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

const SCOPES = ["equal", "narrower"];
const FIDELITY_STATUSES = ["met", "unmet"];
const PRESENTATION_OUTCOMES = ["confirmed", "rejected"];

function canonicalHash(value) {
  return hash(canonicalize(value));
}

function projectRoot(orgFile) {
  return path.dirname(path.resolve(orgFile));
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
    new Set(criteria.map((criterion) => criterion.id)).size ===
      criteria.length,
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
export function requirementsDraft(orgFile, { worktreeId, statements, criteria }) {
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
 * Validates a claim's embedded requirements draft against the claim's own
 * declared director, closing the A.2 deadlock without any registry lookup.
 *
 * @param {object} requirements - The `requirements` block of a kickoff claim.
 * @param {{checkoutPath: string}} director - The claim's declared director.
 * @returns {object} The same `requirements` object, once every check passes.
 * @throws {Error} When statements/criteria are empty, a narrower criterion
 *   lacks a matching confirmation, or the confirmation was recorded from a
 *   checkout other than the claim's declared director.
 */
export function validateLedgerForClaim(requirements, director) {
  assert(
    requirements && typeof requirements === "object",
    "Claim requirements ledger required",
  );
  const { statements, criteria, confirmations = [] } = requirements;
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
    director && typeof director.checkoutPath === "string" && director.checkoutPath.trim(),
    "Claim director.checkoutPath is required to validate the requirements ledger",
  );
  const directorPath = path.resolve(director.checkoutPath);
  for (const criterion of criteria.filter((item) => item.scope === "narrower")) {
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
  }
  return requirements;
}

/**
 * Builds the confirmed ledger record written when a claim is registered.
 *
 * @param {object} requirements - Validated `requirements` block of a claim.
 * @returns {object} Confirmed ledger, with empty presentations/fidelityChecks/exceptions.
 */
export function confirmedLedgerFromClaim(requirements) {
  return {
    schemaVersion: 1,
    worktreeId: requirements.worktreeId,
    statements: requirements.statements,
    criteria: requirements.criteria,
    confirmations: requirements.confirmations ?? [],
    presentations: [],
    fidelityChecks: [],
    exceptions: [],
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
 * @param {{statements: object[], criteria: object[]}} amendment - New statements/criteria.
 * @returns {{amended: boolean, ledger: object, ledgerHash: string}} Updated ledger.
 * @throws {Error} When no confirmed ledger exists yet, or the amendment is malformed.
 */
export function requirementsAmend(orgFile, worktreeId, { statements, criteria }) {
  validateStatements(statements);
  validateCriteria(criteria, statements);
  return withLedgers(orgFile, () => {
    const file = ledgerFile(orgFile, worktreeId);
    assert(fs.existsSync(file), `No confirmed ledger for worktree ${worktreeId}`);
    const ledger = { ...readJSON(file), statements, criteria };
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
 * @param {{criterionId: string, userQuote: string}} request - Confirmation to record.
 * @returns {{confirmed: boolean, ledger: object}} Updated ledger.
 * @throws {Error} When the ledger or criterion is missing, or the criterion is not narrower.
 */
export function requirementsConfirm(orgFile, worktreeId, { criterionId, userQuote }) {
  assert(
    typeof userQuote === "string" && userQuote.trim(),
    "userQuote is required for a narrower criterion confirmation",
  );
  return withLedgers(orgFile, () => {
    const file = ledgerFile(orgFile, worktreeId);
    assert(fs.existsSync(file), `No confirmed ledger for worktree ${worktreeId}`);
    const ledger = readJSON(file);
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
      ...ledger.confirmations.filter((item) => item.criterionId !== criterionId),
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
 * @param {string} request.userQuote - What the user said in response.
 * @param {string} request.outcome - "confirmed" or "rejected".
 * @returns {Promise<{presented: boolean, ledger: object}>} Updated ledger.
 * @throws {Error} When the criterion is unknown, evidence cannot be read, fields are missing,
 *   or `head` does not match the workspace's actual Git HEAD.
 */
export async function requirementsPresent(
  orgFile,
  worktreeId,
  { criterionId, head, repo, source, userQuote, outcome },
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
    assert(fs.existsSync(file), `No confirmed ledger for worktree ${worktreeId}`);
    const ledger = readJSON(file);
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
export async function requirementsFidelity(orgFile, worktreeId, { head, repo, recordedBy, items }) {
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
    assert(fs.existsSync(file), `No confirmed ledger for worktree ${worktreeId}`);
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
 * @returns {{confirmed: boolean, ledger: object}} Updated ledger.
 * @throws {Error} When no fidelity check has been recorded yet.
 */
export function requirementsFidelityConfirm(orgFile, worktreeId) {
  return withLedgers(orgFile, () => {
    const file = ledgerFile(orgFile, worktreeId);
    assert(fs.existsSync(file), `No confirmed ledger for worktree ${worktreeId}`);
    const ledger = readJSON(file);
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
 * @param {string} request.reason - Why the item cannot be met.
 * @param {string} request.userQuote - The user's own words accepting the gap.
 * @param {string} request.unmetFacts - What is actually true instead.
 * @returns {{recorded: boolean, ledger: object}} Updated ledger.
 * @throws {Error} When the scope is empty, names unknown items, or fields are missing.
 */
export function requirementsException(
  orgFile,
  worktreeId,
  { scope, head, reason, userQuote, unmetFacts },
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
  return withLedgers(orgFile, () => {
    const file = ledgerFile(orgFile, worktreeId);
    assert(fs.existsSync(file), `No confirmed ledger for worktree ${worktreeId}`);
    const ledger = readJSON(file);
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
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree the retrofit applies to.
 * @param {{statements: object[], criteria: object[], confirmations: object[]}} draft - Reconstructed ledger content.
 * @param {{checkoutPath: string}} director - The kickoff's registered director.
 * @returns {{retrofitted: boolean, ledger: object}} Written ledger.
 * @throws {Error} When a confirmed ledger already exists, or validation fails.
 */
export function requirementsRetrofit(orgFile, worktreeId, draft, director) {
  return withLedgers(orgFile, () => {
    const file = ledgerFile(orgFile, worktreeId);
    assert(
      !fs.existsSync(file),
      `Worktree ${worktreeId} already has a confirmed ledger`,
    );
    validateLedgerForClaim({ ...draft, worktreeId }, director);
    const ledger = confirmedLedgerFromClaim({ ...draft, worktreeId });
    writeJSON(file, ledger);
    return { retrofitted: true, ledger };
  });
}

function latestForBinding(records, head, currentLedgerHash) {
  return [...records]
    .reverse()
    .find((record) => record.head === head && record.ledgerHash === currentLedgerHash);
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
 * @param {string} options.ownerRoot - Owner project root, for evidence containment.
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
        confirmation.textHash === confirmationTextHash(criterion, ledger.statements),
      `Narrower criterion ${criterion.id} has no valid user confirmation for its current text`,
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

  const fidelity = latestForBinding(ledger.fidelityChecks, head, currentLedgerHash);
  assert(
    fidelity && fidelity.directorConfirmedAt,
    "No director-confirmed fidelity check exists for the current head/ledger",
  );
  const expected = new Set([
    ...ledger.statements.map((statement) => `statement:${statement.id}`),
    ...ledger.criteria.map((criterion) => `criterion:${criterion.id}`),
  ]);
  const covered = new Set(fidelity.items.map((item) => `${item.type}:${item.id}`));
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
    `Worktree ${worktreeId} has no requirements ledger; run requirements-retrofit ` +
      "or record item-scoped requirements-exception records before closing",
  );
  return ledger;
}
