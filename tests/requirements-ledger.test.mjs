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
import { writeJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  kickoffEntryName,
  registryDirectory,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";

// A plausible-looking commit id that is guaranteed not to be any fixture's
// actual HEAD, for the forged/stale-head counterexamples below.
const FORGED_HEAD = "0".repeat(40);

const cli = path.resolve("plugins/oh-my-teams/scripts/teams-org.mjs");

// Runs the teams-org CLI as a real child process (never `run-use`), returning
// its exit code and streams instead of throwing, so a rejection test can
// assert on the exact message the CLI printed to stderr.
function runCli(args, options = {}) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      stdio: "pipe",
      encoding: "utf-8",
      ...options,
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

// A registry entry with no `director` and no `requirements`, written directly
// to the registry file the way a pre-ledger release would have (registerKickoff
// itself now refuses to produce a director-less, requirements-less entry) —
// the shape `requirements-retrofit`'s legacy branch exists to reach.
function writeLegacyKickoffEntry(fx) {
  const entryPath = path.join(
    registryDirectory(fx.orgFile),
    `${kickoffEntryName(fx.worktreeId)}.json`,
  );
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  writeJSON(entryPath, {
    schemaVersion: 1,
    goal: `deliver ${fx.worktreeId}`,
    pm: {
      worktreeId: fx.worktreeId,
      path: fx.dir,
      stateDir: path.join(fx.dir, ".omt"),
    },
    organizationRevision: 1,
    brief: path.join(fx.dir, "brief.md"),
    delivery: { mode: "none" },
    runId: null,
    createdAt: "2026-09-16T00:00:00.000Z",
  });
}

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

// A director-less legacy kickoff's starting point: a real Git workspace and
// an orgFile path, but no draft and no confirmed ledger yet — the state a
// pre-ledger release's worktree is actually in before requirements-draft ever
// runs, unlike fixture() above which already drafts and confirms.
function legacyFixture(t, worktreeId = "wt-legacy-cli") {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "omt-reqledger-legacy-")),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const head = initRepo(dir);
  const orgFile = path.join(dir, ".omt", "organization.json");
  return { dir, orgFile, worktreeId, head };
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
    fx.orgFile,
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

// Reads the draft ledger's own file directly (there is exactly one file per
// worktree under requirements-drafts/), so a test can plant a confirmation
// on the stored draft that no public API can produce — here, one attached to
// an equal-scope criterion, which requirementsConfirmDraft refuses to record
// (only a narrower criterion may be confirmed). This is the only way to
// reproduce "the stored draft carries a confirmation the claim drops" without
// it being caught first by the narrower-criterion loop, which only checks
// narrower criteria.
function draftFilePath(fx) {
  const dir = path.join(fx.projectRoot, "requirements-drafts");
  const [name] = fs.readdirSync(dir);
  return path.join(dir, name);
}

function readDraftFileDirect(fx) {
  const file = draftFilePath(fx);
  return { file, draft: JSON.parse(fs.readFileSync(file, "utf8")) };
}

function writeDraftFileDirect(file, draft) {
  fs.writeFileSync(file, JSON.stringify(draft, null, 2));
}

test("validateLedgerForClaim accepts a narrower criterion with a matching hash-bound confirmation", () => {
  const fx = fixture({ after() {} });
  const requirements = validateLedgerForClaim(
    { ...claimFrom(fx), worktreeId: fx.worktreeId },
    fx.director,
    fx.orgFile,
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
        orgFile,
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
        fx.orgFile,
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
        fx.orgFile,
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
        fx.orgFile,
      ),
    /valid recorded timestamp/,
  );
});

test("validateLedgerForClaim does not require confirmation for equal-scope criteria, but still keeps them for fidelity", (t) => {
  const fx = fixture(t);
  const requirements = validateLedgerForClaim(
    { ...claimFrom(fx), worktreeId: fx.worktreeId },
    fx.director,
    fx.orgFile,
  );
  const equalCriterion = requirements.criteria.find(
    (item) => item.id === "visible-1",
  );
  assert.equal(equalCriterion.scope, "equal");
});

// The equal-only exception the test above proves (no confirmation loop to
// run for equal-scope criteria) does not extend to the draft-comparison gate
// below it: even an equal-only claim must match a draft actually recorded on
// disk, so a hand-assembled equal-only requirements block that never went
// through requirements-draft is still refused.
test("validateLedgerForClaim refuses an equal-only claim with no draft ledger recorded for the worktree", (t) => {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "omt-reqledger-nodraft-")),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const orgFile = path.join(dir, ".omt", "organization.json");
  const requirements = {
    worktreeId: "wt-nodraft",
    statements: [
      { id: "s1", text: "the tool must warn before deleting", source: "brief" },
    ],
    criteria: [
      {
        id: "visible-1",
        text: "the tool warns before deleting",
        scope: "equal",
        userVisible: true,
        derivedFrom: ["s1"],
      },
    ],
    confirmations: [],
  };
  assert.throws(
    () => validateLedgerForClaim(requirements, { checkoutPath: dir }, orgFile),
    /No draft ledger recorded for worktree wt-nodraft/,
  );
});

// draft-comparison-not-hash: ledgerHash(requirements.mjs) deliberately drops
// each criterion's own `confirmation` field (that field is expected to
// change as a confirmation is recorded, without invalidating other bindings
// keyed on the ledger hash), so a claim/retrofit comparison that used
// ledgerHash for this check would let a tampered `criterion.confirmation`
// field through undetected. It has to compare criteria field-for-field
// instead.
test("validateLedgerForClaim refuses a claim whose criteria carry a tampered confirmation field, even though statements/criteria hash the same", (t) => {
  const fx = fixture(t);
  const claim = claimFrom(fx);
  claim.criteria = claim.criteria.map((item) =>
    item.id === "visible-1" ? { ...item, confirmation: "forged" } : item,
  );
  assert.equal(
    ledgerHash({ statements: claim.statements, criteria: claim.criteria }),
    ledgerHash({
      statements: fx.statements,
      criteria: readDraft(fx.orgFile, fx.worktreeId).criteria,
    }),
    "sanity check: ledgerHash itself does not notice the tampered field",
  );
  assert.throws(
    () =>
      validateLedgerForClaim(
        { ...claim, worktreeId: fx.worktreeId },
        fx.director,
        fx.orgFile,
      ),
    /criteria do not match the recorded draft ledger/,
  );
});

test("requirementsRetrofit refuses a draft argument whose criteria carry a tampered confirmation field", async (t) => {
  const fx = fixture(t, "wt-legacy-tamper-criteria");
  const claim = claimFrom(fx);
  claim.criteria = claim.criteria.map((item) =>
    item.id === "visible-1" ? { ...item, confirmation: "forged" } : item,
  );
  await assert.rejects(
    requirementsRetrofit(fx.orgFile, fx.worktreeId, claim, fx.director),
    /criteria do not match the recorded draft ledger/,
  );
});

// draft-comparison-both-ways: a one-directional comparison that only asks,
// for each confirmation the claim presents, "does the draft have this one?"
// never notices a confirmation the stored draft carries but the claim drops
// (requirementsConfirmDraft only ever confirms a narrower criterion, so the
// dropped entry has to belong to an equal-scope criterion here — otherwise
// the narrower-criterion loop above would already refuse it on its own,
// independently of this check).
test("validateLedgerForClaim refuses a claim that drops a confirmation the stored draft still carries", (t) => {
  const fx = fixture(t);
  const { file, draft } = readDraftFileDirect(fx);
  const extraConfirmation = {
    criterionId: "visible-1",
    textHash: confirmationTextHash(
      draft.criteria.find((item) => item.id === "visible-1"),
      draft.statements,
    ),
    confirmedAt: new Date().toISOString(),
    userQuote: "네, 이 기준도 확인했습니다",
    recordedFromCheckout: path.resolve(fx.dir),
  };
  draft.confirmations = [...draft.confirmations, extraConfirmation];
  writeDraftFileDirect(file, draft);
  const claim = claimFrom(fx);
  assert.equal(
    claim.confirmations.length,
    2,
    "sanity check: draft now carries both confirmations",
  );
  claim.confirmations = claim.confirmations.filter(
    (item) => item.criterionId !== "visible-1",
  );
  assert.throws(
    () =>
      validateLedgerForClaim(
        { ...claim, worktreeId: fx.worktreeId },
        fx.director,
        fx.orgFile,
      ),
    /confirmations do not match the recorded draft ledger/,
  );
});

test("requirementsRetrofit refuses a draft argument that drops a confirmation the stored draft still carries", async (t) => {
  const fx = fixture(t, "wt-legacy-drop-confirmation");
  const { file, draft } = readDraftFileDirect(fx);
  const extraConfirmation = {
    criterionId: "visible-1",
    textHash: confirmationTextHash(
      draft.criteria.find((item) => item.id === "visible-1"),
      draft.statements,
    ),
    confirmedAt: new Date().toISOString(),
    userQuote: "네, 이 기준도 확인했습니다",
    recordedFromCheckout: path.resolve(fx.dir),
  };
  draft.confirmations = [...draft.confirmations, extraConfirmation];
  writeDraftFileDirect(file, draft);
  const claim = claimFrom(fx);
  claim.confirmations = claim.confirmations.filter(
    (item) => item.criterionId !== "visible-1",
  );
  await assert.rejects(
    requirementsRetrofit(fx.orgFile, fx.worktreeId, claim, fx.director),
    /confirmations do not match the recorded draft ledger/,
  );
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
    callerCwd: fx.dir,
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
    callerCwd: fx.dir,
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
    callerCwd: fx.dir,
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
    callerCwd: fx.dir,
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

// CLI-level authority tests for requirements-retrofit and requirements-exception
// (director decision on requirements-retrofit's authority gap, msg_2f57aa6e083e):
// --force no longer bypasses the checkout check, and a legacy (director-less)
// kickoff is retrofitted only from the organization's own owner checkout.

test("cli director-authority-gap: requirements-retrofit refuses --force as an unknown option, even outside the checkout", (t) => {
  const fx = fixture(t);
  writeLegacyKickoffEntry(fx);
  const other = otherCheckout(t);
  const result = runCli(
    [
      "requirements-retrofit",
      "--org",
      fx.orgFile,
      "--worktree",
      fx.worktreeId,
      "--checkout",
      fx.dir,
      "--force",
    ],
    { cwd: other },
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unknown option: --force/);
});

test("cli director-authority-gap: requirements-retrofit refuses a director-less kickoff with no --checkout", (t) => {
  const fx = fixture(t);
  writeLegacyKickoffEntry(fx);
  const result = runCli(
    ["requirements-retrofit", "--org", fx.orgFile, "--worktree", fx.worktreeId],
    { cwd: fx.dir },
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /needs --checkout/);
});

test("cli director-authority-gap: requirements-retrofit refuses a --checkout that does not match the caller's cwd", (t) => {
  const fx = fixture(t);
  writeLegacyKickoffEntry(fx);
  const other = otherCheckout(t);
  const result = runCli(
    [
      "requirements-retrofit",
      "--org",
      fx.orgFile,
      "--worktree",
      fx.worktreeId,
      "--checkout",
      fx.dir,
    ],
    { cwd: other },
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /must be run from the given --checkout path/);
});

test("cli director-authority-gap: requirements-retrofit refuses a --checkout that is not the organization's owner checkout", (t) => {
  const fx = fixture(t);
  writeLegacyKickoffEntry(fx);
  // realpath'd, like fixture()'s own dir: otherCheckout() is not, and on
  // macOS an unresolved os.tmpdir() path never equals process.cwd(), which
  // would trip the "must be run from the given --checkout path" check before
  // this test ever reaches the owner-checkout check it means to exercise.
  const other = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "omt-reqledger-other-")),
  );
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const result = runCli(
    [
      "requirements-retrofit",
      "--org",
      fx.orgFile,
      "--worktree",
      fx.worktreeId,
      "--checkout",
      other,
    ],
    { cwd: other },
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /must be the organization's owner checkout/);
});

test("cli director-authority-gap: requirements-retrofit succeeds from the organization's own owner checkout", (t) => {
  const fx = fixture(t);
  writeLegacyKickoffEntry(fx);
  const result = runCli(
    [
      "requirements-retrofit",
      "--org",
      fx.orgFile,
      "--worktree",
      fx.worktreeId,
      "--checkout",
      fx.dir,
    ],
    { cwd: fx.dir },
  );
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.retrofitted, true);
});

test("cli director-authority-gap: requirements-exception refuses a caller outside the ledger's director checkout", (t) => {
  const fx = fixture(t);
  confirmClaim(fx);
  const requestFile = path.join(fx.dir, "exception-request.json");
  fs.writeFileSync(
    requestFile,
    JSON.stringify({
      scope: [{ type: "criterion", id: "visible-1" }],
      head: fx.head,
      repo: fx.dir,
      reason: "user accepted the current behavior for this release",
      userQuote: "fine, ship it as-is for now",
      unmetFacts: "the warning still fires on non-destructive commands too",
    }),
  );
  const other = otherCheckout(t);
  const result = runCli(
    [
      "requirements-exception",
      "--org",
      fx.orgFile,
      "--worktree",
      fx.worktreeId,
      "--from",
      requestFile,
    ],
    { cwd: other },
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /must be run from the director's checkout/);
});

test(
  "cli legacy-sequence: a director-less legacy kickoff walks exception-refused -> draft -> " +
    "confirm --draft (narrower, from the owner checkout) -> retrofit -> exception-succeeds",
  (t) => {
    const fx = legacyFixture(t);
    writeLegacyKickoffEntry(fx);
    const { statements, criteria } = baseStatementsAndCriteria();

    // (f') a legacy kickoff with no ledger yet: requirements-exception is
    // refused for want of any confirmed ledger to record the exception on.
    const exceptionRequest = path.join(fx.dir, "exception-request.json");
    fs.writeFileSync(
      exceptionRequest,
      JSON.stringify({
        scope: [{ type: "criterion", id: "visible-1" }],
        head: fx.head,
        repo: fx.dir,
        reason: "user accepted the current behavior for this release",
        userQuote: "fine, ship it as-is for now",
        unmetFacts: "the warning still fires on non-destructive commands too",
      }),
    );
    const refused = runCli(
      [
        "requirements-exception",
        "--org",
        fx.orgFile,
        "--worktree",
        fx.worktreeId,
        "--from",
        exceptionRequest,
      ],
      { cwd: fx.dir },
    );
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /No confirmed ledger/);

    const draftRequest = path.join(fx.dir, "draft-request.json");
    fs.writeFileSync(draftRequest, JSON.stringify({ statements, criteria }));
    const drafted = runCli(
      [
        "requirements-draft",
        "--org",
        fx.orgFile,
        "--worktree",
        fx.worktreeId,
        "--from",
        draftRequest,
      ],
      { cwd: fx.dir },
    );
    assert.equal(drafted.code, 0, drafted.stderr);

    const confirmed = runCli(
      [
        "requirements-confirm",
        "--org",
        fx.orgFile,
        "--worktree",
        fx.worktreeId,
        "--draft",
        "--checkout",
        fx.dir,
        "--criterion",
        "narrow-1",
        "--quote",
        "yes, only warn on destructive commands",
      ],
      { cwd: fx.dir },
    );
    assert.equal(confirmed.code, 0, confirmed.stderr);

    const retrofitted = runCli(
      [
        "requirements-retrofit",
        "--org",
        fx.orgFile,
        "--worktree",
        fx.worktreeId,
        "--checkout",
        fx.dir,
      ],
      { cwd: fx.dir },
    );
    assert.equal(retrofitted.code, 0, retrofitted.stderr);
    assert.equal(JSON.parse(retrofitted.stdout).retrofitted, true);

    const succeeded = runCli(
      [
        "requirements-exception",
        "--org",
        fx.orgFile,
        "--worktree",
        fx.worktreeId,
        "--from",
        exceptionRequest,
      ],
      { cwd: fx.dir },
    );
    assert.equal(succeeded.code, 0, succeeded.stderr);
    assert.equal(JSON.parse(succeeded.stdout).recorded, true);
  },
);

test(
  "cli legacy-sequence: requirements-retrofit refuses a narrower confirmation recorded from a " +
    "checkout other than the owner checkout, even though requirements-confirm --draft accepted it",
  (t) => {
    const fx = legacyFixture(t, "wt-legacy-cli-2");
    writeLegacyKickoffEntry(fx);
    const { statements, criteria } = baseStatementsAndCriteria();

    const draftRequest = path.join(fx.dir, "draft-request.json");
    fs.writeFileSync(draftRequest, JSON.stringify({ statements, criteria }));
    const drafted = runCli(
      [
        "requirements-draft",
        "--org",
        fx.orgFile,
        "--worktree",
        fx.worktreeId,
        "--from",
        draftRequest,
      ],
      { cwd: fx.dir },
    );
    assert.equal(drafted.code, 0, drafted.stderr);

    // Confirmed from a checkout other than the owner checkout:
    // requirements-confirm --draft only proves the caller ran from
    // --checkout, not that it is the organization's owner checkout — that
    // stricter check belongs to retrofit, which compares against the
    // claim's declared director (the owner checkout, for a legacy kickoff).
    const otherDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "omt-reqledger-legacy-other-")),
    );
    t.after(() => fs.rmSync(otherDir, { recursive: true, force: true }));
    const confirmed = runCli(
      [
        "requirements-confirm",
        "--org",
        fx.orgFile,
        "--worktree",
        fx.worktreeId,
        "--draft",
        "--checkout",
        otherDir,
        "--criterion",
        "narrow-1",
        "--quote",
        "yes, only warn on destructive commands",
      ],
      { cwd: otherDir },
    );
    assert.equal(confirmed.code, 0, confirmed.stderr);

    const retrofitted = runCli(
      [
        "requirements-retrofit",
        "--org",
        fx.orgFile,
        "--worktree",
        fx.worktreeId,
        "--checkout",
        fx.dir,
      ],
      { cwd: fx.dir },
    );
    assert.notEqual(retrofitted.code, 0);
    assert.match(
      retrofitted.stderr,
      /was recorded from a checkout other than the claim's declared director/,
    );
  },
);

// CLI registration for requirements-amend/present/fidelity/fidelity-confirm
// (PM item 3): amend/present/fidelity-confirm are director-only, checked the
// same way requirements-retrofit/requirements-exception are above; fidelity
// carries no in-function authority check by design (it is the PM's own
// record, not the director's), so its CLI test proves success rather than a
// rejection.
test("cli requirements-amend: succeeds from the ledger's director checkout, and refuses from elsewhere", (t) => {
  const fx = fixture(t);
  confirmClaim(fx);
  const requestFile = path.join(fx.dir, "amend-request.json");
  fs.writeFileSync(
    requestFile,
    JSON.stringify({
      statements: fx.statements,
      criteria: fx.criteria.map((item) =>
        item.id === "visible-1"
          ? { ...item, text: "the tool always warns before deleting" }
          : item,
      ),
    }),
  );
  const other = otherCheckout(t);
  const refused = runCli(
    [
      "requirements-amend",
      "--org",
      fx.orgFile,
      "--worktree",
      fx.worktreeId,
      "--from",
      requestFile,
    ],
    { cwd: other },
  );
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /must be run from the director's checkout/);

  const succeeded = runCli(
    [
      "requirements-amend",
      "--org",
      fx.orgFile,
      "--worktree",
      fx.worktreeId,
      "--from",
      requestFile,
    ],
    { cwd: fx.dir },
  );
  assert.equal(succeeded.code, 0, succeeded.stderr);
  assert.equal(JSON.parse(succeeded.stdout).amended, true);
});

test("cli requirements-present: succeeds from the ledger's director checkout, and refuses from elsewhere", (t) => {
  const fx = fixture(t);
  confirmClaim(fx);
  const source = evidenceFile(fx.dir);
  const requestFile = path.join(fx.dir, "present-request.json");
  fs.writeFileSync(
    requestFile,
    JSON.stringify({
      criterionId: "visible-1",
      head: fx.head,
      repo: fx.dir,
      source,
      channel: "PR",
      location: "https://example.invalid/pr/cli-1",
      userQuote: "looks right",
      outcome: "confirmed",
    }),
  );
  const other = otherCheckout(t);
  const refused = runCli(
    [
      "requirements-present",
      "--org",
      fx.orgFile,
      "--worktree",
      fx.worktreeId,
      "--from",
      requestFile,
    ],
    { cwd: other },
  );
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /must be run from the director's checkout/);

  const succeeded = runCli(
    [
      "requirements-present",
      "--org",
      fx.orgFile,
      "--worktree",
      fx.worktreeId,
      "--from",
      requestFile,
    ],
    { cwd: fx.dir },
  );
  assert.equal(succeeded.code, 0, succeeded.stderr);
  assert.equal(JSON.parse(succeeded.stdout).presented, true);
});

test("cli requirements-fidelity: records a fidelity check with no director-authority check, by design", (t) => {
  const fx = fixture(t);
  confirmClaim(fx);
  const requestFile = path.join(fx.dir, "fidelity-request.json");
  fs.writeFileSync(
    requestFile,
    JSON.stringify({
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
    }),
  );
  // Runs from a checkout other than the director's own: requirements-fidelity
  // is the PM's own record, so no checkout check applies here.
  const other = otherCheckout(t);
  const result = runCli(
    [
      "requirements-fidelity",
      "--org",
      fx.orgFile,
      "--worktree",
      fx.worktreeId,
      "--from",
      requestFile,
    ],
    { cwd: other },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).recorded, true);
});

test("cli requirements-fidelity-confirm: succeeds from the ledger's director checkout, and refuses from elsewhere", (t) => {
  const fx = fixture(t);
  confirmClaim(fx);
  const fidelityRequest = path.join(fx.dir, "fidelity-request-2.json");
  fs.writeFileSync(
    fidelityRequest,
    JSON.stringify({
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
    }),
  );
  const recorded = runCli(
    [
      "requirements-fidelity",
      "--org",
      fx.orgFile,
      "--worktree",
      fx.worktreeId,
      "--from",
      fidelityRequest,
    ],
    { cwd: fx.dir },
  );
  assert.equal(recorded.code, 0, recorded.stderr);

  const other = otherCheckout(t);
  const refused = runCli(
    [
      "requirements-fidelity-confirm",
      "--org",
      fx.orgFile,
      "--worktree",
      fx.worktreeId,
    ],
    { cwd: other },
  );
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /must be run from the director's checkout/);

  const succeeded = runCli(
    [
      "requirements-fidelity-confirm",
      "--org",
      fx.orgFile,
      "--worktree",
      fx.worktreeId,
    ],
    { cwd: fx.dir },
  );
  assert.equal(succeeded.code, 0, succeeded.stderr);
  assert.equal(JSON.parse(succeeded.stdout).confirmed, true);
});
