/** Covers the director role: ladder placement, launch refusal, header, registry, and close authority. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DIRECTOR_ROLE,
  ROLE_LADDER,
  ROLES,
  ROOT_ROLE,
  foldRole,
  readJSON,
  resolveRole,
  writeJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  readRoleCharter,
  resolveRoleLaunch,
  roleCommand,
  roleSpec,
} from "../plugins/oh-my-teams/scripts/role-launch.mjs";
import {
  listKickoffs,
  registerKickoff,
  releaseKickoff,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";
import { deliverKickoff } from "../plugins/oh-my-teams/scripts/delivery.mjs";
import { draftOrganization } from "../plugins/oh-my-teams/scripts/org-draft.mjs";

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
    ...(directorOpts !== undefined ? { director: directorOpts } : {}),
  };
}

// ─── 1. 역할 서열과 접힘 ────────────────────────────────────────────────────

test("DIRECTOR_ROLE is 'director' and sits above pm in ROLE_LADDER", () => {
  assert.equal(DIRECTOR_ROLE, "director");
  assert.equal(ROLE_LADDER[0], DIRECTOR_ROLE);
  assert.equal(ROLE_LADDER[1], ROOT_ROLE);
  // director is not in ROLES (감독 worker 목록)
  assert.equal(ROLES.includes(DIRECTOR_ROLE), false);
  // ROLE_LADDER contains all ROLES after director
  assert.deepEqual(ROLE_LADDER.slice(1), ROLES);
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

test("existing registry entries without director field list and release normally", (t) => {
  const fixture = project(t);
  // director 없는 claim
  registerKickoff(fixture.org, claimFor(fixture, "wt-legacy"));
  const [entry] = listKickoffs(fixture.org).kickoffs;
  assert.equal(entry.pm.worktreeId, "wt-legacy");
  assert.equal(entry.director, undefined);

  // 경고 후 허용 - suppressWarnings로 stderr 출력을 무시하고 오류 없이 실행되는지 확인
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(msg);
  try {
    const released = releaseKickoff(fixture.org, {
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

// ─── 5. deliver와 kickoff-release의 이사 권한 거부 ───────────────────────

test("releaseKickoff refuses when caller is not the director's checkout path", (t) => {
  const fixture = project(t);
  const directorPath = path.join(fixture.dir, "director-checkout");
  fs.mkdirSync(directorPath, { recursive: true });
  registerKickoff(
    fixture.org,
    claimFor(fixture, "wt-auth", { checkoutPath: directorPath }),
  );
  const wrongDir = path.join(fixture.dir, "wrong-place");
  fs.mkdirSync(wrongDir, { recursive: true });

  assert.throws(
    () =>
      releaseKickoff(fixture.org, {
        worktreeId: "wt-auth",
        reason: "disbanded",
        callerCwd: wrongDir,
      }),
    /kickoff-release must be run from the director/,
  );
});

test("releaseKickoff succeeds from the director's checkout path", (t) => {
  const fixture = project(t);
  const directorPath = fixture.dir;
  registerKickoff(
    fixture.org,
    claimFor(fixture, "wt-ok", { checkoutPath: directorPath }),
  );

  const released = releaseKickoff(fixture.org, {
    worktreeId: "wt-ok",
    reason: "disbanded",
    callerCwd: directorPath,
  });
  assert.equal(released.released, true);
});

test("releaseKickoff bypasses director check when force is given", (t) => {
  const fixture = project(t);
  const directorPath = path.join(fixture.dir, "director-checkout");
  fs.mkdirSync(directorPath, { recursive: true });
  registerKickoff(
    fixture.org,
    claimFor(fixture, "wt-force", { checkoutPath: directorPath }),
  );

  const released = releaseKickoff(fixture.org, {
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
  const claim = {
    ...claimFor(fixture, "wt-deliver-force", { checkoutPath: directorPath }),
    delivery: { mode: "local-merge", branch: "main" },
  };
  registerKickoff(fixture.org, claim);

  // With force it should proceed past the director check and fail on git ops,
  // not on director authority (the entry exists, force bypasses the path check).
  await assert.rejects(
    () =>
      deliverKickoff({
        orgFile: fixture.org,
        worktreeId: "wt-deliver-force",
        source: wrongDir,
        head: "abc123",
        callerCwd: wrongDir,
        force: true,
      }),
    // Should fail on git operations, not director authority
    /Cannot read the source head|source head/i,
  );
});

test("deliverKickoff warns and proceeds for legacy entry without director", async (t) => {
  const fixture = project(t);
  const wrongDir = path.join(fixture.dir, "somewhere");
  fs.mkdirSync(wrongDir, { recursive: true });
  const claim = {
    ...claimFor(fixture, "wt-deliver-legacy"),
    delivery: { mode: "local-merge", branch: "main" },
  };
  registerKickoff(fixture.org, claim);

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    // Should warn but proceed past the director check (fails on git ops)
    await assert.rejects(
      () =>
        deliverKickoff({
          orgFile: fixture.org,
          worktreeId: "wt-deliver-legacy",
          source: wrongDir,
          head: "abc123",
          callerCwd: wrongDir,
        }),
      /Cannot read the source head|source head/i,
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
