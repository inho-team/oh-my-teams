/** Coverage for the runtime gaps closed in issues #98, #99, #100, #101 and #107. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  hash,
  readJSON,
  run,
  writeJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  attachExecution,
  acceptWorkflowIntegration,
  createWorkflow,
  extendIntegrationChecks,
  increaseCallAllowance,
  readWorkflow,
  recordSettlement,
  reopenTask,
  reworkTask,
  resumeWorkflow,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";
import {
  saveWorkflowState,
  workflowStateFile,
} from "../plugins/oh-my-teams/scripts/workflow-store.mjs";
import {
  DEFAULT_VERIFY_TIMEOUT_MS,
  MAX_VERIFY_TIMEOUT_MS,
  fingerprint,
  validateEvidence,
  verify,
} from "../plugins/oh-my-teams/scripts/evidence.mjs";
import { taskHash } from "../plugins/oh-my-teams/scripts/contracts.mjs";
import {
  acceptOutcome,
  gateCheck,
  recordReview,
} from "../plugins/oh-my-teams/scripts/gates.mjs";

const cli = path.resolve("plugins/oh-my-teams/scripts/teams-org.mjs");

async function cliRun(dir, ...args) {
  return run([process.execPath, cli, ...args], {
    cwd: dir,
    timeoutMs: 120000,
  });
}

const organization = readJSON(
  new URL("../plugins/oh-my-teams/examples/organization.json", import.meta.url),
);

async function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-runtime-gaps-"));
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

const task = (id, files = [`${id}.txt`], overrides = {}) => ({
  schemaVersion: 2,
  revision: 1,
  kind: "edit",
  id,
  goal: "Test workflow runtime gaps",
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
  ...overrides,
});

const receipt = (id) => ({
  executionId: id,
  runId: id,
  taskId: id,
  dispatchId: id,
  worktreeId: id,
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
    budget: budget ?? { maxAttempts: 2, maxCalls: 3 },
  };
  await createWorkflow(stateDir, request, structuredClone(organization), dir);
  return { dir, stateDir, request };
}

test("workflow-allowance raises a reserved attempt's allowance within budget and rejects overreach, staleness and duplicates", async (t) => {
  const { stateDir, request } = await singleTaskWorkflow(t, {
    id: "allowance-workflow",
    budget: { maxAttempts: 2, maxCalls: 3 },
  });
  attachExecution(stateDir, request.id, 1, {
    schemaVersion: 1,
    eventId: "attach-a",
    attemptId: "attempt-a",
    taskId: "a",
    callAllowance: 1,
    receipt: receipt("a"),
  });
  const revision = () => readWorkflow(stateDir, request.id).state.revision;

  assert.throws(
    () =>
      increaseCallAllowance(stateDir, request.id, revision(), {
        schemaVersion: 1,
        eventId: "allow-missing-reason",
        taskId: "a",
        attemptId: "attempt-a",
        allowance: 2,
        approvedBy: "pm",
        reason: "",
      }),
    /approver and reason/,
  );
  assert.throws(
    () =>
      increaseCallAllowance(stateDir, request.id, revision(), {
        schemaVersion: 1,
        eventId: "allow-too-much",
        taskId: "a",
        attemptId: "attempt-a",
        allowance: 4,
        approvedBy: "pm",
        reason: "Extra room to iterate",
      }),
    /unreserved call budget/,
  );
  assert.throws(
    () =>
      increaseCallAllowance(stateDir, request.id, revision() + 1, {
        schemaVersion: 1,
        eventId: "allow-stale",
        taskId: "a",
        attemptId: "attempt-a",
        allowance: 2,
        approvedBy: "pm",
        reason: "Extra room to iterate",
      }),
    /Workflow changed/,
  );

  const raised = increaseCallAllowance(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "allow-1",
    taskId: "a",
    attemptId: "attempt-a",
    allowance: 2,
    approvedBy: "pm",
    reason: "Extra room to iterate",
  });
  const attempt = raised.state.tasks.a.attempts.find(
    (candidate) => candidate.id === "attempt-a",
  );
  assert.equal(attempt.callAllowance, 2);
  assert.equal(attempt.allowanceHistory.at(-1).from, 1);
  assert.equal(attempt.allowanceHistory.at(-1).to, 2);

  const replay = increaseCallAllowance(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "allow-1",
    taskId: "a",
    attemptId: "attempt-a",
    allowance: 2,
    approvedBy: "pm",
    reason: "Extra room to iterate",
  });
  assert.equal(replay.duplicate, true);
});

test("workflow-allowance raises a settled attempt's allowance to unblock a rework rejected for exhausted calls", async (t) => {
  const { stateDir, request } = await singleTaskWorkflow(t, {
    id: "allowance-settled-workflow",
    budget: { maxAttempts: 2, maxCalls: 3 },
  });
  const revision = () => readWorkflow(stateDir, request.id).state.revision;

  attachExecution(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "attach-a",
    attemptId: "attempt-a",
    taskId: "a",
    callAllowance: 1,
    receipt: receipt("a"),
  });
  recordSettlement(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "settle-a",
    attemptId: "attempt-a",
    taskId: "a",
    executionId: "a",
    outcome: "settled",
    callsUsed: 1,
  });
  const settled = readWorkflow(stateDir, request.id).state.tasks.a;
  assert.equal(settled.state, "submitted");

  fs.mkdirSync(path.join(stateDir, "reviews"), { recursive: true });
  writeJSON(path.join(stateDir, "reviews", "review-a.json"), {
    schemaVersion: 1,
    id: "review-a",
    taskId: "a",
    taskHash: settled.taskHash,
    implementationExecutionId: "a",
    conclusion: "changes-requested",
    findings: [{ id: "f1", status: "open", description: "Needs a fix" }],
  });

  // The attempt's single call is already spent, so the rework the review
  // demands is blocked purely on budget, not on anything else about it.
  assert.throws(
    () =>
      reworkTask(stateDir, request.id, revision(), {
        schemaVersion: 1,
        eventId: "rework-blocked",
        taskId: "a",
        attemptId: "attempt-a",
        reviewId: "review-a",
        receipt: receipt("a-fix"),
      }),
    /no call remains for rework/,
  );

  const raised = increaseCallAllowance(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "allow-settled",
    taskId: "a",
    attemptId: "attempt-a",
    allowance: 2,
    approvedBy: "pm",
    reason: "Give the rework a call to run with",
  });
  assert.equal(
    raised.state.tasks.a.attempts.find((a) => a.id === "attempt-a")
      .callAllowance,
    2,
  );

  const reworked = reworkTask(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "rework-unblocked",
    taskId: "a",
    attemptId: "attempt-a",
    reviewId: "review-a",
    receipt: receipt("a-fix"),
  });
  assert.equal(reworked.tasks.a.state, "running");
  assert.equal(reworked.tasks.a.execution.executionId, "a-fix");
});

test("workflow-allowance rejects accepted, failed and pending tasks", async (t) => {
  const rawState = (stateDir, id) => readJSON(workflowStateFile(stateDir, id));
  const patchTaskState = (stateDir, id, newState) => {
    const state = rawState(stateDir, id);
    state.tasks.a.state = newState;
    saveWorkflowState(stateDir, id, state);
  };

  // accepted: settle, then move the task past review straight to accepted —
  // an allowance increase must not reach a task that is already done.
  {
    const { stateDir, request } = await singleTaskWorkflow(t, {
      id: "allowance-accepted-workflow",
      budget: { maxAttempts: 2, maxCalls: 3 },
    });
    const revision = () => readWorkflow(stateDir, request.id).state.revision;
    attachExecution(stateDir, request.id, revision(), {
      schemaVersion: 1,
      eventId: "attach-a",
      attemptId: "attempt-a",
      taskId: "a",
      callAllowance: 1,
      receipt: receipt("a"),
    });
    recordSettlement(stateDir, request.id, revision(), {
      schemaVersion: 1,
      eventId: "settle-a",
      attemptId: "attempt-a",
      taskId: "a",
      executionId: "a",
      outcome: "settled",
      callsUsed: 1,
    });
    patchTaskState(stateDir, request.id, "accepted");
    assert.throws(
      () =>
        increaseCallAllowance(stateDir, request.id, revision(), {
          schemaVersion: 1,
          eventId: "allow-accepted",
          taskId: "a",
          attemptId: "attempt-a",
          allowance: 2,
          approvedBy: "pm",
          reason: "Should not reach an accepted task",
        }),
      /has no reserved, running or settled attempt/,
    );
  }

  // failed: a still-attached attempt that never settled is not reworked, so
  // an allowance increase must not reach it either.
  {
    const { stateDir, request } = await singleTaskWorkflow(t, {
      id: "allowance-failed-workflow",
      budget: { maxAttempts: 2, maxCalls: 3 },
    });
    const revision = () => readWorkflow(stateDir, request.id).state.revision;
    attachExecution(stateDir, request.id, revision(), {
      schemaVersion: 1,
      eventId: "attach-a",
      attemptId: "attempt-a",
      taskId: "a",
      callAllowance: 1,
      receipt: receipt("a"),
    });
    patchTaskState(stateDir, request.id, "failed");
    assert.throws(
      () =>
        increaseCallAllowance(stateDir, request.id, revision(), {
          schemaVersion: 1,
          eventId: "allow-failed",
          taskId: "a",
          attemptId: "attempt-a",
          allowance: 2,
          approvedBy: "pm",
          reason: "Should not reach a failed task",
        }),
      /has no reserved, running or settled attempt/,
    );
  }

  // pending: never attached, so there is no attempt to raise at all.
  {
    const { stateDir, request } = await singleTaskWorkflow(t, {
      id: "allowance-pending-workflow",
      budget: { maxAttempts: 2, maxCalls: 3 },
    });
    const revision = () => readWorkflow(stateDir, request.id).state.revision;
    assert.throws(
      () =>
        increaseCallAllowance(stateDir, request.id, revision(), {
          schemaVersion: 1,
          eventId: "allow-pending",
          taskId: "a",
          attemptId: "attempt-a",
          allowance: 2,
          approvedBy: "pm",
          reason: "Should not reach a pending task",
        }),
      /has no reserved, running or settled attempt/,
    );
  }
});

test("workflow-reopen returns a settled task to pending as a new attempt and rejects the wrong state, exhausted budget and duplicates", async (t) => {
  const { stateDir, request } = await singleTaskWorkflow(t, {
    id: "reopen-workflow",
    budget: { maxAttempts: 1, maxCalls: 3 },
  });
  const revision = () => readWorkflow(stateDir, request.id).state.revision;

  assert.throws(
    () =>
      reopenTask(stateDir, request.id, revision(), {
        schemaVersion: 1,
        eventId: "reopen-too-early",
        taskId: "a",
        approvedBy: "pm",
        reason: "Manual override",
      }),
    /only a settled task/,
  );

  attachExecution(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "attach-a",
    attemptId: "attempt-a",
    taskId: "a",
    callAllowance: 1,
    receipt: receipt("a"),
  });
  recordSettlement(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "settle-a",
    attemptId: "attempt-a",
    taskId: "a",
    executionId: "a",
    outcome: "settled",
    callsUsed: 1,
  });
  assert.equal(
    readWorkflow(stateDir, request.id).state.tasks.a.state,
    "submitted",
  );

  // The single-attempt budget was already spent by the first attach, so a
  // reopen that would spend a second one must be refused before it happens.
  assert.throws(
    () =>
      reopenTask(stateDir, request.id, revision(), {
        schemaVersion: 1,
        eventId: "reopen-budget",
        taskId: "a",
        approvedBy: "pm",
        reason: "Manual override",
      }),
    /budget exhausted/,
  );
});

test("workflow-reopen opens a fresh attempt once attempt budget allows it", async (t) => {
  const { stateDir, request } = await singleTaskWorkflow(t, {
    id: "reopen-workflow-budgeted",
    budget: { maxAttempts: 2, maxCalls: 3 },
  });
  const revision = () => readWorkflow(stateDir, request.id).state.revision;

  attachExecution(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "attach-a",
    attemptId: "attempt-a",
    taskId: "a",
    callAllowance: 1,
    receipt: receipt("a"),
  });
  recordSettlement(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "settle-a",
    attemptId: "attempt-a",
    taskId: "a",
    executionId: "a",
    outcome: "settled",
    callsUsed: 1,
  });

  assert.throws(
    () =>
      reopenTask(stateDir, request.id, revision(), {
        schemaVersion: 1,
        eventId: "reopen-missing-reason",
        taskId: "a",
        approvedBy: "pm",
        reason: "",
      }),
    /approver and reason/,
  );

  const reopened = reopenTask(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "reopen-1",
    taskId: "a",
    approvedBy: "pm",
    reason: "PM wants another pass without a formal rejection",
  });
  assert.equal(reopened.duplicate, false);
  assert.equal(reopened.state.tasks.a.state, "pending");
  assert.equal(reopened.state.tasks.a.attemptId, null);
  assert.equal(reopened.state.tasks.a.rework.at(-1).category, "manual-reopen");

  const replay = reopenTask(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "reopen-1",
    taskId: "a",
    approvedBy: "pm",
    reason: "PM wants another pass without a formal rejection",
  });
  assert.equal(replay.duplicate, true);
});

test("verify records the caller's timeout in the evidence fingerprint and rejects an out-of-range one", async (t) => {
  const dir = await repo(t),
    store = path.join(
      await fs.promises.mkdtemp(path.join(os.tmpdir(), "evidence-")),
      "store",
    );
  t.after(() =>
    fs.rmSync(path.dirname(store), { recursive: true, force: true }),
  );
  const options = {
    commands: [[process.execPath, "-e", "process.exit(0)"]],
    environment: "test",
    store,
  };
  const withDefault = await verify(dir, options);
  assert.equal(withDefault.fingerprint.timeoutMs, DEFAULT_VERIFY_TIMEOUT_MS);

  const withCustom = await verify(dir, { ...options, timeoutMs: 1000 });
  assert.equal(withCustom.fingerprint.timeoutMs, 1000);
  assert.notEqual(withCustom.key, withDefault.key);

  await assert.rejects(
    () => verify(dir, { ...options, timeoutMs: MAX_VERIFY_TIMEOUT_MS + 1 }),
    /timeoutMs/,
  );
  await assert.rejects(
    () => verify(dir, { ...options, timeoutMs: 0 }),
    /timeoutMs/,
  );
});

test("validateEvidence and merge-check accept pre-#100 evidence that has no timeoutMs key, while a declared timeout still changes the key", async (t) => {
  const dir = await repo(t);
  // Evidence/task/log files live outside the repo so the repo's tree stays
  // exactly what it was when fingerprinted; an untracked file dropped inside
  // the repo would itself make every later fingerprint "stale" by changing
  // the tree hash, which is a different failure than the one under test.
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), "workflow-runtime-gaps-evidence-"),
  );
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const commands = [[process.execPath, "-e", "process.exit(0)"]];
  const environment = "test";

  // Reproduce the exact pre-#100 seven-key shape (head/base/tree/commands/
  // environment/platform/node, no timeoutMs) with the same fingerprint()
  // this runtime now uses, via the compatibility option that lets it.
  const oldFingerprint = await fingerprint(
    dir,
    "HEAD",
    commands,
    environment,
    DEFAULT_VERIFY_TIMEOUT_MS,
    { includeTimeout: false },
  );
  assert.equal(Object.hasOwn(oldFingerprint, "timeoutMs"), false);

  const logPath = path.join(scratch, "old-check-0.log");
  fs.writeFileSync(logPath, "ok\n");
  const oldEvidence = {
    schemaVersion: 1,
    key: hash(oldFingerprint),
    fingerprint: oldFingerprint,
    status: "passed",
    unchanged: true,
    checks: [
      {
        argv: commands[0],
        code: 0,
        timedOut: false,
        overflow: false,
        pid: 1,
        elapsedMs: 1,
        log: logPath,
        logHash: hash("ok\n"),
        tail: "ok\n",
      },
    ],
    createdAt: new Date().toISOString(),
  };

  await assert.doesNotReject(() => validateEvidence(dir, oldEvidence, "HEAD"));

  // A modern evidence file, with its declared timeout, must not collide with
  // the key-less shape above — timeoutMs still separates cache entries.
  const newFingerprint = await fingerprint(
    dir,
    "HEAD",
    commands,
    environment,
    1000,
  );
  assert.notEqual(hash(newFingerprint), oldEvidence.key);

  const taskFile = path.join(scratch, "merge-check-task.json");
  writeJSON(taskFile, {
    schemaVersion: 1,
    id: "merge-check-task",
    instruction: "Check something",
    files: ["seed.txt"],
    checks: commands,
    environment,
    baseRef: "HEAD",
    risk: "low",
  });
  const evidenceFile = path.join(scratch, "old-evidence.json");
  writeJSON(evidenceFile, oldEvidence);
  const merged = await cliRun(
    dir,
    "merge-check",
    "--evidence",
    evidenceFile,
    "--task",
    taskFile,
    "--repo",
    dir,
    "--base",
    "HEAD",
  );
  assert.equal(merged.code, 0, merged.stderr);
  assert.equal(JSON.parse(merged.stdout).valid, true);
});

test("fingerprint() preserves the exact key order that pre-#100 and current evidence were hashed under", async (t) => {
  const dir = await repo(t);
  const commands = [[process.execPath, "-e", "process.exit(0)"]];
  const environment = "test";

  // hash() feeds this object straight into JSON.stringify, so key insertion
  // order is part of what every stored evidence.key is bound to. These two
  // arrays are the exact orders every existing evidence file was hashed
  // under (pre-#100, and current); they are written here as literals, not
  // derived from Object.keys() of a value this same test just produced, so a
  // change that moves or inserts a key anywhere in fingerprint() — not only
  // a change to whether timeoutMs itself appears — fails this assertion
  // instead of only failing once some unrelated evidence file goes stale.
  const oldFingerprint = await fingerprint(
    dir,
    "HEAD",
    commands,
    environment,
    DEFAULT_VERIFY_TIMEOUT_MS,
    { includeTimeout: false },
  );
  assert.deepEqual(Object.keys(oldFingerprint), [
    "head",
    "base",
    "tree",
    "commands",
    "environment",
    "platform",
    "node",
  ]);

  const newFingerprint = await fingerprint(
    dir,
    "HEAD",
    commands,
    environment,
    DEFAULT_VERIFY_TIMEOUT_MS,
  );
  assert.deepEqual(Object.keys(newFingerprint), [
    "head",
    "base",
    "tree",
    "commands",
    "environment",
    "timeoutMs",
    "platform",
    "node",
  ]);
});

test("workflow-integration-checks appends new checks to a frozen integration task and refuses to change one already accepted", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  for (const id of ["a", "b"])
    writeJSON(path.join(dir, `${id}.json`), task(id));
  const integration = {
    ...task("integration"),
    checks: [[process.execPath, "-e", "process.exit(0)"]],
  };
  writeJSON(path.join(dir, "integration.json"), integration);
  const request = {
    schemaVersion: 1,
    id: "integration-checks-workflow",
    goal: "Verify combined result",
    repo: ".",
    integrationTask: "integration.json",
    tasks: [
      { file: "a.json", role: "junior" },
      { file: "b.json", role: "junior" },
    ],
    policy: { maxRunning: 2, maxReviewPending: 2 },
    budget: { maxAttempts: 3, maxCalls: 4 },
  };
  await createWorkflow(stateDir, request, structuredClone(organization), dir);
  const revision = () => readWorkflow(stateDir, request.id).state.revision;
  const before = readWorkflow(stateDir, request.id);
  const frozenBefore = readJSON(path.join(before.dir, "integration-task.json"));
  assert.equal(frozenBefore.checks.length, 1);

  assert.throws(
    () =>
      extendIntegrationChecks(stateDir, request.id, revision(), {
        schemaVersion: 1,
        eventId: "extend-missing-reason",
        checks: [[process.execPath, "-e", "process.exit(0)"]],
        approvedBy: "pm",
        reason: "",
      }),
    /approver and reason/,
  );

  const extended = extendIntegrationChecks(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "extend-1",
    checks: [[process.execPath, "-e", "process.exit(0)"]],
    approvedBy: "pm",
    reason: "Add a regression check the original contract missed",
  });
  assert.equal(extended.duplicate, false);
  const after = readWorkflow(stateDir, request.id);
  const frozenAfter = readJSON(path.join(after.dir, "integration-task.json"));
  assert.equal(frozenAfter.checks.length, 2);
  assert.deepEqual(frozenAfter.checks[0], frozenBefore.checks[0]);
  assert.equal(after.state.integration.taskHash, taskHash(frozenAfter));
  assert.notEqual(
    after.state.integration.taskHash,
    before.state.integration.taskHash,
  );

  const replay = extendIntegrationChecks(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "extend-1",
    checks: [[process.execPath, "-e", "process.exit(0)"]],
    approvedBy: "pm",
    reason: "Add a regression check the original contract missed",
  });
  assert.equal(replay.duplicate, true);

  // Drive both component tasks to acceptance, accept the (now two-check)
  // integration task, then confirm extension is refused after acceptance.
  for (const id of ["a", "b"]) {
    let current = readWorkflow(stateDir, request.id);
    attachExecution(stateDir, request.id, current.state.revision, {
      schemaVersion: 1,
      eventId: `attach-${id}`,
      attemptId: `attempt-${id}`,
      taskId: id,
      callAllowance: 1,
      receipt: receipt(id),
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
  const frozen = readJSON(path.join(snapshot.dir, "integration-task.json"));
  const verifyOptions = {
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
    evidence: await verify(dir, verifyOptions),
  };
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
  await acceptWorkflowIntegration(
    stateDir,
    request.id,
    snapshot.state.revision,
    dir,
    report,
  );

  assert.throws(
    () =>
      extendIntegrationChecks(
        stateDir,
        request.id,
        readWorkflow(stateDir, request.id).state.revision,
        {
          schemaVersion: 1,
          eventId: "extend-after-acceptance",
          checks: [[process.execPath, "-e", "process.exit(0)"]],
          approvedBy: "pm",
          reason: "Too late",
        },
      ),
    /already accepted/,
  );
});

const reviewableTask = (checks) =>
  task("reviewable", ["value.txt"], {
    checks,
    acceptance: [
      { id: "check", description: "check", method: "check", checkIndexes: [0] },
      { id: "scope-review", description: "review", method: "review" },
    ],
    reviewRequirements: [
      {
        id: "semantic-review",
        kind: "agent-review",
        role: "senior",
        criteria: ["scope-review"],
      },
    ],
  });

test("review-record accepts failed evidence to record a rejection but never to record an approval", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  const failing = reviewableTask([[process.execPath, "-e", "process.exit(1)"]]);
  const options = {
    baseRef: failing.baseRef,
    commands: failing.checks,
    environment: failing.environment,
    store: path.join(stateDir, "evidence"),
  };
  const failedEvidence = await verify(dir, options);
  assert.equal(failedEvidence.status, "failed");
  const report = {
    taskId: failing.id,
    taskHash: taskHash(failing),
    taskRevision: 1,
    runId: "impl-run",
    evidence: failedEvidence,
  };

  const rejection = {
    schemaVersion: 1,
    id: "review-rejects-failing-run",
    requirementId: "semantic-review",
    reviewer: { kind: "agent-review", role: "senior", executionId: "senior-1" },
    implementationExecutionId: report.runId,
    conclusion: "changes-requested",
    criteria: [
      {
        id: "scope-review",
        conclusion: "changes-requested",
        evidence: "The check itself fails; nothing to approve",
      },
    ],
    findings: [
      {
        id: "f-check-fails",
        status: "open",
        description: "Check exits non-zero",
      },
    ],
  };
  const { gateStatus } = await recordReview(
    dir,
    failing,
    report,
    rejection,
    stateDir,
  );
  assert.equal(gateStatus.gates["checks-passed"].status, "failed");
  assert.equal(gateStatus.state, "submitted");

  const bogusApproval = {
    ...rejection,
    id: "review-cannot-approve-failing-run",
    conclusion: "approved",
    criteria: [
      {
        id: "scope-review",
        conclusion: "approved",
        evidence: "Approving anyway",
      },
    ],
    findings: [],
  };
  await assert.rejects(
    () => recordReview(dir, failing, report, bogusApproval, stateDir),
    /Passing implementation evidence required|Evidence did not pass/,
  );
});
