/** Regression coverage for structured automatic Intern delegation. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readJSON,
  run,
  writeJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  attachExecution,
  createWorkflow,
  readWorkflow,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";
import { work } from "../plugins/oh-my-teams/scripts/worker.mjs";

const organization = () =>
  readJSON(
    new URL(
      "../plugins/oh-my-teams/examples/organization.json",
      import.meta.url,
    ),
  );

function task(id, delegation, risk = "low") {
  return {
    schemaVersion: 2,
    revision: 1,
    kind: "edit",
    id,
    goal: "Verify automatic delegation",
    instruction: "Leave the bounded fixture unchanged.",
    nonGoals: [],
    constraints: [],
    files: [`${id}.txt`],
    checks: [[process.execPath, "-e", "process.exit(0)"]],
    acceptance: [
      {
        id: "check",
        description: "The deterministic check passes.",
        method: "check",
        checkIndexes: [0],
      },
    ],
    dependencies: [],
    contractRefs: [],
    contextRefs: [],
    openQuestions: [],
    reviewRequirements: [],
    environment: "test",
    baseRef: "HEAD",
    risk,
    ...(delegation ? { delegation } : {}),
  };
}

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intern-first-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const args of [
    ["init"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"],
  ]) {
    assert.equal((await run(["git", ...args], { cwd: dir })).code, 0);
  }
  fs.writeFileSync(path.join(dir, ".gitignore"), ".omt/\n");
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  assert.equal((await run(["git", "add", "."], { cwd: dir })).code, 0);
  assert.equal(
    (await run(["git", "commit", "-m", "seed"], { cwd: dir })).code,
    0,
  );
  return dir;
}

async function create(t, tasks) {
  const dir = await fixture(t);
  for (const [id, contract] of Object.entries(tasks)) {
    fs.writeFileSync(path.join(dir, `${id}.txt`), "unchanged\n");
    writeJSON(path.join(dir, `${id}.json`), contract);
  }
  const request = {
    schemaVersion: 1,
    id: "intern-first",
    goal: "Select task roles from structured metadata.",
    repo: ".",
    tasks: Object.keys(tasks).map((id) => ({ file: `${id}.json` })),
    policy: { maxRunning: 3, maxReviewPending: 3 },
    budget: { maxAttempts: 3, maxCalls: 3 },
  };
  const stateDir = path.join(dir, ".omt");
  const state = await createWorkflow(stateDir, request, organization(), dir);
  return { dir, request, state, stateDir };
}

test("automatic selection sends only bounded low-risk work to Intern", async (t) => {
  const bounded = task("bounded", {
    scope: "closed",
    verification: "deterministic",
    authority: "standard",
    design: "routine",
  });
  const privileged = task("privileged", {
    scope: "closed",
    verification: "deterministic",
    authority: "elevated",
    design: "routine",
  });
  const { state } = await create(t, { bounded, privileged });
  assert.deepEqual(state.tasks.bounded.selection, {
    source: "automatic",
    reason: "low-risk-closed-deterministic",
    requestedRole: "intern",
    selectedRole: "intern",
  });
  assert.equal(state.tasks.privileged.role, "senior");
  assert.equal(state.tasks.privileged.selection.reason, "authority-elevated");
});

test("missing metadata remains with Junior and an explicit role wins", async (t) => {
  const unclassified = task("unclassified");
  const bounded = task("bounded", {
    scope: "closed",
    verification: "deterministic",
    authority: "standard",
    design: "routine",
  });
  const dir = await fixture(t);
  for (const [id, contract] of Object.entries({ unclassified, bounded })) {
    fs.writeFileSync(path.join(dir, `${id}.txt`), "unchanged\n");
    writeJSON(path.join(dir, `${id}.json`), contract);
  }
  const stateDir = path.join(dir, ".omt");
  await createWorkflow(
    stateDir,
    {
      schemaVersion: 1,
      id: "explicit-role",
      goal: "Keep explicit assignments.",
      repo: ".",
      tasks: [
        { file: "unclassified.json" },
        { file: "bounded.json", role: "junior" },
      ],
      policy: { maxRunning: 2, maxReviewPending: 2 },
      budget: { maxAttempts: 2, maxCalls: 2 },
    },
    organization(),
    dir,
  );
  const state = readWorkflow(stateDir, "explicit-role").state;
  assert.equal(state.tasks.unclassified.role, "junior");
  assert.equal(state.tasks.unclassified.selection.reason, "metadata-missing");
  assert.equal(state.tasks.bounded.role, "junior");
  assert.equal(state.tasks.bounded.selection.reason, "role-explicit");
});

test("workflow-backed receipt retains the selected role and reason", async (t) => {
  const bounded = task("bounded", {
    scope: "closed",
    verification: "deterministic",
    authority: "standard",
    design: "routine",
  });
  const { dir, request, stateDir } = await create(t, { bounded });
  attachExecution(stateDir, request.id, 1, {
    schemaVersion: 1,
    eventId: "attach-bounded",
    attemptId: "attempt-bounded",
    taskId: "bounded",
    callAllowance: 1,
    receipt: {
      executionId: "execution-bounded",
      runId: "run-bounded",
      taskId: "task-bounded",
      dispatchId: "dispatch-bounded",
      worktreeId: "worktree-bounded",
    },
  });
  const frozen = readWorkflow(stateDir, request.id).tasks.bounded;
  const report = await work(dir, organization(), frozen, {
    role: "intern",
    stateDir,
    workflowId: request.id,
    attemptId: "attempt-bounded",
    call: async () => ({
      code: 0,
      stdout: "{}",
      stderr: "",
      text: '{"edits":[]}',
      elapsedMs: 1,
    }),
  });
  assert.equal(report.role, "intern");
  assert.equal(report.selectionReason, "low-risk-closed-deterministic");
  assert.equal(
    report.calls[0].selectionReason,
    "low-risk-closed-deterministic",
  );
});
