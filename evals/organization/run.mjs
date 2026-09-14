#!/usr/bin/env node
/** Runs the six deterministic organization scenarios and emits JSON evidence. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJSON, run } from "../../plugins/oh-my-teams/scripts/core.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const manifest = readJSON(path.join(root, "evals/organization/scenarios.json"));
const result = await run(
  [process.execPath, "--test", "tests/runtime.test.mjs"],
  { cwd: root, timeoutMs: 120000 },
);
const text = `${result.stdout}\n${result.stderr}`;
const scenarios = manifest.scenarios.map((scenario) => {
  const missing = scenario.evidenceTests.filter(
    (name) => !text.includes(`✔ ${name}`),
  );
  return {
    id: scenario.id,
    status:
      result.code === 0 && !result.timedOut && missing.length === 0
        ? "passed"
        : "failed",
    evidenceTests: scenario.evidenceTests,
    missing,
  };
});
const output = {
  schemaVersion: 1,
  kind: manifest.kind,
  status: scenarios.every((item) => item.status === "passed")
    ? "passed"
    : "failed",
  scenarios,
  testExitCode: result.code,
  timedOut: result.timedOut,
  note: "This evaluator uses deterministic local fixtures and makes no model-quality or subscription-cost claim.",
};
console.log(JSON.stringify(output, null, 2));
if (output.status !== "passed") process.exitCode = 1;
