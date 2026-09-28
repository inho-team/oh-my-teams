/** The structured .omt document runtime: docId/docRef, revisions, locking, and legacyRef (3.5-3.7, 3.10). */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJSON, writeJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  kickoffEntryName,
  registerKickoff,
  registryDirectory,
  releaseKickoff,
  cleanupKickoffBranches,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";
import {
  DOCUMENT_STATES,
  STAGE_FOLDER_NAMES,
  STAGE_SLUGS,
  buildDocId,
  buildDocRef,
  deliveryRefDocId,
  documentState,
  parseDocId,
  parseDocRef,
  resolveKickoffHash,
  saveDocument,
  stageFolderName,
  validateLegacyRef,
} from "../plugins/oh-my-teams/scripts/documents.mjs";

const exampleOrg = path.resolve(
  "plugins/oh-my-teams/examples/organization.json",
);

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-documents-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const org = path.join(dir, ".omt", "organization.json");
  fs.mkdirSync(path.dirname(org), { recursive: true });
  fs.copyFileSync(exampleOrg, org);
  const brief = path.join(dir, "brief.md");
  fs.writeFileSync(brief, "goal, acceptance criteria, non-goals\n");
  return { dir, org, brief };
}

function claimFor(fixture, worktreeId) {
  const pm = path.join(fixture.dir, worktreeId);
  return {
    goal: `deliver ${worktreeId}`,
    pm: { worktreeId, path: pm, stateDir: path.join(pm, ".omt") },
    organizationRevision: readJSON(fixture.org).revision,
    brief: fixture.brief,
    delivery: { mode: "none" },
  };
}

// Registers a kickoff and returns its stateDir and kickoffHash, ready for saveDocument calls.
function kickoff(fixture, worktreeId, delivery) {
  const claim = claimFor(fixture, worktreeId);
  if (delivery) claim.delivery = delivery;
  const { entry } = registerKickoff(fixture.org, claim);
  const kickoffHash = resolveKickoffHash(fixture.org, worktreeId);
  return { entry, stateDir: entry.pm.stateDir, kickoffHash, worktreeId };
}

function envelope({
  kickoffHash,
  workflowId = null,
  stageSlug,
  docType,
  localId,
  state = "resolved",
  extra = {},
}) {
  return {
    schemaVersion: 1,
    docId: buildDocId({ kickoffHash, workflowId, stageSlug, docType, localId }),
    stage: stageSlug,
    kickoffId: kickoffHash,
    workflowId,
    revision: 1,
    state,
    author: { role: "senior", executionId: "exec-1" },
    createdAt: new Date().toISOString(),
    basedOnRevision: null,
    reason: "test fixture",
    ...extra,
  };
}

test("buildDocId/parseDocId round-trip and reject malformed components", () => {
  const kickoffHash = "a".repeat(64);
  const docId = buildDocId({
    kickoffHash,
    workflowId: null,
    stageSlug: "design",
    docType: "design-contract",
    localId: "d1",
  });
  assert.equal(docId, `${kickoffHash}/none/design/design-contract/d1`);
  assert.deepEqual(parseDocId(docId), {
    kickoffHash,
    workflowId: null,
    stageSlug: "design",
    docType: "design-contract",
    localId: "d1",
  });

  const withWorkflow = buildDocId({
    kickoffHash,
    workflowId: "wf-1",
    stageSlug: "implementation",
    docType: "workflow-task-ref",
    localId: "t1",
  });
  assert.deepEqual(parseDocId(withWorkflow).workflowId, "wf-1");

  assert.throws(
    () =>
      buildDocId({
        kickoffHash: "not-hex",
        stageSlug: "design",
        docType: "design-contract",
        localId: "d1",
      }),
    /kickoffHash/,
  );
  assert.throws(
    () =>
      buildDocId({
        kickoffHash,
        stageSlug: "not-a-stage",
        docType: "design-contract",
        localId: "d1",
      }),
    /stageSlug/,
  );
  assert.throws(
    () =>
      buildDocId({
        kickoffHash,
        stageSlug: "design",
        docType: "design-contract",
        localId: "has/slash",
      }),
    /localId/,
  );
  assert.throws(
    () => parseDocId(`${kickoffHash}/none/design/design-contract`),
    /five/,
  );
});

test("buildDocRef/parseDocRef round-trip and reject malformed references", () => {
  const kickoffHash = "b".repeat(64);
  const docId = buildDocId({
    kickoffHash,
    stageSlug: "planning",
    docType: "kickoff-brief-ref",
    localId: "kickoff",
  });
  const ref = buildDocRef(docId, 3);
  assert.equal(ref, `omt-doc:${docId}@r3`);
  assert.deepEqual(parseDocRef(ref), {
    ...parseDocId(docId),
    docId,
    revision: 3,
  });

  assert.throws(() => parseDocRef("not-a-ref"), /omt-doc:/);
  assert.throws(() => parseDocRef(`omt-doc:${docId}@r0`), /at least 1/);
  assert.throws(() => buildDocRef(docId, 0), /positive integer/);
});

test("stageFolderName maps every stageSlug to its 3.1 folder name, normalized to NFC", () => {
  assert.deepEqual(
    [...STAGE_SLUGS].sort(),
    Object.keys(STAGE_FOLDER_NAMES).sort(),
  );
  for (const stageSlug of STAGE_SLUGS) {
    const folder = stageFolderName(stageSlug);
    assert.equal(folder, folder.normalize("NFC"));
    assert.equal(folder, STAGE_FOLDER_NAMES[stageSlug].normalize("NFC"));
  }
  assert.throws(() => stageFolderName("not-a-stage"), /Unknown document stage/);
});

test("resolveKickoffHash reads only the active registry and rejects an unregistered worktree", (t) => {
  const fixture = project(t);
  assert.throws(
    () => resolveKickoffHash(fixture.org, "wt-none"),
    /has no active kickoff/,
  );
  const { kickoffHash } = kickoff(fixture, "wt-a");
  assert.equal(resolveKickoffHash(fixture.org, "wt-a"), kickoffHash);
});

test("releasing and re-registering the same worktree never reuses a kickoffHash", (t) => {
  const fixture = project(t);
  const first = kickoff(fixture, "wt-a");
  releaseKickoff(fixture.org, {
    worktreeId: "wt-a",
    reason: "disbanded",
    callerCwd: fixture.dir,
  });
  const second = kickoff(fixture, "wt-a");
  assert.notEqual(first.kickoffHash, second.kickoffHash);

  // The first kickoff's documents stay reachable under its own kickoffHash;
  // resolveKickoffHash only ever answers for the new, active instance.
  const firstDoc = envelope({
    kickoffHash: first.kickoffHash,
    stageSlug: "planning",
    docType: "kickoff-brief-ref",
    localId: "kickoff",
  });
  saveDocument(first.stateDir, firstDoc);
  assert.equal(documentState(first.stateDir, firstDoc.docId).exists, true);
  assert.equal(resolveKickoffHash(fixture.org, "wt-a"), second.kickoffHash);
});

test("registerKickoff issues a strictly increasing registrationSeq, and .sequence.json is not a kickoff entry", (t) => {
  const fixture = project(t);
  const a = kickoff(fixture, "wt-a");
  const b = kickoff(fixture, "wt-b");
  assert.equal(a.entry.registrationSeq, 1);
  assert.equal(b.entry.registrationSeq, 2);
  const seqFile = path.join(registryDirectory(fixture.org), ".sequence.json");
  assert.ok(fs.existsSync(seqFile));
  assert.deepEqual(readJSON(seqFile), { next: 3 });
});

test("documentState reports {exists: false} before a document is saved, then its committed revision", (t) => {
  const fixture = project(t);
  const { stateDir, kickoffHash } = kickoff(fixture, "wt-a");
  const doc = envelope({
    kickoffHash,
    stageSlug: "design",
    docType: "design-contract",
    localId: "d1",
  });
  assert.deepEqual(documentState(stateDir, doc.docId), { exists: false });

  const saved = saveDocument(stateDir, doc);
  assert.equal(saved.revision, 1);
  const state = documentState(stateDir, doc.docId);
  assert.equal(state.exists, true);
  assert.equal(state.revision, 1);
  assert.equal(state.hash, saved.hash);
  assert.equal(state.state, "resolved");
  assert.equal(state.kickoffId, kickoffHash);
  assert.equal(state.workflowId, null);
});

test("saveDocument appends a new revision file per write and never rewrites an old one", (t) => {
  const fixture = project(t);
  const { stateDir, kickoffHash } = kickoff(fixture, "wt-a");
  const docId = buildDocId({
    kickoffHash,
    stageSlug: "design",
    docType: "design-contract",
    localId: "d1",
  });
  const revisionsDir = path.join(
    stateDir,
    "documents",
    kickoffHash,
    "none",
    STAGE_FOLDER_NAMES.design,
    "design-contract",
    "d1",
    "revisions",
  );

  saveDocument(
    stateDir,
    {
      ...envelope({
        kickoffHash,
        stageSlug: "design",
        docType: "design-contract",
        localId: "d1",
      }),
      state: "open",
    },
    {},
  );
  const r1 = readJSON(path.join(revisionsDir, "1.json"));
  assert.equal(r1.state, "open");

  saveDocument(
    stateDir,
    envelope({
      kickoffHash,
      stageSlug: "design",
      docType: "design-contract",
      localId: "d1",
      extra: { revision: 2, basedOnRevision: 1 },
    }),
    { expectedRevision: 1 },
  );
  // The first revision file is untouched; a second, distinct file was added.
  assert.deepEqual(readJSON(path.join(revisionsDir, "1.json")), r1);
  assert.equal(readJSON(path.join(revisionsDir, "2.json")).state, "resolved");
  assert.equal(documentState(stateDir, docId).revision, 2);
});

test("saveDocument rejects a write against a stale expectedRevision", (t) => {
  const fixture = project(t);
  const { stateDir, kickoffHash } = kickoff(fixture, "wt-a");
  const doc = envelope({
    kickoffHash,
    stageSlug: "design",
    docType: "design-contract",
    localId: "d1",
  });
  saveDocument(stateDir, doc);
  assert.throws(
    () =>
      saveDocument(
        stateDir,
        envelope({
          kickoffHash,
          stageSlug: "design",
          docType: "design-contract",
          localId: "d1",
          extra: { revision: 2, basedOnRevision: 1 },
        }),
        { expectedRevision: 0 },
      ),
    /current revision is 1/,
  );
});

test("saveDocument rejects when another live process holds the document lock", (t) => {
  const fixture = project(t);
  const { stateDir, kickoffHash } = kickoff(fixture, "wt-a");
  const doc = envelope({
    kickoffHash,
    stageSlug: "planning",
    docType: "kickoff-brief-ref",
    localId: "kickoff",
  });
  const lockFile = path.join(stateDir, "documents", kickoffHash, ".lock");
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  // A lock file naming this same, live process looks exactly like a
  // concurrent writer to acquireFileLock, which cannot reclaim a live owner.
  fs.writeFileSync(
    lockFile,
    JSON.stringify({ pid: process.pid, hostname: os.hostname() }),
  );
  t.after(() => fs.rmSync(lockFile, { force: true }));
  assert.throws(
    () => saveDocument(stateDir, doc),
    /Document update in progress/,
  );
});

test("saveDocument rejects a reference to a document that does not exist", (t) => {
  const fixture = project(t);
  const { stateDir, kickoffHash } = kickoff(fixture, "wt-a");
  const missingRef = buildDocRef(
    buildDocId({
      kickoffHash,
      stageSlug: "design",
      docType: "design-contract",
      localId: "never-saved",
    }),
    1,
  );
  const doc = envelope({
    kickoffHash,
    workflowId: "wf-1",
    stageSlug: "implementation",
    docType: "workflow-task-ref",
    localId: "t1",
  });
  assert.throws(
    () => saveDocument(stateDir, doc, { refs: [missingRef] }),
    /does not exist/,
  );
});

test("saveDocument rejects a reference to a different kickoff", (t) => {
  const fixture = project(t);
  const a = kickoff(fixture, "wt-a");
  const b = kickoff(fixture, "wt-b");
  const designDoc = envelope({
    kickoffHash: b.kickoffHash,
    stageSlug: "design",
    docType: "design-contract",
    localId: "d1",
  });
  saveDocument(b.stateDir, designDoc);
  const crossRef = buildDocRef(designDoc.docId, 1);

  const taskDoc = envelope({
    kickoffHash: a.kickoffHash,
    workflowId: "wf-1",
    stageSlug: "implementation",
    docType: "workflow-task-ref",
    localId: "t1",
  });
  assert.throws(
    () => saveDocument(a.stateDir, taskDoc, { refs: [crossRef] }),
    /different kickoff/,
  );
});

test("saveDocument rejects a reference to a different workflow", (t) => {
  const fixture = project(t);
  const { stateDir, kickoffHash } = kickoff(fixture, "wt-a");
  const otherWorkflowDoc = envelope({
    kickoffHash,
    workflowId: "wf-other",
    stageSlug: "implementation",
    docType: "workflow-task-ref",
    localId: "t-other",
  });
  saveDocument(stateDir, otherWorkflowDoc);
  const ref = buildDocRef(otherWorkflowDoc.docId, 1);

  const doc = envelope({
    kickoffHash,
    workflowId: "wf-1",
    stageSlug: "implementation",
    docType: "integration-ref",
    localId: "t1",
  });
  assert.throws(
    () => saveDocument(stateDir, doc, { refs: [ref] }),
    /different workflow/,
  );
});

test("saveDocument rejects a reference to a document that is not resolved", (t) => {
  const fixture = project(t);
  const { stateDir, kickoffHash } = kickoff(fixture, "wt-a");
  const draftDesign = {
    ...envelope({
      kickoffHash,
      stageSlug: "design",
      docType: "design-contract",
      localId: "d1",
    }),
    state: "open",
  };
  saveDocument(stateDir, draftDesign);
  const ref = buildDocRef(draftDesign.docId, 1);

  const taskDoc = envelope({
    kickoffHash,
    workflowId: "wf-1",
    stageSlug: "implementation",
    docType: "workflow-task-ref",
    localId: "t1",
  });
  assert.throws(
    () => saveDocument(stateDir, taskDoc, { refs: [ref] }),
    /not resolved/,
  );

  // Resolving the design afterwards lets the same reference through.
  saveDocument(
    stateDir,
    {
      ...envelope({
        kickoffHash,
        stageSlug: "design",
        docType: "design-contract",
        localId: "d1",
        extra: { revision: 2, basedOnRevision: 1 },
      }),
    },
    { expectedRevision: 1 },
  );
  const resolvedRef = buildDocRef(draftDesign.docId, 2);
  const saved = saveDocument(stateDir, taskDoc, { refs: [resolvedRef] });
  assert.equal(saved.revision, 1);
});

test("saveDocument rejects a mismatched envelope (docId not matching kickoffId/stage/workflowId)", (t) => {
  const fixture = project(t);
  const { stateDir, kickoffHash } = kickoff(fixture, "wt-a");
  const doc = envelope({
    kickoffHash,
    stageSlug: "design",
    docType: "design-contract",
    localId: "d1",
  });
  assert.throws(
    () => saveDocument(stateDir, { ...doc, stage: "planning" }),
    /stage must match/,
  );
  assert.throws(
    () => saveDocument(stateDir, { ...doc, workflowId: "wf-1" }),
    /workflowId must match/,
  );
  assert.throws(
    () => saveDocument(stateDir, { ...doc, state: "invalid-state" }),
    /state must be one of/,
  );
  assert.deepEqual([...DOCUMENT_STATES], ["open", "in-review", "resolved"]);
});

test("validateLegacyRef accepts a pre-activation file scoped to the referencing document", (t) => {
  const fixture = project(t);
  const { stateDir } = kickoff(fixture, "wt-a");
  const reviewFile = path.join(stateDir, "reviews", "task-1.json");
  writeJSON(reviewFile, {
    taskId: "task-1",
    conclusion: "approved",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const org = { documentSystemActivatedAt: "2026-06-01T00:00:00.000Z" };

  const result = validateLegacyRef(stateDir, org, "reviews/task-1.json", {
    taskId: "task-1",
  });
  assert.equal(result.record.taskId, "task-1");

  assert.throws(
    () => validateLegacyRef(stateDir, org, "reviews/missing.json", {}),
    /does not exist/,
  );
  assert.throws(
    () =>
      validateLegacyRef(stateDir, org, "reviews/task-1.json", {
        taskId: "other-task",
      }),
    /belongs to task/,
  );
  assert.throws(
    () => validateLegacyRef(stateDir, org, "../outside.json", {}),
    /escapes workspace|Forbidden path/,
  );
});

test("validateLegacyRef rejects a file created at or after documentSystemActivatedAt", (t) => {
  const fixture = project(t);
  const { stateDir } = kickoff(fixture, "wt-a");
  const reviewFile = path.join(stateDir, "reviews", "task-2.json");
  writeJSON(reviewFile, {
    taskId: "task-2",
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  const org = { documentSystemActivatedAt: "2026-06-01T00:00:00.000Z" };
  assert.throws(
    () =>
      validateLegacyRef(stateDir, org, "reviews/task-2.json", {
        taskId: "task-2",
      }),
    /needs a structured document/,
  );
});

test("validateLegacyRef allows any pre-existing file when documentSystemActivatedAt is unset", (t) => {
  const fixture = project(t);
  const { stateDir } = kickoff(fixture, "wt-a");
  const reviewFile = path.join(stateDir, "reviews", "task-3.json");
  writeJSON(reviewFile, {
    taskId: "task-3",
    createdAt: new Date().toISOString(),
  });
  const result = validateLegacyRef(stateDir, {}, "reviews/task-3.json", {
    taskId: "task-3",
  });
  assert.equal(result.record.taskId, "task-3");
});

test("releaseKickoff refuses to complete a local-merge kickoff until its delivery-ref document is committed", (t) => {
  const fixture = project(t);
  const { worktreeId } = kickoff(fixture, "wt-a", {
    mode: "local-merge",
    branch: "main",
  });
  const mergeCommit = "a".repeat(40);
  const entryFile = path.join(
    registryDirectory(fixture.org),
    `${kickoffEntryName(worktreeId)}.json`,
  );
  writeJSON(entryFile, {
    ...readJSON(entryFile),
    delivered: {
      head: "b".repeat(40),
      mergeCommit,
      at: new Date().toISOString(),
    },
  });

  assert.throws(
    () =>
      releaseKickoff(fixture.org, {
        worktreeId,
        reason: "completed",
        callerCwd: fixture.dir,
      }),
    /delivery-ref document.*is not committed/,
  );

  // force still bypasses it, matching the pre-existing pattern for the merge assert.
  const forced = releaseKickoff(fixture.org, {
    worktreeId,
    reason: "completed",
    force: true,
    callerCwd: fixture.dir,
  });
  assert.equal(forced.released, true);
});

test("releaseKickoff completes once the delivery-ref document is committed and owned by this kickoff", (t) => {
  const fixture = project(t);
  const { stateDir, kickoffHash, worktreeId } = kickoff(fixture, "wt-a", {
    mode: "local-merge",
    branch: "main",
  });
  const mergeCommit = "c".repeat(40);
  const entryFile = path.join(
    registryDirectory(fixture.org),
    `${kickoffEntryName(worktreeId)}.json`,
  );
  writeJSON(entryFile, {
    ...readJSON(entryFile),
    delivered: {
      head: "d".repeat(40),
      mergeCommit,
      at: new Date().toISOString(),
    },
  });

  const docId = deliveryRefDocId(kickoffHash, mergeCommit);
  saveDocument(stateDir, {
    schemaVersion: 1,
    docId,
    stage: "delivery",
    kickoffId: kickoffHash,
    workflowId: null,
    revision: 1,
    state: "resolved",
    author: { role: "pm", executionId: "exec-1" },
    createdAt: new Date().toISOString(),
    basedOnRevision: null,
    reason: "delivery recorded",
    deliveredCommit: mergeCommit,
  });

  const result = releaseKickoff(fixture.org, {
    worktreeId,
    reason: "completed",
    callerCwd: fixture.dir,
  });
  assert.equal(result.released, true);
});

// Builds a repo where "feat/kickoff-work" is already fully merged into main,
// so cleanupKickoffBranches's git-content check alone would allow deletion;
// only our new documentState hook is left to explain a skip.
function mergedRepo(t) {
  const repoDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "omt-doc-branch-cleanup-"),
  );
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));
  const git = (args) =>
    execFileSync("git", args, {
      cwd: repoDir,
      stdio: "pipe",
      encoding: "utf8",
    }).trim();
  git(["init", "--initial-branch=main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  git(["add", "README.md"]);
  git(["commit", "--message", "initial"]);
  git(["checkout", "-b", "feat/kickoff-work"]);
  fs.writeFileSync(path.join(repoDir, "work.txt"), "work\n");
  git(["add", "work.txt"]);
  git(["commit", "--message", "kickoff work"]);
  const head = git(["rev-parse", "HEAD"]);
  git(["checkout", "main"]);
  git(["merge", "--no-ff", "feat/kickoff-work", "--message", "merge kickoff"]);
  const mergeCommit = git(["rev-parse", "HEAD"]);
  return { repoDir, head, mergeCommit };
}

test("cleanupKickoffBranches skips a branch until its kickoff's delivery-ref document is committed and owned", (t) => {
  const fixture = project(t);
  const { entry, stateDir, kickoffHash } = kickoff(fixture, "wt-a", {
    mode: "local-merge",
    branch: "main",
  });
  const { repoDir, head, mergeCommit } = mergedRepo(t);
  const withDelivery = { ...entry, delivered: { head, mergeCommit } };

  const beforeDoc = cleanupKickoffBranches({
    projectDir: repoDir,
    entry: withDelivery,
    branches: ["feat/kickoff-work"],
    remoteName: "",
  });
  assert.deepEqual(beforeDoc, {
    deleted: [],
    skipped: ["feat/kickoff-work"],
    errors: [],
  });

  const docId = deliveryRefDocId(kickoffHash, mergeCommit);
  saveDocument(stateDir, {
    schemaVersion: 1,
    docId,
    stage: "delivery",
    kickoffId: kickoffHash,
    workflowId: null,
    revision: 1,
    state: "resolved",
    author: { role: "pm", executionId: "exec-1" },
    createdAt: new Date().toISOString(),
    basedOnRevision: null,
    reason: "delivery recorded",
    deliveredCommit: mergeCommit,
  });
  const afterDoc = cleanupKickoffBranches({
    projectDir: repoDir,
    entry: withDelivery,
    branches: ["feat/kickoff-work"],
    remoteName: "",
  });
  assert.deepEqual(afterDoc, {
    deleted: ["feat/kickoff-work"],
    skipped: [],
    errors: [],
  });
});

test("cleanupKickoffBranches's force bypasses a missing or mismatched delivery-ref document", (t) => {
  const fixture = project(t);
  const { entry } = kickoff(fixture, "wt-a", {
    mode: "local-merge",
    branch: "main",
  });
  const { repoDir, head, mergeCommit } = mergedRepo(t);
  const withDelivery = { ...entry, delivered: { head, mergeCommit } };

  const forced = cleanupKickoffBranches({
    projectDir: repoDir,
    entry: withDelivery,
    branches: ["feat/kickoff-work"],
    remoteName: "",
    force: true,
  });
  assert.deepEqual(forced, {
    deleted: ["feat/kickoff-work"],
    skipped: [],
    errors: [],
  });
});

test("an entry without registrationSeq (pre-wave-2) keeps the old cleanupKickoffBranches behavior", (t) => {
  const { repoDir, head, mergeCommit } = mergedRepo(t);
  const legacyEntry = {
    delivery: { mode: "local-merge", branch: "main" },
    delivered: { head, mergeCommit },
  };
  const result = cleanupKickoffBranches({
    projectDir: repoDir,
    entry: legacyEntry,
    branches: ["feat/kickoff-work"],
    remoteName: "",
  });
  // No registrationSeq means kickoffHashFor cannot run; the pre-existing
  // git-content-only check is used instead, same as before this feature.
  assert.deepEqual(result, {
    deleted: ["feat/kickoff-work"],
    skipped: [],
    errors: [],
  });
});
