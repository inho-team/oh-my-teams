/** Auditor checkpoints: objection/response/ruling records and acceptance gates. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUDITOR_ROLE, fileSha256, readJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  bindKickoffRun,
  listKickoffs,
  registerKickoff,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";
import { recordLaunch } from "../plugins/oh-my-teams/scripts/usage-ledger.mjs";
import { requirementsPresent } from "../plugins/oh-my-teams/scripts/requirements.mjs";
import {
  auditAccept,
  auditChecked,
  auditObjection,
  auditResponse,
  auditRuling,
  hasValidAcceptance,
  readAudit,
} from "../plugins/oh-my-teams/scripts/audit.mjs";

const exampleOrg = new URL(
  "../plugins/oh-my-teams/examples/organization.json",
  import.meta.url,
);

// A plausible-looking commit id that is guaranteed not to be any fixture's
// actual HEAD, for the forged/stale-head counterexamples below.
const FORGED_HEAD = "0".repeat(40);

// One equal-scope criterion needs no narrower confirmation, so no more of the
// ledger draft/confirm flow (tested in its own file) is needed here.
function minimalRequirements(worktreeId) {
  return {
    statements: [{ id: "s1", text: `deliver ${worktreeId}`, source: "brief" }],
    criteria: [
      { id: "c1", text: `deliver ${worktreeId}`, scope: "equal", userVisible: false, derivedFrom: ["s1"] },
    ],
    confirmations: [],
  };
}

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir }).toString().trim();
}

// A real Git repository with one commit, independent of the workspaceBinding
// adapter under test — resultHead/head assertions must be checked against an
// actual `git rev-parse HEAD`, not an arbitrary string a test made up.
function initRepo(dir) {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "auditor-test@example.com"]);
  git(dir, ["config", "user.name", "Auditor Test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "fixture repo\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return git(dir, ["rev-parse", "HEAD"]);
}

// A registered kickoff with a director, a bound Run, and a launched auditor
// terminal — enough identity plumbing for every verifiedAuditor/verifiedPm/
// verifiedDirector check these tests exercise to pass. `dir` doubles as the
// Git workspace resultHead/head claims are checked against.
function kickoff(t, worktreeId = "wt-1") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-audit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const head = initRepo(dir);
  const org = path.join(dir, ".omt", "organization.json");
  fs.mkdirSync(path.dirname(org), { recursive: true });
  fs.copyFileSync(exampleOrg, org);
  const brief = path.join(dir, "brief.md");
  fs.writeFileSync(brief, "goal, acceptance criteria, non-goals\n");
  const pm = path.join(dir, worktreeId);
  const auditorHandle = `term_auditor_${worktreeId}`;
  const pmHandle = `term_pm_${worktreeId}`;
  registerKickoff(org, {
    goal: `deliver ${worktreeId}`,
    pm: { worktreeId, path: pm, stateDir: path.join(pm, ".omt") },
    organizationRevision: readJSON(org).revision,
    brief,
    delivery: { mode: "none" },
    requirements: minimalRequirements(worktreeId),
    director: { terminalHandle: "term_director_1", checkoutPath: dir },
  });
  bindKickoffRun(org, { worktreeId, runId: "run-1" });
  const [entry] = listKickoffs(org, worktreeId).kickoffs;
  recordLaunch(org, {
    via: "role-terminal",
    role: AUDITOR_ROLE,
    terminal: auditorHandle,
    stateDir: entry.pm.stateDir,
  });
  return { dir, repo: dir, head, org, brief, worktreeId, entry, auditorHandle, pmHandle };
}

const auditorEnv = (handle) => ({ ORCA_TERMINAL_HANDLE: handle });

// verifiedPm confirms the caller via `orchestration run-current`; here that
// Orca call is replaced with a fake that reports the caller bound to the
// kickoff's own Run, exactly as the real CLI would once the PM is bound.
const pmIdentity = (fixture) => ({
  callerHandle: fixture.pmHandle,
  execute: async () => ({
    code: 0,
    timedOut: false,
    stdout: JSON.stringify({
      ok: true,
      result: { run: { id: fixture.entry.runId, coordinator_handle: fixture.pmHandle } },
    }),
    stderr: "",
  }),
});

async function objectAndResolve(fixture, { resultHead, evidencePath }) {
  await auditObjection(
    fixture.org,
    fixture.worktreeId,
    {
      checkpoint: "outcome",
      target: { type: "criterion", id: "c1" },
      kind: "gap",
      description: "criterion c1 does not look delivered",
      rebuttalRequested: "show where it is delivered",
      resultHead,
      repo: fixture.repo,
    },
    auditorEnv(fixture.auditorHandle),
  );
  const objectionId = readAudit(fixture.org, fixture.worktreeId)
    .checkpoints.outcome.objections.at(-1).id;
  const { recorded, audit } = await auditResponse(
    fixture.org,
    fixture.worktreeId,
    {
      checkpoint: "outcome",
      objectionId,
      argument: "c1 is delivered; see the cited evidence",
      evidenceRefs: [{ path: evidencePath, sha256: fileSha256(path.join(fixture.dir, evidencePath)) }],
    },
    pmIdentity(fixture),
  );
  assert.equal(recorded, true);
  const responseId = audit.checkpoints.outcome.responses.at(-1).id;
  await auditRuling(
    fixture.org,
    fixture.worktreeId,
    {
      checkpoint: "outcome",
      objectionId,
      respondedAgainst: responseId,
      verdict: "persuaded",
      reason: "evidence supports the claim",
    },
    auditorEnv(fixture.auditorHandle),
  );
  return objectionId;
}

test("outcome objection -> PM response -> persuaded ruling -> checked -> accept", async (t) => {
  const fixture = kickoff(t);
  const evidencePath = "evidence.txt";
  fs.writeFileSync(path.join(fixture.dir, evidencePath), "proof\n");

  await objectAndResolve(fixture, { resultHead: fixture.head, evidencePath });
  await auditChecked(
    fixture.org,
    fixture.worktreeId,
    "outcome",
    [
      { type: "statement", id: "s1" },
      { type: "criterion", id: "c1" },
    ],
    auditorEnv(fixture.auditorHandle),
  );
  const { accepted } = await auditAccept(
    fixture.org,
    fixture.worktreeId,
    "outcome",
    fixture.head,
    fixture.repo,
    auditorEnv(fixture.auditorHandle),
  );
  assert.equal(accepted, true);
  assert.equal(
    await hasValidAcceptance(fixture.org, fixture.worktreeId, "outcome", fixture.head, fixture.repo),
    true,
  );
});

test("hasValidAcceptance refuses once a cited response evidence file changes, same HEAD and fingerprint", async (t) => {
  const fixture = kickoff(t);
  const evidencePath = "evidence.txt";
  fs.writeFileSync(path.join(fixture.dir, evidencePath), "proof\n");

  await objectAndResolve(fixture, { resultHead: fixture.head, evidencePath });
  await auditChecked(
    fixture.org,
    fixture.worktreeId,
    "outcome",
    [
      { type: "statement", id: "s1" },
      { type: "criterion", id: "c1" },
    ],
    auditorEnv(fixture.auditorHandle),
  );
  await auditAccept(fixture.org, fixture.worktreeId, "outcome", fixture.head, fixture.repo, auditorEnv(fixture.auditorHandle));
  assert.equal(
    await hasValidAcceptance(fixture.org, fixture.worktreeId, "outcome", fixture.head, fixture.repo),
    true,
  );

  // Same HEAD, same ledger, same presentations: the binding does not move,
  // but the file the response cited no longer hashes to what was recorded.
  fs.writeFileSync(path.join(fixture.dir, evidencePath), "swapped\n");
  assert.equal(
    await hasValidAcceptance(fixture.org, fixture.worktreeId, "outcome", fixture.head, fixture.repo),
    false,
  );
});

test("hasValidAcceptance refuses once a new unresolved objection is raised after acceptance", async (t) => {
  const fixture = kickoff(t);
  const evidencePath = "evidence.txt";
  fs.writeFileSync(path.join(fixture.dir, evidencePath), "proof\n");

  await objectAndResolve(fixture, { resultHead: fixture.head, evidencePath });
  await auditChecked(
    fixture.org,
    fixture.worktreeId,
    "outcome",
    [
      { type: "statement", id: "s1" },
      { type: "criterion", id: "c1" },
    ],
    auditorEnv(fixture.auditorHandle),
  );
  await auditAccept(fixture.org, fixture.worktreeId, "outcome", fixture.head, fixture.repo, auditorEnv(fixture.auditorHandle));
  assert.equal(
    await hasValidAcceptance(fixture.org, fixture.worktreeId, "outcome", fixture.head, fixture.repo),
    true,
  );

  // A fresh objection, with no response or ruling yet, leaves the binding
  // untouched (auditObjection recomputes it, but nothing about the ledger,
  // result HEAD, or evidence changed) while the checkpoint substantively
  // regresses to unresolved.
  await auditObjection(
    fixture.org,
    fixture.worktreeId,
    {
      checkpoint: "outcome",
      target: { type: "statement", id: "s1" },
      kind: "mismatch",
      description: "a second look raises a new concern",
      rebuttalRequested: "address this too",
      resultHead: fixture.head,
      repo: fixture.repo,
    },
    auditorEnv(fixture.auditorHandle),
  );
  assert.equal(
    await hasValidAcceptance(fixture.org, fixture.worktreeId, "outcome", fixture.head, fixture.repo),
    false,
  );
});

test("path B: a presentation after acceptance invalidates it, and re-audit + re-accept succeeds without deadlock", async (t) => {
  const fixture = kickoff(t);
  const evidencePath = "evidence.txt";
  fs.writeFileSync(path.join(fixture.dir, evidencePath), "proof\n");

  await objectAndResolve(fixture, { resultHead: fixture.head, evidencePath });
  await auditChecked(
    fixture.org,
    fixture.worktreeId,
    "outcome",
    [
      { type: "statement", id: "s1" },
      { type: "criterion", id: "c1" },
    ],
    auditorEnv(fixture.auditorHandle),
  );
  await auditAccept(fixture.org, fixture.worktreeId, "outcome", fixture.head, fixture.repo, auditorEnv(fixture.auditorHandle));
  assert.equal(
    await hasValidAcceptance(fixture.org, fixture.worktreeId, "outcome", fixture.head, fixture.repo),
    true,
  );

  // A later presentation moves the outcome binding's evidenceFingerprint,
  // which invalidates the acceptance without any objection ever having been
  // withdrawn or re-raised.
  const presentationSource = path.join(fixture.dir, "presentation.txt");
  fs.writeFileSync(presentationSource, "shown to the user\n");
  await requirementsPresent(fixture.org, fixture.worktreeId, {
    criterionId: "c1",
    head: fixture.head,
    repo: fixture.repo,
    source: presentationSource,
    userQuote: "yes, that matches",
    outcome: "confirmed",
  });
  assert.equal(
    await hasValidAcceptance(fixture.org, fixture.worktreeId, "outcome", fixture.head, fixture.repo),
    false,
  );

  // Re-auditing (checked coverage still holds, the objection is still
  // persuaded on its latest response) and re-accepting must succeed — the
  // stale old acceptance must not itself block recording the new one.
  await auditChecked(
    fixture.org,
    fixture.worktreeId,
    "outcome",
    [
      { type: "statement", id: "s1" },
      { type: "criterion", id: "c1" },
    ],
    auditorEnv(fixture.auditorHandle),
  );
  const { accepted } = await auditAccept(
    fixture.org,
    fixture.worktreeId,
    "outcome",
    fixture.head,
    fixture.repo,
    auditorEnv(fixture.auditorHandle),
  );
  assert.equal(accepted, true);
  assert.equal(
    await hasValidAcceptance(fixture.org, fixture.worktreeId, "outcome", fixture.head, fixture.repo),
    true,
  );

  // The superseded acceptance is kept as history, not erased.
  const record = readAudit(fixture.org, fixture.worktreeId).checkpoints.outcome;
  assert.equal(record.acceptanceHistory.length, 1);
});

test("ruling history is preserved across a not-persuaded then a persuaded verdict on a stronger response", async (t) => {
  const fixture = kickoff(t);
  await auditObjection(
    fixture.org,
    fixture.worktreeId,
    {
      checkpoint: "outcome",
      target: { type: "criterion", id: "c1" },
      kind: "gap",
      description: "criterion c1 does not look delivered",
      rebuttalRequested: "show where it is delivered",
      resultHead: fixture.head,
      repo: fixture.repo,
    },
    auditorEnv(fixture.auditorHandle),
  );
  const objectionId = readAudit(fixture.org, fixture.worktreeId)
    .checkpoints.outcome.objections.at(-1).id;

  const weakEvidence = path.join(fixture.dir, "weak.txt");
  fs.writeFileSync(weakEvidence, "weak\n");
  const weakResponse = await auditResponse(
    fixture.org,
    fixture.worktreeId,
    {
      checkpoint: "outcome",
      objectionId,
      argument: "trust me",
      evidenceRefs: [{ path: "weak.txt", sha256: fileSha256(weakEvidence) }],
    },
    pmIdentity(fixture),
  );
  const weakResponseId = weakResponse.audit.checkpoints.outcome.responses.at(-1).id;
  await auditRuling(
    fixture.org,
    fixture.worktreeId,
    {
      checkpoint: "outcome",
      objectionId,
      respondedAgainst: weakResponseId,
      verdict: "not-persuaded",
      reason: "no real evidence cited",
    },
    auditorEnv(fixture.auditorHandle),
  );

  const strongEvidence = path.join(fixture.dir, "strong.txt");
  fs.writeFileSync(strongEvidence, "strong\n");
  const strongResponse = await auditResponse(
    fixture.org,
    fixture.worktreeId,
    {
      checkpoint: "outcome",
      objectionId,
      argument: "here is the actual delivered artifact",
      evidenceRefs: [{ path: "strong.txt", sha256: fileSha256(strongEvidence) }],
    },
    pmIdentity(fixture),
  );
  const strongResponseId = strongResponse.audit.checkpoints.outcome.responses.at(-1).id;
  await auditRuling(
    fixture.org,
    fixture.worktreeId,
    {
      checkpoint: "outcome",
      objectionId,
      respondedAgainst: strongResponseId,
      verdict: "persuaded",
      reason: "the artifact matches",
    },
    auditorEnv(fixture.auditorHandle),
  );

  const record = readAudit(fixture.org, fixture.worktreeId).checkpoints.outcome;
  assert.equal(record.rulings.length, 2);
  assert.equal(record.rulings[0].verdict, "not-persuaded");
  assert.equal(record.rulings[1].verdict, "persuaded");
});

test("auditAccept refuses a resultHead that does not match the workspace's actual Git HEAD", async (t) => {
  const fixture = kickoff(t);
  const evidencePath = "evidence.txt";
  fs.writeFileSync(path.join(fixture.dir, evidencePath), "proof\n");

  await objectAndResolve(fixture, { resultHead: fixture.head, evidencePath });
  await auditChecked(
    fixture.org,
    fixture.worktreeId,
    "outcome",
    [
      { type: "statement", id: "s1" },
      { type: "criterion", id: "c1" },
    ],
    auditorEnv(fixture.auditorHandle),
  );

  await assert.rejects(
    auditAccept(fixture.org, fixture.worktreeId, "outcome", FORGED_HEAD, fixture.repo, auditorEnv(fixture.auditorHandle)),
    /does not match the actual Git HEAD/,
  );
});

test("hasValidAcceptance returns false, without throwing, once the declared resultHead no longer matches the actual Git HEAD", async (t) => {
  const fixture = kickoff(t);
  const evidencePath = "evidence.txt";
  fs.writeFileSync(path.join(fixture.dir, evidencePath), "proof\n");

  await objectAndResolve(fixture, { resultHead: fixture.head, evidencePath });
  await auditChecked(
    fixture.org,
    fixture.worktreeId,
    "outcome",
    [
      { type: "statement", id: "s1" },
      { type: "criterion", id: "c1" },
    ],
    auditorEnv(fixture.auditorHandle),
  );
  await auditAccept(fixture.org, fixture.worktreeId, "outcome", fixture.head, fixture.repo, auditorEnv(fixture.auditorHandle));
  assert.equal(
    await hasValidAcceptance(fixture.org, fixture.worktreeId, "outcome", fixture.head, fixture.repo),
    true,
  );

  // A caller asking about a HEAD other than what the repo is actually at
  // (stale claim, or a forged one) must be told the acceptance does not hold
  // for it — a plain `false`, never a thrown error.
  assert.equal(
    await hasValidAcceptance(fixture.org, fixture.worktreeId, "outcome", FORGED_HEAD, fixture.repo),
    false,
  );
});

test("requirementsPresent refuses a declared head that does not match the workspace's actual Git HEAD", async (t) => {
  const fixture = kickoff(t);
  const presentationSource = path.join(fixture.dir, "presentation.txt");
  fs.writeFileSync(presentationSource, "shown to the user\n");

  await assert.rejects(
    requirementsPresent(fixture.org, fixture.worktreeId, {
      criterionId: "c1",
      head: FORGED_HEAD,
      repo: fixture.repo,
      source: presentationSource,
      userQuote: "yes, that matches",
      outcome: "confirmed",
    }),
    /does not match the actual Git HEAD/,
  );
});
