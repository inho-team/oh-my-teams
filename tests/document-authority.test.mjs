/**
 * Coverage for design 3.4.2's PM design/design-contract roster condition and
 * 3.4.3's PL field-scope restriction on implementation/workflow-task-ref and
 * implementation/integration-ref, both enforced by teams-org.mjs's
 * assertDocumentAuthority through the doc-save CLI (structured-omt-documents.md
 * 3.4.2, 3.4.3, and the two 3.14 regression rows for these rules).
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
import { buildDocId } from "../plugins/oh-my-teams/scripts/documents.mjs";
import { createWorkflow } from "../plugins/oh-my-teams/scripts/workflow.mjs";
import { workflowStateFile } from "../plugins/oh-my-teams/scripts/workflow-store.mjs";

const cli = path.resolve("plugins/oh-my-teams/scripts/teams-org.mjs");
const exampleOrgPath = path.resolve(
  "plugins/oh-my-teams/examples/organization.json",
);
const exampleOrg = readJSON(exampleOrgPath);
const KICKOFF_HASH = "a".repeat(64);

async function cliRun(cwd, ...args) {
  return run([process.execPath, cli, ...args], { cwd, timeoutMs: 120000 });
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "document-authority-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function git(dir, ...args) {
  const result = await run(["git", ...args], { cwd: dir });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

// A git repo with one commit, needed only by createTestWorkflow: freezeTasks
// resolves each task's baseRef ("HEAD") against real git history.
async function repo(t) {
  const dir = tempDir(t);
  await git(dir, "init");
  await git(dir, "config", "user.name", "Document Authority Test");
  await git(
    dir,
    "config",
    "user.email",
    "document-authority-test@example.invalid",
  );
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  await git(dir, "add", "seed.txt");
  await git(dir, "commit", "-m", "seed");
  return dir;
}

const workflowTask = (id) => ({
  schemaVersion: 2,
  revision: 1,
  kind: "edit",
  id,
  goal: "Test document authority",
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
});

// A workflow whose state.roles is depthRoles(definedRoles(org), depth): depth 1
// -> ["pm"], depth 3 -> ["pm", "senior", "junior"] (core.mjs DEPTH_ROLES).
async function createTestWorkflow(dir, stateDir, id, depth) {
  const taskFile = path.join(dir, `${id}-task.json`);
  writeJSON(taskFile, workflowTask(`${id}-task`));
  const request = {
    schemaVersion: 1,
    id,
    goal: "Test document authority",
    repo: ".",
    depth,
    tasks: [{ file: `${id}-task.json`, role: "junior" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 3, maxCalls: 4 },
  };
  await createWorkflow(stateDir, request, structuredClone(exampleOrg), dir);
}

function envelope({
  workflowId = null,
  stageSlug,
  docType,
  localId,
  author = { role: "senior", executionId: "doc-writer" },
  revision = 1,
  basedOnRevision = null,
  ...extra
}) {
  return {
    schemaVersion: 1,
    docId: buildDocId({
      kickoffHash: KICKOFF_HASH,
      workflowId,
      stageSlug,
      docType,
      localId,
    }),
    stage: stageSlug,
    kickoffId: KICKOFF_HASH,
    workflowId,
    revision,
    state: "resolved",
    author,
    createdAt: new Date().toISOString(),
    basedOnRevision,
    reason: "test fixture",
    ...extra,
  };
}

async function docSave(cwd, stateDir, doc, extraArgs = []) {
  const docFile = path.join(
    cwd,
    `${doc.author.executionId}-r${doc.revision}-doc.json`,
  );
  writeJSON(docFile, doc);
  return cliRun(
    cwd,
    "doc-save",
    "--state",
    stateDir,
    "--doc",
    docFile,
    ...extraArgs,
  );
}

// --- 3.4.2 PM roster condition ---------------------------------------------

test("doc-save allows a PM to author design/design-contract when the workflow snapshot's state.roles has no pl, senior, or junior (3.4.2, branch 1, allow)", async (t) => {
  const dir = await repo(t);
  const stateDir = path.join(dir, ".omt");
  await createTestWorkflow(dir, stateDir, "wf-roster-allow", 1);

  const result = await docSave(
    dir,
    stateDir,
    envelope({
      workflowId: "wf-roster-allow",
      stageSlug: "design",
      docType: "design-contract",
      localId: "design-1",
      author: { role: "pm", executionId: "pm-1" },
    }),
  );
  assert.equal(result.code, 0, result.stderr);
});

test("doc-save refuses a PM design/design-contract save when the workflow snapshot's state.roles includes senior or junior (3.4.2, branch 1, reject)", async (t) => {
  const dir = await repo(t);
  const stateDir = path.join(dir, ".omt");
  await createTestWorkflow(dir, stateDir, "wf-roster-reject", 3);

  const result = await docSave(
    dir,
    stateDir,
    envelope({
      workflowId: "wf-roster-reject",
      stageSlug: "design",
      docType: "design-contract",
      localId: "design-1",
      author: { role: "pm", executionId: "pm-1" },
    }),
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /PM may not author design\/design-contract/);
});

test("doc-save allows a PM's design/design-contract via --org when workflowId is unset and --org's roles have no pl, senior, or junior (3.4.2, branch 2, allow)", async (t) => {
  const dir = tempDir(t);
  const stateDir = path.join(dir, ".omt");
  const orgFile = path.join(dir, "reduced-organization.json");
  writeJSON(orgFile, { roles: { pm: {} } });

  const result = await docSave(
    dir,
    stateDir,
    envelope({
      stageSlug: "design",
      docType: "design-contract",
      localId: "design-1",
      author: { role: "pm", executionId: "pm-1" },
    }),
    ["--org", orgFile],
  );
  assert.equal(result.code, 0, result.stderr);
});

test("doc-save refuses a PM design/design-contract save via --org when the organization's roles include pl, senior, or junior (3.4.2, branch 2, reject)", async (t) => {
  const dir = tempDir(t);
  const stateDir = path.join(dir, ".omt");

  const result = await docSave(
    dir,
    stateDir,
    envelope({
      stageSlug: "design",
      docType: "design-contract",
      localId: "design-1",
      author: { role: "pm", executionId: "pm-1" },
    }),
    ["--org", exampleOrgPath],
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /PM may not author design\/design-contract/);
});

test("doc-save refuses a PM design/design-contract save when doc.workflowId is unset and --org is not given (3.4.2, rejection case 1)", async (t) => {
  const dir = tempDir(t);
  const stateDir = path.join(dir, ".omt");

  const result = await docSave(
    dir,
    stateDir,
    envelope({
      stageSlug: "design",
      docType: "design-contract",
      localId: "design-1",
      author: { role: "pm", executionId: "pm-1" },
    }),
  );
  assert.notEqual(result.code, 0);
  assert.match(
    result.stderr,
    /doc\.workflowId is not set and --org was not given/,
  );
});

test("doc-save refuses a PM design/design-contract save when --org cannot be read (3.4.2, rejection case 2)", async (t) => {
  const dir = tempDir(t);
  const stateDir = path.join(dir, ".omt");
  const missingOrgFile = path.join(dir, "missing-organization.json");

  const result = await docSave(
    dir,
    stateDir,
    envelope({
      stageSlug: "design",
      docType: "design-contract",
      localId: "design-1",
      author: { role: "pm", executionId: "pm-1" },
    }),
    ["--org", missingOrgFile],
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Cannot read organization file/);
});

test("doc-save refuses a PM design/design-contract save when doc.workflowId names a workflow that does not exist (3.4.2, rejection case 3)", async (t) => {
  const dir = tempDir(t);
  const stateDir = path.join(dir, ".omt");

  const result = await docSave(
    dir,
    stateDir,
    envelope({
      workflowId: "no-such-workflow",
      stageSlug: "design",
      docType: "design-contract",
      localId: "design-1",
      author: { role: "pm", executionId: "pm-1" },
    }),
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Cannot read workflow no-such-workflow/);
});

test("doc-save prefers the workflow snapshot's state.roles over its organization field when both are present (3.4.2)", async (t) => {
  const dir = await repo(t);
  const stateDir = path.join(dir, ".omt");
  await createTestWorkflow(dir, stateDir, "wf-roster-precedence", 1);

  // state.roles is ["pm"] at depth 1, so a PM save succeeds while it's present.
  const allowed = await docSave(
    dir,
    stateDir,
    envelope({
      workflowId: "wf-roster-precedence",
      stageSlug: "design",
      docType: "design-contract",
      localId: "design-1",
      author: { role: "pm", executionId: "pm-1" },
    }),
  );
  assert.equal(allowed.code, 0, allowed.stderr);

  // Strip state.roles to simulate a snapshot without it; the fallback then
  // reads the snapshot's organization field, whose full role table still
  // names senior and junior, so the same kind of save is now rejected.
  const stateFile = workflowStateFile(stateDir, "wf-roster-precedence");
  const { roles: _roles, ...withoutRoles } = readJSON(stateFile);
  writeJSON(stateFile, withoutRoles);

  const rejected = await docSave(
    dir,
    stateDir,
    envelope({
      workflowId: "wf-roster-precedence",
      stageSlug: "design",
      docType: "design-contract",
      localId: "design-2",
      author: { role: "pm", executionId: "pm-2" },
    }),
  );
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /PM may not author design\/design-contract/);
});

// --- 3.4.3 PL field-scope restriction ---------------------------------------

test("doc-save allows a PM's first revision of workflow-task-ref, then a PL's next revision changing only attemptRefs (3.4.3, normal flow)", async (t) => {
  const dir = tempDir(t);
  const stateDir = path.join(dir, ".omt");

  const rev1 = envelope({
    workflowId: "wf-task-ref",
    stageSlug: "implementation",
    docType: "workflow-task-ref",
    localId: "task-1",
    author: { role: "pm", executionId: "pm-1" },
    workflowRef: {
      path: ".omt/workflows/wf-task-ref/request.json",
      sha256: "a".repeat(64),
    },
    taskRef: {
      path: ".omt/workflows/wf-task-ref/tasks/task-1/revisions/1.json",
      sha256: "b".repeat(64),
    },
    attemptRefs: [],
    designRef: null,
  });
  const first = await docSave(dir, stateDir, rev1);
  assert.equal(first.code, 0, first.stderr);

  const rev2 = envelope({
    workflowId: "wf-task-ref",
    stageSlug: "implementation",
    docType: "workflow-task-ref",
    localId: "task-1",
    author: { role: "pl", executionId: "pl-1" },
    revision: 2,
    basedOnRevision: 1,
    workflowRef: rev1.workflowRef,
    taskRef: rev1.taskRef,
    attemptRefs: ["attempt-1"],
    designRef: null,
  });
  const second = await docSave(dir, stateDir, rev2, [
    "--expected-revision",
    "1",
  ]);
  assert.equal(second.code, 0, second.stderr);
});

test("doc-save refuses a PL's next revision of implementation/workflow-task-ref when workflowRef changes alongside attemptRefs (3.4.3, reject)", async (t) => {
  const dir = tempDir(t);
  const stateDir = path.join(dir, ".omt");

  const rev1 = envelope({
    workflowId: "wf-task-ref",
    stageSlug: "implementation",
    docType: "workflow-task-ref",
    localId: "task-1",
    author: { role: "pm", executionId: "pm-1" },
    workflowRef: {
      path: ".omt/workflows/wf-task-ref/request.json",
      sha256: "a".repeat(64),
    },
    taskRef: {
      path: ".omt/workflows/wf-task-ref/tasks/task-1/revisions/1.json",
      sha256: "b".repeat(64),
    },
    attemptRefs: [],
    designRef: null,
  });
  const first = await docSave(dir, stateDir, rev1);
  assert.equal(first.code, 0, first.stderr);

  const rev2 = envelope({
    workflowId: "wf-task-ref",
    stageSlug: "implementation",
    docType: "workflow-task-ref",
    localId: "task-1",
    author: { role: "pl", executionId: "pl-1" },
    revision: 2,
    basedOnRevision: 1,
    workflowRef: { path: rev1.workflowRef.path, sha256: "c".repeat(64) },
    taskRef: rev1.taskRef,
    attemptRefs: ["attempt-1"],
    designRef: null,
  });
  const second = await docSave(dir, stateDir, rev2, [
    "--expected-revision",
    "1",
  ]);
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /PL may only change attemptRefs/);
});

test("doc-save allows a PL's next revision of implementation/integration-ref to change only taskHashRef and extensionHistory (3.4.3, allow)", async (t) => {
  const dir = tempDir(t);
  const stateDir = path.join(dir, ".omt");

  const rev1 = envelope({
    workflowId: "wf-integration-ref",
    stageSlug: "implementation",
    docType: "integration-ref",
    localId: "integration-1",
    author: { role: "pm", executionId: "pm-1" },
    integrationTaskRef: "integration-1",
    taskHashRef: "a".repeat(64),
    extensionHistory: [],
  });
  const first = await docSave(dir, stateDir, rev1);
  assert.equal(first.code, 0, first.stderr);

  const rev2 = envelope({
    workflowId: "wf-integration-ref",
    stageSlug: "implementation",
    docType: "integration-ref",
    localId: "integration-1",
    author: { role: "pl", executionId: "pl-1" },
    revision: 2,
    basedOnRevision: 1,
    integrationTaskRef: rev1.integrationTaskRef,
    taskHashRef: "b".repeat(64),
    extensionHistory: [{ taskHash: "b".repeat(64), reason: "extend checks" }],
  });
  const second = await docSave(dir, stateDir, rev2, [
    "--expected-revision",
    "1",
  ]);
  assert.equal(second.code, 0, second.stderr);
});

test("doc-save refuses a PL's next revision of implementation/integration-ref when integrationTaskRef changes (3.4.3, reject)", async (t) => {
  const dir = tempDir(t);
  const stateDir = path.join(dir, ".omt");

  const rev1 = envelope({
    workflowId: "wf-integration-ref",
    stageSlug: "implementation",
    docType: "integration-ref",
    localId: "integration-1",
    author: { role: "pm", executionId: "pm-1" },
    integrationTaskRef: "integration-1",
    taskHashRef: "a".repeat(64),
    extensionHistory: [],
  });
  const first = await docSave(dir, stateDir, rev1);
  assert.equal(first.code, 0, first.stderr);

  const rev2 = envelope({
    workflowId: "wf-integration-ref",
    stageSlug: "implementation",
    docType: "integration-ref",
    localId: "integration-1",
    author: { role: "pl", executionId: "pl-1" },
    revision: 2,
    basedOnRevision: 1,
    integrationTaskRef: "integration-2",
    taskHashRef: "b".repeat(64),
    extensionHistory: [{ taskHash: "b".repeat(64), reason: "extend checks" }],
  });
  const second = await docSave(dir, stateDir, rev2, [
    "--expected-revision",
    "1",
  ]);
  assert.notEqual(second.code, 0);
  assert.match(
    second.stderr,
    /PL may only change taskHashRef and extensionHistory/,
  );
});

// --- authority boundary: neither rule widens who may author what -----------

test("doc-save's PM roster condition does not widen design/design-contract authority: a junior still may not author it (authority not widened)", async (t) => {
  const dir = tempDir(t);
  const stateDir = path.join(dir, ".omt");

  const result = await docSave(
    dir,
    stateDir,
    envelope({
      stageSlug: "design",
      docType: "design-contract",
      localId: "design-1",
      author: { role: "junior", executionId: "junior-1" },
    }),
  );
  assert.notEqual(result.code, 0);
  assert.match(
    result.stderr,
    /Role junior may not author design\/design-contract/,
  );
});

test("doc-save's PM roster condition does not restrict a senior author of design/design-contract, nor require --org for one (authority not widened)", async (t) => {
  const dir = tempDir(t);
  const stateDir = path.join(dir, ".omt");

  const result = await docSave(
    dir,
    stateDir,
    envelope({
      stageSlug: "design",
      docType: "design-contract",
      localId: "design-1",
      author: { role: "senior", executionId: "senior-1" },
    }),
  );
  assert.equal(result.code, 0, result.stderr);
});
