#!/usr/bin/env node
/** Runs the deterministic organization scenarios and emits JSON evidence. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJSON, run } from "../../plugins/oh-my-teams/scripts/core.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const manifest = readJSON(path.join(root, "evals/organization/scenarios.json"));
const evidenceTests = [
  ...new Set(manifest.scenarios.flatMap((scenario) => scenario.evidenceTests)),
];

// Running the whole test file made every scenario share one verdict: an
// unrelated failure elsewhere, or a machine slower than the timeout, reported
// all seven as failed. Each evidence test is run by name instead, so a scenario
// only fails on its own evidence and the run costs seconds rather than minutes.
function escapeForPattern(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runEvidenceTest(name) {
  const started = Date.now();
  const result = await run(
    [
      process.execPath,
      "--test",
      "--test-reporter=tap",
      "--test-name-pattern",
      `^${escapeForPattern(name)}$`,
      "tests/runtime.test.mjs",
    ],
    { cwd: root, timeoutMs: 180000 },
  );
  const text = `${result.stdout}\n${result.stderr}`;
  // TAP marks a selected test `ok`; a name that matches nothing reports zero
  // passes, which must read as missing evidence rather than as success.
  // Specifically, `# pass 0` means no test ran for this name, which is a
  // false-positive failure: the file itself produces `ok 1` even with zero
  // matching tests. We check for exactly `# pass 1` AND the absence of
  // `# pass 0` to catch both zero-match and multi-match edge cases.
  const passCount = (() => {
    const m = /^# pass (\d+)$/m.exec(text);
    return m ? parseInt(m[1], 10) : 0;
  })();
  const passed = passCount >= 1 && result.code === 0 && !result.timedOut;
  return {
    name,
    passed,
    exitCode: result.code,
    timedOut: result.timedOut,
    elapsedMs: Date.now() - started,
  };
}

const outcomes = new Map();
for (const name of evidenceTests) {
  outcomes.set(name, await runEvidenceTest(name));
}

const scenarios = manifest.scenarios.map((scenario) => {
  const failing = scenario.evidenceTests.filter(
    (name) => !outcomes.get(name).passed,
  );
  return {
    id: scenario.id,
    status: failing.length === 0 ? "passed" : "failed",
    evidenceTests: scenario.evidenceTests,
    missing: failing,
  };
});

const output = {
  schemaVersion: 1,
  kind: manifest.kind,
  status: scenarios.every((item) => item.status === "passed")
    ? "passed"
    : "failed",
  scenarios,
  evidence: [...outcomes.values()],
  note: "This evaluator uses deterministic local fixtures and makes no model-quality or subscription-cost claim.",
};
console.log(JSON.stringify(output, null, 2));
if (output.status !== "passed") process.exitCode = 1;
