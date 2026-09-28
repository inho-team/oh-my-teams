/**
 * Real subprocess coverage for teams-org.mjs's document CLI (`doc-resolve-kickoff`,
 * `doc-id`, `doc-show`, `doc-save`) and for the current/legacy/integrity-failure
 * caller-obligation procedure `--org` adds to `review-record`, `gate-check`,
 * `accept`, `merge-check`, `workflow-accept` and `kickoff-branch-cleanup`
 * (structured-omt-documents.md 3.7 item 5, 293-304행).
 */
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
import { acceptOutcome } from "../plugins/oh-my-teams/scripts/gates.mjs";
import {
  attachExecution,
  createWorkflow,
  readWorkflow,
  recordSettlement,
  resumeWorkflow,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";
import {
  buildDocId,
  resolveKickoffHash,
  saveDocument,
} from "../plugins/oh-my-teams/scripts/documents.mjs";
import {
  kickoffEntryName,
  registerKickoff,
  registryDirectory,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";

const cli = path.resolve("plugins/oh-my-teams/scripts/teams-org.mjs");
const exampleOrgPath = path.resolve(
  "plugins/oh-my-teams/examples/organization.json",
);

/** Runs teams-org.mjs as a real subprocess, mirroring cli-integration.test.mjs's helper. */
async function cliRun(repo, ...args) {
  return run([process.execPath, cli, ...args], {
    cwd: repo,
    timeoutMs: 120000,
  });
}

async function git(repo, ...args) {
  const result = await run(["git", ...args], { cwd: repo });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teams-org-doc-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The owner project (`.omt/organization.json`) is kept separate from each
// kickoff's PM worktree, since `assertNotKickoffOwner` (delivery.mjs) refuses
// merge-check in a checkout that itself owns an active kickoff.
function project(t) {
  const dir = tempDir(t);
  const orgFile = path.join(dir, ".omt", "organization.json");
  fs.mkdirSync(path.dirname(orgFile), { recursive: true });
  fs.copyFileSync(exampleOrgPath, orgFile);
  const brief = path.join(dir, "brief.md");
  fs.writeFileSync(brief, "goal, acceptance criteria, non-goals\n");
  return { dir, orgFile, brief };
}

async function worktree(fixture, worktreeId) {
  const repoDir = path.join(fixture.dir, worktreeId);
  fs.mkdirSync(repoDir, { recursive: true });
  await git(repoDir, "init");
  await git(repoDir, "config", "user.name", "Doc CLI Test");
  await git(repoDir, "config", "user.email", "doc-cli-test@example.invalid");
  // Evidence fingerprints the working tree's git status; the task/report/review/
  // decision/document fixture files this suite writes into repoDir must stay
  // untracked-and-ignored so they never register as "tree changed".
  fs.writeFileSync(path.join(repoDir, ".gitignore"), ".omt/\n*.json\n");
  fs.writeFileSync(path.join(repoDir, "seed.txt"), "seed\n");
  await git(repoDir, "add", ".gitignore", "seed.txt");
  await git(repoDir, "commit", "-m", "seed");
  return { repoDir, stateDir: path.join(repoDir, ".omt") };
}

function claimFor(fixture, worktreeId, wt, delivery = { mode: "none" }) {
  return {
    goal: `deliver ${worktreeId}`,
    pm: { worktreeId, path: wt.repoDir, stateDir: wt.stateDir },
    organizationRevision: readJSON(fixture.orgFile).revision,
    brief: fixture.brief,
    delivery,
  };
}

// Registers a kickoff (always "current": registerKickoff always issues a
// registrationSeq) and resolves its kickoffHash the same way documents.mjs does.
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

// Demotes a freshly registered ("current") entry to a legacy/integrity-failure
// candidate by stripping registrationSeq, following documents-runtime.test.mjs's
// fixture recipe (registerKickoff always issues one, so a demote step is the
// only way to reach the other two classifyKickoffEntry branches).
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

const task = (id, overrides = {}) => ({
  schemaVersion: 2,
  revision: 1,
  kind: "edit",
  id,
  goal: "Test document CLI wiring",
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

test("doc-id builds a docId, and with --revision a matching docRef", async (t) => {
  const dir = tempDir(t);
  const kickoffHash = "a".repeat(64);
  const bare = await cliRun(
    dir,
    "doc-id",
    "--kickoff-hash",
    kickoffHash,
    "--stage",
    "review",
    "--doc-type",
    "review-ref",
    "--local-id",
    "review-1",
  );
  assert.equal(bare.code, 0, bare.stderr);
  assert.deepEqual(JSON.parse(bare.stdout), {
    docId: `${kickoffHash}/none/review/review-ref/review-1`,
  });

  const withRevision = await cliRun(
    dir,
    "doc-id",
    "--kickoff-hash",
    kickoffHash,
    "--workflow-id",
    "wf-1",
    "--stage",
    "review",
    "--doc-type",
    "review-ref",
    "--local-id",
    "review-1",
    "--revision",
    "2",
  );
  assert.equal(withRevision.code, 0, withRevision.stderr);
  const parsed = JSON.parse(withRevision.stdout);
  assert.equal(parsed.docId, `${kickoffHash}/wf-1/review/review-ref/review-1`);
  assert.equal(parsed.docRef, `omt-doc:${parsed.docId}@r2`);
});

test("doc-save commits a new document and doc-show reports its revision and real filesystem location", async (t) => {
  const fx = project(t);
  const wt = await worktree(fx, "wt-doc-save");
  const { kickoffHash } = registerCurrent(fx, "wt-doc-save", wt);

  const idResult = await cliRun(
    wt.repoDir,
    "doc-id",
    "--kickoff-hash",
    kickoffHash,
    "--stage",
    "review",
    "--doc-type",
    "review-ref",
    "--local-id",
    "review-1",
  );
  const { docId } = JSON.parse(idResult.stdout);
  const docFile = path.join(wt.repoDir, "doc.json");
  writeJSON(
    docFile,
    envelope({
      kickoffHash,
      stageSlug: "review",
      docType: "review-ref",
      localId: "review-1",
    }),
  );
  assert.equal(readJSON(docFile).docId, docId);

  const saved = await cliRun(
    wt.repoDir,
    "doc-save",
    "--state",
    wt.stateDir,
    "--doc",
    docFile,
  );
  assert.equal(saved.code, 0, saved.stderr);
  assert.equal(JSON.parse(saved.stdout).revision, 1);

  const shown = await cliRun(
    wt.repoDir,
    "doc-show",
    "--state",
    wt.stateDir,
    "--doc-id",
    docId,
  );
  assert.equal(shown.code, 0, shown.stderr);
  const body = JSON.parse(shown.stdout);
  assert.equal(body.exists, true);
  assert.equal(body.revision, 1);
  assert.equal(body.state, "resolved");
  assert.equal(body.docId, docId);
  assert.ok(
    fs.existsSync(path.join(body.path, "current.json")),
    `doc-show's reported path ${body.path} should hold the document's current.json`,
  );
});

test("doc-show reports a document that does not exist", async (t) => {
  const dir = tempDir(t);
  const kickoffHash = "b".repeat(64);
  const idResult = await cliRun(
    dir,
    "doc-id",
    "--kickoff-hash",
    kickoffHash,
    "--stage",
    "review",
    "--doc-type",
    "review-ref",
    "--local-id",
    "missing",
  );
  const { docId } = JSON.parse(idResult.stdout);
  const shown = await cliRun(
    dir,
    "doc-show",
    "--state",
    path.join(dir, ".omt"),
    "--doc-id",
    docId,
  );
  assert.equal(shown.code, 0, shown.stderr);
  const body = JSON.parse(shown.stdout);
  assert.equal(body.docId, docId);
  assert.equal(body.exists, false);
});

test("doc-resolve-kickoff resolves the active kickoff's kickoffHash for a worktree, matching resolveKickoffHash", async (t) => {
  const fx = project(t);
  const wt = await worktree(fx, "wt-resolve");
  const { kickoffHash } = registerCurrent(fx, "wt-resolve", wt);

  const result = await cliRun(
    wt.repoDir,
    "doc-resolve-kickoff",
    "--org",
    fx.orgFile,
    "--worktree",
    "wt-resolve",
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { kickoffHash });
});

test("review-record, gate-check, accept and merge-check forward kickoffHash for a current kickoff entry, gating on its review-ref/acceptance-ref documents", async (t) => {
  const fx = project(t);
  const wt = await worktree(fx, "wt-current");
  const { kickoffHash } = registerCurrent(fx, "wt-current", wt);
  const stateDir = wt.stateDir;

  const definedTask = reviewGateTask("current-gate");
  const taskFile = path.join(wt.repoDir, "task.json");
  writeJSON(taskFile, definedTask);
  const report = await passingReport(
    wt.repoDir,
    stateDir,
    definedTask,
    "impl-run",
  );
  const reportFile = path.join(wt.repoDir, "report.json");
  writeJSON(reportFile, report);
  const reviewFile = path.join(wt.repoDir, "review.json");
  writeJSON(reviewFile, reviewInput());

  const recorded = await cliRun(
    wt.repoDir,
    "review-record",
    "--task",
    taskFile,
    "--report",
    reportFile,
    "--review",
    reviewFile,
    "--repo",
    wt.repoDir,
    "--state",
    stateDir,
    "--org",
    fx.orgFile,
  );
  assert.equal(recorded.code, 0, recorded.stderr);
  assert.equal(
    JSON.parse(recorded.stdout).gateStatus.gates["review-complete"].status,
    "pending",
  );

  const reviewDocId = JSON.parse(
    (
      await cliRun(
        wt.repoDir,
        "doc-id",
        "--kickoff-hash",
        kickoffHash,
        "--stage",
        "review",
        "--doc-type",
        "review-ref",
        "--local-id",
        "review-1",
      )
    ).stdout,
  ).docId;
  const reviewDocFile = path.join(wt.repoDir, "review-doc.json");
  writeJSON(
    reviewDocFile,
    envelope({
      kickoffHash,
      stageSlug: "review",
      docType: "review-ref",
      localId: "review-1",
    }),
  );
  assert.equal(readJSON(reviewDocFile).docId, reviewDocId);
  const savedReview = await cliRun(
    wt.repoDir,
    "doc-save",
    "--state",
    stateDir,
    "--doc",
    reviewDocFile,
  );
  assert.equal(savedReview.code, 0, savedReview.stderr);

  const afterReview = await cliRun(
    wt.repoDir,
    "gate-check",
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
  assert.equal(afterReview.code, 0, afterReview.stderr);
  assert.equal(
    JSON.parse(afterReview.stdout).gates["review-complete"].status,
    "passed",
  );

  const decision = {
    schemaVersion: 1,
    id: "decision-1",
    decider: { kind: "pm", executionId: "pm-1" },
    criteria: ["check", "scope-review"],
    basis: "Check passed and independent review approved the scope.",
  };
  const decisionFile = path.join(wt.repoDir, "decision.json");
  writeJSON(decisionFile, decision);
  const accepted = await cliRun(
    wt.repoDir,
    "accept",
    "--task",
    taskFile,
    "--report",
    reportFile,
    "--decision",
    decisionFile,
    "--repo",
    wt.repoDir,
    "--state",
    stateDir,
    "--org",
    fx.orgFile,
  );
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.equal(
    JSON.parse(accepted.stdout).gateStatus.gates["outcome-accepted"].status,
    "pending",
  );
  assert.equal(JSON.parse(accepted.stdout).gateStatus.state, "reviewed");

  const acceptDocId = JSON.parse(
    (
      await cliRun(
        wt.repoDir,
        "doc-id",
        "--kickoff-hash",
        kickoffHash,
        "--stage",
        "acceptance",
        "--doc-type",
        "acceptance-ref",
        "--local-id",
        "decision-1",
      )
    ).stdout,
  ).docId;
  const acceptDocFile = path.join(wt.repoDir, "accept-doc.json");
  writeJSON(
    acceptDocFile,
    envelope({
      kickoffHash,
      stageSlug: "acceptance",
      docType: "acceptance-ref",
      localId: "decision-1",
    }),
  );
  assert.equal(readJSON(acceptDocFile).docId, acceptDocId);
  const savedAccept = await cliRun(
    wt.repoDir,
    "doc-save",
    "--state",
    stateDir,
    "--doc",
    acceptDocFile,
  );
  assert.equal(savedAccept.code, 0, savedAccept.stderr);

  const afterAccept = await cliRun(
    wt.repoDir,
    "gate-check",
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
  assert.equal(afterAccept.code, 0, afterAccept.stderr);
  assert.equal(
    JSON.parse(afterAccept.stdout).gates["outcome-accepted"].status,
    "passed",
  );
  assert.equal(JSON.parse(afterAccept.stdout).state, "accepted");

  const evidenceFile = path.join(stateDir, "evidence.json");
  writeJSON(evidenceFile, report.evidence);
  const merged = await cliRun(
    wt.repoDir,
    "merge-check",
    "--evidence",
    evidenceFile,
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
    "--base",
    "HEAD",
  );
  assert.equal(merged.code, 0, merged.stderr);
  assert.equal(JSON.parse(merged.stdout).valid, true);
});

test("the same flow passes immediately when --org classifies the entry as legacy, omitting kickoffHash", async (t) => {
  const fx = project(t);
  const wt = await worktree(fx, "wt-legacy");
  registerCurrent(fx, "wt-legacy", wt);
  demote(fx.orgFile, "wt-legacy");
  const stateDir = wt.stateDir;

  const definedTask = reviewGateTask("legacy-gate");
  const taskFile = path.join(wt.repoDir, "task.json");
  writeJSON(taskFile, definedTask);
  const report = await passingReport(
    wt.repoDir,
    stateDir,
    definedTask,
    "impl-run",
  );
  const reportFile = path.join(wt.repoDir, "report.json");
  writeJSON(reportFile, report);
  const reviewFile = path.join(wt.repoDir, "review.json");
  writeJSON(reviewFile, reviewInput());

  const recorded = await cliRun(
    wt.repoDir,
    "review-record",
    "--task",
    taskFile,
    "--report",
    reportFile,
    "--review",
    reviewFile,
    "--repo",
    wt.repoDir,
    "--state",
    stateDir,
    "--org",
    fx.orgFile,
  );
  assert.equal(recorded.code, 0, recorded.stderr);
  assert.equal(
    JSON.parse(recorded.stdout).gateStatus.gates["review-complete"].status,
    "passed",
  );

  const decision = {
    schemaVersion: 1,
    id: "decision-legacy",
    decider: { kind: "pm", executionId: "pm-1" },
    criteria: ["check", "scope-review"],
    basis: "Check passed and independent review approved the scope.",
  };
  const decisionFile = path.join(wt.repoDir, "decision.json");
  writeJSON(decisionFile, decision);
  const accepted = await cliRun(
    wt.repoDir,
    "accept",
    "--task",
    taskFile,
    "--report",
    reportFile,
    "--decision",
    decisionFile,
    "--repo",
    wt.repoDir,
    "--state",
    stateDir,
    "--org",
    fx.orgFile,
  );
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).gateStatus.state, "accepted");

  const evidenceFile = path.join(stateDir, "evidence.json");
  writeJSON(evidenceFile, report.evidence);
  const merged = await cliRun(
    wt.repoDir,
    "merge-check",
    "--evidence",
    evidenceFile,
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
    "--base",
    "HEAD",
  );
  assert.equal(merged.code, 0, merged.stderr);
  assert.equal(JSON.parse(merged.stdout).valid, true);
});

test("review-record, gate-check, accept and merge-check refuse when --org's kickoff entry is an integrity failure", async (t) => {
  const fx = project(t);
  const wt = await worktree(fx, "wt-integrity");
  registerCurrent(fx, "wt-integrity", wt);
  activateInThePast(fx.orgFile);
  demote(fx.orgFile, "wt-integrity");
  const stateDir = wt.stateDir;

  const definedTask = task("integrity-gate");
  const taskFile = path.join(wt.repoDir, "task.json");
  writeJSON(taskFile, definedTask);
  const report = await passingReport(
    wt.repoDir,
    stateDir,
    definedTask,
    "impl-run",
  );
  const reportFile = path.join(wt.repoDir, "report.json");
  writeJSON(reportFile, report);
  const reviewFile = path.join(wt.repoDir, "review.json");
  writeJSON(reviewFile, reviewInput());
  const decisionFile = path.join(wt.repoDir, "decision.json");
  writeJSON(decisionFile, {
    schemaVersion: 1,
    id: "decision-integrity",
    decider: { kind: "pm", executionId: "pm-1" },
    criteria: ["check"],
    basis: "n/a",
  });
  const evidenceFile = path.join(stateDir, "evidence.json");
  writeJSON(evidenceFile, report.evidence);

  const reviewResult = await cliRun(
    wt.repoDir,
    "review-record",
    "--task",
    taskFile,
    "--report",
    reportFile,
    "--review",
    reviewFile,
    "--repo",
    wt.repoDir,
    "--state",
    stateDir,
    "--org",
    fx.orgFile,
  );
  assert.notEqual(reviewResult.code, 0);
  assert.match(reviewResult.stderr, /registrationSeq/);

  const gateResult = await cliRun(
    wt.repoDir,
    "gate-check",
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
  assert.notEqual(gateResult.code, 0);
  assert.match(gateResult.stderr, /registrationSeq/);

  const acceptResult = await cliRun(
    wt.repoDir,
    "accept",
    "--task",
    taskFile,
    "--report",
    reportFile,
    "--decision",
    decisionFile,
    "--repo",
    wt.repoDir,
    "--state",
    stateDir,
    "--org",
    fx.orgFile,
  );
  assert.notEqual(acceptResult.code, 0);
  assert.match(acceptResult.stderr, /registrationSeq/);

  const mergeResult = await cliRun(
    wt.repoDir,
    "merge-check",
    "--evidence",
    evidenceFile,
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
    "--base",
    "HEAD",
  );
  assert.notEqual(mergeResult.code, 0);
  assert.match(mergeResult.stderr, /registrationSeq/);
});

test("review-record, gate-check, accept and merge-check refuse when --org is given but no registered kickoff owns --state", async (t) => {
  const fx = project(t);
  const wt = await worktree(fx, "wt-unmatched");
  const stateDir = wt.stateDir;

  const definedTask = task("unmatched-gate");
  const taskFile = path.join(wt.repoDir, "task.json");
  writeJSON(taskFile, definedTask);
  const report = await passingReport(
    wt.repoDir,
    stateDir,
    definedTask,
    "impl-run",
  );
  const reportFile = path.join(wt.repoDir, "report.json");
  writeJSON(reportFile, report);
  const reviewFile = path.join(wt.repoDir, "review.json");
  writeJSON(reviewFile, reviewInput());
  const decisionFile = path.join(wt.repoDir, "decision.json");
  writeJSON(decisionFile, {
    schemaVersion: 1,
    id: "decision-unmatched",
    decider: { kind: "pm", executionId: "pm-1" },
    criteria: ["check"],
    basis: "n/a",
  });
  const evidenceFile = path.join(stateDir, "evidence.json");
  writeJSON(evidenceFile, report.evidence);

  const gateResult = await cliRun(
    wt.repoDir,
    "gate-check",
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
  assert.notEqual(gateResult.code, 0);
  assert.match(gateResult.stderr, /No registered kickoff owns state directory/);

  const mergeResult = await cliRun(
    wt.repoDir,
    "merge-check",
    "--evidence",
    evidenceFile,
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
    "--base",
    "HEAD",
  );
  assert.notEqual(mergeResult.code, 0);
  assert.match(
    mergeResult.stderr,
    /No registered kickoff owns state directory/,
  );
});

test("workflow-accept forwards kickoffHash for a current kickoff entry, gating on the acceptance-ref document", async (t) => {
  const fx = project(t);
  const wt = await worktree(fx, "wt-workflow");
  const { kickoffHash } = registerCurrent(fx, "wt-workflow", wt);
  const stateDir = wt.stateDir;

  for (const id of ["a", "b"])
    writeJSON(path.join(wt.repoDir, `${id}.json`), task(id));
  writeJSON(path.join(wt.repoDir, "integration.json"), task("integration"));
  const request = {
    schemaVersion: 1,
    id: "doc-cli-workflow",
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
  await createWorkflow(
    stateDir,
    request,
    structuredClone(readJSON(exampleOrgPath)),
    wt.repoDir,
  );

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
  const report = await passingReport(
    wt.repoDir,
    stateDir,
    frozen,
    "integration-run",
  );
  const reportFile = path.join(wt.repoDir, "integration-report.json");
  writeJSON(reportFile, report);

  await acceptOutcome(
    wt.repoDir,
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
    { kickoffHash, workflowId: request.id },
  );

  const missing = await cliRun(
    wt.repoDir,
    "workflow-accept",
    "--id",
    request.id,
    "--state",
    stateDir,
    "--revision",
    String(snapshot.state.revision),
    "--repo",
    wt.repoDir,
    "--report",
    reportFile,
    "--org",
    fx.orgFile,
  );
  assert.notEqual(missing.code, 0);
  assert.match(
    missing.stderr,
    /Integration checks, review and PM acceptance required/,
  );

  saveAcceptanceRef(stateDir, kickoffHash, request.id, "integration-decision");
  const accepted = await cliRun(
    wt.repoDir,
    "workflow-accept",
    "--id",
    request.id,
    "--state",
    stateDir,
    "--revision",
    String(snapshot.state.revision),
    "--repo",
    wt.repoDir,
    "--report",
    reportFile,
    "--org",
    fx.orgFile,
  );
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).status, "accepted");
  assert.equal(
    JSON.parse(accepted.stdout).integration.decision.decisionId,
    "integration-decision",
  );
});

test("workflow-accept refuses when --org's kickoff entry cannot be classified", async (t) => {
  const fx = project(t);
  const wt = await worktree(fx, "wt-workflow-refuse");
  registerCurrent(fx, "wt-workflow-refuse", wt);
  activateInThePast(fx.orgFile);
  demote(fx.orgFile, "wt-workflow-refuse");

  const result = await cliRun(
    wt.repoDir,
    "workflow-accept",
    "--id",
    "wf-refuse",
    "--state",
    wt.stateDir,
    "--revision",
    "1",
    "--org",
    fx.orgFile,
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /registrationSeq/);
});

test("kickoff-branch-cleanup forwards --org as cleanupKickoffBranches' orgFile, refusing an integrity-failure entry's merge commit instead of trusting it as legacy", async (t) => {
  const dir = tempDir(t);
  await git(dir, "init", "--initial-branch=main");
  await git(dir, "config", "user.name", "Doc CLI Test");
  await git(dir, "config", "user.email", "doc-cli-test@example.invalid");
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "-m", "initial");
  await git(dir, "checkout", "-b", "feat/kickoff-work");
  fs.writeFileSync(path.join(dir, "work.txt"), "work\n");
  await git(dir, "add", "work.txt");
  await git(dir, "commit", "-m", "kickoff work");
  await git(dir, "checkout", "main");
  await git(
    dir,
    "merge",
    "--no-ff",
    "feat/kickoff-work",
    "-m",
    "merge kickoff",
  );
  const head = await git(dir, "rev-parse", "feat/kickoff-work");
  const mergeCommit = await git(dir, "rev-parse", "HEAD");

  const orgFile = path.join(dir, ".omt", "organization.json");
  fs.mkdirSync(path.dirname(orgFile), { recursive: true });
  fs.copyFileSync(exampleOrgPath, orgFile);
  const brief = path.join(dir, "brief.md");
  fs.writeFileSync(brief, "goal, acceptance criteria, non-goals\n");

  const worktreeId = "wt-cleanup";
  registerKickoff(orgFile, {
    goal: "deliver wt-cleanup",
    pm: {
      worktreeId,
      path: path.join(dir, worktreeId),
      stateDir: path.join(dir, worktreeId, ".omt"),
    },
    organizationRevision: readJSON(orgFile).revision,
    brief,
    delivery: { mode: "local-merge", branch: "feat/kickoff-work" },
  });
  activateInThePast(orgFile);
  demote(orgFile, worktreeId, { delivered: { head, mergeCommit } });

  const result = await cliRun(
    dir,
    "kickoff-branch-cleanup",
    "--org",
    orgFile,
    "--worktree",
    worktreeId,
    "--branches",
    "feat/kickoff-work",
  );
  assert.equal(result.code, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.deepEqual(body.skipped, ["feat/kickoff-work"]);
  assert.deepEqual(body.deleted, []);
});
