/** Requirements ledger: statements, criteria, confirmations, presentations, fidelity, exceptions. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertLedgerCloseReady,
  assertLedgerExists,
  confirmationTextHash,
  confirmedLedgerFromClaim,
  ledgerHash,
  readDraft,
  readLedger,
  requirementsAmend,
  requirementsConfirm,
  requirementsConfirmDraft,
  requirementsDraft,
  requirementsException,
  requirementsFidelity,
  requirementsFidelityConfirm,
  requirementsPresent,
  requirementsRetrofit,
  validateLedgerForClaim,
  writeConfirmedLedger,
} from "../plugins/oh-my-teams/scripts/requirements.mjs";

// A plausible-looking commit id that is guaranteed not to be any fixture's
// actual HEAD, for the forged/stale-head counterexamples below.
const FORGED_HEAD = "0".repeat(40);

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir }).toString().trim();
}

// A real Git repository with one commit, so head/repo assertions are checked
// against an actual `git rev-parse HEAD`, never a string a test made up.
function initRepo(dir) {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "ledger-test@example.com"]);
  git(dir, ["config", "user.name", "Ledger Test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "fixture repo\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function commitMore(dir) {
  fs.writeFileSync(path.join(dir, "later.txt"), "later\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "later"]);
  return git(dir, ["rev-parse", "HEAD"]);
}

// One statement, one narrower criterion and one user-visible criterion — the
// smallest ledger shape that exercises confirmation, presentation and
// fidelity all at once.
function baseStatementsAndCriteria() {
  return {
    statements: [
      { id: "s1", text: "the tool must warn before deleting", source: "brief" },
    ],
    criteria: [
      {
        id: "narrow-1",
        text: "warn only for destructive commands",
        scope: "narrower",
        userVisible: false,
        derivedFrom: ["s1"],
      },
      {
        id: "visible-1",
        text: "the tool warns before deleting",
        scope: "equal",
        userVisible: true,
        derivedFrom: ["s1"],
      },
    ],
  };
}

// Builds a temp project root (with a real Git workspace at its root) and a
// director checkout equal to it, then drafts and confirms `narrow-1` from
// that checkout — the shared starting point for every test below.
function fixture(t, worktreeId = "wt-1") {
  // realpath'd: on macOS os.tmpdir() sits under a /var -> /private/var
  // symlink, and process.chdir() reports the resolved path, so an
  // un-resolved dir would never equal process.cwd() below.
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "omt-reqledger-")),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const head = initRepo(dir);
  const orgFile = path.join(dir, ".omt", "organization.json");
  const { statements, criteria } = baseStatementsAndCriteria();
  requirementsDraft(orgFile, { worktreeId, statements, criteria });
  // requirementsConfirmDraft proves the caller ran from `checkout`, so the
  // fixture really has to run from the director's checkout, not just claim to.
  const originalCwd = process.cwd();
  t.after(() => process.chdir(originalCwd));
  process.chdir(dir);
  requirementsConfirmDraft(orgFile, {
    worktreeId,
    criterionId: "narrow-1",
    userQuote: "yes, only warn on destructive commands",
    checkout: dir,
  });
  process.chdir(originalCwd);
  const director = { checkoutPath: dir };
  // requirementsPresent copies evidence under projectRoot(orgFile) — the
  // orgFile's own parent directory (dir/.omt), not the checkout root itself.
  const projectRoot = path.dirname(orgFile);
  return {
    dir,
    orgFile,
    projectRoot,
    worktreeId,
    head,
    statements,
    criteria,
    director,
  };
}

function claimFrom(fx) {
  const draft = readDraft(fx.orgFile, fx.worktreeId);
  return {
    statements: draft.statements,
    criteria: draft.criteria,
    confirmations: draft.confirmations,
  };
}

function confirmClaim(fx) {
  const requirements = validateLedgerForClaim(
    { ...claimFrom(fx), worktreeId: fx.worktreeId },
    fx.director,
  );
  const ledger = confirmedLedgerFromClaim(requirements, fx.director);
  writeConfirmedLedger(fx.orgFile, fx.worktreeId, ledger);
  return readLedger(fx.orgFile, fx.worktreeId);
}

function evidenceFile(dir, text = "screenshot bytes") {
  const file = path.join(dir, "evidence-source.txt");
  fs.writeFileSync(file, text);
  return file;
}

test("validateLedgerForClaim accepts a narrower criterion with a matching hash-bound confirmation", () => {
  const fx = fixture({ after() {} });
  const requirements = validateLedgerForClaim(
    { ...claimFrom(fx), worktreeId: fx.worktreeId },
    fx.director,
  );
  assert.equal(requirements.criteria.length, 2);
});

test("validateLedgerForClaim refuses a narrower criterion with no recorded confirmation", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-reqledger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const orgFile = path.join(dir, ".omt", "organization.json");
  const { statements, criteria } = baseStatementsAndCriteria();
  requirementsDraft(orgFile, { worktreeId: "wt-2", statements, criteria });
  const draft = readDraft(orgFile, "wt-2");
  assert.throws(
    () =>
      validateLedgerForClaim(
        {
          statements: draft.statements,
          criteria: draft.criteria,
          confirmations: [],
          worktreeId: "wt-2",
        },
        { checkoutPath: dir },
      ),
    /requires a recorded user confirmation/,
  );
});

test("validateLedgerForClaim refuses a confirmation recorded from a checkout other than the claim's declared director", (t) => {
  const fx = fixture(t);
  const otherDirector = {
    checkoutPath: fs.mkdtempSync(
      path.join(os.tmpdir(), "omt-reqledger-other-"),
    ),
  };
  t.after(() =>
    fs.rmSync(otherDirector.checkoutPath, { recursive: true, force: true }),
  );
  assert.throws(
    () =>
      validateLedgerForClaim(
        { ...claimFrom(fx), worktreeId: fx.worktreeId },
        otherDirector,
      ),
    /checkout other than the claim's declared director/,
  );
});

test("validateLedgerForClaim refuses a confirmation with a blank userQuote, even when its hash and checkout match", (t) => {
  const fx = fixture(t);
  const claim = claimFrom(fx);
  claim.confirmations = claim.confirmations.map((item) => ({
    ...item,
    userQuote: "   ",
  }));
  assert.throws(
    () =>
      validateLedgerForClaim(
        { ...claim, worktreeId: fx.worktreeId },
        fx.director,
      ),
    /missing the user's own quote/,
  );
});

test("validateLedgerForClaim refuses a confirmation with no valid confirmedAt timestamp", (t) => {
  const fx = fixture(t);
  const claim = claimFrom(fx);
  claim.confirmations = claim.confirmations.map((item) => ({
    ...item,
    confirmedAt: "not-a-date",
  }));
  assert.throws(
    () =>
      validateLedgerForClaim(
        { ...claim, worktreeId: fx.worktreeId },
        fx.director,
      ),
    /valid recorded timestamp/,
  );
});

test("validateLedgerForClaim does not require confirmation for equal-scope criteria, but still keeps them for fidelity", (t) => {
  const fx = fixture(t);
  const requirements = validateLedgerForClaim(
    { ...claimFrom(fx), worktreeId: fx.worktreeId },
    fx.director,
  );
  const equalCriterion = requirements.criteria.find(
    (item) => item.id === "visible-1",
  );
  assert.equal(equalCriterion.scope, "equal");
});

test("confirmationTextHash changes when a narrower criterion's scope flips away from narrower", () => {
  const statements = [{ id: "s1", text: "x", source: "brief" }];
  const narrower = {
    id: "c1",
    text: "t",
    scope: "narrower",
    userVisible: false,
    derivedFrom: ["s1"],
  };
  const equal = { ...narrower, scope: "equal" };
  assert.notEqual(
    confirmationTextHash(narrower, statements),
    confirmationTextHash(equal, statements),
  );
});

test("confirmationTextHash changes when a criterion's userVisible flips on", () => {
  const statements = [{ id: "s1", text: "x", source: "brief" }];
  const hidden = {
    id: "c1",
    text: "t",
    scope: "narrower",
    userVisible: false,
    derivedFrom: ["s1"],
  };
  const visible = { ...hidden, userVisible: true };
  assert.notEqual(
    confirmationTextHash(hidden, statements),
    confirmationTextHash(visible, statements),
  );
});

test("confirmationTextHash changes when derivedFrom points at a different statement, even with identical statement text", () => {
  const statements = [
    { id: "s1", text: "same text", source: "brief" },
    { id: "s2", text: "same text", source: "brief" },
  ];
  const fromS1 = {
    id: "c1",
    text: "t",
    scope: "narrower",
    userVisible: false,
    derivedFrom: ["s1"],
  };
  const fromS2 = { ...fromS1, derivedFrom: ["s2"] };
  assert.notEqual(
    confirmationTextHash(fromS1, statements),
    confirmationTextHash(fromS2, statements),
  );
});

test("confirmationTextHash changes when the derived statement's own text is edited, even though criterion.text is untouched", () => {
  const criterion = {
    id: "c1",
    text: "t",
    scope: "narrower",
    userVisible: false,
    derivedFrom: ["s1"],
  };
  const before = [{ id: "s1", text: "original wording", source: "brief" }];
  const after = [{ id: "s1", text: "edited wording", source: "brief" }];
  assert.notEqual(
    confirmationTextHash(criterion, before),
    confirmationTextHash(criterion, after),
  );
});

test("requirementsAmend invalidates a narrower confirmation once its criterion text changes, blocking close until re-confirmed", async (t) => {
  const fx = fixture(t);
  const ledger = confirmClaim(fx);
  const amendedCriteria = ledger.criteria.map((item) =>
    item.id === "narrow-1"
      ? { ...item, text: "warn only for destructive, irreversible commands" }
      : item,
  );
  await requirementsAmend(fx.orgFile, fx.worktreeId, {
    statements: ledger.statements,
    criteria: amendedCriteria,
    callerCwd: fx.dir,
  });
  const amended = readLedger(fx.orgFile, fx.worktreeId);
  assert.throws(
    () =>
      assertLedgerCloseReady({
        ledger: amended,
        head: fx.head,
        ownerRoot: fx.projectRoot,
      }),
    /no valid user confirmation/,
  );
  await requirementsConfirm(fx.orgFile, fx.worktreeId, {
    criterionId: "narrow-1",
    userQuote:
      "yes, still just destructive commands, and irreversible ones too",
    callerCwd: fx.dir,
  });
  // Re-confirmed; the remaining close-ready requirements (presentation,
  // fidelity) are exercised by the presented-evidence-gate tests below.
  const reconfirmed = readLedger(fx.orgFile, fx.worktreeId);
  const stillFails = () =>
    assertLedgerCloseReady({
      ledger: reconfirmed,
      head: fx.head,
      ownerRoot: fx.projectRoot,
    });
  assert.throws(stillFails, /no confirmed presentation/);
});

// Drives a fixture all the way to a passing assertLedgerCloseReady, so each
// presented-evidence-gate test below can break exactly one thing.
async function readyLedger(fx) {
  confirmClaim(fx);
  const source = evidenceFile(fx.dir);
  await requirementsPresent(fx.orgFile, fx.worktreeId, {
    criterionId: "visible-1",
    head: fx.head,
    repo: fx.dir,
    source,
    channel: "PR",
    location: "https://example.invalid/pr/1",
    userQuote: "looks right, thanks",
    outcome: "confirmed",
  });
  await requirementsFidelity(fx.orgFile, fx.worktreeId, {
    head: fx.head,
    repo: fx.dir,
    recordedBy: "director-1",
    items: [
      {
        type: "statement",
        id: "s1",
        status: "met",
        evidence: "matches brief section 2",
      },
      {
        type: "criterion",
        id: "narrow-1",
        status: "met",
        evidence: "warns only on rm/reset",
      },
      {
        type: "criterion",
        id: "visible-1",
        status: "met",
        evidence: "screenshot attached",
      },
    ],
  });
  await requirementsFidelityConfirm(fx.orgFile, fx.worktreeId, fx.dir);
  return readLedger(fx.orgFile, fx.worktreeId);
}

test("presented-evidence-gate: a fully presented, confirmed and fidelity-checked ledger is close-ready", async (t) => {
  const fx = fixture(t);
  const ledger = await readyLedger(fx);
  const result = assertLedgerCloseReady({
    ledger,
    head: fx.head,
    ownerRoot: fx.projectRoot,
  });
  assert.deepEqual(result, { ready: true });
});

test("presented-evidence-gate: a user-visible criterion with no presentation at all is refused", async (t) => {
  const fx = fixture(t);
  confirmClaim(fx);
  await requirementsFidelity(fx.orgFile, fx.worktreeId, {
    head: fx.head,
    repo: fx.dir,
    recordedBy: "director-1",
    items: [
      {
        type: "statement",
        id: "s1",
        status: "met",
        evidence: "matches brief section 2",
      },
      {
        type: "criterion",
        id: "narrow-1",
        status: "met",
        evidence: "warns only on rm/reset",
      },
      {
        type: "criterion",
        id: "visible-1",
        status: "met",
        evidence: "screenshot attached",
      },
    ],
  });
  await requirementsFidelityConfirm(fx.orgFile, fx.worktreeId, fx.dir);
  const ledger = readLedger(fx.orgFile, fx.worktreeId);
  assert.throws(
    () =>
      assertLedgerCloseReady({
        ledger,
        head: fx.head,
        ownerRoot: fx.projectRoot,
      }),
    /no confirmed presentation/,
  );
});

test("presented-evidence-gate: a rejected presentation is refused unless a matching exception is recorded, and --force cannot substitute", async (t) => {
  const fx = fixture(t);
  confirmClaim(fx);
  const source = evidenceFile(fx.dir);
  await requirementsPresent(fx.orgFile, fx.worktreeId, {
    criterionId: "visible-1",
    head: fx.head,
    repo: fx.dir,
    source,
    channel: "PR",
    location: "https://example.invalid/pr/2",
    userQuote: "this is not what I asked for",
    outcome: "rejected",
  });
  await requirementsFidelity(fx.orgFile, fx.worktreeId, {
    head: fx.head,
    repo: fx.dir,
    recordedBy: "director-1",
    items: [
      {
        type: "statement",
        id: "s1",
        status: "met",
        evidence: "matches brief section 2",
      },
      {
        type: "criterion",
        id: "narrow-1",
        status: "met",
        evidence: "warns only on rm/reset",
      },
      {
        type: "criterion",
        id: "visible-1",
        status: "met",
        evidence: "screenshot attached",
      },
    ],
  });
  await requirementsFidelityConfirm(fx.orgFile, fx.worktreeId, fx.dir);
  const ledger = readLedger(fx.orgFile, fx.worktreeId);
  // assertLedgerCloseReady takes no force-style escape hatch: passing an
  // arbitrary extra flag changes nothing about the outcome.
  const attempt = () =>
    assertLedgerCloseReady({
      ledger,
      head: fx.head,
      ownerRoot: fx.projectRoot,
      force: true,
    });
  assert.throws(attempt, /no confirmed presentation/);
  await requirementsException(fx.orgFile, fx.worktreeId, {
    scope: [{ type: "criterion", id: "visible-1" }],
    head: fx.head,
    repo: fx.dir,
    reason: "user accepted the current behavior for this release",
    userQuote: "fine, ship it as-is for now",
    unmetFacts: "the warning still fires on non-destructive commands too",
    callerCwd: fx.dir,
  });
  const excepted = readLedger(fx.orgFile, fx.worktreeId);
  const result = assertLedgerCloseReady({
    ledger: excepted,
    head: fx.head,
    ownerRoot: fx.projectRoot,
  });
  assert.deepEqual(result, { ready: true });
});

test("presented-evidence-gate: an exception scoped to a different criterion does not cover the rejected one", async (t) => {
  const fx = fixture(t);
  confirmClaim(fx);
  const source = evidenceFile(fx.dir);
  await requirementsPresent(fx.orgFile, fx.worktreeId, {
    criterionId: "visible-1",
    head: fx.head,
    repo: fx.dir,
    source,
    channel: "PR",
    location: "https://example.invalid/pr/3",
    userQuote: "not what I wanted",
    outcome: "rejected",
  });
  await requirementsFidelity(fx.orgFile, fx.worktreeId, {
    head: fx.head,
    repo: fx.dir,
    recordedBy: "director-1",
    items: [
      {
        type: "statement",
        id: "s1",
        status: "met",
        evidence: "matches brief section 2",
      },
      {
        type: "criterion",
        id: "narrow-1",
        status: "met",
        evidence: "warns only on rm/reset",
      },
      {
        type: "criterion",
        id: "visible-1",
        status: "met",
        evidence: "screenshot attached",
      },
    ],
  });
  await requirementsFidelityConfirm(fx.orgFile, fx.worktreeId, fx.dir);
  await requirementsException(fx.orgFile, fx.worktreeId, {
    scope: [{ type: "statement", id: "s1" }],
    head: fx.head,
    repo: fx.dir,
    reason: "unrelated exception",
    userQuote: "fine about the other thing",
    unmetFacts: "unrelated gap",
    callerCwd: fx.dir,
  });
  const ledger = readLedger(fx.orgFile, fx.worktreeId);
  assert.throws(
    () =>
      assertLedgerCloseReady({
        ledger,
        head: fx.head,
        ownerRoot: fx.projectRoot,
      }),
    /no confirmed presentation/,
  );
});

test("presented-evidence-gate: presentation evidence copied into a registered kickoff worktree is refused", async (t) => {
  const fx = fixture(t);
  const ledger = await readyLedger(fx);
  const presentation = ledger.presentations.find(
    (item) => item.criterionId === "visible-1",
  );
  const evidenceDir = path.dirname(
    path.join(fx.projectRoot, presentation.evidence.ownerPath),
  );
  assert.throws(
    () =>
      assertLedgerCloseReady({
        ledger,
        head: fx.head,
        ownerRoot: fx.projectRoot,
        registeredWorktreePaths: [evidenceDir],
      }),
    /points into a kickoff worktree/,
  );
});

test("presented-evidence-gate: tampering with presented evidence after the fact is refused", async (t) => {
  const fx = fixture(t);
  const ledger = await readyLedger(fx);
  const presentation = ledger.presentations.find(
    (item) => item.criterionId === "visible-1",
  );
  const destination = path.join(
    fx.projectRoot,
    presentation.evidence.ownerPath,
  );
  fs.writeFileSync(destination, "tampered bytes");
  assert.throws(
    () =>
      assertLedgerCloseReady({
        ledger,
        head: fx.head,
        ownerRoot: fx.projectRoot,
      }),
    /has changed since it was recorded/,
  );
});

test("presented-evidence-gate: a presentation bound to a HEAD the workspace has since moved past is refused", async (t) => {
  const fx = fixture(t);
  const ledger = await readyLedger(fx);
  const movedHead = commitMore(fx.dir);
  assert.throws(
    () =>
      assertLedgerCloseReady({
        ledger,
        head: movedHead,
        ownerRoot: fx.projectRoot,
      }),
    /no confirmed presentation/,
  );
});

test("presented-evidence-gate: a hand-assembled presentation with a blank userQuote is refused even though its hash, HEAD and evidence all check out", async (t) => {
  const fx = fixture(t);
  const ledger = await readyLedger(fx);
  const tampered = {
    ...ledger,
    presentations: ledger.presentations.map((item) =>
      item.criterionId === "visible-1" ? { ...item, userQuote: "" } : item,
    ),
  };
  assert.throws(
    () =>
      assertLedgerCloseReady({
        ledger: tampered,
        head: fx.head,
        ownerRoot: fx.projectRoot,
      }),
    /missing the user's own quote/,
  );
});

test("requirementsPresent refuses a presentation with no channel", async (t) => {
  const fx = fixture(t);
  confirmClaim(fx);
  const source = evidenceFile(fx.dir);
  await assert.rejects(
    requirementsPresent(fx.orgFile, fx.worktreeId, {
      criterionId: "visible-1",
      head: fx.head,
      repo: fx.dir,
      source,
      channel: "   ",
      location: "https://example.invalid/pr/6",
      userQuote: "looks right",
      outcome: "confirmed",
    }),
    /channel is required/,
  );
});

test("requirementsPresent refuses a presentation with no location", async (t) => {
  const fx = fixture(t);
  confirmClaim(fx);
  const source = evidenceFile(fx.dir);
  await assert.rejects(
    requirementsPresent(fx.orgFile, fx.worktreeId, {
      criterionId: "visible-1",
      head: fx.head,
      repo: fx.dir,
      source,
      channel: "PR",
      location: "",
      userQuote: "looks right",
      outcome: "confirmed",
    }),
    /location is required/,
  );
});

test("presented-evidence-gate: a hand-assembled presentation with no channel/location is refused even though its hash, HEAD and evidence all check out", async (t) => {
  const fx = fixture(t);
  const ledger = await readyLedger(fx);
  const tampered = {
    ...ledger,
    presentations: ledger.presentations.map((item) =>
      item.criterionId === "visible-1"
        ? { ...item, channel: "", location: "" }
        : item,
    ),
  };
  assert.throws(
    () =>
      assertLedgerCloseReady({
        ledger: tampered,
        head: fx.head,
        ownerRoot: fx.projectRoot,
      }),
    /missing the channel\/location it was shown through/,
  );
});

test("requirementsPresent refuses a declared head that does not match the workspace's actual Git HEAD", async (t) => {
  const fx = fixture(t);
  confirmClaim(fx);
  const source = evidenceFile(fx.dir);
  await assert.rejects(
    requirementsPresent(fx.orgFile, fx.worktreeId, {
      criterionId: "visible-1",
      head: FORGED_HEAD,
      repo: fx.dir,
      source,
      channel: "PR",
      location: "https://example.invalid/pr/4",
      userQuote: "looks right",
      outcome: "confirmed",
    }),
    /does not match the actual Git HEAD/,
  );
});

test("requirementsFidelity refuses a declared head that does not match the workspace's actual Git HEAD", async (t) => {
  const fx = fixture(t);
  confirmClaim(fx);
  await assert.rejects(
    requirementsFidelity(fx.orgFile, fx.worktreeId, {
      head: FORGED_HEAD,
      repo: fx.dir,
      recordedBy: "director-1",
      items: [
        { type: "statement", id: "s1", status: "met", evidence: "x" },
        { type: "criterion", id: "narrow-1", status: "met", evidence: "x" },
        { type: "criterion", id: "visible-1", status: "met", evidence: "x" },
      ],
    }),
    /does not match the actual Git HEAD/,
  );
});

test("assertLedgerCloseReady refuses an unmet item with no matching item-scoped exception", async (t) => {
  const fx = fixture(t);
  confirmClaim(fx);
  const source = evidenceFile(fx.dir);
  await requirementsPresent(fx.orgFile, fx.worktreeId, {
    criterionId: "visible-1",
    head: fx.head,
    repo: fx.dir,
    source,
    channel: "PR",
    location: "https://example.invalid/pr/5",
    userQuote: "looks right",
    outcome: "confirmed",
  });
  await requirementsFidelity(fx.orgFile, fx.worktreeId, {
    head: fx.head,
    repo: fx.dir,
    recordedBy: "director-1",
    items: [
      {
        type: "statement",
        id: "s1",
        status: "unmet",
        evidence: "still missing the warning copy",
      },
      {
        type: "criterion",
        id: "narrow-1",
        status: "met",
        evidence: "warns only on rm/reset",
      },
      {
        type: "criterion",
        id: "visible-1",
        status: "met",
        evidence: "screenshot attached",
      },
    ],
  });
  await requirementsFidelityConfirm(fx.orgFile, fx.worktreeId, fx.dir);
  const ledger = readLedger(fx.orgFile, fx.worktreeId);
  assert.throws(
    () =>
      assertLedgerCloseReady({
        ledger,
        head: fx.head,
        ownerRoot: fx.projectRoot,
      }),
    /has no matching item-scoped exception/,
  );
});

test("compat-not-bypass: a worktree with no confirmed ledger fails assertLedgerExists", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-reqledger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const orgFile = path.join(dir, ".omt", "organization.json");
  assert.throws(
    () => assertLedgerExists(orgFile, "wt-legacy"),
    /has no requirements ledger/,
  );
});

test("compat-not-bypass: requirementsRetrofit lets the director backfill a pre-existing kickoff's ledger, and refuses to run twice", async (t) => {
  const fx = fixture(t, "wt-legacy");
  const claim = claimFrom(fx);
  const { retrofitted, ledger } = await requirementsRetrofit(
    fx.orgFile,
    fx.worktreeId,
    claim,
    fx.director,
  );
  assert.equal(retrofitted, true);
  assert.equal(
    ledgerHash(ledger),
    ledgerHash(readLedger(fx.orgFile, fx.worktreeId)),
  );
  await assert.rejects(
    requirementsRetrofit(fx.orgFile, fx.worktreeId, claim, fx.director),
    /already has a confirmed ledger/,
  );
});

// requirements.mjs never takes an auditor/organization argument anywhere in
// this file: the A-subsystem's confirmation, presentation, fidelity and
// close-ready gates are exercised end to end above without one, so they hold
// for an organization that never declares an auditor at all.
test("compat-not-bypass: the full confirm/present/fidelity/close-ready path needs no auditor role at any step", async (t) => {
  const fx = fixture(t);
  const ledger = await readyLedger(fx);
  const result = assertLedgerCloseReady({
    ledger,
    head: fx.head,
    ownerRoot: fx.projectRoot,
  });
  assert.deepEqual(result, { ready: true });
});

// director-authority-gap: requirementsAmend/Confirm/FidelityConfirm/Exception
// must refuse a caller that is not the ledger's recorded director, and
// requirementsException must refuse a head that does not match the
// workspace's actual Git HEAD, so none of these can be self-approved by
// whichever session happens to hold the write lock first.
function otherCheckout(t) {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "omt-reqledger-other-"));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  return other;
}

test("director-authority-gap: requirementsAmend refuses a caller outside the ledger's director checkout", async (t) => {
  const fx = fixture(t);
  const ledger = confirmClaim(fx);
  await assert.rejects(
    requirementsAmend(fx.orgFile, fx.worktreeId, {
      statements: ledger.statements,
      criteria: ledger.criteria,
      callerCwd: otherCheckout(t),
    }),
    /must be run from the director's checkout/,
  );
});

test("director-authority-gap: requirementsConfirm refuses a caller outside the ledger's director checkout", async (t) => {
  const fx = fixture(t);
  confirmClaim(fx);
  await assert.rejects(
    requirementsConfirm(fx.orgFile, fx.worktreeId, {
      criterionId: "narrow-1",
      userQuote: "yes, that is right",
      callerCwd: otherCheckout(t),
    }),
    /must be run from the director's checkout/,
  );
});

test("director-authority-gap: requirementsFidelityConfirm refuses a caller outside the ledger's director checkout", async (t) => {
  const fx = fixture(t);
  confirmClaim(fx);
  await requirementsFidelity(fx.orgFile, fx.worktreeId, {
    head: fx.head,
    repo: fx.dir,
    recordedBy: "director-1",
    items: [
      { type: "statement", id: "s1", status: "met", evidence: "x" },
      { type: "criterion", id: "narrow-1", status: "met", evidence: "x" },
      { type: "criterion", id: "visible-1", status: "met", evidence: "x" },
    ],
  });
  await assert.rejects(
    requirementsFidelityConfirm(fx.orgFile, fx.worktreeId, otherCheckout(t)),
    /must be run from the director's checkout/,
  );
});

test("director-authority-gap: requirementsException refuses a caller outside the ledger's director checkout", async (t) => {
  const fx = fixture(t);
  confirmClaim(fx);
  await assert.rejects(
    requirementsException(fx.orgFile, fx.worktreeId, {
      scope: [{ type: "criterion", id: "visible-1" }],
      head: fx.head,
      repo: fx.dir,
      reason: "user accepted the current behavior for this release",
      userQuote: "fine, ship it as-is for now",
      unmetFacts: "the warning still fires on non-destructive commands too",
      callerCwd: otherCheckout(t),
    }),
    /must be run from the director's checkout/,
  );
});

test("director-authority-gap: requirementsException refuses a declared head that does not match the workspace's actual Git HEAD", async (t) => {
  const fx = fixture(t);
  confirmClaim(fx);
  await assert.rejects(
    requirementsException(fx.orgFile, fx.worktreeId, {
      scope: [{ type: "criterion", id: "visible-1" }],
      head: FORGED_HEAD,
      repo: fx.dir,
      reason: "user accepted the current behavior for this release",
      userQuote: "fine, ship it as-is for now",
      unmetFacts: "the warning still fires on non-destructive commands too",
      callerCwd: fx.dir,
    }),
    /does not match the actual Git HEAD/,
  );
});
