/** Coverage for the `04. 검토`/`05. 수용` document ownership hooks in gates.mjs (design 3.7 item 5). */
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
import { verify } from "../plugins/oh-my-teams/scripts/evidence.mjs";
import { taskHash } from "../plugins/oh-my-teams/scripts/contracts.mjs";
import {
  acceptOutcome,
  gateCheck,
  recordReview,
} from "../plugins/oh-my-teams/scripts/gates.mjs";
import {
  acceptWorkflowIntegration,
  attachExecution,
  createWorkflow,
  readWorkflow,
  recordSettlement,
  resumeWorkflow,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";
import {
  buildDocId,
  saveDocument,
} from "../plugins/oh-my-teams/scripts/documents.mjs";

const organization = readJSON(
  new URL("../plugins/oh-my-teams/examples/organization.json", import.meta.url),
);

const KICKOFF_HASH = "b".repeat(64);
const OTHER_KICKOFF_HASH = "c".repeat(64);
const WORKFLOW_ID = "wf-gate-hooks";

async function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gates-document-hooks-"));
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

const task = (id, overrides = {}) => ({
  schemaVersion: 2,
  revision: 1,
  kind: "edit",
  id,
  goal: "Test gate document hooks",
  instruction: "Make the change",
  nonGoals: [],
  constraints: [],
  files: [`${id}.txt`],
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

async function passingReport(dir, stateDir, definedTask, runId) {
  const evidence = await verify(dir, {
    baseRef: definedTask.baseRef,
    commands: definedTask.checks,
    environment: definedTask.environment,
    store: path.join(stateDir, "evidence"),
  });
  assert.equal(evidence.status, "passed");
  return {
    taskId: definedTask.id,
    taskHash: taskHash(definedTask),
    taskRevision: definedTask.revision,
    runId,
    evidence,
  };
}

function envelope({
  kickoffHash,
  workflowId = null,
  stageSlug,
  docType,
  localId,
}) {
  return {
    schemaVersion: 1,
    docId: buildDocId({ kickoffHash, workflowId, stageSlug, docType, localId }),
    stage: stageSlug,
    kickoffId: kickoffHash,
    workflowId,
    revision: 1,
    state: "resolved",
    author: { role: "senior", executionId: "doc-writer" },
    createdAt: new Date().toISOString(),
    basedOnRevision: null,
    reason: "test fixture",
  };
}

const saveReviewRef = (stateDir, kickoffHash, workflowId, reviewId) =>
  saveDocument(
    stateDir,
    envelope({
      kickoffHash,
      workflowId,
      stageSlug: "review",
      docType: "review-ref",
      localId: reviewId,
    }),
  );

const saveAcceptanceRef = (stateDir, kickoffHash, workflowId, decisionId) =>
  saveDocument(
    stateDir,
    envelope({
      kickoffHash,
      workflowId,
      stageSlug: "acceptance",
      docType: "acceptance-ref",
      localId: decisionId,
    }),
  );

const reviewInput = (overrides = {}) => ({
  schemaVersion: 1,
  id: "review-1",
  requirementId: "semantic-review",
  reviewer: { kind: "agent-review", role: "senior", executionId: "senior-1" },
  implementationExecutionId: "impl-run",
  conclusion: "approved",
  criteria: [
    {
      id: "scope-review",
      conclusion: "approved",
      evidence: "Diff matches scope",
    },
  ],
  findings: [],
  ...overrides,
});

const reviewGateTask = (id) =>
  task(id, {
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

test("review-complete stays pending until the review-ref document is committed, then passes", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  const definedTask = reviewGateTask("review-gate");
  const report = await passingReport(dir, stateDir, definedTask, "impl-run");

  const { gateStatus: recorded } = await recordReview(
    dir,
    definedTask,
    report,
    reviewInput(),
    stateDir,
    { kickoffHash: KICKOFF_HASH, workflowId: WORKFLOW_ID },
  );
  assert.equal(recorded.gates["review-complete"].status, "pending");

  saveReviewRef(stateDir, KICKOFF_HASH, WORKFLOW_ID, "review-1");
  const afterCommit = await gateCheck(dir, definedTask, report, stateDir, {
    kickoffHash: KICKOFF_HASH,
    workflowId: WORKFLOW_ID,
  });
  assert.equal(afterCommit.gates["review-complete"].status, "passed");
  assert.deepEqual(afterCommit.gates["review-complete"].reviewIds, [
    "review-1",
  ]);
});

test("a review-ref document owned by a different kickoff or workflow does not satisfy review-complete", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  const definedTask = reviewGateTask("review-gate-ownership");
  const report = await passingReport(dir, stateDir, definedTask, "impl-run");

  await recordReview(
    dir,
    definedTask,
    report,
    reviewInput({ id: "review-2" }),
    stateDir,
  );
  saveReviewRef(stateDir, OTHER_KICKOFF_HASH, WORKFLOW_ID, "review-2");

  const gates = await gateCheck(dir, definedTask, report, stateDir, {
    kickoffHash: KICKOFF_HASH,
    workflowId: WORKFLOW_ID,
  });
  assert.equal(gates.gates["review-complete"].status, "pending");
});

test("outcome-accepted stays pending until the acceptance-ref document is committed, then passes", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  const definedTask = task("acceptance-gate");
  const report = await passingReport(dir, stateDir, definedTask, "impl-run");
  const decision = {
    schemaVersion: 1,
    id: "decision-1",
    decider: { kind: "pm", executionId: "pm-1" },
    criteria: ["check"],
    basis: "Check passed",
  };

  const { gateStatus: recorded } = await acceptOutcome(
    dir,
    definedTask,
    report,
    decision,
    stateDir,
    { kickoffHash: KICKOFF_HASH, workflowId: WORKFLOW_ID },
  );
  assert.equal(recorded.gates["outcome-accepted"].status, "pending");
  assert.equal(recorded.state, "reviewed");

  saveAcceptanceRef(stateDir, KICKOFF_HASH, WORKFLOW_ID, "decision-1");
  const afterCommit = await gateCheck(dir, definedTask, report, stateDir, {
    kickoffHash: KICKOFF_HASH,
    workflowId: WORKFLOW_ID,
  });
  assert.equal(afterCommit.gates["outcome-accepted"].status, "passed");
  assert.equal(afterCommit.state, "accepted");
});

test("a caller that omits kickoffHash keeps the review/decision-only behaviour", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  const definedTask = task("no-document-check");
  const report = await passingReport(dir, stateDir, definedTask, "impl-run");
  const decision = {
    schemaVersion: 1,
    id: "decision-legacy",
    decider: { kind: "pm", executionId: "pm-1" },
    criteria: ["check"],
    basis: "Check passed",
  };

  const { gateStatus } = await acceptOutcome(
    dir,
    definedTask,
    report,
    decision,
    stateDir,
  );
  assert.equal(gateStatus.gates["outcome-accepted"].status, "passed");
  assert.equal(gateStatus.state, "accepted");
});

test("acceptWorkflowIntegration forwards kickoffHash and its own id to gateCheck's outcome-accepted document check", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  for (const id of ["a", "b"])
    writeJSON(path.join(dir, `${id}.json`), task(id));
  const integration = task("integration");
  writeJSON(path.join(dir, "integration.json"), integration);
  const request = {
    schemaVersion: 1,
    id: "gate-hooks-integration-workflow",
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
  const frozen = readJSON(path.join(snapshot.dir, "integration-task.json"));
  const report = await passingReport(dir, stateDir, frozen, "integration-run");
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
    { kickoffHash: KICKOFF_HASH, workflowId: request.id },
  );

  await assert.rejects(
    acceptWorkflowIntegration(
      stateDir,
      request.id,
      snapshot.state.revision,
      dir,
      report,
      {
        kickoffHash: KICKOFF_HASH,
      },
    ),
    /Integration checks, review and PM acceptance required/,
  );

  saveAcceptanceRef(stateDir, KICKOFF_HASH, request.id, "integration-decision");
  const accepted = await acceptWorkflowIntegration(
    stateDir,
    request.id,
    snapshot.state.revision,
    dir,
    report,
    { kickoffHash: KICKOFF_HASH },
  );
  assert.equal(accepted.status, "accepted");
  assert.equal(
    accepted.integration.decision.decisionId,
    "integration-decision",
  );
});

test("refreshGateCache sets pending and preserves old review records if evidence fails", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  const definedTask = task("pending-test");
  const report = await passingReport(dir, stateDir, definedTask, "impl-run");
  const decision = {
    schemaVersion: 1,
    id: "decision-1",
    decider: { kind: "pm", executionId: "pm-1" },
    criteria: ["check"],
    basis: "Passed",
  };

  const { gateStatus } = await acceptOutcome(
    dir,
    definedTask,
    report,
    decision,
    stateDir,
  );
  assert.equal(gateStatus.gates["outcome-accepted"].status, "passed");

  // modify evidence to fail
  report.evidence.status = "failed";
  const { refreshGateCache } =
    await import("../plugins/oh-my-teams/scripts/gates.mjs");
  const updatedStatus = await refreshGateCache(
    dir,
    definedTask,
    report,
    stateDir,
  );
  assert.equal(updatedStatus.gates["outcome-accepted"].status, "pending");
  assert.equal(updatedStatus.state, "submitted");
  assert.equal(updatedStatus.gates["checks-passed"].status, "pending");
});

test("refreshGateCache succeeds and sets accepted when everything is valid", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  const definedTask = task("refresh-test");
  const report = await passingReport(dir, stateDir, definedTask, "impl-run");
  const decision = {
    schemaVersion: 1,
    id: "decision-1",
    decider: { kind: "pm", executionId: "pm-1" },
    criteria: ["check"],
    basis: "Passed",
  };

  await acceptOutcome(dir, definedTask, report, decision, stateDir);
  const { refreshGateCache } =
    await import("../plugins/oh-my-teams/scripts/gates.mjs");
  const updatedStatus = await refreshGateCache(
    dir,
    definedTask,
    report,
    stateDir,
  );
  assert.equal(updatedStatus.gates["outcome-accepted"].status, "passed");
  assert.equal(updatedStatus.state, "accepted");
});
