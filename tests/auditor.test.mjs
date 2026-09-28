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
  listKickoffs,
  registerKickoff,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";
import { recordLaunch } from "../plugins/oh-my-teams/scripts/usage-ledger.mjs";
import { requirementsPresent } from "../plugins/oh-my-teams/scripts/requirements.mjs";
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
import { verify } from "../plugins/oh-my-teams/scripts/evidence.mjs";
import { taskHash } from "../plugins/oh-my-teams/scripts/contracts.mjs";
import {
  main,
  resolveAuditorLaunchExecution,
} from "../plugins/oh-my-teams/scripts/teams-org.mjs";
import { TRUSTED_ORCA_EXECUTABLE_PLACEHOLDER } from "../plugins/oh-my-teams/scripts/orca-adapter.mjs";

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
function kickoff(t, worktreeId = "wt-1") {
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
  const fixture = kickoff(t);
  const org = readJSON(fixture.org);
  org.auditor = { profile: "claude-current" };
  writeJSON(fixture.org, org);
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
  const fixture = kickoff(t);
  const org = readJSON(fixture.org);
  org.auditor = { profile: "claude-current" };
  writeJSON(fixture.org, org);

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
    const fixture = kickoff(t);
    const org = readJSON(fixture.org);
    org.auditor = { profile: "claude-current" };
    writeJSON(fixture.org, org);

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
