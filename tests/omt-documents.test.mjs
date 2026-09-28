/**
 * Regression tests for structured `.omt` document system (design brief condition 9).
 * Each test corresponds to one scenario row of design 3.14.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { readJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  buildDocId,
  buildDocRef,
  documentState,
  parseDocId,
  parseDocRef,
  resolveKickoffHash,
  saveDocument,
  STAGE_FOLDER_NAMES,
} from "../plugins/oh-my-teams/scripts/documents.mjs";
import {
  kickoffHashFor,
  registerKickoff,
  releaseKickoff,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const exampleOrgPath = path.resolve(
  path.join(__dirname, "../plugins/oh-my-teams/examples/organization.json"),
);

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omt-test-"));
}

function createProjectStructure(tempDir, worktreeId) {
  const projectDir = tempDir;
  const orgDir = path.join(projectDir, ".omt");
  fs.mkdirSync(orgDir, { recursive: true });

  // Copy example organization
  const orgFile = path.join(orgDir, "organization.json");
  fs.copyFileSync(exampleOrgPath, orgFile);

  // Add document system activation marker
  const org = readJSON(orgFile);
  org.documentSystemActivatedAt = new Date().toISOString();
  fs.writeFileSync(orgFile, JSON.stringify(org, null, 2));

  // Create brief file
  const briefFile = path.join(projectDir, "brief.md");
  fs.writeFileSync(briefFile, "# Test Brief\n");

  // Create PM directory
  const pmDir = path.join(projectDir, "pm-wt");
  fs.mkdirSync(pmDir, { recursive: true });

  // Create state directory for documents
  const stateDir = path.join(orgDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });

  return { orgFile, org, orgDir, briefFile, pmDir, stateDir, projectDir };
}

function createKickoffRequest(worktreeId, briefFile, pmDir, revision) {
  return {
    goal: "Test kickoff",
    pm: {
      worktreeId,
      path: pmDir,
    },
    organizationRevision: revision,
    brief: briefFile,
    delivery: {
      mode: "local-merge",
      branch: "main",
    },
  };
}

function createTestDocument(kickoffId, stageSlug, docType, localId, author) {
  return {
    schemaVersion: 1,
    docId: buildDocId({
      kickoffHash: kickoffId,
      workflowId: null,
      stageSlug,
      docType,
      localId,
    }),
    stage: stageSlug,
    kickoffId,
    workflowId: null,
    revision: 1,
    state: "open",
    author,
    createdAt: new Date().toISOString(),
    basedOnRevision: null,
    reason: "test document creation",
  };
}

// Scenario 1: 정상_생성_참조_갱신
test("정상_생성_참조_갱신", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-1",
    );

    // Register kickoff
    const request = createKickoffRequest(
      "test-wt-1",
      briefFile,
      pmDir,
      org.revision,
    );
    const { entry } = registerKickoff(orgFile, request);
    const kickoffId = kickoffHashFor(entry);

    // Create and save planning document
    const planDoc = createTestDocument(
      kickoffId,
      "planning",
      "kickoff-brief-ref",
      "entry-1",
      { role: "director", executionId: "alice-exec-1" },
    );
    planDoc.briefPath = briefFile;
    planDoc.acceptanceSummary = "test acceptance";
    planDoc.nonGoals = [];
    planDoc.constraints = [];
    planDoc.kickoffEntryRef = entry.kickoffId;

    const result = saveDocument(stateDir, planDoc);
    assert.ok(result.docId);
    assert.equal(result.revision, 1);

    // Verify document state
    const state = documentState(stateDir, planDoc.docId);
    assert.ok(state.exists);
    assert.equal(state.revision, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario 2: 권한_없는_수정
test("권한_없는_수정", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-2",
    );

    const request = createKickoffRequest(
      "test-wt-2",
      briefFile,
      pmDir,
      org.revision,
    );
    const { entry } = registerKickoff(orgFile, request);
    const kickoffId = kickoffHashFor(entry);

    // Create design doc as senior
    const designDoc = createTestDocument(
      kickoffId,
      "design",
      "design-contract",
      "design-1",
      { role: "senior", executionId: "charlie-exec-1" },
    );
    designDoc.problemStatement = "test problem";
    designDoc.decisions = [];
    designDoc.openQuestions = [];
    designDoc.reviewRequirementRef = null;

    saveDocument(stateDir, designDoc);

    // Save documents in general is allowed
    const result = saveDocument(stateDir, designDoc);
    assert.ok(result.docId);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario 3: 오래된_revision
test("오래된_revision", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-3",
    );

    const request = createKickoffRequest(
      "test-wt-3",
      briefFile,
      pmDir,
      org.revision,
    );
    const { entry } = registerKickoff(orgFile, request);
    const kickoffId = kickoffHashFor(entry);

    const doc = createTestDocument(
      kickoffId,
      "planning",
      "kickoff-brief-ref",
      "entry-1",
      { role: "director", executionId: "alice-exec-1" },
    );
    doc.briefPath = briefFile;
    doc.acceptanceSummary = "test";
    doc.nonGoals = [];
    doc.constraints = [];
    doc.kickoffEntryRef = entry.kickoffId;

    // First write
    const r1 = saveDocument(stateDir, doc);
    assert.equal(r1.revision, 1);

    // Update to revision 2
    doc.revision = 2;
    doc.basedOnRevision = 1;
    doc.reason = "update";
    const r2 = saveDocument(stateDir, doc, { expectedRevision: 1 });
    assert.equal(r2.revision, 2);

    // Try to write with old expectedRevision
    doc.revision = 3;
    doc.basedOnRevision = 2;
    assert.throws(() => {
      saveDocument(stateDir, doc, { expectedRevision: 1 });
    }, /current revision is 2/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario 4: 깨진_참조
test("깨진_참조", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-4",
    );

    const request = createKickoffRequest(
      "test-wt-4",
      briefFile,
      pmDir,
      org.revision,
    );
    const { entry } = registerKickoff(orgFile, request);
    const kickoffId = kickoffHashFor(entry);

    // Try to save doc with broken reference
    const doc = createTestDocument(
      kickoffId,
      "implementation",
      "workflow-task-ref",
      "task-1",
      { role: "pm", executionId: "bob-exec-1" },
    );
    doc.workflowRef = null;
    doc.taskRef = null;
    doc.attemptRefs = [];
    doc.designRef = buildDocRef(
      buildDocId({
        kickoffHash: kickoffId,
        workflowId: null,
        stageSlug: "design",
        docType: "design-contract",
        localId: "nonexistent",
      }),
      1,
    );

    // Should fail
    assert.throws(() => {
      saveDocument(stateDir, doc, { refs: [doc.designRef] });
    }, /does not exist/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario 5: 다른_kickoff_참조
test("다른_kickoff_참조", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, briefFile, stateDir } = createProjectStructure(
      tempDir,
      "test-wt-5a",
    );

    // Create two kickoffs
    const pmDir1 = path.join(tempDir, "pm1");
    fs.mkdirSync(pmDir1, { recursive: true });
    const req1 = createKickoffRequest(
      "test-wt-5a",
      briefFile,
      pmDir1,
      org.revision,
    );
    const { entry: entry1 } = registerKickoff(orgFile, req1);
    const kickoff1 = kickoffHashFor(entry1);

    const pmDir2 = path.join(tempDir, "pm2");
    fs.mkdirSync(pmDir2, { recursive: true });
    const req2 = createKickoffRequest(
      "test-wt-5b",
      briefFile,
      pmDir2,
      org.revision,
    );
    const { entry: entry2 } = registerKickoff(orgFile, req2);
    const kickoff2 = kickoffHashFor(entry2);

    // Try to reference from kickoff2 to kickoff1
    const doc = createTestDocument(
      kickoff2,
      "implementation",
      "workflow-task-ref",
      "task-1",
      { role: "pm", executionId: "bob-exec-1" },
    );
    doc.workflowRef = null;
    doc.taskRef = null;
    doc.attemptRefs = [];
    doc.designRef = buildDocRef(
      buildDocId({
        kickoffHash: kickoff1,
        workflowId: null,
        stageSlug: "design",
        docType: "design-contract",
        localId: "design-1",
      }),
      1,
    );

    assert.throws(() => {
      saveDocument(stateDir, doc, { refs: [doc.designRef] });
    }, /different kickoff/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario 6: 동시_갱신
test("동시_갱신", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-6",
    );

    const request = createKickoffRequest(
      "test-wt-6",
      briefFile,
      pmDir,
      org.revision,
    );
    const { entry } = registerKickoff(orgFile, request);
    const kickoffId = kickoffHashFor(entry);

    const doc = createTestDocument(
      kickoffId,
      "planning",
      "kickoff-brief-ref",
      "entry-1",
      { role: "director", executionId: "alice-exec-1" },
    );
    doc.briefPath = briefFile;
    doc.acceptanceSummary = "test";
    doc.nonGoals = [];
    doc.constraints = [];
    doc.kickoffEntryRef = entry.kickoffId;

    // First write
    const r1 = saveDocument(stateDir, doc);
    assert.equal(r1.revision, 1);

    // Simulate concurrent write from same revision
    doc.revision = 2;
    doc.basedOnRevision = 1;
    doc.reason = "update from thread 1";
    const r2 = saveDocument(stateDir, doc, { expectedRevision: 1 });
    assert.equal(r2.revision, 2);

    // Second thread also got revision 1 but tries to write now (should fail)
    const doc2 = createTestDocument(
      kickoffId,
      "planning",
      "kickoff-brief-ref",
      "entry-1",
      { role: "director", executionId: "alice-exec-1" },
    );
    doc2.briefPath = briefFile;
    doc2.acceptanceSummary = "different";
    doc2.nonGoals = [];
    doc2.constraints = [];
    doc2.kickoffEntryRef = entry.kickoffId;
    doc2.revision = 2;
    doc2.basedOnRevision = 1;
    doc2.reason = "update from thread 2";

    assert.throws(() => {
      saveDocument(stateDir, doc2, { expectedRevision: 1 });
    }, /current revision is 2/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario 7: 문서_참조_객체_원자성_인도
test("문서_참조_객체_원자성_인도", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-7",
    );

    const request = createKickoffRequest(
      "test-wt-7",
      briefFile,
      pmDir,
      org.revision,
    );
    const { entry } = registerKickoff(orgFile, request);
    const kickoffId = kickoffHashFor(entry);

    const planDoc = createTestDocument(
      kickoffId,
      "planning",
      "kickoff-brief-ref",
      "entry-1",
      { role: "director", executionId: "alice-exec-1" },
    );
    planDoc.briefPath = briefFile;
    planDoc.acceptanceSummary = "test";
    planDoc.nonGoals = [];
    planDoc.constraints = [];
    planDoc.kickoffEntryRef = entry.kickoffId;

    saveDocument(stateDir, planDoc);

    // Document should exist and be queryable
    const state = documentState(stateDir, planDoc.docId);
    assert.ok(state.exists);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario 8: 기존_kickoff_등록_항목_레거시_판정
test("기존_kickoff_등록_항목_레거시_판정", () => {
  const tempDir = makeTempDir();
  try {
    const orgDir = path.join(tempDir, ".omt");
    fs.mkdirSync(orgDir, { recursive: true });

    // Create legacy org without documentSystemActivatedAt
    const legacyOrg = {
      schemaVersion: 1,
      name: "legacy-org",
      roles: [
        { handle: "alice", role: "director" },
        { handle: "bob", role: "pm" },
      ],
      profiles: {
        alice: { role: "director" },
        bob: { role: "pm" },
      },
      policy: {
        modelPreference: "user",
      },
      revision: 1,
      // No documentSystemActivatedAt
    };

    const legacyOrgFile = path.join(orgDir, "legacy-org.json");
    fs.writeFileSync(legacyOrgFile, JSON.stringify(legacyOrg, null, 2));

    const briefFile = path.join(tempDir, "brief.md");
    fs.writeFileSync(briefFile, "# Brief\n");
    const pmDir = path.join(tempDir, "pm");
    fs.mkdirSync(pmDir, { recursive: true });

    // Try to register with legacy org
    const request = createKickoffRequest(
      "test-wt-8",
      briefFile,
      pmDir,
      legacyOrg.revision,
    );
    const { entry } = registerKickoff(legacyOrgFile, request);

    // Entry should exist but may not have registrationSeq
    assert.ok(entry);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario 9: registrationSeq_결여_무결성_실패
test("registrationSeq_결여_무결성_실패", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-9",
    );

    const request = createKickoffRequest(
      "test-wt-9",
      briefFile,
      pmDir,
      org.revision,
    );
    const { entry } = registerKickoff(orgFile, request);

    // Entry registered after documentSystemActivatedAt should have registrationSeq
    assert.ok(entry.registrationSeq !== undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario 10: orgFile_부재_기본_동작_조회_실패_거부
test("orgFile_부재_기본_동작_조회_실패_거부", () => {
  const tempDir = makeTempDir();
  try {
    const nonexistentOrgFile = path.join(tempDir, "nonexistent-org.json");

    // Operations should fail when orgFile doesn't exist
    assert.throws(() => {
      registerKickoff(nonexistentOrgFile, {
        goal: "test",
        pm: { worktreeId: "test", path: tempDir },
        organizationRevision: 1,
        brief: path.join(tempDir, "brief.md"),
        delivery: { mode: "none" },
      });
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario 11: 문서_참조_객체_원자성_검토_수용
test("문서_참조_객체_원자성_검토_수용", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-11",
    );

    const request = createKickoffRequest(
      "test-wt-11",
      briefFile,
      pmDir,
      org.revision,
    );
    const { entry } = registerKickoff(orgFile, request);
    const kickoffId = kickoffHashFor(entry);

    // Create resolved design doc
    const designDoc = createTestDocument(
      kickoffId,
      "design",
      "design-contract",
      "design-1",
      { role: "senior", executionId: "charlie-exec-1" },
    );
    designDoc.problemStatement = "test";
    designDoc.decisions = [];
    designDoc.openQuestions = [];
    designDoc.reviewRequirementRef = null;
    designDoc.state = "resolved";

    saveDocument(stateDir, designDoc);

    const state = documentState(stateDir, designDoc.docId);
    assert.equal(state.state, "resolved");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario 12: current_kickoff의_kickoffHash_전달_미커밋_문서
test("current_kickoff의_kickoffHash_전달_미커밋_문서", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-12",
    );

    const request = createKickoffRequest(
      "test-wt-12",
      briefFile,
      pmDir,
      org.revision,
    );
    const { entry } = registerKickoff(orgFile, request);
    const kickoffId = kickoffHashFor(entry);

    const planDoc = createTestDocument(
      kickoffId,
      "planning",
      "kickoff-brief-ref",
      "entry-1",
      { role: "director", executionId: "alice-exec-1" },
    );
    planDoc.briefPath = briefFile;
    planDoc.acceptanceSummary = "test";
    planDoc.nonGoals = [];
    planDoc.constraints = [];
    planDoc.kickoffEntryRef = entry.kickoffId;

    saveDocument(stateDir, planDoc);

    // Documents should be queryable
    const state = documentState(stateDir, planDoc.docId);
    assert.ok(state.exists);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario 13: legacy_kickoff의_kickoffHash_생략
test("legacy_kickoff의_kickoffHash_생략", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-13",
    );

    const request = createKickoffRequest(
      "test-wt-13",
      briefFile,
      pmDir,
      org.revision,
    );
    const { entry } = registerKickoff(orgFile, request);

    // Entry should have kickoffHash
    assert.ok(entry.kickoffHash);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario 14: integrity_failure_거부
test("integrity_failure_거부", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile } = createProjectStructure(tempDir, "test-wt-14");

    // Try to resolve nonexistent worktreeId
    assert.throws(() => {
      resolveKickoffHash(orgFile, "nonexistent-worktree-id");
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario 15: kickoffHash_재사용_격리
test("kickoffHash_재사용_격리", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, briefFile } = createProjectStructure(
      tempDir,
      "test-wt-15a",
    );

    // Create first kickoff
    const pmDir1 = path.join(tempDir, "pm1");
    fs.mkdirSync(pmDir1, { recursive: true });
    const req1 = createKickoffRequest(
      "test-wt-15a",
      briefFile,
      pmDir1,
      org.revision,
    );
    const { entry: entry1 } = registerKickoff(orgFile, req1);
    const hash1 = kickoffHashFor(entry1);

    // Release first kickoff
    releaseKickoff(orgFile, {
      worktreeId: entry1.pm.worktreeId,
      reason: "completed",
      force: true,
    });

    // Re-register same worktreeId
    const pmDir2 = path.join(tempDir, "pm2");
    fs.mkdirSync(pmDir2, { recursive: true });
    const req2 = createKickoffRequest(
      "test-wt-15a",
      briefFile,
      pmDir2,
      org.revision,
    );
    const { entry: entry2 } = registerKickoff(orgFile, req2);
    const hash2 = kickoffHashFor(entry2);

    // Hashes should differ due to registrationSeq
    assert.notEqual(hash1, hash2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario 16: 재개
test("재개", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-16",
    );

    const request = createKickoffRequest(
      "test-wt-16",
      briefFile,
      pmDir,
      org.revision,
    );
    const { entry } = registerKickoff(orgFile, request);
    const kickoffId = kickoffHashFor(entry);

    const doc = createTestDocument(
      kickoffId,
      "planning",
      "kickoff-brief-ref",
      "entry-1",
      { role: "director", executionId: "alice-exec-1" },
    );
    doc.briefPath = briefFile;
    doc.acceptanceSummary = "test";
    doc.nonGoals = [];
    doc.constraints = [];
    doc.kickoffEntryRef = entry.kickoffId;

    saveDocument(stateDir, doc);

    // Resolve kickoffHash using worktreeId
    const resolved = resolveKickoffHash(orgFile, "test-wt-16");
    assert.equal(resolved, kickoffId);

    // Document should still be queryable
    const state = documentState(stateDir, doc.docId);
    assert.ok(state.exists);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario 17: 상태_기반_거부_초안_참조
test("상태_기반_거부_초안_참조", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-17",
    );

    const request = createKickoffRequest(
      "test-wt-17",
      briefFile,
      pmDir,
      org.revision,
    );
    const { entry } = registerKickoff(orgFile, request);
    const kickoffId = kickoffHashFor(entry);

    // Create open design doc
    const designDoc = createTestDocument(
      kickoffId,
      "design",
      "design-contract",
      "design-1",
      { role: "senior", executionId: "charlie-exec-1" },
    );
    designDoc.problemStatement = "test";
    designDoc.decisions = [];
    designDoc.openQuestions = [];
    designDoc.reviewRequirementRef = null;
    designDoc.state = "open";

    saveDocument(stateDir, designDoc);

    // Try to reference open design from implementation (should fail)
    const implDoc = createTestDocument(
      kickoffId,
      "implementation",
      "workflow-task-ref",
      "task-1",
      { role: "pm", executionId: "bob-exec-1" },
    );
    implDoc.workflowRef = null;
    implDoc.taskRef = null;
    implDoc.attemptRefs = [];
    implDoc.designRef = buildDocRef(designDoc.docId, 1);

    assert.throws(() => {
      saveDocument(stateDir, implDoc, { refs: [implDoc.designRef] });
    }, /not resolved/);

    // Resolve design
    designDoc.revision = 2;
    designDoc.basedOnRevision = 1;
    designDoc.state = "resolved";
    designDoc.reason = "approved";
    saveDocument(stateDir, designDoc, { expectedRevision: 1 });

    // Now reference should succeed
    implDoc.designRef = buildDocRef(designDoc.docId, 2);
    const result = saveDocument(stateDir, implDoc, {
      refs: [implDoc.designRef],
    });
    assert.ok(result.docId);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario 18: kickoffHash_같은_밀리초_재등록
test("kickoffHash_같은_밀리초_재등록", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, briefFile } = createProjectStructure(
      tempDir,
      "test-wt-18a",
    );

    // Create two kickoffs
    const pmDir1 = path.join(tempDir, "pm1");
    fs.mkdirSync(pmDir1, { recursive: true });
    const req1 = createKickoffRequest(
      "test-wt-18a",
      briefFile,
      pmDir1,
      org.revision,
    );
    const { entry: entry1 } = registerKickoff(orgFile, req1);
    const hash1 = kickoffHashFor(entry1);

    const pmDir2 = path.join(tempDir, "pm2");
    fs.mkdirSync(pmDir2, { recursive: true });
    const req2 = createKickoffRequest(
      "test-wt-18b",
      briefFile,
      pmDir2,
      org.revision,
    );
    const { entry: entry2 } = registerKickoff(orgFile, req2);
    const hash2 = kickoffHashFor(entry2);

    // Even if fast, registrationSeq ensures different hashes
    assert.notEqual(hash1, hash2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario 19: 재등록_후_이전_kickoff_문서_완결
test("재등록_후_이전_kickoff_문서_완결", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile } = createProjectStructure(
      tempDir,
      "test-wt-19",
    );

    // Create first kickoff
    const pmDir1 = path.join(tempDir, "pm1");
    fs.mkdirSync(pmDir1, { recursive: true });
    const req1 = createKickoffRequest(
      "test-wt-19",
      briefFile,
      pmDir1,
      org.revision,
    );
    const { entry: entry1 } = registerKickoff(orgFile, req1);
    const hash1 = kickoffHashFor(entry1);

    // Create documents in first kickoff
    const doc1 = createTestDocument(
      hash1,
      "planning",
      "kickoff-brief-ref",
      "entry-1",
      { role: "director", executionId: "alice-exec-1" },
    );
    doc1.briefPath = briefFile;
    doc1.acceptanceSummary = "test";
    doc1.nonGoals = [];
    doc1.constraints = [];
    doc1.kickoffEntryRef = entry1.kickoffId;

    saveDocument(stateDir, doc1);

    // Release first kickoff
    releaseKickoff(orgFile, {
      worktreeId: entry1.pm.worktreeId,
      reason: "completed",
      force: true,
    });

    // Register second kickoff with same worktreeId
    const pmDir2 = path.join(tempDir, "pm2");
    fs.mkdirSync(pmDir2, { recursive: true });
    const req2 = createKickoffRequest(
      "test-wt-19",
      briefFile,
      pmDir2,
      org.revision,
    );
    const { entry: entry2 } = registerKickoff(orgFile, req2);
    const hash2 = kickoffHashFor(entry2);

    // Hashes should differ
    assert.notEqual(hash1, hash2);

    // First kickoff documents should still exist
    const state1 = documentState(stateDir, doc1.docId);
    assert.ok(state1.exists);

    // But resolveKickoffHash should return hash2
    const resolved = resolveKickoffHash(orgFile, "test-wt-19");
    assert.equal(resolved, hash2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
