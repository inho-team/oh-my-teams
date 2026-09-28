/** Coverage for the append-only workflow-budget command (w2-10). */
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
  createWorkflow,
  increaseWorkflowBudget,
  readWorkflow,
  reserveExecution,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";
import { workflowDirectory } from "../plugins/oh-my-teams/scripts/workflow-store.mjs";

const organization = readJSON(
  new URL("../plugins/oh-my-teams/examples/organization.json", import.meta.url),
);

async function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-budget-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const args of [
    ["init"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"],
  ]) {
    assert.equal((await run(["git", ...args], { cwd: dir })).code, 0);
  }
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  assert.equal((await run(["git", "add", "seed.txt"], { cwd: dir })).code, 0);
  assert.equal(
    (await run(["git", "commit", "-m", "seed"], { cwd: dir })).code,
    0,
  );
  return dir;
}

const task = (id, files) => ({
  schemaVersion: 2,
  revision: 1,
  kind: "edit",
  id,
  goal: "Test workflow budget",
  instruction: "Make the change",
  nonGoals: [],
  constraints: [],
  files: files ?? [`${id}.txt`],
  checks: [[process.execPath, "-e", "process.exit(0)"]],
  acceptance: [
    { id: "check", description: "check", method: "check", checkIndexes: [0] },
  ],
  dependencies: [],
  contractRefs: [],
  contextRefs: [],
  openQuestions: [],
  reviewRequirements: [],
  environment: "test",
  baseRef: "HEAD",
  risk: "low",
});

async function singleTaskWorkflow(t, { id, budget, policy }) {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  writeJSON(path.join(dir, "a.json"), task("a"));
  const request = {
    schemaVersion: 1,
    id,
    goal: "Single task workflow",
    repo: ".",
    tasks: [{ file: "a.json", role: "junior" }],
    policy: policy ?? { maxRunning: 1, maxReviewPending: 1 },
    budget: budget ?? { maxAttempts: 1, maxCalls: 5 },
  };
  await createWorkflow(stateDir, request, structuredClone(organization), dir);
  return { dir, stateDir, request };
}

async function twoTaskWorkflow(t, { id, budget, policy }) {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  writeJSON(path.join(dir, "a.json"), task("a", ["a.txt"]));
  writeJSON(path.join(dir, "b.json"), task("b", ["b.txt"]));
  const request = {
    schemaVersion: 1,
    id,
    goal: "Two task workflow",
    repo: ".",
    tasks: [
      { file: "a.json", role: "junior" },
      { file: "b.json", role: "senior" },
    ],
    policy: policy ?? { maxRunning: 2, maxReviewPending: 2 },
    budget: budget ?? { maxAttempts: 1, maxCalls: 10 },
  };
  await createWorkflow(stateDir, request, structuredClone(organization), dir);
  return { dir, stateDir, request };
}

const approval = (overrides) => ({
  schemaVersion: 1,
  eventId: "budget-1",
  maxAttempts: 2,
  approvedBy: "director",
  approvalRef: "decision-2026-09-27",
  reason: "director approved raising the attempt budget",
  ...overrides,
});

test("workflow-budget raises maxAttempts and leaves other budget fields and task state untouched", async (t) => {
  const { stateDir, request } = await singleTaskWorkflow(t, {
    id: "budget-basic",
    budget: { maxAttempts: 1, maxCalls: 5 },
  });
  const before = readWorkflow(stateDir, request.id).state;
  const taskBefore = structuredClone(before.tasks.a);
  const policyBefore = structuredClone(before.policy);

  const raised = increaseWorkflowBudget(
    stateDir,
    request.id,
    before.revision,
    approval({ maxAttempts: 2 }),
  );

  assert.equal(raised.duplicate, false);
  assert.equal(raised.state.budget.maxAttempts, 2);
  assert.equal(raised.state.budget.maxCalls, 5);
  assert.equal(raised.state.budget.attemptsUsed, 0);
  assert.equal(raised.state.budget.callsUsed, 0);
  assert.deepEqual(raised.state.tasks.a, taskBefore);
  assert.deepEqual(raised.state.policy, policyBefore);
  assert.equal(raised.state.revision, before.revision + 1);
  const change = raised.state.budget.history.at(-1);
  assert.equal(change.from, 1);
  assert.equal(change.to, 2);
  assert.equal(change.approvedBy, "director");
  assert.equal(change.approvalRef, "decision-2026-09-27");
  assert.equal(change.reason, "director approved raising the attempt budget");
  assert.ok(typeof change.recordedAt === "string" && change.recordedAt.trim());
});

test("workflow-budget replays a repeated eventId as a no-op duplicate", async (t) => {
  const { stateDir, request } = await singleTaskWorkflow(t, {
    id: "budget-replay",
    budget: { maxAttempts: 1, maxCalls: 5 },
  });
  const revision = () => readWorkflow(stateDir, request.id).state.revision;

  const first = increaseWorkflowBudget(
    stateDir,
    request.id,
    revision(),
    approval({ eventId: "budget-replay-1", maxAttempts: 2 }),
  );
  assert.equal(first.duplicate, false);

  const replay = increaseWorkflowBudget(
    stateDir,
    request.id,
    revision(),
    approval({ eventId: "budget-replay-1", maxAttempts: 2 }),
  );
  assert.equal(replay.duplicate, true);
  assert.equal(replay.state.budget.maxAttempts, 2);
  assert.equal(replay.state.budget.history.length, 1);
});

test("workflow-budget rejects a stale expectedRevision", async (t) => {
  const { stateDir, request } = await singleTaskWorkflow(t, {
    id: "budget-stale-revision",
    budget: { maxAttempts: 1, maxCalls: 5 },
  });
  const revision = () => readWorkflow(stateDir, request.id).state.revision;

  assert.throws(
    () =>
      increaseWorkflowBudget(
        stateDir,
        request.id,
        revision() + 1,
        approval({ eventId: "budget-stale-1", maxAttempts: 2 }),
      ),
    /Workflow changed/,
  );
});

test("workflow-budget rejects a lock held by a live owner", async (t) => {
  const { stateDir, request } = await singleTaskWorkflow(t, {
    id: "budget-lock-contention",
    budget: { maxAttempts: 1, maxCalls: 5 },
  });
  const revision = () => readWorkflow(stateDir, request.id).state.revision;
  const lockFile = path.join(workflowDirectory(stateDir, request.id), ".lock");
  fs.writeFileSync(
    lockFile,
    JSON.stringify({ pid: process.pid, hostname: os.hostname() }),
  );
  t.after(() => fs.rmSync(lockFile, { force: true }));

  assert.throws(
    () =>
      increaseWorkflowBudget(
        stateDir,
        request.id,
        revision(),
        approval({ eventId: "budget-locked-1", maxAttempts: 2 }),
      ),
    /progress/,
  );
});

test("workflow-budget rejects a decrease or an unchanged maxAttempts", async (t) => {
  const { stateDir, request } = await singleTaskWorkflow(t, {
    id: "budget-decrease-or-equal",
    budget: { maxAttempts: 2, maxCalls: 5 },
  });
  const revision = () => readWorkflow(stateDir, request.id).state.revision;

  assert.throws(
    () =>
      increaseWorkflowBudget(
        stateDir,
        request.id,
        revision(),
        approval({ eventId: "budget-equal-1", maxAttempts: 2 }),
      ),
    /must exceed the current maxAttempts/,
  );
  assert.throws(
    () =>
      increaseWorkflowBudget(
        stateDir,
        request.id,
        revision(),
        approval({ eventId: "budget-decrease-1", maxAttempts: 1 }),
      ),
    /must exceed the current maxAttempts/,
  );
});

test("workflow-budget rejects a new maxAttempts below attemptsUsed", async (t) => {
  const { stateDir, request } = await singleTaskWorkflow(t, {
    id: "budget-below-attempts-used",
    budget: { maxAttempts: 2, maxCalls: 5 },
  });
  // Simulate a legacy/inconsistent record where attemptsUsed already exceeds
  // the requested new limit, independent of the current maxAttempts.
  const { state, dir } = readWorkflow(stateDir, request.id);
  state.budget.attemptsUsed = 5;
  writeJSON(path.join(dir, "state.json"), state);
  const revision = () => readWorkflow(stateDir, request.id).state.revision;

  assert.throws(
    () =>
      increaseWorkflowBudget(
        stateDir,
        request.id,
        revision(),
        approval({ eventId: "budget-below-used-1", maxAttempts: 3 }),
      ),
    /cannot be below attemptsUsed/,
  );
});

test("workflow-budget rejects missing or blank approval fields", async (t) => {
  const { stateDir, request } = await singleTaskWorkflow(t, {
    id: "budget-missing-approval",
    budget: { maxAttempts: 1, maxCalls: 5 },
  });
  const revision = () => readWorkflow(stateDir, request.id).state.revision;

  assert.throws(
    () =>
      increaseWorkflowBudget(
        stateDir,
        request.id,
        revision(),
        approval({
          eventId: "budget-no-approver",
          maxAttempts: 2,
          approvedBy: "",
        }),
      ),
    /approver, an approval reference and a reason/,
  );
  assert.throws(
    () =>
      increaseWorkflowBudget(
        stateDir,
        request.id,
        revision(),
        approval({
          eventId: "budget-no-ref",
          maxAttempts: 2,
          approvalRef: "   ",
        }),
      ),
    /approver, an approval reference and a reason/,
  );
  assert.throws(
    () =>
      increaseWorkflowBudget(
        stateDir,
        request.id,
        revision(),
        approval({ eventId: "budget-no-reason", maxAttempts: 2, reason: "" }),
      ),
    /approver, an approval reference and a reason/,
  );
  assert.throws(
    () =>
      increaseWorkflowBudget(
        stateDir,
        request.id,
        revision(),
        approval({ eventId: "budget-non-integer", maxAttempts: 1.5 }),
      ),
    /positive integer maxAttempts/,
  );
  assert.throws(
    () =>
      increaseWorkflowBudget(
        stateDir,
        request.id,
        revision(),
        approval({ eventId: "budget-zero", maxAttempts: 0 }),
      ),
    /positive integer maxAttempts/,
  );
  assert.throws(
    () =>
      increaseWorkflowBudget(
        stateDir,
        request.id,
        revision(),
        approval({ eventId: "budget-negative", maxAttempts: -1 }),
      ),
    /positive integer maxAttempts/,
  );
});

test("a workflow-budget journal crashed mid-save recovers exactly once", async (t) => {
  const { stateDir, request } = await singleTaskWorkflow(t, {
    id: "budget-crash-recovery",
    budget: { maxAttempts: 1, maxCalls: 5 },
  });
  const dir = workflowDirectory(stateDir, request.id);
  const before = readWorkflow(stateDir, request.id).state;
  const eventId = "budget-crash-1";
  const recordedAt = new Date().toISOString();
  const crashedState = {
    ...before,
    revision: before.revision + 1,
    eventIds: [...before.eventIds, eventId],
    budget: {
      ...before.budget,
      maxAttempts: 2,
      history: [
        {
          from: 1,
          to: 2,
          approvedBy: "director",
          approvalRef: "decision-2026-09-27",
          reason: "raise the limit",
          recordedAt,
        },
      ],
    },
  };
  const event = {
    id: eventId,
    type: "attempt-budget-increased",
    from: 1,
    to: 2,
    approvedBy: "director",
    approvalRef: "decision-2026-09-27",
    reason: "raise the limit",
    recordedAt,
  };
  // A crash between writing the journal and materializing state/events.
  writeJSON(path.join(dir, "transaction.json"), {
    state: crashedState,
    events: [{ name: "000002-budget-crash-1.json", event }],
  });

  // A read before recovery already sees the crashed journal's state.
  assert.equal(readWorkflow(stateDir, request.id).state.budget.maxAttempts, 2);

  // The next call recovers the journal under the lock, then finds the event
  // already recorded and returns a duplicate instead of applying it again.
  const replay = increaseWorkflowBudget(
    stateDir,
    request.id,
    before.revision + 1,
    approval({
      eventId,
      maxAttempts: 2,
      approvalRef: "decision-2026-09-27",
      reason: "raise the limit",
    }),
  );
  assert.equal(replay.duplicate, true);
  assert.equal(replay.state.budget.maxAttempts, 2);
  assert.equal(replay.state.budget.history.length, 1);
  assert.equal(fs.existsSync(path.join(dir, "transaction.json")), false);
  assert.equal(
    fs.existsSync(path.join(dir, "events", "000002-budget-crash-1.json")),
    true,
  );
  const persisted = readJSON(path.join(dir, "state.json"));
  assert.equal(persisted.budget.maxAttempts, 2);
  assert.equal(persisted.budget.history.length, 1);
});

test("workflow-budget unblocks workflow-reserve once the attempt budget is raised", async (t) => {
  const { stateDir, request } = await twoTaskWorkflow(t, {
    id: "budget-unblocks-reserve",
    budget: { maxAttempts: 1, maxCalls: 10 },
  });
  const revision = () => readWorkflow(stateDir, request.id).state.revision;

  reserveExecution(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "reserve-a",
    taskId: "a",
    attemptId: "attempt-a",
    callAllowance: 1,
  });

  assert.throws(
    () =>
      reserveExecution(stateDir, request.id, revision(), {
        schemaVersion: 1,
        eventId: "reserve-b-blocked",
        taskId: "b",
        attemptId: "attempt-b",
        callAllowance: 1,
      }),
    /attempt budget exhausted/,
  );

  increaseWorkflowBudget(
    stateDir,
    request.id,
    revision(),
    approval({ eventId: "budget-unblock-1", maxAttempts: 2 }),
  );

  const reserved = reserveExecution(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "reserve-b-ok",
    taskId: "b",
    attemptId: "attempt-b",
    callAllowance: 1,
  });
  assert.equal(reserved.tasks.b.state, "reserved");
  assert.equal(reserved.budget.attemptsUsed, 2);
});
