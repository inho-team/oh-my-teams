#!/usr/bin/env node
/** Runs the deterministic organization scenarios and emits JSON evidence. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { readJSON, run } from "../../plugins/oh-my-teams/scripts/core.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const manifest = readJSON(path.join(root, "evals/organization/scenarios.json"));
const evidenceTests = [
  ...new Set(manifest.scenarios.flatMap((scenario) => scenario.evidenceTests)),
];

const testFilesCache = readdirSync(path.join(root, "tests"))
  .filter((f) => f.endsWith(".test.mjs"))
  .map((f) => ({
    path: path.join("tests", f),
    content: readFileSync(path.join(root, "tests", f), "utf8"),
  }));

// Running the whole test file made every scenario share one verdict: an
// unrelated failure elsewhere, or a machine slower than the timeout, reported
// all seven as failed. Each evidence test is run by name instead, so a scenario
// only fails on its own evidence and the run costs seconds rather than minutes.
/**
 * Escapes characters with special meaning in RegExp.
 * @param {string} name - The string to escape.
 * @returns {string} The escaped string.
 */
function escapeForPattern(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Runs a single evidence test by its full description.
 * @param {string} name - The name of the test to run.
 * @returns {Promise<boolean>} True if the test passes.
 */
async function runEvidenceTest(name) {
  const started = Date.now();
  // Run across all test files so evidence tests can live in any *.test.mjs.
  // Each file is run separately so the --test-name-pattern inner plan (1..N)
  // can be read per-file. The counts are then summed to detect:
  //   total=0  → test name not found anywhere → false positive → failed
  //   total=1  → exactly one test matched → passed (if exit code is 0)
  //   total>1  → duplicate names across files → ambiguous → failed
  const testFiles = testFilesCache
    .filter((entry) => entry.content.includes(name))
    .map((entry) => entry.path);

  let totalInner = 0;
  let anyFail = false;
  let anyTimeout = false;
  let lastCode = 0;
  for (const file of testFiles) {
    const result = await run(
      [
        process.execPath,
        "--test",
        "--test-reporter=tap",
        "--test-name-pattern",
        `^${escapeForPattern(name)}$`,
        file,
      ],
      { cwd: root, timeoutMs: 180000 },
    );
    const text = `${result.stdout}\n${result.stderr}`;
    // The TAP output has two layers:
    //   1..0                     ← inner plan: 0 tests matched the pattern
    //   ok 1 - tests/foo.mjs    ← outer runner reports the file as ok
    //   1..1                     ← outer plan: 1 file ran
    //   # pass 1                 ← outer counts the file, not tests
    //
    // Reading "# pass N" is therefore unreliable. Read the FIRST plan line
    // ("1..N") which counts the tests matching --test-name-pattern in this file.
    const firstPlanMatch = /^1\.\.(\d+)$/m.exec(text);
    const innerCount = firstPlanMatch ? parseInt(firstPlanMatch[1], 10) : 0;
    totalInner += innerCount;
    if (result.code !== 0) anyFail = true;
    if (result.timedOut) anyTimeout = true;
    lastCode = result.code;
  }
  // N=0 means no test ran → missing evidence.
  // N>1 means duplicate test names → ambiguous evidence.
  // N=1 is the only acceptable outcome.
  const passed = totalInner === 1 && !anyFail && !anyTimeout;
  return {
    name,
    passed,
    exitCode: lastCode,
    timedOut: anyTimeout,
    innerCount: totalInner,
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
