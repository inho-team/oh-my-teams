#!/usr/bin/env node
/** Runs an explicitly authorized, call-bounded routing experiment in Orca. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  hash,
  readJSON,
  run,
  writeJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  invoke,
  parseModelJSON,
} from "../plugins/oh-my-teams/scripts/providers.mjs";
import {
  createWorktree,
  discoverOrcaRuntime,
} from "../plugins/oh-my-teams/scripts/orca-adapter.mjs";
import {
  evaluateRoutingFixture,
  routingFixtures,
  routingGraderVersion,
  routingModes,
} from "./routing-fixtures.mjs";
import { validateQuotaSnapshot } from "../plugins/oh-my-teams/scripts/quota.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  argv = process.argv.slice(2);
const value = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : null;
};
const mode = value("--mode"),
  maxCalls = Number(value("--max-calls"));
assert(
  mode === "e1" || routingModes[mode],
  "Use --mode opus-first|balanced|control|e1",
);
assert(
  Number.isInteger(maxCalls) && maxCalls >= 1 && maxCalls <= 18,
  "Use --max-calls 1..18",
);
const models = [
  "gpt-oss-120b-medium",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
];
const jobs =
  mode === "e1"
    ? routingFixtures.flatMap((fixture) =>
        models.map((model) => ({ fixture, model })),
      )
    : routingFixtures.map((fixture) => ({
        fixture,
        model: routingModes[mode][fixture.id],
      }));
assert(
  maxCalls >= jobs.length,
  `Mode ${mode} requires ${jobs.length} initial calls; increase --max-calls or choose a smaller mode`,
);
if (argv.includes("--dry-run")) {
  console.log(
    JSON.stringify(
      {
        mode,
        requiredCalls: jobs.length,
        jobs: jobs.map((job) => ({
          fixture: job.fixture.id,
          kind: job.fixture.kind,
          requestedModel: job.model,
        })),
        subscriptionCallsStarted: false,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
assert(
  argv.includes("--confirm-subscription-use"),
  "Refusing model calls without --confirm-subscription-use",
);
const runtime = await discoverOrcaRuntime("orca"),
  base = (await run(["git", "rev-parse", "HEAD"], { cwd: root })).stdout.trim();
const out = path.join(
  root,
  "experiments",
  "results",
  `routing-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
fs.mkdirSync(out, { recursive: true });
const quotaBeforePath = value("--quota-before"),
  quotaBefore = quotaBeforePath
    ? validateQuotaSnapshot(readJSON(path.resolve(quotaBeforePath)))
    : null;
writeJSON(path.join(out, "manifest.json"), {
  schemaVersion: 1,
  experiment: "routing-e1-e2",
  mode,
  status: "creating-worktree",
  base,
  runtime,
  maxCalls,
  plannedCalls: jobs.length,
  actualCalls: 0,
  records: [],
  quotaBefore,
  quotaAfter: null,
});
const created = await createWorktree(root, {
  name: `routing-${mode}-${Date.now()}`,
  base,
  setup: "skip",
  discovery: runtime,
  executable: runtime.executable,
});
const { receipt, worktree } = created;
const records = [];
writeJSON(path.join(out, "manifest.json"), {
  schemaVersion: 1,
  experiment: "routing-e1-e2",
  mode,
  status: "running",
  base,
  runtime,
  worktree,
  receipt,
  maxCalls,
  plannedCalls: jobs.length,
  actualCalls: 0,
  records,
  quotaBefore,
  quotaAfter: null,
});
for (const job of jobs) {
  const dir = path.join(
    worktree.path,
    "routing-fixture",
    job.fixture.id,
    job.model,
  );
  fs.mkdirSync(dir, { recursive: true });
  const prompt = `Return only JSON. Do not use tools or edit files.\n${job.fixture.prompt}`;
  const response = await invoke(
    {
      provider: "agy",
      command: ["agy"],
      model: job.model,
      account: "current",
      subscription: "current Agy pool",
    },
    dir,
    prompt,
    300000,
  );
  const rawDir = path.join(out, "raw", job.fixture.id, job.model);
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, "stdout.txt"), response.stdout);
  fs.writeFileSync(path.join(rawDir, "stderr.txt"), response.stderr);
  let evaluation = { passed: false, evidence: "provider failure" },
    parseError = null;
  try {
    assert(
      response.code === 0 && !response.providerError && !response.timedOut,
      "Provider failed",
    );
    evaluation = await evaluateRoutingFixture(
      job.fixture,
      parseModelJSON(response.text),
      dir,
    );
  } catch (error) {
    parseError = error.message;
  }
  const record = {
    fixture: job.fixture.id,
    kind: job.fixture.kind,
    requestedModel: job.model,
    effectiveModel: response.effectiveModel ?? null,
    promptHash: hash(prompt),
    providerExit: response.code,
    failureClass: response.failureClass ?? null,
    usage: response.usage ?? null,
    costUsd: response.costUsd ?? null,
    elapsedMs: response.elapsedMs,
    graderVersion: routingGraderVersion,
    evaluation,
    parseError,
    raw: {
      stdout: path.join(rawDir, "stdout.txt"),
      stderr: path.join(rawDir, "stderr.txt"),
    },
  };
  records.push(record);
  writeJSON(path.join(out, `${job.fixture.id}-${job.model}.json`), record);
  writeJSON(path.join(out, "manifest.json"), {
    schemaVersion: 1,
    experiment: "routing-e1-e2",
    mode,
    status: "running",
    base,
    runtime,
    worktree,
    receipt,
    maxCalls,
    plannedCalls: jobs.length,
    actualCalls: records.length,
    records,
    quotaBefore,
    quotaAfter: null,
  });
}
const manifest = {
  schemaVersion: 1,
  experiment: "routing-e1-e2",
  mode,
  status: "complete",
  base,
  runtime,
  worktree,
  receipt,
  maxCalls,
  plannedCalls: jobs.length,
  actualCalls: records.length,
  records,
  quotaBefore,
  quotaAfter: null,
  cleanup: { status: "pending" },
  note: "Quota-after remains null until finalize-routing records a supported snapshot. This run does not auto-merge results.",
};
writeJSON(path.join(out, "manifest.json"), manifest);
console.log(
  JSON.stringify(
    {
      results: out,
      passed: records.filter((item) => item.evaluation.passed).length,
      total: records.length,
      worktree,
    },
    null,
    2,
  ),
);
