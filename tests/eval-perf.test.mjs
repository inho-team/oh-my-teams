/** Tests that evals/organization/run.mjs fails gracefully when test names are missing or duplicated. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../plugins/oh-my-teams/scripts/core.mjs";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-eval-perf-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("evals/organization/run.mjs fails scenarios with missing or duplicate test names", async (t) => {
  const dir = tempDir(t);
  const evalsDir = path.join(dir, "evals", "organization");
  const testsDir = path.join(dir, "tests");
  const pluginsDir = path.join(dir, "plugins");
  fs.mkdirSync(evalsDir, { recursive: true });
  fs.mkdirSync(testsDir, { recursive: true });

  // Copy run.mjs
  const sourceRun = path.resolve("evals/organization/run.mjs");
  fs.copyFileSync(sourceRun, path.join(evalsDir, "run.mjs"));

  // Symlink plugins
  fs.symlinkSync(path.resolve("plugins"), pluginsDir, "junction");

  // Mock scenarios.json
  const scenarios = {
    schemaVersion: 1,
    kind: "deterministic-local",
    scenarios: [
      {
        id: "missing-scenario",
        description: "A scenario with a missing test",
        evidenceTests: ["missing test name"],
      },
      {
        id: "duplicate-scenario",
        description: "A scenario with a duplicated test",
        evidenceTests: ["duplicate test name"],
      },
    ],
  };
  fs.writeFileSync(
    path.join(evalsDir, "scenarios.json"),
    JSON.stringify(scenarios),
  );

  // Mock test files
  // fake1.test.mjs contains "duplicate test name" and "another test"
  fs.writeFileSync(
    path.join(testsDir, "fake1.test.mjs"),
    `
import test from "node:test";
test("duplicate test name", () => {});
test("another test", () => {});
`,
  );

  // fake2.test.mjs contains "duplicate test name" again
  fs.writeFileSync(
    path.join(testsDir, "fake2.test.mjs"),
    `
import test from "node:test";
test("duplicate test name", () => {});
`,
  );

  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;

  const result = await run([process.execPath, "evals/organization/run.mjs"], {
    cwd: dir,
    env,
  });

  // It should exit with code 1 because both scenarios should fail
  assert.equal(
    result.code,
    1,
    "run.mjs should fail when evidence is missing or ambiguous",
  );

  const output = JSON.parse(result.stdout);

  const missing = output.scenarios.find((s) => s.id === "missing-scenario");
  assert.equal(missing.status, "failed");

  const duplicate = output.scenarios.find((s) => s.id === "duplicate-scenario");
  assert.equal(duplicate.status, "failed");

  const evidenceMissing = output.evidence.find(
    (e) => e.name === "missing test name",
  );
  assert.equal(evidenceMissing.passed, false);
  assert.equal(evidenceMissing.innerCount, 0);

  const evidenceDuplicate = output.evidence.find(
    (e) => e.name === "duplicate test name",
  );
  assert.equal(evidenceDuplicate.passed, false);
  assert.equal(
    evidenceDuplicate.innerCount,
    2,
    "Duplicate test names should run the file twice and report innerCount=2",
  );
});
