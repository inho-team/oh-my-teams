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
  withAsyncFileLock,
  writeJSON,
} from "./core.mjs";
import { canonicalize, readReference } from "./contracts.mjs";
import {
  ledgerHash as computeLedgerHash,
  readLedger,
} from "./requirements.mjs";
import { listKickoffs, ownerProject } from "./kickoff-registry.mjs";
import { assertDirectorAuthority } from "./delivery.mjs";
import { readLaunches } from "./usage-ledger.mjs";
import { runTrustedOrcaJson } from "./orca-adapter.mjs";
import { workspaceBinding } from "./evidence.mjs";

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
  return withAsyncFileLock(
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
 * For "outcome", `resultHead` is not trusted as given: it must match the
 * actual current Git HEAD of `repo`, read through the same
 * `evidence.mjs#workspaceBinding` adapter `fingerprint()` uses. Without this,
 * a caller could bind (and later re-validate) an outcome checkpoint against a
 * stale or fabricated head that no longer describes the real workspace.
 *
 * @param {string} checkpoint - "brief" or "outcome".
 * @param {object} ledger - Confirmed requirements ledger.
 * @param {object} audit - Full audit record (for the outcome fingerprint).
 * @param {string} [resultHead] - Result HEAD; required for "outcome".
 * @param {string} [repo] - Workspace `resultHead` is checked against; required for "outcome".
 * @returns {Promise<object>} `{ledgerHash}` for brief, `{ledgerHash, resultHead, evidenceFingerprint}` for outcome.
 * @throws {Error} When `resultHead` does not match the workspace's actual HEAD.
 */
export async function computeBinding(
  checkpoint,
  ledger,
  audit,
  resultHead,
  repo,
) {
  const ledgerHashValue = computeLedgerHash(ledger);
  if (checkpoint === "brief") return { ledgerHash: ledgerHashValue };
  assert(
    typeof resultHead === "string" && resultHead.trim(),
    "resultHead is required to compute the outcome checkpoint binding",
  );
  assert(
    typeof repo === "string" && repo.trim(),
    "repo is required to verify resultHead against the workspace's actual HEAD",
  );
  const { head: actualHead } = await workspaceBinding(repo);
  assert(
    actualHead && actualHead === resultHead,
    `Declared resultHead ${resultHead} does not match the actual Git HEAD ` +
      `${actualHead ?? "(not a Git workspace)"} of ${repo}; ` +
      "a stale or forged head cannot bind an outcome checkpoint",
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
 * It does not close environment forgery: a process sharing this OS user
 * account can still start a child with `ORCA_TERMINAL_HANDLE` set to the
 * auditor's handle and pass this check. Binding the handle to the process
 * lineage that actually launched it is what B.6's design is meant to add;
 * until it lands, this remains an open gap.
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
export function verifiedDirector(
  orgFile,
  worktreeId,
  callerCwd = process.cwd(),
) {
  const [entry] = listKickoffs(orgFile, worktreeId).kickoffs;
  assert(entry, `Worktree ${worktreeId} supervises no registered kickoff`);
  assertDirectorAuthority(
    entry,
    callerCwd,
    "audit-response (brief checkpoint)",
    false,
  );
  return entry;
}

/**
 * Judges whether a `run-current` result binds the caller as PM of the given
 * Run, without performing any I/O. Kept separate from `verifiedPm` so this
 * substantive judgment can be fixture-tested directly, and so `verifiedPm`
 * carries no injection point through which a caller could substitute a
 * fabricated `bound` value for the one `runTrustedOrcaJson` actually
 * produced.
 *
 * @param {object | null} bound - `result.run` from a `run-current` response, or `null`.
 * @param {string} callerHandle - The caller's own `ORCA_TERMINAL_HANDLE`.
 * @param {string} runId - The kickoff's registered Run id.
 * @returns {boolean} Whether `bound` names this caller as this Run's PM.
 */
export function isPmBoundToRun(bound, callerHandle, runId) {
  return Boolean(
    bound && bound.coordinator_handle === callerHandle && bound.id === runId,
  );
}

/**
 * Confirms the caller is the PM bound to this kickoff's Run, reusing the same
 * `orchestration run-current` binding `verifySupervisor` checks.
 *
 * The caller's identity is read from its own `ORCA_TERMINAL_HANDLE`, exactly
 * as `verifiedAuditor` does, so a CLI argument (e.g. --terminal) can never
 * substitute for it. This function takes no executable, execute, or factory
 * option: the binding check always runs through `runTrustedOrcaJson`, which
 * validates and then directly runs the fixed, per-platform trusted script
 * (`resolveTrustedOrcaScriptPath`) with a pinned interpreter and an
 * allowlisted child environment. A CLI argument (e.g. --orca),
 * `ORCA_CLI_COMMAND`, `ORCA_DEV_REPO_ROOT`, and PATH play no part in choosing
 * either the script or what it reads once running (B.6, decision B). Nothing
 * here is overridable: unlike the prior revision, a caller importing this
 * module directly (rather than going through the CLI) has no option to pass
 * that would substitute a forged executable, runner, or `run-current` result
 * for the real one, since none of those inputs are accepted at all.
 *
 * What this closes is the caller's ability to redirect, through an argument,
 * `PATH`, or an inherited environment variable, which executable answers this
 * binding check or what that executable reads while doing so. What this does
 * not close: `ORCA_TERMINAL_HANDLE` itself is still read from the
 * environment, so a caller sharing this OS user account can still set it to a
 * value of their choosing and pass this check, and the trusted script's own
 * integrity (its app bundle is owned by the same OS user, no code-signature
 * check is performed) is not verified. Binding the handle to the process
 * lineage that actually launched it is what B.6's design is meant to add
 * next; until it lands this remains an open gap.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree of the kickoff under audit.
 * @param {NodeJS.ProcessEnv} [env] - Environment to read the handle from.
 * @returns {Promise<object>} The kickoff's registry entry.
 * @throws {Error} When the caller is not bound to this kickoff's Run as PM.
 */
export async function verifiedPm(orgFile, worktreeId, env = process.env) {
  const callerHandle = env.ORCA_TERMINAL_HANDLE;
  assert(
    callerHandle,
    "ORCA_TERMINAL_HANDLE is not set, so the caller cannot be identified as the PM",
  );
  const [entry] = listKickoffs(orgFile, worktreeId).kickoffs;
  assert(entry, `Worktree ${worktreeId} supervises no registered kickoff`);
  assert(entry.runId, `Kickoff ${worktreeId} has not bound a Run yet`);
  let bound = null;
  try {
    const current = await runTrustedOrcaJson([
      "orchestration",
      "run-current",
      "--from",
      callerHandle,
    ]);
    bound = current.result?.run ?? null;
  } catch {
    bound = null;
  }
  assert(
    isPmBoundToRun(bound, callerHandle, entry.runId),
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
 * @param {string} [request.repo] - Workspace `resultHead` is checked against; required for "outcome".
 * @param {NodeJS.ProcessEnv} [env] - Environment the auditor identity is read from.
 * @returns {Promise<{recorded: boolean, audit: object}>} Updated audit record.
 * @throws {Error} When identity fails or the request is malformed.
 */
export async function auditObjection(
  orgFile,
  worktreeId,
  {
    checkpoint,
    target,
    kind,
    description,
    rebuttalRequested,
    resultHead,
    repo,
  },
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
    assert(
      typeof value === "string" && value.trim(),
      `Objection ${name} required`,
    );
  }
  verifiedAuditor(orgFile, worktreeId, env);
  const ledger = requireLedger(orgFile, worktreeId);
  return withAudit(orgFile, worktreeId, async (audit) => {
    const record = audit.checkpoints[checkpoint];
    record.binding = await computeBinding(
      checkpoint,
      ledger,
      audit,
      resultHead,
      repo,
    );
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
 * @param {object} [identity] - Non-identity inputs for `verifiedDirector`
 *   (`callerCwd` for the director path). Any other field, such as an
 *   `orca`/`execute` override, is ignored: `verifiedPm`, used for the
 *   "outcome" checkpoint, accepts no such override, so a caller cannot
 *   substitute a forged executable, runner, or `run-current` result here.
 * @param {NodeJS.ProcessEnv} [env] - Environment the PM identity is read from.
 * @returns {Promise<{recorded: boolean, audit: object}>} Updated audit record.
 * @throws {Error} When identity fails, the objection is unknown, or fields are missing.
 */
export async function auditResponse(
  orgFile,
  worktreeId,
  { checkpoint, objectionId, argument, evidenceRefs },
  identity = {},
  env = process.env,
) {
  assert(CHECKPOINTS.includes(checkpoint), `Unknown checkpoint: ${checkpoint}`);
  assert(
    typeof argument === "string" && argument.trim(),
    "Response argument required",
  );
  assert(
    Array.isArray(evidenceRefs) &&
      evidenceRefs.length > 0 &&
      evidenceRefs.every(
        (ref) =>
          ref && typeof ref.path === "string" && typeof ref.sha256 === "string",
      ),
    "Response evidenceRefs required: at least one {path, sha256}",
  );
  if (checkpoint === "brief") {
    verifiedDirector(orgFile, worktreeId, identity.callerCwd);
  } else {
    await verifiedPm(orgFile, worktreeId, env);
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
 * @returns {Promise<{recorded: boolean, audit: object}>} Updated audit record.
 * @throws {Error} When identity fails, or the ruling targets a stale response.
 */
export async function auditRuling(
  orgFile,
  worktreeId,
  { checkpoint, objectionId, respondedAgainst, verdict, reason },
  env = process.env,
) {
  assert(CHECKPOINTS.includes(checkpoint), `Unknown checkpoint: ${checkpoint}`);
  assert(
    VERDICTS.includes(verdict),
    `Ruling verdict must be one of ${VERDICTS.join("/")}`,
  );
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
 * @returns {Promise<{recorded: boolean, audit: object}>} Updated audit record.
 */
export async function auditChecked(
  orgFile,
  worktreeId,
  checkpoint,
  checked,
  env = process.env,
) {
  assert(CHECKPOINTS.includes(checkpoint), `Unknown checkpoint: ${checkpoint}`);
  assert(
    Array.isArray(checked) &&
      checked.every(
        (item) =>
          item && ["statement", "criterion"].includes(item.type) && item.id,
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

// The B.4 substantive conditions (1-6): checked coverage, every objection
// persuaded on its latest response, and — for "outcome" — every cited
// response evidence file still hashing to what was cited. Re-verifies
// evidence from disk rather than trusting a stored value, so a file changed
// after the fact is caught (addendum 4 item 2). Shared by `auditAccepted`
// (deciding whether a NEW acceptance may be recorded) and
// `hasValidAcceptance` (deciding whether an EXISTING one is still
// trustworthy) — both need the same substantive re-check; only the latter
// also compares against a stored acceptance.
function checkpointSubstantiveReasons(record, ledger, ownerRoot, checkpoint) {
  const reasons = [];
  if (!checkedCovers(record.checked, ledger)) {
    reasons.push(
      "checked does not cover every current statement and criterion exactly once",
    );
  }
  for (const objection of record.objections) {
    const latest = latestResponse(record, objection.id);
    const ruling = latestRuling(record, objection.id);
    if (!latest) {
      reasons.push(`Objection ${objection.id} has no response`);
      continue;
    }
    if (!ruling || ruling.respondedAgainst !== latest.id) {
      reasons.push(
        `Objection ${objection.id} has no ruling on its latest response`,
      );
      continue;
    }
    if (ruling.verdict !== "persuaded") {
      reasons.push(
        `Objection ${objection.id} is unresolved (${ruling.verdict})`,
      );
    }
    if (checkpoint === "outcome") {
      for (const ref of latest.evidenceRefs) {
        let actual;
        try {
          actual = fileSha256(inside(ownerRoot, ref.path));
        } catch (error) {
          reasons.push(
            `Objection ${objection.id} response evidence unreadable: ${error.message}`,
          );
          continue;
        }
        if (actual !== ref.sha256) {
          reasons.push(
            `Objection ${objection.id} response evidence has changed since it was cited`,
          );
        }
      }
    }
  }
  return reasons;
}

/**
 * Checks whether a checkpoint's current state qualifies for a NEW acceptance
 * to be recorded (B.4, conditions 1-6).
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
 * @param {string} [options.repo] - Workspace `resultHead` is checked against; required for "outcome".
 * @returns {Promise<{accepted: boolean, currentBinding: object, reasons: string[]}>} Result.
 */
export async function auditAccepted({
  audit,
  checkpoint,
  ledger,
  ownerRoot,
  resultHead,
  repo,
}) {
  const record = audit.checkpoints[checkpoint];
  const reasons = checkpointSubstantiveReasons(
    record,
    ledger,
    ownerRoot,
    checkpoint,
  );
  const currentBinding = await computeBinding(
    checkpoint,
    ledger,
    audit,
    resultHead,
    repo,
  );
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
 * @param {string} [repo] - Workspace `resultHead` is checked against; required for "outcome".
 * @param {NodeJS.ProcessEnv} [env] - Environment the auditor identity is read from.
 * @returns {Promise<{accepted: boolean, audit: object}>} Updated audit record.
 * @throws {Error} When any B.4 condition fails, naming every reason.
 */
export async function auditAccept(
  orgFile,
  worktreeId,
  checkpoint,
  resultHead,
  repo,
  env = process.env,
) {
  assert(CHECKPOINTS.includes(checkpoint), `Unknown checkpoint: ${checkpoint}`);
  verifiedAuditor(orgFile, worktreeId, env);
  const ledger = requireLedger(orgFile, worktreeId);
  const ownerRoot = ownerProject(orgFile);
  return withAudit(orgFile, worktreeId, async (audit) => {
    const check = await auditAccepted({
      audit,
      checkpoint,
      ledger,
      ownerRoot,
      resultHead,
      repo,
    });
    assert(
      check.accepted,
      `Checkpoint ${checkpoint} cannot be accepted: ${check.reasons.join("; ")}`,
    );
    const record = audit.checkpoints[checkpoint];
    // A prior acceptance made stale by a later presentation or amendment
    // (path B) is superseded here, not discarded: it moves into history so
    // re-acceptance after re-audit leaves a full trail rather than erasing
    // the fact that an earlier acceptance existed and was invalidated.
    if (record.acceptance) {
      record.acceptanceHistory = [
        ...record.acceptanceHistory,
        record.acceptance,
      ];
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
 * boolean rather than a thrown reason list.
 *
 * Two things must both hold: the stored acceptance's `boundHash` must still
 * match the freshly recomputed binding (an outcome's evidence fingerprint or
 * a criterion's ledger hash moved since it was accepted), and the checkpoint
 * must still pass the same B.4 substantive conditions `auditAccepted` checks
 * before recording a new acceptance — otherwise an acceptance stays "valid"
 * by binding alone even after its response evidence file was swapped for a
 * different one at the same path, or after a new unresolved objection was
 * raised without touching the binding. This is the only place that compares
 * a stored `acceptance.boundHash` against the freshly recomputed binding;
 * `auditAccept` never re-derives this from `auditAccepted`, which avoids the
 * re-acceptance deadlock a stale acceptance would otherwise cause.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree of the kickoff under audit.
 * @param {string} checkpoint - "brief" or "outcome".
 * @param {string} [resultHead] - Result HEAD; required for "outcome".
 * @param {string} [repo] - Workspace `resultHead` is checked against; required for "outcome".
 * @returns {Promise<boolean>} Whether the checkpoint currently has a valid acceptance.
 */
export async function hasValidAcceptance(
  orgFile,
  worktreeId,
  checkpoint,
  resultHead,
  repo,
) {
  const ledger = readLedger(orgFile, worktreeId);
  if (!ledger) return false;
  const audit = readAudit(orgFile, worktreeId);
  const record = audit.checkpoints[checkpoint];
  if (!record.acceptance) return false;
  const ownerRoot = ownerProject(orgFile);
  const reasons = checkpointSubstantiveReasons(
    record,
    ledger,
    ownerRoot,
    checkpoint,
  );
  if (reasons.length > 0) return false;
  let currentBinding;
  try {
    currentBinding = await computeBinding(
      checkpoint,
      ledger,
      audit,
      resultHead,
      repo,
    );
  } catch {
    // A stale or forged resultHead must make an existing acceptance invalid,
    // not throw — this is the plain-boolean gate contract callers rely on.
    return false;
  }
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
      !latest ||
      !ruling ||
      ruling.respondedAgainst !== latest.id ||
      ruling.verdict !== "persuaded"
    );
  });
}
