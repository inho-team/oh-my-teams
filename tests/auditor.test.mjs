/** Auditor checkpoints: objection/response/ruling records and acceptance gates. */
import nodeTest, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  kickoffResultRepoDecide,
  listKickoffs,
  recordAuditorLaunch,
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
  requirementsAmend,
  requirementsPresent,
} from "../plugins/oh-my-teams/scripts/requirements.mjs";
import { minimalRequirements } from "./requirements-draft-fixture.mjs";
import {
  acceptComponentTask,
  acceptTaskThroughRuntime,
  createSingleTaskWorkflow,
  recordAcceptanceRef,
  withUntrackedHidden,
  createSingleTaskWorkflow as createStateWorkflow,
  taskBody,
} from "./accepted-workflow-fixture.mjs";
import {
  auditAccept,
  auditChecked,
  auditObjection,
  auditResponse,
  assertDeclaredIdentity,
  auditRuling,
  hasUnresolvedObjections,
  hasValidAcceptance,
  pickDeclaredIdentity,
  isPmBoundToRun,
  readAudit,
  verifiedPm,
} from "../plugins/oh-my-teams/scripts/audit.mjs";
import { acceptOutcome } from "../plugins/oh-my-teams/scripts/gates.mjs";
import {
  acceptWorkflowIntegration,
  createWorkflow,
  readWorkflow,
  resolveResultRepo,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";
import { verify } from "../plugins/oh-my-teams/scripts/evidence.mjs";
import { taskHash } from "../plugins/oh-my-teams/scripts/contracts.mjs";
import {
  blockingOutcome,
  auditorLaunchEnvironmentInputs,
  createRoleWorktree,
  main,
  resolveAuditorLaunchExecution,
} from "../plugins/oh-my-teams/scripts/teams-org.mjs";
import {
  createWorktreeWithRoleSession,
  isTrustedOrcaExecute,
  trustedOrcaExecute,
  TRUSTED_ORCA_EXECUTABLE_PLACEHOLDER,
} from "../plugins/oh-my-teams/scripts/orca-adapter.mjs";
import { deliverKickoff } from "../plugins/oh-my-teams/scripts/delivery.mjs";
import { readLaunchEnvironment } from "../plugins/oh-my-teams/scripts/role-terminal.mjs";
import { predictLaunchPath } from "../plugins/oh-my-teams/scripts/launch-matrix.mjs";
import { roleCommand } from "../plugins/oh-my-teams/scripts/role-launch.mjs";
import {
  bindKickoffResultRepo,
  ledgerHash,
  readLedger,
} from "../plugins/oh-my-teams/scripts/requirements.mjs";

const exampleOrg = new URL(
  "../plugins/oh-my-teams/examples/organization.json",
  import.meta.url,
);

// A plausible-looking commit id that is guaranteed not to be any fixture's
// actual HEAD, for the forged/stale-head counterexamples below.
const FORGED_HEAD = "0".repeat(40);

// Anchored on this file, never on process.cwd(), which other tests change.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(REPO_ROOT, "plugins/oh-my-teams/scripts/teams-org.mjs");

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

// node:test runs t.after hooks in registration order. A directory fixture
// registers its removal before the test body can register a cwd restore, and
// Windows cannot delete the current directory (EBUSY), which also left every
// later test running inside a removed directory. This wrapper therefore takes
// over the test's t.after hooks: it runs them itself, in registration order,
// after bringing the cwd back, so no removal can run inside the cwd.
//
// That forced restore must not hide a test that forgot its own: when the body
// ends with a changed cwd, one of its hooks has to chdir back to the start
// directory (the last chdir its hooks make, observed through process.chdir),
// or the test fails. The restore
// is never retried and a failing hook is never swallowed.
const START_CWD = process.cwd();
function sameDirectory(left, right) {
  try {
    return fs.realpathSync.native(left) === fs.realpathSync.native(right);
  } catch {
    return false;
  }
}
function test(name, fn) {
  return nodeTest(name, async (t) => {
    const hooks = [];
    const context = new Proxy(t, {
      get(target, property) {
        if (property === "after") return (hook) => void hooks.push(hook);
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const realChdir = process.chdir;
    // Only chdir calls made by the after hooks count, and the last one wins,
    // so a round trip inside the body (withCwd) never vouches for a restore.
    let inHooks = false;
    let hooksRestored = false;
    process.chdir = (directory) => {
      if (inHooks) hooksRestored = sameDirectory(directory, START_CWD);
      return realChdir.call(process, directory);
    };
    let leaked = false;
    let failure;
    try {
      await fn(context);
    } catch (error) {
      failure = { error };
    }
    try {
      leaked = process.cwd() !== START_CWD;
      realChdir.call(process, START_CWD);
      inHooks = true;
      for (const hook of hooks) {
        try {
          await hook(t);
        } catch (error) {
          failure ??= { error };
        }
      }
    } finally {
      process.chdir = realChdir;
    }
    if (failure) throw failure.error;
    assert.ok(
      !leaked || hooksRestored,
      "the test changed process.cwd() and never restored it in an after hook",
    );
  });
}
// Hooks of a test run after beforeEach/afterEach of the same test, so a cwd
// the restore above failed to bring back is caught when the next test starts
// (and after the last one), on every platform.
function assertCwdRestored() {
  assert.equal(
    process.cwd(),
    START_CWD,
    "a previous test left process.cwd() changed",
  );
}
beforeEach(assertCwdRestored);
after(assertCwdRestored);

// A registered kickoff with a director, a bound Run, and a launched auditor
// terminal — enough identity plumbing for every verifiedAuditor/verifiedPm/
// verifiedDirector check these tests exercise to pass. `dir` doubles as the
// Git workspace resultHead/head claims are checked against.
//
// With `deliverable: true` the kickoff can really be delivered: `dir` becomes
// the owner checkout on `main` (also the director's checkout), `repo` a linked
// worktree on branch `kick` holding one extra commit, `head` that commit, and
// the delivery mode `local-merge` into `main`.
function kickoff(
  t,
  worktreeId = "wt-1",
  { auditor, deliverable = false } = {},
) {
  // realpath'd: on macOS os.tmpdir() sits under a /var -> /private/var
  // symlink, and process.chdir() reports the resolved path, so an
  // un-resolved dir would never equal process.cwd() in a director-authority
  // check.
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "omt-audit-")),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let head = initRepo(dir);
  let repo = dir;
  if (deliverable) {
    git(dir, ["branch", "-M", "main"]);
    repo = `${dir}-kick`;
    t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
    git(dir, ["worktree", "add", "-q", "-b", "kick", repo]);
    fs.writeFileSync(path.join(repo, "result.md"), "delivered result\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "result"]);
    head = git(repo, ["rev-parse", "HEAD"]);
  }
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
    delivery: deliverable
      ? { mode: "local-merge", branch: "main" }
      : { mode: "none" },
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
  recordAuditorLaunch(org, {
    worktreeId,
    terminalHandle: auditorHandle,
    path: dir,
  });
  return {
    dir,
    repo,
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
  const dir = fs.realpathSync.native(
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
    auditChecked(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      [
        { type: "statement", id: "s1" },
        { type: "criterion", id: "c1" },
      ],
      undefined,
      fixture.head,
      fixture.repo,
    ),
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

test("new fidelity items and response evidence each require another outcome check", async (t) => {
  const fixture = kickoff(t);
  fs.writeFileSync(path.join(fixture.dir, "evidence.txt"), "first proof\n");
  const objectionId = await objectAndResolve(fixture, {
    resultHead: fixture.head,
    evidencePath: "evidence.txt",
  });
  const check = () =>
    withOrcaHandle(fixture.auditorHandle, () =>
      auditChecked(
        fixture.org,
        fixture.worktreeId,
        "outcome",
        BRIEF_ITEMS,
        undefined,
        fixture.head,
        fixture.repo,
      ),
    );
  const accept = () =>
    withOrcaHandle(fixture.auditorHandle, () =>
      auditAccept(
        fixture.org,
        fixture.worktreeId,
        "outcome",
        fixture.head,
        fixture.repo,
      ),
    );
  await check();
  await accept();
  await requirementsFidelity(fixture.org, fixture.worktreeId, {
    head: fixture.head,
    repo: fixture.repo,
    recordedBy: "pm",
    items: [
      { type: "statement", id: "s1", status: "met", evidence: "first proof" },
      { type: "criterion", id: "c1", status: "met", evidence: "first proof" },
    ],
  });
  await assert.rejects(accept(), /checked does not cover.*current binding/);
  await check();
  await accept();

  const evidencePath = path.join(fixture.dir, "second-evidence.txt");
  fs.writeFileSync(evidencePath, "second proof\n");
  const { response } = recordOutcomeResponseDirectly(fixture, {
    objectionId,
    argument: "new evidence resolves the objection",
    evidenceRefs: [
      { path: "second-evidence.txt", sha256: fileSha256(evidencePath) },
    ],
  });
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditRuling(fixture.org, fixture.worktreeId, {
      checkpoint: "outcome",
      objectionId,
      respondedAgainst: response.id,
      verdict: "persuaded",
      reason: "second proof supports the result",
    }),
  );
  await assert.rejects(accept(), /checked does not cover.*current binding/);
  await check();
  await accept();
});

test("hasValidAcceptance refuses once a cited response evidence file changes, same HEAD and fingerprint", async (t) => {
  const fixture = kickoff(t);
  const evidencePath = "evidence.txt";
  fs.writeFileSync(path.join(fixture.dir, evidencePath), "proof\n");

  await objectAndResolve(fixture, { resultHead: fixture.head, evidencePath });
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditChecked(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      [
        { type: "statement", id: "s1" },
        { type: "criterion", id: "c1" },
      ],
      undefined,
      fixture.head,
      fixture.repo,
    ),
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
    auditChecked(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      [
        { type: "statement", id: "s1" },
        { type: "criterion", id: "c1" },
      ],
      undefined,
      fixture.head,
      fixture.repo,
    ),
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
    auditChecked(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      [
        { type: "statement", id: "s1" },
        { type: "criterion", id: "c1" },
      ],
      undefined,
      fixture.head,
      fixture.repo,
    ),
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

  await assert.rejects(
    withOrcaHandle(fixture.auditorHandle, () =>
      auditAccept(
        fixture.org,
        fixture.worktreeId,
        "outcome",
        fixture.head,
        fixture.repo,
      ),
    ),
    /checked does not cover.*current binding/,
  );

  // Re-checking every item under the new evidence binding permits a new
  // acceptance; the stale old acceptance does not block it.
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditChecked(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      [
        { type: "statement", id: "s1" },
        { type: "criterion", id: "c1" },
      ],
      undefined,
      fixture.head,
      fixture.repo,
    ),
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
  assert.equal(record.checkedHistory.length, 1);
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
    auditChecked(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      [
        { type: "statement", id: "s1" },
        { type: "criterion", id: "c1" },
      ],
      undefined,
      fixture.head,
      fixture.repo,
    ),
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
    auditChecked(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      [
        { type: "statement", id: "s1" },
        { type: "criterion", id: "c1" },
      ],
      undefined,
      fixture.head,
      fixture.repo,
    ),
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
      auditChecked(
        fixture.org,
        fixture.worktreeId,
        "outcome",
        [
          { type: "statement", id: "s1" },
          { type: "criterion", id: "c1" },
        ],
        undefined,
        fixture.head,
        fixture.repo,
      ),
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
  // The result repository is fixed by an accepted workflow (Appendix G).
  await acceptStaged(await stageAcceptedTask(fixture, "wf-signal"));

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
    auditChecked(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      [
        { type: "statement", id: "s1" },
        { type: "criterion", id: "c1" },
      ],
      undefined,
      fixture.head,
      fixture.repo,
    ),
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
    const soloDir = fs.realpathSync.native(
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
  // The CLI's own exit-status decision, given the result untouched: main sets
  // process.exitCode = 1 exactly when this is true.
  assert.equal(blockingOutcome(result), true);
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
      // The auditor's launch runs only through the one trusted runner, so
      // the discovery receipt names the placeholder and every Orca call this
      // real createWorktreeWithRoleSession issues lands in `calls`.
      const discovery = {
        executable: TRUSTED_ORCA_EXECUTABLE_PLACEHOLDER,
        versionsMatch: true,
      };
      const trusted = trustedLaunchOver(async (orcaArgs) =>
        orcaReply(
          orcaArgs.includes("create")
            ? {
                worktree: { id: "wt_d4_audit", path: fixture.entry.pm.path },
              }
            : { removed: "wt_d4_audit" },
        ),
      );
      const calls = trusted.spawned;
      let openCalls = 0;
      await assert.rejects(
        () =>
          createRoleWorktree(
            { ...baseArgs, repo: fixture.dir },
            {
              organization: () => readJSON(fixture.org),
              environment,
              matrix,
              auditorLaunch: trusted.port,
              // Stands in only for orca-adapter's export lookup, not for its
              // reclaim/throw contract: options.execute is the auditor's own
              // trusted runner, and discovery is the real function's
              // injectable port (tests/worktree-lifecycle.test.mjs uses the
              // same pattern).
              create: (repo, options) =>
                createWorktreeWithRoleSession(repo, {
                  ...options,
                  discovery,
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

    const unauthorizedCwd = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "omt-audit-no-authority-")),
    );
    t.after(() => fs.rmSync(unauthorizedCwd, { recursive: true, force: true }));
    await refusesBeforeCreate(
      { ...baseArgs, repo: fixture.dir },
      unauthorizedCwd,
      /must be run from the director's checkout/,
    );

    const otherRepo = fs.realpathSync.native(
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
    const auditorBefore = listKickoffs(fixture.org, fixture.worktreeId)
      .kickoffs[0].auditor;
    await assert.rejects(
      roleTerminalAuditor(),
      /Agy 감사 지원은 별도의 신뢰 실행 경로 설계가 필요/,
    );
    await assert.rejects(
      roleTerminalAuditor(["--allow-unverified", "I approve this launch"]),
      /Agy 감사 지원은 별도의 신뢰 실행 경로 설계가 필요/,
    );

    // recordAuditorLaunch (kickoff-registry) never ran: the pre-existing
    // auditor handle is unchanged.
    const [afterEntry] = listKickoffs(fixture.org, fixture.worktreeId).kickoffs;
    assert.deepEqual(afterEntry.auditor, auditorBefore);
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
        assert.doesNotMatch(err.message, BINDING_REFUSED);
        if (process.platform === "win32") {
          // The matrix refuses a non-auditor agy role on win32 before any spawn.
          seniorWin32MatrixRefusal();
          assert.match(err.message, new RegExp(AGY_WIN32_REASON));
        } else {
          assert.match(err.message, /ENOENT/);
        }
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
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
  );
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

// The example organization's senior runs on an agy profile, which the launch
// matrix refuses on win32. A launch the binding table lets through therefore
// ends at that matrix refusal there (the binding check runs first: teams-org.mjs
// assertDirectRoleTerminalBinding precedes role-terminal.mjs openRoleTerminal's
// matrix check) and at the ordinary ENOENT spawn failure everywhere else.
const AGY_WIN32_REASON = "agy-interactive-terminal-unavailable";

// What the launch matrix answers for the example organization's senior on
// win32 with no trust record, from the public predictor alone.
function seniorWin32MatrixRefusal() {
  const command = roleCommand(readJSON(fileURLToPath(exampleOrg)), "senior");
  const matrix = predictLaunchPath({
    runner: command.provider,
    model: command.modelRequested,
    platform: "win32",
    shell: "powershell",
    trustRecordExists: false,
    codexTrustRecordExists: "unknown",
  });
  assert.equal(matrix.path, "blocked");
  assert.deepEqual(matrix.reason, [AGY_WIN32_REASON]);
  return matrix;
}

// Passing the binding table means reaching the ordinary spawn failure.
async function assertPassesBinding(launch) {
  await assert.rejects(launch, (error) => {
    assert.doesNotMatch(error.message, BINDING_REFUSED);
    if (process.platform === "win32") {
      seniorWin32MatrixRefusal();
      assert.match(error.message, new RegExp(AGY_WIN32_REASON));
      assert.equal(error.matrixRefusal?.path, "blocked");
      assert.deepEqual(error.matrixRefusal?.reason, [AGY_WIN32_REASON]);
    } else {
      assert.match(error.message, /ENOENT/);
    }
    return true;
  });
}

// A minimal, real workflow in `stateDir`, which launchContext and
// createRoleWorktree both read before they accept --workflow-id/--state; the
// read happens before any binding check, so a --state without one would fail
// there instead of reaching the rule under test. `repoDir` is the Git
// directory the task file lives in.
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
  const sessions = [];
  const ports = (open) => ({
    organization: () => readJSON(fixture.org),
    environment: d2Environment,
    matrix: d2Matrix,
    create: async (_repo, options) => {
      const session = await options.openRoleSession(workspace);
      sessions.push(session);
      return { workspace, session };
    },
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
  const realOpen = () =>
    withCwd(fixture.entry.pm.path, () =>
      createRoleWorktree(
        { ...baseArgs, orca: path.join(fixture.dir, "missing-orca") },
        ports(),
      ),
    );
  if (process.platform !== "win32") {
    await assertPassesBinding(realOpen());
    return;
  }
  // On win32 the senior's agy profile is refused by the launch matrix after
  // the binding table, and the refusal is not thrown: the open wrapper turns a
  // matrix refusal into a "no session observed" result, which this injected
  // create() hands back instead of the adapter's reclaim-and-throw. A binding
  // refusal is thrown (it is no matrix refusal), so a resolved no-session
  // result is the proof that the binding table was passed.
  const sessionsBefore = sessions.length;
  const refused = await realOpen();
  assert.equal(sessions.length, sessionsBefore + 1);
  assert.deepEqual(sessions.at(-1), { ready: false, sessionObserved: false });
  assert.deepEqual(refused.session, { ready: false, sessionObserved: false });
  assert.equal(refused.status, undefined);
  assert.equal(refused.path, childDir);
  assert.equal(refused.id, workspace.id);
  // The same no-session result also comes from the D4 shared-worktree branch
  // of the open wrapper, which only runs for the auditor role; this launch is
  // the senior's, and its open wrapper was reached (recorded above).
  assert.equal(baseArgs.role, "senior");
  // And the matrix is what refuses this launch, by its reason code.
  seniorWin32MatrixRefusal();
});

test("role-worktree-create (counterexample 13, success path): a non-colliding auditor workspace is created and opened without any reclaim", async (t) => {
  const fixture = kickoff(t, "wt-1", {
    auditor: { profile: "claude-current" },
  });
  fs.mkdirSync(fixture.entry.pm.path, { recursive: true });
  const auditorDir = realTempDir(t, "omt-d2-cx13-ok-");
  const trusted = trustedLaunchOver(async () =>
    orcaReply({ worktree: { id: "wt_d2_audit_ok", path: auditorDir } }),
  );
  const calls = trusted.spawned;
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
        auditorLaunch: trusted.port,
        create: (repo, options) =>
          createWorktreeWithRoleSession(repo, {
            ...options,
            discovery: {
              executable: TRUSTED_ORCA_EXECUTABLE_PLACEHOLDER,
              versionsMatch: true,
            },
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
  // The create call itself went through the trusted runner, never PATH.
  assert.equal(calls.filter((argv) => argv.includes("create")).length, 1);
});

// --- Appendix I (k139-auditor-f3): the auditor launch runs every Orca call
// through one trusted runner. These helpers build that runner exactly as
// production does (trustedOrcaExecute) over test-only injected script
// resolution and a recording fake spawn; nothing here touches a real Orca.

function orcaReply(result) {
  return {
    code: 0,
    stderr: "",
    timedOut: false,
    stdout: JSON.stringify({ ok: true, result }),
  };
}

// `handler(orcaArgs, options)` plays Orca; `spawned` records every call the
// trusted runner received as [script, ...orcaArgs], so an Orca call that went
// anywhere else (a general runner, PATH) is simply absent from it.
function trustedLaunchOver(handler) {
  const spawned = [];
  const execute = trustedOrcaExecute({
    platform: "darwin",
    candidates: ["/fake/orca"],
    exists: () => true,
    realpath: () => "/fake/orca-real",
    expectedRealpaths: { "/fake/orca": "/fake/orca-real" },
    userInfo: () => ({ homedir: os.userInfo().homedir, username: "tester" }),
    spawnExecute: async (argv, options) => {
      spawned.push(argv.slice(3));
      return handler(argv.slice(4), options);
    },
  });
  const launch = {
    executable: TRUSTED_ORCA_EXECUTABLE_PLACEHOLDER,
    execute,
    versionExecutable: "/fake/orca-real",
  };
  return { execute, launch, spawned, port: () => launch };
}

// A fake Orca whose worktree create/remove really run `git worktree` in the
// caller's repository, so a test can assert on the repository's actual
// leftovers. The first `--version` is the discovery read; later ones return
// `laterVersion`, which is how a test makes the launch's own environment read
// unverified. `terminal` decides what the terminal verbs answer.
function gitBackedOrca(repo, { laterVersion = "1.4.210", terminal } = {}) {
  let versionReads = 0;
  const fail = (stderr) => ({ code: 1, stdout: "", stderr, timedOut: false });
  return async (orcaArgs, options) => {
    const [noun, verb] = orcaArgs;
    const after = (flag) => orcaArgs[orcaArgs.indexOf(flag) + 1];
    if (noun === "--version") {
      versionReads += 1;
      const version = versionReads === 1 ? "1.4.210" : laterVersion;
      return { code: 0, stdout: `${version}\n`, stderr: "", timedOut: false };
    }
    if (noun === "skills")
      return { code: 0, stdout: "orca-cli guide", stderr: "", timedOut: false };
    if (noun === "status")
      return orcaReply({ runtime: { reachable: true, state: "ready" } });
    if (noun === "worktree" && verb === "create") {
      const name = after("--name");
      const dir = `${repo}-${name}`;
      git(options.cwd, [
        "worktree",
        "add",
        "-q",
        "-b",
        name,
        dir,
        after("--base-branch"),
      ]);
      return orcaReply({ worktree: { id: `wt_${name}::${dir}`, path: dir } });
    }
    if (noun === "worktree" && verb === "remove") {
      const id = after("--worktree").slice("id:".length);
      const [handle, dir] = id.split("::");
      git(options.cwd, ["worktree", "remove", "--force", dir]);
      git(options.cwd, ["branch", "-D", handle.slice("wt_".length)]);
      return orcaReply({ removed: id });
    }
    if (noun === "terminal" && terminal) return terminal(orcaArgs, fail);
    return fail(`unexpected orca call: ${orcaArgs.join(" ")}`);
  };
}

function gitTrace(dir) {
  const lines = (args) => git(dir, args).split("\n").filter(Boolean);
  return {
    worktrees: lines(["worktree", "list", "--porcelain"]).filter((line) =>
      line.startsWith("worktree "),
    ),
    branches: lines(["branch", "--format=%(refname:short)"]),
  };
}

// Runs role-worktree-create --role auditor through the real
// createWorktreeWithRoleSession and the real internal role-terminal command
// (no `open` port), over a git-backed trusted fake Orca, and returns what
// happened. `spawned` holds every Orca call the one trusted runner received.
async function launchAuditorThroughRealPath(
  t,
  { profile, name, orca, realPreflight = false },
) {
  const fixture = kickoff(t, "wt-1", { auditor: { profile } });
  fs.mkdirSync(fixture.entry.pm.path, { recursive: true });
  t.after(() =>
    fs.rmSync(`${fixture.dir}-${name}`, { recursive: true, force: true }),
  );
  const trusted = trustedLaunchOver(gitBackedOrca(fixture.dir, orca));
  const before = gitTrace(fixture.dir);
  const sessions = [];
  const executors = [];
  let result = null;
  const rejection = await withCwd(fixture.dir, async () => {
    try {
      result = await createRoleWorktree(
        {
          org: fixture.org,
          role: "auditor",
          state: fixture.entry.pm.stateDir,
          repo: fixture.dir,
          name,
          base: fixture.head,
        },
        {
          organization: () => readJSON(fixture.org),
          // With `realPreflight` the preflight reads its environment through
          // the real readLaunchEnvironment, so its version read lands on the
          // trusted runner exactly as the launch's other calls do.
          environment: realPreflight ? readLaunchEnvironment : d2Environment,
          matrix: d2Matrix,
          auditorLaunch: trusted.port,
          create: (repo, options) => {
            executors.push(options.execute);
            return createWorktreeWithRoleSession(repo, {
              ...options,
              openRoleSession: async (workspace) => {
                const session = await options.openRoleSession(workspace);
                sessions.push(session);
                return session;
              },
            });
          },
        },
      );
    } catch (error) {
      return error;
    }
    return null;
  });
  return {
    fixture,
    trusted,
    before,
    after: gitTrace(fixture.dir),
    sessions,
    executors,
    rejection,
    result,
  };
}

const orcaCallsOf = (spawned, ...words) =>
  spawned.filter((call) => words.every((word, i) => call[1 + i] === word));

test("T3 auditor role-worktree-create reclaims a worktree whose launch is refused before any terminal exists, through the real internal role-terminal path", async (t) => {
  // The real role-terminal command reads its own environment: a trusted
  // version that no longer verifies refuses the launch before terminal create.
  const run = await launchAuditorThroughRealPath(t, {
    profile: "claude-current",
    name: "audit-t3-env",
    orca: { laterVersion: "unversioned build" },
  });
  assert.match(run.rejection?.message ?? "", /was reclaimed/);
  assert.deepEqual(
    run.sessions.map((session) => session.sessionObserved),
    [false],
  );
  assert.equal(
    orcaCallsOf(run.trusted.spawned, "worktree", "create").length,
    1,
  );
  assert.equal(
    orcaCallsOf(run.trusted.spawned, "worktree", "remove").length,
    1,
  );
  assert.equal(orcaCallsOf(run.trusted.spawned, "terminal").length, 0);
  assert.equal(
    run.rejection.workspace.id.startsWith("wt_audit-t3-env::"),
    true,
  );

  // An agy-configured auditor is refused by role-terminal before any Orca
  // probe or terminal; that refusal is reclaimed the same way.
  const agy = await launchAuditorThroughRealPath(t, {
    profile: "agy-pro",
    name: "audit-t3-agy",
  });
  assert.match(agy.rejection?.message ?? "", /was reclaimed/);
  assert.deepEqual(
    agy.sessions.map((session) => session.sessionObserved),
    [false],
  );
  assert.equal(
    orcaCallsOf(agy.trusted.spawned, "worktree", "remove").length,
    1,
  );
});

test("T4 auditor creation and reclaim use the one trusted runner and leave no git worktree or branch behind", async (t) => {
  const run = await launchAuditorThroughRealPath(t, {
    profile: "claude-current",
    name: "audit-t4",
    orca: { laterVersion: "unversioned build" },
    realPreflight: true,
  });
  assert.match(run.rejection?.message ?? "", /was reclaimed/);
  // The runner createWorktree received is the launch's own trusted runner, and
  // it is the only one that saw the preflight version read, discovery, worktree
  // create, the internal role-terminal's version read and worktree remove: a
  // second runner built anywhere would leave its calls out of this record.
  assert.deepEqual(run.executors, [run.trusted.execute]);
  assert.equal(isTrustedOrcaExecute(run.executors[0]), true);
  const calls = run.trusted.spawned;
  assert.ok(calls.every((call) => call[0] === "/fake/orca-real"));
  const verbs = calls.map((call) => call.slice(1, 3).join(" "));
  assert.deepEqual(verbs, [
    "--version",
    "--version",
    "skills get",
    "status --json",
    "worktree create",
    "--version",
    "worktree remove",
  ]);
  // The repository itself is left exactly as it was found.
  assert.deepEqual(run.after, run.before);
  assert.equal(run.after.worktrees.length, 1);
});

test("T5 auditor preflight reads the environment with role-terminal's inputs and refuses before any worktree create", async (t) => {
  const fixture = kickoff(t, "wt-1", {
    auditor: { profile: "claude-current" },
  });
  fs.mkdirSync(fixture.entry.pm.path, { recursive: true });
  const args = {
    org: fixture.org,
    role: "auditor",
    state: fixture.entry.pm.stateDir,
    repo: fixture.dir,
    name: "audit-t5",
    base: fixture.head,
  };
  const attempt = async (ports, message) => {
    const trusted =
      ports.trusted ?? trustedLaunchOver(async () => orcaReply({}));
    let creates = 0;
    await withCwd(fixture.dir, () =>
      assert.rejects(
        () =>
          createRoleWorktree(args, {
            organization: () => readJSON(fixture.org),
            environment: d2Environment,
            matrix: d2Matrix,
            auditorLaunch: trusted.port,
            ...ports.override,
            create: async () => {
              creates += 1;
              throw new Error("create must not run");
            },
          }),
        message,
      ),
    );
    assert.equal(creates, 0);
    return trusted;
  };

  // (a) The preflight environment receives the same inputs role-terminal's
  // auditor branch uses, with the version read routed to the launch's runner.
  let received;
  const trusted = await attempt(
    {
      override: {
        environment: async (options) => {
          received = options;
          throw new Error("preflight refused");
        },
      },
    },
    /preflight refused/,
  );
  const expected = auditorLaunchEnvironmentInputs(trusted.execute);
  assert.deepEqual(Object.keys(received).sort(), [
    "homedir",
    "orcaExecutable",
    "readOrcaVersion",
    "skipAgyVersion",
    "throwOnUnverifiedOrca",
    "worktreePath",
  ]);
  assert.equal(typeof received.readOrcaVersion, "function");
  // Nothing has run on the launch's runner yet: the preflight only built the
  // inputs before refusing.
  assert.equal(trusted.spawned.length, 0);
  // The preflight's version read runs on the launch's own runner instance:
  // the call lands in that runner's record, not on a runner built afresh.
  assert.equal(await received.readOrcaVersion().catch(() => null), null);
  assert.deepEqual(trusted.spawned, [["/fake/orca-real", "--version"]]);
  assert.equal(received.skipAgyVersion, expected.skipAgyVersion);
  assert.equal(received.throwOnUnverifiedOrca, expected.throwOnUnverifiedOrca);
  assert.equal(received.homedir, os.userInfo().homedir);
  assert.equal(received.orcaExecutable, "/fake/orca-real");
  // (b) An unverified trusted version refuses the real preflight read.
  await attempt(
    {
      trusted: trustedLaunchOver(async () => ({
        code: 0,
        stdout: "unversioned build\n",
        stderr: "",
        timedOut: false,
      })),
      override: { environment: undefined },
    },
    /./,
  );

  // (c) A trusted script that cannot be resolved refuses before any create.
  await attempt(
    {
      override: {
        auditorLaunch: (options) =>
          resolveAuditorLaunchExecution({
            ...options,
            trustedExecuteFactory: () =>
              trustedOrcaExecute({
                platform: "darwin",
                candidates: ["/missing/orca"],
                exists: () => false,
              }),
          }),
      },
    },
    /No trusted Orca executable found/,
  );

  // (d) A runner that trustedOrcaExecute did not build is refused, even when
  // it arrives beside the placeholder.
  await attempt(
    {
      override: {
        auditorLaunch: () => ({
          executable: TRUSTED_ORCA_EXECUTABLE_PLACEHOLDER,
          execute: async () => orcaReply({}),
          versionExecutable: "/fake/orca-real",
        }),
      },
    },
    /trustedOrcaExecute built/,
  );
});

test("T6 auditor launch failure after a terminal was created preserves the worktree and reports its id", async (t) => {
  const run = await launchAuditorThroughRealPath(t, {
    profile: "claude-current",
    name: "audit-t6",
    orca: {
      terminal: (orcaArgs, fail) =>
        orcaArgs[1] === "create"
          ? orcaReply({ terminal: { handle: "term_t6" } })
          : fail("screen unavailable"),
    },
  });
  assert.doesNotMatch(run.rejection?.message ?? "", /was reclaimed/);
  assert.match(run.rejection?.message ?? "", /screen unavailable/);
  assert.equal(
    orcaCallsOf(run.trusted.spawned, "terminal", "create").length,
    1,
  );
  assert.equal(
    orcaCallsOf(run.trusted.spawned, "worktree", "remove").length,
    0,
  );
  assert.equal(run.rejection.workspace.id.startsWith("wt_audit-t6::"), true);
  // The worktree is still there for reconciliation.
  assert.equal(run.after.worktrees.length, run.before.worktrees.length + 1);
});

// T7 (appendix I, section 7): the positive twin of T3~T6. The incident path is
// worktree create followed by the real internal role-terminal, and only a
// launch that succeeds there proves the trusted runner is wired end to end.
test("T7 auditor role-worktree-create succeeds through the real internal role-terminal path on one trusted runner", async (t) => {
  let typed = "";
  const run = await launchAuditorThroughRealPath(t, {
    profile: "claude-current",
    name: "audit-t7",
    orca: {
      terminal: (orcaArgs, fail) => {
        const verb = orcaArgs[1];
        const reply = (result) => orcaReply(result);
        if (verb === "create") {
          typed = orcaArgs[orcaArgs.indexOf("--command") + 1];
          return reply({ terminal: { handle: "term_t7" } });
        }
        if (verb === "read")
          return reply({
            terminal: {
              source: "screen",
              tail: [`me@host project % ${typed}`, "Claude Code", ">"],
            },
          });
        if (verb === "wait") return reply({ wait: { satisfied: true } });
        if (verb === "rename") return reply({ rename: { title: "ok" } });
        if (verb === "list") return reply({ terminals: [] });
        return fail(`unexpected terminal verb ${verb}`);
      },
    },
    realPreflight: true,
  });
  assert.equal(run.rejection, null);
  // The real internal role-terminal reported a ready session with a terminal.
  assert.equal(run.sessions.length, 1);
  assert.equal(run.sessions[0].ready, true);
  assert.equal(run.sessions[0].terminal, "term_t7");
  assert.notEqual(run.sessions[0].sessionObserved, false);
  // Every call, from the preflight's version read through worktree create,
  // discovery and every terminal verb, reached the one trusted runner that
  // createWorktree was handed; none went to PATH or a general runner.
  assert.deepEqual(run.executors, [run.trusted.execute]);
  assert.equal(isTrustedOrcaExecute(run.executors[0]), true);
  const calls = run.trusted.spawned;
  assert.ok(calls.every((call) => call[0] === "/fake/orca-real"));
  const kinds = new Set(calls.map((call) => call.slice(1, 3).join(" ")));
  for (const kind of [
    "--version",
    "skills get",
    "status --json",
    "worktree create",
    "terminal create",
    "terminal read",
    "terminal wait",
    "terminal rename",
    "terminal list",
  ])
    assert.ok(kinds.has(kind), `${kind} did not go through the trusted runner`);
  assert.equal(orcaCallsOf(calls, "worktree", "remove").length, 0);
  // The value createRoleWorktree returned carries the worktree and terminal
  // the fake created, not merely what the session opener saw.
  const worktrees = run.after.worktrees.filter(
    (line) => !run.before.worktrees.includes(line),
  );
  assert.equal(worktrees.length, 1);
  assert.match(worktrees[0], /-audit-t7$/);
  const dir = worktrees[0].slice("worktree ".length);
  const { result } = run;
  // The id and path are exactly what the fake's worktree create replied.
  const fakeDir = `${run.fixture.dir}-audit-t7`;
  assert.equal(result.id, `wt_audit-t7::${fakeDir}`);
  assert.equal(result.path, fakeDir);
  assert.equal(
    fs.realpathSync.native(result.path),
    fs.realpathSync.native(dir),
  );
  assert.equal(result.session.ready, true);
  assert.equal(result.session.terminal, "term_t7");
  assert.notEqual(result.status, "blocked");
  // Reclaim the temporary worktree through the same runner with the id that
  // was returned, then prove the repository is back to what it was. t.after
  // covers an assertion failure.
  const cleanup = () => {
    // The fixture's own cleanup may already have removed the repository.
    if (
      !fs.existsSync(run.fixture.dir) ||
      !gitTrace(run.fixture.dir).worktrees.includes(`worktree ${dir}`)
    )
      return;
    git(run.fixture.dir, ["worktree", "remove", "--force", dir]);
    git(run.fixture.dir, ["branch", "-D", "audit-t7"]);
  };
  t.after(cleanup);
  const removed = await run.trusted.execute(
    ["orca", "worktree", "remove", "--worktree", `id:${result.id}`, "--json"],
    { cwd: run.fixture.dir },
  );
  assert.equal(removed.code, 0);
  assert.deepEqual(gitTrace(run.fixture.dir), run.before);
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
  // Since appendix I these four inputs come from one shared function that both
  // role-worktree-create's preflight and this branch call, so what is checked
  // here is that the shared function still carries all four, and that the
  // auditor branch still reads its environment only through it.
  const source = fs.readFileSync(cli, "utf8");
  const inputsStart = source.indexOf(
    "export function auditorLaunchEnvironmentInputs(",
  );
  assert.notEqual(inputsStart, -1, "auditorLaunchEnvironmentInputs not found");
  const inputs = source.slice(
    inputsStart,
    source.indexOf("\n}\n", inputsStart),
  );
  assert.match(
    inputs,
    /readOrcaVersion:\s*\(\)\s*=>\s*readTrustedOrcaVersion\(\{\s*execute\s*\}\)/,
  );
  assert.match(inputs, /skipAgyVersion:\s*true/);
  assert.match(inputs, /throwOnUnverifiedOrca:\s*true/);
  assert.match(inputs, /homedir:\s*os\.userInfo\(\)\.homedir/);
  const resolveCallStart = source.indexOf(
    "resolveAuditorLaunchExecution({ auditorEntry",
  );
  assert.notEqual(
    resolveCallStart,
    -1,
    "resolveAuditorLaunchExecution call not found",
  );
  const envCallStart = source.indexOf(
    "env = await readLaunchEnvironment({",
    resolveCallStart,
  );
  assert.notEqual(envCallStart, -1, "readLaunchEnvironment call not found");
  const envCall = source.slice(
    envCallStart,
    source.indexOf("});", envCallStart),
  );
  assert.match(envCall, /auditorLaunchEnvironmentInputs\(auditorExecute\)/);
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

  const missingBinding = runCli(
    [
      "audit-checked",
      "--org",
      fixture.org,
      "--worktree",
      fixture.worktreeId,
      "--checkpoint",
      "outcome",
      "--from",
      requestFile,
    ],
    { cwd: fixture.dir, env: { ORCA_TERMINAL_HANDLE: fixture.auditorHandle } },
  );
  assert.notEqual(missingBinding.code, 0);
  assert.match(missingBinding.stderr, /resultHead is required/);
  const outcome = runCli(
    [
      "audit-checked",
      "--org",
      fixture.org,
      "--worktree",
      fixture.worktreeId,
      "--checkpoint",
      "outcome",
      "--from",
      requestFile,
      "--head",
      fixture.head,
      "--repo",
      fixture.repo,
    ],
    { cwd: fixture.dir, env: { ORCA_TERMINAL_HANDLE: fixture.auditorHandle } },
  );
  assert.equal(outcome.code, 0, outcome.stderr);
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
  const root = fs.realpathSync.native(
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
  recordAuditorLaunch(org, {
    worktreeId,
    terminalHandle: auditorHandle,
    path: owner,
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

// The objection is recorded so that an orgFile accepted by the identity check
// is observable: the next check the call reaches is the unresolved objection.
async function acceptWithObjection(t, label) {
  const fixture = registeredKickoffProject(t, label);
  const task = gapTask(fixture.worktreeId);
  const report = await passingReportFor(fixture, task, "run-org");
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
  return {
    fixture,
    accept: (decisionId, orgFile) =>
      acceptOutcome(
        fixture.pmWorktree,
        task,
        report,
        decisionFor(decisionId),
        fixture.stateDir,
        { orgFile },
      ),
  };
}

const ORG_FILE_MISMATCH =
  /orgFile does not match this state directory's registered kickoff/;
const UNRESOLVED_OBJECTION =
  /outcome audit checkpoint has an unresolved objection/;

test("acceptOutcome orgFile identity (a): the same organization file under a symlinked spelling is not refused and reaches the next check", async (t) => {
  const { fixture, accept } = await acceptWithObjection(t, "wt-org-same-a");
  const link = path.join(fixture.root, "org-link");
  fs.symlinkSync(path.dirname(fixture.org), link, "junction");
  const respelled = path.join(link, path.basename(fixture.org));
  assert.notEqual(path.resolve(respelled), path.resolve(fixture.org));
  assert.equal(
    fs.realpathSync.native(respelled),
    fs.realpathSync.native(fixture.org),
  );
  await assert.rejects(
    () => accept("accept-org-a", respelled),
    UNRESOLVED_OBJECTION,
  );
});

test("acceptOutcome orgFile identity (b): another project's organization file is refused with the existing message", async (t) => {
  const { accept } = await acceptWithObjection(t, "wt-org-other-b");
  const other = registeredKickoffProject(t, "wt-org-other-b2");
  assert.equal(fs.existsSync(other.org), true);
  await assert.rejects(
    () => accept("accept-org-b", other.org),
    ORG_FILE_MISMATCH,
  );
});

test("acceptOutcome orgFile identity (c): an organization file path that cannot be resolved is refused", async (t) => {
  const { fixture, accept } = await acceptWithObjection(t, "wt-org-missing-c");
  await assert.rejects(
    () =>
      accept(
        "accept-org-c",
        path.join(fixture.root, "no-such-dir", "organization.json"),
      ),
    ORG_FILE_MISMATCH,
  );
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
  const root = fs.realpathSync.native(
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
      pathToFileURL(
        path.join(
          REPO_ROOT,
          "plugins/oh-my-teams/scripts/kickoff-registry.mjs",
        ),
      ).href,
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
    // The result repository is fixed by an accepted workflow (Appendix G).
    await acceptStaged(await stageAcceptedTask(fixture, "wf-d1"));

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

// D3 (checklist 7, finding d3-no-verified-caller): every objection, response,
// ruling and checked item stores the runtime-verified caller, and a payload
// that declares a different identity is refused before anything is recorded.
const BRIEF_ITEMS = [
  { type: "statement", id: "s1" },
  { type: "criterion", id: "c1" },
];

async function d3BriefObjection(fixture) {
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditObjection(fixture.org, fixture.worktreeId, {
      checkpoint: "brief",
      target: { type: "criterion", id: "c1" },
      kind: "gap",
      description: "criterion c1 is not clearly derived from the brief",
      rebuttalRequested: "point to the brief section it comes from",
    }),
  );
  return readAudit(
    fixture.org,
    fixture.worktreeId,
  ).checkpoints.brief.objections.at(-1).id;
}

function d3ResponseRequest(fixture, objectionId, extra = {}) {
  const evidencePath = "d3-evidence.txt";
  fs.writeFileSync(path.join(fixture.dir, evidencePath), "brief section 2\n");
  return {
    checkpoint: "brief",
    objectionId,
    argument: "c1 traces to brief section 2",
    evidenceRefs: [
      {
        path: evidencePath,
        sha256: fileSha256(path.join(fixture.dir, evidencePath)),
      },
    ],
    ...extra,
  };
}

function d3WriteRequest(fixture, name, body) {
  const file = path.join(fixture.dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

function d3RunAudit(
  fixture,
  command,
  requestFile,
  { handle, cwd, extra = [] },
) {
  return runCli(
    [
      command,
      "--org",
      fixture.org,
      "--worktree",
      fixture.worktreeId,
      ...extra,
      "--from",
      requestFile,
    ],
    { cwd: cwd ?? fixture.dir, env: { ORCA_TERMINAL_HANDLE: handle ?? null } },
  );
}

function d3Counts(fixture, checkpoint = "brief") {
  const record = readAudit(fixture.org, fixture.worktreeId).checkpoints[
    checkpoint
  ];
  return {
    objections: record.objections.length,
    responses: record.responses.length,
    rulings: record.rulings.length,
    checked: record.checked.length,
  };
}

test("D3 (a,b): objection, response, ruling and checked items each store the runtime-verified caller", async (t) => {
  const fixture = kickoff(t);
  const objectionId = await d3BriefObjection(fixture);
  const { audit } = await withCwd(fixture.dir, () =>
    auditResponse(
      fixture.org,
      fixture.worktreeId,
      d3ResponseRequest(fixture, objectionId),
    ),
  );
  const responseId = audit.checkpoints.brief.responses.at(-1).id;
  await withOrcaHandle(fixture.auditorHandle, async () => {
    await auditRuling(fixture.org, fixture.worktreeId, {
      checkpoint: "brief",
      objectionId,
      respondedAgainst: responseId,
      verdict: "persuaded",
      reason: "evidence supports the claim",
    });
    await auditChecked(fixture.org, fixture.worktreeId, "brief", BRIEF_ITEMS);
  });
  const record = readAudit(fixture.org, fixture.worktreeId).checkpoints.brief;
  const auditor = { role: AUDITOR_ROLE, handle: fixture.auditorHandle };
  assert.deepEqual(record.objections[0].verifiedCaller, auditor);
  assert.deepEqual(record.responses[0].verifiedCaller, {
    role: "director",
    checkoutPath: fixture.dir,
  });
  assert.deepEqual(record.rulings[0].verifiedCaller, auditor);
  assert.deepEqual(
    record.checked.map(({ type, id, verifiedCaller }) => ({
      type,
      id,
      verifiedCaller,
    })),
    BRIEF_ITEMS.map((item) => ({ ...item, verifiedCaller: auditor })),
  );
});

test("D3 (a): the outcome checkpoint's objection and ruling store the verified auditor too", async (t) => {
  const fixture = kickoff(t);
  fs.writeFileSync(path.join(fixture.dir, "evidence.txt"), "proof\n");
  await objectAndResolve(fixture, {
    resultHead: fixture.head,
    evidencePath: "evidence.txt",
  });
  const record = readAudit(fixture.org, fixture.worktreeId).checkpoints.outcome;
  const auditor = { role: AUDITOR_ROLE, handle: fixture.auditorHandle };
  assert.deepEqual(record.objections[0].verifiedCaller, auditor);
  assert.deepEqual(record.rulings[0].verifiedCaller, auditor);
});

test("D3 (c): a narrower or different-auditor re-send keeps each existing checked item's type:id and first verifiedCaller", async (t) => {
  const fixture = kickoff(t);
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditChecked(fixture.org, fixture.worktreeId, "brief", BRIEF_ITEMS),
  );
  const before = readAudit(fixture.org, fixture.worktreeId).checkpoints.brief
    .checked;
  const second = "term_auditor_second";
  recordLaunch(fixture.org, {
    via: "role-terminal",
    role: AUDITOR_ROLE,
    terminal: second,
    stateDir: fixture.entry.pm.stateDir,
  });
  recordAuditorLaunch(fixture.org, {
    worktreeId: fixture.worktreeId,
    terminalHandle: second,
    path: fixture.dir,
  });
  await withOrcaHandle(second, () =>
    auditChecked(fixture.org, fixture.worktreeId, "brief", [BRIEF_ITEMS[0]]),
  );
  assert.deepEqual(
    readAudit(fixture.org, fixture.worktreeId).checkpoints.brief.checked,
    before,
  );
  await withOrcaHandle(second, () =>
    auditChecked(fixture.org, fixture.worktreeId, "brief", [
      ...BRIEF_ITEMS,
      { type: "criterion", id: "c2" },
    ]),
  );
  const after = readAudit(fixture.org, fixture.worktreeId).checkpoints.brief
    .checked;
  assert.deepEqual(after.slice(0, 2), before);
  assert.deepEqual(after[2], {
    type: "criterion",
    id: "c2",
    verifiedCaller: { role: AUDITOR_ROLE, handle: second },
  });
});

test("reopening an auditor terminal revokes the old handle for every auditor write", async (t) => {
  const fixture = kickoff(t);
  const replacement = "term_auditor_reopened";
  recordLaunch(fixture.org, {
    via: "role-terminal",
    role: AUDITOR_ROLE,
    terminal: replacement,
    stateDir: fixture.entry.pm.stateDir,
  });
  recordAuditorLaunch(fixture.org, {
    worktreeId: fixture.worktreeId,
    terminalHandle: replacement,
    path: fixture.dir,
  });
  const before = readAudit(fixture.org, fixture.worktreeId);
  const attempts = [
    () =>
      auditObjection(fixture.org, fixture.worktreeId, {
        checkpoint: "brief",
        target: BRIEF_ITEMS[0],
        kind: "gap",
        description: "stale terminal objection",
        rebuttalRequested: "review this again",
      }),
    () =>
      auditRuling(fixture.org, fixture.worktreeId, {
        checkpoint: "brief",
        objectionId: "missing",
        respondedAgainst: "missing",
        verdict: "persuaded",
        reason: "stale terminal ruling",
      }),
    () => auditChecked(fixture.org, fixture.worktreeId, "brief", BRIEF_ITEMS),
    () => auditAccept(fixture.org, fixture.worktreeId, "brief"),
  ];
  for (const attempt of attempts) {
    await assert.rejects(
      withOrcaHandle(fixture.auditorHandle, attempt),
      /not the current auditor terminal/,
    );
  }
  assert.deepEqual(readAudit(fixture.org, fixture.worktreeId), before);
  await withOrcaHandle(replacement, async () => {
    await auditChecked(fixture.org, fixture.worktreeId, "brief", BRIEF_ITEMS);
    await auditAccept(fixture.org, fixture.worktreeId, "brief");
  });
  assert.equal(
    await hasValidAcceptance(fixture.org, fixture.worktreeId, "brief"),
    true,
  );
});

test("amending text under the same item IDs requires a fresh brief and outcome check", async (t) => {
  const fixture = kickoff(t);
  await withOrcaHandle(fixture.auditorHandle, async () => {
    await auditChecked(fixture.org, fixture.worktreeId, "brief", BRIEF_ITEMS);
    await auditAccept(fixture.org, fixture.worktreeId, "brief");
    await auditChecked(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      BRIEF_ITEMS,
      undefined,
      fixture.head,
      fixture.repo,
    );
    await auditAccept(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      fixture.head,
      fixture.repo,
    );
  });
  const ledger = readLedger(fixture.org, fixture.worktreeId);
  const statements = ledger.statements.map((item) => ({
    ...item,
    text: `${item.text} with amended scope`,
  }));
  const criteria = ledger.criteria.map((item) => ({
    ...item,
    text: `${item.text} with amended criterion`,
  }));
  await requirementsAmend(fixture.org, fixture.worktreeId, {
    statements,
    criteria,
    callerCwd: fixture.dir,
  });
  for (const checkpoint of ["brief", "outcome"]) {
    const args = checkpoint === "outcome" ? [fixture.head, fixture.repo] : [];
    assert.equal(
      await hasValidAcceptance(
        fixture.org,
        fixture.worktreeId,
        checkpoint,
        ...args,
      ),
      false,
    );
    await assert.rejects(
      withOrcaHandle(fixture.auditorHandle, () =>
        auditAccept(fixture.org, fixture.worktreeId, checkpoint, ...args),
      ),
      /checked does not cover.*current binding/,
    );
    await withOrcaHandle(fixture.auditorHandle, async () => {
      await auditChecked(
        fixture.org,
        fixture.worktreeId,
        checkpoint,
        [BRIEF_ITEMS[0]],
        undefined,
        ...args,
      );
      await assert.rejects(
        auditAccept(fixture.org, fixture.worktreeId, checkpoint, ...args),
        /checked does not cover/,
      );
      await auditChecked(
        fixture.org,
        fixture.worktreeId,
        checkpoint,
        [BRIEF_ITEMS[1]],
        undefined,
        ...args,
      );
      await auditAccept(fixture.org, fixture.worktreeId, checkpoint, ...args);
    });
    assert.equal(
      await hasValidAcceptance(
        fixture.org,
        fixture.worktreeId,
        checkpoint,
        ...args,
      ),
      true,
    );
    assert.equal(
      readAudit(fixture.org, fixture.worktreeId).checkpoints[checkpoint]
        .checkedHistory.length,
      1,
    );
  }
});

test("a new result HEAD requires a new outcome check while brief coverage stays valid", async (t) => {
  const fixture = kickoff(t);
  await withOrcaHandle(fixture.auditorHandle, async () => {
    await auditChecked(fixture.org, fixture.worktreeId, "brief", BRIEF_ITEMS);
    await auditAccept(fixture.org, fixture.worktreeId, "brief");
    await auditChecked(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      BRIEF_ITEMS,
      undefined,
      fixture.head,
      fixture.repo,
    );
    await auditAccept(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      fixture.head,
      fixture.repo,
    );
  });
  fs.writeFileSync(path.join(fixture.repo, "new-result.txt"), "new result\n");
  git(fixture.repo, ["add", "new-result.txt"]);
  git(fixture.repo, ["commit", "-q", "-m", "new result"]);
  const newHead = git(fixture.repo, ["rev-parse", "HEAD"]);
  assert.equal(
    await hasValidAcceptance(fixture.org, fixture.worktreeId, "brief"),
    true,
  );
  await assert.rejects(
    withOrcaHandle(fixture.auditorHandle, () =>
      auditAccept(
        fixture.org,
        fixture.worktreeId,
        "outcome",
        newHead,
        fixture.repo,
      ),
    ),
    /checked does not cover.*current binding/,
  );
  await withOrcaHandle(fixture.auditorHandle, async () => {
    await auditChecked(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      BRIEF_ITEMS,
      undefined,
      newHead,
      fixture.repo,
    );
    await auditAccept(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      newHead,
      fixture.repo,
    );
  });
});

test("D3 (d): a --from payload declaring another identity is refused by each audit CLI command with no record added", async (t) => {
  const fixture = kickoff(t);
  const objectionId = await d3BriefObjection(fixture);
  const forged = {
    actor: "term_someone_else",
    raisedBy: { role: AUDITOR_ROLE, handle: "term_someone_else" },
  };
  const responseFile = d3WriteRequest(
    fixture,
    "d3-response",
    d3ResponseRequest(fixture, objectionId, { respondedBy: "term_pm_forged" }),
  );
  const objectionFile = d3WriteRequest(fixture, "d3-objection", {
    checkpoint: "brief",
    target: { type: "criterion", id: "c1" },
    kind: "gap",
    description: "another gap",
    rebuttalRequested: "explain it",
    ...forged,
  });
  const checkedFile = d3WriteRequest(fixture, "d3-checked", {
    checked: BRIEF_ITEMS,
    terminal: "term_someone_else",
  });
  const before = d3Counts(fixture);
  const refusals = [
    d3RunAudit(fixture, "audit-objection", objectionFile, {
      handle: fixture.auditorHandle,
    }),
    d3RunAudit(fixture, "audit-response", responseFile, {}),
    d3RunAudit(fixture, "audit-checked", checkedFile, {
      handle: fixture.auditorHandle,
      extra: ["--checkpoint", "brief"],
    }),
  ];
  for (const refused of refusals) {
    assert.notEqual(refused.code, 0, refused.stdout);
    assert.match(refused.stderr, /does not match the runtime-verified caller/);
  }
  assert.deepEqual(d3Counts(fixture), before);

  const { audit } = await withCwd(fixture.dir, () =>
    auditResponse(
      fixture.org,
      fixture.worktreeId,
      d3ResponseRequest(fixture, objectionId),
    ),
  );
  const rulingFile = d3WriteRequest(fixture, "d3-ruling", {
    checkpoint: "brief",
    objectionId,
    respondedAgainst: audit.checkpoints.brief.responses.at(-1).id,
    verdict: "persuaded",
    reason: "evidence supports the claim",
    verifiedCaller: { role: AUDITOR_ROLE, handle: "term_someone_else" },
  });
  const beforeRuling = d3Counts(fixture);
  const refusedRuling = d3RunAudit(fixture, "audit-ruling", rulingFile, {
    handle: fixture.auditorHandle,
  });
  assert.notEqual(refusedRuling.code, 0, refusedRuling.stdout);
  assert.match(
    refusedRuling.stderr,
    /does not match the runtime-verified caller/,
  );
  assert.deepEqual(d3Counts(fixture), beforeRuling);
});

test("D3 (d): the PM-role (outcome) and director-role (brief) checks refuse a mismatched declared identity, reached without a real Orca", () => {
  const pm = { role: "pm", handle: "term_pm_real" };
  const director = { role: "director", checkoutPath: "/checkout/real" };
  for (const [declared, caller] of [
    [{ respondedBy: "term_pm_forged" }, pm],
    [{ actor: { role: "pm", handle: "term_pm_forged" } }, pm],
    [{ verifiedCaller: { role: "director", handle: "term_pm_real" } }, pm],
    [{ respondedBy: "/checkout/other" }, director],
    [{ actor: {} }, director],
    [{ actor: 7 }, director],
    [{ terminal: "" }, pm],
  ]) {
    assert.throws(
      () => assertDeclaredIdentity(declared, caller),
      /does not match the runtime-verified caller/,
      JSON.stringify(declared),
    );
  }
  assert.throws(
    () =>
      assertDeclaredIdentity(pickDeclaredIdentity({ actor: "x" }), {
        role: "pm",
        handle: "y",
      }),
    /does not match/,
  );
});

test("D3 (e): a payload declaring exactly the verified identity is accepted and only the verified value is stored", async (t) => {
  const fixture = kickoff(t);
  const objectionFile = d3WriteRequest(fixture, "d3-objection-ok", {
    checkpoint: "brief",
    target: { type: "criterion", id: "c1" },
    kind: "gap",
    description: "criterion c1 is not clearly derived from the brief",
    rebuttalRequested: "point to the brief section it comes from",
    actor: fixture.auditorHandle,
    verifiedCaller: { role: AUDITOR_ROLE, handle: fixture.auditorHandle },
  });
  const accepted = d3RunAudit(fixture, "audit-objection", objectionFile, {
    handle: fixture.auditorHandle,
  });
  assert.equal(accepted.code, 0, accepted.stderr);
  const [objection] = readAudit(fixture.org, fixture.worktreeId).checkpoints
    .brief.objections;
  assert.deepEqual(objection.verifiedCaller, {
    role: AUDITOR_ROLE,
    handle: fixture.auditorHandle,
  });
  assert.equal(Object.hasOwn(objection, "actor"), false);
  assert.equal(Object.hasOwn(objection, "raisedBy"), false);
  assert.deepEqual(
    pickDeclaredIdentity({ checkpoint: "brief", actor: "a", x: 1 }),
    { actor: "a" },
  );
});

test("D3 (f): audit records written before verifiedCaller existed stay valid per judgement function, and rewriting never invents one", async (t) => {
  const fixture = kickoff(t);
  const objectionId = await d3BriefObjection(fixture);
  const { audit } = await withCwd(fixture.dir, () =>
    auditResponse(
      fixture.org,
      fixture.worktreeId,
      d3ResponseRequest(fixture, objectionId),
    ),
  );
  await withOrcaHandle(fixture.auditorHandle, async () => {
    await auditRuling(fixture.org, fixture.worktreeId, {
      checkpoint: "brief",
      objectionId,
      respondedAgainst: audit.checkpoints.brief.responses.at(-1).id,
      verdict: "persuaded",
      reason: "evidence supports the claim",
    });
    await auditChecked(fixture.org, fixture.worktreeId, "brief", BRIEF_ITEMS);
    await auditAccept(fixture.org, fixture.worktreeId, "brief");
  });
  const legacy = readAudit(fixture.org, fixture.worktreeId);
  const brief = legacy.checkpoints.brief;
  delete brief.checkedBoundHash;
  for (const list of [
    brief.objections,
    brief.responses,
    brief.rulings,
    brief.checked,
  ]) {
    for (const item of list) delete item.verifiedCaller;
  }
  writeJSON(auditFilePath(fixture.org, fixture.worktreeId), legacy);

  assert.equal(
    hasUnresolvedObjections(fixture.org, fixture.worktreeId, "brief"),
    false,
  );
  assert.equal(
    await hasValidAcceptance(fixture.org, fixture.worktreeId, "brief"),
    true,
  );
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditChecked(fixture.org, fixture.worktreeId, "brief", BRIEF_ITEMS),
  );
  const rewritten = readAudit(fixture.org, fixture.worktreeId).checkpoints
    .brief;
  assert.deepEqual(rewritten.checked, BRIEF_ITEMS);
  assert.equal(rewritten.objections[0].verifiedCaller, undefined);
  assert.equal(rewritten.responses[0].verifiedCaller, undefined);
  assert.equal(rewritten.rulings[0].verifiedCaller, undefined);
  assert.equal(
    await hasValidAcceptance(fixture.org, fixture.worktreeId, "brief"),
    true,
  );
});

test("D3 (g): a PM-shaped or unlaunched handle still cannot record an auditor-only command", async (t) => {
  const fixture = kickoff(t);
  await assert.rejects(
    withOrcaHandle(fixture.pmHandle, () =>
      auditChecked(fixture.org, fixture.worktreeId, "brief", BRIEF_ITEMS),
    ),
    /is not the current auditor terminal/,
  );
  assert.equal(d3Counts(fixture).checked, 0);
});

// D4 (finding d4-auditor-independence-string-compare, the parts the earlier
// exact/nested/symlink tests do not reach): the forbidden list now also holds
// every worktree a workflow task of this kickoff recorded in its receipt, so a
// worker with no launch-ledger line is covered, and an unreadable workflow
// state refuses instead of shrinking the list.
async function d4AuditorFixture(t) {
  const fixture = kickoff(t, "wt-1", { auditor: { profile: "agy-oss" } });
  const originalCwd = process.cwd();
  t.after(() => process.chdir(originalCwd));
  process.chdir(fixture.dir);
  const workerDir = realTempDir(t, "omt-d4-worker-");
  const auditorDir = realTempDir(t, "omt-d4-auditor-");
  const roleTerminal = (worktree) =>
    main([
      "role-terminal",
      "--org",
      fixture.org,
      "--role",
      "auditor",
      "--worktree",
      `path:${worktree}`,
      "--state",
      fixture.entry.pm.stateDir,
    ]);
  // The org's auditor profile uses the agy provider, which role-terminal
  // refuses right after the D4 path check and before any terminal or trusted
  // Orca is touched. An independent path therefore ends in this refusal, which
  // proves the D4 check let it by without ever opening a session.
  const passesD4 = (worktree) =>
    assert.rejects(
      () => roleTerminal(worktree),
      /Agy 감사 지원은 별도의 신뢰 실행 경로 설계가 필요/,
    );
  return { fixture, workerDir, auditorDir, roleTerminal, passesD4 };
}

async function d4RecordReceipt(fixture, workflowId, worktreePath) {
  await createFixtureWorkflow(fixture, workflowId);
  const file = path.join(
    fixture.entry.pm.stateDir,
    "workflows",
    workflowId,
    "state.json",
  );
  const state = readJSON(file);
  state.tasks.a.worktreeId = `wt-receipt::${worktreePath}`;
  writeJSON(file, state);
  return file;
}

test("D4: role-terminal --role auditor refuses a worktree only a workflow task receipt records, including nested and symlinked spellings", async (t) => {
  const { fixture, workerDir, auditorDir, roleTerminal, passesD4 } =
    await d4AuditorFixture(t);
  await d4RecordReceipt(fixture, "wf-d4-receipt", workerDir);
  assert.equal(
    readLaunches(fixture.org).some((line) => line.worktreePath === workerDir),
    false,
    "the worker must have no launch-ledger line for this to prove the receipt path",
  );
  await assert.rejects(
    () => roleTerminal(workerDir),
    /PM or a worker already uses/,
  );
  const nested = path.join(workerDir, "deep", "nested");
  fs.mkdirSync(nested, { recursive: true });
  await assert.rejects(
    () => roleTerminal(nested),
    /PM or a worker already uses/,
  );
  const alias = path.join(realTempDir(t, "omt-d4-alias-"), "alias");
  fs.symlinkSync(workerDir, alias, "dir");
  await assert.rejects(
    () => roleTerminal(alias),
    /PM or a worker already uses/,
  );
  await passesD4(auditorDir);
});

test("D4: role-terminal --role auditor refuses an unreadable workflow state instead of ignoring it (fail closed)", async (t) => {
  const { fixture, workerDir, auditorDir, roleTerminal, passesD4 } =
    await d4AuditorFixture(t);
  const file = await d4RecordReceipt(fixture, "wf-d4-corrupt", workerDir);
  await passesD4(auditorDir);
  // A stray regular file under workflows/ (e.g. macOS's .DS_Store) is not a
  // workflow, so it must not refuse an otherwise independent path.
  const workflows = path.join(fixture.entry.pm.stateDir, "workflows");
  fs.writeFileSync(path.join(workflows, ".DS_Store"), "not a workflow");
  await passesD4(auditorDir);
  // A directory with no state.json is a workflow that cannot be read.
  const empty = path.join(workflows, "wf-d4-empty");
  fs.mkdirSync(empty);
  await assert.rejects(
    () => roleTerminal(auditorDir),
    /workflow wf-d4-empty .* cannot be read/,
  );
  fs.rmdirSync(empty);
  fs.writeFileSync(file, "{ not json");
  await assert.rejects(
    () => roleTerminal(auditorDir),
    /workflow wf-d4-corrupt .* cannot be read/,
  );
  // typeof null and typeof [] are both "object", so a state whose tasks is
  // null or an array must be refused as malformed too, not crash later.
  for (const tasks of [null, []]) {
    fs.writeFileSync(file, JSON.stringify({ tasks }));
    await assert.rejects(
      () => roleTerminal(auditorDir),
      /workflow wf-d4-corrupt .* cannot be read \(malformed state\)/,
    );
  }
});

test("D4: role-terminal --role auditor refuses a differently-cased spelling of a launch-ledger worker's worktree (case-insensitive filesystems only)", async (t) => {
  const { fixture, workerDir, auditorDir, roleTerminal, passesD4 } =
    await d4AuditorFixture(t);
  if (!isFilesystemCaseInsensitive(path.dirname(workerDir))) {
    t.skip(
      "this filesystem is case-sensitive, so a case variant is a different path",
    );
    return;
  }
  recordLaunch(fixture.org, {
    via: "worker-start",
    role: "senior",
    stateDir: fixture.entry.pm.stateDir,
    worktreePath: workerDir,
    callerCwd: workerDir,
  });
  const variant = path.join(
    path.dirname(workerDir),
    path.basename(workerDir).toUpperCase(),
  );
  assert.notEqual(variant, workerDir);
  await assert.rejects(
    () => roleTerminal(variant),
    /PM or a worker already uses/,
  );
  await passesD4(auditorDir);
});

// Appendix G: workflow-accept's audit checks and the result repository.

const OUTCOME_CHECKED = [
  { type: "statement", id: "s1" },
  { type: "criterion", id: "c1" },
];

// Takes the fixture workflow's only task to accepted through the runtime path
// (tests/accepted-workflow-fixture.mjs: attach, settle, real evidence,
// acceptOutcome, resume), with a receipt naming `worktreePath`; the workflow
// decision then comes from the real acceptWorkflowIntegration, as in the test
// "workflow-accept records the result repository from a real single-task
// acceptance, and close-ready then passes with it (G-1 end to end)".
async function stageAcceptedTask(
  fixture,
  workflowId,
  {
    worktreePath = fixture.repo,
    stateDir = fixture.entry.pm.stateDir,
    taskId,
  } = {},
) {
  return acceptTaskThroughRuntime({
    org: fixture.org,
    stateDir,
    taskDir: fixture.dir,
    workflowId,
    resultRepo: worktreePath,
    taskId,
  });
}

const acceptStaged = (staged, repo) =>
  acceptWorkflowIntegration(
    staged.stateDir,
    staged.workflowId,
    staged.revision,
    repo,
  );

const auditorAcceptsOutcome = (
  fixture,
  repo = fixture.repo,
  head = fixture.head,
) =>
  withOrcaHandle(fixture.auditorHandle, async () => {
    await auditChecked(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      OUTCOME_CHECKED,
      undefined,
      head,
      repo,
    );
    return auditAccept(fixture.org, fixture.worktreeId, "outcome", head, repo);
  });

const signalCloseReady = (fixture) =>
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

test("workflow-accept records the result repository from a real single-task acceptance, and close-ready then passes with it (G-1 end to end)", async (t) => {
  const fixture = kickoff(t, "wt-1", {
    auditor: { profile: "claude-current" },
  });
  const staged = await stageAcceptedTask(fixture, "wf-e2e");
  // Before workflow-accept the repository is undetermined, so no outcome
  // acceptance is recorded (checklist 21).
  await assert.rejects(
    () => auditorAcceptsOutcome(fixture),
    /result repository is not determined/,
  );
  const accepted = await acceptStaged(staged);
  assert.equal(
    accepted.integration.decision.checkoutPath,
    fs.realpathSync.native(fixture.repo),
  );
  assert.deepEqual(accepted.integration.decision.auditGate, {
    mode: "configured",
    source: fixture.entry.auditPolicy.source,
  });
  await auditorAcceptsOutcome(fixture);
  await assert.doesNotReject(() => signalCloseReady(fixture));
  // Counterexample 4: a real HEAD change after workflow-accept leaves the
  // accepted decision alone, and close-ready then refuses.
  const decisionBytes = fs.readFileSync(staged.file);
  git(fixture.dir, ["commit", "-q", "--allow-empty", "-m", "moves HEAD"]);
  await assert.rejects(() => signalCloseReady(fixture));
  assert.deepEqual(fs.readFileSync(staged.file), decisionBytes);
});

test("h1: a new outcome objection after a recorded outcome acceptance makes close-ready and deliver each refuse, on the same HEAD and ledger", async (t) => {
  const fixture = kickoff(t, "wt-1", {
    auditor: { profile: "claude-current" },
    deliverable: true,
  });
  await acceptStaged(await stageAcceptedTask(fixture, "wf-h1"));
  await requirementsFidelity(fixture.org, fixture.worktreeId, {
    head: fixture.head,
    repo: fixture.repo,
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
  await withOrcaHandle(fixture.auditorHandle, async () => {
    await auditChecked(
      fixture.org,
      fixture.worktreeId,
      "brief",
      OUTCOME_CHECKED,
    );
    await auditAccept(fixture.org, fixture.worktreeId, "brief");
  });
  await auditorAcceptsOutcome(fixture);

  const closeReady = () =>
    assertKickoffCloseReady(fixture.org, fixture.worktreeId, {
      head: fixture.head,
      repo: fixture.repo,
      entry: fixture.entry,
    });
  const deliver = () =>
    deliverKickoff({
      orgFile: fixture.org,
      worktreeId: fixture.worktreeId,
      source: fixture.repo,
      head: fixture.head,
      callerCwd: fixture.dir,
    });

  // Before the objection: close-ready passes and deliver really succeeds,
  // merging the verified result HEAD into the owner checkout's main.
  await assert.doesNotReject(closeReady);
  await assert.doesNotReject(() => signalCloseReady(fixture));
  const delivered = await deliver();
  assert.equal(delivered.delivered, true);
  assert.equal(delivered.merged, true);
  assert.equal(delivered.branch, "main");
  assert.equal(delivered.head, fixture.head);
  assert.equal(delivered.mergeCommit, git(fixture.dir, ["rev-parse", "HEAD"]));
  git(fixture.dir, ["merge-base", "--is-ancestor", fixture.head, "main"]);
  assert.equal(
    fs.readFileSync(path.join(fixture.dir, "result.md"), "utf8"),
    "delivered result\n",
  );

  const headBefore = git(fixture.repo, ["rev-parse", "HEAD"]);
  const ledgerBefore = ledgerHash(readLedger(fixture.org, fixture.worktreeId));
  const request = path.join(fixture.dir, "h1-objection.json");
  writeJSON(request, {
    checkpoint: "outcome",
    target: { type: "criterion", id: "c1" },
    kind: "gap",
    description: "criterion c1 is not delivered after all",
    rebuttalRequested: "show where it is delivered",
    resultHead: fixture.head,
    repo: fixture.repo,
  });
  const objected = runCli(
    [
      "audit-objection",
      "--org",
      fixture.org,
      "--worktree",
      fixture.worktreeId,
      "--from",
      request,
    ],
    { cwd: fixture.dir, env: { ORCA_TERMINAL_HANDLE: fixture.auditorHandle } },
  );
  assert.equal(objected.code, 0, objected.stderr);
  assert.equal(JSON.parse(objected.stdout).recorded, true);
  // Only the objection changed: same HEAD, same ledger.
  assert.equal(git(fixture.repo, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(
    ledgerHash(readLedger(fixture.org, fixture.worktreeId)),
    ledgerBefore,
  );

  const refusal = /Outcome audit acceptance is missing or no longer valid/;
  await assert.rejects(closeReady, refusal);
  await assert.rejects(deliver, refusal);
});

test("h2: worker-start under a kickoff with no pinned audit policy is refused by name with the retrofit command, not by an incidental TypeError", async (t) => {
  const fixture = legacyKickoff(t, "wt-legacy");
  fs.mkdirSync(fixture.entry.pm.path, { recursive: true });
  await assert.rejects(
    () =>
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
        path.join(fixture.dir, "missing-orca"),
      ]),
    (error) => {
      assert.equal(error instanceof TypeError, false);
      assert.match(error.message, /no pinned audit policy/);
      assert.match(error.message, /kickoff-audit-policy-retrofit/);
      return true;
    },
  );
});

test("workflow-accept refuses an unresolved outcome objection raised before acceptance, through the CLI without --org too, and leaves state.json untouched", async (t) => {
  const fixture = kickoff(t, "wt-1", {
    auditor: { profile: "claude-current" },
  });
  const staged = await stageAcceptedTask(fixture, "wf-objection");
  await withOrcaHandle(fixture.auditorHandle, () =>
    auditObjection(fixture.org, fixture.worktreeId, {
      checkpoint: "outcome",
      target: { type: "criterion", id: "c1" },
      kind: "gap",
      description: "the result does not show c1",
      rebuttalRequested: "point at the evidence for c1",
      resultHead: fixture.head,
      repo: fixture.repo,
    }),
  );
  const before = fs.readFileSync(staged.file);
  await assert.rejects(() => acceptStaged(staged), /unresolved objection/);
  // Counterexample 8: no --org to omit, and the registry still resolves the
  // kickoff from --state, so the objection check cannot be skipped.
  await assert.rejects(
    () =>
      main([
        "workflow-accept",
        "--state",
        staged.stateDir,
        "--id",
        staged.workflowId,
        "--revision",
        String(staged.revision),
      ]),
    /unresolved objection/,
  );
  assert.deepEqual(fs.readFileSync(staged.file), before);
});

test("an outcome objection before workflow-accept is admitted only for a possible result repository (it only blocks; a ruling lifts it)", async (t) => {
  const fixture = kickoff(t, "wt-1", {
    auditor: { profile: "claude-current" },
  });
  const raise = (repo) =>
    withOrcaHandle(fixture.auditorHandle, () =>
      auditObjection(fixture.org, fixture.worktreeId, {
        checkpoint: "outcome",
        target: { type: "criterion", id: "c1" },
        kind: "gap",
        description: "gap",
        rebuttalRequested: "show it",
        resultHead: fixture.head,
        repo,
      }),
    );
  // No workflow of this kickoff exists yet: nothing can be a candidate.
  await assert.rejects(() => raise(fixture.repo), /not a candidate/);
  const other = realTempDir(t, "omt-g-other-");
  const otherHead = initRepo(other);
  const staged = await stageAcceptedTask(fixture, "wf-candidate");
  // Counterexample 6: a repository the recorded state does not name.
  await assert.rejects(
    () =>
      withOrcaHandle(fixture.auditorHandle, () =>
        auditObjection(fixture.org, fixture.worktreeId, {
          checkpoint: "outcome",
          target: { type: "criterion", id: "c1" },
          kind: "gap",
          description: "gap",
          rebuttalRequested: "show it",
          resultHead: otherHead,
          repo: other,
        }),
      ),
    /not a candidate/,
  );
  await assert.doesNotReject(() => raise(fixture.repo));
  // A workflow that ended blocked is not a candidate: retrying revives it.
  const state = readJSON(staged.file);
  state.status = "blocked";
  writeJSON(staged.file, state);
  await assert.rejects(() => raise(fixture.repo), /not a candidate/);
});

test("workflow-accept without an auditor duty keeps its old behaviour, and a kickoff whose audit policy was never pinned refuses with the retrofit command", async (t) => {
  // Not configured: pinned false, so nothing about the result repository is
  // recorded and a mismatched receipt does not matter.
  const plain = kickoff(t, "wt-plain");
  const plainStaged = await stageAcceptedTask(plain, "wf-plain");
  const plainDecision = (await acceptStaged(plainStaged)).integration.decision;
  assert.deepEqual(plainDecision.auditGate, {
    mode: "not-configured",
    source: plain.entry.auditPolicy.source,
  });
  assert.equal("checkoutPath" in plainDecision, false);
  // Consumers of a not-configured kickoff pass the caller's value through.
  assert.equal(bindKickoffResultRepo(plain.entry, "/any/repo"), "/any/repo");

  // No kickoff owns the state directory: no audit fields at all.
  const owner = kickoff(t, "wt-owner", {
    auditor: { profile: "claude-current" },
  });
  const loose = realTempDir(t, "omt-g-loose-");
  initRepo(loose);
  const looseState = path.join(loose, ".omt");
  const looseStaged = await stageAcceptedTask(owner, "wf-loose", {
    stateDir: looseState,
  });
  const looseDecision = (await acceptStaged(looseStaged)).integration.decision;
  assert.equal("auditGate" in looseDecision, false);
  assert.equal("checkoutPath" in looseDecision, false);

  // A registered kickoff with no pinned policy is refused outright.
  const legacy = legacyKickoff(t, "wt-legacy");
  const legacyStaged = await stageAcceptedTask(legacy, "wf-legacy");
  const before = fs.readFileSync(legacyStaged.file);
  await assert.rejects(
    () => acceptStaged(legacyStaged),
    /no pinned audit policy.*kickoff-audit-policy-retrofit/,
  );
  assert.deepEqual(fs.readFileSync(legacyStaged.file), before);
});

test("the recorded result repository binds every outcome consumer: another repository, an older decision and disagreeing workflows are refused", async (t) => {
  const fixture = kickoff(t, "wt-1", {
    auditor: { profile: "claude-current" },
  });
  const staged = await stageAcceptedTask(fixture, "wf-bound");
  await acceptStaged(staged);
  // A clone, so it holds the commit the workflow's tasks pin as their base;
  // an unrelated init commit only matches that hash when both are made within
  // the same second.
  const other = realTempDir(t, "omt-g-consumer-other-");
  git(other, ["clone", "-q", fixture.dir, "."]);
  git(other, ["config", "user.email", "auditor-test@example.com"]);
  git(other, ["config", "user.name", "Auditor Test"]);
  git(other, ["commit", "-q", "--allow-empty", "-m", "other repository"]);
  const otherHead = git(other, ["rev-parse", "HEAD"]);
  // Counterexample 5 and 6: another repository, forged as the caller's value.
  await assert.rejects(
    () => auditorAcceptsOutcome(fixture, other, otherHead),
    /not the result repository/,
  );
  await assert.rejects(
    () =>
      withOrcaHandle(fixture.auditorHandle, () =>
        auditObjection(fixture.org, fixture.worktreeId, {
          checkpoint: "outcome",
          target: { type: "criterion", id: "c1" },
          kind: "gap",
          description: "gap",
          rebuttalRequested: "show it",
          resultHead: otherHead,
          repo: other,
        }),
      ),
    /not the result repository/,
  );
  // The caller may omit the repository: the recorded one is used.
  assert.equal(
    bindKickoffResultRepo(fixture.entry, undefined),
    fs.realpathSync.native(fixture.repo),
  );
  // Two accepted workflows that recorded different repositories disagree.
  const second = await stageAcceptedTask(fixture, "wf-second", {
    worktreePath: other,
  });
  await acceptStaged(second);
  assert.throws(
    () => bindKickoffResultRepo(fixture.entry, fixture.repo),
    /different result repositories/,
  );
  fs.rmSync(path.dirname(second.file), { recursive: true });
  // Counterexample 7: a decision saved before checkoutPath existed cannot
  // name the repository, so this configured kickoff refuses it.
  const state = readJSON(staged.file);
  delete state.integration.decision.checkoutPath;
  writeJSON(staged.file, state);
  assert.throws(
    () => bindKickoffResultRepo(fixture.entry, fixture.repo),
    /predates result-repository binding/,
  );
  await assert.rejects(
    () => signalCloseReady(fixture),
    /predates result-repository binding/,
  );
});

test("resolveResultRepo: one recorded worktree is the only candidate, and the caller's value never widens it", async (t) => {
  const repoA = realTempDir(t, "omt-g-a-");
  const repoB = realTempDir(t, "omt-g-b-");
  const task = (state, worktreeId, execution) => ({
    state,
    worktreeId,
    ...(execution ? { execution: { worktreeId: execution } } : {}),
  });
  const workflow = (tasks, integration = {}) => ({ tasks, integration });
  const one = workflow({ a: task("accepted", `wt::${repoA}`) });
  assert.equal(resolveResultRepo(one), repoA);
  assert.equal(resolveResultRepo(one, repoA), repoA);
  // Counterexample 6: a forged caller value is compared, never adopted.
  assert.throws(() => resolveResultRepo(one, repoB), /not the worktree/);
  // A symlink spelling of the same repository is the same repository.
  const alias = path.join(realTempDir(t, "omt-g-alias-"), "alias");
  fs.symlinkSync(repoA, alias, "dir");
  assert.equal(resolveResultRepo(one, alias), repoA);
  // Condition 5: different receipt repositories cannot be decided, with or
  // without a caller value, including a task whose two receipts disagree.
  const two = workflow({
    a: task("accepted", `wt::${repoA}`),
    b: task("accepted", `wt::${repoB}`),
  });
  assert.throws(() => resolveResultRepo(two), /differ/);
  assert.throws(() => resolveResultRepo(two, repoA), /differ/);
  const split = workflow({
    a: task("accepted", `wt::${repoA}`, `wt::${repoB}`),
  });
  assert.throws(() => resolveResultRepo(split), /differ/);
  // A vanished worktree is refused, not dropped (which would leave one).
  const gone = path.join(repoB, "gone");
  const vanished = workflow({
    a: task("accepted", `wt::${repoA}`),
    b: task("accepted", `wt::${gone}`),
  });
  assert.throws(() => resolveResultRepo(vanished, repoA), /no longer resolves/);
  // A blocked or failed task is never a candidate.
  const failed = workflow({
    a: task("accepted", `wt::${repoA}`),
    b: task("failed", `wt::${repoB}`),
  });
  assert.equal(resolveResultRepo(failed), repoA);
  assert.throws(() => resolveResultRepo(workflow({})), /No accepted task/);
});

test("resolveResultRepo: integration required takes the caller's checkout as an unverified candidate only, and a recorded decision fixes the answer", async (t) => {
  const repoA = realTempDir(t, "omt-g-int-a-");
  const repoB = realTempDir(t, "omt-g-int-b-");
  const receipt = { a: { state: "accepted", worktreeId: `wt::${repoB}` } };
  const required = { tasks: receipt, integration: { required: true } };
  // Task receipt paths are never the result repository here.
  assert.throws(() => resolveResultRepo(required), /requires integration/);
  assert.equal(resolveResultRepo(required, repoA), repoA);
  assert.throws(
    () => resolveResultRepo(required, path.join(repoA, "missing")),
    /does not resolve/,
  );
  const decided = {
    tasks: receipt,
    integration: { required: true, decision: { checkoutPath: repoA } },
  };
  assert.equal(resolveResultRepo(decided, repoA), repoA);
  assert.throws(
    () => resolveResultRepo(decided, repoB),
    /not the one this workflow was accepted with/,
  );
  assert.throws(
    () =>
      resolveResultRepo(
        { tasks: receipt, integration: { decision: {} } },
        repoA,
      ),
    /accepted before its result repository was recorded/,
  );
});

// A real integration-required workflow inside the audited fixture: one
// component task settled and accepted, the frozen integration task verified
// and accepted, so only workflow-accept itself is left to call.
async function integrationRequiredWorkflow(fixture, workflowId) {
  const stateDir = fixture.entry.pm.stateDir;
  writeJSON(path.join(fixture.dir, "a.json"), taskBody("a"));
  writeJSON(
    path.join(fixture.dir, "integration.json"),
    taskBody("integration"),
  );
  await createWorkflow(
    stateDir,
    {
      schemaVersion: 1,
      id: workflowId,
      goal: "integration required",
      repo: ".",
      integrationTask: "integration.json",
      tasks: [{ file: "a.json", role: "junior" }],
      policy: { maxRunning: 1, maxReviewPending: 1 },
      budget: { maxAttempts: 1, maxCalls: 4 },
    },
    readJSON(fixture.org),
    fixture.dir,
  );
  await acceptComponentTask({
    stateDir,
    workflowId,
    taskId: "a",
    resultRepo: fixture.dir,
  });
  const snapshot = readWorkflow(stateDir, workflowId);
  const frozen = readJSON(path.join(snapshot.dir, "integration-task.json"));
  const report = {
    taskId: frozen.id,
    taskHash: taskHash(frozen),
    taskRevision: 1,
    runId: "integration-run",
    evidence: await verify(fixture.dir, {
      baseRef: frozen.baseRef,
      commands: frozen.checks,
      environment: frozen.environment,
      store: path.join(stateDir, "evidence"),
    }),
  };
  await acceptOutcome(
    fixture.dir,
    frozen,
    report,
    {
      schemaVersion: 1,
      id: "integration-decision",
      decider: { kind: "pm", executionId: "pm" },
      criteria: ["check"],
      basis: "combined check passed",
    },
    stateDir,
  );
  return {
    stateDir,
    workflowId,
    report,
    revision: snapshot.state.revision,
    file: path.join(snapshot.dir, "state.json"),
  };
}

test("workflow-accept with integration required: the checkout is resolved once, verified by gateCheck, and recorded as its real path (counterexamples a, b, c)", async (t) => {
  const fixture = kickoff(t, "wt-1", {
    auditor: { profile: "claude-current" },
  });
  // The workflow-accept gateCheck re-reads the workspace fingerprint, so the
  // untracked fixture files stay hidden for the whole test.
  await withUntrackedHidden(fixture.dir, async () => {
    const wf = await integrationRequiredWorkflow(fixture, "wf-integration");
    const accept = (repo) =>
      acceptWorkflowIntegration(
        wf.stateDir,
        wf.workflowId,
        wf.revision,
        repo,
        wf.report,
      );
    const before = fs.readFileSync(wf.file);
    // (b) A checkout that does not resolve is refused before any gateCheck and
    // before any write.
    await assert.rejects(
      () => accept(path.join(fixture.dir, "missing-checkout")),
      /does not resolve to a directory/,
    );
    assert.deepEqual(fs.readFileSync(wf.file), before);
    // (a) A symlink spelling is accepted and recorded as the real path.
    const alias = path.join(realTempDir(t, "omt-g-int-alias-"), "alias");
    fs.symlinkSync(fixture.dir, alias, "dir");
    const accepted = await accept(alias);
    assert.equal(
      accepted.integration.decision.checkoutPath,
      fs.realpathSync.native(fixture.dir),
    );
    // (c) With a decision recorded, another checkout is refused and the
    // recorded state stays as it was.
    const decided = fs.readFileSync(wf.file);
    const other = realTempDir(t, "omt-g-int-other-");
    initRepo(other);
    await assert.rejects(
      () =>
        acceptWorkflowIntegration(
          wf.stateDir,
          wf.workflowId,
          readWorkflow(wf.stateDir, wf.workflowId).state.revision,
          other,
          wf.report,
        ),
      /not the one this workflow was accepted with/,
    );
    assert.deepEqual(fs.readFileSync(wf.file), decided);
  });
});

test("withUntrackedHidden restores the exclude file byte for byte on success and failure, and refuses a repository outside the temp directory", async (t) => {
  const exclude = (repo) => path.join(repo, ".git", "info", "exclude");
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file) : null);

  // The file existed with content that does not end in a newline.
  const withContent = realTempDir(t, "omt-hide-content-");
  initRepo(withContent);
  fs.writeFileSync(exclude(withContent), "node_modules");
  const contentBefore = read(exclude(withContent));
  await withUntrackedHidden(withContent, async () => {
    assert.match(read(exclude(withContent)).toString(), /\n\*\n$/);
  });
  assert.deepEqual(read(exclude(withContent)), contentBefore);

  // The file did not exist: it is deleted again, on success and on a throw.
  const absent = realTempDir(t, "omt-hide-absent-");
  initRepo(absent);
  fs.rmSync(exclude(absent), { force: true });
  await withUntrackedHidden(absent, async () => {
    assert.equal(read(exclude(absent)).toString(), "*\n");
  });
  assert.equal(read(exclude(absent)), null);
  await assert.rejects(
    () =>
      withUntrackedHidden(absent, async () => {
        throw new Error("work failed");
      }),
    /work failed/,
  );
  assert.equal(read(exclude(absent)), null);

  // A failing check (verify reports failed, acceptOutcome refuses) restores it.
  const failing = realTempDir(t, "omt-hide-failing-");
  initRepo(failing);
  const failingBefore = read(exclude(failing));
  const org = path.join(failing, ".omt", "organization.json");
  fs.mkdirSync(path.dirname(org), { recursive: true });
  fs.copyFileSync(exampleOrg, org);
  const stateDir = path.join(failing, ".omt");
  await createSingleTaskWorkflow(org, stateDir, failing, "wf-failing", {
    checks: [[process.execPath, "-e", "process.exit(1)"]],
  });
  await assert.rejects(() =>
    acceptComponentTask({
      stateDir,
      workflowId: "wf-failing",
      taskId: "a",
      resultRepo: failing,
    }),
  );
  assert.deepEqual(read(exclude(failing)), failingBefore);

  // A repository outside the temporary directory is refused untouched.
  const real = path.join(REPO_ROOT, ".git");
  const cwdBefore = fs.existsSync(real);
  await assert.rejects(
    () => withUntrackedHidden(REPO_ROOT, async () => {}),
    /not inside/,
  );
  assert.equal(fs.existsSync(real), cwdBefore);
});

// #139 f7: the director's append-only decision of one result repository when a
// kickoff's accepted workflows recorded several (kickoffResultRepoDecide).

// Every file under the registry, the audit records and the PM state, so a
// refusal can prove it changed none of them.
function f7Bytes(fixture) {
  const roots = [
    registryDirectory(fixture.org),
    path.join(path.dirname(fixture.org), "audits"),
    fixture.entry.pm.stateDir,
  ];
  const files = new Map();
  const walk = (entry) => {
    if (!fs.existsSync(entry)) return;
    if (fs.lstatSync(entry).isDirectory()) {
      for (const name of fs.readdirSync(entry)) walk(path.join(entry, name));
    } else {
      files.set(entry, fs.readFileSync(entry).toString("base64"));
    }
  };
  for (const root of roots) walk(root);
  return files;
}

async function assertUnchanged(fixture, work) {
  const before = f7Bytes(fixture);
  await work();
  assert.deepEqual(f7Bytes(fixture), before);
}

// audit-accept without first recording `checked`, so a refusal can be shown to
// have written nothing (the binding check runs before any coverage check).
const f7AuditAccept = (fixture, repo, head) =>
  withOrcaHandle(fixture.auditorHandle, () =>
    auditAccept(fixture.org, fixture.worktreeId, "outcome", head, repo),
  );

const F7_REASON = "the integration checkout contains every accepted head";

const f7Decide = (fixture, repo, reason = F7_REASON) =>
  withCwd(fixture.dir, () =>
    kickoffResultRepoDecide(fixture.org, fixture.worktreeId, { repo, reason }),
  );

const f7Resolve = (fixture) =>
  bindKickoffResultRepo(
    listKickoffs(fixture.org, fixture.worktreeId).kickoffs[0],
    undefined,
  );

const f7Ambiguous = { code: "result-repo-ambiguous" };

// Two accepted workflows that recorded different result repositories: `impl`
// (a clone, one commit ahead of the base) and the kickoff's own worktree
// `fixture.repo`, which merges impl's commit and so contains every accepted
// head. With `merge: false` no repository contains them all.
async function f7Kickoff(t, { merge = true, integration = false } = {}) {
  const fixture = kickoff(t, "wt-1", {
    auditor: { profile: "claude-current" },
    deliverable: true,
  });
  const impl = realTempDir(t, "omt-f7-impl-");
  git(impl, ["clone", "-q", fixture.dir, "."]);
  git(impl, ["config", "user.email", "auditor-test@example.com"]);
  git(impl, ["config", "user.name", "Auditor Test"]);
  git(impl, ["commit", "-q", "--allow-empty", "-m", "impl work"]);
  const implStaged = await stageAcceptedTask(fixture, "wf-impl", {
    worktreePath: impl,
    taskId: "impl-task",
  });
  await acceptStaged(implStaged);
  if (merge) {
    git(fixture.repo, ["pull", "-q", "--no-rebase", "--no-edit", impl, "HEAD"]);
  }
  let mainStaged;
  if (integration) {
    await f7IntegrationWorkflow(fixture, "wf-integration");
  } else {
    mainStaged = await stageAcceptedTask(fixture, "wf-main", {
      worktreePath: fixture.repo,
      taskId: "main-task",
    });
    await acceptStaged(mainStaged);
  }
  return {
    ...fixture,
    head: git(fixture.repo, ["rev-parse", "HEAD"]),
    impl,
    implStaged,
    mainStaged,
  };
}

// An integration-required workflow accepted in the kickoff's own worktree,
// with the integration report kept under <state>/reports like the others.
async function f7IntegrationWorkflow(fixture, workflowId) {
  const stateDir = fixture.entry.pm.stateDir;
  const repo = fixture.repo;
  writeJSON(path.join(fixture.dir, "int-comp.json"), taskBody("int-comp"));
  writeJSON(path.join(fixture.dir, "int-final.json"), taskBody("int-final"));
  await createWorkflow(
    stateDir,
    {
      schemaVersion: 1,
      id: workflowId,
      goal: "integration required",
      repo: ".",
      integrationTask: "int-final.json",
      tasks: [{ file: "int-comp.json", role: "junior" }],
      policy: { maxRunning: 1, maxReviewPending: 1 },
      budget: { maxAttempts: 1, maxCalls: 4 },
    },
    readJSON(fixture.org),
    fixture.dir,
  );
  await acceptComponentTask({
    stateDir,
    workflowId,
    taskId: "int-comp",
    resultRepo: repo,
  });
  await withUntrackedHidden(repo, async () => {
    const snapshot = readWorkflow(stateDir, workflowId);
    const frozen = readJSON(path.join(snapshot.dir, "integration-task.json"));
    const report = {
      taskId: frozen.id,
      taskHash: taskHash(frozen),
      taskRevision: 1,
      runId: `${workflowId}-integration-run`,
      evidence: await verify(repo, {
        baseRef: frozen.baseRef,
        commands: frozen.checks,
        environment: frozen.environment,
        store: path.join(stateDir, "evidence"),
      }),
    };
    const decisionId = `${workflowId}-integration-decision`;
    await recordAcceptanceRef(stateDir, workflowId, decisionId);
    await acceptOutcome(
      repo,
      frozen,
      report,
      {
        schemaVersion: 1,
        id: decisionId,
        decider: { kind: "pm", executionId: "pm" },
        criteria: ["check"],
        basis: "combined check passed",
      },
      stateDir,
      { workflowId },
    );
    writeJSON(path.join(stateDir, "reports", `${report.runId}.json`), {
      schemaVersion: 1,
      ...report,
      head: report.evidence.fingerprint.head,
    });
    await acceptWorkflowIntegration(
      stateDir,
      workflowId,
      snapshot.state.revision,
      repo,
      report,
    );
  });
}

// The ledger, fidelity and brief audit a kickoff needs before its close gates
// reach the outcome acceptance (the h1 test's own setup).
async function f7CompleteBriefSide(fixture) {
  await requirementsFidelity(fixture.org, fixture.worktreeId, {
    head: fixture.head,
    repo: fixture.repo,
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
  await withOrcaHandle(fixture.auditorHandle, async () => {
    await auditChecked(
      fixture.org,
      fixture.worktreeId,
      "brief",
      OUTCOME_CHECKED,
    );
    await auditAccept(fixture.org, fixture.worktreeId, "brief");
  });
}

const f7CloseReady = (fixture, repo = fixture.repo) =>
  assertKickoffCloseReady(fixture.org, fixture.worktreeId, {
    head: fixture.head,
    repo,
    entry: listKickoffs(fixture.org, fixture.worktreeId).kickoffs[0],
  });

const f7Deliver = (fixture, source = fixture.repo) =>
  deliverKickoff({
    orgFile: fixture.org,
    worktreeId: fixture.worktreeId,
    source,
    head: fixture.head,
    callerCwd: fixture.dir,
  });

const f7Release = (fixture, repo = fixture.repo) =>
  releaseKickoff(fixture.org, {
    worktreeId: fixture.worktreeId,
    reason: "completed",
    head: fixture.head,
    repo,
    callerCwd: fixture.dir,
  });

const f7Objection = (fixture, repo = fixture.repo) =>
  withOrcaHandle(fixture.auditorHandle, () =>
    auditObjection(fixture.org, fixture.worktreeId, {
      checkpoint: "outcome",
      target: { type: "criterion", id: "c1" },
      kind: "gap",
      description: "the result repository is not determined",
      rebuttalRequested: "name the repository that holds every accepted head",
      resultHead: fixture.head,
      repo,
    }),
  );

test("f7-1: with no decision record, audit-accept, close-ready, deliver and completed release all refuse two recorded result repositories and change nothing", async (t) => {
  const fixture = await f7Kickoff(t);
  await f7CompleteBriefSide(fixture);
  await assertUnchanged(fixture, async () => {
    await assert.rejects(
      () => f7AuditAccept(fixture, fixture.repo, fixture.head),
      f7Ambiguous,
    );
    await assert.rejects(() => f7CloseReady(fixture), f7Ambiguous);
    await assert.rejects(() => f7Deliver(fixture), f7Ambiguous);
    await assert.rejects(() => f7Release(fixture), f7Ambiguous);
    await assert.rejects(
      () => signalCloseReady(fixture),
      /different result repositories/,
    );
  });
  const error = await f7CloseReady(fixture).catch((caught) => caught);
  assert.deepEqual(
    [...error.candidates].sort(),
    [
      fs.realpathSync.native(fixture.impl),
      fs.realpathSync.native(fixture.repo),
    ].sort(),
  );
  assert.match(error.message, /kickoff-result-repo-decide/);
});

test("f7-2: an outcome objection records the ambiguity as a bindingDefect without touching binding or checked; any other binding error still refuses", async (t) => {
  const fixture = await f7Kickoff(t);
  const seeded = readAudit(fixture.org, fixture.worktreeId);
  seeded.checkpoints.outcome.checked = OUTCOME_CHECKED;
  writeJSON(auditFilePath(fixture.org, fixture.worktreeId), seeded);
  const before = readAudit(fixture.org, fixture.worktreeId).checkpoints.outcome;
  const { recorded } = await f7Objection(fixture);
  assert.equal(recorded, true);
  const after = readAudit(fixture.org, fixture.worktreeId).checkpoints.outcome;
  assert.equal(after.objections.length, 1);
  const [objection] = after.objections;
  assert.equal(objection.bindingDefect.code, "result-repo-ambiguous");
  assert.match(objection.bindingDefect.message, /kickoff-result-repo-decide/);
  assert.equal(objection.bindingDefect.candidates.length, 2);
  assert.deepEqual(after.binding, before.binding);
  assert.deepEqual(after.checked, before.checked);
  assert.equal(after.acceptance, null);
  // An ordinary objection carries no bindingDefect.
  const single = kickoff(t, "wt-2", { auditor: { profile: "claude-current" } });
  await acceptStaged(await stageAcceptedTask(single, "wf-single"));
  await withOrcaHandle(single.auditorHandle, () =>
    auditObjection(single.org, single.worktreeId, {
      checkpoint: "outcome",
      target: { type: "criterion", id: "c1" },
      kind: "gap",
      description: "gap",
      rebuttalRequested: "show it",
      resultHead: single.head,
      repo: single.repo,
    }),
  );
  assert.equal(
    "bindingDefect" in
      readAudit(single.org, single.worktreeId).checkpoints.outcome
        .objections[0],
    false,
  );
});

test("f7-2: binding errors other than the ambiguity are refused and leave the audit record unchanged", async (t) => {
  const fixture = await f7Kickoff(t);
  const other = realTempDir(t, "omt-f7-other-");
  git(other, ["clone", "-q", fixture.dir, "."]);
  // A decision that predates result-repository binding is a different error.
  const original = fs.readFileSync(fixture.implStaged.file);
  const state = readJSON(fixture.implStaged.file);
  delete state.integration.decision.checkoutPath;
  writeJSON(fixture.implStaged.file, state);
  await assertUnchanged(fixture, () =>
    assert.rejects(() => f7Objection(fixture), /predates result-repository/),
  );
  fs.writeFileSync(fixture.implStaged.file, original);
  // After a decision, a caller repository that is not the decided one is refused.
  await f7Decide(fixture, fixture.repo);
  await assertUnchanged(fixture, () =>
    assert.rejects(
      () => f7Objection(fixture, other),
      /not the result repository/,
    ),
  );
});

test("f7-3: a bindingDefect objection blocks acceptance until ruled persuaded, and persuaded alone does not choose a repository", async (t) => {
  const fixture = await f7Kickoff(t);
  await f7Objection(fixture);
  const evidencePath = "evidence.txt";
  fs.writeFileSync(path.join(fixture.dir, evidencePath), "proof\n");
  const objectionId = readAudit(fixture.org, fixture.worktreeId).checkpoints
    .outcome.objections[0].id;
  const respond = () =>
    recordOutcomeResponseDirectly(fixture, {
      objectionId,
      argument: "the integration checkout contains every accepted head",
      evidenceRefs: [
        {
          path: evidencePath,
          sha256: fileSha256(path.join(fixture.dir, evidencePath)),
        },
      ],
    }).response.id;
  const rule = (respondedAgainst, verdict) =>
    withOrcaHandle(fixture.auditorHandle, () =>
      auditRuling(fixture.org, fixture.worktreeId, {
        checkpoint: "outcome",
        objectionId,
        respondedAgainst,
        verdict,
        reason: "ruling",
      }),
    );
  // not-persuaded: the objection stays unresolved, so no acceptance path works.
  await rule(respond(), "not-persuaded");
  assert.equal(
    hasUnresolvedObjections(fixture.org, fixture.worktreeId, "outcome"),
    true,
  );
  await assert.rejects(
    () => f7AuditAccept(fixture, fixture.repo, fixture.head),
    /unresolved|result-repo|different result repositories/,
  );
  await assert.rejects(
    () =>
      stageAcceptedTask(fixture, "wf-more", {
        worktreePath: fixture.repo,
        taskId: "more-task",
      }),
    /unresolved objection/,
  );
  // persuaded, but nothing decided yet: audit-accept still refuses.
  await rule(respond(), "persuaded");
  assert.equal(
    hasUnresolvedObjections(fixture.org, fixture.worktreeId, "outcome"),
    false,
  );
  await assert.rejects(
    () => f7AuditAccept(fixture, fixture.repo, fixture.head),
    f7Ambiguous,
  );
  // persuaded and decided: acceptance holds for the decided repository and HEAD.
  await f7Decide(fixture, fixture.repo);
  const { accepted } = await auditorAcceptsOutcome(
    fixture,
    fixture.repo,
    fixture.head,
  );
  assert.ok(accepted);
  assert.equal(
    await hasValidAcceptance(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      fixture.head,
      fs.realpathSync.native(fixture.repo),
    ),
    true,
  );
});

test("f7-4: only the registered director's checkout may decide, with no callerCwd or --force way around it, and a blank reason is refused", async (t) => {
  const fixture = await f7Kickoff(t);
  const elsewhere = realTempDir(t, "omt-f7-elsewhere-");
  await assertUnchanged(fixture, async () => {
    await assert.rejects(
      () =>
        withCwd(elsewhere, () =>
          kickoffResultRepoDecide(fixture.org, fixture.worktreeId, {
            repo: fixture.repo,
            reason: F7_REASON,
            callerCwd: fixture.dir,
          }),
        ),
      /must be run from the director's checkout/,
    );
    for (const reason of ["", "   ", null]) {
      await assert.rejects(
        () => f7Decide(fixture, fixture.repo, reason),
        /--reason is required/,
      );
    }
    await assert.rejects(
      () =>
        withCwd(fixture.dir, () =>
          kickoffResultRepoDecide(fixture.org, "wt-missing", {
            repo: fixture.repo,
            reason: F7_REASON,
          }),
        ),
      /supervises no registered kickoff/,
    );
  });
  // The API names no caller directory: it takes the organization, the
  // worktree and one request object.
  assert.equal(kickoffResultRepoDecide.length, 3);
  const args = [
    "kickoff-result-repo-decide",
    "--org",
    fixture.org,
    "--worktree",
    fixture.worktreeId,
    "--repo",
    fixture.repo,
    "--reason",
    F7_REASON,
  ];
  await assertUnchanged(fixture, () => {
    const forced = runCli([...args, "--force"], { cwd: fixture.dir });
    assert.notEqual(forced.code, 0);
    assert.match(forced.stderr, /force/);
    const wrongCwd = runCli(args, { cwd: elsewhere });
    assert.notEqual(wrongCwd.code, 0);
    assert.match(wrongCwd.stderr, /director's checkout/);
  });
  // A kickoff with no registered director cannot be decided at all.
  const legacy = legacyKickoff(t, "wt-nodirector", { director: false });
  await assertUnchanged(legacy, () =>
    assert.rejects(
      () =>
        withCwd(legacy.dir, () =>
          kickoffResultRepoDecide(legacy.org, legacy.worktreeId, {
            repo: legacy.dir,
            reason: F7_REASON,
          }),
        ),
      /no registered director/,
    ),
  );
  // From the director's checkout the CLI records the decision.
  const decided = runCli(args, { cwd: fixture.dir });
  assert.equal(decided.code, 0, decided.stderr);
  assert.equal(JSON.parse(decided.stdout).decided, true);
  assert.equal(f7Resolve(fixture), fs.realpathSync.native(fixture.repo));
});

// Each mutation breaks one link of an accepted task's chain; decide must then
// refuse and write nothing. `file` is read, changed and restored by the test.
function f7Mutations(fixture) {
  const stateDir = fixture.entry.pm.stateDir;
  const decisionFile = path.join(
    stateDir,
    "decisions",
    "accept-wf-impl-impl-task.json",
  );
  const gateFile = path.join(stateDir, "gates", "impl-task.json");
  const reportFile = path.join(stateDir, "reports", "wf-impl-impl-task.json");
  const edit = (file, change) => () => {
    const value = readJSON(file);
    change(value);
    writeJSON(file, value);
  };
  return [
    ["decision file missing", () => fs.rmSync(decisionFile)],
    ["gate file missing", () => fs.rmSync(gateFile)],
    ["no matching report", () => fs.rmSync(reportFile)],
    [
      "two matching reports",
      () =>
        fs.copyFileSync(reportFile, path.join(stateDir, "reports", "dup.json")),
    ],
    [
      "unparseable report",
      () => fs.writeFileSync(path.join(stateDir, "reports", "bad.json"), "{"),
    ],
    [
      "decision taskHash",
      edit(decisionFile, (value) => (value.taskHash = "0".repeat(64))),
    ],
    [
      "decision revision",
      edit(decisionFile, (value) => (value.taskRevision = 2)),
    ],
    [
      "decision executionId",
      edit(decisionFile, (value) => (value.implementationExecutionId = "x")),
    ],
    ["decision id", edit(decisionFile, (value) => (value.id = "other"))],
    [
      "decision status",
      edit(decisionFile, (value) => (value.status = "rejected")),
    ],
    ["gate runId", edit(gateFile, (value) => (value.runId = "x"))],
    ["gate evidenceKey", edit(gateFile, (value) => (value.evidenceKey = "x"))],
    [
      "gate contract hash",
      edit(
        gateFile,
        (value) => (value.gates["contract-ready"].taskHash = "0".repeat(64)),
      ),
    ],
    [
      "gate decisionId",
      edit(
        gateFile,
        (value) => (value.gates["outcome-accepted"].decisionId = "x"),
      ),
    ],
    [
      "report fingerprint no longer hashes to its key",
      edit(
        reportFile,
        (value) => (value.evidence.fingerprint.environment = "forged"),
      ),
    ],
    [
      "report head differs from fingerprint",
      edit(reportFile, (value) => (value.head = "1".repeat(40))),
    ],
    [
      "report evidence not passed",
      edit(reportFile, (value) => (value.evidence.status = "failed")),
    ],
    [
      "workflow task taskHash",
      edit(
        fixture.implStaged.file,
        (value) => (value.tasks["impl-task"].taskHash = "0".repeat(64)),
      ),
    ],
    [
      "non-integration decision names a run",
      edit(
        fixture.implStaged.file,
        (value) => (value.integration.decision.runId = "run-x"),
      ),
    ],
    [
      "non-integration decision names a decision id",
      edit(
        fixture.implStaged.file,
        (value) => (value.integration.decision.decisionId = "x"),
      ),
    ],
  ];
}

test("f7-5: decide fails closed on a broken accepted chain and passes once it is intact without cache or old HEAD", async (t) => {
  const fixture = await f7Kickoff(t);
  const stateDir = fixture.entry.pm.stateDir;
  for (const [name, mutate] of f7Mutations(fixture)) {
    const saved = f7Bytes(fixture);
    mutate();
    await assertUnchanged(fixture, () =>
      assert.rejects(
        () => f7Decide(fixture, fixture.repo),
        (error) => {
          assert.ok(error instanceof Error, name);
          return true;
        },
        name,
      ),
    );
    // Put back exactly what was there, files the mutation removed included.
    for (const [file] of f7Bytes(fixture)) {
      if (!saved.has(file)) fs.rmSync(file);
    }
    for (const [file, content] of saved) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(content, "base64"));
    }
    assert.deepEqual(f7Bytes(fixture), saved, name);
  }
  // Positive: the evidence cache is gone and the repository's HEAD has moved
  // past every accepted head, yet the recorded chain alone proves containment.
  fs.rmSync(path.join(stateDir, "evidence"), { recursive: true, force: true });
  git(fixture.repo, ["commit", "-q", "--allow-empty", "-m", "later work"]);
  const { decision } = await f7Decide(fixture, fixture.repo);
  assert.equal(
    decision.headAtDecision,
    git(fixture.repo, ["rev-parse", "HEAD"]),
  );
  assert.notEqual(decision.headAtDecision, fixture.head);
  assert.ok(
    decision.proof.acceptedHeads.includes(
      git(fixture.impl, ["rev-parse", "HEAD"]),
    ),
  );
});

test("f7-5: an integration-required workflow's decision, gate and report are cross-checked too, and its head is among the proven heads", async (t) => {
  const fixture = await f7Kickoff(t, { integration: true });
  const stateDir = fixture.entry.pm.stateDir;
  const gateFile = path.join(stateDir, "gates", "int-final.json");
  const reportFile = path.join(
    stateDir,
    "reports",
    "wf-integration-integration-run.json",
  );
  const decisionFile = path.join(
    stateDir,
    "decisions",
    "wf-integration-integration-decision.json",
  );
  const cases = [
    ["integration gate runId", gateFile, (value) => (value.runId = "x")],
    [
      "integration decision hash",
      decisionFile,
      (value) => (value.taskHash = "0".repeat(64)),
    ],
    [
      "integration report key",
      reportFile,
      (value) => (value.evidence.key = "0".repeat(64)),
    ],
  ];
  for (const [name, file, change] of cases) {
    const original = fs.readFileSync(file);
    const value = readJSON(file);
    change(value);
    writeJSON(file, value);
    await assertUnchanged(fixture, () =>
      assert.rejects(() => f7Decide(fixture, fixture.repo), Error, name),
    );
    fs.writeFileSync(file, original);
  }
  fs.rmSync(reportFile);
  await assertUnchanged(fixture, () =>
    assert.rejects(() => f7Decide(fixture, fixture.repo), /exactly one report/),
  );
});

test("f7-6: a repository that is not a candidate, misses an accepted head, or is not the only one containing them is refused", async (t) => {
  const fixture = await f7Kickoff(t);
  const outside = realTempDir(t, "omt-f7-outside-");
  git(outside, ["clone", "-q", fixture.dir, "."]);
  await assertUnchanged(fixture, async () => {
    await assert.rejects(
      () => f7Decide(fixture, outside),
      /not a result repository any accepted workflow recorded/,
    );
    await assert.rejects(
      () => f7Decide(fixture, path.join(outside, "missing")),
      /does not resolve to a directory/,
    );
    await assert.rejects(
      () => f7Decide(fixture, fixture.impl),
      /does not contain accepted head/,
    );
  });
  // Both candidates now contain every accepted head: ambiguous, so refused.
  git(fixture.impl, [
    "pull",
    "-q",
    "--no-rebase",
    "--no-edit",
    fixture.repo,
    "HEAD",
  ]);
  await assertUnchanged(fixture, async () => {
    await assert.rejects(
      () => f7Decide(fixture, fixture.repo),
      /also contains every accepted head/,
    );
    await assert.rejects(
      () => f7Decide(fixture, fixture.impl),
      /also contains every accepted head/,
    );
  });
  // Without the merge, an accepted head is not even a commit of the repository.
  const apart = await f7Kickoff(t, { merge: false });
  await assertUnchanged(apart, async () => {
    await assert.rejects(
      () => f7Decide(apart, apart.repo),
      /does not contain accepted head/,
    );
    await assert.rejects(
      () => f7Decide(apart, apart.impl),
      /does not contain accepted head/,
    );
  });
});

// f7-6b and f7-6c used to fake Git failures with a POSIX shim first on PATH. The
// proof now runs only the trusted git through the local adapter, so such a shim
// can no longer cause any failure. The tests that replace them check the same
// counterexamples at the new boundary: a real Git error wherever Git can
// produce one, and an injected fault only for what cannot be made for real here
// (no trusted git, a timeout, a dying process). The injection lives in a child
// process that loads a preload module replacing that process's own
// child_process.spawnSync and fs.lstatSync; the production code has no hook, and
// no caller, CLI flag or environment variable can pick another executor.

const F7_PRELOAD = [
  'import childProcess from "node:child_process";',
  'import fs from "node:fs";',
  'import { syncBuiltinESMExports } from "node:module";',
  'const fault = JSON.parse(process.env.F7_FAULT || "null");',
  "const log = process.env.F7_CALL_LOG;",
  "const spawn = childProcess.spawnSync;",
  "const lstat = fs.lstatSync;",
  "childProcess.spawnSync = (file, args, options) => {",
  '  const hit = Boolean(fault && fault.mode !== "absent" && Array.isArray(args) && options?.cwd &&',
  "      fs.realpathSync.native(options.cwd) === fault.repo &&",
  "      fault.args.every((arg, index) => args[index] === arg));",
  "  if (log) {",
  '    fs.appendFileSync(log, JSON.stringify({ file, args, cwd: options?.cwd ?? null, injected: hit }) + "\\n");',
  "  }",
  "  if (hit) {",
  '    if (fault.mode === "death") {',
  '      return { status: null, signal: "SIGKILL", stdout: "", stderr: "" };',
  "    }",
  '    const error = Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" });',
  '    return { error, status: null, signal: "SIGTERM", stdout: "", stderr: "" };',
  "  }",
  "  return spawn(file, args, options);",
  "};",
  'if (fault?.mode === "absent") {',
  "  fs.lstatSync = (target, ...rest) => {",
  "    if (/(^|[\\\\/])git(\\.exe)?$/i.test(String(target))) {",
  '      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });',
  "    }",
  "    return lstat(target, ...rest);",
  "  };",
  "}",
  "syncBuiltinESMExports();",
  "",
].join("\n");

const F7_PROBE = [
  `import { kickoffResultRepoDecide } from ${JSON.stringify(
    pathToFileURL(
      path.join(REPO_ROOT, "plugins/oh-my-teams/scripts/kickoff-registry.mjs"),
    ).href,
  )};`,
  "const [org, worktreeId, repo] = process.argv.slice(2);",
  "let out;",
  "try {",
  `  out = kickoffResultRepoDecide(org, worktreeId, { repo, reason: ${JSON.stringify(F7_REASON)} });`,
  "} catch (error) {",
  "  out = { error: error.message };",
  "}",
  "process.stdout.write(JSON.stringify(out));",
  "",
].join("\n");

// Returns a function that runs kickoffResultRepoDecide for `repo` in a fresh
// child process whose cwd is the director's checkout. `fault` is injected by the
// preload ({mode: "absent"}, or {mode: "timeout" | "death", repo, args} for one
// Git call in one repository); `env` is merged onto the child's environment.
// The result is the decision or the error message, plus every spawnSync call
// the child made.
function f7ChildDecider(t) {
  const kit = realTempDir(t, "omt-f7-child-");
  fs.writeFileSync(path.join(kit, "preload.mjs"), F7_PRELOAD);
  fs.writeFileSync(path.join(kit, "probe.mjs"), F7_PROBE);
  let counter = 0;
  return (fixture, repo, { fault, env } = {}) => {
    counter += 1;
    const log = path.join(kit, `calls-${counter}.jsonl`);
    const injected = fault?.repo
      ? { ...fault, repo: fs.realpathSync.native(fault.repo) }
      : (fault ?? null);
    const stdout = execFileSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(path.join(kit, "preload.mjs")).href,
        path.join(kit, "probe.mjs"),
        fixture.org,
        fixture.worktreeId,
        repo,
      ],
      {
        cwd: fixture.dir,
        encoding: "utf8",
        env: {
          ...process.env,
          ...env,
          F7_CALL_LOG: log,
          F7_FAULT: JSON.stringify(injected),
        },
      },
    );
    const calls = fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
    // An injection that never fired would let the test pass on a real answer
    // from Git, so a timeout or death fault must have intercepted a call.
    if (injected?.mode === "timeout" || injected?.mode === "death") {
      assert.equal(
        calls.some((call) => call.injected === true),
        true,
        `the ${injected.mode} fault intercepted no call in ${injected.repo}`,
      );
    }
    return { ...JSON.parse(stdout), calls };
  };
}

// The spawn calls whose leading arguments are `args`, optionally in one directory.
const f7Calls = (calls, args, cwd) =>
  calls.filter(
    (call) =>
      args.every((arg, index) => call.args?.[index] === arg) &&
      (cwd === undefined ||
        (call.cwd &&
          fs.realpathSync.native(call.cwd) === fs.realpathSync.native(cwd))),
  );

// The loose object file of a commit; the fixture repositories hold few enough
// objects for Git to keep every one of them loose. The objects directory is
// asked of Git because a fixture checkout can be a linked worktree.
function f7LooseObject(repo, sha) {
  const objects = git(repo, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "objects",
  ]);
  const file = path.join(objects, sha.slice(0, 2), sha.slice(2));
  assert.equal(fs.existsSync(file), true, `${sha} must be a loose object`);
  fs.chmodSync(file, 0o666);
  return file;
}

const f7Corrupt = (repo, sha) =>
  fs.writeFileSync(f7LooseObject(repo, sha), "not a zlib stream\n");
const f7Remove = (repo, sha) => fs.rmSync(f7LooseObject(repo, sha));

function f7Commit(repo, message) {
  git(repo, ["commit", "-q", "--allow-empty", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

// What real Git answers for a command, so each fixture is shown to produce
// exactly the exit code its test relies on.
const f7GitStatus = (repo, args) =>
  spawnSync("git", args, { cwd: repo, stdio: "ignore" }).status;

const f7Verify = (sha) => [
  "rev-parse",
  "--verify",
  "--quiet",
  `${sha}^{commit}`,
];

const F7_VERIFY_ERROR =
  /Git could not decide whether commit [0-9a-f]{40} exists in (.*) \(exit 128\)/;
const F7_ANCESTOR_ERROR =
  /Git could not decide whether [0-9a-f]{40} is an ancestor of HEAD in (.*) \(exit 128\)/;

test("f7-6b (replaces PATH-shim f7-6b, a): with no trusted git the proof is refused for either repository and records keep their bytes", async (t) => {
  const fixture = await f7Kickoff(t);
  const decide = f7ChildDecider(t);
  await assertUnchanged(fixture, async () => {
    for (const repo of [fixture.repo, fixture.impl]) {
      const outcome = decide(fixture, repo, { fault: { mode: "absent" } });
      assert.equal(outcome.decision, undefined);
      assert.match(
        outcome.error,
        /result repository proof cannot run Git in .*No trusted git executable found/s,
      );
      // Not by path and not by name: no git was spawned for the proof at all.
      assert.deepEqual(f7Calls(outcome.calls, ["rev-parse"]), []);
      assert.deepEqual(f7Calls(outcome.calls, ["merge-base"]), []);
    }
  });
  // Without the fault the same child decides the same repository normally.
  const normal = decide(fixture, fixture.repo);
  assert.equal(normal.decision.repo, fs.realpathSync.native(fixture.repo));
});

test("f7-6b (replaces PATH-shim f7-6b, b d e f): a real Git error in only rev-parse --verify or only merge-base refuses either repository, bytes unchanged", async (t) => {
  // Each scenario damages one repository of a fresh fixture, then decides
  // fixture.repo. `real` is the repository where Git must report the error.
  const scenarios = [
    {
      name: "verify error in the other candidate",
      pattern: F7_VERIFY_ERROR,
      real: (fixture) => fixture.impl,
      damage: (fixture) => {
        // The commit that is both impl's HEAD and an accepted head: `rev-parse
        // HEAD` still answers, `rev-parse --verify <it>^{commit}` cannot read it.
        const head = git(fixture.impl, ["rev-parse", "HEAD"]);
        f7Corrupt(fixture.impl, head);
        assert.equal(f7GitStatus(fixture.impl, ["rev-parse", "HEAD"]), 0);
        assert.equal(f7GitStatus(fixture.impl, f7Verify(head)), 128);
      },
    },
    {
      name: "verify error in the chosen repository",
      pattern: F7_VERIFY_ERROR,
      real: (fixture) => fixture.repo,
      damage: (fixture) => {
        // The proof checks the accepted heads in sorted order, so damaging the
        // first one makes its commit check fail before any merge-base runs;
        // damaging a later one could let merge-base fail first (it also reads
        // parents), and that would be the other scenario.
        const accepted = [
          git(fixture.impl, ["rev-parse", "HEAD"]),
          git(fixture.repo, ["rev-parse", "HEAD"]),
        ].sort();
        f7Corrupt(fixture.repo, accepted[0]);
        assert.equal(f7GitStatus(fixture.repo, ["rev-parse", "HEAD"]), 0);
        assert.equal(f7GitStatus(fixture.repo, f7Verify(accepted[0])), 128);
      },
    },
    {
      name: "merge-base error in the other candidate",
      pattern: F7_ANCESTOR_ERROR,
      real: (fixture) => fixture.impl,
      damage: (fixture) => {
        const accepted = git(fixture.impl, ["rev-parse", "HEAD"]);
        const lost = f7Commit(fixture.impl, "lost");
        f7Commit(fixture.impl, "tip");
        f7Remove(fixture.impl, lost);
        // HEAD answers and the accepted commit itself is intact; only walking
        // from HEAD down to it hits the missing commit.
        assert.equal(f7GitStatus(fixture.impl, ["rev-parse", "HEAD"]), 0);
        assert.equal(f7GitStatus(fixture.impl, f7Verify(accepted)), 0);
        assert.equal(
          f7GitStatus(fixture.impl, [
            "merge-base",
            "--is-ancestor",
            accepted,
            "HEAD",
          ]),
          128,
        );
      },
    },
    {
      name: "merge-base error in the chosen repository",
      pattern: F7_ANCESTOR_ERROR,
      real: (fixture) => fixture.repo,
      damage: (fixture) => {
        const accepted = git(fixture.impl, ["rev-parse", "HEAD"]);
        const lost = f7Commit(fixture.repo, "lost");
        f7Commit(fixture.repo, "tip");
        f7Remove(fixture.repo, lost);
        assert.equal(f7GitStatus(fixture.repo, ["rev-parse", "HEAD"]), 0);
        assert.equal(f7GitStatus(fixture.repo, f7Verify(accepted)), 0);
        assert.equal(
          f7GitStatus(fixture.repo, [
            "merge-base",
            "--is-ancestor",
            accepted,
            "HEAD",
          ]),
          128,
        );
      },
    },
  ];
  for (const scenario of scenarios) {
    const fixture = await f7Kickoff(t);
    scenario.damage(fixture);
    await assertUnchanged(fixture, async () => {
      const error = await f7Decide(fixture, fixture.repo).then(
        () => assert.fail(`${scenario.name}: the proof must be refused`),
        (caught) => caught,
      );
      const match = scenario.pattern.exec(error.message);
      assert.ok(
        match,
        `${scenario.name}: unexpected refusal: ${error.message}`,
      );
      // The refusal names the repository where Git failed, and it is not the
      // other kind of failure or the ordinary "does not contain" answer.
      assert.equal(match[1], fs.realpathSync.native(scenario.real(fixture)));
      const unlike =
        scenario.pattern === F7_VERIFY_ERROR
          ? F7_ANCESTOR_ERROR
          : F7_VERIFY_ERROR;
      assert.doesNotMatch(error.message, unlike);
      assert.doesNotMatch(error.message, /does not contain|cannot be read/);
    });
  }
});

test("f7-6c (replaces PATH-shim f7-6c, c d f): a timeout or a dying Git process at any proof call refuses either repository, bytes unchanged", async (t) => {
  const fixture = await f7Kickoff(t);
  const decide = f7ChildDecider(t);
  const calls = [
    {
      args: ["rev-parse", "HEAD"],
      pattern: /HEAD of (candidate )?.* cannot be read/,
    },
    {
      args: ["rev-parse", "--verify"],
      pattern:
        /could not decide whether commit [0-9a-f]{40} exists in .* \(exit none\)/,
    },
    {
      args: ["merge-base"],
      pattern:
        /could not decide whether [0-9a-f]{40} is an ancestor of HEAD in .* \(exit none\)/,
    },
  ];
  await assertUnchanged(fixture, async () => {
    for (const mode of ["timeout", "death"]) {
      for (const repo of [fixture.repo, fixture.impl]) {
        for (const { args, pattern } of calls) {
          const label = `${mode} of git ${args.join(" ")} in ${repo}`;
          const outcome = decide(fixture, fixture.repo, {
            fault: { mode, repo, args },
          });
          assert.equal(outcome.decision, undefined, `${label} must refuse`);
          assert.match(outcome.error, pattern, label);
          assert.ok(
            outcome.error.includes(repo),
            `${label} must name the repository`,
          );
          // The injected fault was really reached by the proof.
          assert.ok(f7Calls(outcome.calls, args, repo).length > 0, label);
        }
      }
    }
  });
  const normal = decide(fixture, fixture.repo);
  assert.equal(normal.decision.repo, fs.realpathSync.native(fixture.repo));
});

test("f7-6c (replaces PATH-shim f7-6c, g): Git's clear exit code 1 still counts as not containing, so the same repository is confirmed", async (t) => {
  const fixture = await f7Kickoff(t);
  // The accepted head the other candidate lacks: real Git says exit 1 for it.
  const lacking = git(fixture.repo, ["rev-parse", "HEAD"]);
  assert.equal(f7GitStatus(fixture.impl, f7Verify(lacking)), 1);
  const { decision } = await f7Decide(fixture, fixture.repo);
  assert.equal(decision.repo, fs.realpathSync.native(fixture.repo));
  assert.equal(decision.headAtDecision, lacking);
  assert.deepEqual(decision.proof.others, [
    { repo: fixture.impl, missing: [lacking] },
  ]);
});

// Decides in children with and without `env`, comparing what the proof
// reports. Refusals are compared message for message against a clean run; the
// confirmation is compared against what real Git says about the repositories.
function f7AssertPollutionHasNoEffect(t, fixture, env) {
  const decide = f7ChildDecider(t);
  const proofCalls = (calls) =>
    calls.filter(
      (call) =>
        f7Calls([call], ["merge-base", "--is-ancestor"]).length > 0 ||
        f7Calls([call], ["rev-parse", "--verify", "--quiet"]).length > 0,
    );
  for (const repo of [fixture.impl, path.join(fixture.dir, "not-recorded")]) {
    const clean = decide(fixture, repo);
    const polluted = decide(fixture, repo, { env });
    assert.equal(typeof clean.error, "string");
    assert.equal(polluted.error, clean.error);
  }
  assert.match(
    decide(fixture, fixture.impl, { env }).error,
    /does not contain accepted head/,
  );
  const lacking = git(fixture.repo, ["rev-parse", "HEAD"]);
  const confirmed = decide(fixture, fixture.repo, { env });
  assert.equal(confirmed.error, undefined);
  assert.equal(confirmed.decision.repo, fs.realpathSync.native(fixture.repo));
  assert.equal(confirmed.decision.headAtDecision, lacking);
  assert.deepEqual(confirmed.decision.proof.others, [
    { repo: fixture.impl, missing: [lacking] },
  ]);
  // Every Git call of the proof ran the same absolute executable and none ran
  // by the bare name `git`, which is what PATH and the environment steer.
  const calls = proofCalls(confirmed.calls);
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(path.isAbsolute(call.file), true, call.file);
  }
  assert.equal(new Set(calls.map((call) => call.file)).size, 1);
}

test("f7-6d (new, pollution): forged GIT_DIR, GIT_WORK_TREE and GIT_COMMON_DIR change neither the refusals nor the confirmation of the proof", async (t) => {
  const fixture = await f7Kickoff(t);
  const decoy = realTempDir(t, "omt-f7-decoy-");
  initRepo(decoy);
  f7Commit(decoy, "decoy only");
  f7AssertPollutionHasNoEffect(t, fixture, {
    GIT_DIR: path.join(decoy, ".git"),
    GIT_WORK_TREE: decoy,
    GIT_COMMON_DIR: path.join(decoy, ".git"),
  });
});

test("f7-6d (new, pollution): a fake git first on PATH is never run by the proof, whatever it answers", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fake git on PATH is a POSIX shell script");
    return;
  }
  const fixture = await f7Kickoff(t);
  const fakeDir = realTempDir(t, "omt-f7-fake-");
  const fakeLog = path.join(fakeDir, "calls.log");
  fs.writeFileSync(
    path.join(fakeDir, "git"),
    `#!/bin/sh\necho "$@" >> "${fakeLog}"\nexit 99\n`,
    { mode: 0o755 },
  );
  f7AssertPollutionHasNoEffect(t, fixture, {
    PATH: `${fakeDir}${path.delimiter}${process.env.PATH}`,
  });
  // No proof call reached it (other, unrelated Git users may have).
  const reached = fs.existsSync(fakeLog)
    ? fs.readFileSync(fakeLog, "utf8")
    : "";
  assert.doesNotMatch(reached, /merge-base|--verify/);
});

test("f7-7: after a decision every consumer binds to that one repository, at its HEAD only, and a different path is refused", async (t) => {
  const fixture = await f7Kickoff(t);
  await f7CompleteBriefSide(fixture);
  const stateBefore = f7Bytes(fixture);
  const { decision } = await f7Decide(fixture, fixture.repo);
  const real = fs.realpathSync.native(fixture.repo);
  assert.equal(decision.repo, real);
  assert.equal(f7Resolve(fixture), real);
  // Only the registry entry gained the record; workflow state is untouched.
  const stateDir = fixture.entry.pm.stateDir;
  for (const [file, content] of stateBefore) {
    if (file.startsWith(stateDir))
      assert.equal(f7Bytes(fixture).get(file), content);
  }
  // The caller's value is only compared, never a source.
  const stranger = realTempDir(t, "omt-f7-stranger-");
  git(stranger, ["clone", "-q", fixture.dir, "."]);
  await assertUnchanged(fixture, async () => {
    await assert.rejects(
      () => f7Objection(fixture, stranger),
      /not the result repository/,
    );
    await assert.rejects(
      () => f7AuditAccept(fixture, stranger, fixture.head),
      /not the result repository/,
    );
    await assert.rejects(
      () => f7CloseReady(fixture, fixture.impl),
      /not the result repository/,
    );
    await assert.rejects(
      () => f7Deliver(fixture, fixture.impl),
      /not the result repository/,
    );
  });
  await auditorAcceptsOutcome(fixture, fixture.repo, fixture.head);
  await assert.doesNotReject(() => f7CloseReady(fixture));
  await assert.doesNotReject(() => signalCloseReady(fixture));
  // The acceptance is bound to the HEAD it was made at.
  await assert.rejects(
    () => auditorAcceptsOutcome(fixture, fixture.repo, FORGED_HEAD),
    Error,
  );
  const delivered = await f7Deliver(fixture);
  assert.equal(delivered.delivered, true);
  assert.equal(delivered.head, fixture.head);
  // Completed release now clears the result repository and close-ready gates
  // and stops only at the delivery document this fixture never writes.
  await assert.rejects(
    () => f7Release(fixture),
    /delivery-ref document is not committed yet/,
  );
});

test("f7-7: the same binding holds when one accepted workflow required integration", async (t) => {
  const fixture = await f7Kickoff(t, { integration: true });
  const { decision } = await f7Decide(fixture, fixture.repo);
  const integrationHead = decision.workflowSet.find(
    (item) => item.id === "wf-integration",
  ).integration.head;
  assert.ok(decision.proof.acceptedHeads.includes(integrationHead));
  assert.equal(f7Resolve(fixture), fs.realpathSync.native(fixture.repo));
  await assert.rejects(
    () => f7Objection(fixture, fixture.impl),
    /not the result repository/,
  );
  await assert.doesNotReject(() =>
    auditorAcceptsOutcome(fixture, fixture.repo, fixture.head),
  );
});

test("f7-8: a decision is append-only, cannot be repeated for the same accepted results, and stops binding when those results change", async (t) => {
  const fixture = await f7Kickoff(t);
  const stateDir = fixture.entry.pm.stateDir;
  const stateBefore = f7Bytes(fixture);
  const first = (await f7Decide(fixture, fixture.repo)).decision;
  for (const [file, content] of stateBefore) {
    if (file.startsWith(stateDir))
      assert.equal(f7Bytes(fixture).get(file), content, file);
  }
  await assertUnchanged(fixture, () =>
    assert.rejects(
      () => f7Decide(fixture, fixture.repo),
      /already decided for these accepted results/,
    ),
  );
  // A decision file edited after the record: the fingerprint no longer matches.
  const decisionFile = path.join(
    stateDir,
    "decisions",
    "accept-wf-main-main-task.json",
  );
  const original = fs.readFileSync(decisionFile);
  writeJSON(decisionFile, { ...readJSON(decisionFile), note: "edited" });
  await assertUnchanged(fixture, () =>
    assert.throws(
      () => f7Resolve(fixture),
      (error) => {
        assert.equal(error.code, "result-repo-ambiguous");
        assert.match(error.message, /wf-main: tasks\.0\.decisionSha256/);
        return true;
      },
    ),
  );
  fs.writeFileSync(decisionFile, original);
  // A duplicated matching report and a changed gate evidence key.
  const reportFile = path.join(stateDir, "reports", "wf-main-main-task.json");
  fs.copyFileSync(reportFile, path.join(stateDir, "reports", "dup.json"));
  await assert.throws(() => f7Resolve(fixture), f7Ambiguous);
  fs.rmSync(path.join(stateDir, "reports", "dup.json"));
  const gateFile = path.join(stateDir, "gates", "main-task.json");
  const gateOriginal = fs.readFileSync(gateFile);
  writeJSON(gateFile, { ...readJSON(gateFile), evidenceKey: "x" });
  await assert.throws(() => f7Resolve(fixture), f7Ambiguous);
  fs.writeFileSync(gateFile, gateOriginal);
  assert.equal(f7Resolve(fixture), fs.realpathSync.native(fixture.repo));
  // A newly accepted workflow changes the set: the old record stops binding,
  // naming the workflow, until a new record is appended next to it.
  await acceptStaged(
    await stageAcceptedTask(fixture, "wf-third", {
      worktreePath: fixture.repo,
      taskId: "third-task",
    }),
  );
  await assert.throws(
    () => f7Resolve(fixture),
    (error) => {
      assert.equal(error.code, "result-repo-ambiguous");
      assert.match(error.message, /workflows accepted since: wf-third/);
      return true;
    },
  );
  const second = (await f7Decide(fixture, fixture.repo)).decision;
  const records = listKickoffs(fixture.org, fixture.worktreeId).kickoffs[0]
    .resultRepoDecisions;
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], first);
  assert.deepEqual(records[1], second);
  assert.notEqual(first.id, second.id);
  assert.equal(f7Resolve(fixture), fs.realpathSync.native(fixture.repo));
});

test("f7-9: a repository whose HEAD moved off the accepted heads, or a hand-edited registry record, stops binding", async (t) => {
  const fixture = await f7Kickoff(t);
  await f7Decide(fixture, fixture.repo);
  const entryFile = path.join(
    registryDirectory(fixture.org),
    `${kickoffEntryName(fixture.worktreeId)}.json`,
  );
  const original = fs.readFileSync(entryFile);
  const base = git(fixture.dir, ["rev-parse", "main"]);
  const tip = git(fixture.repo, ["rev-parse", "HEAD"]);
  git(fixture.repo, ["reset", "-q", "--hard", base]);
  await assert.throws(
    () => f7Resolve(fixture),
    (error) => {
      assert.equal(error.code, "result-repo-ambiguous");
      assert.match(error.message, /no longer holds/);
      return true;
    },
  );
  git(fixture.repo, ["reset", "-q", "--hard", tip]);
  assert.equal(f7Resolve(fixture), fs.realpathSync.native(fixture.repo));
  // The record's repo changed by hand to the other candidate.
  const entry = readJSON(entryFile);
  entry.resultRepoDecisions[0].repo = fs.realpathSync.native(fixture.impl);
  writeJSON(entryFile, entry);
  await assert.throws(() => f7Resolve(fixture), f7Ambiguous);
  // The record's fingerprint edited by hand.
  const edited = readJSON(entryFile);
  edited.resultRepoDecisions[0].repo = fs.realpathSync.native(fixture.repo);
  edited.resultRepoDecisions[0].workflowSet[0].tasks[0].head = "2".repeat(40);
  writeJSON(entryFile, edited);
  await assert.throws(() => f7Resolve(fixture), f7Ambiguous);
  fs.writeFileSync(entryFile, original);
  assert.equal(f7Resolve(fixture), fs.realpathSync.native(fixture.repo));
});

test("f7-10: a single recorded result repository behaves as before and needs neither reports nor a decision", async (t) => {
  const fixture = kickoff(t, "wt-1", {
    auditor: { profile: "claude-current" },
  });
  await acceptStaged(await stageAcceptedTask(fixture, "wf-only"));
  fs.rmSync(path.join(fixture.entry.pm.stateDir, "reports"), {
    recursive: true,
    force: true,
  });
  assert.equal(f7Resolve(fixture), fs.realpathSync.native(fixture.repo));
  await assertUnchanged(fixture, () =>
    assert.rejects(() => f7Decide(fixture, fixture.repo), /nothing to decide/),
  );
});
