/** Covers the director role: ladder placement, launch refusal, header, registry, and close authority. */
import { after } from "node:test";
import { cloneTemplateProject, cleanupTemplates } from "./template-factory.mjs";
after(() => cleanupTemplates());
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUDITOR_ROLE,
  DIRECTOR_ROLE,
  ROLE_LADDER,
  ACTIVE_ROLES,
  ROLES,
  ROOT_ROLE,
  fileSha256,
  foldRole,
  readJSON,
  resolveRole,
  run,
  writeJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  DISPATCH_AUTHORITY,
  readRoleCharter,
  resolveRoleLaunch,
  roleCommand,
  roleSpec,
} from "../plugins/oh-my-teams/scripts/role-launch.mjs";
import { ROLE_TITLE_TAGS } from "../plugins/oh-my-teams/scripts/role-terminal.mjs";
import {
  listKickoffs,
  bindKickoffRun,
  cleanupKickoffBranches,
  kickoffEntryName,
  recordDelivery,
  registerKickoff,
  registryDirectory,
  releaseKickoff,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";
import { recordLaunch } from "../plugins/oh-my-teams/scripts/usage-ledger.mjs";
import {
  assertDirectorAuthority,
  checkCloseReady,
  deliverKickoff,
} from "../plugins/oh-my-teams/scripts/delivery.mjs";
import { sendSignal } from "../plugins/oh-my-teams/scripts/director.mjs";
import {
  requirementsFidelity,
  requirementsFidelityConfirm,
} from "../plugins/oh-my-teams/scripts/requirements.mjs";
import { draftOrganization } from "../plugins/oh-my-teams/scripts/org-draft.mjs";
import {
  ACCEPTED_RISK_AUTHORITIES,
  acceptOutcome,
  validateReviewInput,
} from "../plugins/oh-my-teams/scripts/gates.mjs";
import {
  auditAccept,
  auditChecked,
  auditObjection,
} from "../plugins/oh-my-teams/scripts/audit.mjs";
import { verify } from "../plugins/oh-my-teams/scripts/evidence.mjs";
import { acceptWorkflowIntegration } from "../plugins/oh-my-teams/scripts/workflow.mjs";
import { acceptTaskThroughRuntime } from "./accepted-workflow-fixture.mjs";
import { taskHash } from "../plugins/oh-my-teams/scripts/contracts.mjs";
import {
  deliveryRefDocId,
  resolveKickoffHash,
  saveDocument,
} from "../plugins/oh-my-teams/scripts/documents.mjs";
import { minimalRequirements } from "./requirements-draft-fixture.mjs";

const example = () =>
  readJSON(
    new URL(
      "../plugins/oh-my-teams/examples/organization.json",
      import.meta.url,
    ),
  );

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-director-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function project(t) {
  const dir = tempDir(t);
  const org = path.join(dir, ".omt", "organization.json");
  fs.mkdirSync(path.dirname(org), { recursive: true });
  const exampleOrg = new URL(
    "../plugins/oh-my-teams/examples/organization.json",
    import.meta.url,
  );
  fs.copyFileSync(exampleOrg, org);
  const brief = path.join(dir, "brief.md");
  fs.writeFileSync(brief, "goal, acceptance criteria, non-goals\n");
  return { dir, org, brief };
}

function claimFor(fixture, worktreeId, directorOpts) {
  const pm = path.join(fixture.dir, worktreeId);
  return {
    goal: `deliver ${worktreeId}`,
    pm: {
      worktreeId,
      path: pm,
      stateDir: path.join(pm, ".omt"),
    },
    organizationRevision: readJSON(fixture.org).revision,
    brief: fixture.brief,
    delivery: { mode: "none" },
    requirements: minimalRequirements(fixture.org, worktreeId),
    ...(directorOpts !== undefined ? { director: directorOpts } : {}),
  };
}

// A pre-ledger release wrote entries with neither `requirements` nor
// `director`; registerKickoff can no longer produce one (a ledger-bearing
// claim always requires a director), so tests standing in for that legacy
// shape write the entry file directly rather than going through it.
function writeLegacyEntry(fixture, worktreeId, extra = {}) {
  const {
    requirements: _requirements,
    director: _director,
    ...claim
  } = claimFor(fixture, worktreeId);
  const entryPath = path.join(
    registryDirectory(fixture.org),
    `${kickoffEntryName(worktreeId)}.json`,
  );
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  writeJSON(entryPath, {
    schemaVersion: 1,
    ...claim,
    runId: null,
    createdAt: "2026-09-16T00:00:00.000Z",
    ...extra,
  });
}

// A tiny real Git checkout for tests that must satisfy
// `requirementsFidelity`'s check that the declared head matches the
// workspace's actual HEAD (assertKickoffCloseReady runs unconditionally
// inside checkCloseReady/deliverKickoff, so a real, close-ready ledger is
// the only way to reach the behavior those tests actually exercise).
function initGitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: dir,
      stdio: "pipe",
      encoding: "utf8",
    }).trim();
  git("init", "--initial-branch=main", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "file.txt"), "x\n");
  git("add", "file.txt");
  git("commit", "-q", "-m", "init");
  return git("rev-parse", "HEAD");
}

// Registers a kickoff and drives its ledger to close-ready (a
// director-confirmed fidelity check covering the minimal statement/criterion
// pair as "met"), so tests can call checkCloseReady/deliverKickoff without
// tripping the A.5/B.5 ledger-completeness check they no longer bypass.
async function closeReadyKickoff(
  fixture,
  worktreeId,
  directorPath,
  extra = {},
) {
  const ledgerRepo = path.join(fixture.dir, `${worktreeId}-ledger-repo`);
  const head = initGitRepo(ledgerRepo);
  registerKickoff(fixture.org, {
    ...claimFor(fixture, worktreeId, { checkoutPath: directorPath }),
    ...extra,
  });
  await requirementsFidelity(fixture.org, worktreeId, {
    head,
    repo: ledgerRepo,
    recordedBy: "pm",
    items: [
      { type: "statement", id: "s1", status: "met", evidence: "x" },
      { type: "criterion", id: "c1", status: "met", evidence: "x" },
    ],
  });
  await requirementsFidelityConfirm(fixture.org, worktreeId, directorPath);
  return head;
}

// ─── 1. 역할 서열과 접힘 ────────────────────────────────────────────────────

test("DIRECTOR_ROLE is 'director' and sits above pm in ROLE_LADDER", () => {
  assert.equal(DIRECTOR_ROLE, "director");
  assert.equal(ROLE_LADDER[0], DIRECTOR_ROLE);
  assert.equal(ROLE_LADDER[1], ROOT_ROLE);
  // director is not in ROLES (감독 worker 목록)
  assert.equal(ROLES.includes(DIRECTOR_ROLE), false);
  // ROLE_LADDER contains all ROLES after director
  assert.deepEqual(ROLE_LADDER.slice(1), ACTIVE_ROLES);
});

test("director does not appear in foldRole or resolveRole: existing folding is unchanged", () => {
  const org = example();
  // foldRole은 ROLES만 본다; director를 넣으면 Unknown role 오류
  assert.throws(() => foldRole(["pm", "pl"], DIRECTOR_ROLE), /Unknown role/);
  // resolveRole도 마찬가지
  assert.throws(() => resolveRole(org, DIRECTOR_ROLE), /Unknown role/);
  // 기존 접힘: pl 선언 안 된 팀에서 pl → pm으로 접힘
  const twoTier = draftOrganization({
    name: "mini",
    tiers: 2,
    models: ["claude:default", "codex:default"],
  });
  assert.equal(resolveRole(twoTier, "pl"), "pm");
});

test("pm and director do not fold into each other", () => {
  // pm은 ROOT_ROLE이므로 foldRole(['pm'], 'pm') === 'pm'
  assert.equal(foldRole(["pm"], ROOT_ROLE), ROOT_ROLE);
  // director는 ROLES에 없으므로 foldRole(['pm'], 'director')는 오류
  assert.throws(() => foldRole(["pm"], DIRECTOR_ROLE), /Unknown role/);
});

// 71cb8dd 병합(Director/PM/Worker 재편, AUDITOR_ROLE 도입)이 기존 PL/Senior/Junior
// 계보와 새 Worker/Auditor 계보를 모두 보존하는지 확인하는 호환성 회귀 테스트.
test("a legacy PL/Senior/Junior organization keeps its full fold and dispatch surface after the Worker/auditor reorg", () => {
  const org = example();
  const declared = ["pm", "pl", "senior", "junior"];
  assert.deepEqual(Object.keys(org.roles), declared);
  // 선언된 각 역할은 병합 전과 마찬가지로 스스로에게 그대로 접힌다.
  for (const role of declared) {
    assert.equal(foldRole(declared, role), role);
  }
  // worker가 선언되지 않은 조직에서 worker 요청은 여전히 가장 가까운 선언 역할로 접힌다.
  assert.equal(foldRole(declared, "worker"), "junior");
  // PM의 dispatch 권한은 worker가 추가된 뒤에도 pl/senior/junior를 그대로 포함한다.
  assert.deepEqual(DISPATCH_AUTHORITY.pm, ["pl", "senior", "junior", "worker"]);
  // roleCommand는 auditor 분기와 무관하게 선언된 profile로 junior를 그대로 실행한다.
  const command = roleCommand(org, "junior", { roles: declared });
  assert.equal(command.role, "junior");
  assert.equal(command.profile, org.roles.junior.profile);
});

test("org.auditor coexists with AUDITOR_ROLE and Worker on a three-tier organization without polluting ROLES/ACTIVE_ROLES", () => {
  const org = readJSON(
    new URL(
      "../plugins/oh-my-teams/examples/organization.three-tier.json",
      import.meta.url,
    ),
  );
  org.auditor = { profile: "codex-default" };
  const declared = ["pm", "worker"];
  assert.deepEqual(Object.keys(org.roles), declared);
  // auditor는 out-of-ladder 역할이므로 ROLES·ACTIVE_ROLES 어디에도 섞이지 않는다.
  assert.equal(ROLES.includes(AUDITOR_ROLE), false);
  assert.equal(ACTIVE_ROLES.includes(AUDITOR_ROLE), false);
  // foldRole은 auditor를 모르는 역할로 취급해 거부한다: auditor는 folding 대상이 아니다.
  assert.throws(() => foldRole(declared, AUDITOR_ROLE), /Unknown role/);
  // worker는 그대로 선언된 역할로 접히고, roleCommand는 auditor 요청을
  // org.auditor의 profile로, worker 요청은 org.roles.worker의 profile로 각각 실행한다.
  assert.equal(foldRole(declared, "worker"), "worker");
  const auditorCommand = roleCommand(org, AUDITOR_ROLE);
  assert.equal(auditorCommand.role, AUDITOR_ROLE);
  assert.equal(auditorCommand.profile, org.auditor.profile);
  const workerCommand = roleCommand(org, "worker", { roles: declared });
  assert.equal(workerCommand.role, "worker");
  assert.equal(workerCommand.profile, org.roles.worker.profile);
  // 역할 터미널 제목 태그는 worker와 auditor 모두를 구분해서 표시한다.
  assert.equal(ROLE_TITLE_TAGS.worker, "[Worker]");
  assert.equal(ROLE_TITLE_TAGS.auditor, "[Auditor]");
});

// ─── 2. 시작 거부 ─────────────────────────────────────────────────────────

test("resolveRoleLaunch rejects director before Orca is called", () => {
  // PM 거부와 구분되는 문구: '호스트 세션'
  assert.throws(
    () => resolveRoleLaunch(example(), DIRECTOR_ROLE, {}, { terminal: "t1" }),
    /호스트 세션/,
  );
  // PM 거부 문구는 다르다
  assert.throws(
    () => resolveRoleLaunch(example(), ROOT_ROLE),
    /PM runs in its own terminal/,
  );
});

test("roleCommand rejects director before Orca is called", () => {
  assert.throws(() => roleCommand(example(), DIRECTOR_ROLE), /호스트 세션/);
  // director 거부 문구는 PM 거부와 달리 'role-command'를 언급
  assert.throws(() => roleCommand(example(), DIRECTOR_ROLE), /role-command/);
});

// ─── 3. PM 머리글의 보고 대상 ─────────────────────────────────────────────

test("PM spec header reports to 이사, not to 사용자", () => {
  const spec = roleSpec(example(), "pm", "kickoff를 감독한다.");
  assert.match(spec, /보고 대상: 이사/);
  assert.doesNotMatch(spec, /보고 대상: 사용자/);
});

test("PM spec header includes director terminal handle when provided", () => {
  const spec = roleSpec(example(), "pm", "kickoff를 감독한다.", {
    director: { terminalHandle: "term_abc", checkoutPath: "/p" },
  });
  assert.match(spec, /보고 대상: 이사 \(term_abc\)/);
});

test("PM spec header reports to 이사 without handle when no terminalHandle given", () => {
  const spec = roleSpec(example(), "pm", "kickoff를 감독한다.", {
    director: { checkoutPath: "/p" },
  });
  assert.match(spec, /보고 대상: 이사(?! \()/);
});

test("all PM-and-below role specs include the no-direct-user-contact sentence", () => {
  const sentence = "사용자에게 직접 묻거나 보고하지 않는다.";
  for (const role of ROLES) {
    const spec = roleSpec(example(), role, "작업한다.");
    assert.ok(
      spec.includes(sentence),
      `${role} spec is missing the no-direct-user-contact sentence`,
    );
  }
});

test("sub-PM roles still report to their folded parent, not to 이사", () => {
  // pl reports to pm (not 이사)
  const pl = roleSpec(example(), "pl", "나눈다.");
  assert.match(pl, /보고 대상: PM/);
  assert.doesNotMatch(pl, /보고 대상: 이사/);
  // junior reports to senior
  const junior = roleSpec(example(), "junior", "구현한다.");
  assert.match(junior, /보고 대상: Senior/);
});

// ─── 4. 이사 기록이 없는 기존 조직·등록부의 호환 ────────────────────────

test("validateOrg accepts existing organizations without director field", () => {
  // director를 조직 파일의 roles에 추가하지 않으므로 기존 org는 그대로 유효
  const org = example();
  assert.ok(org); // validateOrg in example() call does not throw
  assert.equal(ROLES.includes(DIRECTOR_ROLE), false);
});

test("a claim with a requirements ledger but no director is refused, even equal-only", (t) => {
  const fixture = project(t);
  // A ledger-bearing claim always requires a registered director, regardless
  // of whether its criteria are all equal-scope (#139: an equal-only ledger
  // must not become a way to skip director-only-command protection).
  assert.throws(
    () => registerKickoff(fixture.org, claimFor(fixture, "wt-legacy")),
    /director\.checkoutPath is required/,
  );
});

test("existing registry entries without director field list and release normally", async (t) => {
  const fixture = project(t);
  writeLegacyEntry(fixture, "wt-legacy");
  const [entry] = listKickoffs(fixture.org).kickoffs;
  assert.equal(entry.pm.worktreeId, "wt-legacy");
  assert.equal(entry.director, undefined);

  // 경고 후 허용 - suppressWarnings로 stderr 출력을 무시하고 오류 없이 실행되는지 확인
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(msg);
  try {
    // "disbanded" skips the A.5/B.5 ledger check (only "completed" runs it),
    // so this stays about the director-authority warning, not the ledger.
    const released = await releaseKickoff(fixture.org, {
      worktreeId: "wt-legacy",
      reason: "disbanded",
    });
    assert.equal(released.released, true);
    assert.ok(warnings.some((w) => w.includes("no director record")));
  } finally {
    console.warn = originalWarn;
  }
});

test("registry entry stores director when claim provides it", (t) => {
  const fixture = project(t);
  registerKickoff(
    fixture.org,
    claimFor(fixture, "wt-with-dir", {
      terminalHandle: "term_xyz",
      checkoutPath: fixture.dir,
    }),
  );
  const [entry] = listKickoffs(fixture.org).kickoffs;
  assert.ok(entry.director);
  assert.equal(entry.director.terminalHandle, "term_xyz");
  assert.equal(
    path.resolve(entry.director.checkoutPath),
    path.resolve(fixture.dir),
  );
});

test("registry entry stores director without terminalHandle when omitted", (t) => {
  const fixture = project(t);
  registerKickoff(
    fixture.org,
    claimFor(fixture, "wt-no-handle", { checkoutPath: fixture.dir }),
  );
  const [entry] = listKickoffs(fixture.org).kickoffs;
  assert.ok(entry.director);
  assert.equal(entry.director.terminalHandle, undefined);
  assert.ok(entry.director.checkoutPath);
});

test("a claim in the documented form registers a director without any warning", (t) => {
  const fixture = project(t);
  const warnings = [];
  const original = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    const result = registerKickoff(
      fixture.org,
      claimFor(fixture, "wt-doc-form", {
        terminalHandle: "term_doc",
        checkoutPath: fixture.dir,
      }),
    );
    assert.equal(result.warnings, undefined);
    assert.equal(result.entry.director.terminalHandle, "term_doc");
  } finally {
    console.warn = original;
  }
  assert.deepEqual(warnings, []);
});

test("a claim key outside the claim format is reported instead of silently dropped", (t) => {
  const fixture = project(t);
  const warnings = [];
  const original = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    const result = registerKickoff(fixture.org, {
      ...claimFor(fixture, "wt-typo", {
        terminal: "term_typo",
        checkoutPath: fixture.dir,
      }),
      directorTerminal: "term_typo",
    });
    assert.equal(result.claimed, true);
    assert.equal(result.entry.director.terminalHandle, undefined);
    assert.deepEqual(result.warnings, [
      'Claim key "directorTerminal" is not part of the claim format and was ignored',
      'Claim key "director.terminal" is not part of the claim format and was ignored',
    ]);
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /directorTerminal/);
});

test("a director without checkoutPath is refused instead of borrowing the working directory", (t) => {
  const fixture = project(t);
  for (const director of [
    { terminalHandle: "term_x" },
    { terminalHandle: "term_x", path: fixture.dir },
    {},
  ]) {
    assert.throws(
      () =>
        registerKickoff(
          fixture.org,
          claimFor(fixture, "wt-no-checkout", director),
        ),
      /director\.checkoutPath required/,
    );
  }
  assert.deepEqual(listKickoffs(fixture.org).kickoffs, []);
});

// ─── 5. deliver와 kickoff-release의 이사 권한 거부 ───────────────────────

test("releaseKickoff refuses when caller is not the director's checkout path", async (t) => {
  const fixture = project(t);
  const directorPath = path.join(fixture.dir, "director-checkout");
  fs.mkdirSync(directorPath, { recursive: true });
  registerKickoff(
    fixture.org,
    claimFor(fixture, "wt-auth", { checkoutPath: directorPath }),
  );
  const wrongDir = path.join(fixture.dir, "wrong-place");
  fs.mkdirSync(wrongDir, { recursive: true });

  // "disbanded" skips the A.5/B.5 ledger check, so this stays about director
  // authority alone.
  await assert.rejects(
    releaseKickoff(fixture.org, {
      worktreeId: "wt-auth",
      reason: "disbanded",
      callerCwd: wrongDir,
    }),
    /kickoff-release must be run from the director/,
  );
});

test("releaseKickoff succeeds from the director's checkout path", async (t) => {
  const fixture = project(t);
  const directorPath = fixture.dir;
  registerKickoff(
    fixture.org,
    claimFor(fixture, "wt-ok", { checkoutPath: directorPath }),
  );

  const released = await releaseKickoff(fixture.org, {
    worktreeId: "wt-ok",
    reason: "disbanded",
    callerCwd: directorPath,
  });
  assert.equal(released.released, true);
});

test("releaseKickoff bypasses director check when force is given", async (t) => {
  const fixture = project(t);
  const directorPath = path.join(fixture.dir, "director-checkout");
  fs.mkdirSync(directorPath, { recursive: true });
  registerKickoff(
    fixture.org,
    claimFor(fixture, "wt-force", { checkoutPath: directorPath }),
  );

  const released = await releaseKickoff(fixture.org, {
    worktreeId: "wt-force",
    reason: "disbanded",
    callerCwd: "/some/wrong/place",
    force: true,
  });
  assert.equal(released.released, true);
});

test("deliverKickoff refuses when caller is not the director's checkout path", async (t) => {
  const fixture = project(t);
  const directorPath = path.join(fixture.dir, "director-checkout");
  fs.mkdirSync(directorPath, { recursive: true });
  // Use local-merge delivery so deliverKickoff proceeds past the delivery check
  const claim = {
    ...claimFor(fixture, "wt-deliver-auth", { checkoutPath: directorPath }),
    delivery: { mode: "local-merge", branch: "main" },
  };
  registerKickoff(fixture.org, claim);

  const wrongDir = path.join(fixture.dir, "wrong-pm-dir");
  fs.mkdirSync(wrongDir, { recursive: true });

  await assert.rejects(
    () =>
      deliverKickoff({
        orgFile: fixture.org,
        worktreeId: "wt-deliver-auth",
        source: wrongDir,
        head: "abc123",
        callerCwd: wrongDir,
      }),
    /deliver must be run from the director/,
  );
});

test("deliverKickoff bypasses director check when force is given", async (t) => {
  const fixture = project(t);
  const directorPath = path.join(fixture.dir, "director-checkout");
  fs.mkdirSync(directorPath, { recursive: true });
  const wrongDir = path.join(fixture.dir, "pm-dir");
  fs.mkdirSync(wrongDir, { recursive: true });
  // A close-ready ledger, bound to a real head, so deliverKickoff clears the
  // unconditional A.5/B.5 check and actually reaches the director/git checks
  // this test means to exercise.
  const head = await closeReadyKickoff(
    fixture,
    "wt-deliver-force",
    directorPath,
    { delivery: { mode: "local-merge", branch: "main" } },
  );

  // With force it should proceed past the director check and fail on git ops,
  // not on director authority (the entry exists, force bypasses the path check).
  await assert.rejects(
    () =>
      deliverKickoff({
        orgFile: fixture.org,
        worktreeId: "wt-deliver-force",
        source: wrongDir,
        head,
        callerCwd: wrongDir,
        force: true,
      }),
    // Should fail on git operations, not director authority
    /Cannot read the source head|source head/i,
  );
});

test("deliverKickoff warns for legacy entry without director but still refuses without a ledger", async (t) => {
  const fixture = project(t);
  const wrongDir = path.join(fixture.dir, "somewhere");
  fs.mkdirSync(wrongDir, { recursive: true });
  writeLegacyEntry(fixture, "wt-deliver-legacy", {
    delivery: { mode: "local-merge", branch: "main" },
  });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    // The director-authority warning still fires (assertDirectorAuthority runs
    // first), but a legacy entry with no requirements ledger at all is now
    // refused unconditionally by assertKickoffCloseReady (A.6 compatibility
    // boundary), never reaching the git operations.
    await assert.rejects(
      () =>
        deliverKickoff({
          orgFile: fixture.org,
          worktreeId: "wt-deliver-legacy",
          source: wrongDir,
          head: "abc123",
          callerCwd: wrongDir,
        }),
      /has no requirements ledger/,
    );
    assert.ok(warnings.some((w) => w.includes("no director record")));
  } finally {
    console.warn = originalWarn;
  }
});

// ─── 6. launchContext director 조회 경로 (finding 2) ──────────────────────

test("director from registry reaches roleSpec via stateDir lookup (launchContext path)", (t) => {
  const fixture = project(t);
  const pmStateDir = path.join(fixture.dir, "pm-worktree", ".omt");
  fs.mkdirSync(pmStateDir, { recursive: true });
  const directorPath = path.join(fixture.dir, "director-checkout");
  fs.mkdirSync(directorPath, { recursive: true });

  // Register a kickoff with a director, using pmStateDir as pm.stateDir.
  registerKickoff(fixture.org, {
    goal: "test director lookup",
    pm: {
      worktreeId: "wt-director-lookup",
      path: path.join(fixture.dir, "pm-worktree"),
      stateDir: pmStateDir,
    },
    organizationRevision: readJSON(fixture.org).revision,
    brief: fixture.brief,
    delivery: { mode: "none" },
    director: { terminalHandle: "term_lookup", checkoutPath: directorPath },
    requirements: minimalRequirements(fixture.org, "wt-director-lookup"),
  });

  // Replicate the launchContext lookup: find the kickoff entry by stateDir.
  const { kickoffs } = listKickoffs(fixture.org);
  const resolvedStateDir = path.resolve(pmStateDir);
  const entry = kickoffs.find(
    (k) => path.resolve(k.pm.stateDir) === resolvedStateDir,
  );
  assert.ok(entry, "entry found by stateDir");
  assert.ok(entry.director, "entry has director");
  assert.equal(entry.director.terminalHandle, "term_lookup");

  // Verify that passing this director to roleSpec produces a header with the handle.
  const spec = roleSpec(readJSON(fixture.org), "pm", "kickoff를 감독한다.", {
    director: entry.director,
  });
  assert.match(spec, /보고 대상: 이사 \(term_lookup\)/);
});

test("launchContext director lookup is non-fatal when registry has no matching entry", (t) => {
  const fixture = project(t);
  // No kickoff registered; listKickoffs returns empty, no director in run.
  const { kickoffs } = listKickoffs(fixture.org);
  const entry = kickoffs.find(
    (k) => path.resolve(k.pm.stateDir) === path.resolve(fixture.dir),
  );
  assert.equal(entry, undefined);
  // roleSpec without director still produces a valid header (no terminalHandle).
  const spec = roleSpec(readJSON(fixture.org), "pm", "kickoff를 감독한다.");
  assert.match(spec, /보고 대상: 이사(?! \()/);
});

// ─── 7. PR 전달의 close-ready 신호 검사 ───────────────────────────────────

test("checkCloseReady warns and returns legacy:true when no close-ready signal exists", async (t) => {
  const fixture = project(t);
  const head = await closeReadyKickoff(fixture, "wt-no-signal", fixture.dir);

  const warnings = [];
  const original = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    const result = await checkCloseReady({
      orgFile: fixture.org,
      worktreeId: "wt-no-signal",
      head,
    });
    assert.equal(result.ready, true);
    assert.equal(result.legacy, true);
    assert.ok(warnings.some((w) => w.includes("no close-ready signal")));
  } finally {
    console.warn = original;
  }
});

test("checkCloseReady throws when signal head does not match requested head", async (t) => {
  const fixture = project(t);
  // The requested head must be the one the ledger's fidelity check is bound
  // to (assertKickoffCloseReady runs before the signal comparison); the
  // signal itself carries an unrelated, non-Git head to trigger the mismatch.
  const head = await closeReadyKickoff(
    fixture,
    "wt-head-mismatch",
    fixture.dir,
  );
  sendSignal(fixture.org, {
    worktreeId: "wt-head-mismatch",
    kind: "close-ready",
    text: "ready",
    head: "signal-sha",
  });

  await assert.rejects(
    checkCloseReady({
      orgFile: fixture.org,
      worktreeId: "wt-head-mismatch",
      head,
    }),
    new RegExp(
      `close-ready signal records HEAD signal-sha but requested HEAD is ${head}`,
    ),
  );
});

test("checkCloseReady returns ready when signal head matches", async (t) => {
  const fixture = project(t);
  const head = await closeReadyKickoff(fixture, "wt-head-match", fixture.dir);
  sendSignal(fixture.org, {
    worktreeId: "wt-head-match",
    kind: "close-ready",
    text: "ready",
    head,
  });

  const result = await checkCloseReady({
    orgFile: fixture.org,
    worktreeId: "wt-head-match",
    head,
  });
  assert.equal(result.ready, true);
  assert.equal(result.legacy, undefined);
  assert.ok(result.signal);
  assert.equal(result.signal.head, head);
});

// ─── 8. kickoff-merge-record 이사 권한 거부 ─────────────────────────────

test("assertDirectorAuthority refuses when caller is not at director checkout", (t) => {
  const fixture = project(t);
  const directorPath = path.join(fixture.dir, "director-checkout");
  fs.mkdirSync(directorPath, { recursive: true });
  const wrongDir = path.join(fixture.dir, "wrong-place");
  fs.mkdirSync(wrongDir, { recursive: true });
  registerKickoff(
    fixture.org,
    claimFor(fixture, "wt-auth-check", { checkoutPath: directorPath }),
  );
  const [entry] = listKickoffs(fixture.org).kickoffs;

  assert.throws(
    () =>
      assertDirectorAuthority(entry, wrongDir, "kickoff-merge-record", false),
    /kickoff-merge-record must be run from the director/,
  );
});

test("assertDirectorAuthority succeeds from the director checkout path", (t) => {
  const fixture = project(t);
  registerKickoff(
    fixture.org,
    claimFor(fixture, "wt-auth-ok", { checkoutPath: fixture.dir }),
  );
  const [entry] = listKickoffs(fixture.org).kickoffs;
  assert.doesNotThrow(() =>
    assertDirectorAuthority(entry, fixture.dir, "kickoff-merge-record", false),
  );
});

// ─── 9. 병합 기록은 실제 git 병합만 받고 그 기록으로 cleanup이 진행 ──────────

// 주인 체크아웃 자리에 임시 저장소를 만들고, 원격으로 쓸 bare 저장소를 붙인다.
// main에서 갈라진 feat/work 브랜치가 하나 있고 두 브랜치 모두 원격에 있다.
function gitProject(t) {
  // macOS resolves the temporary directory through a symlink; the authority
  // check compares paths as written, so the fixture uses the resolved one.
  const raw = project(t);
  const dir = fs.realpathSync.native(raw.dir);
  const fixture = {
    ...raw,
    dir,
    org: path.join(dir, ".omt", "organization.json"),
  };
  const remote = tempDir(t);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: fixture.dir,
      stdio: "pipe",
      encoding: "utf8",
    }).trim();
  execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
  git("init", "--initial-branch=main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("remote", "add", "origin", remote);
  fs.writeFileSync(path.join(fixture.dir, "README.md"), "hello\n");
  git("add", "README.md");
  git("commit", "--message", "initial");
  git("push", "origin", "main");
  git("checkout", "-b", "feat/work");
  fs.writeFileSync(path.join(fixture.dir, "work.txt"), "work\n");
  git("add", "work.txt");
  git("commit", "--message", "work");
  const head = git("rev-parse", "HEAD");
  git("push", "origin", "feat/work");
  git("checkout", "main");
  const remoteHas = (branch) =>
    execFileSync("git", ["ls-remote", "--heads", "origin", branch], {
      cwd: fixture.dir,
      stdio: "pipe",
      encoding: "utf8",
    }).trim() !== "";
  registerKickoff(fixture.org, {
    ...claimFor(fixture, "wt-git", {
      checkoutPath: fixture.dir,
    }),
    delivery: { mode: "pull-request", branch: "main" },
  });
  return { ...fixture, git, head, remoteHas };
}

function mergeWork(fixture) {
  fixture.git("merge", "--no-ff", "feat/work", "--message", "merge work");
  return fixture.git("rev-parse", "HEAD");
}

function cleanUp(fixture) {
  const [entry] = listKickoffs(fixture.org, "wt-git").kickoffs;
  return cleanupKickoffBranches({
    projectDir: fixture.dir,
    entry,
    branches: ["feat/work"],
    remoteName: "origin",
    callerCwd: fixture.dir,
  });
}

test("a recorded real merge commit lets cleanup delete the merged branch", (t) => {
  const fixture = gitProject(t);
  const mergeCommit = mergeWork(fixture);
  fixture.git("push", "origin", "main");

  const recorded = recordDelivery(fixture.org, {
    worktreeId: "wt-git",
    head: fixture.head,
    mergeCommit,
  });
  assert.equal(recorded.entry.delivered.head, fixture.head);
  assert.equal(recorded.entry.delivered.mergeCommit, mergeCommit);

  // Save the delivery-ref document before cleanup
  const kickoffHash = resolveKickoffHash(fixture.org, "wt-git");
  const docId = deliveryRefDocId(kickoffHash, mergeCommit);
  const [entry] = listKickoffs(fixture.org, "wt-git").kickoffs;
  saveDocument(entry.pm.stateDir, {
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

  const result = cleanUp(fixture);
  assert.deepEqual(result.deleted, ["feat/work"]);
  assert.deepEqual(result.skipped, []);
  assert.equal(fixture.remoteHas("feat/work"), false);
  assert.throws(() => fixture.git("rev-parse", "refs/heads/feat/work"));
});

test("a merge commit that only the remote branch holds is accepted, and its full id is stored", (t) => {
  const fixture = gitProject(t);
  const before = fixture.git("rev-parse", "main");
  const mergeCommit = mergeWork(fixture);
  fixture.git("push", "origin", "main");
  // The local branch has not fetched the merge, as after a PR merged on the remote.
  fixture.git("reset", "--hard", before);

  const recorded = recordDelivery(fixture.org, {
    worktreeId: "wt-git",
    head: fixture.head.slice(0, 10),
    mergeCommit: mergeCommit.slice(0, 10),
  });
  assert.equal(recorded.entry.delivered.head, fixture.head);
  assert.equal(recorded.entry.delivered.mergeCommit, mergeCommit);
});

test("a branch tip recorded as the merge commit is refused, and cleanup deletes nothing", (t) => {
  const fixture = gitProject(t);

  assert.throws(
    () =>
      recordDelivery(fixture.org, {
        worktreeId: "wt-git",
        head: fixture.head,
        mergeCommit: fixture.head,
      }),
    /not reachable from refs\/heads\/main/,
  );
  const [entry] = listKickoffs(fixture.org, "wt-git").kickoffs;
  assert.equal(entry.delivered, undefined);

  const result = cleanUp(fixture);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.skipped, ["feat/work"]);
  assert.equal(fixture.remoteHas("feat/work"), true);
  assert.ok(fixture.git("rev-parse", "refs/heads/feat/work"));
});

test("a merge commit that does not contain the delivered head is refused", (t) => {
  const fixture = gitProject(t);
  const unrelated = fixture.git("rev-parse", "main");
  mergeWork(fixture);

  assert.throws(
    () =>
      recordDelivery(fixture.org, {
        worktreeId: "wt-git",
        head: fixture.head,
        mergeCommit: unrelated,
      }),
    /not contained in merge commit/,
  );
  assert.equal(
    listKickoffs(fixture.org, "wt-git").kickoffs[0].delivered,
    undefined,
  );
});

test("an unknown or option-like merge commit is refused", (t) => {
  const fixture = gitProject(t);
  for (const mergeCommit of [
    "0123456789abcdef0123456789abcdef01234567",
    "--all",
    "main",
    "",
    undefined,
  ]) {
    assert.throws(
      () =>
        recordDelivery(fixture.org, {
          worktreeId: "wt-git",
          head: fixture.head,
          mergeCommit,
        }),
      /is not a commit in/,
    );
  }
  assert.equal(
    listKickoffs(fixture.org, "wt-git").kickoffs[0].delivered,
    undefined,
  );
});

test("kickoff-merge-record refuses an unmerged commit through the command line", (t) => {
  const fixture = gitProject(t);
  const run = (mergeCommit) =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "../plugins/oh-my-teams/scripts/teams-org.mjs",
            import.meta.url,
          ),
        ),
        "kickoff-merge-record",
        "--org",
        fixture.org,
        "--worktree",
        "wt-git",
        "--head",
        fixture.head,
        "--merge-commit",
        mergeCommit,
      ],
      { cwd: fixture.dir, encoding: "utf8" },
    );

  const refused = run(fixture.head);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /not reachable from/);
  assert.equal(fixture.remoteHas("feat/work"), true);

  const accepted = run(mergeWork(fixture));
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).recorded, true);
});

// ─── 10. 이사 기록이 없는 기존 항목의 호환 ──────────────────────────────

test("checkCloseReady refuses a legacy kickoff with no requirements ledger", async (t) => {
  const fixture = project(t);
  writeLegacyEntry(fixture, "wt-legacy-check");

  // A legacy entry that predates the ledger feature has nothing for
  // assertKickoffCloseReady to check; it must be retrofitted before it can
  // close, the same A.6 compatibility boundary releaseKickoff enforces.
  await assert.rejects(
    checkCloseReady({
      orgFile: fixture.org,
      worktreeId: "wt-legacy-check",
      head: "any-sha",
    }),
    /has no requirements ledger/,
  );
});

test("assertDirectorAuthority warns and proceeds for legacy entry without director", (t) => {
  const fixture = project(t);
  writeLegacyEntry(fixture, "wt-legacy-authority");
  const [entry] = listKickoffs(fixture.org).kickoffs;
  assert.equal(entry.director, undefined);

  const warnings = [];
  const original = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    assertDirectorAuthority(
      entry,
      "/some/wrong/place",
      "kickoff-merge-record",
      false,
    );
    assert.ok(warnings.some((w) => w.includes("no director record")));
  } finally {
    console.warn = original;
  }
});

// ─── 8. 결함 수정: accepted-risk authority 스키마 일치 ─────────────────────

const REVIEW_SCHEMA = readJSON(
  new URL("../plugins/oh-my-teams/schemas/review.schema.json", import.meta.url),
);

test("the review schema and the runtime accept the same accepted-risk authorities", () => {
  const schemaAuthorities =
    REVIEW_SCHEMA.properties.findings.items.properties.authority.enum;
  assert.deepEqual(schemaAuthorities, [...ACCEPTED_RISK_AUTHORITIES]);
  assert.ok(schemaAuthorities.includes("director"));

  const task = {
    schemaVersion: 2,
    revision: 1,
    kind: "edit",
    id: "reviewed",
    goal: "Check the accepted-risk authorities",
    instruction: "Make the change",
    nonGoals: [],
    constraints: [],
    files: ["reviewed.txt"],
    checks: [[process.execPath, "-e", "process.exit(0)"]],
    acceptance: [
      { id: "semantic", description: "reads correctly", method: "review" },
    ],
    dependencies: [],
    contractRefs: [],
    contextRefs: [],
    openQuestions: [],
    reviewRequirements: [
      {
        id: "review-senior",
        kind: "agent-review",
        role: "senior",
        criteria: ["semantic"],
      },
    ],
    environment: "test",
    baseRef: "HEAD",
    risk: "low",
  };
  const review = (authority) => ({
    schemaVersion: 1,
    id: "review-1",
    requirementId: "review-senior",
    reviewer: {
      kind: "agent-review",
      role: "senior",
      executionId: "reviewer-exec",
    },
    implementationExecutionId: "implementation-exec",
    conclusion: "approved",
    criteria: [{ id: "semantic", conclusion: "approved", evidence: "read" }],
    findings: [
      {
        id: "risk-1",
        status: "accepted-risk",
        description: "a known gap",
        authority,
        reason: "decided by the deciding role",
      },
    ],
  });
  for (const authority of schemaAuthorities) {
    assert.equal(validateReviewInput(review(authority), task).id, "review-1");
  }
  for (const authority of ["senior", "junior", undefined]) {
    assert.throws(
      () => validateReviewInput(review(authority), task),
      /Accepted risk needs PM\/user\/director authority/,
    );
  }
});

// ─── 9. 결함 수정: close-ready 신호가 없을 때의 문서와 동작 ───────────────

test("director and close skills describe the close-ready check as the runtime runs it", () => {
  const skills = ["director", "close"].map((name) =>
    fs.readFileSync(
      new URL(
        `../plugins/oh-my-teams/skills/${name}/SKILL.md`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const text of skills) {
    // A missing signal warns and proceeds; only a different HEAD refuses.
    assert.match(text, /다르면 거부하고, 신호가 없으면 경고한 뒤 진행/);
    assert.doesNotMatch(text, /신호가 없거나[^.]*거부/);
  }
});

// ─── 10. Worker 경로 원장·감사 게이트 회귀(#139) ────────────────────────────
// assertKickoffCloseReady(A.5/B.5)는 orgFile/worktreeId만 받고 호출자의 역할을
// 구분하지 않으므로, PL/Senior/Junior 계보와 단일 Worker 계보 모두 같은
// checkCloseReady/deliverKickoff/acceptOutcome 경로를 탄다. 아래 두 테스트는
// 새 Worker/auditor 조직(organization.three-tier.json)으로 이 사실을 직접
// 재현한다.

function gitCmd(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// gapTask와 동일한 최소 task v2 fixture: tests/auditor.test.mjs의 gapTask와
// 의도적으로 같은 모양을 쓴다(리뷰 요구 없음, 단일 통과 체크 하나).
function workerGapTask(worktreeId) {
  return {
    schemaVersion: 2,
    revision: 1,
    kind: "edit",
    id: `worker-gap-${worktreeId}`,
    goal: `deliver ${worktreeId}`,
    instruction: "no-op",
    nonGoals: [],
    constraints: [],
    files: ["docs/report.md"],
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
  };
}

// 세 계층(PL/Senior/Junior) 대신 pm/worker만 선언한 organization.three-tier.json에
// org.auditor를 얹고, 실제 git 오너 프로젝트와 그 kickoff worktree를 구성한다.
// deliverKickoff이 오너 브랜치에 실제로 병합하는 경로까지 확인해야 하므로
// tests/delivery.test.mjs의 kickoffProject와 같은 실제 git worktree 구조를 쓴다.
async function workerAuditedProject(t, worktreeId) {
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "omt-worker-audit-")),
  );
  t.after(() =>
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    }),
  );
  const project = path.join(root, "project");
  await cloneTemplateProject(project);
  const org = path.join(project, ".omt", "organization.json");
  fs.mkdirSync(path.dirname(org), { recursive: true });
  const threeTier = readJSON(
    new URL(
      "../plugins/oh-my-teams/examples/organization.three-tier.json",
      import.meta.url,
    ),
  );
  threeTier.auditor = { profile: "codex-default" };
  writeJSON(org, threeTier);
  const brief = path.join(project, ".omt", "brief.md");
  fs.writeFileSync(brief, "전달 범위: main에 커밋한다.\n");

  const worktree = path.join(root, "kick");
  gitCmd(project, "worktree", "add", "-q", "-b", "kick", worktree);
  fs.mkdirSync(path.join(worktree, "docs"));
  fs.writeFileSync(path.join(worktree, "docs", "report.md"), "report\n");
  gitCmd(worktree, "add", ".");
  gitCmd(worktree, "commit", "-q", "-m", "report");
  const head = gitCmd(worktree, "rev-parse", "HEAD");

  registerKickoff(org, {
    goal: `deliver ${worktreeId}`,
    pm: {
      worktreeId,
      path: worktree,
      stateDir: path.join(worktree, ".omt"),
    },
    organizationRevision: readJSON(org).revision,
    brief,
    delivery: { mode: "local-merge", branch: "main" },
    requirements: minimalRequirements(org, worktreeId),
    director: {
      terminalHandle: `term_director_${worktreeId}`,
      checkoutPath: process.cwd(),
    },
  });
  bindKickoffRun(org, { worktreeId, runId: `run-${worktreeId}` });
  const [entry] = listKickoffs(org, worktreeId).kickoffs;
  const auditorHandle = `term_auditor_${worktreeId}`;
  recordLaunch(org, {
    via: "role-terminal",
    role: AUDITOR_ROLE,
    terminal: auditorHandle,
    stateDir: entry.pm.stateDir,
  });

  return { project, org, worktree, worktreeId, head, entry, auditorHandle };
}

async function withOrcaHandle(handle, fn) {
  const previous = process.env.ORCA_TERMINAL_HANDLE;
  process.env.ORCA_TERMINAL_HANDLE = handle;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
    else process.env.ORCA_TERMINAL_HANDLE = previous;
  }
}

test("Worker 경로: 원장 미완결과 감사 outcome 미해결 이의는 close-ready·deliver·task accept를 모두 거부한다", async (t) => {
  const fixture = await workerAuditedProject(t, "wt-worker-gap");

  // 원장이 아직 fidelity-confirm되지 않은 상태: PL/Senior/Junior 조직과 똑같이
  // close-ready/deliver 모두 assertKickoffCloseReady에서 거부된다.
  await assert.rejects(
    () =>
      checkCloseReady({
        orgFile: fixture.org,
        worktreeId: fixture.worktreeId,
        head: fixture.head,
        repo: fixture.worktree,
      }),
    /No director-confirmed fidelity check exists/,
  );
  await assert.rejects(
    () =>
      deliverKickoff({
        orgFile: fixture.org,
        worktreeId: fixture.worktreeId,
        source: fixture.worktree,
        head: fixture.head,
      }),
    /No director-confirmed fidelity check exists/,
  );

  // 원장을 close-ready로 만든다.
  await requirementsFidelity(fixture.org, fixture.worktreeId, {
    head: fixture.head,
    repo: fixture.worktree,
    recordedBy: "pm",
    items: [
      { type: "statement", id: "s1", status: "met", evidence: "report.md" },
      { type: "criterion", id: "c1", status: "met", evidence: "report.md" },
    ],
  });
  await requirementsFidelityConfirm(
    fixture.org,
    fixture.worktreeId,
    process.cwd(),
  );

  // 원장은 이제 close-ready지만 org.auditor가 선언돼 있고 brief 수용이 아직
  // 없으므로 여전히 거부된다.
  await assert.rejects(
    () =>
      checkCloseReady({
        orgFile: fixture.org,
        worktreeId: fixture.worktreeId,
        head: fixture.head,
        repo: fixture.worktree,
      }),
    /Brief audit acceptance is missing or no longer valid/,
  );

  // brief만 수용하고 outcome에는 미해결 이의를 남긴다.
  const checked = [
    { type: "statement", id: "s1" },
    { type: "criterion", id: "c1" },
  ];
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditChecked(fixture.org, fixture.worktreeId, "brief", checked),
  );
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditAccept(fixture.org, fixture.worktreeId, "brief"),
  );
  // The result repository is fixed by a workflow accepted through the runtime
  // path (Appendix G) before the objection is recorded, so the assertions
  // below still meet the outcome-acceptance refusal, not the binding one.
  const staged = await acceptTaskThroughRuntime({
    org: fixture.org,
    stateDir: path.join(fixture.worktree, ".omt"),
    taskDir: fixture.worktree,
    workflowId: "wf-worker-gap",
    resultRepo: fixture.worktree,
    role: "worker",
  });
  await acceptWorkflowIntegration(
    staged.stateDir,
    staged.workflowId,
    staged.revision,
  );
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditObjection(fixture.org, fixture.worktreeId, {
      checkpoint: "outcome",
      target: { type: "criterion", id: "c1" },
      kind: "gap",
      description: "criterion c1 does not look delivered",
      rebuttalRequested: "show where it is delivered",
      resultHead: fixture.head,
      repo: fixture.worktree,
    }),
  );

  await assert.rejects(
    () =>
      checkCloseReady({
        orgFile: fixture.org,
        worktreeId: fixture.worktreeId,
        head: fixture.head,
        repo: fixture.worktree,
      }),
    /Outcome audit acceptance is missing or no longer valid/,
  );
  await assert.rejects(
    () =>
      deliverKickoff({
        orgFile: fixture.org,
        worktreeId: fixture.worktreeId,
        source: fixture.worktree,
        head: fixture.head,
      }),
    /Outcome audit acceptance is missing or no longer valid/,
  );

  // task 단위 accept(gates.mjs acceptOutcome)도 같은 미해결 이의로 거부된다:
  // kickoff 레벨 게이트뿐 아니라 task 레벨 게이트도 Worker 경로에서 똑같이 탄다.
  const stateDir = path.join(fixture.worktree, ".omt");
  const task = workerGapTask(fixture.worktreeId);
  const evidencePath = "evidence.txt";
  fs.writeFileSync(path.join(fixture.worktree, evidencePath), "proof\n");
  const report = {
    taskId: task.id,
    taskHash: taskHash(task),
    taskRevision: task.revision,
    runId: "worker-gap-run",
    evidence: await verify(fixture.worktree, {
      baseRef: task.baseRef,
      commands: task.checks,
      environment: task.environment,
      store: path.join(stateDir, "evidence"),
    }),
  };
  const decision = {
    schemaVersion: 1,
    id: "accept-worker-gap",
    decider: { kind: "pm", executionId: "pm-worker-1" },
    criteria: ["check"],
    basis: "Check passed",
  };
  await assert.rejects(
    () =>
      acceptOutcome(fixture.worktree, task, report, decision, stateDir, {
        orgFile: fixture.org,
        worktreeId: fixture.worktreeId,
      }),
    /outcome audit checkpoint has an unresolved objection/,
  );
});

test("Worker 경로: 원장 close-ready와 감사 brief·outcome 수용을 모두 마치면 task accept부터 deliver까지 end-to-end로 통과한다", async (t) => {
  const fixture = await workerAuditedProject(t, "wt-worker-ok");

  await requirementsFidelity(fixture.org, fixture.worktreeId, {
    head: fixture.head,
    repo: fixture.worktree,
    recordedBy: "pm",
    items: [
      { type: "statement", id: "s1", status: "met", evidence: "report.md" },
      { type: "criterion", id: "c1", status: "met", evidence: "report.md" },
    ],
  });
  await requirementsFidelityConfirm(
    fixture.org,
    fixture.worktreeId,
    process.cwd(),
  );

  const checked = [
    { type: "statement", id: "s1" },
    { type: "criterion", id: "c1" },
  ];
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditChecked(fixture.org, fixture.worktreeId, "brief", checked),
  );
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditAccept(fixture.org, fixture.worktreeId, "brief"),
  );
  // The result repository is fixed by a workflow accepted through the runtime
  // path (Appendix G): task acceptance, then workflow-accept.
  const staged = await acceptTaskThroughRuntime({
    org: fixture.org,
    stateDir: path.join(fixture.worktree, ".omt"),
    taskDir: fixture.worktree,
    workflowId: "wf-worker-ok",
    resultRepo: fixture.worktree,
    role: "worker",
  });
  await acceptWorkflowIntegration(
    staged.stateDir,
    staged.workflowId,
    staged.revision,
  );
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditChecked(fixture.org, fixture.worktreeId, "outcome", checked),
  );
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditAccept(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      fixture.head,
      fixture.worktree,
    ),
  );

  const stateDir = path.join(fixture.worktree, ".omt");
  const task = workerGapTask(fixture.worktreeId);
  const evidencePath = "evidence.txt";
  fs.writeFileSync(path.join(fixture.worktree, evidencePath), "proof\n");
  const report = {
    taskId: task.id,
    taskHash: taskHash(task),
    taskRevision: task.revision,
    runId: "worker-ok-run",
    evidence: await verify(fixture.worktree, {
      baseRef: task.baseRef,
      commands: task.checks,
      environment: task.environment,
      store: path.join(stateDir, "evidence"),
    }),
  };
  const decision = {
    schemaVersion: 1,
    id: "accept-worker-ok",
    decider: { kind: "pm", executionId: "pm-worker-2" },
    criteria: ["check"],
    basis: "Check passed",
  };
  const { decision: recorded } = await acceptOutcome(
    fixture.worktree,
    task,
    report,
    decision,
    stateDir,
    { orgFile: fixture.org, worktreeId: fixture.worktreeId },
  );
  assert.equal(recorded.status, "accepted");

  const closeReady = await checkCloseReady({
    orgFile: fixture.org,
    worktreeId: fixture.worktreeId,
    head: fixture.head,
    repo: fixture.worktree,
  });
  assert.equal(closeReady.ready, true);

  const delivered = await deliverKickoff({
    orgFile: fixture.org,
    worktreeId: fixture.worktreeId,
    source: fixture.worktree,
    head: fixture.head,
  });
  assert.equal(delivered.merged, true);
  assert.equal(gitCmd(fixture.project, "rev-parse", "HEAD^2"), fixture.head);
  assert.ok(fs.existsSync(path.join(fixture.project, "docs", "report.md")));
});
