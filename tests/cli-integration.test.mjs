/** Real subprocess coverage for the task-v2 organization CLI gates. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, hash, readJSON } from "../plugins/oh-my-teams/scripts/core.mjs";

const cli = path.resolve("plugins/oh-my-teams/scripts/teams-org.mjs");
const exampleOrg = readJSON(
  new URL("../plugins/oh-my-teams/examples/organization.json", import.meta.url),
);

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-cli-integration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function git(repo, ...args) {
  const result = await run(["git", ...args], { cwd: repo });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function cliRun(repo, ...args) {
  return run([process.execPath, cli, ...args], {
    cwd: repo,
    timeoutMs: 120000,
  });
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test("CLI task v2 flow requires review, records acceptance, and rejects stale source", async (t) => {
  const repo = tempDir(t);
  await git(repo, "init");
  await git(repo, "config", "user.name", "Orca CLI Test");
  await git(repo, "config", "user.email", "cli-test@example.invalid");
  fs.writeFileSync(
    path.join(repo, ".gitignore"),
    ".omt/\norg.json\ntask.json\nfake-provider.mjs\nreview*.json\ndecision.json\n",
  );
  fs.writeFileSync(path.join(repo, "value.txt"), "wrong\n");
  fs.writeFileSync(
    path.join(repo, "check.mjs"),
    "import fs from 'node:fs'; if (fs.readFileSync('value.txt', 'utf8') !== 'right\\n') process.exit(1);\n",
  );
  await git(repo, "add", ".gitignore", "value.txt", "check.mjs");
  await git(repo, "commit", "-m", "fixture");

  const provider = path.join(repo, "fake-provider.mjs");
  fs.writeFileSync(
    provider,
    `import fs from "node:fs";
import crypto from "node:crypto";
const beforeHash = crypto.createHash("sha256").update(fs.readFileSync("value.txt", "utf8")).digest("hex");
const payload = { edits: [{ file: "value.txt", beforeHash, content: "right\\n" }], summary: "fixed value" };
process.stdout.write(JSON.stringify({ result: JSON.stringify(payload), model: "fixture-model" }));
`,
    { mode: 0o755 },
  );

  const org = structuredClone(exampleOrg);
  org.profiles["claude-current"].command = [process.execPath, provider];
  org.roles.junior.profile = "claude-current";
  org.roles.junior.fallbacks = [];
  org.policy.timeoutMs = 120000;
  const orgFile = path.join(repo, "org.json");
  writeJson(orgFile, org);

  const task = {
    schemaVersion: 2,
    revision: 1,
    kind: "edit",
    id: "cli-value-fix",
    goal: "Make the checked value correct",
    instruction: "Replace wrong with right, retaining newline",
    nonGoals: ["Do not change the checker"],
    constraints: ["Retain the newline"],
    files: ["value.txt"],
    checks: [[process.execPath, "check.mjs"]],
    acceptance: [
      {
        id: "value-check",
        description: "The value passes",
        method: "check",
        checkIndexes: [0],
      },
      {
        id: "scope-review",
        description: "Only the allowed file changes",
        method: "review",
      },
    ],
    dependencies: [],
    contractRefs: [],
    contextRefs: [],
    openQuestions: [],
    reviewRequirements: [
      {
        id: "semantic-review",
        kind: "agent-review",
        role: "senior",
        criteria: ["scope-review"],
      },
    ],
    environment: "cli-integration-v1",
    baseRef: "HEAD",
    risk: "normal",
  };
  const taskFile = path.join(repo, "task.json");
  writeJson(taskFile, task);
  const state = path.join(repo, ".omt");

  const workResult = await cliRun(
    repo,
    "work",
    "--org",
    orgFile,
    "--task",
    taskFile,
    "--repo",
    repo,
    "--state",
    state,
  );
  assert.equal(workResult.code, 0, workResult.stderr);
  const report = JSON.parse(workResult.stdout);
  assert.equal(report.status, "submitted");
  assert.equal(report.implementation.status, "passed");
  const reportFile = report.reportPath;
  const evidenceFile = path.join(state, "evidence.json");
  writeJson(evidenceFile, report.evidence);

  const decision = {
    schemaVersion: 1,
    id: "cli-acceptance",
    decider: { kind: "pm", executionId: "pm-cli-1" },
    criteria: ["value-check", "scope-review"],
    basis: "The check passed and independent review approved the scope.",
  };
  const decisionFile = path.join(repo, "decision.json");
  writeJson(decisionFile, decision);
  const review = {
    schemaVersion: 1,
    id: "cli-review-approved",
    requirementId: "semantic-review",
    reviewer: {
      kind: "agent-review",
      role: "senior",
      executionId: "senior-cli-1",
    },
    implementationExecutionId: report.runId,
    conclusion: "approved",
    criteria: [
      {
        id: "scope-review",
        conclusion: "approved",
        evidence: "Only value.txt changed.",
      },
    ],
    findings: [],
  };
  const reviewFile = path.join(repo, "review-approved.json");

  const missing = await cliRun(
    repo,
    "accept",
    "--task",
    taskFile,
    "--report",
    reportFile,
    "--decision",
    decisionFile,
    "--repo",
    repo,
    "--state",
    state,
  );
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /Required reviews are incomplete/);

  writeJson(reviewFile, review);
  const recordOnce = () =>
    cliRun(
      repo,
      "review-record",
      "--task",
      taskFile,
      "--report",
      reportFile,
      "--review",
      reviewFile,
      "--repo",
      repo,
      "--state",
      state,
    );
  const competing = await Promise.all([recordOnce(), recordOnce()]);
  assert.equal(competing.filter((result) => result.code === 0).length, 1);
  assert.match(
    competing.find((result) => result.code !== 0).stderr,
    /update in progress|already exists/,
  );
  const recorded = competing.find((result) => result.code === 0);
  assert.equal(recorded.code, 0, recorded.stderr);
  assert.equal(JSON.parse(recorded.stdout).gateStatus.state, "reviewed");

  const accepted = await cliRun(
    repo,
    "accept",
    "--task",
    taskFile,
    "--report",
    reportFile,
    "--decision",
    decisionFile,
    "--repo",
    repo,
    "--state",
    state,
  );
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).gateStatus.state, "accepted");

  const merged = await cliRun(
    repo,
    "merge-check",
    "--evidence",
    evidenceFile,
    "--task",
    taskFile,
    "--report",
    reportFile,
    "--repo",
    repo,
    "--state",
    state,
    "--base",
    "HEAD",
  );
  assert.equal(merged.code, 0, merged.stderr);
  assert.equal(JSON.parse(merged.stdout).valid, true);

  fs.writeFileSync(path.join(repo, "value.txt"), "tampered\n");
  const stale = await cliRun(
    repo,
    "merge-check",
    "--evidence",
    evidenceFile,
    "--task",
    taskFile,
    "--report",
    reportFile,
    "--repo",
    repo,
    "--state",
    state,
    "--base",
    "HEAD",
  );
  assert.notEqual(stale.code, 0);
  assert.match(stale.stderr, /fingerprint|evidence|source|changed/i);
});

test("CLI newer changes-requested review with no findings revokes prior approval", async (t) => {
  const repo = tempDir(t);
  await git(repo, "init");
  await git(repo, "config", "user.name", "Orca CLI Test");
  await git(repo, "config", "user.email", "cli-test@example.invalid");
  fs.writeFileSync(
    path.join(repo, ".gitignore"),
    ".omt/\norg.json\ntask.json\nfake-provider.mjs\nreview*.json\n",
  );
  fs.writeFileSync(path.join(repo, "value.txt"), "wrong\n");
  fs.writeFileSync(path.join(repo, "check.mjs"), "process.exit(0);\n");
  await git(repo, "add", ".gitignore", "value.txt", "check.mjs");
  await git(repo, "commit", "-m", "fixture");
  const provider = path.join(repo, "fake-provider.mjs");
  fs.writeFileSync(
    provider,
    `import fs from "node:fs"; import crypto from "node:crypto"; const ` +
      `h=crypto.createHash("sha256").update(fs.readFileSync("value.txt","utf8")).digest("hex"); ` +
      `process.stdout.write(JSON.stringify({result:JSON.stringify({edits:[{file:"value.txt",beforeHash:h,content:"right\\n"}],summary:"fixed"})}));`,
    { mode: 0o755 },
  );
  const org = structuredClone(exampleOrg);
  org.profiles["claude-current"].command = [process.execPath, provider];
  org.roles.junior.profile = "claude-current";
  org.roles.junior.fallbacks = [];
  const orgFile = path.join(repo, "org.json");
  writeJson(orgFile, org);
  const task = {
    schemaVersion: 2,
    revision: 1,
    kind: "edit",
    id: "cli-review-revocation",
    goal: "Fix value",
    instruction: "Replace wrong with right",
    nonGoals: [],
    constraints: [],
    files: ["value.txt"],
    checks: [[process.execPath, "check.mjs"]],
    acceptance: [
      { id: "check", description: "check", method: "check", checkIndexes: [0] },
      { id: "review", description: "review", method: "review" },
    ],
    dependencies: [],
    contractRefs: [],
    contextRefs: [],
    openQuestions: [],
    reviewRequirements: [
      {
        id: "semantic-review",
        kind: "agent-review",
        role: "senior",
        criteria: ["review"],
      },
    ],
    environment: "cli-revocation-v1",
    baseRef: "HEAD",
    risk: "normal",
  };
  const taskFile = path.join(repo, "task.json");
  writeJson(taskFile, task);
  const state = path.join(repo, ".omt");
  const workResult = await cliRun(
    repo,
    "work",
    "--org",
    orgFile,
    "--task",
    taskFile,
    "--repo",
    repo,
    "--state",
    state,
  );
  assert.equal(workResult.code, 0, workResult.stderr);
  const report = JSON.parse(workResult.stdout);
  const reportFile = report.reportPath;
  const reviewFile = path.join(repo, "review.json");
  const baseReview = {
    schemaVersion: 1,
    requirementId: "semantic-review",
    reviewer: {
      kind: "agent-review",
      role: "senior",
      executionId: "senior-cli-2",
    },
    implementationExecutionId: report.runId,
    criteria: [{ id: "review", conclusion: "approved", evidence: "scope" }],
    findings: [],
  };
  writeJson(reviewFile, {
    ...baseReview,
    id: "review-first",
    conclusion: "approved",
  });
  const first = await cliRun(
    repo,
    "review-record",
    "--task",
    taskFile,
    "--report",
    reportFile,
    "--review",
    reviewFile,
    "--repo",
    repo,
    "--state",
    state,
  );
  assert.equal(first.code, 0, first.stderr);
  writeJson(reviewFile, {
    ...baseReview,
    id: "review-newer",
    conclusion: "changes-requested",
    criteria: [
      {
        id: "review",
        conclusion: "changes-requested",
        evidence: "Recheck required",
      },
    ],
  });
  const second = await cliRun(
    repo,
    "review-record",
    "--task",
    taskFile,
    "--report",
    reportFile,
    "--review",
    reviewFile,
    "--repo",
    repo,
    "--state",
    state,
  );
  assert.equal(second.code, 0, second.stderr);
  const gate = await cliRun(
    repo,
    "gate-check",
    "--task",
    taskFile,
    "--report",
    reportFile,
    "--repo",
    repo,
    "--state",
    state,
  );
  assert.equal(gate.code, 0, gate.stderr);
  const gateOutput = JSON.parse(gate.stdout);
  assert.equal(gateOutput.state, "submitted");
  assert.equal(gateOutput.gates["review-complete"].status, "pending");
  assert.deepEqual(gateOutput.gates["review-complete"].missing, [
    "semantic-review",
  ]);
});

test("STATE-04: terminal-idle-check warns about launch path prediction failures without crashing", async (t) => {
  const dir = tempDir(t);
  const orgOllama = readJSON(
    new URL(
      "../plugins/oh-my-teams/examples/organization.local-ollama.json",
      import.meta.url,
    ),
  );
  fs.writeFileSync(path.join(dir, "org.json"), JSON.stringify(orgOllama));
  const result = await run(
    [
      process.execPath,
      cli,
      "terminal-idle-check",
      "--org",
      "org.json",
      "--role",
      "intern",
      "--terminal",
      "t-123",
      "--orca",
      "does-not-exist-orca",
    ],
    { cwd: dir },
  );
  assert.ok(
    result.stderr.includes("Warning: Failed to predict launch path"),
    "Should print warning to stderr",
  );
});
