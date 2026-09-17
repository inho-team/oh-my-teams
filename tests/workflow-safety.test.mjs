/** Adversarial tests for workflow capacity and execution-bound acceptance. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readJSON,
  run,
  writeJSON,
  hash,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  attachExecution,
  reserveExecution,
  acceptWorkflowIntegration,
  createWorkflow,
  resumeWorkflow,
  recordSettlement,
  readWorkflow,
  reworkTask,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";
import { work } from "../plugins/oh-my-teams/scripts/worker.mjs";
import { verify } from "../plugins/oh-my-teams/scripts/evidence.mjs";
import { taskHash } from "../plugins/oh-my-teams/scripts/contracts.mjs";
import { acceptOutcome } from "../plugins/oh-my-teams/scripts/gates.mjs";

test("component acceptance cannot bypass failed or stale integration evidence", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".omt/\n");
  for (const id of ["a", "b"])
    writeJSON(path.join(dir, `${id}.json`), task(id));
  const integration = {
    ...task("integration"),
    checks: [
      [
        process.execPath,
        "-e",
        "if(require('fs').readFileSync('seed.txt','utf8')!=='integrated')process.exit(1)",
      ],
    ],
  };
  writeJSON(path.join(dir, "integration.json"), integration);
  const request = {
    schemaVersion: 1,
    id: "integration-test",
    goal: "Verify combined result",
    repo: ".",
    integrationTask: "integration.json",
    tasks: [
      { file: "a.json", role: "intern" },
      { file: "b.json", role: "intern" },
    ],
    policy: { maxRunning: 2, maxReviewPending: 2 },
    budget: { maxAttempts: 3, maxCalls: 4 },
  };
  await createWorkflow(stateDir, request, structuredClone(organization), dir);
  for (const id of ["a", "b"]) {
    let current = readWorkflow(stateDir, request.id);
    attachExecution(stateDir, request.id, current.state.revision, {
      schemaVersion: 1,
      eventId: `attach-${id}`,
      attemptId: `attempt-${id}`,
      taskId: id,
      callAllowance: 1,
      receipt: {
        executionId: id,
        runId: id,
        taskId: id,
        dispatchId: id,
        worktreeId: id,
      },
    });
    current = readWorkflow(stateDir, request.id);
    recordSettlement(stateDir, request.id, current.state.revision, {
      schemaVersion: 1,
      eventId: `settle-${id}`,
      attemptId: `attempt-${id}`,
      taskId: id,
      executionId: id,
      outcome: "settled",
      callsUsed: 0,
    });
    writeJSON(path.join(stateDir, "gates", `${id}.json`), {
      runId: id,
      state: "accepted",
      gates: {
        "contract-ready": { taskHash: taskHash(current.tasks[id]) },
        "outcome-accepted": { decisionId: `accept-${id}` },
      },
    });
    resumeWorkflow(
      stateDir,
      request.id,
      readWorkflow(stateDir, request.id).state.revision,
    );
  }
  const snapshot = readWorkflow(stateDir, request.id);
  assert.equal(snapshot.state.status, "integration-pending");
  const frozen = readJSON(path.join(snapshot.dir, "integration-task.json"));
  const options = {
    baseRef: frozen.baseRef,
    commands: frozen.checks,
    environment: frozen.environment,
    store: path.join(stateDir, "evidence"),
  };
  const report = {
    taskId: frozen.id,
    taskHash: taskHash(frozen),
    taskRevision: 1,
    runId: "integration-run",
    evidence: await verify(dir, options),
  };
  await assert.rejects(
    () =>
      acceptWorkflowIntegration(
        stateDir,
        request.id,
        snapshot.state.revision,
        dir,
        report,
      ),
    /Passing implementation/,
  );
  fs.writeFileSync(path.join(dir, "seed.txt"), "integrated");
  report.evidence = await verify(dir, options);
  await acceptOutcome(
    dir,
    frozen,
    report,
    {
      schemaVersion: 1,
      id: "integration-decision",
      decider: { kind: "pm", executionId: "pm" },
      criteria: ["check"],
      basis: "Combined check passed",
    },
    stateDir,
  );
  const accepted = await acceptWorkflowIntegration(
    stateDir,
    request.id,
    snapshot.state.revision,
    dir,
    report,
  );
  assert.equal(accepted.status, "accepted");
  assert.equal(
    Object.keys(accepted.integration.decision.componentResults).length,
    2,
  );
  fs.writeFileSync(path.join(dir, "seed.txt"), "regressed");
  await assert.rejects(
    () =>
      acceptWorkflowIntegration(
        stateDir,
        request.id,
        accepted.revision,
        dir,
        report,
      ),
    /Stale evidence/,
  );
});

test("worker enforces persisted workflow allowance before a second provider call", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  const fallbackOrganization = structuredClone(organization);
  fallbackOrganization.roles.intern.fallbacks = ["agy-oss"];
  fs.writeFileSync(path.join(dir, ".gitignore"), ".omt/\n");
  fs.writeFileSync(path.join(dir, "a.txt"), "unchanged");
  writeJSON(path.join(dir, "a.json"), task("a"));
  const request = {
    schemaVersion: 1,
    id: "worker-budget",
    goal: "Bound actual provider calls",
    repo: ".",
    tasks: [{ file: "a.json", role: "intern" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 2, maxCalls: 1 },
  };
  await createWorkflow(stateDir, request, fallbackOrganization, dir);
  attachExecution(stateDir, request.id, 1, {
    schemaVersion: 1,
    eventId: "attached",
    attemptId: "attempt-a",
    taskId: "a",
    callAllowance: 1,
    receipt: {
      executionId: "exec-a",
      runId: "run-a",
      taskId: "orca-a",
      dispatchId: "dispatch-a",
      worktreeId: "wt-a",
    },
  });
  const frozen = readWorkflow(stateDir, request.id).tasks.a;
  let calls = 0;
  const options = {
    stateDir,
    workflowId: request.id,
    attemptId: "attempt-a",
    call: async () => {
      calls++;
      return {
        code: 0,
        stdout: "{}",
        stderr: "",
        text: '{"edits":[]}',
        elapsedMs: 1,
      };
    },
  };
  await assert.rejects(
    () => work(dir, structuredClone(fallbackOrganization), frozen, options),
    /allowance exhausted/,
  );
  assert.equal(calls, 1);
  assert.equal(
    readWorkflow(stateDir, request.id).state.tasks.a.attempts[0].callsStarted,
    1,
  );
  await assert.rejects(
    () => work(dir, structuredClone(fallbackOrganization), frozen, options),
    /already has a worker/,
  );
  assert.equal(calls, 1);
  const state = readWorkflow(stateDir, request.id).state;
  assert.throws(
    () =>
      recordSettlement(stateDir, request.id, state.revision, {
        schemaVersion: 1,
        eventId: "settle",
        attemptId: "attempt-a",
        taskId: "a",
        executionId: "exec-a",
        outcome: "settled",
        callsUsed: 0,
      }),
    /budget/,
  );
});

test("a one-task workflow closes on its task's acceptance, without an integration task", async (t) => {
  // #39: createWorkflow makes integration optional for a single task, yet
  // workflow-accept demanded integration-task.json and refused to close it.
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  writeJSON(path.join(dir, "a.json"), task("a"));
  const request = {
    schemaVersion: 1,
    id: "single-task",
    goal: "Write one report",
    repo: ".",
    tasks: [{ file: "a.json", role: "intern" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 1, maxCalls: 1 },
  };
  await createWorkflow(stateDir, request, structuredClone(organization), dir);
  assert.equal(
    readWorkflow(stateDir, request.id).state.integration.required,
    false,
  );
  let current = readWorkflow(stateDir, request.id);
  attachExecution(stateDir, request.id, current.state.revision, {
    schemaVersion: 1,
    eventId: "attach-a",
    attemptId: "attempt-a",
    taskId: "a",
    callAllowance: 1,
    receipt: {
      executionId: "a",
      runId: "a",
      taskId: "a",
      dispatchId: "a",
      worktreeId: "a",
    },
  });
  current = readWorkflow(stateDir, request.id);
  recordSettlement(stateDir, request.id, current.state.revision, {
    schemaVersion: 1,
    eventId: "settle-a",
    attemptId: "attempt-a",
    taskId: "a",
    executionId: "a",
    outcome: "settled",
    callsUsed: 0,
  });
  // Before the task is accepted, the refusal names what is still open.
  await assert.rejects(
    acceptWorkflowIntegration(
      stateDir,
      request.id,
      readWorkflow(stateDir, request.id).state.revision,
    ),
    /must be accepted first: a \(submitted\)/,
  );
  writeJSON(path.join(stateDir, "gates", "a.json"), {
    runId: "a",
    state: "accepted",
    gates: {
      "contract-ready": { taskHash: taskHash(current.tasks.a) },
      "outcome-accepted": { decisionId: "accept-a" },
    },
  });
  resumeWorkflow(
    stateDir,
    request.id,
    readWorkflow(stateDir, request.id).state.revision,
  );
  const before = readWorkflow(stateDir, request.id).state;
  const accepted = await acceptWorkflowIntegration(
    stateDir,
    request.id,
    before.revision,
  );
  assert.equal(accepted.status, "accepted");
  assert.equal(
    accepted.integration.decision.componentResults.a.acceptedResult,
    "accept-a",
  );
  // Closing it again changes nothing.
  const again = await acceptWorkflowIntegration(
    stateDir,
    request.id,
    accepted.revision,
  );
  assert.equal(again.revision, accepted.revision);
});

test("a review that asks for changes hands the task back within its attempt", async (t) => {
  // #38: the corrected execution's gate was accepted, yet the task stayed
  // submitted, because it was bound to the execution first attached and no
  // command could attach the correction.
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  writeJSON(path.join(dir, "a.json"), task("a"));
  const request = {
    schemaVersion: 1,
    id: "rework-loop",
    goal: "Write a report a reviewer accepts",
    repo: ".",
    tasks: [{ file: "a.json", role: "intern" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 1, maxCalls: 3 },
  };
  await createWorkflow(stateDir, request, structuredClone(organization), dir);
  const revision = () => readWorkflow(stateDir, request.id).state.revision;
  const receipt = (executionId) => ({
    executionId,
    runId: "run",
    taskId: "orca-task",
    dispatchId: executionId,
    worktreeId: "repo::/w/report",
  });
  attachExecution(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "attach-first",
    attemptId: "attempt-1",
    taskId: "a",
    callAllowance: 2,
    receipt: receipt("first"),
  });
  recordSettlement(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "settle-first",
    attemptId: "attempt-1",
    taskId: "a",
    executionId: "first",
    outcome: "settled",
    callsUsed: 1,
  });
  const { taskHash: hashOfA } = readWorkflow(stateDir, request.id).state.tasks
    .a;
  const review = (id, implementationExecutionId, conclusion, findings) =>
    writeJSON(path.join(stateDir, "reviews", `${id}.json`), {
      schemaVersion: 1,
      id,
      taskId: "a",
      taskHash: hashOfA,
      implementationExecutionId,
      conclusion,
      findings,
    });
  const rework = (eventId, reviewId, executionId) =>
    reworkTask(stateDir, request.id, revision(), {
      schemaVersion: 1,
      eventId,
      taskId: "a",
      attemptId: "attempt-1",
      reviewId,
      receipt: receipt(executionId),
    });
  review("approve-first", "first", "approved", []);
  review("reject-first", "first", "changes-requested", [
    { id: "unsupported-claim", status: "open", description: "No source." },
  ]);
  review("reject-other", "someone-else", "changes-requested", []);

  assert.throws(
    () => rework("rw-approved", "approve-first", "second"),
    /nothing to rework/,
  );
  assert.throws(
    () => rework("rw-other", "reject-other", "second"),
    /did not review this task's current execution/,
  );
  assert.throws(
    () => rework("rw-missing", "never-recorded", "second"),
    /Review not recorded/,
  );
  assert.throws(
    () => rework("rw-same", "reject-first", "first"),
    /new execution/,
  );

  const reworked = rework("rw-1", "reject-first", "second");
  assert.equal(reworked.tasks.a.state, "running");
  assert.equal(reworked.tasks.a.execution.executionId, "second");
  // The review sent the work back, so no new attempt is spent.
  assert.equal(reworked.budget.attemptsUsed, 1);
  const attempt = reworked.tasks.a.attempts[0];
  assert.equal(attempt.previousReceipts[0].executionId, "first");
  assert.equal(attempt.priorCallsUsed, 1);
  assert.deepEqual(reworked.tasks.a.rework[0].openFindings, [
    "unsupported-claim",
  ]);
  // Replaying the same event changes nothing.
  assert.equal(rework("rw-1", "reject-first", "second").duplicate, true);

  // The allowance covers both executions: 1 + 2 would exceed 2.
  const settle = (eventId, callsUsed) =>
    recordSettlement(stateDir, request.id, revision(), {
      schemaVersion: 1,
      eventId,
      attemptId: "attempt-1",
      taskId: "a",
      executionId: "second",
      outcome: "settled",
      callsUsed,
    });
  assert.throws(() => settle("settle-over", 2), /call budget exceeded/);
  settle("settle-second", 1);

  // A gate from the first execution still does not advance the task; the
  // corrected execution's accepted gate does.
  const gate = (runId, decisionId) =>
    writeJSON(path.join(stateDir, "gates", "a.json"), {
      runId,
      state: "accepted",
      gates: {
        "contract-ready": { taskHash: hashOfA },
        "outcome-accepted": { decisionId },
      },
    });
  gate("first", "accept-first");
  assert.equal(
    resumeWorkflow(stateDir, request.id, revision()).state.tasks.a.state,
    "submitted",
  );

  // With both calls spent, another rejection has no call left to rework with.
  review("reject-second", "second", "inconclusive", []);
  assert.throws(
    () => rework("rw-2", "reject-second", "third"),
    /used 2 of 2 calls/,
  );

  gate("second", "accept-second");
  const resumed = resumeWorkflow(stateDir, request.id, revision()).state;
  assert.equal(resumed.tasks.a.state, "accepted");
  assert.equal(resumed.tasks.a.acceptedResult, "accept-second");
  const accepted = await acceptWorkflowIntegration(
    stateDir,
    request.id,
    resumed.revision,
  );
  assert.equal(accepted.status, "accepted");
});

const organization = readJSON(
  new URL("../plugins/oh-my-teams/examples/organization.json", import.meta.url),
);

test("prelaunch reservation blocks duplicate launches and attaches without spending twice", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  writeJSON(path.join(dir, "a.json"), task("a"));
  writeJSON(path.join(dir, "b.json"), task("b"));
  const request = {
    schemaVersion: 1,
    id: "prelaunch",
    goal: "Reserve before launch",
    repo: ".",
    tasks: [
      { file: "a.json", role: "intern" },
      { file: "b.json", role: "intern" },
    ],
    policy: { maxRunning: 1, maxReviewPending: 2 },
    budget: { maxAttempts: 2, maxCalls: 2 },
  };
  await createWorkflow(stateDir, request, structuredClone(organization), dir);
  const input = {
    schemaVersion: 1,
    eventId: "reserve-a",
    attemptId: "attempt-a",
    taskId: "a",
    callAllowance: 2,
  };
  const reserved = reserveExecution(stateDir, request.id, 1, input);
  assert.equal(reserved.tasks.a.state, "reserved");
  assert.equal(reserved.tasks.a.execution, null);
  assert.equal(
    reserveExecution(stateDir, request.id, 1, input).duplicate,
    true,
  );
  const resumed = resumeWorkflow(stateDir, request.id, 2);
  assert.deepEqual(
    resumed.actions.map((action) => action.type),
    ["launch-reconcile-required"],
  );
  assert.throws(
    () =>
      reserveExecution(stateDir, request.id, 3, {
        ...input,
        eventId: "reserve-b",
        attemptId: "attempt-b",
        taskId: "b",
      }),
    /capacity/,
  );
  const attached = attachExecution(stateDir, request.id, 3, {
    ...input,
    eventId: "attach-a",
    receipt: {
      executionId: "exec",
      runId: "run",
      taskId: "task",
      dispatchId: "dispatch",
      worktreeId: "worktree",
    },
  });
  assert.equal(attached.tasks.a.state, "running");
  assert.equal(attached.budget.attemptsUsed, 1);
  assert.equal(attached.tasks.a.attempts[0].callAllowance, 2);
});

test("parallel attempts reserve allowances and reject spending another attempt budget", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  writeJSON(path.join(dir, "a.json"), task("a"));
  writeJSON(path.join(dir, "b.json"), task("b"));
  const request = {
    schemaVersion: 1,
    id: "reserved",
    goal: "Bound parallel usage",
    repo: ".",
    tasks: [
      { file: "a.json", role: "intern" },
      { file: "b.json", role: "intern" },
    ],
    policy: { maxRunning: 2, maxReviewPending: 2 },
    budget: { maxAttempts: 3, maxCalls: 3 },
  };
  // Reservation discipline, not slot exhaustion, is under test here, so this
  // organization opts into a second intern slot instead of inheriting the
  // single shared-pool slot the shipped examples pin.
  const parallelOrganization = structuredClone(organization);
  parallelOrganization.roles.intern.concurrency = 2;
  await createWorkflow(stateDir, request, parallelOrganization, dir);
  const receipt = (id) => ({
    executionId: id,
    runId: id,
    taskId: id,
    dispatchId: id,
    worktreeId: id,
  });
  attachExecution(stateDir, "reserved", 1, {
    schemaVersion: 1,
    eventId: "attach-a",
    attemptId: "attempt-a",
    taskId: "a",
    callAllowance: 2,
    receipt: receipt("a"),
  });
  assert.throws(
    () =>
      attachExecution(stateDir, "reserved", 2, {
        schemaVersion: 1,
        eventId: "attach-b",
        attemptId: "attempt-b",
        taskId: "b",
        callAllowance: 2,
        receipt: receipt("b"),
      }),
    /unreserved/,
  );
  attachExecution(stateDir, "reserved", 2, {
    schemaVersion: 1,
    eventId: "attach-b",
    attemptId: "attempt-b",
    taskId: "b",
    callAllowance: 1,
    receipt: receipt("b"),
  });
  assert.throws(
    () =>
      recordSettlement(stateDir, "reserved", 3, {
        schemaVersion: 1,
        eventId: "settle-b",
        attemptId: "attempt-b",
        taskId: "b",
        executionId: "b",
        outcome: "settled",
        callsUsed: 2,
      }),
    /budget/,
  );
  const settled = recordSettlement(stateDir, "reserved", 3, {
    schemaVersion: 1,
    eventId: "settle-b",
    attemptId: "attempt-b",
    taskId: "b",
    executionId: "b",
    outcome: "settled",
    callsUsed: 1,
  });
  assert.equal(settled.state.budget.callsUsed, 1);
});
const task = (id, files = [`${id}.txt`]) => ({
  schemaVersion: 2,
  revision: 1,
  kind: "edit",
  id,
  goal: "Test workflow safety",
  instruction: "Make the change",
  nonGoals: [],
  constraints: [],
  files,
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

async function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-safety-"));
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

test("attachExecution enforces workflow running capacity and active conflicts", async (t) => {
  const dir = await repo(t);
  const stateDir = path.join(dir, ".omt");
  const first = task("first", ["shared.txt"]);
  const second = task("second", ["shared.txt"]);
  writeJSON(path.join(dir, "first.json"), first);
  writeJSON(path.join(dir, "second.json"), second);
  const request = {
    schemaVersion: 1,
    id: "safety-capacity",
    goal: "test",
    repo: ".",
    tasks: [
      { file: "first.json", role: "intern" },
      { file: "second.json", role: "intern" },
    ],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 3, maxCalls: 3 },
  };
  await createWorkflow(stateDir, request, structuredClone(organization), dir);
  resumeWorkflow(stateDir, request.id, 1);
  attachExecution(stateDir, request.id, 2, {
    schemaVersion: 1,
    eventId: "attach-first",
    attemptId: "attempt-first",
    taskId: "first",
    receipt: {
      executionId: "exec-first",
      runId: "run-first",
      taskId: "orca-first",
      dispatchId: "dispatch-first",
      worktreeId: "wt-first",
    },
  });
  assert.throws(
    () =>
      attachExecution(stateDir, request.id, 3, {
        schemaVersion: 1,
        eventId: "attach-second",
        attemptId: "attempt-second",
        taskId: "second",
        receipt: {
          executionId: "exec-second",
          runId: "run-second",
          taskId: "orca-second",
          dispatchId: "dispatch-second",
          worktreeId: "wt-second",
        },
      }),
    /running capacity|conflicts/,
  );

  const conflictRequest = {
    ...request,
    id: "safety-conflict",
    policy: { maxRunning: 2, maxReviewPending: 1 },
  };
  await createWorkflow(
    stateDir,
    conflictRequest,
    structuredClone(organization),
    dir,
  );
  resumeWorkflow(stateDir, conflictRequest.id, 1);
  attachExecution(stateDir, conflictRequest.id, 2, {
    schemaVersion: 1,
    eventId: "attach-conflict-first",
    attemptId: "attempt-conflict-first",
    taskId: "first",
    receipt: {
      executionId: "exec-conflict-first",
      runId: "run-conflict-first",
      taskId: "orca-conflict-first",
      dispatchId: "dispatch-conflict-first",
      worktreeId: "wt-conflict-first",
    },
  });
  assert.throws(
    () =>
      attachExecution(stateDir, conflictRequest.id, 3, {
        schemaVersion: 1,
        eventId: "attach-conflict-second",
        attemptId: "attempt-conflict-second",
        taskId: "second",
        receipt: {
          executionId: "exec-conflict-second",
          runId: "run-conflict-second",
          taskId: "orca-conflict-second",
          dispatchId: "dispatch-conflict-second",
          worktreeId: "wt-conflict-second",
        },
      }),
    /conflicts/,
  );
});

test("resumeWorkflow rejects pending and stale-execution gates", async (t) => {
  const dir = await repo(t);
  const stateDir = path.join(dir, ".omt");
  const item = task("gated");
  writeJSON(path.join(dir, "gated.json"), item);
  const request = {
    schemaVersion: 1,
    id: "safety-gate",
    goal: "test",
    repo: ".",
    tasks: [{ file: "gated.json", role: "intern" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 2, maxCalls: 3 },
  };
  await createWorkflow(stateDir, request, structuredClone(organization), dir);
  fs.mkdirSync(path.join(stateDir, "gates"), { recursive: true });
  const frozen = readJSON(
    path.join(
      stateDir,
      "workflows",
      request.id,
      "tasks",
      "gated",
      "revisions",
      "1.json",
    ),
  );
  const { taskHash } =
    await import("../plugins/oh-my-teams/scripts/contracts.mjs");
  writeJSON(path.join(stateDir, "gates", "gated.json"), {
    runId: "wrong-execution",
    state: "accepted",
    gates: {
      "contract-ready": { taskHash: taskHash(frozen) },
      "outcome-accepted": { decisionId: "accepted" },
    },
  });
  const first = resumeWorkflow(stateDir, request.id, 1);
  assert.equal(first.state.tasks.gated.state, "pending");
  attachExecution(stateDir, request.id, 2, {
    schemaVersion: 1,
    eventId: "attach-gated",
    attemptId: "attempt-gated",
    taskId: "gated",
    receipt: {
      executionId: "exec-gated",
      runId: "run-gated",
      taskId: "orca-gated",
      dispatchId: "dispatch-gated",
      worktreeId: "wt-gated",
    },
  });
  const stale = resumeWorkflow(stateDir, request.id, 3, {
    "attempt-gated": {
      executionId: "exec-gated",
      status: "settled",
      eventId: "observed-gated",
      callsUsed: 0,
    },
  });
  assert.equal(stale.state.tasks.gated.state, "submitted");
  const gateFile = path.join(stateDir, "gates", "gated.json");
  writeJSON(gateFile, {
    runId: "exec-gated",
    state: "accepted",
    gates: {
      "contract-ready": { taskHash: taskHash(frozen) },
      "outcome-accepted": { decisionId: "accepted" },
    },
  });
  assert.equal(
    resumeWorkflow(stateDir, request.id, 4).state.tasks.gated.state,
    "accepted",
  );
  writeJSON(gateFile, {
    runId: "exec-gated",
    state: "submitted",
    gates: {
      "contract-ready": { taskHash: taskHash(frozen) },
      "review-complete": { status: "pending" },
    },
  });
  const revoked = resumeWorkflow(stateDir, request.id, 5);
  assert.equal(revoked.state.tasks.gated.state, "review-pending");
  assert.equal(revoked.state.tasks.gated.acceptedResult, null);
});

test("headless receipt: valid receipt passes, invalid receipts are rejected", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  writeJSON(path.join(dir, "a.json"), task("a"));
  const request = {
    schemaVersion: 1,
    id: "headless-receipt-test",
    goal: "Test headless receipt validation",
    repo: ".",
    tasks: [{ file: "a.json", role: "intern" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 3, maxCalls: 3 },
  };
  await createWorkflow(stateDir, request, structuredClone(organization), dir);

  // goodReceipt 검증에 필요한 headless worker.json을 stateDir에 기록한다.
  const worktreePath = path.join(dir, "worktree-abc123");
  fs.mkdirSync(worktreePath, { recursive: true });
  const workerDir = path.join(stateDir, "headless", "worker-abc123");
  fs.mkdirSync(workerDir, { recursive: true });
  writeJSON(path.join(workerDir, "worker.json"), {
    schemaVersion: 1,
    id: "worker-abc123",
    role: "junior",
    profile: "agy-profile",
    provider: "agy",
    binary: ["agy"],
    modelRequested: "gemini-3.1-pro-high",
    effortRequested: null,
    cwd: worktreePath,
    timeoutMs: 1800000,
    createdAt: new Date().toISOString(),
  });

  // 올바른 headless receipt는 통과한다.
  const repoId = "uuid";
  const worktreeId = `${repoId}::${worktreePath}`;
  const goodReceipt = {
    via: "headless-start",
    executionId: "worker-abc123",
    runId: "run_worker-abc123",
    taskId: "headless:worker-abc123",
    dispatchId: "headless:worker-abc123",
    worktreeId,
    runnerPid: 1234,
    modelRequested: "gemini-3.1-pro-high",
  };
  const attached = attachExecution(stateDir, request.id, 1, {
    schemaVersion: 1,
    eventId: "attach-headless-good",
    attemptId: "attempt-headless-good",
    taskId: "a",
    callAllowance: 1,
    receipt: goodReceipt,
  });
  assert.equal(attached.tasks.a.state, "running");
  assert.equal(attached.tasks.a.execution.via, "headless-start");

  // 접두사 불일치: taskId가 headless:<executionId> 형식이 아님
  await createWorkflow(
    stateDir,
    { ...request, id: "headless-receipt-reject-1" },
    structuredClone(organization),
    dir,
  );
  assert.throws(
    () =>
      attachExecution(stateDir, "headless-receipt-reject-1", 1, {
        schemaVersion: 1,
        eventId: "attach-bad-prefix",
        attemptId: "attempt-bad-prefix",
        taskId: "a",
        callAllowance: 1,
        receipt: {
          via: "headless-start",
          executionId: "worker-xyz",
          runId: "run_xyz",
          taskId: "task_123", // 접두사 불일치
          dispatchId: "headless:worker-xyz",
          worktreeId,
        },
      }),
    /taskId must be/,
    "접두사 불일치 taskId는 거부해야 한다",
  );

  // 다른 worker ID (케이스 1): worker 기록이 없는 executionId
  await createWorkflow(
    stateDir,
    { ...request, id: "headless-receipt-reject-2a" },
    structuredClone(organization),
    dir,
  );
  assert.throws(
    () =>
      attachExecution(stateDir, "headless-receipt-reject-2a", 1, {
        schemaVersion: 1,
        eventId: "attach-no-worker-record",
        attemptId: "attempt-no-worker-record",
        taskId: "a",
        callAllowance: 1,
        receipt: {
          via: "headless-start",
          executionId: "worker-nonexistent", // worker.json이 없는 ID
          runId: "run_nonexistent",
          taskId: "headless:worker-nonexistent",
          dispatchId: "headless:worker-nonexistent",
          worktreeId,
        },
      }),
    /worker record not found/,
    "worker 기록이 없는 executionId는 거부해야 한다",
  );

  // 다른 worker ID (케이스 2): 작업 경로가 다른 worker 기록
  await createWorkflow(
    stateDir,
    { ...request, id: "headless-receipt-reject-2b" },
    structuredClone(organization),
    dir,
  );
  const workerDirWrong = path.join(stateDir, "headless", "worker-wrong-path");
  fs.mkdirSync(workerDirWrong, { recursive: true });
  writeJSON(path.join(workerDirWrong, "worker.json"), {
    schemaVersion: 1,
    id: "worker-wrong-path",
    role: "junior",
    profile: "agy-profile",
    provider: "agy",
    binary: ["agy"],
    modelRequested: null,
    effortRequested: null,
    cwd: path.join(dir, "different-worktree"), // 다른 경로
    timeoutMs: 1800000,
    createdAt: new Date().toISOString(),
  });
  assert.throws(
    () =>
      attachExecution(stateDir, "headless-receipt-reject-2b", 1, {
        schemaVersion: 1,
        eventId: "attach-wrong-path",
        attemptId: "attempt-wrong-path",
        taskId: "a",
        callAllowance: 1,
        receipt: {
          via: "headless-start",
          executionId: "worker-wrong-path",
          runId: "run_wrong",
          taskId: "headless:worker-wrong-path",
          dispatchId: "headless:worker-wrong-path",
          worktreeId, // worktreePath와 다른 cwd를 가진 worker
        },
      }),
    /worktreeId path does not match/,
    "작업 경로가 다른 worker 기록은 거부해야 한다",
  );

  // via 누락: 기존 Orca receipt로 간주되어 기존 검사만 적용 (headless 접두사 검사 없음)
  await createWorkflow(
    stateDir,
    { ...request, id: "headless-receipt-no-via" },
    structuredClone(organization),
    dir,
  );
  // via 없이 일반 Orca receipt 형식이면 통과한다.
  const noViaAttached = attachExecution(
    stateDir,
    "headless-receipt-no-via",
    1,
    {
      schemaVersion: 1,
      eventId: "attach-no-via",
      attemptId: "attempt-no-via",
      taskId: "a",
      callAllowance: 1,
      receipt: {
        executionId: "exec-no-via",
        runId: "run-no-via",
        taskId: "orca-task",
        dispatchId: "dispatch-no-via",
        worktreeId: "wt-no-via",
      },
    },
  );
  assert.equal(noViaAttached.tasks.a.state, "running");

  // 필수 필드 누락: worktreeId 없음
  await createWorkflow(
    stateDir,
    { ...request, id: "headless-receipt-missing-field" },
    structuredClone(organization),
    dir,
  );
  assert.throws(
    () =>
      attachExecution(stateDir, "headless-receipt-missing-field", 1, {
        schemaVersion: 1,
        eventId: "attach-missing-field",
        attemptId: "attempt-missing-field",
        taskId: "a",
        callAllowance: 1,
        receipt: {
          via: "headless-start",
          executionId: "worker-def",
          runId: "run_def",
          taskId: "headless:worker-def",
          dispatchId: "headless:worker-def",
          // worktreeId 누락
        },
      }),
    /receipt ids required/,
    "필수 필드 누락은 거부해야 한다",
  );
});
