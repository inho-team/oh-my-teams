#!/usr/bin/env node
/** Produces a conservative cross-mode routing experiment summary. */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readJSON, writeJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  compareQuotaSnapshots,
  validateQuotaSnapshot,
} from "../plugins/oh-my-teams/scripts/quota.mjs";

/**
 * Summarizes completed routing manifests without fabricating missing quota data.
 *
 * @param {object[]} manifests - E1 and/or operational routing manifests.
 * @returns {object} Comparable runs, provisional recommendation, and OSS scope.
 */
export function summarizeRouting(manifests) {
  const runs = manifests.map((manifest) => {
    const complete =
      manifest.status === "complete" &&
      manifest.actualCalls === manifest.plannedCalls;
    const usageKnown = manifest.records.every((record) =>
      Number.isFinite(record.usage?.total_tokens),
    );
    const quota =
      manifest.quotaBefore && manifest.quotaAfter
        ? compareQuotaSnapshots(manifest.quotaBefore, manifest.quotaAfter)
        : {
            attributable: false,
            reasons: ["missing-before-or-after-snapshot"],
            consumption: null,
          };
    return {
      mode: manifest.mode,
      complete,
      passed: manifest.records.filter((record) => record.evaluation?.passed)
        .length,
      total: manifest.records.length,
      passRate: manifest.records.length
        ? manifest.records.filter((record) => record.evaluation?.passed)
            .length / manifest.records.length
        : 0,
      totalTokens: usageKnown
        ? manifest.records.reduce(
            (sum, record) => sum + record.usage.total_tokens,
            0,
          )
        : null,
      elapsedMs: manifest.records.reduce(
        (sum, record) => sum + (record.elapsedMs ?? 0),
        0,
      ),
      usageKnown,
      quota,
      worktreeId: manifest.worktree?.id ?? null,
      cleanup: manifest.cleanup?.status ?? "unknown",
    };
  });
  const opus = runs.find((run) => run.mode === "opus-first"),
    balanced = runs.find((run) => run.mode === "balanced");
  let recommendation = {
    status: "insufficient-evidence",
    preset: null,
    reason: "Complete matched opus-first and balanced runs are required.",
  };
  if (opus?.complete && balanced?.complete) {
    const tokenGain =
      opus.totalTokens && balanced.totalTokens
        ? (opus.totalTokens - balanced.totalTokens) / opus.totalTokens
        : null;
    const timeGain = opus.elapsedMs
      ? (opus.elapsedMs - balanced.elapsedMs) / opus.elapsedMs
      : null;
    if (balanced.passRate < opus.passRate)
      recommendation = {
        status: "do-not-adopt",
        preset: "opus-first",
        reason: "Balanced reduced measured quality.",
      };
    else if (balanced.passRate > opus.passRate)
      recommendation = {
        status: "provisional",
        preset: "balanced",
        reason:
          "Balanced passed more matched fixtures; repeat before broad adoption.",
        tokenGain,
        timeGain,
      };
    else {
      recommendation =
        (tokenGain !== null && tokenGain >= 0.1) ||
        (timeGain !== null && timeGain >= 0.1)
          ? {
              status: "provisional",
              preset: "balanced",
              reason:
                "Quality matched and token or model-time improvement reached 10%; repeat before broad adoption.",
              tokenGain,
              timeGain,
            }
          : {
              status: "provisional",
              preset: "opus-first",
              reason:
                "Balanced did not show a 10% measured improvement at matched quality.",
              tokenGain,
              timeGain,
            };
    }
  }
  const e1 = manifests.find((manifest) => manifest.mode === "e1"),
    gptOssObservedPass = e1
      ? e1.records
          .filter(
            (record) =>
              record.requestedModel === "gpt-oss-120b-medium" &&
              record.evaluation?.passed,
          )
          .map((record) => record.fixture)
      : [];
  const gptOssKeep = gptOssObservedPass.filter((fixture) =>
    ["narrow-edit", "source-citations"].includes(fixture),
  );
  return {
    schemaVersion: 1,
    status: runs.every((run) => run.complete) ? "complete" : "incomplete",
    runs,
    recommendation,
    gptOssKeep,
    gptOssObservedPass,
    note:
      "A provisional recommendation from one batch is not a statistical claim. GPT-OSS operating " +
      "recommendations remain limited to low-risk narrow/citation work even when one higher-risk " +
      "fixture passed. Missing quota remains unknown.",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error("Pass one or more routing manifest paths");
  const summary = summarizeRouting(
    files.map((file) => readJSON(path.resolve(file))),
  );
  writeJSON("experiments/routing-summary.json", summary);
  console.log(JSON.stringify(summary, null, 2));
}
