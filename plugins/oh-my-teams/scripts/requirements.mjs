/**
 * Requirements ledger: user statements, acceptance criteria derived from them,
 * user confirmation of narrowed criteria, presentation of results, fidelity
 * checks against the original statements, and item-scoped exceptions.
 *
 * See docs/plan/requirements-ledger-and-audit.md (section A) for the full
 * design. A draft ledger holds no authenticated confirmation; a confirmed
 * ledger is written only once `kickoff-claim` validates the draft against the
 * claim's own director identity, closing the deadlock described in A.2.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  assert,
  fileSha256,
  hash,
  inside,
  readJSON,
  withAsyncFileLock,
  withFileLock,
  writeJSON,
} from "./core.mjs";
import { canonicalize } from "./contracts.mjs";
import { workspaceBinding } from "./evidence.mjs";
import { hasValidAcceptance } from "./audit.mjs";
import { resolveResultRepo } from "./workflow.mjs";

const SCOPES = ["equal", "narrower"];
const FIDELITY_STATUSES = ["met", "unmet"];
const PRESENTATION_OUTCOMES = ["confirmed", "rejected"];

function canonicalHash(value) {
  return hash(canonicalize(value));
}

/**
 * Sorts a copy of `list` by the string value of `key`, so two arrays holding
 * the same items in a different order compare equal, while a length
 * difference, an added item, a removed item, or a changed field on any item
 * still compares unequal.
 *
 * @param {object[]} list - Items to sort, each carrying `key`.
 * @param {string} key - Property to sort by.
 * @returns {object[]} New, sorted array; `list` itself is left untouched.
 */
function sortedBy(list, key) {
  return [...list].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
}

/**
 * Rejects a confirmation or presentation record whose user-facing fields are
 * blank or malformed, so a record assembled by hand (matching hash and
 * checkout, but never actually spoken by the user) cannot pass the gate that
 * `requirementsConfirmDraft`/`requirementsConfirm`/`requirementsPresent`
 * would otherwise have refused to write.
 *
 * @param {object} record - Confirmation or presentation record to check.
 * @param {string} label - What the record is, for the error message.
 * @throws {Error} When `userQuote` is blank or `confirmedAt`/`recordedAt` is not a valid timestamp.
 */
function assertSubstantiveUserRecord(record, label) {
  assert(
    typeof record.userQuote === "string" && record.userQuote.trim(),
    `${label} is missing the user's own quote`,
  );
  const timestamp = record.confirmedAt ?? record.recordedAt;
  assert(
    typeof timestamp === "string" && !Number.isNaN(Date.parse(timestamp)),
    `${label} is missing a valid recorded timestamp`,
  );
}

function projectRoot(orgFile) {
  return path.dirname(path.resolve(orgFile));
}

/**
 * Checks that a ledger-mutating call runs from the ledger's own recorded
 * director checkout. Checked against the ledger itself, not a kickoff-registry
 * lookup, so `requirements.mjs` stays independent of `kickoff-registry.mjs`
 * (the same self-declared-location principle `requirementsConfirmDraft`
 * documents for A.2). A ledger written before this check existed carries no
 * `director` and is let through with a warning, mirroring
 * `delivery.mjs`'s `assertDirectorAuthority` precedent for legacy entries.
 *
 * @param {object} ledger - Confirmed ledger read from disk.
 * @param {string} callerCwd - Caller's working directory to compare.
 * @param {string} use - Description of the operation, for the error message.
 * @throws {Error} When the caller is not at the ledger's director checkout path.
 */
function assertLedgerDirectorAuthority(ledger, callerCwd, use) {
  if (!ledger.director) {
    console.warn(
      `[omt] Warning: ledger has no director record; ${use} proceeds without director verification.`,
    );
    return;
  }
  const expected = path.resolve(ledger.director.checkoutPath);
  const actual = path.resolve(callerCwd);
  assert(
    actual === expected,
    `${use} must be run from the director's checkout at ${expected}; ` +
      `current directory is ${actual}.`,
  );
}

function entryName(worktreeId) {
  assert(
    typeof worktreeId === "string" && worktreeId.trim(),
    "PM worktree id required",
  );
  return crypto.createHash("sha256").update(worktreeId).digest("hex");
}

function draftFile(orgFile, worktreeId) {
  return path.join(
    projectRoot(orgFile),
    "requirements-drafts",
    `${entryName(worktreeId)}.json`,
  );
}

function ledgerFile(orgFile, worktreeId) {
  return path.join(
    projectRoot(orgFile),
    "requirements",
    `${entryName(worktreeId)}.json`,
  );
}

function withDrafts(orgFile, callback) {
  const directory = path.join(projectRoot(orgFile), "requirements-drafts");
  fs.mkdirSync(directory, { recursive: true });
  return withFileLock(
    path.join(directory, ".lock"),
    callback,
    "Requirements draft update in progress; read it again",
  );
}

function withLedgers(orgFile, callback) {
  const directory = path.join(projectRoot(orgFile), "requirements");
  fs.mkdirSync(directory, { recursive: true });
  return withAsyncFileLock(
    path.join(directory, ".lock"),
    callback,
    "Requirements ledger update in progress; read it again",
  );
}

function validateStatements(statements) {
  assert(
    Array.isArray(statements) && statements.length > 0,
    "At least one requirements statement is required",
  );
  for (const statement of statements) {
    assert(
      statement && typeof statement.id === "string" && statement.id.trim(),
      "Statement id required",
    );
    assert(
      typeof statement.text === "string" && statement.text.trim(),
      `Statement text required: ${statement.id}`,
    );
    assert(
      typeof statement.source === "string" && statement.source.trim(),
      `Statement source required: ${statement.id}`,
    );
  }
  assert(
    new Set(statements.map((statement) => statement.id)).size ===
      statements.length,
    "Statement ids must be unique",
  );
}

function validateCriteria(criteria, statements) {
  assert(
    Array.isArray(criteria) && criteria.length > 0,
    "At least one acceptance criterion is required",
  );
  const statementIds = new Set(statements.map((statement) => statement.id));
  for (const criterion of criteria) {
    assert(
      criterion && typeof criterion.id === "string" && criterion.id.trim(),
      "Criterion id required",
    );
    assert(
      typeof criterion.text === "string" && criterion.text.trim(),
      `Criterion text required: ${criterion.id}`,
    );
    assert(
      SCOPES.includes(criterion.scope),
      `Criterion scope must be one of ${SCOPES.join("/")}: ${criterion.id}`,
    );
    assert(
      typeof criterion.userVisible === "boolean",
      `Criterion userVisible required: ${criterion.id}`,
    );
    assert(
      Array.isArray(criterion.derivedFrom) &&
        criterion.derivedFrom.length > 0 &&
        criterion.derivedFrom.every((id) => statementIds.has(id)),
      `Criterion derivedFrom must name existing statements: ${criterion.id}`,
    );
  }
  assert(
    new Set(criteria.map((criterion) => criterion.id)).size === criteria.length,
    "Criterion ids must be unique",
  );
}

/**
 * Hashes the parts of a ledger that must stay stable for a recorded fact
 * (confirmation, presentation, fidelity check, exception) to remain valid.
 *
 * @param {{statements: object[], criteria: object[]}} ledger - Draft or confirmed ledger.
 * @returns {string} Stable SHA-256 digest over statements and criteria text/scope.
 */
export function ledgerHash(ledger) {
  return canonicalHash({
    statements: ledger.statements,
    criteria: ledger.criteria.map(({ confirmation, ...rest }) => rest),
  });
}

/**
 * Hashes everything a narrower criterion's user confirmation must stay bound
 * to: the criterion's own id, text, scope, userVisible and derivedFrom, plus
 * the id and text of every statement it was derived from. Any one of those
 * changing at the same HEAD must invalidate the confirmation — scope flipping
 * away from "narrower", userVisible turning on, or derivedFrom pointing at a
 * different statement all change what the user actually agreed to, even when
 * `criterion.text` itself is untouched.
 *
 * @param {object} criterion - Criterion carrying id/text/scope/userVisible/derivedFrom.
 * @param {object[]} statements - Statements the criterion may reference.
 * @returns {string} Stable SHA-256 digest.
 */
export function confirmationTextHash(criterion, statements) {
  return canonicalHash({
    criterionId: criterion.id,
    criterionText: criterion.text,
    criterionScope: criterion.scope,
    criterionUserVisible: criterion.userVisible,
    criterionDerivedFrom: criterion.derivedFrom,
    derivedStatements: criterion.derivedFrom.map((id) => {
      const statement = statements.find((item) => item.id === id);
      return { id, text: statement?.text };
    }),
  });
}

/**
 * Creates or overwrites the pre-claim draft ledger for a PM worktree.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {{worktreeId: string, statements: object[], criteria: object[]}} request - Draft content.
 * @returns {{drafted: boolean, file: string, draft: object}} Written draft.
 * @throws {Error} When statements or criteria are missing or malformed.
 */
export function requirementsDraft(
  orgFile,
  { worktreeId, statements, criteria },
) {
  validateStatements(statements);
  validateCriteria(criteria, statements);
  return withDrafts(orgFile, () => {
    const file = draftFile(orgFile, worktreeId);
    const draft = {
      schemaVersion: 1,
      worktreeId,
      statements,
      criteria: criteria.map((criterion) => ({
        ...criterion,
        confirmation: null,
      })),
      confirmations: [],
    };
    writeJSON(file, draft);
    return { drafted: true, file, draft };
  });
}

/**
 * Reads the draft ledger for a PM worktree, if one exists.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree the draft belongs to.
 * @returns {object | null} Draft ledger, or null when none was written.
 */
export function readDraft(orgFile, worktreeId) {
  const file = draftFile(orgFile, worktreeId);
  return fs.existsSync(file) ? readJSON(file) : null;
}

/**
 * Reads the confirmed ledger for a PM worktree, if the kickoff has claimed one.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree the ledger belongs to.
 * @returns {object | null} Confirmed ledger, or null when none exists.
 */
export function readLedger(orgFile, worktreeId) {
  const file = ledgerFile(orgFile, worktreeId);
  return fs.existsSync(file) ? readJSON(file) : null;
}

/**
 * Records a user confirmation for a narrower criterion on the draft ledger.
 *
 * Authentication here is self-declared location, not a registry lookup: no
 * kickoff is registered yet, so there is no `entry.director` to compare
 * against (A.2). The check only proves a process ran this command from
 * `checkout`; `validateLedgerForClaim` later ties that fact to the claim's
 * own declared director checkout, closing the deadlock.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {{worktreeId: string, criterionId: string, userQuote: string, checkout: string}} request - Confirmation to record.
 * @returns {{confirmed: boolean, draft: object}} Updated draft.
 * @throws {Error} When the criterion is unknown, not narrower, or the caller
 *   is not running from `checkout`.
 */
export function requirementsConfirmDraft(
  orgFile,
  { worktreeId, criterionId, userQuote, checkout },
) {
  assert(
    typeof checkout === "string" && checkout.trim(),
    "--checkout is required to record a draft confirmation",
  );
  assert(
    path.resolve(process.cwd()) === path.resolve(checkout),
    "requirements-confirm --draft must run from the given --checkout path",
  );
  assert(
    typeof userQuote === "string" && userQuote.trim(),
    "userQuote is required for a narrower criterion confirmation",
  );
  return withDrafts(orgFile, () => {
    const file = draftFile(orgFile, worktreeId);
    assert(fs.existsSync(file), `No draft ledger for worktree ${worktreeId}`);
    const draft = readJSON(file);
    const criterion = draft.criteria.find((item) => item.id === criterionId);
    assert(criterion, `Unknown criterion: ${criterionId}`);
    assert(
      criterion.scope === "narrower",
      `Criterion ${criterionId} has scope "${criterion.scope}"; only narrower criteria require confirmation`,
    );
    const confirmation = {
      criterionId,
      textHash: confirmationTextHash(criterion, draft.statements),
      confirmedAt: new Date().toISOString(),
      userQuote,
      recordedFromCheckout: path.resolve(checkout),
    };
    draft.confirmations = [
      ...draft.confirmations.filter((item) => item.criterionId !== criterionId),
      confirmation,
    ];
    writeJSON(file, draft);
    return { confirmed: true, draft };
  });
}

/**
 * Validates a claim's embedded requirements against the stored draft ledger
 * recorded on disk for the same worktree, closing the A.2 deadlock without a
 * kickoff-registry lookup. This is the single comparison a new claim
 * (`kickoff-registry.mjs`'s `withLedgerFromClaim`) and a legacy backfill
 * (`requirementsRetrofit`) both run: neither may substitute hand-assembled
 * statements, criteria or confirmations for what `requirements-draft` and
 * `requirements-confirm --draft` actually recorded, so a confirmation whose
 * hash and checkout merely happen to match (but was never spoken by the
 * user through that draft) is refused. There is no equal-only shortcut: a
 * claim that never went through `requirements-draft` is refused even when
 * every criterion is equal-scope, because a narrower criterion demoted to
 * equal-scope in the claim (to dodge the confirmation requirement below)
 * would otherwise pass unnoticed (docs/plan/requirements-ledger-and-audit.md
 * A.2).
 *
 * @param {object} requirements - The `requirements` block of a kickoff claim
 *   or a retrofit's reconstructed ledger, both compared against the stored
 *   draft; carries the `worktreeId` the draft was recorded under.
 * @param {{checkoutPath: string}} director - The claim's declared director.
 * @param {string} orgFile - Organization JSON path, to locate the stored draft.
 * @returns {object} The same `requirements` object, once every check passes.
 * @throws {Error} When statements/criteria are empty, a narrower criterion
 *   lacks a matching confirmation, a confirmation was recorded from a
 *   checkout other than the claim's declared director, no draft is recorded
 *   for the worktree, or the requirements block diverges from that draft.
 */
export function validateLedgerForClaim(requirements, director, orgFile) {
  assert(
    requirements && typeof requirements === "object",
    "Claim requirements ledger required",
  );
  const { statements, criteria, confirmations = [], worktreeId } = requirements;
  validateStatements(statements);
  validateCriteria(criteria, statements);
  // A registered director is required unconditionally, even when this claim's
  // criteria are all equal-scope and so need no narrower confirmation right
  // now: skipping the check for an equal-only ledger would let a claim that
  // carries a ledger but omits its director bypass director-only commands
  // (present, confirm, fidelity-confirm, exception, audit-policy pin) that
  // key off the same registry entry later, once a narrower criterion is
  // added. A pre-ledger kickoff with no director at all is migrated through
  // a separate, director-run retrofit procedure instead of this check.
  assert(
    director &&
      typeof director.checkoutPath === "string" &&
      director.checkoutPath.trim(),
    "Claim director.checkoutPath is required to validate the requirements ledger",
  );
  const directorPath = path.resolve(director.checkoutPath);
  for (const criterion of criteria.filter(
    (item) => item.scope === "narrower",
  )) {
    const confirmation = confirmations.find(
      (item) => item.criterionId === criterion.id,
    );
    assert(
      confirmation,
      `Narrower criterion ${criterion.id} requires a recorded user confirmation`,
    );
    assert(
      confirmation.textHash === confirmationTextHash(criterion, statements),
      `Confirmation for ${criterion.id} does not match its current statement/criterion text`,
    );
    assert(
      path.resolve(confirmation.recordedFromCheckout) === directorPath,
      `Confirmation for ${criterion.id} was recorded from a checkout other than the claim's declared director`,
    );
    assertSubstantiveUserRecord(
      confirmation,
      `Confirmation for ${criterion.id}`,
    );
  }
  // Every claim/retrofit must match a draft actually recorded on disk: this
  // is what stops a hand-assembled requirements block (correct hash, correct
  // checkout, non-blank quote, but never run through requirements-draft /
  // requirements-confirm --draft) from passing. There is no equal-only
  // exception (A.2, appendix B).
  assert(
    typeof orgFile === "string" && orgFile.trim(),
    "Validating a claim's requirements ledger requires orgFile, to locate the stored draft",
  );
  assert(
    typeof worktreeId === "string" && worktreeId.trim(),
    "Claim requirements must carry the worktreeId the draft was recorded under",
  );
  const draft = readDraft(orgFile, worktreeId);
  assert(
    draft,
    `No draft ledger recorded for worktree ${worktreeId}; run requirements-draft ` +
      "(and, for a narrower criterion, requirements-confirm --draft from the director's checkout) " +
      "before this claim or retrofit",
  );
  // Compared field-for-field against the draft, not via ledgerHash: ledgerHash
  // deliberately excludes each criterion's own `confirmation` field (it is
  // meant to stay stable across a confirmation being recorded), so a hash
  // comparison here would let a claim tamper with that field undetected.
  // Sorting both sides and running isDeepStrictEqual instead catches a
  // changed, added, or removed statement/criterion (confirmation field
  // included), and — for confirmations — is checked both ways: an entry the
  // claim adds and one it drops from the stored draft are both refused.
  assert(
    isDeepStrictEqual(
      sortedBy(statements, "id"),
      sortedBy(draft.statements, "id"),
    ),
    `This claim's statements do not match the recorded draft ledger for worktree ${worktreeId} ` +
      "(a statement was added, removed, or its text/source changed)",
  );
  assert(
    isDeepStrictEqual(sortedBy(criteria, "id"), sortedBy(draft.criteria, "id")),
    `This claim's criteria do not match the recorded draft ledger for worktree ${worktreeId} ` +
      "(a criterion was added, removed, or its text/scope/userVisible/derivedFrom/confirmation field changed)",
  );
  assert(
    isDeepStrictEqual(
      sortedBy(confirmations, "criterionId"),
      sortedBy(draft.confirmations, "criterionId"),
    ),
    `This claim's confirmations do not match the recorded draft ledger for worktree ${worktreeId} ` +
      "(an entry was added, removed, or altered)",
  );
  return requirements;
}

/**
 * Builds the confirmed ledger record written when a claim is registered.
 *
 * @param {object} requirements - Validated `requirements` block of a claim.
 * @param {{checkoutPath: string}} [director] - The claim's declared director,
 *   recorded on the ledger so later mutations (amend/confirm/fidelity-confirm/
 *   exception) can check director authority without a kickoff-registry lookup.
 * @returns {object} Confirmed ledger, with empty presentations/fidelityChecks/exceptions.
 */
export function confirmedLedgerFromClaim(requirements, director) {
  return {
    schemaVersion: 1,
    worktreeId: requirements.worktreeId,
    statements: requirements.statements,
    criteria: requirements.criteria,
    confirmations: requirements.confirmations ?? [],
    presentations: [],
    fidelityChecks: [],
    exceptions: [],
    ...(director?.checkoutPath
      ? { director: { checkoutPath: path.resolve(director.checkoutPath) } }
      : {}),
  };
}

/**
 * Writes the confirmed ledger for a worktree. The caller (`registerKickoff`)
 * already holds the kickoff-registry lock, so this performs no locking of
 * its own.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree the ledger belongs to.
 * @param {object} ledger - Confirmed ledger to persist.
 * @returns {{file: string, ledgerHash: string}} Written file and its hash.
 */
export function writeConfirmedLedger(orgFile, worktreeId, ledger) {
  const file = ledgerFile(orgFile, worktreeId);
  writeJSON(file, { ...ledger, worktreeId });
  return { file, ledgerHash: ledgerHash(ledger) };
}

/**
 * Replaces the statements/criteria of a confirmed ledger. Every recorded
 * confirmation, presentation, fidelity check, and exception stays on disk,
 * but the changed `ledgerHash` makes each of them fail the binding check the
 * next time it is consumed (A.3) — the amendment needs no separate
 * invalidation step.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree the ledger belongs to.
 * @param {object} amendment - New statements/criteria.
 * @param {object[]} amendment.statements - Replacement statements.
 * @param {object[]} amendment.criteria - Replacement criteria.
 * @param {string} [amendment.callerCwd] - Caller's working directory, checked
 *   against the ledger's recorded director.
 * @returns {Promise<{amended: boolean, ledger: object, ledgerHash: string}>} Updated ledger.
 * @throws {Error} When no confirmed ledger exists yet, the amendment is malformed,
 *   or the caller is not the ledger's director.
 */
export async function requirementsAmend(
  orgFile,
  worktreeId,
  { statements, criteria, callerCwd = process.cwd() },
) {
  validateStatements(statements);
  validateCriteria(criteria, statements);
  return withLedgers(orgFile, () => {
    const file = ledgerFile(orgFile, worktreeId);
    assert(
      fs.existsSync(file),
      `No confirmed ledger for worktree ${worktreeId}`,
    );
    const existing = readJSON(file);
    assertLedgerDirectorAuthority(existing, callerCwd, "requirements-amend");
    const ledger = { ...existing, statements, criteria };
    writeJSON(file, ledger);
    return { amended: true, ledger, ledgerHash: ledgerHash(ledger) };
  });
}

/**
 * Records or refreshes a user confirmation for a narrower criterion on the
 * confirmed ledger, after `requirements-amend` changed its text.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree the ledger belongs to.
 * @param {object} request - Confirmation to record.
 * @param {string} request.criterionId - Narrower criterion being confirmed.
 * @param {string} request.userQuote - The user's own words.
 * @param {string} [request.callerCwd] - Caller's working directory, checked
 *   against the ledger's recorded director.
 * @returns {Promise<{confirmed: boolean, ledger: object}>} Updated ledger.
 * @throws {Error} When the ledger or criterion is missing, the criterion is not narrower,
 *   or the caller is not the ledger's director.
 */
export async function requirementsConfirm(
  orgFile,
  worktreeId,
  { criterionId, userQuote, callerCwd = process.cwd() },
) {
  assert(
    typeof userQuote === "string" && userQuote.trim(),
    "userQuote is required for a narrower criterion confirmation",
  );
  return withLedgers(orgFile, () => {
    const file = ledgerFile(orgFile, worktreeId);
    assert(
      fs.existsSync(file),
      `No confirmed ledger for worktree ${worktreeId}`,
    );
    const ledger = readJSON(file);
    assertLedgerDirectorAuthority(ledger, callerCwd, "requirements-confirm");
    const criterion = ledger.criteria.find((item) => item.id === criterionId);
    assert(criterion, `Unknown criterion: ${criterionId}`);
    assert(
      criterion.scope === "narrower",
      `Criterion ${criterionId} has scope "${criterion.scope}"; only narrower criteria require confirmation`,
    );
    const confirmation = {
      criterionId,
      textHash: confirmationTextHash(criterion, ledger.statements),
      confirmedAt: new Date().toISOString(),
      userQuote,
      recordedFromCheckout: process.cwd(),
    };
    ledger.confirmations = [
      ...ledger.confirmations.filter(
        (item) => item.criterionId !== criterionId,
      ),
      confirmation,
    ];
    writeJSON(file, ledger);
    return { confirmed: true, ledger };
  });
}

/**
 * Copies evidence into the owner project and records a presentation of a
 * criterion's current result to the user.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree the ledger belongs to.
 * @param {object} request - Presentation to record.
 * @param {string} request.criterionId - Criterion presented.
 * @param {string} request.head - Result HEAD the presentation reflects.
 * @param {string} request.repo - Workspace `head` is checked against.
 * @param {string} request.source - Local file path copied into evidence storage.
 * @param {string} request.channel - How the result was shown to the user (e.g. "PR", "terminal report", "doc link").
 * @param {string} request.location - Where within that channel it was shown (e.g. a PR URL or file path).
 * @param {string} request.userQuote - What the user said in response.
 * @param {string} request.outcome - "confirmed" or "rejected".
 * @param {string} [request.callerCwd] - Caller's working directory, checked
 *   against the ledger's recorded director.
 * @returns {Promise<{presented: boolean, ledger: object}>} Updated ledger.
 * @throws {Error} When the criterion is unknown, evidence cannot be read, fields are missing,
 *   `head` does not match the workspace's actual Git HEAD, or the caller is not the ledger's director.
 */
export async function requirementsPresent(
  orgFile,
  worktreeId,
  {
    criterionId,
    head,
    repo,
    source,
    channel,
    location,
    userQuote,
    outcome,
    callerCwd = process.cwd(),
  },
) {
  assert(
    typeof head === "string" && head.trim(),
    "head is required for a presentation",
  );
  assert(
    typeof repo === "string" && repo.trim(),
    "repo is required to verify head against the workspace's actual HEAD",
  );
  assert(
    PRESENTATION_OUTCOMES.includes(outcome),
    `Presentation outcome must be one of ${PRESENTATION_OUTCOMES.join("/")}`,
  );
  assert(
    typeof channel === "string" && channel.trim(),
    "channel is required for a presentation (how the result was shown to the user)",
  );
  assert(
    typeof location === "string" && location.trim(),
    "location is required for a presentation (where within that channel it was shown)",
  );
  assert(
    typeof userQuote === "string" && userQuote.trim(),
    "userQuote is required for a presentation",
  );
  assert(
    typeof source === "string" && fs.existsSync(source),
    "Presentation evidence source must exist",
  );
  const { head: actualHead } = await workspaceBinding(repo);
  assert(
    actualHead && actualHead === head,
    `Declared head ${head} does not match the actual Git HEAD ` +
      `${actualHead ?? "(not a Git workspace)"} of ${repo}; ` +
      "a stale or forged head cannot be presented as the current result",
  );
  return withLedgers(orgFile, () => {
    const file = ledgerFile(orgFile, worktreeId);
    assert(
      fs.existsSync(file),
      `No confirmed ledger for worktree ${worktreeId}`,
    );
    const ledger = readJSON(file);
    assertLedgerDirectorAuthority(ledger, callerCwd, "requirements-present");
    const criterion = ledger.criteria.find((item) => item.id === criterionId);
    assert(criterion, `Unknown criterion: ${criterionId}`);
    const root = projectRoot(orgFile);
    const ownerPath = path.posix.join(
      "requirements-evidence",
      `${criterionId}-${head}${path.extname(source) || ""}`,
    );
    const destination = inside(root, ownerPath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    const presentation = {
      criterionId,
      head,
      ledgerHash: ledgerHash(ledger),
      evidence: { ownerPath, sha256: fileSha256(destination) },
      channel,
      location,
      userQuote,
      outcome,
      recordedAt: new Date().toISOString(),
    };
    ledger.presentations = [...ledger.presentations, presentation];
    writeJSON(file, ledger);
    return { presented: true, ledger };
  });
}

/**
 * Records a PM's draft fidelity check: met/unmet status for every statement
 * and criterion against the current result HEAD.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree the ledger belongs to.
 * @param {{head: string, repo: string, recordedBy: string, items: object[]}} request - Fidelity check to record.
 * @returns {Promise<{recorded: boolean, ledger: object}>} Updated ledger.
 * @throws {Error} When items do not cover every statement/criterion exactly once, or `head`
 *   does not match the workspace's actual Git HEAD.
 */
export async function requirementsFidelity(
  orgFile,
  worktreeId,
  { head, repo, recordedBy, items },
) {
  assert(typeof head === "string" && head.trim(), "head is required");
  assert(
    typeof repo === "string" && repo.trim(),
    "repo is required to verify head against the workspace's actual HEAD",
  );
  assert(
    typeof recordedBy === "string" && recordedBy.trim(),
    "recordedBy is required",
  );
  assert(Array.isArray(items) && items.length > 0, "fidelity items required");
  const { head: actualHead } = await workspaceBinding(repo);
  assert(
    actualHead && actualHead === head,
    `Declared head ${head} does not match the actual Git HEAD ` +
      `${actualHead ?? "(not a Git workspace)"} of ${repo}; ` +
      "a stale or forged head cannot bind a fidelity check",
  );
  for (const item of items) {
    assert(
      item && ["statement", "criterion"].includes(item.type) && item.id,
      "Each fidelity item needs a type (statement/criterion) and id",
    );
    assert(
      FIDELITY_STATUSES.includes(item.status),
      `Fidelity item status must be one of ${FIDELITY_STATUSES.join("/")}: ${item.id}`,
    );
    assert(
      typeof item.evidence === "string" && item.evidence.trim(),
      `Fidelity item evidence required: ${item.id}`,
    );
  }
  return withLedgers(orgFile, () => {
    const file = ledgerFile(orgFile, worktreeId);
    assert(
      fs.existsSync(file),
      `No confirmed ledger for worktree ${worktreeId}`,
    );
    const ledger = readJSON(file);
    const expected = new Set([
      ...ledger.statements.map((statement) => `statement:${statement.id}`),
      ...ledger.criteria.map((criterion) => `criterion:${criterion.id}`),
    ]);
    const covered = new Set(items.map((item) => `${item.type}:${item.id}`));
    assert(
      covered.size === items.length &&
        expected.size === covered.size &&
        [...expected].every((key) => covered.has(key)),
      "Fidelity items must cover every current statement and criterion exactly once",
    );
    const record = {
      head,
      ledgerHash: ledgerHash(ledger),
      recordedAt: new Date().toISOString(),
      recordedBy,
      items,
      directorConfirmedAt: null,
    };
    ledger.fidelityChecks = [...ledger.fidelityChecks, record];
    writeJSON(file, ledger);
    return { recorded: true, ledger };
  });
}

/**
 * Marks the most recent fidelity check as confirmed by the director.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree the ledger belongs to.
 * @param {string} [callerCwd] - Caller's working directory, checked against
 *   the ledger's recorded director.
 * @returns {Promise<{confirmed: boolean, ledger: object}>} Updated ledger.
 * @throws {Error} When no fidelity check has been recorded yet, or the caller
 *   is not the ledger's director.
 */
export async function requirementsFidelityConfirm(
  orgFile,
  worktreeId,
  callerCwd = process.cwd(),
) {
  return withLedgers(orgFile, () => {
    const file = ledgerFile(orgFile, worktreeId);
    assert(
      fs.existsSync(file),
      `No confirmed ledger for worktree ${worktreeId}`,
    );
    const ledger = readJSON(file);
    assertLedgerDirectorAuthority(
      ledger,
      callerCwd,
      "requirements-fidelity-confirm",
    );
    assert(
      ledger.fidelityChecks.length > 0,
      "No fidelity check has been recorded yet",
    );
    const index = ledger.fidelityChecks.length - 1;
    ledger.fidelityChecks[index] = {
      ...ledger.fidelityChecks[index],
      directorConfirmedAt: new Date().toISOString(),
    };
    writeJSON(file, ledger);
    return { confirmed: true, ledger };
  });
}

/**
 * Records an item-scoped exception for statements/criteria that cannot be met.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree the ledger belongs to.
 * @param {object} request - Exception to record.
 * @param {{type: string, id: string}[]} request.scope - Exact items covered; no blanket scope.
 * @param {string} request.head - Result HEAD the exception applies to.
 * @param {string} request.repo - Workspace `head` is checked against.
 * @param {string} request.reason - Why the item cannot be met.
 * @param {string} request.userQuote - The user's own words accepting the gap.
 * @param {string} request.unmetFacts - What is actually true instead.
 * @param {string} [request.callerCwd] - Caller's working directory, checked
 *   against the ledger's recorded director.
 * @returns {Promise<{recorded: boolean, ledger: object}>} Updated ledger.
 * @throws {Error} When the scope is empty, names unknown items, fields are missing,
 *   `head` does not match the workspace's actual Git HEAD, or the caller is not
 *   the ledger's director.
 */
export async function requirementsException(
  orgFile,
  worktreeId,
  {
    scope,
    head,
    repo,
    reason,
    userQuote,
    unmetFacts,
    callerCwd = process.cwd(),
  },
) {
  assert(
    Array.isArray(scope) &&
      scope.length > 0 &&
      scope.every(
        (item) =>
          item &&
          ["statement", "criterion"].includes(item.type) &&
          typeof item.id === "string" &&
          item.id.trim(),
      ),
    "Exception scope must be a non-empty array of {type, id}; no blanket scope is allowed",
  );
  for (const field of [
    ["reason", reason],
    ["userQuote", userQuote],
    ["unmetFacts", unmetFacts],
  ]) {
    assert(
      typeof field[1] === "string" && field[1].trim(),
      `Exception ${field[0]} required`,
    );
  }
  assert(typeof head === "string" && head.trim(), "head is required");
  assert(
    typeof repo === "string" && repo.trim(),
    "repo is required to verify head against the workspace's actual HEAD",
  );
  const { head: actualHead } = await workspaceBinding(repo);
  assert(
    actualHead && actualHead === head,
    `Declared head ${head} does not match the actual Git HEAD ` +
      `${actualHead ?? "(not a Git workspace)"} of ${repo}; ` +
      "a stale or forged head cannot ground an exception",
  );
  return withLedgers(orgFile, () => {
    const file = ledgerFile(orgFile, worktreeId);
    assert(
      fs.existsSync(file),
      `No confirmed ledger for worktree ${worktreeId}`,
    );
    const ledger = readJSON(file);
    assertLedgerDirectorAuthority(ledger, callerCwd, "requirements-exception");
    const known = new Set([
      ...ledger.statements.map((statement) => `statement:${statement.id}`),
      ...ledger.criteria.map((criterion) => `criterion:${criterion.id}`),
    ]);
    assert(
      scope.every((item) => known.has(`${item.type}:${item.id}`)),
      "Exception scope names an unknown statement or criterion",
    );
    const exception = {
      id: crypto.randomUUID(),
      scope,
      ledgerHash: ledgerHash(ledger),
      head,
      reason,
      userQuote,
      unmetFacts,
      recordedAt: new Date().toISOString(),
    };
    ledger.exceptions = [...ledger.exceptions, exception];
    writeJSON(file, ledger);
    return { recorded: true, ledger };
  });
}

/**
 * Constructs and writes a confirmed ledger for a kickoff that was registered
 * before this feature existed, so its close gates (A.6) can pass. Follows the
 * same validation as a new claim's draft; the director's authority to do this
 * (`assertDirectorAuthority`) is checked by the caller.
 *
 * `draft` must equal what `requirements-draft` (and, for a narrower
 * criterion, `requirements-confirm --draft`) actually recorded on disk for
 * `worktreeId` — `validateLedgerForClaim` compares it against that stored
 * draft field-for-field, so a hand-assembled `draft` argument that never went
 * through those commands is refused the same way a forged new-claim
 * `requirements` block is. This closes counterexample 7 for legacy kickoffs
 * too: a legacy kickoff still has to go through `requirements-draft` (and
 * `requirements-confirm --draft` for any narrower criterion) before it can be
 * retrofitted, it just does so after the fact instead of before the claim.
 * One gap the runtime cannot catch: a criterion the user actually meant as
 * narrower, but that the draft records as equal-scope, passes here exactly
 * like any other equal-scope criterion, because nothing on disk marks it as a
 * semantic narrowing. Catching that is the director's own fidelity
 * confirmation (`requirementsFidelityConfirm`) and the auditor's comparison
 * against the original statements, not this function.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree the retrofit applies to.
 * @param {{statements: object[], criteria: object[], confirmations: object[]}} draft - Content
 *   that must equal the stored draft already recorded for `worktreeId`.
 * @param {{checkoutPath: string}} director - The kickoff's registered director.
 * @returns {Promise<{retrofitted: boolean, ledger: object}>} Written ledger.
 * @throws {Error} When a confirmed ledger already exists, or validation fails.
 */
export async function requirementsRetrofit(
  orgFile,
  worktreeId,
  draft,
  director,
) {
  return withLedgers(orgFile, () => {
    const file = ledgerFile(orgFile, worktreeId);
    assert(
      !fs.existsSync(file),
      `Worktree ${worktreeId} already has a confirmed ledger`,
    );
    validateLedgerForClaim({ ...draft, worktreeId }, director, orgFile);
    const ledger = confirmedLedgerFromClaim({ ...draft, worktreeId }, director);
    writeJSON(file, ledger);
    return { retrofitted: true, ledger };
  });
}

function latestForBinding(records, head, currentLedgerHash) {
  return [...records]
    .reverse()
    .find(
      (record) =>
        record.head === head && record.ledgerHash === currentLedgerHash,
    );
}

/**
 * Checks the requirements ledger's close-time completeness (A.3): every
 * user-visible criterion was presented and confirmed, the full statement and
 * criterion set was checked for fidelity and confirmed by the director, and
 * every unmet item has a matching item-scoped exception. Also checks that
 * every narrower criterion still carries a confirmation matching its current
 * text, so a `requirements-amend` that is never re-confirmed keeps blocking
 * close (the `narrowing-needs-confirmation` acceptance criterion).
 *
 * There is no `force` parameter: bypassing this check is only ever done by
 * calling `requirements-exception` for the exact item, never by a flag.
 *
 * @param {object} options - Check inputs.
 * @param {object} options.ledger - Confirmed ledger to check.
 * @param {string} options.head - Current result HEAD.
 * @param {string} options.ownerRoot - Directory presentation evidence is stored under: the
 *   organization file's own parent directory (`projectRoot(orgFile)`, i.e. `requirementsPresent`'s
 *   write target), not the director's checkout or any audit-response `ownerProject` repo.
 * @param {string[]} [options.registeredWorktreePaths] - Kickoff worktree paths evidence must not point into.
 * @returns {{ready: boolean}} Result when every check passes.
 * @throws {Error} On the first failing check, naming the item and reason.
 */
export function assertLedgerCloseReady({
  ledger,
  head,
  ownerRoot,
  registeredWorktreePaths = [],
}) {
  const currentLedgerHash = ledgerHash(ledger);

  for (const criterion of ledger.criteria.filter(
    (item) => item.scope === "narrower",
  )) {
    const confirmation = ledger.confirmations.find(
      (item) => item.criterionId === criterion.id,
    );
    assert(
      confirmation &&
        confirmation.textHash ===
          confirmationTextHash(criterion, ledger.statements),
      `Narrower criterion ${criterion.id} has no valid user confirmation for its current text`,
    );
    assertSubstantiveUserRecord(
      confirmation,
      `Confirmation for ${criterion.id}`,
    );
  }

  for (const criterion of ledger.criteria.filter((item) => item.userVisible)) {
    const presentation = latestForBinding(
      ledger.presentations.filter((item) => item.criterionId === criterion.id),
      head,
      currentLedgerHash,
    );
    if (presentation) {
      const resolved = inside(ownerRoot, presentation.evidence.ownerPath);
      assert(
        !registeredWorktreePaths.some(
          (worktreePath) =>
            resolved === path.resolve(worktreePath) ||
            resolved.startsWith(`${path.resolve(worktreePath)}${path.sep}`),
        ),
        `Presentation evidence for ${criterion.id} points into a kickoff worktree`,
      );
      assert(
        fileSha256(resolved) === presentation.evidence.sha256,
        `Presentation evidence for ${criterion.id} has changed since it was recorded`,
      );
      assertSubstantiveUserRecord(
        presentation,
        `Presentation for ${criterion.id}`,
      );
      assert(
        typeof presentation.channel === "string" &&
          presentation.channel.trim() &&
          typeof presentation.location === "string" &&
          presentation.location.trim(),
        `Presentation for ${criterion.id} is missing the channel/location it was shown through`,
      );
    }
    const exempt = ledger.exceptions.some(
      (exception) =>
        exception.ledgerHash === currentLedgerHash &&
        exception.head === head &&
        exception.scope.some(
          (item) => item.type === "criterion" && item.id === criterion.id,
        ),
    );
    assert(
      (presentation && presentation.outcome === "confirmed") || exempt,
      `User-visible criterion ${criterion.id} has no confirmed presentation at the current head/ledger and no matching exception`,
    );
  }

  const fidelity = latestForBinding(
    ledger.fidelityChecks,
    head,
    currentLedgerHash,
  );
  assert(
    fidelity && fidelity.directorConfirmedAt,
    "No director-confirmed fidelity check exists for the current head/ledger",
  );
  const expected = new Set([
    ...ledger.statements.map((statement) => `statement:${statement.id}`),
    ...ledger.criteria.map((criterion) => `criterion:${criterion.id}`),
  ]);
  const covered = new Set(
    fidelity.items.map((item) => `${item.type}:${item.id}`),
  );
  assert(
    covered.size === fidelity.items.length &&
      expected.size === covered.size &&
      [...expected].every((key) => covered.has(key)),
    "The confirmed fidelity check does not cover every current statement and criterion exactly once",
  );
  for (const item of fidelity.items) {
    if (item.status === "met") continue;
    const exempt = ledger.exceptions.some(
      (exception) =>
        exception.ledgerHash === currentLedgerHash &&
        exception.head === head &&
        exception.scope.some(
          (scoped) => scoped.type === item.type && scoped.id === item.id,
        ),
    );
    assert(
      exempt,
      `Unmet ${item.type} ${item.id} has no matching item-scoped exception at the current head/ledger`,
    );
  }
  return { ready: true };
}

/**
 * Checks that a kickoff's confirmed ledger exists at all — the compatibility
 * boundary from A.6: a kickoff registered before this feature has no
 * `requirements` entry and must be retrofitted or excepted before it closes.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree to check.
 * @returns {object} The confirmed ledger.
 * @throws {Error} When no confirmed ledger exists for the worktree.
 */
export function assertLedgerExists(orgFile, worktreeId) {
  const ledger = readLedger(orgFile, worktreeId);
  assert(
    ledger,
    `Worktree ${worktreeId} has no requirements ledger; run requirements-draft, then ` +
      "(for any narrower criterion, from the director's checkout) requirements-confirm --draft, " +
      "then requirements-retrofit before closing — requirements-exception records unmet items only " +
      "after a confirmed ledger exists, so it cannot substitute for the retrofit itself",
  );
  return ledger;
}

// Every workflow state stored under a kickoff's PM state directory. Fails
// closed like the auditor-independence check: a directory whose state cannot
// be read is refused rather than skipped, while a stray file (e.g. .DS_Store)
// is not a workflow and is ignored.
function readKickoffWorkflowStates(stateDir) {
  const root = path.join(stateDir, "workflows");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => fs.lstatSync(path.join(root, name)).isDirectory())
    .map((name) => {
      let state;
      try {
        state = readJSON(path.join(root, name, "state.json"));
        assert(
          state?.tasks !== null &&
            typeof state?.tasks === "object" &&
            !Array.isArray(state.tasks),
          "malformed state",
        );
      } catch (error) {
        throw new Error(
          `Workflow ${name} under ${stateDir} cannot be read (${error.message}), ` +
            "so this kickoff's result repository cannot be determined",
        );
      }
      return state;
    });
}

/**
 * Reads the result repository a kickoff's accepted workflows were closed
 * with, from its own `pm.stateDir`; the caller supplies no state to read.
 *
 * @param {object} entry - The kickoff's registry entry.
 * @returns {string|undefined} The recorded `decision.checkoutPath`, or `undefined` when no workflow of this kickoff has been accepted yet.
 * @throws {Error} When a state cannot be read, an accepted decision names no `checkoutPath` (it predates the binding), or accepted workflows name different ones.
 */
export function resolveKickoffResultRepo(entry) {
  const decided = readKickoffWorkflowStates(entry.pm.stateDir).filter(
    (state) => state.integration?.decision,
  );
  if (decided.length === 0) return undefined;
  const paths = decided.map((state) => state.integration.decision.checkoutPath);
  assert(
    paths.every((value) => typeof value === "string" && value),
    "An accepted workflow of this kickoff predates result-repository binding, " +
      "so its decision cannot name the repository an audit binds to; the director must decide how to close it",
  );
  assert(
    new Set(paths).size === 1,
    `Accepted workflows of this kickoff name different result repositories (${[...new Set(paths)].join(", ")})`,
  );
  return paths[0];
}

/**
 * Binds a consumer's `--repo` to the kickoff's result repository when its
 * pinned policy configures an auditor; otherwise returns `callerRepo`
 * unchanged. The caller's value is only compared with what recorded state
 * derives and is never a source of the repository (B.3).
 *
 * After acceptance the repository is the accepted workflows' `checkoutPath`.
 * Before acceptance, only an outcome objection may pass `allowPending`: the
 * caller's repository must be a candidate of a not-yet-accepted workflow (its
 * accepted tasks' worktrees, or, when integration is required and nothing is
 * recorded yet, any repository whose real HEAD the objection binding checks).
 * That is safe because an objection only blocks: it is lifted only by a
 * ruling, never by the repository it names.
 *
 * @param {object} entry - The kickoff's registry entry.
 * @param {string} [callerRepo] - Repository the caller named.
 * @param {object} [options] - Phase options.
 * @param {boolean} [options.allowPending=false] - Permit a caller repository before any workflow was accepted (outcome objection only).
 * @returns {string|undefined} Real path of the repository the binding must use.
 * @throws {Error} When the repository is undetermined, differs from the recorded one, or is not a pending candidate.
 */
export function bindKickoffResultRepo(
  entry,
  callerRepo,
  { allowPending = false } = {},
) {
  if (entry.auditPolicy?.auditorConfigured !== true) return callerRepo;
  const recorded = resolveKickoffResultRepo(entry);
  if (recorded !== undefined) {
    let caller;
    try {
      caller =
        callerRepo === undefined
          ? undefined
          : fs.realpathSync.native(path.resolve(callerRepo));
    } catch {
      caller = null;
    }
    assert(
      callerRepo === undefined || caller === recorded,
      `Repository ${callerRepo} is not the result repository this kickoff's workflow was accepted with (${recorded})`,
    );
    return recorded;
  }
  assert(
    allowPending,
    "No workflow of this kickoff has been accepted, so its result repository is not determined; " +
      "run workflow-accept first",
  );
  assert(
    callerRepo !== undefined,
    "A repository is required before any workflow of this kickoff is accepted",
  );
  // A workflow that ended blocked or failed never produces a result, so it
  // is not a candidate; retrying it puts it back among the live ones.
  const live = readKickoffWorkflowStates(entry.pm.stateDir).filter(
    (state) => !["blocked", "failed"].includes(state.status),
  );
  for (const state of live) {
    try {
      return resolveResultRepo(state, callerRepo);
    } catch {
      // Not this workflow's candidate; try the next.
    }
  }
  throw new Error(
    `Repository ${callerRepo} is not a candidate result repository of any live workflow of this kickoff`,
  );
}

/**
 * Runs every check A.5 requires before a kickoff may close: the ledger's
 * close-time completeness (`assertLedgerCloseReady`) and, when this kickoff's
 * pinned `auditPolicy` calls for an auditor, that both the brief and outcome
 * checkpoints still carry a valid acceptance (B.5). This is the single call
 * `checkCloseReady`, `deliverKickoff` and `kickoff-release --reason completed`
 * each run unconditionally in their own function body; it takes no `force`
 * parameter, so none of the three can be asked to skip it.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree of the kickoff under audit.
 * @param {object} options - Check inputs.
 * @param {string} options.head - Result HEAD the kickoff is closing at.
 * @param {string} options.repo - Workspace `head` is checked against for the outcome acceptance binding.
 * @param {string[]} [options.registeredWorktreePaths] - Kickoff worktree paths evidence must not point into.
 * @param {object} [options.entry] - This kickoff's registry entry, required.
 *   Its `auditPolicy` (pinned at kickoff-claim, D1, or backfilled onto a
 *   legacy entry only through `kickoffAuditPolicyRetrofit`) decides whether
 *   an auditor is configured, not a fresh `organization.json` read, so
 *   removing `org.auditor` after claim cannot waive an audit this kickoff
 *   already took on. There is no live-read fallback: an entry with no
 *   `auditPolicy` refuses close outright, naming the retrofit command,
 *   rather than guessing a policy from the organization's current setting.
 * @returns {Promise<{ready: boolean}>} Result once every check passes.
 * @throws {Error} When no confirmed ledger exists, the ledger is not
 *   close-ready, this kickoff's `auditPolicy` was never pinned, or (with an
 *   auditor configured) either checkpoint's acceptance is missing or no
 *   longer valid.
 */
export async function assertKickoffCloseReady(
  orgFile,
  worktreeId,
  { head, repo, registeredWorktreePaths = [], entry },
) {
  const ledger = assertLedgerExists(orgFile, worktreeId);
  assertLedgerCloseReady({
    ledger,
    head,
    ownerRoot: projectRoot(orgFile),
    registeredWorktreePaths,
  });
  assert(
    entry?.auditPolicy !== undefined,
    `Kickoff ${worktreeId} has no pinned audit policy; the director must run ` +
      "kickoff-audit-policy-retrofit for this worktree before it can close " +
      "(a live organization.json read is never used as a substitute)",
  );
  const auditorConfigured = entry.auditPolicy.auditorConfigured;
  if (!auditorConfigured) return { ready: true };
  assert(
    await hasValidAcceptance(orgFile, worktreeId, "brief"),
    "Brief audit acceptance is missing or no longer valid; " +
      "run audit-accept for the brief checkpoint before closing",
  );
  const resultRepo = bindKickoffResultRepo(entry, repo);
  assert(
    await hasValidAcceptance(orgFile, worktreeId, "outcome", head, resultRepo),
    "Outcome audit acceptance is missing or no longer valid; " +
      "run audit-accept for the outcome checkpoint before closing",
  );
  return { ready: true };
}
