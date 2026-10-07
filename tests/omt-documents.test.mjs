/**
 * Regression tests for structured `.omt` document system (design brief condition 9).
 * Each test corresponds to one scenario row of design 3.14 (structured-omt-documents.md at
 * commit 2796c7a, worktree omt-docs-w2-design-legacy). The two rows "PM 로스터 조건"과
 * "PL 필드 단위 수정 범위"는 별도 작업 w2-09가 다루므로 이 파일에서는 제외한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  readJSON,
  run,
  writeJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import { verify } from "../plugins/oh-my-teams/scripts/evidence.mjs";
import { taskHash } from "../plugins/oh-my-teams/scripts/contracts.mjs";
import {
  buildDocId,
  buildDocRef,
  deliveryRefDocId,
  documentState,
  resolveKickoffHash,
  saveDocument,
} from "../plugins/oh-my-teams/scripts/documents.mjs";
import {
  cleanupKickoffBranches,
  kickoffEntryName,
  kickoffHashFor,
  registerKickoff,
  registryDirectory,
  releaseKickoff,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";
import {
  requirementsFidelity,
  requirementsFidelityConfirm,
} from "../plugins/oh-my-teams/scripts/requirements.mjs";
import {
  acceptOutcome,
  gateCheck,
  recordReview,
} from "../plugins/oh-my-teams/scripts/gates.mjs";
import { minimalRequirements } from "./requirements-draft-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const exampleOrgPath = path.resolve(
  path.join(__dirname, "../plugins/oh-my-teams/examples/organization.json"),
);
const cli = path.resolve(
  path.join(__dirname, "../plugins/oh-my-teams/scripts/teams-org.mjs"),
);

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omt-test-"));
}

function createProjectStructure(tempDir, worktreeId) {
  const projectDir = tempDir;
  const orgDir = path.join(projectDir, ".omt");
  fs.mkdirSync(orgDir, { recursive: true });

  const orgFile = path.join(orgDir, "organization.json");
  fs.copyFileSync(exampleOrgPath, orgFile);

  const org = readJSON(orgFile);
  org.documentSystemActivatedAt = new Date().toISOString();
  fs.writeFileSync(orgFile, JSON.stringify(org, null, 2));

  const briefFile = path.join(projectDir, "brief.md");
  fs.writeFileSync(briefFile, "# Test Brief\n");

  const pmDir = path.join(projectDir, "pm-wt");
  fs.mkdirSync(pmDir, { recursive: true });

  const stateDir = path.join(orgDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });

  return { orgFile, org, orgDir, briefFile, pmDir, stateDir, projectDir };
}

// stateDir을 넘기면 entry.pm.stateDir이 그 값을 실제로 가리키게 되어, releaseKickoff/
// cleanupKickoffBranches의 delivery-ref 문서 소유권 검사(documentState(entry.pm.stateDir, ...))가
// 이 테스트 파일이 만든 문서를 올바르게 찾는다. 생략하면 registerKickoff은 빈 값을 cwd로
// 되돌리므로, 그 값에 의존하지 않는 테스트에서는 그대로 생략한다.
function createKickoffRequest(
  orgFile,
  worktreeId,
  briefFile,
  pmDir,
  revision,
  stateDir,
  checkoutPath = pmDir,
) {
  return {
    goal: "Test kickoff",
    pm: {
      worktreeId,
      path: pmDir,
      ...(stateDir ? { stateDir } : {}),
    },
    organizationRevision: revision,
    brief: briefFile,
    delivery: {
      mode: "local-merge",
      branch: "main",
    },
    requirements: minimalRequirements(orgFile, worktreeId),
    director: {
      terminalHandle: `term_director_${worktreeId}`,
      checkoutPath,
    },
  };
}

// assertKickoffCloseReady(releaseKickoff --reason completed)는 legacy/integrity-failure
// 문서 분류와 무관하게, 이사가 확인한 fidelity 기록이 현재 head/원장에 바인딩돼 있을 것을
// 항상 요구한다(force도 이 게이트는 우회하지 못한다). minimalRequirements는 statement(s1)
// 하나와 criterion(c1) 하나뿐이므로, 두 항목을 정확히 한 번씩 덮는 fidelity가 필요하다.
async function confirmFidelity(orgFile, worktreeId, checkoutPath, repo, head) {
  await requirementsFidelity(orgFile, worktreeId, {
    head,
    repo,
    recordedBy: "term_director_test",
    items: [
      { type: "statement", id: "s1", status: "met", evidence: "test evidence" },
      { type: "criterion", id: "c1", status: "met", evidence: "test evidence" },
    ],
  });
  await requirementsFidelityConfirm(orgFile, worktreeId, checkoutPath);
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

function entryFileFor(orgFile, worktreeId) {
  return path.join(
    registryDirectory(orgFile),
    `${kickoffEntryName(worktreeId)}.json`,
  );
}

// registrationSeq를 지워 legacy 또는 integrity-failure 판정 후보로 만든다
// (registerKickoff은 항상 registrationSeq를 발급하므로, 강등이 그 두 분기에 도달하는 유일한 방법이다).
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

function execCliDocSave(stateDir, docFile, { expectedRevision } = {}) {
  const args = ["doc-save", "--state", stateDir, "--doc", docFile];
  if (expectedRevision !== undefined) {
    args.push("--expected-revision", String(expectedRevision));
  }
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      stdio: "pipe",
      encoding: "utf-8",
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: error.stdout || "",
      stderr: error.stderr || error.message || "",
    };
  }
}

// 합쳐진 브랜치를 가진 git 저장소를 만든다. cleanupKickoffBranches의 git-content 검사만으로도
// 삭제가 허용될 상황을 만들어, delivery-ref 문서 확인 hook 하나만으로 skip/delete가 갈리게 한다.
function mergedGitRepo(t) {
  const repoDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "omt-doc-branch-cleanup-"),
  );
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));
  const g = (args) =>
    execFileSync("git", args, {
      cwd: repoDir,
      stdio: "pipe",
      encoding: "utf8",
    }).trim();
  g(["init", "--initial-branch=main"]);
  g(["config", "user.email", "branch-cleanup@example.invalid"]);
  g(["config", "user.name", "Branch Cleanup Test"]);
  fs.writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  g(["add", "README.md"]);
  g(["commit", "--message", "initial"]);
  g(["checkout", "-b", "feat/kickoff-work"]);
  fs.writeFileSync(path.join(repoDir, "work.txt"), "work\n");
  g(["add", "work.txt"]);
  g(["commit", "--message", "kickoff work"]);
  const head = g(["rev-parse", "HEAD"]);
  g(["checkout", "main"]);
  g(["merge", "--no-ff", "feat/kickoff-work", "--message", "merge kickoff"]);
  const mergeCommit = g(["rev-parse", "HEAD"]);
  return { repoDir, head, mergeCommit };
}

// --- CLI(teams-org.mjs)를 실제 서브프로세스로 실행하는 고정물. review-record/gate-check/
// accept/merge-check가 --org로 구현하는 current/legacy/integrity-failure 캐릭터 판정과,
// gates.mjs 문서 hook을 실제 프로세스 경계 너머로 검증할 때 사용한다. ---

async function cliRun(repoDir, ...args) {
  return run([process.execPath, cli, ...args], {
    cwd: repoDir,
    timeoutMs: 120000,
  });
}

async function git(repoDir, ...args) {
  const result = await run(["git", ...args], { cwd: repoDir });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

function gitProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-doc-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const orgFile = path.join(dir, ".omt", "organization.json");
  fs.mkdirSync(path.dirname(orgFile), { recursive: true });
  fs.copyFileSync(exampleOrgPath, orgFile);
  const brief = path.join(dir, "brief.md");
  fs.writeFileSync(brief, "goal, acceptance criteria, non-goals\n");
  return { dir, orgFile, brief };
}

async function gitWorktree(fixture, worktreeId) {
  const repoDir = path.join(fixture.dir, worktreeId);
  fs.mkdirSync(repoDir, { recursive: true });
  await git(repoDir, "init");
  await git(repoDir, "config", "user.name", "Doc CLI Test");
  await git(repoDir, "config", "user.email", "doc-cli-test@example.invalid");
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

async function gatesRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-gates-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const args of [
    ["init"],
    ["config", "user.name", "Gate Test"],
    ["config", "user.email", "gate-test@example.invalid"],
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

const taskDef = (id, overrides = {}) => ({
  schemaVersion: 2,
  revision: 1,
  kind: "edit",
  id,
  goal: "Test document system wiring",
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

const reviewGateTaskDef = (id) =>
  taskDef(id, {
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

function gateEnvelope({
  kickoffHash,
  workflowId = null,
  stageSlug,
  docType,
  localId,
  author = { role: "senior", executionId: "doc-writer" },
}) {
  return {
    schemaVersion: 1,
    docId: buildDocId({ kickoffHash, workflowId, stageSlug, docType, localId }),
    stage: stageSlug,
    kickoffId: kickoffHash,
    workflowId,
    revision: 1,
    state: "resolved",
    author,
    createdAt: new Date().toISOString(),
    basedOnRevision: null,
    reason: "test fixture",
  };
}

const saveReviewRef = (stateDir, kickoffHash, workflowId, reviewId) =>
  saveDocument(
    stateDir,
    gateEnvelope({
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
    gateEnvelope({
      kickoffHash,
      workflowId,
      stageSlug: "acceptance",
      docType: "acceptance-ref",
      localId: decisionId,
      author: { role: "pm", executionId: "pm-1" },
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

// Scenario: 정상_생성_참조_갱신 (row1)
// 01. 기획부터 07. 종료까지 전 단계 문서를 실제로 생성하고, 각 단계가 이전 단계의 resolved
// 문서를 refs로 실제 참조하며, 설계 문서는 revision 1에서 2로 실제 갱신되는 것까지 확인한다.
test("정상_생성_참조_갱신", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-1",
    );

    const request = createKickoffRequest(
      orgFile,
      "test-wt-1",
      briefFile,
      pmDir,
      org.revision,
    );
    const { entry } = registerKickoff(orgFile, request);
    const kickoffId = kickoffHashFor(entry);

    // 01. 기획: kickoff-brief-ref
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
    planDoc.state = "resolved";
    const planResult = saveDocument(stateDir, planDoc);
    assert.equal(planResult.revision, 1);
    const planRef = buildDocRef(planDoc.docId, 1);

    // 02. 설계: design-contract가 기획 문서를 참조하며 생성되고, revision 2로 실제 갱신된다.
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
    designDoc.planningRef = planRef;
    designDoc.state = "open";
    const designResult = saveDocument(stateDir, designDoc, { refs: [planRef] });
    assert.equal(designResult.revision, 1);

    designDoc.revision = 2;
    designDoc.basedOnRevision = 1;
    designDoc.state = "resolved";
    designDoc.reason = "design decisions finalized";
    const designUpdateResult = saveDocument(stateDir, designDoc, {
      expectedRevision: 1,
      refs: [planRef],
    });
    assert.equal(designUpdateResult.revision, 2);
    const designRef = buildDocRef(designDoc.docId, 2);

    // 03. 구현: workflow-task-ref가 설계 문서를 참조한다.
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
    implDoc.designRef = designRef;
    implDoc.state = "resolved";
    const implResult = saveDocument(stateDir, implDoc, { refs: [designRef] });
    assert.equal(implResult.revision, 1);
    const implRef = buildDocRef(implDoc.docId, 1);

    // 04. 검토: review-ref가 구현 문서를 참조한다.
    const reviewDoc = createTestDocument(
      kickoffId,
      "review",
      "review-ref",
      "review-1",
      { role: "senior", executionId: "diana-exec-1" },
    );
    reviewDoc.reviewFileRef = null;
    reviewDoc.implementationRef = implRef;
    reviewDoc.state = "resolved";
    const reviewResult = saveDocument(stateDir, reviewDoc, { refs: [implRef] });
    assert.equal(reviewResult.revision, 1);
    const reviewRef = buildDocRef(reviewDoc.docId, 1);

    // 05. 수용: acceptance-ref가 검토 문서를 참조한다.
    const acceptDoc = createTestDocument(
      kickoffId,
      "acceptance",
      "acceptance-ref",
      "decision-1",
      { role: "pm", executionId: "bob-exec-1" },
    );
    acceptDoc.decisionRef = null;
    acceptDoc.reviewRef = reviewRef;
    acceptDoc.state = "resolved";
    const acceptResult = saveDocument(stateDir, acceptDoc, {
      refs: [reviewRef],
    });
    assert.equal(acceptResult.revision, 1);
    const acceptRef = buildDocRef(acceptDoc.docId, 1);

    // 06. 인도: delivery-ref가 수용 문서를 참조한다.
    const mergeCommit = "a".repeat(40);
    const deliveryDoc = {
      schemaVersion: 1,
      docId: deliveryRefDocId(kickoffId, mergeCommit),
      stage: "delivery",
      kickoffId,
      workflowId: null,
      revision: 1,
      state: "resolved",
      author: { role: "pm", executionId: "bob-exec-1" },
      createdAt: new Date().toISOString(),
      basedOnRevision: null,
      reason: "delivery recorded",
      deliveredCommit: mergeCommit,
      acceptanceRef: acceptRef,
    };
    const deliveryResult = saveDocument(stateDir, deliveryDoc, {
      refs: [acceptRef],
    });
    assert.equal(deliveryResult.revision, 1);
    const deliveryRef = buildDocRef(deliveryDoc.docId, 1);

    // 07. 종료: closure-record가 인도 문서를 참조한다.
    const closureDoc = createTestDocument(
      kickoffId,
      "closure",
      "closure-record",
      "closure-1",
      { role: "director", executionId: "alice-exec-1" },
    );
    closureDoc.deliveryRef = deliveryRef;
    closureDoc.state = "resolved";
    const closureResult = saveDocument(stateDir, closureDoc, {
      refs: [deliveryRef],
    });
    assert.equal(closureResult.revision, 1);

    // 7단계 문서가 모두 실제로 조회되고, revision과 state가 기대와 일치한다.
    for (const [doc, expectedRevision] of [
      [planDoc, 1],
      [designDoc, 2],
      [implDoc, 1],
      [reviewDoc, 1],
      [acceptDoc, 1],
      [deliveryDoc, 1],
      [closureDoc, 1],
    ]) {
      const state = documentState(stateDir, doc.docId);
      assert.ok(state.exists, `${doc.docId} should exist`);
      assert.equal(state.revision, expectedRevision);
      assert.equal(state.state, "resolved");
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario: 권한_없는_수정 (row2)
// doc-save CLI를 실제로 실행해 (a) 다른 실행이 남의 문서 다음 revision을 쓰려는 시도,
// (b) Junior가 04. 검토를 작성하려는 시도, (c) Senior가 자신의 구현을 스스로 검토하려는
// 시도를 각각 거부하는지 확인한다(structured-omt-documents.md 3.4).
test("권한_없는_수정", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-2",
    );

    const request = createKickoffRequest(
      orgFile,
      "test-wt-2",
      briefFile,
      pmDir,
      org.revision,
    );
    const { entry } = registerKickoff(orgFile, request);
    const kickoffId = kickoffHashFor(entry);

    // (a) 다른 실행이 같은 문서의 다음 revision을 쓰려는 시도는 거부된다.
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

    const r1 = saveDocument(stateDir, designDoc);
    assert.equal(r1.revision, 1);

    designDoc.revision = 2;
    designDoc.basedOnRevision = 1;
    designDoc.author = { role: "senior", executionId: "charlie-exec-2" };
    designDoc.reason = "attempted update by different execution";
    const designUpdateFile = path.join(tempDir, "design-doc-update.json");
    fs.writeFileSync(designUpdateFile, JSON.stringify(designDoc, null, 2));
    const differentExecution = execCliDocSave(stateDir, designUpdateFile, {
      expectedRevision: 1,
    });
    assert.notEqual(differentExecution.code, 0);
    assert.match(differentExecution.stderr, /3\.4/);

    // (b) Junior가 04. 검토(review-ref)를 작성하려는 시도는 역할 권한으로 거부된다.
    const juniorReviewDoc = createTestDocument(
      kickoffId,
      "review",
      "review-ref",
      "review-1",
      { role: "junior", executionId: "eve-exec-1" },
    );
    juniorReviewDoc.reviewFileRef = null;
    juniorReviewDoc.implementationRef = null;
    const juniorReviewFile = path.join(tempDir, "junior-review-doc.json");
    fs.writeFileSync(
      juniorReviewFile,
      JSON.stringify(juniorReviewDoc, null, 2),
    );
    const juniorAttempt = execCliDocSave(stateDir, juniorReviewFile);
    assert.notEqual(juniorAttempt.code, 0);
    assert.match(
      juniorAttempt.stderr,
      /Role junior may not author review\/review-ref/,
    );

    // (c) Senior가 자신이 구현한 작업을 스스로 검토하려는 시도는 독립성 검사로 거부된다.
    const reviewsDir = path.join(stateDir, "reviews");
    fs.mkdirSync(reviewsDir, { recursive: true });
    fs.writeFileSync(
      path.join(reviewsDir, "self-review.json"),
      JSON.stringify({ implementationExecutionId: "charlie-exec-1" }, null, 2),
    );

    const selfReviewDoc = createTestDocument(
      kickoffId,
      "review",
      "review-ref",
      "review-2",
      { role: "senior", executionId: "charlie-exec-1" },
    );
    selfReviewDoc.reviewFileRef = "reviews/self-review.json";
    selfReviewDoc.implementationRef = null;
    const selfReviewFile = path.join(tempDir, "self-review-doc.json");
    fs.writeFileSync(selfReviewFile, JSON.stringify(selfReviewDoc, null, 2));
    const selfReviewAttempt = execCliDocSave(stateDir, selfReviewFile);
    assert.notEqual(selfReviewAttempt.code, 0);
    assert.match(
      selfReviewAttempt.stderr,
      /Independent review must use a different execution identity/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario: 오래된_revision (row3)
test("오래된_revision", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-3",
    );

    const request = createKickoffRequest(
      orgFile,
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

    const r1 = saveDocument(stateDir, doc);
    assert.equal(r1.revision, 1);

    doc.revision = 2;
    doc.basedOnRevision = 1;
    doc.reason = "update";
    const r2 = saveDocument(stateDir, doc, { expectedRevision: 1 });
    assert.equal(r2.revision, 2);

    doc.revision = 3;
    doc.basedOnRevision = 2;
    assert.throws(() => {
      saveDocument(stateDir, doc, { expectedRevision: 1 });
    }, /current revision is 2/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario: 깨진_참조 (row4)
test("깨진_참조", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-4",
    );

    const request = createKickoffRequest(
      orgFile,
      "test-wt-4",
      briefFile,
      pmDir,
      org.revision,
    );
    const { entry } = registerKickoff(orgFile, request);
    const kickoffId = kickoffHashFor(entry);

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

    assert.throws(() => {
      saveDocument(stateDir, doc, { refs: [doc.designRef] });
    }, /does not exist/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario: 다른_kickoff_참조 (row5)
test("다른_kickoff_참조", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, briefFile, stateDir } = createProjectStructure(
      tempDir,
      "test-wt-5a",
    );

    const pmDir1 = path.join(tempDir, "pm1");
    fs.mkdirSync(pmDir1, { recursive: true });
    const req1 = createKickoffRequest(
      orgFile,
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
      orgFile,
      "test-wt-5b",
      briefFile,
      pmDir2,
      org.revision,
    );
    const { entry: entry2 } = registerKickoff(orgFile, req2);
    const kickoff2 = kickoffHashFor(entry2);

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

// Scenario: 동시_갱신 (row6)
// 같은 revision 1을 읽은 두 세션이 동시에 revision 2를 쓰려는 상황을, doc-save CLI를 실제로
// 동시에 두 프로세스로 실행해 재현한다. 정확히 한 쪽만 성공하고, 다른 쪽은 낙관적 동시성
// 검사 또는 락 충돌 메시지로 실패해야 한다.
test("동시_갱신", async () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-6",
    );

    const request = createKickoffRequest(
      orgFile,
      "test-wt-6",
      briefFile,
      pmDir,
      org.revision,
    );
    const { entry } = registerKickoff(orgFile, request);
    const kickoffId = kickoffHashFor(entry);

    const doc = createTestDocument(
      kickoffId,
      "design",
      "design-contract",
      "design-1",
      { role: "senior", executionId: "charlie-exec-1" },
    );
    doc.problemStatement = "test";
    doc.decisions = [];
    doc.openQuestions = [];
    doc.reviewRequirementRef = null;

    const r1 = saveDocument(stateDir, doc);
    assert.equal(r1.revision, 1);

    const buildCandidate = (reason) => ({
      ...doc,
      revision: 2,
      basedOnRevision: 1,
      reason,
    });
    const fileA = path.join(tempDir, "concurrent-a.json");
    const fileB = path.join(tempDir, "concurrent-b.json");
    fs.writeFileSync(
      fileA,
      JSON.stringify(buildCandidate("update from session A"), null, 2),
    );
    fs.writeFileSync(
      fileB,
      JSON.stringify(buildCandidate("update from session B"), null, 2),
    );

    const [resultA, resultB] = await Promise.all([
      run(
        [
          process.execPath,
          cli,
          "doc-save",
          "--state",
          stateDir,
          "--doc",
          fileA,
          "--expected-revision",
          "1",
        ],
        { cwd: tempDir },
      ),
      run(
        [
          process.execPath,
          cli,
          "doc-save",
          "--state",
          stateDir,
          "--doc",
          fileB,
          "--expected-revision",
          "1",
        ],
        { cwd: tempDir },
      ),
    ]);

    const successes = [resultA, resultB].filter((result) => result.code === 0);
    assert.equal(successes.length, 1, "정확히 한 세션만 성공해야 한다");
    const winner = successes[0];
    const loser = resultA.code === 0 ? resultB : resultA;
    assert.equal(JSON.parse(winner.stdout).revision, 2);
    assert.match(
      loser.stderr,
      /current revision is|Document update in progress/,
    );

    const finalState = documentState(stateDir, doc.docId);
    assert.equal(finalState.revision, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario: 문서_참조_객체_원자성_인도 (row7)
// releaseKickoff와 cleanupKickoffBranches를 실제로 호출해, delivery-ref 문서가 커밋되기
// 전에는 force 없이 완결이 거부되고, 커밋된 뒤에는 force 없이도 완결되며, 완결 이후에도
// delivery-ref 문서가 그대로 조회됨을 확인한다.
test("문서_참조_객체_원자성_인도", async (t) => {
  const tempDir = makeTempDir();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const { orgFile, org, stateDir, briefFile } = createProjectStructure(
    tempDir,
    "test-wt-7a",
  );

  // (1) delivery-ref 문서가 없으면 force 없는 releaseKickoff은 거부된다.
  const pmDirA = path.join(tempDir, "pm-wt-7a");
  fs.mkdirSync(pmDirA, { recursive: true });
  const requestA = createKickoffRequest(
    orgFile,
    "test-wt-7a",
    briefFile,
    pmDirA,
    org.revision,
    stateDir,
    tempDir,
  );
  registerKickoff(orgFile, requestA);
  const { repoDir: repoDirA, mergeCommit: mergeCommitA } = mergedGitRepo(t);
  const entryFileA = entryFileFor(orgFile, "test-wt-7a");
  writeJSON(entryFileA, {
    ...readJSON(entryFileA),
    delivered: {
      head: mergeCommitA,
      mergeCommit: mergeCommitA,
      at: new Date().toISOString(),
    },
  });
  // 원장을 close-ready로 만들어야 delivery-ref 거부가 실제로 관찰된다; force는
  // delivery-ref 검사만 우회할 뿐, 이 이사 fidelity 게이트는 우회하지 못한다.
  await confirmFidelity(orgFile, "test-wt-7a", tempDir, repoDirA, mergeCommitA);
  await assert.rejects(
    () =>
      releaseKickoff(orgFile, {
        worktreeId: "test-wt-7a",
        reason: "completed",
        callerCwd: tempDir,
      }),
    /delivery-ref document.*is not committed/,
  );
  const forced = await releaseKickoff(orgFile, {
    worktreeId: "test-wt-7a",
    reason: "completed",
    force: true,
    callerCwd: tempDir,
  });
  assert.equal(forced.released, true);

  // (2) delivery-ref 문서를 실제로 커밋하면 force 없이도 완결되고, 문서는 완결 이후에도 남는다.
  const pmDirB = path.join(tempDir, "pm-wt-7b");
  fs.mkdirSync(pmDirB, { recursive: true });
  const requestB = createKickoffRequest(
    orgFile,
    "test-wt-7b",
    briefFile,
    pmDirB,
    org.revision,
    stateDir,
    tempDir,
  );
  const { entry: entryB } = registerKickoff(orgFile, requestB);
  const kickoffHashB = kickoffHashFor(entryB);
  const { repoDir: repoDirB, mergeCommit: mergeCommitB } = mergedGitRepo(t);
  const entryFileB = entryFileFor(orgFile, "test-wt-7b");
  writeJSON(entryFileB, {
    ...readJSON(entryFileB),
    delivered: {
      head: mergeCommitB,
      mergeCommit: mergeCommitB,
      at: new Date().toISOString(),
    },
  });
  await confirmFidelity(orgFile, "test-wt-7b", tempDir, repoDirB, mergeCommitB);
  const deliveryDocIdB = deliveryRefDocId(kickoffHashB, mergeCommitB);
  saveDocument(stateDir, {
    schemaVersion: 1,
    docId: deliveryDocIdB,
    stage: "delivery",
    kickoffId: kickoffHashB,
    workflowId: null,
    revision: 1,
    state: "resolved",
    author: { role: "pm", executionId: "bob-exec-1" },
    createdAt: new Date().toISOString(),
    basedOnRevision: null,
    reason: "delivery recorded",
    deliveredCommit: mergeCommitB,
  });
  const releasedB = await releaseKickoff(orgFile, {
    worktreeId: "test-wt-7b",
    reason: "completed",
    callerCwd: tempDir,
  });
  assert.equal(releasedB.released, true);
  const stateB = documentState(stateDir, deliveryDocIdB);
  assert.ok(stateB.exists);
  assert.equal(stateB.state, "resolved");

  // (3) cleanupKickoffBranches도 같은 delivery-ref 문서 존재 여부로 branch 삭제를 결정한다.
  //     이 함수는 releaseKickoff과 달리 이사 fidelity 게이트를 거치지 않는다.
  const { repoDir, mergeCommit } = mergedGitRepo(t);
  const pmDirC = path.join(tempDir, "pm-wt-7c");
  fs.mkdirSync(pmDirC, { recursive: true });
  const requestC = createKickoffRequest(
    orgFile,
    "test-wt-7c",
    briefFile,
    pmDirC,
    org.revision,
    stateDir,
    tempDir,
  );
  const { entry: entryC } = registerKickoff(orgFile, requestC);
  const kickoffHashC = kickoffHashFor(entryC);
  const withDelivery = {
    ...entryC,
    delivered: { head: mergeCommit, mergeCommit },
  };

  const beforeDoc = cleanupKickoffBranches({
    projectDir: repoDir,
    entry: withDelivery,
    branches: ["feat/kickoff-work"],
    remoteName: "",
    callerCwd: tempDir,
  });
  assert.deepEqual(beforeDoc, {
    deleted: [],
    skipped: ["feat/kickoff-work"],
    errors: [],
  });

  const deliveryDocIdC = deliveryRefDocId(kickoffHashC, mergeCommit);
  saveDocument(stateDir, {
    schemaVersion: 1,
    docId: deliveryDocIdC,
    stage: "delivery",
    kickoffId: kickoffHashC,
    workflowId: null,
    revision: 1,
    state: "resolved",
    author: { role: "pm", executionId: "bob-exec-1" },
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
    callerCwd: tempDir,
  });
  assert.deepEqual(afterDoc, {
    deleted: ["feat/kickoff-work"],
    skipped: [],
    errors: [],
  });
});

// Scenario: 기존_kickoff_등록_항목_레거시_판정
// documentSystemActivatedAt이 없는 조직에서는 registrationSeq 없는 entry가 legacy로 판정되어,
// releaseKickoff와 cleanupKickoffBranches가 delivery-ref 문서 검사를 건너뛰고 그대로 완결된다.
test("기존_kickoff_등록_항목_레거시_판정", async (t) => {
  const tempDir = makeTempDir();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const { orgFile, org, stateDir, briefFile } = createProjectStructure(
    tempDir,
    "test-wt-8",
  );
  const orgWithoutActivation = readJSON(orgFile);
  delete orgWithoutActivation.documentSystemActivatedAt;
  writeJSON(orgFile, orgWithoutActivation);

  const pmDir = path.join(tempDir, "pm-wt-8");
  fs.mkdirSync(pmDir, { recursive: true });
  registerKickoff(
    orgFile,
    createKickoffRequest(
      orgFile,
      "test-wt-8",
      briefFile,
      pmDir,
      org.revision,
      stateDir,
      tempDir,
    ),
  );
  demote(orgFile, "test-wt-8");
  const entryFile = entryFileFor(orgFile, "test-wt-8");
  assert.equal(readJSON(entryFile).registrationSeq, undefined);

  const { repoDir: releaseRepoDir, mergeCommit: releaseMergeCommit } =
    mergedGitRepo(t);
  writeJSON(entryFile, {
    ...readJSON(entryFile),
    delivered: {
      head: releaseMergeCommit,
      mergeCommit: releaseMergeCommit,
      at: new Date().toISOString(),
    },
  });
  // "legacy"는 delivery-ref 문서 검사만 건너뛰게 하는 documentState 분류이며,
  // releaseKickoff의 이사 fidelity 게이트는 이 분류와 무관하게 항상 실행된다.
  await confirmFidelity(
    orgFile,
    "test-wt-8",
    tempDir,
    releaseRepoDir,
    releaseMergeCommit,
  );

  const released = await releaseKickoff(orgFile, {
    worktreeId: "test-wt-8",
    reason: "completed",
    callerCwd: tempDir,
  });
  assert.equal(released.released, true);

  const { repoDir, mergeCommit } = mergedGitRepo(t);
  const legacyEntry = {
    delivery: { mode: "local-merge", branch: "main" },
    delivered: { head: mergeCommit, mergeCommit },
  };
  const cleanupResult = cleanupKickoffBranches({
    projectDir: repoDir,
    entry: legacyEntry,
    branches: ["feat/kickoff-work"],
    remoteName: "",
  });
  assert.deepEqual(cleanupResult, {
    deleted: ["feat/kickoff-work"],
    skipped: [],
    errors: [],
  });
});

// Scenario: registrationSeq_결여_무결성_실패
// documentSystemActivatedAt 이후 등록되었는데 registrationSeq가 없는 entry는 integrity-failure로
// 판정되어, releaseKickoff와 cleanupKickoffBranches 모두 force 없이는 거부되고 force로만 우회된다.
test("registrationSeq_결여_무결성_실패", async (t) => {
  const tempDir = makeTempDir();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const { orgFile, org, stateDir, briefFile } = createProjectStructure(
    tempDir,
    "test-wt-9",
  );
  activateInThePast(orgFile);

  const pmDir = path.join(tempDir, "pm-wt-9");
  fs.mkdirSync(pmDir, { recursive: true });
  const { entry } = registerKickoff(
    orgFile,
    createKickoffRequest(
      orgFile,
      "test-wt-9",
      briefFile,
      pmDir,
      org.revision,
      stateDir,
      tempDir,
    ),
  );
  assert.ok(entry.registrationSeq !== undefined);

  demote(orgFile, "test-wt-9");
  const entryFile = entryFileFor(orgFile, "test-wt-9");
  const { repoDir: releaseRepoDir, mergeCommit: releaseMergeCommit } =
    mergedGitRepo(t);
  writeJSON(entryFile, {
    ...readJSON(entryFile),
    delivered: {
      head: releaseMergeCommit,
      mergeCommit: releaseMergeCommit,
      at: new Date().toISOString(),
    },
  });
  // force는 registrationSeq 무결성 거부를 우회하지만 이사 fidelity 게이트는 만들어 주지
  // 않으므로, 원장을 먼저 close-ready로 만들어야 아래 integrity 거부가 실제로 나타난다.
  await confirmFidelity(
    orgFile,
    "test-wt-9",
    tempDir,
    releaseRepoDir,
    releaseMergeCommit,
  );

  await assert.rejects(
    () =>
      releaseKickoff(orgFile, {
        worktreeId: "test-wt-9",
        reason: "completed",
        callerCwd: tempDir,
      }),
    /no registrationSeq.*completion is refused as a corrupted entry/,
  );
  const forcedRelease = await releaseKickoff(orgFile, {
    worktreeId: "test-wt-9",
    reason: "completed",
    force: true,
    callerCwd: tempDir,
  });
  assert.equal(forcedRelease.released, true);

  const { repoDir, mergeCommit } = mergedGitRepo(t);
  const integrityFailureEntry = {
    createdAt: new Date().toISOString(),
    delivery: { mode: "local-merge", branch: "main" },
    delivered: { head: mergeCommit, mergeCommit },
  };
  const skipped = cleanupKickoffBranches({
    projectDir: repoDir,
    entry: integrityFailureEntry,
    branches: ["feat/kickoff-work"],
    remoteName: "",
    orgFile,
  });
  assert.deepEqual(skipped, {
    deleted: [],
    skipped: ["feat/kickoff-work"],
    errors: [],
  });

  const forcedCleanup = cleanupKickoffBranches({
    projectDir: repoDir,
    entry: integrityFailureEntry,
    branches: ["feat/kickoff-work"],
    remoteName: "",
    orgFile,
    force: true,
  });
  assert.deepEqual(forcedCleanup, {
    deleted: ["feat/kickoff-work"],
    skipped: [],
    errors: [],
  });
});

// Scenario: orgFile_부재_기본_동작_조회_실패_거부
// orgFile을 주지 않으면 registrationSeq 없는 entry는 활성화 경계와 무관하게 항상 legacy로
// 판정되어(기존 동작 유지) branch가 삭제되고, 반대로 조회할 수 없는 orgFile을 지정하면
// force와 무관하게 어떤 branch도 건드리지 않고 즉시 거부한다.
test("orgFile_부재_기본_동작_조회_실패_거부", (t) => {
  const { repoDir, mergeCommit } = mergedGitRepo(t);
  const registrationSeqLessEntry = {
    delivery: { mode: "local-merge", branch: "main" },
    delivered: { head: mergeCommit, mergeCommit },
  };
  const withoutOrgFile = cleanupKickoffBranches({
    projectDir: repoDir,
    entry: registrationSeqLessEntry,
    branches: ["feat/kickoff-work"],
    remoteName: "",
  });
  assert.deepEqual(withoutOrgFile, {
    deleted: ["feat/kickoff-work"],
    skipped: [],
    errors: [],
  });

  const { repoDir: repoDir2, mergeCommit: mergeCommit2 } = mergedGitRepo(t);
  const missingOrgFile = path.join(repoDir2, "does-not-exist.json");
  const entry2 = {
    delivery: { mode: "local-merge", branch: "main" },
    delivered: { head: mergeCommit2, mergeCommit: mergeCommit2 },
  };
  for (const force of [false, true]) {
    assert.throws(() =>
      cleanupKickoffBranches({
        projectDir: repoDir2,
        entry: entry2,
        branches: ["feat/kickoff-work"],
        remoteName: "",
        orgFile: missingOrgFile,
        force,
      }),
    );
  }
  const branches = execFileSync(
    "git",
    ["branch", "--list", "feat/kickoff-work"],
    { cwd: repoDir2, encoding: "utf8" },
  );
  assert.match(branches, /feat\/kickoff-work/);
});

// Scenario: 문서_참조_객체_원자성_검토_수용 (row8)
// gates.mjs의 recordReview/gateCheck/acceptOutcome을 실제로 호출해, 04. 검토와 05. 수용
// 게이트가 각각 review-ref/acceptance-ref 문서 커밋 전에는 pending, 커밋 후에는 passed로
// 전환됨을 확인한다(structured-omt-documents.md 3.7 item 5).
test("문서_참조_객체_원자성_검토_수용", async (t) => {
  const dir = await gatesRepo(t);
  const stateDir = path.join(dir, ".omt");
  const kickoffHash = "d".repeat(64);
  const workflowId = "wf-row8";

  const definedTask = reviewGateTaskDef("row8-gate");
  const report = await passingReport(dir, stateDir, definedTask, "impl-run");

  const { gateStatus: recordedReview } = await recordReview(
    dir,
    definedTask,
    report,
    reviewInput(),
    stateDir,
    { kickoffHash, workflowId },
  );
  assert.equal(recordedReview.gates["review-complete"].status, "pending");

  saveReviewRef(stateDir, kickoffHash, workflowId, "review-1");
  const afterReview = await gateCheck(dir, definedTask, report, stateDir, {
    kickoffHash,
    workflowId,
  });
  assert.equal(afterReview.gates["review-complete"].status, "passed");

  const decision = {
    schemaVersion: 1,
    id: "decision-1",
    decider: { kind: "pm", executionId: "pm-1" },
    criteria: ["check", "scope-review"],
    basis: "Check passed and independent review approved the scope.",
  };
  const { gateStatus: recordedAccept } = await acceptOutcome(
    dir,
    definedTask,
    report,
    decision,
    stateDir,
    { kickoffHash, workflowId },
  );
  assert.equal(recordedAccept.gates["outcome-accepted"].status, "pending");
  assert.equal(recordedAccept.state, "reviewed");

  saveAcceptanceRef(stateDir, kickoffHash, workflowId, "decision-1");
  const afterAccept = await gateCheck(dir, definedTask, report, stateDir, {
    kickoffHash,
    workflowId,
  });
  assert.equal(afterAccept.gates["outcome-accepted"].status, "passed");
  assert.equal(afterAccept.state, "accepted");
});

// Scenario: current_kickoff의_kickoffHash_전달과_미커밋_문서
// review-record/gate-check CLI가 --org로 current 판정된 entry의 kickoffHash를 실제로
// gates.mjs에 전달해, review-ref 문서 커밋 전에는 pending을 보고하고 커밋 후에는 passed로
// 전환함을 확인한다.
test("current_kickoff의_kickoffHash_전달_미커밋_문서", async (t) => {
  const fx = gitProject(t);
  const wt = await gitWorktree(fx, "wt-current-row12");
  const { kickoffHash } = registerCurrent(fx, "wt-current-row12", wt);
  const stateDir = wt.stateDir;

  const definedTask = reviewGateTaskDef("current-gate");
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

  const reviewDocFile = path.join(wt.repoDir, "review-doc.json");
  writeJSON(
    reviewDocFile,
    gateEnvelope({
      kickoffHash,
      stageSlug: "review",
      docType: "review-ref",
      localId: "review-1",
    }),
  );
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
});

// Scenario: legacy_kickoff의_kickoffHash_생략
// legacy로 판정된 entry에 대해서는 review-record CLI가 kickoffHash를 생략하고, 문서 커밋과
// 무관하게 체크·리뷰 입력만으로 즉시 통과하는 기존 게이트 동작을 그대로 유지함을 확인한다.
test("legacy_kickoff의_kickoffHash_생략", async (t) => {
  const fx = gitProject(t);
  const wt = await gitWorktree(fx, "wt-legacy-row13");
  registerCurrent(fx, "wt-legacy-row13", wt);
  demote(fx.orgFile, "wt-legacy-row13");
  const stateDir = wt.stateDir;

  const definedTask = reviewGateTaskDef("legacy-gate");
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
});

// Scenario: integrity_failure_거부
// gate-check CLI가 --org의 캐릭터 판정을 실제로 거부하는 세 분기(entry가 integrity-failure,
// --state를 소유한 entry가 없음, --org 자체를 읽을 수 없음)를 모두 확인한다.
test("integrity_failure_거부", async (t) => {
  const fx1 = gitProject(t);
  const wt1 = await gitWorktree(fx1, "wt-integrity-row14");
  registerCurrent(fx1, "wt-integrity-row14", wt1);
  activateInThePast(fx1.orgFile);
  demote(fx1.orgFile, "wt-integrity-row14");
  const definedTask1 = reviewGateTaskDef("integrity-gate");
  const taskFile1 = path.join(wt1.repoDir, "task.json");
  writeJSON(taskFile1, definedTask1);
  const report1 = await passingReport(
    wt1.repoDir,
    wt1.stateDir,
    definedTask1,
    "impl-run",
  );
  const reportFile1 = path.join(wt1.repoDir, "report.json");
  writeJSON(reportFile1, report1);

  const integrityResult = await cliRun(
    wt1.repoDir,
    "gate-check",
    "--task",
    taskFile1,
    "--report",
    reportFile1,
    "--repo",
    wt1.repoDir,
    "--state",
    wt1.stateDir,
    "--org",
    fx1.orgFile,
  );
  assert.notEqual(integrityResult.code, 0);
  assert.match(integrityResult.stderr, /registrationSeq/);

  const fx2 = gitProject(t);
  const wt2 = await gitWorktree(fx2, "wt-unmatched-row14");
  const definedTask2 = reviewGateTaskDef("unmatched-gate");
  const taskFile2 = path.join(wt2.repoDir, "task.json");
  writeJSON(taskFile2, definedTask2);
  const report2 = await passingReport(
    wt2.repoDir,
    wt2.stateDir,
    definedTask2,
    "impl-run",
  );
  const reportFile2 = path.join(wt2.repoDir, "report.json");
  writeJSON(reportFile2, report2);

  const unmatchedResult = await cliRun(
    wt2.repoDir,
    "gate-check",
    "--task",
    taskFile2,
    "--report",
    reportFile2,
    "--repo",
    wt2.repoDir,
    "--state",
    wt2.stateDir,
    "--org",
    fx2.orgFile,
  );
  assert.notEqual(unmatchedResult.code, 0);
  assert.match(
    unmatchedResult.stderr,
    /No registered kickoff owns state directory/,
  );

  const missingOrgFile = path.join(wt2.repoDir, "does-not-exist.json");
  const unreadableResult = await cliRun(
    wt2.repoDir,
    "gate-check",
    "--task",
    taskFile2,
    "--report",
    reportFile2,
    "--repo",
    wt2.repoDir,
    "--state",
    wt2.stateDir,
    "--org",
    missingOrgFile,
  );
  assert.notEqual(unreadableResult.code, 0);
  assert.match(unreadableResult.stderr, /Cannot read organization file/);
});

// Scenario: kickoffHash_재사용_격리 (row9)
test("kickoffHash_재사용_격리", async (t) => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, briefFile, stateDir } = createProjectStructure(
      tempDir,
      "test-wt-15a",
    );

    const pmDir1 = path.join(tempDir, "pm1");
    fs.mkdirSync(pmDir1, { recursive: true });
    const req1 = createKickoffRequest(
      orgFile,
      "test-wt-15a",
      briefFile,
      pmDir1,
      org.revision,
      undefined,
      tempDir,
    );
    const { entry: entry1 } = registerKickoff(orgFile, req1);
    const hash1 = kickoffHashFor(entry1);

    // force는 delivered 기록이 없어도 완결시키지만, --head(또는 이전 deliver)와
    // 이사 fidelity 확인은 여전히 요구한다.
    const { repoDir, mergeCommit } = mergedGitRepo(t);
    await confirmFidelity(
      orgFile,
      "test-wt-15a",
      tempDir,
      repoDir,
      mergeCommit,
    );
    await releaseKickoff(orgFile, {
      worktreeId: entry1.pm.worktreeId,
      reason: "completed",
      force: true,
      head: mergeCommit,
      callerCwd: tempDir,
    });

    const pmDir2 = path.join(tempDir, "pm2");
    fs.mkdirSync(pmDir2, { recursive: true });
    const req2 = createKickoffRequest(
      orgFile,
      "test-wt-15a",
      briefFile,
      pmDir2,
      org.revision,
      undefined,
      tempDir,
    );
    const { entry: entry2 } = registerKickoff(orgFile, req2);
    const hash2 = kickoffHashFor(entry2);

    assert.notEqual(hash1, hash2);

    // 새 kickoff의 문서는 이전 kickoff의 revision을 이어받지 않고 1부터 다시 시작한다.
    const doc2 = createTestDocument(
      hash2,
      "planning",
      "kickoff-brief-ref",
      "entry-1",
      { role: "director", executionId: "alice-exec-1" },
    );
    doc2.briefPath = briefFile;
    doc2.acceptanceSummary = "test";
    doc2.nonGoals = [];
    doc2.constraints = [];
    doc2.kickoffEntryRef = entry2.kickoffId;
    const result2 = saveDocument(stateDir, doc2);
    assert.equal(result2.revision, 1);

    // 같은 docType/localId라도 kickoffHash가 다르면 서로 다른 문서로 완전히 격리된다.
    const doc1SameLocalId = createTestDocument(
      hash1,
      "planning",
      "kickoff-brief-ref",
      "entry-1",
      { role: "director", executionId: "alice-exec-1" },
    );
    const state1 = documentState(stateDir, doc1SameLocalId.docId);
    assert.equal(state1.exists, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario: 재개 (row10)
test("재개", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-16",
    );

    const request = createKickoffRequest(
      orgFile,
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

    const resolved = resolveKickoffHash(orgFile, "test-wt-16");
    assert.equal(resolved, kickoffId);

    const state = documentState(stateDir, doc.docId);
    assert.ok(state.exists);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario: 상태_기반_거부_초안_참조 (row11)
test("상태_기반_거부_초안_참조", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-17",
    );

    const request = createKickoffRequest(
      orgFile,
      "test-wt-17",
      briefFile,
      pmDir,
      org.revision,
    );
    const { entry } = registerKickoff(orgFile, request);
    const kickoffId = kickoffHashFor(entry);

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

    designDoc.revision = 2;
    designDoc.basedOnRevision = 1;
    designDoc.state = "resolved";
    designDoc.reason = "approved";
    saveDocument(stateDir, designDoc, { expectedRevision: 1 });

    implDoc.designRef = buildDocRef(designDoc.docId, 2);
    const result = saveDocument(stateDir, implDoc, {
      refs: [implDoc.designRef],
    });
    assert.ok(result.docId);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Scenario: kickoffHash_같은_밀리초_재등록 (row12)
// Date를 고정해 두 kickoff이 실제로 같은 밀리초에 createdAt을 얻도록 강제한 뒤,
// registrationSeq만으로 kickoffHash가 여전히 갈라짐을 확인한다.
test("kickoffHash_같은_밀리초_재등록", (t) => {
  const tempDir = makeTempDir();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const { orgFile, org, briefFile } = createProjectStructure(
    tempDir,
    "test-wt-18a",
  );
  const pmDir1 = path.join(tempDir, "pm1");
  fs.mkdirSync(pmDir1, { recursive: true });
  const pmDir2 = path.join(tempDir, "pm2");
  fs.mkdirSync(pmDir2, { recursive: true });

  t.mock.timers.enable({ apis: ["Date"] });

  const req1 = createKickoffRequest(
    orgFile,
    "test-wt-18a",
    briefFile,
    pmDir1,
    org.revision,
  );
  const { entry: entry1 } = registerKickoff(orgFile, req1);

  const req2 = createKickoffRequest(
    orgFile,
    "test-wt-18b",
    briefFile,
    pmDir2,
    org.revision,
  );
  const { entry: entry2 } = registerKickoff(orgFile, req2);

  assert.equal(entry1.createdAt, entry2.createdAt);
  assert.notEqual(entry1.registrationSeq, entry2.registrationSeq);

  const hash1 = kickoffHashFor(entry1);
  const hash2 = kickoffHashFor(entry2);
  assert.notEqual(hash1, hash2);
});

// Scenario: 재등록_후_이전_kickoff_문서_완결 (row13)
test("재등록_후_이전_kickoff_문서_완결", async (t) => {
  const tempDir = makeTempDir();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const { orgFile, org, stateDir, briefFile } = createProjectStructure(
    tempDir,
    "test-wt-19",
  );

  const pmDir1 = path.join(tempDir, "pm1");
  fs.mkdirSync(pmDir1, { recursive: true });
  const req1 = createKickoffRequest(
    orgFile,
    "test-wt-19",
    briefFile,
    pmDir1,
    org.revision,
    stateDir,
    tempDir,
  );
  const { entry: entry1 } = registerKickoff(orgFile, req1);
  const hash1 = kickoffHashFor(entry1);

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

  // force는 delivered 기록이 없어도 완결시키지만, --head(또는 이전 deliver)와
  // 이사 fidelity 확인은 여전히 요구한다(15와 같은 이유).
  const { repoDir, mergeCommit } = mergedGitRepo(t);
  await confirmFidelity(orgFile, "test-wt-19", tempDir, repoDir, mergeCommit);
  await releaseKickoff(orgFile, {
    worktreeId: entry1.pm.worktreeId,
    reason: "completed",
    force: true,
    head: mergeCommit,
    callerCwd: tempDir,
  });

  const pmDir2 = path.join(tempDir, "pm2");
  fs.mkdirSync(pmDir2, { recursive: true });
  const req2 = createKickoffRequest(
    orgFile,
    "test-wt-19",
    briefFile,
    pmDir2,
    org.revision,
    stateDir,
    tempDir,
  );
  const { entry: entry2 } = registerKickoff(orgFile, req2);
  const hash2 = kickoffHashFor(entry2);
  assert.notEqual(hash1, hash2);

  const state1 = documentState(stateDir, doc1.docId);
  assert.ok(state1.exists);

  // 이전 kickoff(A)의 완결 시도(delivery-ref 문서 작성)는 재등록 이후에도 실제로 성공한다.
  const docMergeCommit = "e".repeat(40);
  const deliveryDocId1 = deliveryRefDocId(hash1, docMergeCommit);
  const deliveryDoc1 = {
    schemaVersion: 1,
    docId: deliveryDocId1,
    stage: "delivery",
    kickoffId: hash1,
    workflowId: null,
    revision: 1,
    state: "resolved",
    author: { role: "pm", executionId: "bob-exec-1" },
    createdAt: new Date().toISOString(),
    basedOnRevision: null,
    reason: "delivery recorded for the released kickoff",
    deliveredCommit: docMergeCommit,
  };
  const completionResult = saveDocument(stateDir, deliveryDoc1);
  assert.equal(completionResult.revision, 1);

  // 같은 mergeCommit이라도 재등록된 kickoff(B)의 kickoffHash로는 전혀 다른 문서이므로,
  // A의 완결 상태를 이어받았다고 가정한 쓰기는 실패한다.
  const deliveryDocId2 = deliveryRefDocId(hash2, docMergeCommit);
  const stateBeforeB = documentState(stateDir, deliveryDocId2);
  assert.equal(stateBeforeB.exists, false);
  assert.throws(
    () =>
      saveDocument(
        stateDir,
        {
          ...deliveryDoc1,
          docId: deliveryDocId2,
          kickoffId: hash2,
          revision: 2,
          basedOnRevision: 1,
        },
        { expectedRevision: 1 },
      ),
    /current revision is 0/,
  );

  const resolved = resolveKickoffHash(orgFile, "test-wt-19");
  assert.equal(resolved, hash2);

  await t.test("saveDocument rejects task-comment", () => {
    const kId =
      "0000000000000000000000000000000000000000000000000000000000000000";
    const commentDoc = {
      schemaVersion: 1,
      docId: `${hash2}/wf-1/implementation/task-comment/c1`,
      kickoffId: hash2,
      workflowId: "wf-1",
      stage: "implementation",
      revision: 1,
      state: "open",
      basedOnRevision: null,
      reason: "test reason",
      createdAt: new Date().toISOString(),
      author: { role: "pm", executionId: "exec-1" },
      content: "This is a comment",
    };
    assert.throws(
      () => saveDocument(stateDir, commentDoc),
      /task-comment documents are explicitly rejected/,
    );
  });
});
