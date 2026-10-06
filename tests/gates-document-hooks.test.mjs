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
  resolveKickoffHash,
} from "../plugins/oh-my-teams/scripts/documents.mjs";
import {
  kickoffEntryName,
  registerKickoff,
  registryDirectory,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";
import {
  minimalRequirements,
} from "./requirements-draft-fixture.mjs";

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

test("refreshGateCache provides deterministic safety, idempotency, and respects locks", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  const definedTask = task("safety-test");
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
  const { withAsyncFileLock } =
    await import("../plugins/oh-my-teams/scripts/core.mjs");
  const { readJSON } = await import("../plugins/oh-my-teams/scripts/core.mjs");

  const decisionFile = path.join(stateDir, "decisions", "decision-1.json");
  const originalDecision = readJSON(decisionFile);

  // 1. Lock contention test
  await withAsyncFileLock(
    path.join(stateDir, "gates-write.lock"),
    async () => {
      await assert.rejects(
        refreshGateCache(dir, definedTask, report, stateDir),
        /Gate cache refresh in progress/,
      );
    },
    "Testing",
  );

  // 2. Idempotency test
  const first = await refreshGateCache(dir, definedTask, report, stateDir);
  const second = await refreshGateCache(dir, definedTask, report, stateDir);
  assert.deepEqual(first, second, "Repeated calls must be idempotent");

  // 3. Immutability test
  const untouchedDecision = readJSON(decisionFile);
  assert.deepEqual(
    untouchedDecision,
    originalDecision,
    "Decision records must remain immutable",
  );
});

test("refreshGateCache checks current/legacy kickoff compatibility and handles tampered/missing refs", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  const definedTask = task("ref-test");
  const report = await passingReport(dir, stateDir, definedTask, "impl-run");
  const decision = {
    schemaVersion: 1,
    id: "decision-2",
    decider: { kind: "pm", executionId: "pm-2" },
    criteria: ["check"],
    basis: "Passed",
  };

  await acceptOutcome(dir, definedTask, report, decision, stateDir);

  const { refreshGateCache } =
    await import("../plugins/oh-my-teams/scripts/gates.mjs");

  // 4. Legacy kickoff compatibility (no kickoffHash provided -> skips ref validation)
  const legacyCache = await refreshGateCache(
    dir,
    definedTask,
    report,
    stateDir,
  );
  assert.equal(
    legacyCache.gates["outcome-accepted"].status,
    "passed",
    "Legacy kickoff skips document ref validation",
  );

  // 5. Current kickoff missing reference -> falls back to pending
  const missingRefCache = await refreshGateCache(
    dir,
    definedTask,
    report,
    stateDir,
    { kickoffHash: KICKOFF_HASH, workflowId: WORKFLOW_ID },
  );
  assert.equal(
    missingRefCache.gates["outcome-accepted"].status,
    "pending",
    "Current kickoff without ref falls back to pending",
  );

  // 6. Current kickoff with tampered reference -> falls back to pending
  saveAcceptanceRef(stateDir, KICKOFF_HASH, WORKFLOW_ID, "decision-tampered");
  const tamperedRefCache = await refreshGateCache(
    dir,
    definedTask,
    report,
    stateDir,
    { kickoffHash: KICKOFF_HASH, workflowId: WORKFLOW_ID },
  );
  assert.equal(
    tamperedRefCache.gates["outcome-accepted"].status,
    "pending",
    "Current kickoff with tampered ref falls back to pending",
  );

  // 7. Current kickoff with valid reference -> passes
  saveAcceptanceRef(stateDir, KICKOFF_HASH, WORKFLOW_ID, "decision-2");
  const validRefCache = await refreshGateCache(
    dir,
    definedTask,
    report,
    stateDir,
    { kickoffHash: KICKOFF_HASH, workflowId: WORKFLOW_ID },
  );
  assert.equal(
    validRefCache.gates["outcome-accepted"].status,
    "passed",
    "Current kickoff with valid ref succeeds",
  );

  // 8. Evidence failure -> falls back to pending
  report.evidence.status = "failed";
  const evidenceFailCache = await refreshGateCache(
    dir,
    definedTask,
    report,
    stateDir,
    { kickoffHash: KICKOFF_HASH, workflowId: WORKFLOW_ID },
  );
  assert.equal(
    evidenceFailCache.gates["checks-passed"].status,
    "pending",
    "Evidence failure causes checks-passed pending",
  );
  assert.equal(
    evidenceFailCache.gates["outcome-accepted"].status,
    "pending",
    "Evidence failure bubbles up to outcome-accepted pending",
  );
  assert.equal(
    evidenceFailCache.state,
    "submitted",
    "Evidence failure falls back to submitted state",
  );

  // 9. Unvalidated task -> throws early to prevent cache pollution
  report.evidence.status = "passed";
  const invalidTask = { ...definedTask, schemaVersion: 999 };
  await assert.rejects(
    refreshGateCache(dir, invalidTask, report, stateDir, {
      kickoffHash: KICKOFF_HASH,
      workflowId: WORKFLOW_ID,
    }),
    /Task schemaVersion/,
    "Unvalidated task must throw and prevent cache pollution",
  );
});
const cli = path.resolve("plugins/oh-my-teams/scripts/teams-org.mjs");

async function cliRun(repo, ...args) {
  return run([process.execPath, cli, ...args], {
    cwd: repo,
    timeoutMs: 120000,
  });
}

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-cli-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const orgFile = path.join(dir, ".omt", "organization.json");
  fs.mkdirSync(path.dirname(orgFile), { recursive: true });
  fs.copyFileSync(new URL("../plugins/oh-my-teams/examples/organization.json", import.meta.url), orgFile);
  const brief = path.join(dir, "brief.md");
  fs.writeFileSync(brief, "goal, acceptance criteria, non-goals\n");
  return { dir, orgFile, brief };
}

async function worktree(fixture, worktreeId) {
  const repoDir = path.join(fixture.dir, worktreeId);
  fs.mkdirSync(repoDir, { recursive: true });
  await run(["git", "init"], { cwd: repoDir });
  await run(["git", "config", "user.name", "Test"], { cwd: repoDir });
  await run(["git", "config", "user.email", "test@example.invalid"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, ".gitignore"), ".omt/\n*.json\n");
  fs.writeFileSync(path.join(repoDir, "seed.txt"), "seed\n");
  await run(["git", "add", ".gitignore", "seed.txt"], { cwd: repoDir });
  await run(["git", "commit", "-m", "seed"], { cwd: repoDir });
  return { repoDir, stateDir: path.join(repoDir, ".omt") };
}

function claimFor(fixture, worktreeId, wt, delivery = { mode: "none" }) {
  return {
    goal: `deliver ${worktreeId}`,
    pm: { worktreeId, path: wt.repoDir, stateDir: wt.stateDir },
    organizationRevision: readJSON(fixture.orgFile).revision,
    brief: fixture.brief,
    delivery,
    requirements: minimalRequirements(fixture.orgFile, worktreeId),
    director: {
      terminalHandle: `term_director_${worktreeId}`,
      checkoutPath: wt.repoDir,
    },
  };
}

function registerCurrent(fixture, worktreeId, wt, delivery) {
  registerKickoff(fixture.orgFile, claimFor(fixture, worktreeId, wt, delivery));
  return { kickoffHash: resolveKickoffHash(fixture.orgFile, worktreeId) };
}

function entryFileFor(orgFile, worktreeId) {
  return path.join(
    registryDirectory(orgFile),
    `${kickoffEntryName(worktreeId)}.json`,
  );
}

function demote(orgFile, worktreeId, extra = {}) {
  const entryFile = entryFileFor(orgFile, worktreeId);
  const { registrationSeq, ...withoutSeq } = readJSON(entryFile);
  writeJSON(entryFile, { ...withoutSeq, ...extra });
}

function activateInThePast(orgFile) {
  writeJSON(orgFile, {
    ...readJSON(orgFile),
    documentSystemActivatedAt: "2020-01-01T00:00:00.000Z",
  });
}


test("gate-cache-refresh CLI resolves current/legacy/integrity-failure and handles references", async (t) => {
  const fx = project(t);
  const wt = await worktree(fx, "wt-gate");
  const { kickoffHash } = registerCurrent(fx, "wt-gate", wt);
  const stateDir = wt.stateDir;

  const tsk = task("cli-gate-refresh");
  const taskFile = path.join(wt.repoDir, "task.json");
  writeJSON(taskFile, tsk);

  const reportFile = path.join(wt.repoDir, "report.json");
  const report = await passingReport(wt.repoDir, stateDir, tsk, "impl-run");
  writeJSON(reportFile, report);

  // 1. Missing --org (handled by REQUIRED_OPTIONS parser)
  const missingOrg = await cliRun(
    wt.repoDir,
    "gate-cache-refresh",
    "--task",
    taskFile,
    "--report",
    reportFile,
    "--repo",
    wt.repoDir,
    "--state",
    stateDir,
  );
  assert.equal(missingOrg.code, 1, "Missing --org fails");
  assert.match(missingOrg.stderr, /org/);

  // 2. Current kickoff missing reference -> falls back to pending
  const missingRef = await cliRun(
    wt.repoDir,
    "gate-cache-refresh",
    "--task",
    taskFile,
    "--report",
    reportFile,
    "--repo",
    wt.repoDir,
    "--state",
    stateDir,
    "--org",
    fx.orgFile,
    "--workflow-id",
    "wf-gate",
  );
  assert.equal(missingRef.code, 0);
  assert.equal(
    JSON.parse(missingRef.stdout).gates["outcome-accepted"].status,
    "pending",
  );

  // 3. Current kickoff with valid reference -> passed
  const decision = {
    schemaVersion: 1,
    id: "decision-valid",
    decider: { kind: "pm", executionId: "pm-1" },
    criteria: ["check"],
    basis: "Passed"
  };
  await acceptOutcome(wt.repoDir, tsk, report, decision, stateDir);
  saveAcceptanceRef(stateDir, kickoffHash, "wf-gate", "decision-valid");

  const validRef = await cliRun(
    wt.repoDir,
    "gate-cache-refresh",
    "--task",
    taskFile,
    "--report",
    reportFile,
    "--repo",
    wt.repoDir,
    "--state",
    stateDir,
    "--org",
    fx.orgFile,
    "--workflow-id",
    "wf-gate",
  );
  assert.equal(validRef.code, 0);
  assert.equal(
    JSON.parse(validRef.stdout).gates["outcome-accepted"].status,
    "passed",
  );

  // 4. Legacy entry bypasses document refs
  const legacyWt = await worktree(fx, "wt-legacy");
  registerCurrent(fx, "wt-legacy", legacyWt);
  demote(fx.orgFile, "wt-legacy");
  const legacyStateDir = legacyWt.stateDir;
  const legacyReportFile = path.join(legacyWt.repoDir, "report.json");
  const legacyReport = await passingReport(
    legacyWt.repoDir,
    legacyStateDir,
    tsk,
    "impl-legacy",
  );
  writeJSON(legacyReportFile, legacyReport);

  const legacyDecision = {
    schemaVersion: 1,
    id: "decision-legacy",
    decider: { kind: "pm", executionId: "pm-1" },
    criteria: ["check"],
    basis: "Passed"
  };
  await acceptOutcome(legacyWt.repoDir, tsk, legacyReport, legacyDecision, legacyStateDir);

  const legacyRef = await cliRun(
    legacyWt.repoDir,
    "gate-cache-refresh",
    "--task",
    taskFile,
    "--report",
    legacyReportFile,
    "--repo",
    legacyWt.repoDir,
    "--state",
    legacyStateDir,
    "--org",
    fx.orgFile,
    "--workflow-id",
    "wf-legacy",
  );
  assert.equal(legacyRef.code, 0);
  assert.equal(
    JSON.parse(legacyRef.stdout).gates["outcome-accepted"].status,
    "passed",
  );

  // 5. Integrity-failure entry refuses the command
  const refuseWt = await worktree(fx, "wt-refuse");
  registerCurrent(fx, "wt-refuse", refuseWt);
  activateInThePast(fx.orgFile);
  demote(fx.orgFile, "wt-refuse");

  const refuseRef = await cliRun(
    refuseWt.repoDir,
    "gate-cache-refresh",
    "--task",
    taskFile,
    "--report",
    legacyReportFile,
    "--repo",
    refuseWt.repoDir,
    "--state",
    refuseWt.stateDir,
    "--org",
    fx.orgFile,
    "--workflow-id",
    "wf-refuse",
  );
  assert.equal(refuseRef.code, 1);
  assert.match(refuseRef.stderr, /registrationSeq/);
});
test("gate-cache-refresh CLI handles lock contention and duplicate requests safely", async (t) => {
  const fx = project(t);
  const wt = await worktree(fx, "wt-gate-lock");
  registerCurrent(fx, "wt-gate-lock", wt);
  const stateDir = wt.stateDir;

  const tsk = task("cli-gate-lock");
  const taskFile = path.join(wt.repoDir, "task.json");
  writeJSON(taskFile, tsk);

  const reportFile = path.join(wt.repoDir, "report.json");
  const report = await passingReport(wt.repoDir, stateDir, tsk, "impl-run");
  writeJSON(reportFile, report);

  const { withAsyncFileLock } =
    await import("../plugins/oh-my-teams/scripts/core.mjs");

  // Lock contention
  await withAsyncFileLock(
    path.join(stateDir, "gates-write.lock"),
    async () => {
      const lockRes = await cliRun(
        wt.repoDir,
        "gate-cache-refresh",
        "--task",
        taskFile,
        "--report",
        reportFile,
        "--repo",
        wt.repoDir,
        "--state",
        stateDir,
        "--org",
        fx.orgFile,
      );
      assert.equal(lockRes.code, 1);
      assert.match(lockRes.stderr, /Gate cache refresh in progress/);
    },
    "Testing CLI lock",
  );

  // Duplication/Idempotency
  const first = await cliRun(
    wt.repoDir,
    "gate-cache-refresh",
    "--task",
    taskFile,
    "--report",
    reportFile,
    "--repo",
    wt.repoDir,
    "--state",
    stateDir,
    "--org",
    fx.orgFile,
  );
  assert.equal(first.code, 0);

  const second = await cliRun(
    wt.repoDir,
    "gate-cache-refresh",
    "--task",
    taskFile,
    "--report",
    reportFile,
    "--repo",
    wt.repoDir,
    "--state",
    stateDir,
    "--org",
    fx.orgFile,
  );
  assert.equal(second.code, 0);
  assert.deepEqual(
    JSON.parse(first.stdout),
    JSON.parse(second.stdout),
    "CLI repeated calls must be idempotent",
  );
});
