/**
 * Auditor role: independent objection/response/ruling records at the brief
 * and outcome checkpoints of a kickoff's requirements ledger.
 *
 * See docs/plan/requirements-ledger-and-audit.md (section B). Identity for
 * every write is confirmed from runtime state (a launch ledger line, an Orca
 * Run binding, or the director's registered checkout), never from a caller
 * argument, so a PM or director cannot forge the auditor's records by copying
 * a handle string (B.6).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  assert,
  AUDITOR_ROLE,
  DIRECTOR_ROLE,
  fileSha256,
  hash,
  inside,
  readJSON,
  run,
  withFileLock,
  writeJSON,
} from "./core.mjs";
import { canonicalize, readReference } from "./contracts.mjs";
import { ledgerHash as computeLedgerHash, readLedger } from "./requirements.mjs";
import { listKickoffs, ownerProject } from "./kickoff-registry.mjs";
import { assertDirectorAuthority } from "./delivery.mjs";
import { readLaunches } from "./usage-ledger.mjs";
import { runOrcaJson } from "./orca-adapter.mjs";

/** Checkpoints a kickoff's requirements ledger is audited at. */
export const CHECKPOINTS = Object.freeze(["brief", "outcome"]);
const VERDICTS = ["persuaded", "not-persuaded"];
const OBJECTION_KINDS = ["mismatch", "gap", "overreach", "other"];

function canonicalHash(value) {
  return hash(canonicalize(value));
}

function auditFile(orgFile, worktreeId) {
  const digest = crypto.createHash("sha256").update(worktreeId).digest("hex");
  return path.join(
    path.dirname(path.resolve(orgFile)),
    "audits",
    `${digest}.json`,
  );
}

function withAudit(orgFile, worktreeId, callback) {
  const directory = path.join(path.dirname(path.resolve(orgFile)), "audits");
  fs.mkdirSync(directory, { recursive: true });
  return withFileLock(
    path.join(directory, ".lock"),
    () => callback(readAudit(orgFile, worktreeId)),
    "Audit record update in progress; read it again",
  );
}

function emptyCheckpoint() {
  return {
    binding: null,
    checked: [],
    objections: [],
    responses: [],
    rulings: [],
    acceptance: null,
    acceptanceHistory: [],
  };
}

/**
 * Reads (or lazily initializes) a kickoff's audit record.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree of the kickoff under audit.
 * @returns {object} Audit record with `brief` and `outcome` checkpoints.
 */
export function readAudit(orgFile, worktreeId) {
  const file = auditFile(orgFile, worktreeId);
  if (fs.existsSync(file)) return readJSON(file);
  return {
    schemaVersion: 1,
    worktreeId,
    checkpoints: { brief: emptyCheckpoint(), outcome: emptyCheckpoint() },
  };
}

function requireLedger(orgFile, worktreeId) {
  const ledger = readLedger(orgFile, worktreeId);
  assert(ledger, `Worktree ${worktreeId} has no confirmed requirements ledger`);
  return ledger;
}

function latestResponse(checkpointRecord, objectionId) {
  return [...checkpointRecord.responses]
    .filter((response) => response.objectionId === objectionId)
    .sort((a, b) => String(a.respondedAt).localeCompare(String(b.respondedAt)))
    .pop();
}

// Rulings are appended, never overwritten, so an objection's full history
// (e.g. a weak response ruled not-persuaded, then a stronger one ruled
// persuaded) stays on record; every consumer selects the latest by ruledAt.
function latestRuling(checkpointRecord, objectionId) {
  return [...checkpointRecord.rulings]
    .filter((ruling) => ruling.objectionId === objectionId)
    .sort((a, b) => String(a.ruledAt).localeCompare(String(b.ruledAt)))
    .pop();
}

/**
 * Computes the evidence fingerprint the outcome checkpoint binds to: the
 * fidelity draft's items, every presentation's evidence hash so far, and the
 * most recent response evidence for every outcome objection (sorted by
 * objection id). Always computed, never omitted (addendum 4, item 2) — an
 * empty ledger still hashes to a stable value, so evidence added later is
 * guaranteed to change it.
 *
 * @param {object} ledger - Confirmed requirements ledger.
 * @param {object} outcomeCheckpoint - `checkpoints.outcome` of the audit record.
 * @returns {string} Stable SHA-256 digest.
 */
export function evidenceFingerprint(ledger, outcomeCheckpoint) {
  const fidelityItems = ledger.fidelityChecks.at(-1)?.items ?? [];
  const presentationHashes = ledger.presentations
    .map((presentation) => presentation.evidence.sha256)
    .sort();
  const responseEvidence = [...outcomeCheckpoint.objections]
    .map((objection) => objection.id)
    .sort()
    .flatMap((objectionId) => {
      const response = latestResponse(outcomeCheckpoint, objectionId);
      return (response?.evidenceRefs ?? []).map((ref) => ref.sha256).sort();
    });
  return canonicalHash({ fidelityItems, presentationHashes, responseEvidence });
}

/**
 * Computes the binding a checkpoint's objections/responses/rulings apply to.
 *
 * @param {string} checkpoint - "brief" or "outcome".
 * @param {object} ledger - Confirmed requirements ledger.
 * @param {object} audit - Full audit record (for the outcome fingerprint).
 * @param {string} [resultHead] - Result HEAD; required for "outcome".
 * @returns {object} `{ledgerHash}` for brief, `{ledgerHash, resultHead, evidenceFingerprint}` for outcome.
 */
export function computeBinding(checkpoint, ledger, audit, resultHead) {
  const ledgerHashValue = computeLedgerHash(ledger);
  if (checkpoint === "brief") return { ledgerHash: ledgerHashValue };
  assert(
    typeof resultHead === "string" && resultHead.trim(),
    "resultHead is required to compute the outcome checkpoint binding",
  );
  return {
    ledgerHash: ledgerHashValue,
    resultHead,
    evidenceFingerprint: evidenceFingerprint(ledger, audit.checkpoints.outcome),
  };
}

/**
 * Confirms the caller is the auditor terminal Orca opened for this kickoff.
 *
 * Reads the caller's own `ORCA_TERMINAL_HANDLE`, which Orca injects only into
 * the terminal process it opens; a PM or director copying the auditor's
 * public handle into an argument has no such variable set to that value, so
 * this check cannot be satisfied by argument forgery (B.6).
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree of the kickoff under audit.
 * @param {NodeJS.ProcessEnv} [env] - Environment to read the handle from.
 * @returns {string} The confirmed auditor terminal handle.
 * @throws {Error} When the handle is unset or was not launched as this kickoff's auditor.
 */
export function verifiedAuditor(orgFile, worktreeId, env = process.env) {
  const callerHandle = env.ORCA_TERMINAL_HANDLE;
  assert(
    callerHandle,
    "ORCA_TERMINAL_HANDLE is not set, so the caller cannot be identified as the auditor",
  );
  const launch = readLaunches(orgFile).findLast(
    (line) =>
      line.via === "role-terminal" &&
      line.role === AUDITOR_ROLE &&
      line.terminal === callerHandle &&
      line.kickoffPmWorktreeId === worktreeId,
  );
  assert(
    launch,
    `Caller ${callerHandle} is not the auditor terminal launched for kickoff ${worktreeId}`,
  );
  return callerHandle;
}

/**
 * Confirms the caller is running from the kickoff's registered director
 * checkout, reusing the same authority check `deliver` and `kickoff-release`
 * already enforce.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree of the kickoff under audit.
 * @param {string} [callerCwd] - Caller's working directory.
 * @returns {object} The kickoff's registry entry.
 * @throws {Error} When the caller is not at the director's checkout.
 */
export function verifiedDirector(orgFile, worktreeId, callerCwd = process.cwd()) {
  const [entry] = listKickoffs(orgFile, worktreeId).kickoffs;
  assert(entry, `Worktree ${worktreeId} supervises no registered kickoff`);
  assertDirectorAuthority(entry, callerCwd, "audit-response (brief checkpoint)", false);
  return entry;
}

/**
 * Confirms the caller is the PM bound to this kickoff's Run, reusing the same
 * `orchestration run-current` binding `verifySupervisor` checks.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree of the kickoff under audit.
 * @param {object} options - Identity inputs.
 * @param {string} options.callerHandle - Caller's own terminal handle.
 * @param {string} [options.orca] - Orca CLI binary, for the injected `run`.
 * @param {Function} [options.execute] - Injectable command runner.
 * @returns {object} The kickoff's registry entry.
 * @throws {Error} When the caller is not bound to this kickoff's Run as PM.
 */
export async function verifiedPm(
  orgFile,
  worktreeId,
  { callerHandle, orca, execute = run },
) {
  assert(callerHandle, "callerHandle is required to confirm the PM's identity");
  const [entry] = listKickoffs(orgFile, worktreeId).kickoffs;
  assert(entry, `Worktree ${worktreeId} supervises no registered kickoff`);
  assert(entry.runId, `Kickoff ${worktreeId} has not bound a Run yet`);
  let bound = null;
  try {
    const current = await runOrcaJson(
      orca,
      ["orchestration", "run-current", "--from", callerHandle],
      { execute },
    );
    bound = current.result?.run ?? null;
  } catch {
    bound = null;
  }
  assert(
    bound && bound.coordinator_handle === callerHandle && bound.id === entry.runId,
    `Caller ${callerHandle} is not the PM bound to kickoff ${worktreeId}'s Run`,
  );
  return entry;
}

/**
 * Records an auditor's objection at a checkpoint. Recomputes and stores the
 * checkpoint's current binding: a changed binding (e.g. a new presentation
 * shifted the outcome evidence fingerprint) invalidates any existing
 * acceptance the next time it is checked (B.4 condition 5), which is how the
 * design avoids a separate invalidation step for addendum 4 item 1.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree of the kickoff under audit.
 * @param {object} request - Objection to record.
 * @param {string} request.checkpoint - "brief" or "outcome".
 * @param {{type: string, id: string}} request.target - Statement/criterion targeted.
 * @param {string} request.kind - One of OBJECTION_KINDS.
 * @param {string} request.description - What is wrong.
 * @param {string} request.rebuttalRequested - What would resolve it.
 * @param {string} [request.resultHead] - Result HEAD; required for "outcome".
 * @param {NodeJS.ProcessEnv} [env] - Environment the auditor identity is read from.
 * @returns {{recorded: boolean, audit: object}} Updated audit record.
 * @throws {Error} When identity fails or the request is malformed.
 */
export function auditObjection(
  orgFile,
  worktreeId,
  { checkpoint, target, kind, description, rebuttalRequested, resultHead },
  env = process.env,
) {
  assert(CHECKPOINTS.includes(checkpoint), `Unknown checkpoint: ${checkpoint}`);
  assert(
    target && ["statement", "criterion"].includes(target.type) && target.id,
    "Objection target must be a {type, id}",
  );
  assert(OBJECTION_KINDS.includes(kind), `Unknown objection kind: ${kind}`);
  for (const [name, value] of [
    ["description", description],
    ["rebuttalRequested", rebuttalRequested],
  ]) {
    assert(typeof value === "string" && value.trim(), `Objection ${name} required`);
  }
  verifiedAuditor(orgFile, worktreeId, env);
  const ledger = requireLedger(orgFile, worktreeId);
  return withAudit(orgFile, worktreeId, (audit) => {
    const record = audit.checkpoints[checkpoint];
    record.binding = computeBinding(checkpoint, ledger, audit, resultHead);
    record.objections = [
      ...record.objections,
      {
        id: crypto.randomUUID(),
        target,
        kind,
        description,
        rebuttalRequested,
        raisedAt: new Date().toISOString(),
      },
    ];
    const file = auditFile(orgFile, worktreeId);
    writeJSON(file, audit);
    return { recorded: true, audit };
  });
}

/**
 * Records a response to an objection. The responder's identity is confirmed
 * for the checkpoint's role: director for "brief", PM for "outcome" (B.2 of
 * addendum 2) — a lower role or the wrong side can never write this record.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree of the kickoff under audit.
 * @param {object} request - Response to record.
 * @param {string} request.checkpoint - "brief" or "outcome".
 * @param {string} request.objectionId - Objection being answered.
 * @param {string} request.argument - Substantive argument, not a bare claim of completion.
 * @param {{path: string, sha256: string}[]} request.evidenceRefs - Cited evidence.
 * @param {object} identity - Identity inputs for `verifiedDirector`/`verifiedPm`.
 * @returns {Promise<{recorded: boolean, audit: object}>} Updated audit record.
 * @throws {Error} When identity fails, the objection is unknown, or fields are missing.
 */
export async function auditResponse(
  orgFile,
  worktreeId,
  { checkpoint, objectionId, argument, evidenceRefs },
  identity = {},
) {
  assert(CHECKPOINTS.includes(checkpoint), `Unknown checkpoint: ${checkpoint}`);
  assert(typeof argument === "string" && argument.trim(), "Response argument required");
  assert(
    Array.isArray(evidenceRefs) &&
      evidenceRefs.length > 0 &&
      evidenceRefs.every(
        (ref) => ref && typeof ref.path === "string" && typeof ref.sha256 === "string",
      ),
    "Response evidenceRefs required: at least one {path, sha256}",
  );
  if (checkpoint === "brief") {
    verifiedDirector(orgFile, worktreeId, identity.callerCwd);
  } else {
    await verifiedPm(orgFile, worktreeId, identity);
  }
  return withAudit(orgFile, worktreeId, (audit) => {
    const record = audit.checkpoints[checkpoint];
    assert(
      record.objections.some((objection) => objection.id === objectionId),
      `Unknown objection: ${objectionId}`,
    );
    record.responses = [
      ...record.responses,
      {
        id: crypto.randomUUID(),
        objectionId,
        argument,
        evidenceRefs,
        respondedAt: new Date().toISOString(),
      },
    ];
    const file = auditFile(orgFile, worktreeId);
    writeJSON(file, audit);
    return { recorded: true, audit };
  });
}

/**
 * Records the auditor's ruling on an objection's most recent response.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree of the kickoff under audit.
 * @param {object} request - Ruling to record.
 * @param {string} request.checkpoint - "brief" or "outcome".
 * @param {string} request.objectionId - Objection being ruled on.
 * @param {string} request.respondedAgainst - Response id the ruling addresses; must be the latest.
 * @param {string} request.verdict - "persuaded" or "not-persuaded".
 * @param {string} request.reason - Why.
 * @param {NodeJS.ProcessEnv} [env] - Environment the auditor identity is read from.
 * @returns {{recorded: boolean, audit: object}} Updated audit record.
 * @throws {Error} When identity fails, or the ruling targets a stale response.
 */
export function auditRuling(
  orgFile,
  worktreeId,
  { checkpoint, objectionId, respondedAgainst, verdict, reason },
  env = process.env,
) {
  assert(CHECKPOINTS.includes(checkpoint), `Unknown checkpoint: ${checkpoint}`);
  assert(VERDICTS.includes(verdict), `Ruling verdict must be one of ${VERDICTS.join("/")}`);
  assert(typeof reason === "string" && reason.trim(), "Ruling reason required");
  verifiedAuditor(orgFile, worktreeId, env);
  return withAudit(orgFile, worktreeId, (audit) => {
    const record = audit.checkpoints[checkpoint];
    const latest = latestResponse(record, objectionId);
    assert(
      latest && latest.id === respondedAgainst,
      "Ruling must target the objection's most recent response",
    );
    // Appended, not replaced: a not-persuaded ruling on a weak response and a
    // later persuaded ruling on a stronger one must both stay on record.
    record.rulings = [
      ...record.rulings,
      {
        objectionId,
        respondedAgainst,
        verdict,
        reason,
        ruledAt: new Date().toISOString(),
      },
    ];
    const file = auditFile(orgFile, worktreeId);
    writeJSON(file, audit);
    return { recorded: true, audit };
  });
}

/**
 * Records the auditor's `checked` coverage for a checkpoint: every statement
 * and criterion the auditor actually compared against the user's original
 * words, not just the ones an objection was raised against.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree of the kickoff under audit.
 * @param {string} checkpoint - "brief" or "outcome".
 * @param {{type: string, id: string}[]} checked - Items checked.
 * @param {NodeJS.ProcessEnv} [env] - Environment the auditor identity is read from.
 * @returns {{recorded: boolean, audit: object}} Updated audit record.
 */
export function auditChecked(orgFile, worktreeId, checkpoint, checked, env = process.env) {
  assert(CHECKPOINTS.includes(checkpoint), `Unknown checkpoint: ${checkpoint}`);
  assert(
    Array.isArray(checked) &&
      checked.every(
        (item) => item && ["statement", "criterion"].includes(item.type) && item.id,
      ),
    "checked must be a {type, id} array",
  );
  verifiedAuditor(orgFile, worktreeId, env);
  return withAudit(orgFile, worktreeId, (audit) => {
    audit.checkpoints[checkpoint].checked = checked;
    const file = auditFile(orgFile, worktreeId);
    writeJSON(file, audit);
    return { recorded: true, audit };
  });
}

function checkedCovers(checked, ledger) {
  const expected = new Set([
    ...ledger.statements.map((statement) => `statement:${statement.id}`),
    ...ledger.criteria.map((criterion) => `criterion:${criterion.id}`),
  ]);
  const covered = new Set(checked.map((item) => `${item.type}:${item.id}`));
  return (
    covered.size === checked.length &&
    expected.size === covered.size &&
    [...expected].every((key) => covered.has(key))
  );
}

/**
 * Checks whether a checkpoint's current state qualifies for a NEW acceptance
 * to be recorded (B.4, conditions 1-6: checked coverage, every objection
 * persuaded on its latest response, and — for "outcome" — every cited
 * response evidence file still hashing to what was cited). Re-verifies
 * evidence from disk rather than trusting a stored value, so a file changed
 * after the fact is caught (addendum 4 item 2).
 *
 * This is deliberately silent about whether an EXISTING acceptance is still
 * current — that is `hasValidAcceptance`'s job. Conflating the two created a
 * re-acceptance deadlock: once a binding changed, the stale old acceptance
 * would itself count as a reason to refuse recording the very re-acceptance
 * meant to replace it. A consuming gate must call `hasValidAcceptance`, not
 * this function, to decide whether to trust an already-recorded acceptance.
 *
 * @param {object} options - Check inputs.
 * @param {object} options.audit - Full audit record.
 * @param {string} options.checkpoint - "brief" or "outcome".
 * @param {object} options.ledger - Confirmed requirements ledger.
 * @param {string} options.ownerRoot - Owner project root, for evidence containment.
 * @param {string} [options.resultHead] - Result HEAD; required for "outcome".
 * @returns {{accepted: boolean, currentBinding: object, reasons: string[]}} Result.
 */
export function auditAccepted({ audit, checkpoint, ledger, ownerRoot, resultHead }) {
  const record = audit.checkpoints[checkpoint];
  const reasons = [];
  if (!checkedCovers(record.checked, ledger)) {
    reasons.push("checked does not cover every current statement and criterion exactly once");
  }
  for (const objection of record.objections) {
    const latest = latestResponse(record, objection.id);
    const ruling = latestRuling(record, objection.id);
    if (!latest) {
      reasons.push(`Objection ${objection.id} has no response`);
      continue;
    }
    if (!ruling || ruling.respondedAgainst !== latest.id) {
      reasons.push(`Objection ${objection.id} has no ruling on its latest response`);
      continue;
    }
    if (ruling.verdict !== "persuaded") {
      reasons.push(`Objection ${objection.id} is unresolved (${ruling.verdict})`);
    }
    if (checkpoint === "outcome") {
      for (const ref of latest.evidenceRefs) {
        let actual;
        try {
          actual = fileSha256(inside(ownerRoot, ref.path));
        } catch (error) {
          reasons.push(`Objection ${objection.id} response evidence unreadable: ${error.message}`);
          continue;
        }
        if (actual !== ref.sha256) {
          reasons.push(`Objection ${objection.id} response evidence has changed since it was cited`);
        }
      }
    }
  }
  const currentBinding = computeBinding(checkpoint, ledger, audit, resultHead);
  return { accepted: reasons.length === 0, currentBinding, reasons };
}

/**
 * Records the auditor's acceptance of a checkpoint once every B.4 condition
 * holds.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree of the kickoff under audit.
 * @param {string} checkpoint - "brief" or "outcome".
 * @param {string} [resultHead] - Result HEAD; required for "outcome".
 * @param {NodeJS.ProcessEnv} [env] - Environment the auditor identity is read from.
 * @returns {{accepted: boolean, audit: object}} Updated audit record.
 * @throws {Error} When any B.4 condition fails, naming every reason.
 */
export function auditAccept(orgFile, worktreeId, checkpoint, resultHead, env = process.env) {
  assert(CHECKPOINTS.includes(checkpoint), `Unknown checkpoint: ${checkpoint}`);
  verifiedAuditor(orgFile, worktreeId, env);
  const ledger = requireLedger(orgFile, worktreeId);
  const ownerRoot = ownerProject(orgFile);
  return withAudit(orgFile, worktreeId, (audit) => {
    const check = auditAccepted({ audit, checkpoint, ledger, ownerRoot, resultHead });
    assert(check.accepted, `Checkpoint ${checkpoint} cannot be accepted: ${check.reasons.join("; ")}`);
    const record = audit.checkpoints[checkpoint];
    // A prior acceptance made stale by a later presentation or amendment
    // (path B) is superseded here, not discarded: it moves into history so
    // re-acceptance after re-audit leaves a full trail rather than erasing
    // the fact that an earlier acceptance existed and was invalidated.
    if (record.acceptance) {
      record.acceptanceHistory = [...record.acceptanceHistory, record.acceptance];
    }
    record.binding = check.currentBinding;
    record.acceptance = {
      acceptedAt: new Date().toISOString(),
      boundHash: canonicalHash(check.currentBinding),
    };
    const file = auditFile(orgFile, worktreeId);
    writeJSON(file, audit);
    return { accepted: true, audit };
  });
}

/**
 * Checks whether a checkpoint's RECORDED acceptance is still current, without
 * throwing — for use by A.5's hard-coded gate points, which need a plain
 * boolean rather than a thrown reason list. This is the only place that
 * compares a stored `acceptance.boundHash` against the freshly recomputed
 * binding; `auditAccept` never re-derives this from `auditAccepted`, which
 * avoids the re-acceptance deadlock a stale acceptance would otherwise cause.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree of the kickoff under audit.
 * @param {string} checkpoint - "brief" or "outcome".
 * @param {string} [resultHead] - Result HEAD; required for "outcome".
 * @returns {boolean} Whether the checkpoint currently has a valid acceptance.
 */
export function hasValidAcceptance(orgFile, worktreeId, checkpoint, resultHead) {
  const ledger = readLedger(orgFile, worktreeId);
  if (!ledger) return false;
  const audit = readAudit(orgFile, worktreeId);
  const record = audit.checkpoints[checkpoint];
  if (!record.acceptance) return false;
  const currentBinding = computeBinding(checkpoint, ledger, audit, resultHead);
  return record.acceptance.boundHash === canonicalHash(currentBinding);
}

/**
 * Checks whether a checkpoint has any unresolved objection (no ruling, or
 * the latest ruling is not-persuaded) — the narrower condition A.5/B.5 use at
 * PM `accept`, which must not require acceptance itself to exist yet
 * (addendum 4 item 4).
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree of the kickoff under audit.
 * @param {string} checkpoint - "brief" or "outcome".
 * @returns {boolean} Whether at least one objection is unresolved.
 */
export function hasUnresolvedObjections(orgFile, worktreeId, checkpoint) {
  const audit = readAudit(orgFile, worktreeId);
  const record = audit.checkpoints[checkpoint];
  return record.objections.some((objection) => {
    const latest = latestResponse(record, objection.id);
    const ruling = latestRuling(record, objection.id);
    return (
      !latest || !ruling || ruling.respondedAgainst !== latest.id || ruling.verdict !== "persuaded"
    );
  });
}
