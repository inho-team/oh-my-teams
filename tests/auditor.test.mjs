/** Auditor checkpoints: objection/response/ruling records and acceptance gates. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUDITOR_ROLE,
  fileSha256,
  readJSON,
  writeJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  bindKickoffRun,
  isIdenticalDirectory,
  isSameOrWithin,
  isSameOrWithinByIdentity,
  kickoffAuditPolicyRetrofit,
  kickoffEntryName,
  listKickoffs,
  registerKickoff,
  registryDirectory,
  releaseKickoff,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";
import {
  readLaunches,
  recordLaunch,
} from "../plugins/oh-my-teams/scripts/usage-ledger.mjs";
import {
  assertKickoffCloseReady,
  requirementsFidelity,
  requirementsFidelityConfirm,
  requirementsPresent,
} from "../plugins/oh-my-teams/scripts/requirements.mjs";
import { minimalRequirements } from "./requirements-draft-fixture.mjs";
import {
  auditAccept,
  auditChecked,
  auditObjection,
  auditResponse,
  auditRuling,
  hasValidAcceptance,
  isPmBoundToRun,
  readAudit,
  verifiedPm,
} from "../plugins/oh-my-teams/scripts/audit.mjs";
import { acceptOutcome } from "../plugins/oh-my-teams/scripts/gates.mjs";
import { createWorkflow } from "../plugins/oh-my-teams/scripts/workflow.mjs";
import { verify } from "../plugins/oh-my-teams/scripts/evidence.mjs";
import { taskHash } from "../plugins/oh-my-teams/scripts/contracts.mjs";
import {
  createRoleWorktree,
  main,
  resolveAuditorLaunchExecution,
} from "../plugins/oh-my-teams/scripts/teams-org.mjs";
import {
  createWorktreeWithRoleSession,
  TRUSTED_ORCA_EXECUTABLE_PLACEHOLDER,
} from "../plugins/oh-my-teams/scripts/orca-adapter.mjs";
import { deliverKickoff } from "../plugins/oh-my-teams/scripts/delivery.mjs";

const exampleOrg = new URL(
  "../plugins/oh-my-teams/examples/organization.json",
  import.meta.url,
);

// A plausible-looking commit id that is guaranteed not to be any fixture's
// actual HEAD, for the forged/stale-head counterexamples below.
const FORGED_HEAD = "0".repeat(40);

const cli = path.resolve("plugins/oh-my-teams/scripts/teams-org.mjs");

// Runs the teams-org CLI as a real child process (never `run-use`), returning
// its exit code and streams instead of throwing, so a rejection test can
// assert on the exact message the CLI printed to stderr. `env` merges onto
// the child's own environment (not replaces it); a `null` value in `env`
// deletes that key instead of setting it, which is how a test clears this
// session's own inherited ORCA_TERMINAL_HANDLE to exercise the no-handle
// rejection path.
function runCli(args, { cwd, env } = {}) {
  const merged = { ...process.env, ...env };
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === null) delete merged[key];
  }
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      stdio: "pipe",
      encoding: "utf-8",
      cwd,
      env: merged,
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
function kickoff(t, worktreeId = "wt-1", { auditor } = {}) {
  // realpath'd: on macOS os.tmpdir() sits under a /var -> /private/var
  // symlink, and process.chdir() reports the resolved path, so an
  // un-resolved dir would never equal process.cwd() in a director-authority
  // check.
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "omt-audit-")),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const head = initRepo(dir);
  const org = path.join(dir, ".omt", "organization.json");
  fs.mkdirSync(path.dirname(org), { recursive: true });
  fs.copyFileSync(exampleOrg, org);
  // D1: registerKickoff pins auditPolicy from organizationAtClaim.auditor at
  // claim time (kickoff-registry.mjs), with no later live-organization.json
  // fallback, so a caller wanting an audited kickoff must set org.auditor
  // here, before registerKickoff runs below, not by mutating the org file
  // afterward.
  if (auditor !== undefined) {
    const orgConfig = readJSON(org);
    orgConfig.auditor = auditor;
    writeJSON(org, orgConfig);
  }
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
    requirements: minimalRequirements(org, worktreeId),
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
  return {
    dir,
    repo: dir,
    head,
    org,
    brief,
    worktreeId,
    entry,
    auditorHandle,
    pmHandle,
  };
}

// A kickoff shaped exactly like `kickoff()` above (real ledger, requirements
// and, unless `director: false` is passed, a registered director), but with
// its D1 auditPolicy stripped back off right after registration, the way an
// entry registered before this feature existed reads today. This is the
// fixture kickoffAuditPolicyRetrofit's own counterexamples below need: a
// legacy entry with entry.auditPolicy === undefined, and, when
// `auditorLaunch` is true, a recorded auditor-role launch for it (the
// launch-ledger evidence a false auditorConfigured statement must be
// refused against).
function legacyKickoff(
  t,
  worktreeId = "wt-legacy",
  { auditorLaunch = false, director = true } = {},
) {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "omt-audit-legacy-")),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const head = initRepo(dir);
  const org = path.join(dir, ".omt", "organization.json");
  fs.mkdirSync(path.dirname(org), { recursive: true });
  fs.copyFileSync(exampleOrg, org);
  const brief = path.join(dir, "brief.md");
  fs.writeFileSync(brief, "goal, acceptance criteria, non-goals\n");
  const pm = path.join(dir, worktreeId);
  const auditorHandle = `term_auditor_${worktreeId}`;
  // validateLedgerForClaim requires director.checkoutPath unconditionally
  // whenever a claim carries a requirements ledger (a pre-ledger, no-director
  // kickoff is out of scope for registerKickoff itself), so a `director:
  // false` fixture still registers with one and strips it back off the entry
  // afterward, the same way auditPolicy is stripped below.
  registerKickoff(org, {
    goal: `deliver ${worktreeId}`,
    pm: { worktreeId, path: pm, stateDir: path.join(pm, ".omt") },
    organizationRevision: readJSON(org).revision,
    brief,
    delivery: { mode: "none" },
    requirements: minimalRequirements(org, worktreeId),
    director: { terminalHandle: "term_director_1", checkoutPath: dir },
  });
  const entryPath = path.join(
    registryDirectory(org),
    `${kickoffEntryName(worktreeId)}.json`,
  );
  const legacyEntry = readJSON(entryPath);
  delete legacyEntry.auditPolicy;
  if (!director) delete legacyEntry.director;
  writeJSON(entryPath, legacyEntry);
  bindKickoffRun(org, { worktreeId, runId: "run-1" });
  const [entry] = listKickoffs(org, worktreeId).kickoffs;
  if (auditorLaunch) {
    recordLaunch(org, {
      via: "role-terminal",
      role: AUDITOR_ROLE,
      terminal: auditorHandle,
      stateDir: entry.pm.stateDir,
    });
  }
  return { dir, repo: dir, head, org, brief, worktreeId, entry, auditorHandle };
}

// audit.mjs's verifiedAuditor/verifiedPm read ORCA_TERMINAL_HANDLE only from
// the real process environment now (B.6, decision B): no exported function
// takes an env-override argument any more, so a test that needs to act as a
// given handle must actually set process.env for the duration of the call,
// then restore whatever was there before (including "unset", via delete)
// once it returns or throws.
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

// verifiedDirector reads process.cwd() directly now, with no callerCwd
// override (B.6, decision B), so a test exercising the brief checkpoint's
// auditResponse from a specific directory must actually chdir there for the
// duration of the call and restore the original cwd afterward.
async function withCwd(dir, fn) {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

// verifiedPm now confirms the caller only through runTrustedOrcaJson, which
// takes no injectable executable/execute/factory (B.6, decision B): no test
// fixture can stand in for a real trusted Orca install any more. Exercising
// the outcome checkpoint's later stages (ruling/checked/accept/
// hasValidAcceptance) does not need that identity check to actually run —
// only a response record shaped the way auditResponse would have written it.
// This helper reproduces auditFile's own path (same worktreeId -> sha256
// digest) and appends a response the same way auditResponse's outcome branch
// does, skipping straight past verifiedPm. It proves nothing about identity
// confirmation itself; that is covered separately by the isPmBoundToRun
// fixture tests and the ORCA_TERMINAL_HANDLE-absent rejection test below, and
// verifiedPm's real success path is confirmed manually (B.6 decision B, item c).
function auditFilePath(orgFile, worktreeId) {
  const digest = crypto.createHash("sha256").update(worktreeId).digest("hex");
  return path.join(
    path.dirname(path.resolve(orgFile)),
    "audits",
    `${digest}.json`,
  );
}

function recordOutcomeResponseDirectly(
  fixture,
  { objectionId, argument, evidenceRefs },
) {
  const audit = readAudit(fixture.org, fixture.worktreeId);
  const record = audit.checkpoints.outcome;
  const response = {
    id: crypto.randomUUID(),
    objectionId,
    argument,
    evidenceRefs,
    respondedAt: new Date().toISOString(),
  };
  record.responses = [...record.responses, response];
  writeJSON(auditFilePath(fixture.org, fixture.worktreeId), audit);
  return { recorded: true, audit, response };
}

async function objectAndResolve(fixture, { resultHead, evidencePath }) {
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditObjection(fixture.org, fixture.worktreeId, {
      checkpoint: "outcome",
      target: { type: "criterion", id: "c1" },
      kind: "gap",
      description: "criterion c1 does not look delivered",
      rebuttalRequested: "show where it is delivered",
      resultHead,
      repo: fixture.repo,
    }),
  );
  const objectionId = readAudit(
    fixture.org,
    fixture.worktreeId,
  ).checkpoints.outcome.objections.at(-1).id;
  const { recorded, audit } = recordOutcomeResponseDirectly(fixture, {
    objectionId,
    argument: "c1 is delivered; see the cited evidence",
    evidenceRefs: [
      {
        path: evidencePath,
        sha256: fileSha256(path.join(fixture.dir, evidencePath)),
      },
    ],
  });
  assert.equal(recorded, true);
  const responseId = audit.checkpoints.outcome.responses.at(-1).id;
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditRuling(fixture.org, fixture.worktreeId, {
      checkpoint: "outcome",
      objectionId,
      respondedAgainst: responseId,
      verdict: "persuaded",
      reason: "evidence supports the claim",
    }),
  );
  return objectionId;
}

test("outcome objection -> PM response -> persuaded ruling -> checked -> accept", async (t) => {
  const fixture = kickoff(t);
  const evidencePath = "evidence.txt";
  fs.writeFileSync(path.join(fixture.dir, evidencePath), "proof\n");

  await objectAndResolve(fixture, { resultHead: fixture.head, evidencePath });
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditChecked(fixture.org, fixture.worktreeId, "outcome", [
      { type: "statement", id: "s1" },
      { type: "criterion", id: "c1" },
    ]),
  );
  const { accepted } = await withOrcaHandle(fixture.auditorHandle, () =>
    auditAccept(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      fixture.head,
      fixture.repo,
    ),
  );
  assert.equal(accepted, true);
  assert.equal(
    await hasValidAcceptance(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      fixture.head,
      fixture.repo,
    ),
    true,
  );
});

test("hasValidAcceptance refuses once a cited response evidence file changes, same HEAD and fingerprint", async (t) => {
  const fixture = kickoff(t);
  const evidencePath = "evidence.txt";
  fs.writeFileSync(path.join(fixture.dir, evidencePath), "proof\n");

  await objectAndResolve(fixture, { resultHead: fixture.head, evidencePath });
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditChecked(fixture.org, fixture.worktreeId, "outcome", [
      { type: "statement", id: "s1" },
      { type: "criterion", id: "c1" },
    ]),
  );
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditAccept(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      fixture.head,
      fixture.repo,
    ),
  );
  assert.equal(
    await hasValidAcceptance(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      fixture.head,
      fixture.repo,
    ),
    true,
  );

  // Same HEAD, same ledger, same presentations: the binding does not move,
  // but the file the response cited no longer hashes to what was recorded.
  fs.writeFileSync(path.join(fixture.dir, evidencePath), "swapped\n");
  assert.equal(
    await hasValidAcceptance(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      fixture.head,
      fixture.repo,
    ),
    false,
  );
});

test("hasValidAcceptance refuses once a new unresolved objection is raised after acceptance", async (t) => {
  const fixture = kickoff(t);
  const evidencePath = "evidence.txt";
  fs.writeFileSync(path.join(fixture.dir, evidencePath), "proof\n");

  await objectAndResolve(fixture, { resultHead: fixture.head, evidencePath });
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditChecked(fixture.org, fixture.worktreeId, "outcome", [
      { type: "statement", id: "s1" },
      { type: "criterion", id: "c1" },
    ]),
  );
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditAccept(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      fixture.head,
      fixture.repo,
    ),
  );
  assert.equal(
    await hasValidAcceptance(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      fixture.head,
      fixture.repo,
    ),
    true,
  );

  // A fresh objection, with no response or ruling yet, leaves the binding
  // untouched (auditObjection recomputes it, but nothing about the ledger,
  // result HEAD, or evidence changed) while the checkpoint substantively
  // regresses to unresolved.
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditObjection(fixture.org, fixture.worktreeId, {
      checkpoint: "outcome",
      target: { type: "statement", id: "s1" },
      kind: "mismatch",
      description: "a second look raises a new concern",
      rebuttalRequested: "address this too",
      resultHead: fixture.head,
      repo: fixture.repo,
    }),
  );
  assert.equal(
    await hasValidAcceptance(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      fixture.head,
      fixture.repo,
    ),
    false,
  );
});

test("path B: a presentation after acceptance invalidates it, and re-audit + re-accept succeeds without deadlock", async (t) => {
  const fixture = kickoff(t);
  const evidencePath = "evidence.txt";
  fs.writeFileSync(path.join(fixture.dir, evidencePath), "proof\n");

  await objectAndResolve(fixture, { resultHead: fixture.head, evidencePath });
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditChecked(fixture.org, fixture.worktreeId, "outcome", [
      { type: "statement", id: "s1" },
      { type: "criterion", id: "c1" },
    ]),
  );
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditAccept(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      fixture.head,
      fixture.repo,
    ),
  );
  assert.equal(
    await hasValidAcceptance(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      fixture.head,
      fixture.repo,
    ),
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
    channel: "chat",
    location: "outcome re-presentation",
    userQuote: "yes, that matches",
    outcome: "confirmed",
    callerCwd: fixture.dir,
  });
  assert.equal(
    await hasValidAcceptance(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      fixture.head,
      fixture.repo,
    ),
    false,
  );

  // Re-auditing (checked coverage still holds, the objection is still
  // persuaded on its latest response) and re-accepting must succeed — the
  // stale old acceptance must not itself block recording the new one.
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditChecked(fixture.org, fixture.worktreeId, "outcome", [
      { type: "statement", id: "s1" },
      { type: "criterion", id: "c1" },
    ]),
  );
  const { accepted } = await withOrcaHandle(fixture.auditorHandle, () =>
    auditAccept(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      fixture.head,
      fixture.repo,
    ),
  );
  assert.equal(accepted, true);
  assert.equal(
    await hasValidAcceptance(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      fixture.head,
      fixture.repo,
    ),
    true,
  );

  // The superseded acceptance is kept as history, not erased.
  const record = readAudit(fixture.org, fixture.worktreeId).checkpoints.outcome;
  assert.equal(record.acceptanceHistory.length, 1);
});

test("ruling history is preserved across a not-persuaded then a persuaded verdict on a stronger response", async (t) => {
  const fixture = kickoff(t);
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditObjection(fixture.org, fixture.worktreeId, {
      checkpoint: "outcome",
      target: { type: "criterion", id: "c1" },
      kind: "gap",
      description: "criterion c1 does not look delivered",
      rebuttalRequested: "show where it is delivered",
      resultHead: fixture.head,
      repo: fixture.repo,
    }),
  );
  const objectionId = readAudit(
    fixture.org,
    fixture.worktreeId,
  ).checkpoints.outcome.objections.at(-1).id;

  const weakEvidence = path.join(fixture.dir, "weak.txt");
  fs.writeFileSync(weakEvidence, "weak\n");
  const weakResponse = recordOutcomeResponseDirectly(fixture, {
    objectionId,
    argument: "trust me",
    evidenceRefs: [{ path: "weak.txt", sha256: fileSha256(weakEvidence) }],
  });
  const weakResponseId =
    weakResponse.audit.checkpoints.outcome.responses.at(-1).id;
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditRuling(fixture.org, fixture.worktreeId, {
      checkpoint: "outcome",
      objectionId,
      respondedAgainst: weakResponseId,
      verdict: "not-persuaded",
      reason: "no real evidence cited",
    }),
  );

  const strongEvidence = path.join(fixture.dir, "strong.txt");
  fs.writeFileSync(strongEvidence, "strong\n");
  const strongResponse = recordOutcomeResponseDirectly(fixture, {
    objectionId,
    argument: "here is the actual delivered artifact",
    evidenceRefs: [{ path: "strong.txt", sha256: fileSha256(strongEvidence) }],
  });
  const strongResponseId =
    strongResponse.audit.checkpoints.outcome.responses.at(-1).id;
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditRuling(fixture.org, fixture.worktreeId, {
      checkpoint: "outcome",
      objectionId,
      respondedAgainst: strongResponseId,
      verdict: "persuaded",
      reason: "the artifact matches",
    }),
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
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditChecked(fixture.org, fixture.worktreeId, "outcome", [
      { type: "statement", id: "s1" },
      { type: "criterion", id: "c1" },
    ]),
  );

  await assert.rejects(
    withOrcaHandle(fixture.auditorHandle, () =>
      auditAccept(
        fixture.org,
        fixture.worktreeId,
        "outcome",
        FORGED_HEAD,
        fixture.repo,
      ),
    ),
    /does not match the actual Git HEAD/,
  );
});

test("hasValidAcceptance returns false, without throwing, once the declared resultHead no longer matches the actual Git HEAD", async (t) => {
  const fixture = kickoff(t);
  const evidencePath = "evidence.txt";
  fs.writeFileSync(path.join(fixture.dir, evidencePath), "proof\n");

  await objectAndResolve(fixture, { resultHead: fixture.head, evidencePath });
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditChecked(fixture.org, fixture.worktreeId, "outcome", [
      { type: "statement", id: "s1" },
      { type: "criterion", id: "c1" },
    ]),
  );
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditAccept(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      fixture.head,
      fixture.repo,
    ),
  );
  assert.equal(
    await hasValidAcceptance(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      fixture.head,
      fixture.repo,
    ),
    true,
  );

  // A caller asking about a HEAD other than what the repo is actually at
  // (stale claim, or a forged one) must be told the acceptance does not hold
  // for it — a plain `false`, never a thrown error.
  assert.equal(
    await hasValidAcceptance(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      FORGED_HEAD,
      fixture.repo,
    ),
    false,
  );
});

test(
  "hasValidAcceptance returns false once the workspace's actual Git HEAD moves past the accepted resultHead, " +
    "even when the caller re-declares that same resultHead",
  async (t) => {
    const fixture = kickoff(t);
    const evidencePath = "evidence.txt";
    fs.writeFileSync(path.join(fixture.dir, evidencePath), "proof\n");

    await objectAndResolve(fixture, { resultHead: fixture.head, evidencePath });
    await withOrcaHandle(fixture.auditorHandle, () =>
      auditChecked(fixture.org, fixture.worktreeId, "outcome", [
        { type: "statement", id: "s1" },
        { type: "criterion", id: "c1" },
      ]),
    );
    await withOrcaHandle(fixture.auditorHandle, () =>
      auditAccept(
        fixture.org,
        fixture.worktreeId,
        "outcome",
        fixture.head,
        fixture.repo,
      ),
    );
    assert.equal(
      await hasValidAcceptance(
        fixture.org,
        fixture.worktreeId,
        "outcome",
        fixture.head,
        fixture.repo,
      ),
      true,
    );

    // A new commit lands after acceptance. The ledger, the declared resultHead
    // argument, and the evidence backing the binding are all unchanged, so a
    // stored `acceptance.boundHash` comparison alone cannot tell this case
    // apart from a still-valid acceptance — only comparing the declared
    // resultHead against the workspace's actual *current* HEAD catches a
    // caller re-declaring an old, no-longer-current resultHead to keep
    // reusing a stale acceptance.
    fs.writeFileSync(path.join(fixture.dir, "later.txt"), "later work\n");
    git(fixture.dir, ["add", "-A"]);
    git(fixture.dir, ["commit", "-q", "-m", "later work"]);

    assert.equal(
      await hasValidAcceptance(
        fixture.org,
        fixture.worktreeId,
        "outcome",
        fixture.head,
        fixture.repo,
      ),
      false,
    );
  },
);

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
      channel: "chat",
      location: "outcome presentation",
      userQuote: "yes, that matches",
      outcome: "confirmed",
    }),
    /does not match the actual Git HEAD/,
  );
});

// No review requirements at all: `review-complete` reaches `not-required`
// straight from a single passing check, isolating the new B.5 objection gate
// from the unrelated independent-review gate this file does not exercise.
function gapTask(worktreeId) {
  return {
    schemaVersion: 2,
    revision: 1,
    kind: "edit",
    id: `accept-gap-${worktreeId}`,
    goal: `deliver ${worktreeId}`,
    instruction: "no-op",
    nonGoals: [],
    constraints: [],
    files: ["README.md"],
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

test("accept refuses while the outcome audit checkpoint has an unresolved objection, and succeeds once ruled persuaded", async (t) => {
  const fixture = kickoff(t);
  // Top-level `.omt/`, not the kickoff's own PM state dir: `changedWorkspaceFiles`
  // only excludes a repo-root `.omt/`, so gate/evidence bookkeeping must live
  // there too or verify() would see its own writes as workspace drift.
  const stateDir = path.join(fixture.dir, ".omt");
  const task = gapTask(fixture.worktreeId);
  // Written before the first verify() call so the workspace tree the report's
  // evidence binds to already includes it; writing it later, between the two
  // acceptOutcome calls below, would make the second one see stale evidence.
  const evidencePath = "evidence.txt";
  fs.writeFileSync(path.join(fixture.dir, evidencePath), "proof\n");
  const options = {
    baseRef: task.baseRef,
    commands: task.checks,
    environment: task.environment,
    store: path.join(stateDir, "evidence"),
  };
  const report = {
    taskId: task.id,
    taskHash: taskHash(task),
    taskRevision: task.revision,
    runId: "gap-4-run",
    evidence: await verify(fixture.repo, options),
  };
  const decision = {
    schemaVersion: 1,
    id: "accept-gap-4",
    decider: { kind: "pm", executionId: "pm-1" },
    criteria: ["check"],
    basis: "Check passed",
  };

  await withOrcaHandle(fixture.auditorHandle, () =>
    auditObjection(fixture.org, fixture.worktreeId, {
      checkpoint: "outcome",
      target: { type: "criterion", id: "c1" },
      kind: "gap",
      description: "criterion c1 does not look delivered",
      rebuttalRequested: "show where it is delivered",
      resultHead: fixture.head,
      repo: fixture.repo,
    }),
  );

  await assert.rejects(
    () =>
      acceptOutcome(fixture.repo, task, report, decision, stateDir, {
        orgFile: fixture.org,
        worktreeId: fixture.worktreeId,
      }),
    /outcome audit checkpoint has an unresolved objection/,
  );

  const objectionId = readAudit(
    fixture.org,
    fixture.worktreeId,
  ).checkpoints.outcome.objections.at(-1).id;
  const { audit } = recordOutcomeResponseDirectly(fixture, {
    objectionId,
    argument: "c1 is delivered; see the cited evidence",
    evidenceRefs: [
      {
        path: evidencePath,
        sha256: fileSha256(path.join(fixture.dir, evidencePath)),
      },
    ],
  });
  const responseId = audit.checkpoints.outcome.responses.at(-1).id;
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditRuling(fixture.org, fixture.worktreeId, {
      checkpoint: "outcome",
      objectionId,
      respondedAgainst: responseId,
      verdict: "persuaded",
      reason: "evidence supports the claim",
    }),
  );

  const { decision: recorded } = await acceptOutcome(
    fixture.repo,
    task,
    report,
    decision,
    stateDir,
    { orgFile: fixture.org, worktreeId: fixture.worktreeId },
  );
  assert.equal(recorded.status, "accepted");
});

test("worker-start refuses to assign under an audited kickoff before the brief audit is accepted, and proceeds once it is", async (t) => {
  const fixture = kickoff(t, "wt-1", {
    auditor: { profile: "claude-current" },
  });
  fs.mkdirSync(fixture.entry.pm.path, { recursive: true });

  const missingOrca = path.join(fixture.dir, "missing-orca");
  const workerStart = () =>
    main([
      "worker-start",
      "--repo",
      fixture.entry.pm.path,
      "--org",
      fixture.org,
      "--role",
      "senior",
      "--spec",
      "x",
      "--terminal",
      "term_worker_1",
      "--orca",
      missingOrca,
    ]);

  await assert.rejects(workerStart, /no valid brief-audit acceptance yet/);

  await withOrcaHandle(fixture.auditorHandle, () =>
    auditChecked(fixture.org, fixture.worktreeId, "brief", [
      { type: "statement", id: "s1" },
      { type: "criterion", id: "c1" },
    ]),
  );
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditAccept(fixture.org, fixture.worktreeId, "brief", undefined, undefined),
  );

  // The audit gate opened; what stops the launch now is the same missing-Orca
  // executable failure any worker-start hits once it actually tries to spawn
  // a worker, proving execution reached past the new brief-audit gate.
  await assert.rejects(workerStart, /Selected Orca executable failed/);
});

test("director-signal refuses a close-ready under an audited kickoff before the outcome audit is accepted, and proceeds once it is", async (t) => {
  const fixture = kickoff(t, "wt-1", {
    auditor: { profile: "claude-current" },
  });

  const signalClose = () =>
    main([
      "director-signal",
      "--org",
      fixture.org,
      "--worktree",
      fixture.worktreeId,
      "--kind",
      "close-ready",
      "--text",
      "ready to close",
      "--head",
      fixture.head,
      "--source",
      fixture.repo,
    ]);

  await assert.rejects(signalClose, /valid outcome-audit acceptance/);

  await withOrcaHandle(fixture.auditorHandle, () =>
    auditChecked(fixture.org, fixture.worktreeId, "outcome", [
      { type: "statement", id: "s1" },
      { type: "criterion", id: "c1" },
    ]),
  );
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditAccept(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      fixture.head,
      fixture.repo,
    ),
  );

  // The audit gate opened; main() prints its JSON result instead of returning
  // it, so reaching here without a rejection is what proves the gate passed.
  await assert.doesNotReject(signalClose);
});

test(
  "worker-start (D2): binds a child worktree to its kickoff only by PM-path containment or a matching " +
    "--terminal ledger line, never by --state alone, and leaves an org with no registered kickoff unaffected",
  async (t) => {
    const fixture = kickoff(t, "wt-1", {
      auditor: { profile: "claude-current" },
    });
    // Only rule 4's mismatch check further below reads --state at all, and
    // its identity comparison runs fs.realpathSync.native on both sides, so
    // this, the directory it names as the bound kickoff's own stateDir, must
    // actually exist on disk.
    fs.mkdirSync(fixture.entry.pm.stateDir, { recursive: true });

    const childDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "omt-audit-d2-child-"),
    );
    t.after(() => fs.rmSync(childDir, { recursive: true, force: true }));

    const missingOrca = path.join(fixture.dir, "missing-orca");
    const workerStart = (extraArgs) =>
      main([
        "worker-start",
        "--repo",
        childDir,
        "--org",
        fixture.org,
        "--role",
        "senior",
        "--spec",
        "x",
        "--orca",
        missingOrca,
        ...extraArgs,
      ]);

    // (1) 신규 child 무기록 거부: no launch line has ever named this worktree
    // under this --terminal, so it cannot be tied to any registered kickoff
    // (director decision msg_c9d1afb03fd4, rule 3).
    await assert.rejects(
      () => workerStart(["--terminal", "term_never_recorded"]),
      /cannot be tied to any registered kickoff/,
    );

    // Simulates the launch line role-worktree-create's own role-terminal call
    // would have recorded when it first opened this child (that internal
    // call, and the terminal handle it assigns, are exercised directly by the
    // "role-terminal --role auditor" tests above; only its recorded shape
    // matters to startSupervisedWorker's own gate, which is what is under
    // test here).
    recordLaunch(fixture.org, {
      via: "role-terminal",
      role: "senior",
      terminal: "term_child_1",
      stateDir: fixture.entry.pm.stateDir,
      worktreePath: childDir,
      callerCwd: childDir,
    });

    // (2) role-worktree-create 정상 첫 child 통과(감사 gate 적용): the exact
    // --terminal that launch line recorded now resolves this worktree to the
    // kickoff, and the brief-audit gate applies to it exactly as it does for
    // a launch straight from the PM worktree (see the worker-start test
    // above this one).
    await assert.rejects(
      () => workerStart(["--terminal", "term_child_1"]),
      /no valid brief-audit acceptance yet/,
    );

    // (3) 기존 연결 child 유지: a second worker-start against the same,
    // already-bound child (same --terminal) resolves the same way, not
    // "cannot be tied" -- the binding is not a one-shot fluke of the first
    // call consuming something.
    await assert.rejects(
      () => workerStart(["--terminal", "term_child_1"]),
      /no valid brief-audit acceptance yet/,
    );

    // 부모 target과 자식 과거 launch가 결속되지 않고 거부되는 경우: a past
    // launch's own recorded worktreePath sits NESTED inside this call's
    // target, not the other way around. identicalOrWithin's parameters are
    // (parent=recorded worktreePath, child=target), so this correctly
    // refuses -- the reversed direction would have wrongly let a caller name
    // any broad ancestor directory as --worktree and inherit whatever
    // unrelated launch's worktreePath happened to sit somewhere underneath it.
    const nestedChildDir = path.join(childDir, "nested", "deep");
    fs.mkdirSync(nestedChildDir, { recursive: true });
    recordLaunch(fixture.org, {
      via: "role-terminal",
      role: "senior",
      terminal: "term_nested_only",
      stateDir: fixture.entry.pm.stateDir,
      worktreePath: nestedChildDir,
      callerCwd: nestedChildDir,
    });
    await assert.rejects(
      () => workerStart(["--terminal", "term_nested_only"]),
      /cannot be tied to any registered kickoff/,
    );

    // 같은 terminal의 worker-start 줄만 있고 role-terminal 줄이 없는 경우
    // 거부: only a via:"worker-start" line names this worktree and terminal.
    // Its own kickoffPmWorktreeId came from recordLaunch's separate,
    // --state/callerCwd-based lookup (usage-ledger.mjs's own
    // resolveLaunchKickoff), not from a validated role-terminal call, so it
    // must not count as binding evidence either.
    const workerOnlyDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "omt-audit-d2-workeronly-"),
    );
    t.after(() => fs.rmSync(workerOnlyDir, { recursive: true, force: true }));
    recordLaunch(fixture.org, {
      via: "worker-start",
      role: "senior",
      terminal: "term_worker_only",
      stateDir: fixture.entry.pm.stateDir,
      worktreePath: workerOnlyDir,
      callerCwd: workerOnlyDir,
    });
    await assert.rejects(
      () =>
        main([
          "worker-start",
          "--repo",
          workerOnlyDir,
          "--org",
          fixture.org,
          "--role",
          "senior",
          "--spec",
          "x",
          "--terminal",
          "term_worker_only",
          "--orca",
          missingOrca,
        ]),
      /cannot be tied to any registered kickoff/,
    );

    // 다른 kickoff의 --state 지정 거부 (rule 4): this worktree is bound (by
    // terminal) to the first kickoff; naming a second, real kickoff's --state
    // must still be refused, not silently accepted as if --state alone were
    // authoritative over the binding term_child_1 already established.
    // launchContext itself requires a genuine, readable workflow snapshot
    // for any --state it is given (it pairs --state with --workflow-id and
    // calls readWorkflow), so exercising this rule via the real CLI needs an
    // actual workflow created with createWorkflow, not just a bare directory.
    const other = secondKickoff(fixture, "wt-d2-other");
    t.after(() => fs.rmSync(other.dir, { recursive: true, force: true }));
    initRepo(other.dir);
    writeJSON(path.join(other.dir, "a.json"), {
      schemaVersion: 2,
      revision: 1,
      kind: "edit",
      id: "a",
      goal: "noop",
      instruction: "noop",
      nonGoals: [],
      constraints: [],
      files: ["x.txt"],
      checks: [[process.execPath, "-e", "process.exit(0)"]],
      acceptance: [
        {
          id: "check",
          description: "check",
          method: "check",
          checkIndexes: [0],
        },
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
    await createWorkflow(
      other.entry.pm.stateDir,
      {
        schemaVersion: 1,
        id: "wf-d2-other",
        goal: "unrelated kickoff's own workflow",
        repo: ".",
        tasks: [{ file: "a.json", role: "senior" }],
        policy: { maxRunning: 1, maxReviewPending: 1 },
        budget: { maxAttempts: 1, maxCalls: 4 },
      },
      readJSON(fixture.org),
      other.dir,
    );
    await assert.rejects(
      () =>
        workerStart([
          "--terminal",
          "term_child_1",
          "--workflow-id",
          "wf-d2-other",
          "--state",
          other.entry.pm.stateDir,
        ]),
      /does not name the kickoff/,
    );

    // (5) A path match alone, from a *different* --terminal that never
    // recorded anything against this worktree, is not trusted either: rule
    // 2 requires the ledger line's own terminal to match this call's
    // --terminal exactly, so this is refused the same way as (1), not
    // silently reusing term_child_1's binding.
    await assert.rejects(
      () => workerStart(["--terminal", "term_impersonator"]),
      /cannot be tied to any registered kickoff/,
    );

    // 같은 경로를 다른 kickoff가 재사용하고 새 세션이 ledgerError일 때 옛 줄로
    // 결속되지 않고 거부: term_child_1's own line is still the only one this
    // worktree ever recorded. A brand-new session at the same path, under a
    // brand-new --terminal, whose own launch line never got written (the
    // ledgerError case -- rule 6, tested for its own surfaced status below)
    // looks identical, from this gate's point of view, to (1) and (5) above:
    // there is still no line naming ITS terminal, so it is refused the same
    // way rather than silently inheriting term_child_1's kickoff binding.
    await assert.rejects(
      () => workerStart(["--terminal", "term_ledgererror_session"]),
      /cannot be tied to any registered kickoff/,
    );

    // kickoff 없는 조직 기존 동작 유지: an organization.json with no
    // registered kickoff at all skips the binding assert entirely
    // (kickoffs.length === 0), so an ordinary solo worktree keeps working
    // exactly as before D2 -- reaching the same missing-Orca failure any
    // worker-start hits once it actually tries to spawn, not a "cannot be
    // tied" refusal.
    const soloDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "omt-audit-d2-solo-")),
    );
    t.after(() => fs.rmSync(soloDir, { recursive: true, force: true }));
    const soloOrg = path.join(soloDir, ".omt", "organization.json");
    fs.mkdirSync(path.dirname(soloOrg), { recursive: true });
    fs.copyFileSync(exampleOrg, soloOrg);
    await assert.rejects(
      () =>
        main([
          "worker-start",
          "--repo",
          soloDir,
          "--org",
          soloOrg,
          "--role",
          "senior",
          "--spec",
          "x",
          "--terminal",
          "term_solo",
          "--orca",
          missingOrca,
        ]),
      /Selected Orca executable failed/,
    );
  },
);

test("role-worktree-create (D2 rule 6): a swallowed launch-ledger write failure surfaces as a top-level blocked status, not a silent success", async (t) => {
  const fixture = kickoff(t, "wt-1", {
    auditor: { profile: "claude-current" },
  });
  fs.mkdirSync(fixture.entry.pm.path, { recursive: true });

  // D2/부록 F: an active kickoff exists in this organization, so a non-pm
  // role-worktree-create now requires --workflow-id/--workflow-task/--state
  // naming this kickoff, and --repo must be that kickoff's own PM worktree
  // (satisfied by fixture.entry.pm.path above) -- unrelated to this test's own
  // point (a swallowed ledger write still surfaces as a blocked status), but
  // required to reach it.
  writeJSON(path.join(fixture.dir, "a.json"), {
    schemaVersion: 2,
    revision: 1,
    kind: "edit",
    id: "a",
    goal: "noop",
    instruction: "noop",
    nonGoals: [],
    constraints: [],
    files: ["x.txt"],
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
  await createWorkflow(
    fixture.entry.pm.stateDir,
    {
      schemaVersion: 1,
      id: "wf-ledger-error",
      goal: "fixture's own workflow",
      repo: ".",
      tasks: [{ file: "a.json", role: "senior" }],
      policy: { maxRunning: 1, maxReviewPending: 1 },
      budget: { maxAttempts: 1, maxCalls: 4 },
    },
    readJSON(fixture.org),
    fixture.dir,
  );

  const result = await createRoleWorktree(
    {
      org: fixture.org,
      role: "senior",
      repo: fixture.entry.pm.path,
      "workflow-id": "wf-ledger-error",
      "workflow-task": "a",
      state: fixture.entry.pm.stateDir,
      name: "task-ledger-error",
      base: "f".repeat(40),
    },
    {
      organization: () => readJSON(fixture.org),
      environment: async () => ({
        platform: "darwin",
        shell: "zsh",
        trustRecordExists: true,
        codexTrustRecordExists: true,
        orcaVersion: "1.4.210",
        cliVersion: "1.2.11",
      }),
      matrix: () => ({
        path: "supervised-terminal",
        reason: [],
        nextAction: "",
      }),
      create: async (_repo, options) => {
        const session = await options.openRoleSession({
          id: "wt_ledger_error",
        });
        return {
          workspace: { id: "wt_ledger_error", path: "/repo/task-ledger-error" },
          session,
        };
      },
      // The real role-terminal handler spreads recordLaunchSafely's result
      // (tests/worktree-lifecycle.test.mjs exercises that swallow directly,
      // with a genuine ledger write failure) at the same top level as
      // `ready`/`terminal`; injecting that shape here isolates what
      // createRoleWorktree itself must do once it sees it, from how the
      // write actually came to fail.
      open: async () => ({
        ready: true,
        terminal: "term_ledger_error",
        role: "senior",
        worktree: "id:wt_ledger_error",
        modelRequested: "claude-current",
        ledgerError: "EACCES: permission denied, open '.omt/launches.jsonl'",
      }),
    },
  );

  assert.equal(result.status, "blocked");
  assert.match(result.blockedReason, /task-ledger-error/);
  assert.match(result.blockedReason, /term_ledger_error/);
  assert.match(
    result.blockedReason,
    /EACCES: permission denied, open '\.omt\/launches\.jsonl'/,
  );
  assert.match(
    result.blockedReason,
    /Neither the worktree nor the session is reclaimed automatically/,
  );
  // The underlying session (and its worktree) are still returned untouched,
  // not discarded, so the director can inspect exactly what was opened.
  assert.equal(
    result.session.ledgerError,
    "EACCES: permission denied, open '.omt/launches.jsonl'",
  );
  assert.equal(result.session.terminal, "term_ledger_error");
  assert.equal(result.id, "wt_ledger_error");
});

// A second kickoff registered under the same organization file as `fixture`,
// with its own director checkout, so a --state belonging to it can be tried
// from `fixture`'s director cwd (mismatched director-authority check).
function secondKickoff(fixture, worktreeId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-audit-"));
  const pm = path.join(dir, worktreeId);
  const brief = path.join(dir, "brief.md");
  fs.writeFileSync(brief, "goal, acceptance criteria, non-goals\n");
  registerKickoff(fixture.org, {
    goal: `deliver ${worktreeId}`,
    pm: { worktreeId, path: pm, stateDir: path.join(pm, ".omt") },
    organizationRevision: readJSON(fixture.org).revision,
    brief,
    delivery: { mode: "none" },
    requirements: minimalRequirements(fixture.org, worktreeId),
    director: { terminalHandle: "term_director_2", checkoutPath: dir },
  });
  const [entry] = listKickoffs(fixture.org, worktreeId).kickoffs;
  return { dir, entry };
}

test(
  "role-terminal --role auditor refuses without --state, without director authority, " +
    "from the pm's or a worker's worktree, with another kickoff's --state, and with --orca even once every other check is satisfied",
  async (t) => {
    const fixture = kickoff(t, "wt-1", {
      auditor: { profile: "claude-current" },
    });

    const originalCwd = process.cwd();
    t.after(() => process.chdir(originalCwd));

    const workerDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "omt-audit-worker-"),
    );
    t.after(() => fs.rmSync(workerDir, { recursive: true, force: true }));
    recordLaunch(fixture.org, {
      via: "worker-start",
      role: "senior",
      stateDir: fixture.entry.pm.stateDir,
      worktreePath: workerDir,
      callerCwd: workerDir,
    });

    const auditorDir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-audit-run-"));
    t.after(() => fs.rmSync(auditorDir, { recursive: true, force: true }));

    const roleTerminal = (extraArgs) =>
      main([
        "role-terminal",
        "--org",
        fixture.org,
        "--role",
        "auditor",
        ...extraArgs,
      ]);

    process.chdir(fixture.dir);

    // --state 없음
    await assert.rejects(
      () => roleTerminal(["--worktree", `path:${auditorDir}`]),
      /requires --state/,
    );

    // 이사가 아닌 cwd: fixture.dir is this kickoff's director checkout, so
    // running from anywhere else must be refused.
    const outsiderDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "omt-audit-outsider-"),
    );
    t.after(() => fs.rmSync(outsiderDir, { recursive: true, force: true }));
    process.chdir(outsiderDir);
    await assert.rejects(
      () =>
        roleTerminal([
          "--worktree",
          `path:${auditorDir}`,
          "--state",
          fixture.entry.pm.stateDir,
        ]),
      /director's checkout/,
    );
    process.chdir(fixture.dir);

    // PM 워크트리
    await assert.rejects(
      () =>
        roleTerminal([
          "--worktree",
          `path:${fixture.entry.pm.path}`,
          "--state",
          fixture.entry.pm.stateDir,
        ]),
      /PM or a worker already uses/,
    );

    // worker 워크트리
    await assert.rejects(
      () =>
        roleTerminal([
          "--worktree",
          `path:${workerDir}`,
          "--state",
          fixture.entry.pm.stateDir,
        ]),
      /PM or a worker already uses/,
    );

    // D4: a path nested arbitrarily deep inside the worker's worktree is not
    // itself workerDir, so an exact string-set membership test would let it
    // through; sharesWorktreeWithAny's ancestor walk still catches it.
    const nestedInWorker = path.join(workerDir, "deep", "nested", "dir");
    fs.mkdirSync(nestedInWorker, { recursive: true });
    await assert.rejects(
      () =>
        roleTerminal([
          "--worktree",
          `path:${nestedInWorker}`,
          "--state",
          fixture.entry.pm.stateDir,
        ]),
      /PM or a worker already uses/,
    );

    // D4: a symlink to the worker's worktree resolves, through
    // fs.realpathSync.native, to the same filesystem identity as workerDir
    // itself, so it cannot pass as an independent path either.
    const symlinkToWorker = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "omt-audit-symlink-")),
      "alias",
    );
    fs.symlinkSync(workerDir, symlinkToWorker, "dir");
    t.after(() => fs.rmSync(symlinkToWorker, { force: true }));
    await assert.rejects(
      () =>
        roleTerminal([
          "--worktree",
          `path:${symlinkToWorker}`,
          "--state",
          fixture.entry.pm.stateDir,
        ]),
      /PM or a worker already uses/,
    );

    // 다른 kickoff의 --state: same organization, a different kickoff's PM state
    // directory, tried from fixture's director cwd, not that kickoff's own.
    const other = secondKickoff(fixture, "wt-other");
    t.after(() => fs.rmSync(other.dir, { recursive: true, force: true }));
    await assert.rejects(
      () =>
        roleTerminal([
          "--worktree",
          `path:${auditorDir}`,
          "--state",
          other.entry.pm.stateDir,
        ]),
      /director's checkout/,
    );

    // 모든 사전 검사(state, director authority, worktree 충돌)를 통과해도
    // --orca는 여전히 거부된다: 감사 실행기와 명령 실행기는
    // resolveAuditorLaunchExecution을 거쳐 trustedOrcaExecute로만 정해지며
    // (B.6, 결정 B), 이 값이 실제 신뢰 경로를 가리키면 곧바로 진짜 Orca
    // 프로세스와 통신을 시도하게 되므로, 그 성공 경로까지 이 테스트가 안전하게
    // 검증할 수 없다(로컬 개발 머신에 실제 Orca 설치가 있을 수 있어 부작용을
    // 일으킬 위험이 있다). resolveTrustedOrcaScriptPath/trustedOrcaExecute의
    // 성공·실패 분기 자체는 tests/orca-adapter.test.mjs가 candidates/exists/
    // realpath/userInfo를 주입해 다루고, resolveAuditorLaunchExecution이 그
    // 신뢰 실행을 실제로 반환값에 담아 전달한다는 것은 아래
    // "resolveAuditorLaunchExecution" 테스트가 다룬다.
    await assert.rejects(
      () =>
        roleTerminal([
          "--worktree",
          `path:${auditorDir}`,
          "--state",
          fixture.entry.pm.stateDir,
          "--orca",
          path.join(fixture.dir, "missing-orca"),
        ]),
      /does not accept --orca/,
    );
  },
);

test(
  "role-worktree-create (counterexample 13): a D4-colliding auditor workspace is reclaimed before any " +
    "terminal-open port runs, and create() itself never runs without director authority or a matching --repo",
  async (t) => {
    const fixture = kickoff(t, "wt-1", {
      auditor: { profile: "claude-current" },
    });
    fs.mkdirSync(fixture.entry.pm.path, { recursive: true });

    const originalCwd = process.cwd();
    t.after(() => process.chdir(originalCwd));

    const baseArgs = {
      org: fixture.org,
      role: "auditor",
      state: fixture.entry.pm.stateDir,
      name: "audit-d4",
      base: "f".repeat(40),
    };
    const environment = async () => ({
      platform: "darwin",
      shell: "zsh",
      trustRecordExists: true,
      codexTrustRecordExists: true,
      orcaVersion: "1.4.210",
      cliVersion: "1.2.11",
    });
    const matrix = () => ({
      path: "supervised-terminal",
      reason: [],
      nextAction: "",
    });

    // [A] The D4 collision itself, exercised through orca-adapter.mjs's own
    // createWorktreeWithRoleSession rather than a mock that reinvents its
    // contract: `execute` records every Orca invocation this real function
    // issues, so this proves both that it always rejects a D4 collision
    // (never returns a success object) and that its own "worktree remove"
    // call, not a stand-in, is what reclaims the colliding workspace.
    {
      process.chdir(fixture.dir);
      const discovery = { executable: "orca", versionsMatch: true };
      const calls = [];
      const execute = async (argv) => {
        calls.push(argv);
        return {
          code: 0,
          stderr: "",
          timedOut: false,
          stdout: argv.includes("create")
            ? JSON.stringify({
                ok: true,
                result: {
                  worktree: { id: "wt_d4_audit", path: fixture.entry.pm.path },
                },
              })
            : JSON.stringify({ ok: true, result: { removed: "wt_d4_audit" } }),
        };
      };
      let openCalls = 0;
      await assert.rejects(
        () =>
          createRoleWorktree(
            { ...baseArgs, repo: fixture.dir },
            {
              organization: () => readJSON(fixture.org),
              environment,
              matrix,
              // Stands in only for orca-adapter's export lookup, not for its
              // reclaim/throw contract: options.execute/discovery are the
              // real createWorktreeWithRoleSession's own injectable ports
              // (tests/worktree-lifecycle.test.mjs uses the same pattern).
              create: (repo, options) =>
                createWorktreeWithRoleSession(repo, {
                  ...options,
                  discovery,
                  execute,
                }),
              // Injected in place of role-terminal's own terminal-open call:
              // if the D4 pre-check inside createRoleWorktree's
              // openRoleSession callback did not run before this port, a D4
              // violation would still reach it.
              open: async () => {
                openCalls += 1;
                return {
                  ready: true,
                  terminal: "term_d4_audit",
                  role: "auditor",
                  worktree: "id:wt_d4_audit",
                  modelRequested: "claude-current",
                };
              },
            },
          ),
        /was reclaimed/,
      );
      assert.equal(openCalls, 0);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[1].slice(1, 4), [
        "worktree",
        "remove",
        "--worktree",
      ]);
      assert.equal(calls[1][4], "id:wt_d4_audit");
    }

    // [B] A caller without director authority, or with a --repo that is not
    // the director's checkout, is refused before create() ever runs -- the
    // D4 collision above never has a chance to matter for these callers.
    const refusesBeforeCreate = async (args, cwd, messagePattern) => {
      process.chdir(cwd);
      let createCalls = 0;
      await assert.rejects(
        () =>
          createRoleWorktree(args, {
            organization: () => readJSON(fixture.org),
            environment,
            matrix,
            create: async () => {
              createCalls += 1;
              throw new Error("create must not run for this caller");
            },
            open: async () => {
              throw new Error("open must not run for this caller");
            },
          }),
        messagePattern,
      );
      assert.equal(createCalls, 0);
    };

    const unauthorizedCwd = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "omt-audit-no-authority-")),
    );
    t.after(() => fs.rmSync(unauthorizedCwd, { recursive: true, force: true }));
    await refusesBeforeCreate(
      { ...baseArgs, repo: fixture.dir },
      unauthorizedCwd,
      /must be run from the director's checkout/,
    );

    const otherRepo = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "omt-audit-other-repo-")),
    );
    t.after(() => fs.rmSync(otherRepo, { recursive: true, force: true }));
    await refusesBeforeCreate(
      { ...baseArgs, repo: otherRepo },
      fixture.dir,
      /does not match kickoff .* director checkout/,
    );
  },
);

test(
  "role-terminal --role auditor refuses an agy-provider auditor profile before any trusted-Orca probe, " +
    "terminal open, or launch record runs, with or without --allow-unverified, while a non-auditor role " +
    "on the same agy profile reaches its ordinary spawn path unaffected",
  async (t) => {
    const fixture = kickoff(t, "wt-1", { auditor: { profile: "agy-oss" } });

    const originalCwd = process.cwd();
    t.after(() => process.chdir(originalCwd));
    process.chdir(fixture.dir);

    const auditorDir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-audit-agy-"));
    t.after(() => fs.rmSync(auditorDir, { recursive: true, force: true }));

    const roleTerminalAuditor = (extraArgs = []) =>
      main([
        "role-terminal",
        "--org",
        fixture.org,
        "--role",
        "auditor",
        "--worktree",
        `path:${auditorDir}`,
        "--state",
        fixture.entry.pm.stateDir,
        ...extraArgs,
      ]);

    // agy-oss's "agy" provider must be refused before
    // resolveAuditorLaunchExecution/readLaunchEnvironment ever run: were the
    // trusted-Orca probe or a real terminal spawn reached instead, this
    // in-process call would try to talk to whatever Orca/agy happens to be
    // on this machine, which is exactly what the rejection below proves did
    // not happen.
    const launchesBefore = readLaunches(fixture.org).length;
    await assert.rejects(
      roleTerminalAuditor(),
      /Agy 감사 지원은 별도의 신뢰 실행 경로 설계가 필요/,
    );
    await assert.rejects(
      roleTerminalAuditor(["--allow-unverified", "I approve this launch"]),
      /Agy 감사 지원은 별도의 신뢰 실행 경로 설계가 필요/,
    );

    // recordAuditorLaunch (kickoff-registry) never ran: the kickoff entry
    // still carries no `auditor` field.
    const [afterEntry] = listKickoffs(fixture.org, fixture.worktreeId).kickoffs;
    assert.equal(afterEntry.auditor, undefined);
    // recordLaunchSafely (usage-ledger), which only runs once openRoleTerminal
    // has already returned, never ran either.
    assert.equal(readLaunches(fixture.org).length, launchesBefore);

    // Contrast: a non-auditor role on the very same agy profile is not
    // touched by this refusal. `senior` is configured on `agy-flash` (an
    // "agy" provider) by the example organization already, with no
    // org.auditor override needed. This call targets fixture.entry.pm.path
    // itself, run from that same directory, rather than an unrelated
    // workerDir: assertDirectRoleTerminalBinding's direct role-terminal
    // binding table (부록 F) now refuses a --state-less launch at any target
    // it cannot tie to a registered kickoff, and an unrelated fresh directory
    // is exactly such an unbound, unrecorded child (that refusal itself is
    // covered separately by counterexample 7). The PM's own worktree, opened
    // --state-less from the PM's own cwd, is the one row the table allows, so
    // this contrast keeps reaching its ordinary, pre-existing PATH-based
    // spawn attempt, which this test only lets run against a missing
    // executable (a plain ENOENT, not any Orca/agy process), so it stays a
    // safe, local failure rather than the agy refusal above.
    fs.mkdirSync(fixture.entry.pm.path, { recursive: true });
    const seniorCwd = process.cwd();
    await assert.rejects(
      async () => {
        process.chdir(fixture.entry.pm.path);
        try {
          return await main([
            "role-terminal",
            "--org",
            fixture.org,
            "--role",
            "senior",
            "--worktree",
            `path:${fixture.entry.pm.path}`,
            "--orca",
            path.join(fixture.entry.pm.path, "missing-orca"),
          ]);
        } finally {
          process.chdir(seniorCwd);
        }
      },
      (err) => {
        assert.doesNotMatch(
          err.message,
          /Agy 감사 지원은 별도의 신뢰 실행 경로 설계가 필요/,
        );
        assert.match(err.message, /ENOENT/);
        return true;
      },
    );
  },
);

// --- D2 counterexamples (부록 F 반례 1~17) -------------------------------
//
// The tests below cover the counterexamples 1, 3-11, 15 and 17, and the parts
// of 2, 6 and 13 that the tests above do not. They all use a kickoff-bearing
// organization (D2's binding rules only apply once a kickoff is registered).
// A direct role-terminal call is made through `main`, exactly as the CLI does;
// `--orca` names a missing executable, so a launch that passes the binding
// table stops at the ordinary ENOENT spawn failure instead of reaching any
// real Orca process, while a launch the table refuses stops earlier with its
// own message. Distinguishing the two is the whole point of these tests.

const BINDING_REFUSED =
  /cannot be tied to any registered kickoff|does not name the kickoff|must name the kickoff|may only be opened from kickoff|No kickoff is registered/;

function realTempDir(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A registered kickoff whose PM worktree exists on disk, so realpath-based
// binding checks can resolve it.
function boundKickoff(t, worktreeId = "wt-1") {
  const fixture = kickoff(t, worktreeId);
  fs.mkdirSync(fixture.entry.pm.path, { recursive: true });
  return fixture;
}

// The ledger line role-worktree-create's own first role-terminal call records
// for a child worktree it opened under `fixture`'s kickoff.
function recordBoundChild(fixture, dir, terminal) {
  recordLaunch(fixture.org, {
    via: "role-terminal",
    role: "senior",
    terminal,
    stateDir: fixture.entry.pm.stateDir,
    worktreePath: dir,
    callerCwd: dir,
  });
}

// One direct `role-terminal --role senior` launch from `cwd`.
async function directSeniorLaunch(fixture, cwd, worktree, extraArgs = []) {
  return withCwd(cwd, () =>
    main([
      "role-terminal",
      "--org",
      fixture.org,
      "--role",
      "senior",
      "--worktree",
      `path:${worktree}`,
      "--orca",
      path.join(fixture.dir, "missing-orca"),
      ...extraArgs,
    ]),
  );
}

// Passing the binding table means reaching the ordinary spawn failure.
async function assertPassesBinding(launch) {
  await assert.rejects(launch, (error) => {
    assert.doesNotMatch(error.message, BINDING_REFUSED);
    assert.match(error.message, /ENOENT/);
    return true;
  });
}

// A minimal, real workflow in `stateDir`, which launchContext and
// createRoleWorktree both read before they accept --workflow-id/--state; the
// read happens before any binding check, so a --state without one would fail
// there instead of reaching the rule under test. `repoDir` is the Git
// directory the task file lives in.
async function createStateWorkflow(org, stateDir, repoDir, workflowId) {
  writeJSON(path.join(repoDir, "a.json"), {
    schemaVersion: 2,
    revision: 1,
    kind: "edit",
    id: "a",
    goal: "noop",
    instruction: "noop",
    nonGoals: [],
    constraints: [],
    files: ["x.txt"],
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
  await createWorkflow(
    stateDir,
    {
      schemaVersion: 1,
      id: workflowId,
      goal: "fixture's own workflow",
      repo: ".",
      tasks: [{ file: "a.json", role: "senior" }],
      policy: { maxRunning: 1, maxReviewPending: 1 },
      budget: { maxAttempts: 1, maxCalls: 4 },
    },
    readJSON(org),
    repoDir,
  );
}

// The same, for `fixture`'s own kickoff.
function createFixtureWorkflow(fixture, workflowId) {
  return createStateWorkflow(
    fixture.org,
    fixture.entry.pm.stateDir,
    fixture.dir,
    workflowId,
  );
}

// A second kickoff with a genuine workflow of its own, as a launch naming its
// --state needs.
async function secondKickoffWithWorkflow(t, fixture, worktreeId, workflowId) {
  const other = secondKickoff(fixture, worktreeId);
  t.after(() => fs.rmSync(other.dir, { recursive: true, force: true }));
  fs.mkdirSync(other.entry.pm.path, { recursive: true });
  initRepo(other.dir);
  await createStateWorkflow(
    fixture.org,
    other.entry.pm.stateDir,
    other.dir,
    workflowId,
  );
  return other;
}

// --state on a direct role-terminal launch is only accepted together with the
// --workflow-id of a real workflow in that state directory.
function stateArgs(stateDir, workflowId) {
  return ["--state", stateDir, "--workflow-id", workflowId];
}

// A state directory no kickoff registered, holding a genuine workflow.
async function unregisteredStateWithWorkflow(t, fixture, workflowId) {
  const dir = realTempDir(t, "omt-d2-unregistered-");
  initRepo(dir);
  const stateDir = path.join(dir, ".omt");
  await createStateWorkflow(fixture.org, stateDir, dir, workflowId);
  return stateDir;
}

const d2Environment = async () => ({
  platform: "darwin",
  shell: "zsh",
  trustRecordExists: true,
  codexTrustRecordExists: true,
  orcaVersion: "1.4.210",
  cliVersion: "1.2.11",
});
const d2Matrix = () => ({
  path: "supervised-terminal",
  reason: [],
  nextAction: "",
});

test("role-terminal (counterexample 1): the internal role-worktree-create marker cannot be passed through the real CLI", (t) => {
  const fixture = boundKickoff(t);
  const child = realTempDir(t, "omt-d2-cx1-");
  const launchesBefore = readLaunches(fixture.org).length;
  for (const spelling of [
    "--viaRoleWorktreeCreate",
    "--via-role-worktree-create",
  ]) {
    const result = runCli(
      [
        "role-terminal",
        "--org",
        fixture.org,
        "--role",
        "senior",
        "--worktree",
        `path:${child}`,
        spelling,
        "true",
      ],
      { cwd: fixture.dir },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Unknown option: --/);
  }
  assert.equal(readLaunches(fixture.org).length, launchesBefore);
});

test("role-terminal (counterexamples 7, 8): an unrecorded child and an unregistered --state are refused through the real CLI", async (t) => {
  const fixture = boundKickoff(t);
  await createFixtureWorkflow(fixture, "wf-d2-cx7");
  const child = realTempDir(t, "omt-d2-cx7-");
  const unregisteredState = await unregisteredStateWithWorkflow(
    t,
    fixture,
    "wf-d2-cx8",
  );
  const launchesBefore = readLaunches(fixture.org).length;
  const run = (cwd, extraArgs) =>
    runCli(
      [
        "role-terminal",
        "--org",
        fixture.org,
        "--role",
        "senior",
        "--worktree",
        `path:${child}`,
        "--orca",
        path.join(fixture.dir, "missing-orca"),
        ...extraArgs,
      ],
      { cwd },
    );

  // 7: no launch line ever named this worktree, so it cannot be tied to the
  // kickoff whatever --state or cwd the caller supplies.
  for (const [cwd, extraArgs] of [
    [fixture.dir, []],
    [fixture.entry.pm.path, []],
    [fixture.dir, stateArgs(fixture.entry.pm.stateDir, "wf-d2-cx7")],
  ]) {
    const result = run(cwd, extraArgs);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /cannot be tied to any registered kickoff/);
  }

  // 8: a --state that no registered kickoff owns is refused outright.
  const unregistered = run(
    fixture.dir,
    stateArgs(unregisteredState, "wf-d2-cx8"),
  );
  assert.notEqual(unregistered.code, 0);
  assert.match(
    unregistered.stderr,
    /No kickoff is registered with pm state directory/,
  );
  assert.equal(readLaunches(fixture.org).length, launchesBefore);
});

test("role-terminal (counterexamples 3, 10): existing bound children resume under their own kickoff's --state, and a matching worker-start terminal stays bound", async (t) => {
  const fixture = boundKickoff(t);
  await createFixtureWorkflow(fixture, "wf-d2-cx3");
  const childOne = realTempDir(t, "omt-d2-cx3-one-");
  const childTwo = realTempDir(t, "omt-d2-cx3-two-");
  recordBoundChild(fixture, childOne, "term_child_one");
  recordBoundChild(fixture, childTwo, "term_child_two");
  // A sub-directory of an already-bound child is the same child.
  const nested = path.join(childTwo, "sub", "dir");
  fs.mkdirSync(nested, { recursive: true });

  for (const child of [childOne, childTwo, nested]) {
    await assertPassesBinding(
      directSeniorLaunch(
        fixture,
        fixture.dir,
        child,
        stateArgs(fixture.entry.pm.stateDir, "wf-d2-cx3"),
      ),
    );
  }

  // worker-start reaches Orca (missing here) for a terminal whose own
  // role-terminal line names the child, rather than refusing it as unbound.
  for (const [child, terminal] of [
    [childOne, "term_child_one"],
    [childTwo, "term_child_two"],
  ]) {
    await assert.rejects(
      () =>
        main([
          "worker-start",
          "--repo",
          child,
          "--org",
          fixture.org,
          "--role",
          "senior",
          "--spec",
          "x",
          "--terminal",
          terminal,
          "--orca",
          path.join(fixture.dir, "missing-orca"),
        ]),
      /Selected Orca executable failed/,
    );
  }
});

test("role-terminal (counterexamples 4, 5, 6, 11): another kickoff's PM cannot take over a bound child or PM worktree, with or without --state", async (t) => {
  const fixture = boundKickoff(t);
  await createFixtureWorkflow(fixture, "wf-d2-cx4-a");
  const other = await secondKickoffWithWorkflow(
    t,
    fixture,
    "wt-d2-thief",
    "wf-d2-cx4-b",
  );
  const stateA = stateArgs(fixture.entry.pm.stateDir, "wf-d2-cx4-a");
  const stateB = stateArgs(other.entry.pm.stateDir, "wf-d2-cx4-b");
  const child = realTempDir(t, "omt-d2-cx4-");
  recordBoundChild(fixture, child, "term_child_a");
  const launchesBefore = readLaunches(fixture.org).length;

  // 4: kickoff B names its own --state for kickoff A's bound child.
  await assert.rejects(
    directSeniorLaunch(fixture, other.entry.pm.path, child, stateB),
    /--state must name the kickoff \(wt-1\) this worktree is already bound to/,
  );
  // 5: the same takeover without --state, from B's own PM worktree.
  await assert.rejects(
    directSeniorLaunch(fixture, other.entry.pm.path, child),
    /--state must name the kickoff \(wt-1\)/,
  );
  // 11: kickoff B's session reuses the child's path but its own launch line
  // was never written (ledgerError), so the old line still says kickoff A
  // and B's --state is refused instead of silently taking it over.
  await assert.rejects(
    directSeniorLaunch(fixture, fixture.dir, child, stateB),
    /--state must name the kickoff \(wt-1\)/,
  );
  // 6: a --state naming another kickoff is refused for a PM worktree too.
  await assert.rejects(
    directSeniorLaunch(
      fixture,
      fixture.entry.pm.path,
      fixture.entry.pm.path,
      stateB,
    ),
    /does not name the kickoff \(wt-1\) this worktree belongs to/,
  );
  await assert.rejects(
    directSeniorLaunch(
      fixture,
      other.entry.pm.path,
      other.entry.pm.path,
      stateA,
    ),
    /does not name the kickoff \(wt-d2-thief\) this worktree belongs to/,
  );
  assert.equal(readLaunches(fixture.org).length, launchesBefore);

  // Control: the rightful kickoff still resumes its own child.
  await assertPassesBinding(
    directSeniorLaunch(fixture, fixture.dir, child, stateA),
  );
});

test("role-terminal (counterexample 17): --state may be omitted for a PM worktree only from that PM's own cwd", async (t) => {
  const fixture = boundKickoff(t);
  const other = secondKickoff(fixture, "wt-d2-other-pm");
  t.after(() => fs.rmSync(other.dir, { recursive: true, force: true }));
  fs.mkdirSync(other.entry.pm.path, { recursive: true });
  const outsider = realTempDir(t, "omt-d2-cx17-");

  // cwd matches the PM worktree: allowed.
  await assertPassesBinding(
    directSeniorLaunch(fixture, fixture.entry.pm.path, fixture.entry.pm.path),
  );
  // cwd is another PM's worktree, the director's checkout or elsewhere:
  // refused, since only the PM's own cwd may stand in for --state.
  for (const cwd of [other.entry.pm.path, fixture.dir, outsider]) {
    await assert.rejects(
      directSeniorLaunch(fixture, cwd, fixture.entry.pm.path),
      /may only be opened from kickoff wt-1's own PM worktree/,
    );
  }
});

test(
  "role-worktree-create (counterexamples 8, 15): a non-PM role is refused before create() without a registered --state " +
    "matching its --repo, and role: pm's first worktree is the one exception",
  async (t) => {
    const fixture = boundKickoff(t);
    const other = secondKickoff(fixture, "wt-d2-b");
    t.after(() => fs.rmSync(other.dir, { recursive: true, force: true }));
    fs.mkdirSync(other.entry.pm.path, { recursive: true });
    await createFixtureWorkflow(fixture, "wf-d2-cx15");
    const unregisteredState = await unregisteredStateWithWorkflow(
      t,
      fixture,
      "wf-d2-cx15",
    );

    let createCalls = 0;
    const ports = {
      organization: () => readJSON(fixture.org),
      environment: d2Environment,
      matrix: d2Matrix,
      create: async (_repo, options) => {
        createCalls += 1;
        const session = await options.openRoleSession({
          id: "wt_d2_created",
          path: "/repo/d2-created",
        });
        return {
          workspace: { id: "wt_d2_created", path: "/repo/d2-created" },
          session,
        };
      },
      open: async () => ({
        ready: true,
        terminal: "term_d2_created",
        role: "pm",
        worktree: "id:wt_d2_created",
        modelRequested: "claude-current",
      }),
    };
    const refused = (args, cwd, pattern) =>
      withCwd(cwd, async () => {
        const before = createCalls;
        await assert.rejects(
          createRoleWorktree(
            {
              org: fixture.org,
              name: "d2-refused",
              base: "f".repeat(40),
              ...args,
            },
            ports,
          ),
          pattern,
        );
        assert.equal(createCalls, before);
      });

    // 15: --repo is kickoff A's PM worktree, the caller sits in kickoff B's PM
    // worktree, and no --state/--workflow names any kickoff at all.
    await refused(
      { role: "senior", repo: fixture.entry.pm.path },
      other.entry.pm.path,
      /An active kickoff exists in this organization/,
    );
    // 8: --state names no registered kickoff.
    await refused(
      {
        role: "senior",
        repo: fixture.entry.pm.path,
        "workflow-id": "wf-d2-cx15",
        "workflow-task": "a",
        state: unregisteredState,
      },
      fixture.entry.pm.path,
      /No kickoff is registered with pm state directory/,
    );
    // --state names kickoff A, but --repo is kickoff B's PM worktree.
    await refused(
      {
        role: "senior",
        repo: other.entry.pm.path,
        "workflow-id": "wf-d2-cx15",
        "workflow-task": "a",
        state: fixture.entry.pm.stateDir,
      },
      fixture.entry.pm.path,
      /does not match kickoff wt-1's PM worktree/,
    );

    // role: pm's first worktree needs no --state and is not refused here.
    const created = await withCwd(fixture.dir, () =>
      createRoleWorktree(
        {
          org: fixture.org,
          name: "d2-first-pm",
          base: "f".repeat(40),
          role: "pm",
          repo: fixture.dir,
        },
        ports,
      ),
    );
    assert.equal(createCalls, 1);
    assert.equal(created.id, "wt_d2_created");
    assert.equal(created.session.terminal, "term_d2_created");
  },
);

test("role-worktree-create (counterexample 9): a normal first child under its own kickoff is created, and its internal role-terminal open passes the binding table", async (t) => {
  const fixture = boundKickoff(t);
  await createFixtureWorkflow(fixture, "wf-d2-cx9");
  const childDir = realTempDir(t, "omt-d2-cx9-child-");
  const workspace = { id: `wt_d2_cx9::${childDir}`, path: childDir };
  const baseArgs = {
    org: fixture.org,
    role: "senior",
    repo: fixture.entry.pm.path,
    "workflow-id": "wf-d2-cx9",
    "workflow-task": "a",
    state: fixture.entry.pm.stateDir,
    name: "d2-cx9",
    base: "f".repeat(40),
  };
  const ports = (open) => ({
    organization: () => readJSON(fixture.org),
    environment: d2Environment,
    matrix: d2Matrix,
    create: async (_repo, options) => ({
      workspace,
      session: await options.openRoleSession(workspace),
    }),
    ...(open ? { open } : {}),
  });

  // Injected open: the session is returned untouched and no blocked status
  // is invented for a launch whose ledger line was written.
  const created = await withCwd(fixture.entry.pm.path, () =>
    createRoleWorktree(
      baseArgs,
      ports(async () => ({
        ready: true,
        terminal: "term_d2_cx9",
        role: "senior",
        worktree: `id:${workspace.id}`,
        modelRequested: "claude-current",
      })),
    ),
  );
  assert.equal(created.status, undefined);
  assert.equal(created.session.terminal, "term_d2_cx9");

  // Real role-terminal open (missing Orca): the child has no ledger line yet,
  // so only the internal marker lets it past the binding table; the failure is
  // the ordinary spawn error, not a binding refusal.
  await assertPassesBinding(
    withCwd(fixture.entry.pm.path, () =>
      createRoleWorktree(
        { ...baseArgs, orca: path.join(fixture.dir, "missing-orca") },
        ports(),
      ),
    ),
  );
});

test("role-worktree-create (counterexample 13, success path): a non-colliding auditor workspace is created and opened without any reclaim", async (t) => {
  const fixture = kickoff(t, "wt-1", {
    auditor: { profile: "claude-current" },
  });
  fs.mkdirSync(fixture.entry.pm.path, { recursive: true });
  const auditorDir = realTempDir(t, "omt-d2-cx13-ok-");
  const calls = [];
  const execute = async (argv) => {
    calls.push(argv);
    return {
      code: 0,
      stderr: "",
      timedOut: false,
      stdout: JSON.stringify({
        ok: true,
        result: { worktree: { id: "wt_d2_audit_ok", path: auditorDir } },
      }),
    };
  };
  let openCalls = 0;
  const created = await withCwd(fixture.dir, () =>
    createRoleWorktree(
      {
        org: fixture.org,
        role: "auditor",
        state: fixture.entry.pm.stateDir,
        repo: fixture.dir,
        name: "audit-ok",
        base: "f".repeat(40),
      },
      {
        organization: () => readJSON(fixture.org),
        environment: d2Environment,
        matrix: d2Matrix,
        create: (repo, options) =>
          createWorktreeWithRoleSession(repo, {
            ...options,
            discovery: { executable: "orca", versionsMatch: true },
            execute,
          }),
        open: async () => {
          openCalls += 1;
          return {
            ready: true,
            terminal: "term_d2_audit_ok",
            role: "auditor",
            worktree: "id:wt_d2_audit_ok",
            modelRequested: "claude-current",
          };
        },
      },
    ),
  );
  assert.equal(openCalls, 1);
  assert.equal(created.id, "wt_d2_audit_ok");
  assert.equal(created.session.terminal, "term_d2_audit_ok");
  assert.equal(created.status, undefined);
  assert.equal(
    calls.some((argv) => argv.includes("remove")),
    false,
  );
});

// readTrustedOrcaVersion(options = {}) (orca-adapter.mjs) exposes injection
// points, but only for tests: production callers, this role-terminal
// handler included, must call it with none. That means the handler has no
// parameter through which a test could make the trusted-Orca probe below
// actually throw, return null, or return a non-semver value while running
// the real role-terminal command path — doing so would require adding a
// new public injection option to teams-org.mjs, which msg_431a3c562ca5
// asked to be reported before building rather than added unasked. What can
// be checked without one is that the handler still wires
// readOrcaVersion/skipAgyVersion/throwOnUnverifiedOrca into
// readLaunchEnvironment for the auditor branch, so a refactor cannot drop
// that wiring silently; readLaunchEnvironment's own throw/null/empty-value
// fail-closed behavior for each of those is exercised directly, without a
// real Orca process, by tests/role-terminal.test.mjs's
// assertFailsClosedOnUnverifiedOrca cases.
test("role-terminal handler wires readOrcaVersion/skipAgyVersion/throwOnUnverifiedOrca into readLaunchEnvironment for the auditor branch", () => {
  const source = fs.readFileSync(
    "plugins/oh-my-teams/scripts/teams-org.mjs",
    "utf8",
  );
  const resolveCallStart = source.indexOf(
    "resolveAuditorLaunchExecution({ auditorEntry",
  );
  assert.notEqual(
    resolveCallStart,
    -1,
    "resolveAuditorLaunchExecution call not found",
  );
  const envCallStart = source.indexOf(
    "const env = await readLaunchEnvironment({",
    resolveCallStart,
  );
  assert.notEqual(envCallStart, -1, "readLaunchEnvironment call not found");
  const envCallEnd = source.indexOf("});", envCallStart);
  const envCall = source.slice(envCallStart, envCallEnd);
  assert.match(
    envCall,
    /readOrcaVersion:\s*\(\)\s*=>\s*readTrustedOrcaVersion\(\)/,
  );
  assert.match(envCall, /skipAgyVersion:\s*true/);
  assert.match(envCall, /throwOnUnverifiedOrca:\s*true/);
});

// CLI registration for audit-objection/audit-response/audit-ruling/
// audit-checked/audit-accept (PM item 3): objection/ruling/checked/accept are
// auditor-only via ORCA_TERMINAL_HANDLE (verifiedAuditor); response is
// director-only for the brief checkpoint (verifiedDirector), exercised here
// rather than the PM path, since the PM path calls the real orca binary
// (verifiedPm) and so is exercised through the identity-injected direct-call
// tests above, not as a subprocess.
test("cli audit-objection: succeeds with the launched auditor's handle, and refuses without one", (t) => {
  const fixture = kickoff(t);
  const requestFile = path.join(fixture.dir, "objection-request.json");
  fs.writeFileSync(
    requestFile,
    JSON.stringify({
      checkpoint: "brief",
      target: { type: "criterion", id: "c1" },
      kind: "gap",
      description: "criterion c1 is not clearly derived from the brief",
      rebuttalRequested: "point to the brief section it comes from",
    }),
  );
  const refused = runCli(
    [
      "audit-objection",
      "--org",
      fixture.org,
      "--worktree",
      fixture.worktreeId,
      "--from",
      requestFile,
    ],
    { cwd: fixture.dir, env: { ORCA_TERMINAL_HANDLE: null } },
  );
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /ORCA_TERMINAL_HANDLE is not set/);

  const succeeded = runCli(
    [
      "audit-objection",
      "--org",
      fixture.org,
      "--worktree",
      fixture.worktreeId,
      "--from",
      requestFile,
    ],
    { cwd: fixture.dir, env: { ORCA_TERMINAL_HANDLE: fixture.auditorHandle } },
  );
  assert.equal(succeeded.code, 0, succeeded.stderr);
  assert.equal(JSON.parse(succeeded.stdout).recorded, true);
});

test("cli audit-response: succeeds from the director's checkout (brief checkpoint), and refuses from elsewhere", async (t) => {
  const fixture = kickoff(t);
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditObjection(fixture.org, fixture.worktreeId, {
      checkpoint: "brief",
      target: { type: "criterion", id: "c1" },
      kind: "gap",
      description: "criterion c1 is not clearly derived from the brief",
      rebuttalRequested: "point to the brief section it comes from",
    }),
  );
  const objectionId = readAudit(
    fixture.org,
    fixture.worktreeId,
  ).checkpoints.brief.objections.at(-1).id;
  const evidencePath = "brief-evidence.txt";
  fs.writeFileSync(path.join(fixture.dir, evidencePath), "brief section 2\n");
  const requestFile = path.join(fixture.dir, "response-request.json");
  fs.writeFileSync(
    requestFile,
    JSON.stringify({
      checkpoint: "brief",
      objectionId,
      argument: "c1 traces to brief section 2",
      evidenceRefs: [
        {
          path: evidencePath,
          sha256: fileSha256(path.join(fixture.dir, evidencePath)),
        },
      ],
    }),
  );
  const other = fs.mkdtempSync(
    path.join(os.tmpdir(), "omt-audit-response-other-"),
  );
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const refused = runCli(
    [
      "audit-response",
      "--org",
      fixture.org,
      "--worktree",
      fixture.worktreeId,
      "--from",
      requestFile,
    ],
    { cwd: other },
  );
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /director's checkout/);

  const succeeded = runCli(
    [
      "audit-response",
      "--org",
      fixture.org,
      "--worktree",
      fixture.worktreeId,
      "--from",
      requestFile,
    ],
    { cwd: fixture.dir },
  );
  assert.equal(succeeded.code, 0, succeeded.stderr);
  assert.equal(JSON.parse(succeeded.stdout).recorded, true);
});

// --terminal and --orca were removed from audit-response's outcome-checkpoint
// path (see teams-org.mjs's "audit-response" case) because a caller could
// otherwise name any handle via --terminal and have run-current confirmed
// against it, or point --orca at a forged executable that fabricates that
// confirmation. verifiedPm now reads ORCA_TERMINAL_HANDLE from the real
// process environment and, unless a test injects options.orca, runs its
// check through trustedOrcaExecute, the same way verifiedAuditor's identity
// input is settled without argv (B.6, decision B), so neither --terminal nor
// --orca can substitute for either. The success path this used to exercise
// at the CLI, by pointing ORCA_CLI_COMMAND at a forged Orca, no longer
// demonstrates anything: trustedOrcaExecute's underlying
// resolveTrustedOrcaScriptPath ignores that variable, so it is covered
// instead by the direct verifiedPm/auditResponse call below, which injects a
// stand-in executable through options.orca (an API argument), exactly as
// decision B requires test fixtures to.
test("cli audit-response (outcome checkpoint): --terminal and --orca are unknown options", async (t) => {
  const fixture = kickoff(t);
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditObjection(fixture.org, fixture.worktreeId, {
      checkpoint: "outcome",
      target: { type: "criterion", id: "c1" },
      kind: "gap",
      description: "criterion c1 does not look delivered",
      rebuttalRequested: "show where it is delivered",
      resultHead: fixture.head,
      repo: fixture.repo,
    }),
  );
  const objectionId = readAudit(
    fixture.org,
    fixture.worktreeId,
  ).checkpoints.outcome.objections.at(-1).id;
  const evidencePath = "outcome-evidence.txt";
  fs.writeFileSync(path.join(fixture.dir, evidencePath), "delivered\n");
  const requestFile = path.join(fixture.dir, "outcome-response-request.json");
  fs.writeFileSync(
    requestFile,
    JSON.stringify({
      checkpoint: "outcome",
      objectionId,
      argument: "c1 is delivered; see the cited evidence",
      evidenceRefs: [
        {
          path: evidencePath,
          sha256: fileSha256(path.join(fixture.dir, evidencePath)),
        },
      ],
    }),
  );

  // (a) --terminal, forging the caller as the PM by naming its handle, is
  // rejected as an unknown option before identity is even checked.
  const terminalRejected = runCli([
    "audit-response",
    "--org",
    fixture.org,
    "--worktree",
    fixture.worktreeId,
    "--from",
    requestFile,
    "--terminal",
    fixture.pmHandle,
  ]);
  assert.notEqual(terminalRejected.code, 0);
  assert.match(terminalRejected.stderr, /--terminal/);

  // (b) --orca, pointing identity verification at a forged executable, is
  // likewise rejected as an unknown option; the value itself never has to be
  // a real executable, since the CLI refuses the flag before reading it.
  const orcaRejected = runCli([
    "audit-response",
    "--org",
    fixture.org,
    "--worktree",
    fixture.worktreeId,
    "--from",
    requestFile,
    "--orca",
    path.join(fixture.dir, "forged-orca-for-omt-auditor-test"),
  ]);
  assert.notEqual(orcaRejected.code, 0);
  assert.match(orcaRejected.stderr, /--orca/);
});

// isPmBoundToRun is the substantive judgment verifiedPm's run-current check
// reduces to, kept pure and separate exactly so it can be fixture-tested
// without any Orca process, real or fake (B.6, decision B, item i).
test("isPmBoundToRun: matches only when both the handle and the Run id agree, and is false for null/mismatched input", () => {
  const bound = { coordinator_handle: "term_pm_1", id: "run-1" };
  assert.equal(isPmBoundToRun(bound, "term_pm_1", "run-1"), true);
  assert.equal(isPmBoundToRun(bound, "term_pm_1", "run-2"), false);
  assert.equal(isPmBoundToRun(bound, "term_other", "run-1"), false);
  assert.equal(isPmBoundToRun(null, "term_pm_1", "run-1"), false);
  assert.equal(isPmBoundToRun(undefined, "term_pm_1", "run-1"), false);
});

// verifiedPm's own ORCA_TERMINAL_HANDLE-absent rejection needs no trusted
// Orca install to reach: it is asserted before runTrustedOrcaJson is ever
// called. Its success path (a real trusted script confirming the binding)
// takes no test fixture at all any more, per decision B item i, and is
// confirmed manually instead (see B.6 decision B, item c).
test("verifiedPm (direct call) refuses when ORCA_TERMINAL_HANDLE is unset, without attempting any Orca call", async (t) => {
  const fixture = kickoff(t);
  // verifiedPm reads process.env.ORCA_TERMINAL_HANDLE directly, and this test
  // session's own environment may itself carry one (it is, after all, an
  // Orca-launched terminal), so the variable must be actually removed for the
  // duration of the call rather than assumed absent.
  const previous = process.env.ORCA_TERMINAL_HANDLE;
  delete process.env.ORCA_TERMINAL_HANDLE;
  t.after(() => {
    if (previous !== undefined) process.env.ORCA_TERMINAL_HANDLE = previous;
  });
  await assert.rejects(
    () => verifiedPm(fixture.org, fixture.worktreeId),
    /ORCA_TERMINAL_HANDLE is not set/,
  );
});

// Counterexample required by decision B item 3: auditResponse takes no
// identity/executable/execute-override argument at all any more (B.6,
// decision B) — its public signature is (orgFile, worktreeId, request), so a
// 4th positional argument a caller (the CLI or another module importing
// auditResponse directly) passes is simply never read. This proves that
// narrower claim directly: even with ORCA_TERMINAL_HANDLE actually set to the
// PM's real handle (so verifiedPm's outcome-checkpoint path genuinely runs,
// rather than short-circuiting on the "not set" assertion), a forged 4th
// argument's `execute` is never invoked. Whether verifiedPm itself ends up
// resolving or refusing against this machine's real trusted Orca script is
// environment-dependent and not what this test checks.
test("auditResponse (outcome checkpoint) takes no identity-override argument: a forged 4th argument's execute is never invoked", async (t) => {
  const fixture = kickoff(t);
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditObjection(fixture.org, fixture.worktreeId, {
      checkpoint: "outcome",
      target: { type: "criterion", id: "c1" },
      kind: "gap",
      description: "criterion c1 does not look delivered",
      rebuttalRequested: "show where it is delivered",
      resultHead: fixture.head,
      repo: fixture.repo,
    }),
  );
  const objectionId = readAudit(
    fixture.org,
    fixture.worktreeId,
  ).checkpoints.outcome.objections.at(-1).id;
  const evidencePath = "outcome-evidence.txt";
  fs.writeFileSync(path.join(fixture.dir, evidencePath), "delivered\n");
  const responseRequest = {
    checkpoint: "outcome",
    objectionId,
    argument: "c1 is delivered; see the cited evidence",
    evidenceRefs: [
      {
        path: evidencePath,
        sha256: fileSha256(path.join(fixture.dir, evidencePath)),
      },
    ],
  };

  let injectedExecuteCalls = 0;
  const forgedIdentity = {
    orca: "/tmp/forged-orca-for-omt-auditor-test",
    execute: async () => {
      injectedExecuteCalls += 1;
      return {
        code: 0,
        timedOut: false,
        stdout: JSON.stringify({
          ok: true,
          result: {
            run: {
              id: fixture.entry.runId,
              coordinator_handle: fixture.pmHandle,
            },
          },
        }),
        stderr: "",
      };
    },
  };

  await withOrcaHandle(fixture.pmHandle, async () => {
    try {
      await auditResponse(
        fixture.org,
        fixture.worktreeId,
        responseRequest,
        forgedIdentity,
        { ORCA_TERMINAL_HANDLE: fixture.pmHandle },
      );
    } catch {
      // Whether this machine's real trusted Orca script confirms or refuses
      // the binding is not this test's concern.
    }
  });
  assert.equal(
    injectedExecuteCalls,
    0,
    "auditResponse must never call a forged 4th argument's execute for the outcome checkpoint",
  );
});

test("cli audit-ruling: succeeds with the auditor's handle, and refuses without one", async (t) => {
  const fixture = kickoff(t);
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditObjection(fixture.org, fixture.worktreeId, {
      checkpoint: "brief",
      target: { type: "criterion", id: "c1" },
      kind: "gap",
      description: "criterion c1 is not clearly derived from the brief",
      rebuttalRequested: "point to the brief section it comes from",
    }),
  );
  const objectionId = readAudit(
    fixture.org,
    fixture.worktreeId,
  ).checkpoints.brief.objections.at(-1).id;
  const evidencePath = "brief-evidence-2.txt";
  fs.writeFileSync(path.join(fixture.dir, evidencePath), "brief section 2\n");
  const { audit } = await withCwd(fixture.dir, () =>
    auditResponse(fixture.org, fixture.worktreeId, {
      checkpoint: "brief",
      objectionId,
      argument: "c1 traces to brief section 2",
      evidenceRefs: [
        {
          path: evidencePath,
          sha256: fileSha256(path.join(fixture.dir, evidencePath)),
        },
      ],
    }),
  );
  const responseId = audit.checkpoints.brief.responses.at(-1).id;
  const requestFile = path.join(fixture.dir, "ruling-request.json");
  fs.writeFileSync(
    requestFile,
    JSON.stringify({
      checkpoint: "brief",
      objectionId,
      respondedAgainst: responseId,
      verdict: "persuaded",
      reason: "evidence supports the claim",
    }),
  );
  const refused = runCli(
    [
      "audit-ruling",
      "--org",
      fixture.org,
      "--worktree",
      fixture.worktreeId,
      "--from",
      requestFile,
    ],
    { cwd: fixture.dir, env: { ORCA_TERMINAL_HANDLE: null } },
  );
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /ORCA_TERMINAL_HANDLE is not set/);

  const succeeded = runCli(
    [
      "audit-ruling",
      "--org",
      fixture.org,
      "--worktree",
      fixture.worktreeId,
      "--from",
      requestFile,
    ],
    { cwd: fixture.dir, env: { ORCA_TERMINAL_HANDLE: fixture.auditorHandle } },
  );
  assert.equal(succeeded.code, 0, succeeded.stderr);
  assert.equal(JSON.parse(succeeded.stdout).recorded, true);
});

test("cli audit-checked: succeeds with the auditor's handle, and refuses without one", (t) => {
  const fixture = kickoff(t);
  const requestFile = path.join(fixture.dir, "checked-request.json");
  fs.writeFileSync(
    requestFile,
    JSON.stringify({
      checked: [
        { type: "statement", id: "s1" },
        { type: "criterion", id: "c1" },
      ],
    }),
  );
  const refused = runCli(
    [
      "audit-checked",
      "--org",
      fixture.org,
      "--worktree",
      fixture.worktreeId,
      "--checkpoint",
      "brief",
      "--from",
      requestFile,
    ],
    { cwd: fixture.dir, env: { ORCA_TERMINAL_HANDLE: null } },
  );
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /ORCA_TERMINAL_HANDLE is not set/);

  const succeeded = runCli(
    [
      "audit-checked",
      "--org",
      fixture.org,
      "--worktree",
      fixture.worktreeId,
      "--checkpoint",
      "brief",
      "--from",
      requestFile,
    ],
    { cwd: fixture.dir, env: { ORCA_TERMINAL_HANDLE: fixture.auditorHandle } },
  );
  assert.equal(succeeded.code, 0, succeeded.stderr);
  assert.equal(JSON.parse(succeeded.stdout).recorded, true);
});

test("cli audit-accept: succeeds with the auditor's handle once checked coverage holds, and refuses without one", async (t) => {
  const fixture = kickoff(t);
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditChecked(fixture.org, fixture.worktreeId, "brief", [
      { type: "statement", id: "s1" },
      { type: "criterion", id: "c1" },
    ]),
  );
  const refused = runCli(
    [
      "audit-accept",
      "--org",
      fixture.org,
      "--worktree",
      fixture.worktreeId,
      "--checkpoint",
      "brief",
    ],
    { cwd: fixture.dir, env: { ORCA_TERMINAL_HANDLE: null } },
  );
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /ORCA_TERMINAL_HANDLE is not set/);

  const succeeded = runCli(
    [
      "audit-accept",
      "--org",
      fixture.org,
      "--worktree",
      fixture.worktreeId,
      "--checkpoint",
      "brief",
    ],
    { cwd: fixture.dir, env: { ORCA_TERMINAL_HANDLE: fixture.auditorHandle } },
  );
  assert.equal(succeeded.code, 0, succeeded.stderr);
  assert.equal(JSON.parse(succeeded.stdout).accepted, true);
});

// verifiedPm no longer accepts any executable/execute/factory override at
// all (B.6, decision B, item i): it always calls runTrustedOrcaJson with no
// options, so there is nothing left here for a test to inject and observe.
// That runTrustedOrcaJson itself builds its invocation through
// trustedOrcaExecute, with TRUSTED_ORCA_EXECUTABLE_PLACEHOLDER discarded as
// argv[0], is covered by tests/orca-adapter.test.mjs's own
// runTrustedOrcaJson unit tests instead.

// (i, auditor-launch half) resolveAuditorLaunchExecution is what
// teams-org.mjs's "role-terminal" case uses to decide the executable
// placeholder, command runner, and version-probe executable an auditor
// launch (or any other role's launch) gets. The auditor branch must always
// return the trusted invocation regardless of what --orca the caller passed
// (role-terminal already asserts --orca absent there; this confirms the
// fallback itself never reads it either), and must never fall through to
// the caller's own value. `versionExecutable` must be the trusted script's
// own resolved real path (from `resolveScriptPath`), never the placeholder:
// readLaunchEnvironment's `orca --version` probe reads `executable`
// directly, not through the paired `execute`, and the placeholder is not a
// runnable name on its own. The non-auditor branch must do the opposite:
// pass --orca through unchanged for both `executable` and
// `versionExecutable`, and build no trusted runner at all.
test("resolveAuditorLaunchExecution: auditor branch always returns the trusted invocation and script path; non-auditor branch passes --orca through unchanged", () => {
  let factoryCalls = 0;
  let resolveScriptPathCalls = 0;
  const fakeTrustedExecute = async () => ({ code: 0 });
  const fakeFactory = () => {
    factoryCalls += 1;
    return fakeTrustedExecute;
  };
  const fakeResolveScriptPath = () => {
    resolveScriptPathCalls += 1;
    return "/resolved/trusted-orca-script";
  };

  const auditorResult = resolveAuditorLaunchExecution({
    auditorEntry: { pm: { worktreeId: "wt-1" } },
    orcaArg: "/tmp/forged-orca-for-omt-auditor-test",
    trustedExecuteFactory: fakeFactory,
    resolveScriptPath: fakeResolveScriptPath,
  });
  assert.equal(auditorResult.executable, TRUSTED_ORCA_EXECUTABLE_PLACEHOLDER);
  assert.equal(auditorResult.execute, fakeTrustedExecute);
  assert.equal(
    auditorResult.versionExecutable,
    "/resolved/trusted-orca-script",
  );
  assert.equal(factoryCalls, 1);
  assert.equal(resolveScriptPathCalls, 1);

  const nonAuditorResult = resolveAuditorLaunchExecution({
    auditorEntry: undefined,
    orcaArg: "/some/legitimate/orca",
    trustedExecuteFactory: fakeFactory,
    resolveScriptPath: fakeResolveScriptPath,
  });
  assert.equal(nonAuditorResult.executable, "/some/legitimate/orca");
  assert.equal(nonAuditorResult.execute, undefined);
  assert.equal(nonAuditorResult.versionExecutable, "/some/legitimate/orca");
  // The non-auditor branch must not build a trusted runner or resolve a
  // trusted script path at all.
  assert.equal(factoryCalls, 1);
  assert.equal(resolveScriptPathCalls, 1);
});

// --- accept-bypass fail-closed minimal counterexamples -------------------
// kickoff()'s `pm` path is a plain subdirectory of the owner repo, never a
// real Git worktree, so it cannot exercise resolveRegisteredKickoffFromState's
// git-common-dir-based worktree identification at all: that check needs
// `pm.stateDir` to sit inside an actual `git worktree add` checkout. This
// fixture builds one, with its `.omt` created up front (a registered
// stateDir that never gets created on disk is not this check's concern) and
// named after the PM worktree's own root so it falls inside
// changedWorkspaceFiles' repo-root `.omt` exception the same way a real PM
// worktree's state directory would.
function registeredKickoffProject(t, worktreeId) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "omt-registered-")),
  );
  t.after(() =>
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    }),
  );
  const owner = path.join(root, "owner");
  fs.mkdirSync(owner, { recursive: true });
  initRepo(owner);
  const org = path.join(owner, ".omt", "organization.json");
  fs.mkdirSync(path.dirname(org), { recursive: true });
  fs.copyFileSync(exampleOrg, org);
  const brief = path.join(owner, ".omt", "brief.md");
  fs.writeFileSync(brief, "goal, acceptance criteria, non-goals\n");

  const pmWorktree = path.join(root, "pm-wt");
  git(owner, [
    "worktree",
    "add",
    "-q",
    "-b",
    `${worktreeId}-branch`,
    pmWorktree,
  ]);
  const stateDir = path.join(pmWorktree, ".omt");
  fs.mkdirSync(stateDir, { recursive: true });
  const head = git(pmWorktree, ["rev-parse", "HEAD"]);
  const auditorHandle = `term_auditor_${worktreeId}`;

  registerKickoff(org, {
    goal: `deliver ${worktreeId}`,
    pm: { worktreeId, path: pmWorktree, stateDir },
    organizationRevision: readJSON(org).revision,
    brief,
    delivery: { mode: "none" },
    requirements: minimalRequirements(org, worktreeId),
    director: {
      terminalHandle: `term_director_${worktreeId}`,
      checkoutPath: owner,
    },
  });
  bindKickoffRun(org, { worktreeId, runId: `run-${worktreeId}` });
  const [entry] = listKickoffs(org, worktreeId).kickoffs;
  recordLaunch(org, {
    via: "role-terminal",
    role: AUDITOR_ROLE,
    terminal: auditorHandle,
    stateDir: entry.pm.stateDir,
  });

  return {
    root,
    owner,
    org,
    brief,
    pmWorktree,
    // Aliases so this fixture also fits the existing objectAndResolve/
    // recordOutcomeResponseDirectly helpers above, which read fixture.repo
    // and fixture.dir.
    repo: pmWorktree,
    dir: pmWorktree,
    stateDir,
    worktreeId,
    entry,
    auditorHandle,
    head,
  };
}

async function passingReportFor(fixture, task, runId) {
  return {
    taskId: task.id,
    taskHash: taskHash(task),
    taskRevision: task.revision,
    runId,
    evidence: await verify(fixture.pmWorktree, {
      baseRef: task.baseRef,
      commands: task.checks,
      environment: task.environment,
      store: path.join(fixture.stateDir, "evidence"),
    }),
  };
}

function decisionFor(id) {
  return {
    schemaVersion: 1,
    id,
    decider: { kind: "pm", executionId: "pm-1" },
    criteria: ["check"],
    basis: "Check passed",
  };
}

test("registered PM stateDir: acceptOutcome resolves the kickoff from stateDir itself and refuses on any option mismatch or unresolved objection", async (t) => {
  const fixture = registeredKickoffProject(t, "wt-registered-a");
  const task = gapTask(fixture.worktreeId);
  // Written before verify() runs, so the workspace tree the report's
  // evidence binds to already includes it; writing it after would make the
  // later, second acceptOutcome call see stale evidence (evidence.mjs's
  // validateEvidence compares against the tree verify() actually recorded).
  const evidencePath = "evidence.txt";
  fs.writeFileSync(path.join(fixture.pmWorktree, evidencePath), "proof\n");
  const report = await passingReportFor(fixture, task, "run-a");

  await withOrcaHandle(fixture.auditorHandle, () =>
    auditObjection(fixture.org, fixture.worktreeId, {
      checkpoint: "outcome",
      target: { type: "criterion", id: "c1" },
      kind: "gap",
      description: "criterion c1 does not look delivered",
      rebuttalRequested: "show where it is delivered",
      resultHead: fixture.head,
      repo: fixture.pmWorktree,
    }),
  );

  // (a) Omitting every option still identifies the registered kickoff from
  // stateDir alone, so the unresolved objection still refuses acceptance —
  // a direct import of the public API cannot dodge it either.
  await assert.rejects(
    () =>
      acceptOutcome(
        fixture.pmWorktree,
        task,
        report,
        decisionFor("accept-a-1"),
        fixture.stateDir,
      ),
    /outcome audit checkpoint has an unresolved objection/,
  );

  // (c) A caller-supplied orgFile that names a different (non-existent)
  // organization than the one stateDir actually resolves to is refused
  // before the objection check even runs.
  await assert.rejects(
    () =>
      acceptOutcome(
        fixture.pmWorktree,
        task,
        report,
        decisionFor("accept-a-2"),
        fixture.stateDir,
        { orgFile: path.join(fixture.root, "does-not-exist.json") },
      ),
    /orgFile does not match this state directory's registered kickoff/,
  );

  // A caller-supplied worktreeId that names a different kickoff is refused.
  await assert.rejects(
    () =>
      acceptOutcome(
        fixture.pmWorktree,
        task,
        report,
        decisionFor("accept-a-3"),
        fixture.stateDir,
        { worktreeId: "some-other-worktree" },
      ),
    /worktreeId does not match this state directory's registered kickoff/,
  );

  // (o) A caller-supplied kickoffHash that does not match the registered
  // kickoff's own hash is refused.
  await assert.rejects(
    () =>
      acceptOutcome(
        fixture.pmWorktree,
        task,
        report,
        decisionFor("accept-a-4"),
        fixture.stateDir,
        { kickoffHash: "f".repeat(64) },
      ),
    /kickoffHash does not match this state directory's registered kickoff/,
  );

  // (h) Once the objection is resolved, omitting every option still
  // succeeds: the registry, not the caller, supplies orgFile/worktreeId/
  // kickoffHash.
  const objectionId = readAudit(
    fixture.org,
    fixture.worktreeId,
  ).checkpoints.outcome.objections.at(-1).id;
  const { audit } = recordOutcomeResponseDirectly(fixture, {
    objectionId,
    argument: "c1 is delivered; see the cited evidence",
    evidenceRefs: [
      {
        path: evidencePath,
        sha256: fileSha256(path.join(fixture.pmWorktree, evidencePath)),
      },
    ],
  });
  const responseId = audit.checkpoints.outcome.responses.at(-1).id;
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditRuling(fixture.org, fixture.worktreeId, {
      checkpoint: "outcome",
      objectionId,
      respondedAgainst: responseId,
      verdict: "persuaded",
      reason: "evidence supports the claim",
    }),
  );

  const { decision: recorded } = await acceptOutcome(
    fixture.pmWorktree,
    task,
    report,
    decisionFor("accept-a-5"),
    fixture.stateDir,
  );
  assert.equal(recorded.status, "accepted");
});

test("isSameOrWithin: case-insensitive Windows-shaped comparisons (path.win32 injected) and POSIX comparisons", () => {
  const win32 = { path: path.win32, platform: "win32" };
  // Identical directory spelled with different casing counts as the same
  // directory (not merely "child inside parent"): a raw `===` on the
  // un-normalized arguments would miss this, since Windows' filesystem is
  // case-preserving, not case-normalizing.
  assert.equal(isSameOrWithin("C:\\A\\PM", "c:\\a\\pm", win32), true);
  // A directory nested arbitrarily deep inside the parent.
  assert.equal(isSameOrWithin("c:\\a\\pm", "c:\\a\\pm\\x\\.omt", win32), true);
  // A sibling directory that merely shares a name prefix is not "inside".
  assert.equal(isSameOrWithin("c:\\a\\pm", "C:\\a\\pm-other", win32), false);
  // The parent's own ancestor is not "inside" it either.
  assert.equal(isSameOrWithin("c:\\a\\pm", "C:\\a", win32), false);
  // An identically-spelled path on a different drive is unrelated.
  assert.equal(isSameOrWithin("c:\\a\\pm", "D:\\a\\pm", win32), false);

  // Same shapes on POSIX, with `path.posix`/`platform: "linux"` injected so
  // these assertions hold regardless of which host actually runs the suite.
  const posix = { path: path.posix, platform: "linux" };
  assert.equal(isSameOrWithin("/a/pm", "/a/pm", posix), true);
  assert.equal(isSameOrWithin("/a/pm", "/a/pm/x/.omt", posix), true);
  assert.equal(isSameOrWithin("/a/pm", "/a/pm-other", posix), false);
  assert.equal(isSameOrWithin("/a/pm", "/a", posix), false);
});

test("isIdenticalDirectory: prefers real device+inode identity, and falls back to a STRICT (never casefolded) text match only when the inode cannot be trusted", (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "omt-identical-dir-")),
  );
  t.after(() =>
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 }),
  );
  const dirA = path.join(root, "pm-wt");
  const dirB = path.join(root, "pm-wt-other");
  fs.mkdirSync(dirA);
  fs.mkdirSync(dirB);

  // Real, distinct sibling directories are never conflated by dev/ino, and a
  // directory is identical to itself, with no injected stat at all: this is
  // the actual filesystem, not a simulation.
  assert.equal(isIdenticalDirectory(dirA, dirB), false);
  assert.equal(isIdenticalDirectory(dirA, dirA), true);

  // ino: 0n on either side is treated as untrustworthy (some Windows
  // filesystems report it for paths they track no real inode for), so
  // comparison drops to a byte-for-byte text match instead of either
  // declaring a false match or refusing to decide.
  const unreliableStat = () => ({ dev: 1n, ino: 0n });
  assert.equal(
    isIdenticalDirectory(dirA, dirA, { stat: unreliableStat }),
    true,
    "identical text still counts as the same directory once inode is unreliable",
  );
  assert.equal(
    isIdenticalDirectory(dirA, dirB, { stat: unreliableStat }),
    false,
    "different text is still different once inode is unreliable",
  );
  // Exact-match identity must NOT casefold once the inode is unreliable:
  // Windows can configure a directory to be case-sensitive, so
  // `C:\A\PM` and `c:\a\pm` can be two genuinely distinct directories even
  // there. Treating them as identical here would let a differently-cased
  // directory be misidentified as the registered stateDir and dodge its
  // unresolved objection entirely -- this is the accept-bypass the director
  // flagged when a prior draft of this test asserted `true` here instead.
  // Real Windows inode-reliability and per-directory case-sensitivity
  // behavior is confirmed by this repository's own Windows CI runner, not
  // simulated in this test.
  assert.equal(
    isIdenticalDirectory("C:\\A\\PM", "c:\\a\\pm", { stat: unreliableStat }),
    false,
    "exact-match identity must not casefold two differently-cased paths even when the inode is unreliable",
  );
});

test("isSameOrWithinByIdentity: allows a casefold-only ancestor match once the inode is untrustworthy, unlike isIdenticalDirectory's exact-match role", () => {
  const unreliableStat = () => ({ dev: 1n, ino: 0n });
  // Forward-slash-separated pseudo-Windows paths, not backslash ones: the
  // ancestor walk itself always uses this host's own `path.dirname` (it has
  // no injectable `path` implementation the way `isSameOrWithin` does), and
  // this suite may run on a POSIX host, whose `path.dirname` does not treat
  // `\` as a separator. `platform: "win32"` here drives only the casefold
  // normalization inside the per-step comparison, independent of that.

  // Same directory, same casing: matches regardless of inode reliability.
  assert.equal(
    isSameOrWithinByIdentity("c:/pm/pm-wt", "c:/pm/pm-wt", {
      platform: "win32",
      stat: unreliableStat,
    }),
    true,
  );
  // A genuinely nested child, reached through a casefold-only spelling of
  // its ancestor, is still recognized as "inside" once the inode cannot be
  // trusted: unlike exact-match identity, casefold-equating an ancestor here
  // only ever produces an ANCESTOR refusal ("shares the registered
  // worktree"), never an exact-match acceptance, so over-broad matching is
  // the safe direction to err in. Real Windows inode-reliability and
  // per-directory case-sensitivity behavior is confirmed by this
  // repository's own Windows CI runner, not simulated in this test.
  assert.equal(
    isSameOrWithinByIdentity("C:/PM/PM-WT", "c:/pm/pm-wt/.omt/inner", {
      platform: "win32",
      stat: unreliableStat,
    }),
    true,
  );
  // An unrelated sibling never casefold-matches, inode-unreliable or not.
  assert.equal(
    isSameOrWithinByIdentity("C:/PM/PM-WT", "c:/pm/pm-wt-other", {
      platform: "win32",
      stat: unreliableStat,
    }),
    false,
  );
});

test("accept refuses a stateDir sharing the registered worktree but keeps accepting a separate unregistered worktree unchanged", async (t) => {
  const fixture = registeredKickoffProject(t, "wt-registered-b");

  // (m) A directory that shares the registered kickoff's own worktree but is
  // not the exact stateDir it registered is refused, not treated as solo.
  const otherStateDir = path.join(fixture.pmWorktree, ".omt-other");
  fs.mkdirSync(otherStateDir, { recursive: true });
  const taskM = gapTask(`${fixture.worktreeId}-m`);
  const reportM = {
    taskId: taskM.id,
    taskHash: taskHash(taskM),
    taskRevision: taskM.revision,
    runId: "run-m",
    evidence: await verify(fixture.pmWorktree, {
      baseRef: taskM.baseRef,
      commands: taskM.checks,
      environment: taskM.environment,
      store: path.join(otherStateDir, "evidence"),
    }),
  };
  await assert.rejects(
    () =>
      acceptOutcome(
        fixture.pmWorktree,
        taskM,
        reportM,
        decisionFor("accept-b-m"),
        otherStateDir,
      ),
    /shares the registered kickoff's own worktree but is not the exact state directory it registered/,
  );

  // (H) A directory INSIDE the registered stateDir itself, not merely
  // somewhere else in the worktree, is refused the same way: depth from
  // pm.path is unbounded, so nesting one level deeper than the registered
  // `.omt` itself does not dodge this. Its evidence store still sits under
  // `.omt/`, which `changedWorkspaceFiles` (evidence.mjs, #63) already
  // excludes at the worktree root, so no `.git/info/exclude` entry is needed
  // for this one to avoid a spurious "Stale evidence" masking the rejection.
  const innerStateDir = path.join(fixture.stateDir, "inner");
  fs.mkdirSync(innerStateDir, { recursive: true });
  const taskH = gapTask(`${fixture.worktreeId}-h`);
  const reportH = {
    taskId: taskH.id,
    taskHash: taskHash(taskH),
    taskRevision: taskH.revision,
    runId: "run-h",
    evidence: await verify(fixture.pmWorktree, {
      baseRef: taskH.baseRef,
      commands: taskH.checks,
      environment: taskH.environment,
      store: path.join(innerStateDir, "evidence"),
    }),
  };
  await assert.rejects(
    () =>
      acceptOutcome(
        fixture.pmWorktree,
        taskH,
        reportH,
        decisionFor("accept-b-h"),
        innerStateDir,
      ),
    /shares the registered kickoff's own worktree but is not the exact state directory it registered/,
  );

  // (G) A stateDir nested at an arbitrary depth elsewhere in the worktree
  // (not a direct child of pm.path, nor inside the registered stateDir) is
  // refused the same way, and the anchor check runs (gates.mjs) BEFORE
  // gateCheck/validateEvidence ever inspects the report's evidence, so this
  // must hold regardless of whether this stateDir's own evidence files would
  // otherwise show up as workspace drift. Both sub-scenarios are checked:
  // without a `.git/info/exclude` entry for it (where this evidence store's
  // own files DO show up as untracked drift to evidence.mjs) and with one
  // (where they do not), so a future regression that moves the anchor check
  // to run after evidence validation would surface as "Stale evidence" in the
  // first sub-scenario instead of silently passing for the wrong reason.
  const subPlainStateDir = path.join(fixture.pmWorktree, "sub-plain", ".omt");
  fs.mkdirSync(subPlainStateDir, { recursive: true });
  const taskG1 = gapTask(`${fixture.worktreeId}-g1`);
  const reportG1 = {
    taskId: taskG1.id,
    taskHash: taskHash(taskG1),
    taskRevision: taskG1.revision,
    runId: "run-g1",
    evidence: await verify(fixture.pmWorktree, {
      baseRef: taskG1.baseRef,
      commands: taskG1.checks,
      environment: taskG1.environment,
      store: path.join(subPlainStateDir, "evidence"),
    }),
  };
  await assert.rejects(
    () =>
      acceptOutcome(
        fixture.pmWorktree,
        taskG1,
        reportG1,
        decisionFor("accept-b-g1"),
        subPlainStateDir,
      ),
    /shares the registered kickoff's own worktree but is not the exact state directory it registered/,
  );

  // `pmWorktree` is a `git worktree add` checkout, so its `.git` is a text
  // file naming the real gitdir, not a directory: `info/exclude` lives once,
  // shared across worktrees, at the owner repository's own `.git`.
  fs.appendFileSync(
    path.join(fixture.owner, ".git", "info", "exclude"),
    "sub-excluded/\n",
  );
  const subStateDir = path.join(fixture.pmWorktree, "sub-excluded", ".omt");
  fs.mkdirSync(subStateDir, { recursive: true });
  const taskG = gapTask(`${fixture.worktreeId}-g2`);
  const reportG = {
    taskId: taskG.id,
    taskHash: taskHash(taskG),
    taskRevision: taskG.revision,
    runId: "run-g2",
    evidence: await verify(fixture.pmWorktree, {
      baseRef: taskG.baseRef,
      commands: taskG.checks,
      environment: taskG.environment,
      store: path.join(subStateDir, "evidence"),
    }),
  };
  await assert.rejects(
    () =>
      acceptOutcome(
        fixture.pmWorktree,
        taskG,
        reportG,
        decisionFor("accept-b-g"),
        subStateDir,
      ),
    /shares the registered kickoff's own worktree but is not the exact state directory it registered/,
  );

  // (I) Same as G, several levels deeper, confirming depth is truly
  // unbounded rather than merely "one level past a direct child".
  fs.appendFileSync(
    path.join(fixture.owner, ".git", "info", "exclude"),
    "a/\n",
  );
  const deepStateDir = path.join(fixture.pmWorktree, "a", "b", "c");
  fs.mkdirSync(deepStateDir, { recursive: true });
  const taskI = gapTask(`${fixture.worktreeId}-i`);
  const reportI = {
    taskId: taskI.id,
    taskHash: taskHash(taskI),
    taskRevision: taskI.revision,
    runId: "run-i",
    evidence: await verify(fixture.pmWorktree, {
      baseRef: taskI.baseRef,
      commands: taskI.checks,
      environment: taskI.environment,
      store: path.join(deepStateDir, "evidence"),
    }),
  };
  await assert.rejects(
    () =>
      acceptOutcome(
        fixture.pmWorktree,
        taskI,
        reportI,
        decisionFor("accept-b-i"),
        deepStateDir,
      ),
    /shares the registered kickoff's own worktree but is not the exact state directory it registered/,
  );

  // (f) A genuinely different worktree of the same owner repository (a
  // Senior/Worker child worktree's own solo task state, for instance) is not
  // registered under this kickoff and must keep accepting unchanged: the
  // fail-closed scope covers the registered kickoff's own worktree only.
  const childWorktree = path.join(fixture.root, "child-wt");
  git(fixture.owner, [
    "worktree",
    "add",
    "-q",
    "-b",
    "child-branch",
    childWorktree,
  ]);
  const childStateDir = path.join(childWorktree, ".omt");
  fs.mkdirSync(childStateDir, { recursive: true });
  const taskF = gapTask(`${fixture.worktreeId}-f`);
  const reportF = {
    taskId: taskF.id,
    taskHash: taskHash(taskF),
    taskRevision: taskF.revision,
    runId: "run-f",
    evidence: await verify(childWorktree, {
      baseRef: taskF.baseRef,
      commands: taskF.checks,
      environment: taskF.environment,
      store: path.join(childStateDir, "evidence"),
    }),
  };
  const { decision: recordedF } = await acceptOutcome(
    childWorktree,
    taskF,
    reportF,
    decisionFor("accept-b-f"),
    childStateDir,
  );
  assert.equal(recordedF.status, "accepted");
});

// Detects, on the actual filesystem under test, whether a directory created
// with one casing can also be reached by spelling its name in another case:
// true on a case-preserving-but-insensitive volume (macOS's/Windows' default
// filesystems), false on a case-sensitive one (most Linux filesystems, as CI
// runs on), where the uppercased probe name never exists at all. The probe
// name is hex-only so `.toUpperCase()` actually changes it (a name with no
// letters would trivially "pass" on a case-sensitive filesystem too).
function isFilesystemCaseInsensitive(dir) {
  const name = `case-probe-${crypto.randomBytes(4).toString("hex")}`;
  const probe = path.join(dir, name);
  fs.mkdirSync(probe);
  try {
    return fs.existsSync(path.join(dir, name.toUpperCase()));
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

test("accept identifies a differently-cased spelling of the registered stateDir as itself, not an anchor mismatch (case-insensitive filesystems only)", async (t) => {
  const fixture = registeredKickoffProject(t, "wt-registered-h");
  if (!isFilesystemCaseInsensitive(fixture.root)) {
    t.skip(
      "this filesystem is case-sensitive, so a differently-cased path does not name the same on-disk directory to begin with",
    );
    return;
  }

  const task = gapTask(`${fixture.worktreeId}-case`);
  const evidencePath = "evidence-case.txt";
  fs.writeFileSync(path.join(fixture.pmWorktree, evidencePath), "proof\n");
  const report = await passingReportFor(fixture, task, "run-case");

  await withOrcaHandle(fixture.auditorHandle, () =>
    auditObjection(fixture.org, fixture.worktreeId, {
      checkpoint: "outcome",
      target: { type: "criterion", id: "c1" },
      kind: "gap",
      description: "criterion c1 does not look delivered",
      rebuttalRequested: "show where it is delivered",
      resultHead: fixture.head,
      repo: fixture.pmWorktree,
    }),
  );

  const upperWorktree = path.join(
    path.dirname(fixture.pmWorktree),
    path.basename(fixture.pmWorktree).toUpperCase(),
  );

  // (M) The registered stateDir itself, spelled with its worktree segment
  // uppercased, is still the exact registered directory: identified by
  // device+inode, since `fs.realpathSync.native`'s own text canonicalization
  // is not trusted alone to have already normalized this. The unresolved
  // objection refuses it, not the "sits inside worktree ... but is not the
  // exact state directory" anchor message a text-only comparison used to
  // produce for this same directory.
  const stateDirViaUpperWorktree = path.join(upperWorktree, ".omt");
  await assert.rejects(
    () =>
      acceptOutcome(
        fixture.pmWorktree,
        task,
        report,
        decisionFor("accept-h-m"),
        stateDirViaUpperWorktree,
      ),
    /outcome audit checkpoint has an unresolved objection/,
  );

  // (O) The registered stateDir spelled with only its own ".omt" segment
  // uppercased is the same directory too, and is refused the same way.
  const stateDirViaUpperOmt = path.join(fixture.pmWorktree, ".OMT");
  await assert.rejects(
    () =>
      acceptOutcome(
        fixture.pmWorktree,
        task,
        report,
        decisionFor("accept-h-o"),
        stateDirViaUpperOmt,
      ),
    /outcome audit checkpoint has an unresolved objection/,
  );

  // Once the objection is resolved, accept succeeds through the
  // differently-cased spelling too: it is genuinely the same registration,
  // not merely tolerated by some separate anchor exception.
  const objectionId = readAudit(
    fixture.org,
    fixture.worktreeId,
  ).checkpoints.outcome.objections.at(-1).id;
  const { audit } = recordOutcomeResponseDirectly(fixture, {
    objectionId,
    argument: "c1 is delivered; see the cited evidence",
    evidenceRefs: [
      {
        path: evidencePath,
        sha256: fileSha256(path.join(fixture.pmWorktree, evidencePath)),
      },
    ],
  });
  const responseId = audit.checkpoints.outcome.responses.at(-1).id;
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditRuling(fixture.org, fixture.worktreeId, {
      checkpoint: "outcome",
      objectionId,
      respondedAgainst: responseId,
      verdict: "persuaded",
      reason: "evidence supports the claim",
    }),
  );
  const { decision: recorded } = await acceptOutcome(
    fixture.pmWorktree,
    task,
    report,
    decisionFor("accept-h-resolved"),
    stateDirViaUpperWorktree,
  );
  assert.equal(recorded.status, "accepted");
});

test("accept still refuses a genuinely different nested stateDir reached through a differently-cased spelling (case-insensitive filesystems only)", async (t) => {
  const fixture = registeredKickoffProject(t, "wt-registered-i");
  if (!isFilesystemCaseInsensitive(fixture.root)) {
    t.skip(
      "this filesystem is case-sensitive, so a differently-cased path does not name the same on-disk directory to begin with",
    );
    return;
  }

  const upperWorktree = path.join(
    path.dirname(fixture.pmWorktree),
    path.basename(fixture.pmWorktree).toUpperCase(),
  );

  const cases = [
    // (N) Genuinely nested one level inside the registered stateDir, reached
    // through the worktree segment uppercased.
    { label: "n", stateDir: path.join(upperWorktree, ".omt", "inner") },
    // Same nesting, reached instead through the stateDir's own ".omt"
    // segment uppercased.
    {
      label: "omt-inner",
      stateDir: path.join(fixture.pmWorktree, ".OMT", "inner"),
    },
    // A different subdirectory of the worktree entirely (not inside the
    // registered stateDir at all), reached through the uppercased worktree.
    { label: "sub", stateDir: path.join(upperWorktree, "sub", ".omt") },
  ];

  for (const { label, stateDir } of cases) {
    fs.mkdirSync(stateDir, { recursive: true });
    const task = gapTask(`${fixture.worktreeId}-${label}`);
    const report = {
      taskId: task.id,
      taskHash: taskHash(task),
      taskRevision: task.revision,
      runId: `run-${label}`,
      evidence: await verify(fixture.pmWorktree, {
        baseRef: task.baseRef,
        commands: task.checks,
        environment: task.environment,
        store: path.join(stateDir, "evidence"),
      }),
    };
    await assert.rejects(
      () =>
        acceptOutcome(
          fixture.pmWorktree,
          task,
          report,
          decisionFor(`accept-i-${label}`),
          stateDir,
        ),
      /shares the registered kickoff's own worktree but is not the exact state directory it registered/,
      `case ${label} must be refused as sharing the registered worktree, not silently accepted`,
    );
  }
});

test("accept refuses when the registered entry is an integrity-failure (registered after documentSystemActivatedAt but missing registrationSeq)", async (t) => {
  const fixture = registeredKickoffProject(t, "wt-registered-c");
  // Backdating documentSystemActivatedAt ahead of the entry's own createdAt
  // reclassifies its (perfectly normal) missing-registrationSeq shape as an
  // integrity-failure instead of ordinary legacy leniency.
  const org = readJSON(fixture.org);
  org.documentSystemActivatedAt = "2000-01-01T00:00:00Z";
  writeJSON(fixture.org, org);
  const entryPath = path.join(
    registryDirectory(fixture.org),
    `${kickoffEntryName(fixture.worktreeId)}.json`,
  );
  const entry = readJSON(entryPath);
  delete entry.registrationSeq;
  writeJSON(entryPath, entry);

  const task = gapTask(fixture.worktreeId);
  const report = await passingReportFor(fixture, task, "run-c");
  await assert.rejects(
    () =>
      acceptOutcome(
        fixture.pmWorktree,
        task,
        report,
        decisionFor("accept-c-1"),
        fixture.stateDir,
      ),
    /failed its integrity classification/,
  );
});

test("accept refuses when the owner organization.json cannot be parsed or fails schema validation", async (t) => {
  const fixture = registeredKickoffProject(t, "wt-registered-d");
  const task = gapTask(fixture.worktreeId);
  const report = await passingReportFor(fixture, task, "run-d");

  fs.writeFileSync(fixture.org, "{not json");
  await assert.rejects(() =>
    acceptOutcome(
      fixture.pmWorktree,
      task,
      report,
      decisionFor("accept-d-1"),
      fixture.stateDir,
    ),
  );

  writeJSON(fixture.org, { schemaVersion: 1 });
  await assert.rejects(() =>
    acceptOutcome(
      fixture.pmWorktree,
      task,
      report,
      decisionFor("accept-d-2"),
      fixture.stateDir,
    ),
  );
});

test("teams-org.mjs accept: the registered-kickoff anchor lookup never invokes a fake git planted first in PATH", async (t) => {
  const fixture = registeredKickoffProject(t, "wt-registered-e");
  const task = gapTask(fixture.worktreeId);
  const evidencePath = "evidence.txt";
  fs.writeFileSync(path.join(fixture.pmWorktree, evidencePath), "proof\n");
  const report = await passingReportFor(fixture, task, "run-e");

  await withOrcaHandle(fixture.auditorHandle, () =>
    auditObjection(fixture.org, fixture.worktreeId, {
      checkpoint: "outcome",
      target: { type: "criterion", id: "c1" },
      kind: "gap",
      description: "criterion c1 does not look delivered",
      rebuttalRequested: "show where it is delivered",
      resultHead: fixture.head,
      repo: fixture.pmWorktree,
    }),
  );

  const taskFile = path.join(fixture.root, "task-e.json");
  const reportFile = path.join(fixture.root, "report-e.json");
  const decisionFile = path.join(fixture.root, "decision-e.json");
  writeJSON(taskFile, task);
  writeJSON(reportFile, report);
  writeJSON(decisionFile, decisionFor("accept-e-1"));

  const fakeBinDir = path.join(fixture.root, "fake-bin");
  fs.mkdirSync(fakeBinDir, { recursive: true });
  const callLog = path.join(fixture.root, "fake-git-calls.log");
  // Records its own argv, then delegates to the real trusted git so the rest
  // of accept's flow still runs to completion instead of aborting on the
  // first PATH-resolved git call; only the recorded argv is inspected below.
  fs.writeFileSync(
    path.join(fakeBinDir, "git"),
    `#!/bin/sh\necho "$@" >> "${callLog}"\nexec /usr/bin/git "$@"\n`,
  );
  fs.chmodSync(path.join(fakeBinDir, "git"), 0o755);

  const result = runCli(
    [
      "accept",
      "--repo",
      fixture.pmWorktree,
      "--task",
      taskFile,
      "--report",
      reportFile,
      "--decision",
      decisionFile,
      "--state",
      fixture.stateDir,
    ],
    {
      cwd: fixture.pmWorktree,
      env: { PATH: `${fakeBinDir}:${process.env.PATH}` },
    },
  );

  assert.notEqual(
    result.code,
    0,
    "must still refuse for the unresolved objection",
  );
  assert.match(result.stderr, /unresolved objection/i);

  const calls = fs.existsSync(callLog)
    ? fs.readFileSync(callLog, "utf8").split("\n").filter(Boolean)
    : [];
  // Known limitation: evidence.mjs's own `git()` helper still spawns "git" by
  // bare name (PATH-resolved), so validateEvidence's fingerprint recompute
  // does run through the fake git above — that residual PATH exposure in the
  // evidence layer is a separately tracked follow-up, out of this test's
  // scope. What this test asserts is narrower: the registered-kickoff anchor
  // lookup (`resolveGitCommonDir` in local-adapter.mjs) never does, because it
  // always spawns the compiled-in trusted absolute path
  // (`resolveTrustedGitExecutable`) instead of a PATH-resolved "git", so no
  // recorded call here ever asks for `--git-common-dir`.
  assert.equal(
    calls.some((line) => line.includes("--git-common-dir")),
    false,
    "the registered-kickoff anchor lookup must never invoke a PATH-resolved git",
  );
});

test("teams-org.mjs accept: forged GIT_DIR/GIT_COMMON_DIR/GIT_WORK_TREE cannot steer the registered-kickoff anchor lookup, and accept still refuses", async (t) => {
  const fixture = registeredKickoffProject(t, "wt-registered-g");
  const decoyRepo = path.join(fixture.root, "decoy-repo");
  fs.mkdirSync(decoyRepo, { recursive: true });
  initRepo(decoyRepo);
  const forgedGitEnv = {
    GIT_DIR: path.join(decoyRepo, ".git"),
    GIT_COMMON_DIR: path.join(decoyRepo, ".git"),
    GIT_WORK_TREE: decoyRepo,
  };

  // Part A: the anchor lookup (kickoff-registry.mjs's
  // resolveRegisteredKickoffFromState, anchored on local-adapter.mjs's
  // resolveGitCommonDir) always spawns the compiled-in trusted git path with
  // a fixed, caller-uncontrollable environment, so it never reads GIT_DIR/
  // GIT_COMMON_DIR/GIT_WORK_TREE at all. Run it in a fresh child process
  // (not this test's own process) with and without those forged, and assert
  // its return value is identical either way — a direct, deterministic
  // check of the anchor lookup alone, independent of anything evidence.mjs
  // does afterwards.
  const probeSource =
    "import { resolveRegisteredKickoffFromState } from " +
    JSON.stringify(
      path.join(
        process.cwd(),
        "plugins/oh-my-teams/scripts/kickoff-registry.mjs",
      ),
    ) +
    ";\n" +
    "const resolved = await resolveRegisteredKickoffFromState(process.argv[1]);\n" +
    "process.stdout.write(JSON.stringify(resolved));\n";
  const runProbe = (env) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ["--input-type=module", "-e", probeSource, fixture.stateDir],
        { encoding: "utf8", env: { ...process.env, ...env } },
      ),
    );
  const clean = runProbe({});
  const forged = runProbe(forgedGitEnv);
  assert.deepEqual(forged, clean);
  assert.equal(clean.worktreeId, fixture.worktreeId);

  // Part B: at the CLI level, accept must not silently succeed while an
  // objection is unresolved, but this test does not assert exit 0 for the
  // no-objection case: evidence.mjs's own `git()` helper (kept reverted per
  // PM msg_6bd1ad2003fb) still spawns "git" through the caller's inherited
  // process environment, so it also inherits these same forged GIT_DIR/
  // GIT_COMMON_DIR/GIT_WORK_TREE and can recompute a different HEAD/base
  // from the decoy repo. A "Stale evidence" rejection here is that existing,
  // separately tracked evidence-layer environment exposure, NOT evidence
  // that the anchor lookup was steered to the decoy (part A above already
  // proves it was not). Only the unresolved-objection rejection is the
  // property this half actually needs; a stale-evidence rejection is
  // accepted as an equally safe (if noisier) outcome of the same forgery.
  const task = gapTask(fixture.worktreeId);
  const evidencePath = "evidence.txt";
  fs.writeFileSync(path.join(fixture.pmWorktree, evidencePath), "proof\n");
  const report = await passingReportFor(fixture, task, "run-g");
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditObjection(fixture.org, fixture.worktreeId, {
      checkpoint: "outcome",
      target: { type: "criterion", id: "c1" },
      kind: "gap",
      description: "criterion c1 does not look delivered",
      rebuttalRequested: "show where it is delivered",
      resultHead: fixture.head,
      repo: fixture.pmWorktree,
    }),
  );
  const taskFile = path.join(fixture.root, "task-g.json");
  const reportFile = path.join(fixture.root, "report-g.json");
  const decisionFile = path.join(fixture.root, "decision-g.json");
  writeJSON(taskFile, task);
  writeJSON(reportFile, report);
  writeJSON(decisionFile, decisionFor("accept-g-1"));

  const result = runCli(
    [
      "accept",
      "--repo",
      fixture.pmWorktree,
      "--task",
      taskFile,
      "--report",
      reportFile,
      "--decision",
      decisionFile,
      "--state",
      fixture.stateDir,
    ],
    { cwd: fixture.pmWorktree, env: forgedGitEnv },
  );
  assert.notEqual(
    result.code,
    0,
    "must not accept while an objection is unresolved",
  );
  assert.match(
    result.stderr,
    /unresolved objection|Stale evidence/i,
    `unexpected rejection reason: ${result.stderr}`,
  );
});

// Confirms the trusted-git candidate this platform actually resolves is
// real, so a CI runner whose Git lives somewhere else fails this assertion
// loudly instead of silently falling through to "no trusted git" fail-closed
// everywhere else.
test("a trusted git executable is actually found among this platform's compiled-in candidates", async () => {
  const { resolveTrustedGitExecutable } =
    await import("../plugins/oh-my-teams/scripts/local-adapter.mjs");
  const found = resolveTrustedGitExecutable();
  assert.equal(path.isAbsolute(found), true);
  assert.equal(fs.existsSync(found), true);
  assert.equal(fs.lstatSync(found).isFile(), true);
});

// D1 (director decision msg_0b114271f1f5, PM supplement msg_901f9291b1d3):
// a kickoff's audit obligation is decided once, from its registry entry's
// auditPolicy — pinned at kickoff-claim time by registerKickoff, or
// backfilled onto a legacy entry exactly once through
// kickoffAuditPolicyRetrofit — and never by a fresh organization.json read.
// The six counterexamples below are the director's own list.

test(
  "D1 #1: an auditor-pinned kickoff's close-ready, deliver and completed kickoff-release still require " +
    "audit acceptance after org.auditor is removed from the live organization.json (no fallback substitutes for it)",
  async (t) => {
    const fixture = kickoff(t, "wt-1", {
      auditor: { profile: "claude-current" },
    });
    assert.equal(fixture.entry.auditPolicy.auditorConfigured, true);

    // Clear assertLedgerCloseReady's own fidelity gate first, so every
    // rejection below comes from the auditPolicy-driven audit-acceptance
    // check this test actually targets, not from a missing fidelity check.
    await requirementsFidelity(fixture.org, fixture.worktreeId, {
      head: fixture.head,
      repo: fixture.dir,
      recordedBy: "pm",
      items: [
        { type: "statement", id: "s1", status: "met", evidence: "README.md" },
        { type: "criterion", id: "c1", status: "met", evidence: "README.md" },
      ],
    });
    await requirementsFidelityConfirm(
      fixture.org,
      fixture.worktreeId,
      fixture.dir,
    );

    // Live org no longer declares an auditor at all; only this kickoff's own
    // pinned auditPolicy may still gate these calls.
    const org = readJSON(fixture.org);
    delete org.auditor;
    writeJSON(fixture.org, org);

    await assert.rejects(
      assertKickoffCloseReady(fixture.org, fixture.worktreeId, {
        head: fixture.head,
        repo: fixture.dir,
        entry: fixture.entry,
      }),
      /Brief audit acceptance is missing or no longer valid/,
    );

    await assert.rejects(
      deliverKickoff({
        orgFile: fixture.org,
        worktreeId: fixture.worktreeId,
        source: fixture.dir,
        head: fixture.head,
        callerCwd: fixture.dir,
      }),
      /Brief audit acceptance is missing or no longer valid/,
    );

    await assert.rejects(
      main([
        "director-signal",
        "--org",
        fixture.org,
        "--worktree",
        fixture.worktreeId,
        "--kind",
        "close-ready",
        "--text",
        "ready to close",
        "--head",
        fixture.head,
        "--source",
        fixture.dir,
      ]),
      /valid outcome-audit acceptance/,
    );

    await assert.rejects(
      releaseKickoff(fixture.org, {
        worktreeId: fixture.worktreeId,
        reason: "completed",
        head: fixture.head,
        repo: fixture.dir,
        callerCwd: fixture.dir,
      }),
      /Brief audit acceptance is missing or no longer valid/,
    );
  },
);

test(
  "D1 #2: kickoffAuditPolicyRetrofit pins a legacy entry's audit policy once, checking --profile/--fallbacks " +
    "against organization.json, and refuses to re-pin, relax or reaffirm that policy afterward",
  async (t) => {
    const fixture = legacyKickoff(t, "wt-legacy-1");
    assert.equal(fixture.entry.auditPolicy, undefined);

    // A profile or fallback not declared in organization.json is refused
    // before anything is pinned.
    assert.throws(
      () =>
        kickoffAuditPolicyRetrofit(fixture.org, fixture.worktreeId, {
          auditorConfigured: true,
          profile: "does-not-exist",
          fallbacks: [],
          reason: "director attests this kickoff always needed an auditor",
          callerCwd: fixture.dir,
        }),
      /--profile must name a profile declared in organization\.json/,
    );
    assert.throws(
      () =>
        kickoffAuditPolicyRetrofit(fixture.org, fixture.worktreeId, {
          auditorConfigured: true,
          profile: "claude-current",
          fallbacks: ["also-does-not-exist"],
          reason: "director attests this kickoff always needed an auditor",
          callerCwd: fixture.dir,
        }),
      /--fallbacks must be unique profiles declared in organization\.json/,
    );

    const result = kickoffAuditPolicyRetrofit(fixture.org, fixture.worktreeId, {
      auditorConfigured: true,
      profile: "claude-current",
      fallbacks: ["codex-current"],
      reason: "director attests this kickoff always needed an auditor",
      callerCwd: fixture.dir,
    });
    assert.equal(result.retrofitted, true);
    assert.equal(result.auditPolicy.auditorConfigured, true);
    assert.equal(result.auditPolicy.profile, "claude-current");
    assert.deepEqual(result.auditPolicy.fallbacks, ["codex-current"]);
    assert.equal(result.auditPolicy.source, "retrofit");
    assert.equal(result.auditPolicy.retrofittedFrom, "director-attestation");
    assert.equal(result.auditPolicy.corroboratingAuditorLaunch, false);

    // Re-pinning the very same values is refused exactly like relaxing or
    // reaffirming it would be: once pinned, this policy is permanent.
    for (const attempt of [
      {
        auditorConfigured: true,
        profile: "claude-current",
        fallbacks: ["codex-current"],
        reason: "re-confirming the same policy",
        callerCwd: fixture.dir,
      },
      {
        auditorConfigured: false,
        reason: "actually no auditor is needed",
        callerCwd: fixture.dir,
      },
    ]) {
      assert.throws(
        () =>
          kickoffAuditPolicyRetrofit(fixture.org, fixture.worktreeId, attempt),
        /already has a pinned audit policy/,
      );
    }
  },
);

test("D1 #2 (CLI): kickoff-audit-policy-retrofit pins once and refuses a second run from the CLI the same way", (t) => {
  const fixture = legacyKickoff(t, "wt-legacy-cli");
  const retrofit = (extraArgs) =>
    runCli(
      [
        "kickoff-audit-policy-retrofit",
        "--org",
        fixture.org,
        "--worktree",
        fixture.worktreeId,
        ...extraArgs,
      ],
      { cwd: fixture.dir },
    );

  const first = retrofit([
    "--auditor-configured",
    "true",
    "--profile",
    "claude-current",
    "--fallbacks",
    "codex-current,codex-luna",
    "--reason",
    "director backfills this legacy kickoff",
  ]);
  assert.equal(first.code, 0, first.stderr);
  assert.match(JSON.parse(first.stdout).auditPolicy.profile, /claude-current/);

  const second = retrofit([
    "--auditor-configured",
    "false",
    "--reason",
    "trying to clear it",
  ]);
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /already has a pinned audit policy/);
});

test(
  "D1 #3: --auditor-configured false is refused when the launch ledger already records an auditor session " +
    "for this kickoff, at both the function and CLI level",
  (t) => {
    const withLaunch = legacyKickoff(t, "wt-legacy-launch", {
      auditorLaunch: true,
    });
    assert.throws(
      () =>
        kickoffAuditPolicyRetrofit(withLaunch.org, withLaunch.worktreeId, {
          auditorConfigured: false,
          reason: "no auditor is actually needed",
          callerCwd: withLaunch.dir,
        }),
      /already records an auditor session/,
    );

    const cli = runCli(
      [
        "kickoff-audit-policy-retrofit",
        "--org",
        withLaunch.org,
        "--worktree",
        withLaunch.worktreeId,
        "--auditor-configured",
        "false",
        "--reason",
        "no auditor is actually needed",
      ],
      { cwd: withLaunch.dir },
    );
    assert.notEqual(cli.code, 0);
    assert.match(cli.stderr, /already records an auditor session/);

    // auditorConfigured: true does not contradict the recorded launch, so it
    // succeeds, and the launch is recorded as corroborating evidence, not the
    // basis (retrofittedFrom stays director-attestation either way).
    const result = kickoffAuditPolicyRetrofit(
      withLaunch.org,
      withLaunch.worktreeId,
      {
        auditorConfigured: true,
        profile: "claude-current",
        fallbacks: [],
        reason: "director attests this kickoff always needed an auditor",
        callerCwd: withLaunch.dir,
      },
    );
    assert.equal(result.auditPolicy.retrofittedFrom, "director-attestation");
    assert.equal(result.auditPolicy.corroboratingAuditorLaunch, true);
  },
);

test("D1 #4: kickoffAuditPolicyRetrofit refuses a missing --reason, an entry with no registered director, and a caller outside the director's checkout", (t) => {
  const noReason = legacyKickoff(t, "wt-legacy-noreason");
  assert.throws(
    () =>
      kickoffAuditPolicyRetrofit(noReason.org, noReason.worktreeId, {
        auditorConfigured: true,
        profile: "claude-current",
        fallbacks: [],
        reason: "",
        callerCwd: noReason.dir,
      }),
    /non-empty justification/,
  );

  const noDirector = legacyKickoff(t, "wt-legacy-nodirector", {
    director: false,
  });
  assert.throws(
    () =>
      kickoffAuditPolicyRetrofit(noDirector.org, noDirector.worktreeId, {
        auditorConfigured: true,
        profile: "claude-current",
        fallbacks: [],
        reason: "director attests this kickoff always needed an auditor",
        callerCwd: noDirector.dir,
      }),
    /no registered director/,
  );

  const mismatch = legacyKickoff(t, "wt-legacy-mismatch");
  const outsiderDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "omt-audit-outsider-"),
  );
  t.after(() => fs.rmSync(outsiderDir, { recursive: true, force: true }));
  assert.throws(
    () =>
      kickoffAuditPolicyRetrofit(mismatch.org, mismatch.worktreeId, {
        auditorConfigured: true,
        profile: "claude-current",
        fallbacks: [],
        reason: "director attests this kickoff always needed an auditor",
        callerCwd: outsiderDir,
      }),
    /must be run from the director's checkout/,
  );
});

test(
  "D1 #5: a legacy kickoff with no auditor ever configured passes close-ready once its auditPolicy is " +
    "retrofitted with --auditor-configured false",
  async (t) => {
    const fixture = legacyKickoff(t, "wt-legacy-none");

    // Clear assertLedgerCloseReady's own fidelity gate first, so both calls
    // below turn on the auditPolicy check this test actually targets.
    await requirementsFidelity(fixture.org, fixture.worktreeId, {
      head: fixture.head,
      repo: fixture.dir,
      recordedBy: "pm",
      items: [
        { type: "statement", id: "s1", status: "met", evidence: "README.md" },
        { type: "criterion", id: "c1", status: "met", evidence: "README.md" },
      ],
    });
    await requirementsFidelityConfirm(
      fixture.org,
      fixture.worktreeId,
      fixture.dir,
    );

    // Before retrofit, this legacy entry's missing auditPolicy refuses
    // close-ready outright rather than guessing from organization.json.
    await assert.rejects(
      assertKickoffCloseReady(fixture.org, fixture.worktreeId, {
        head: fixture.head,
        repo: fixture.dir,
        entry: fixture.entry,
      }),
      /no pinned audit policy/,
    );

    const result = kickoffAuditPolicyRetrofit(fixture.org, fixture.worktreeId, {
      auditorConfigured: false,
      reason: "this kickoff never had an auditor; documenting it explicitly",
      callerCwd: fixture.dir,
    });
    assert.equal(result.auditPolicy.auditorConfigured, false);
    assert.equal(result.auditPolicy.profile, null);
    assert.equal(result.auditPolicy.fallbacks, null);

    const [retrofittedEntry] = listKickoffs(
      fixture.org,
      fixture.worktreeId,
    ).kickoffs;
    const ready = await assertKickoffCloseReady(
      fixture.org,
      fixture.worktreeId,
      {
        head: fixture.head,
        repo: fixture.dir,
        entry: retrofittedEntry,
      },
    );
    assert.equal(ready.ready, true);
  },
);

test(
  "D1 #6: role-terminal --role auditor uses this kickoff's pinned auditor profile, not a live " +
    "organization.json read — an agy-provider profile pinned at claim stays refused after org.auditor is " +
    "changed or cleared live, and a pinned profile removed from organization.json is refused, never substituted",
  async (t) => {
    const fixture = kickoff(t, "wt-1", { auditor: { profile: "agy-oss" } });

    const originalCwd = process.cwd();
    t.after(() => process.chdir(originalCwd));
    process.chdir(fixture.dir);

    const auditorDir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-audit-pin-"));
    t.after(() => fs.rmSync(auditorDir, { recursive: true, force: true }));

    const roleTerminal = () =>
      main([
        "role-terminal",
        "--org",
        fixture.org,
        "--role",
        "auditor",
        "--worktree",
        `path:${auditorDir}`,
        "--state",
        fixture.entry.pm.stateDir,
      ]);

    // Pinned at claim as the agy-provider "agy-oss". Changing org.auditor
    // live to a non-agy profile must not be read at all: the launch still
    // refuses with the agy-specific message, proving the pinned profile
    // decided it, not the live one.
    let org = readJSON(fixture.org);
    org.auditor = { profile: "claude-current" };
    writeJSON(fixture.org, org);
    await assert.rejects(
      roleTerminal(),
      /Agy 감사 지원은 별도의 신뢰 실행 경로 설계가 필요/,
    );

    // Clearing org.auditor entirely afterward does not matter either.
    org = readJSON(fixture.org);
    delete org.auditor;
    writeJSON(fixture.org, org);
    await assert.rejects(
      roleTerminal(),
      /Agy 감사 지원은 별도의 신뢰 실행 경로 설계가 필요/,
    );

    // The pinned profile itself vanishing from organization.json is refused
    // outright, never substituted with another profile.
    org = readJSON(fixture.org);
    delete org.profiles["agy-oss"];
    writeJSON(fixture.org, org);
    await assert.rejects(
      roleTerminal(),
      /no longer exists in organization\.json/,
    );
  },
);

test(
  "D1 #6 (reverse): a non-agy profile pinned at claim is still what a live organization.json override cannot " +
    "change — only the pinned profile's own removal is what causes the refusal",
  async (t) => {
    const fixture = kickoff(t, "wt-1", {
      auditor: { profile: "claude-current" },
    });

    const originalCwd = process.cwd();
    t.after(() => process.chdir(originalCwd));
    process.chdir(fixture.dir);

    const auditorDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "omt-audit-pin2-"),
    );
    t.after(() => fs.rmSync(auditorDir, { recursive: true, force: true }));

    const roleTerminal = () =>
      main([
        "role-terminal",
        "--org",
        fixture.org,
        "--role",
        "auditor",
        "--worktree",
        `path:${auditorDir}`,
        "--state",
        fixture.entry.pm.stateDir,
      ]);

    // Live org.auditor now points at a still-valid, different profile, and
    // the pinned profile ("claude-current") is removed from organization.json.
    // Using the live value would proceed past the "no longer exists" check
    // (agy-oss still exists) all the way to the agy-provider refusal; seeing
    // the "no longer exists" message instead proves the pinned profile, not
    // the live one, was actually read.
    const org = readJSON(fixture.org);
    org.auditor = { profile: "agy-oss" };
    delete org.profiles["claude-current"];
    writeJSON(fixture.org, org);
    await assert.rejects(
      roleTerminal(),
      /no longer exists in organization\.json/,
    );
  },
);

test(
  "D1 #7 (PM supplement msg_7d6d9df2cfb1): kickoffAuditPolicyRetrofit pins a single profile with no " +
    "fallbacks, at both the function and CLI level, and role-terminal --role auditor refuses once that " +
    "profile is gone rather than substituting an org.profiles entry that still exists",
  async (t) => {
    const fnFixture = legacyKickoff(t, "wt-legacy-nofallback-fn");
    const fnResult = kickoffAuditPolicyRetrofit(
      fnFixture.org,
      fnFixture.worktreeId,
      {
        auditorConfigured: true,
        profile: "claude-current",
        reason: "director attests this kickoff needs only its primary profile",
        callerCwd: fnFixture.dir,
      },
    );
    assert.equal(fnResult.auditPolicy.profile, "claude-current");
    assert.deepEqual(fnResult.auditPolicy.fallbacks, []);

    const cliFixture = legacyKickoff(t, "wt-legacy-nofallback-cli");
    const cli = runCli(
      [
        "kickoff-audit-policy-retrofit",
        "--org",
        cliFixture.org,
        "--worktree",
        cliFixture.worktreeId,
        "--auditor-configured",
        "true",
        "--profile",
        "claude-current",
        "--reason",
        "director attests this kickoff needs only its primary profile",
      ],
      { cwd: cliFixture.dir },
    );
    assert.equal(cli.code, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout).auditPolicy.fallbacks, []);

    const originalCwd = process.cwd();
    t.after(() => process.chdir(originalCwd));
    process.chdir(cliFixture.dir);
    const [pinnedEntry] = listKickoffs(
      cliFixture.org,
      cliFixture.worktreeId,
    ).kickoffs;
    const auditorDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "omt-audit-nofallback-"),
    );
    t.after(() => fs.rmSync(auditorDir, { recursive: true, force: true }));

    // codex-current still exists in organization.json, so a substitution
    // would silently succeed with it; seeing "no longer exists" instead
    // proves no fallback (there is none pinned) and no other profile was
    // tried.
    const org = readJSON(cliFixture.org);
    delete org.profiles["claude-current"];
    writeJSON(cliFixture.org, org);
    await assert.rejects(
      main([
        "role-terminal",
        "--org",
        cliFixture.org,
        "--role",
        "auditor",
        "--worktree",
        `path:${auditorDir}`,
        "--state",
        pinnedEntry.pm.stateDir,
      ]),
      /no longer exists in organization\.json/,
    );
  },
);
