#!/usr/bin/env node
/** Re-evaluates stored routing evidence after a versioned grader correction. */
import path from "node:path";
import { readJSON, writeJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  evaluateRoutingFixture,
  routingFixtures,
  routingGraderVersion,
} from "./routing-fixtures.mjs";

for (const input of process.argv.slice(2)) {
  const file = path.resolve(input),
    manifest = readJSON(file);
  for (const record of manifest.records) {
    if (record.fixture !== "narrow-edit") continue;
    const fixture = routingFixtures.find((item) => item.id === record.fixture),
      next = await evaluateRoutingFixture(
        fixture,
        { answer: record.evaluation?.evidence },
        path.dirname(file),
      );
    if (
      record.graderVersion !== routingGraderVersion ||
      JSON.stringify(next) !== JSON.stringify(record.evaluation)
    ) {
      record.evaluationHistory ??= [];
      record.evaluationHistory.push({
        graderVersion: record.graderVersion ?? 1,
        evaluation: record.evaluation,
      });
      record.evaluation = next;
      record.graderVersion = routingGraderVersion;
    }
  }
  manifest.regradedAt = new Date().toISOString();
  manifest.graderVersion = routingGraderVersion;
  writeJSON(file, manifest);
  console.log(
    JSON.stringify({
      file,
      passed: manifest.records.filter((record) => record.evaluation.passed)
        .length,
      total: manifest.records.length,
      graderVersion: routingGraderVersion,
    }),
  );
}
