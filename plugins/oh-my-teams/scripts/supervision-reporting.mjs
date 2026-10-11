/**
 * Durable, evidence-conservative supervision reporting for one Orca Dispatch.
 * @module supervision-reporting
 */
import fs from "node:fs";
import path from "node:path";
import { readJSON, withFileLock, writeJSON } from "./core.mjs";
import { nextSupervisionAction } from "./status.mjs";

const REPORTING_DIRECTORY = "supervision-reporting";
const DELAYED_REPORT_STATES = new Set(["queued", "stored", "submitted"]);

/**
 * Returns the durable record path for a dispatch without using its text as a
 * path segment. Orca dispatch IDs are opaque identifiers, not filenames.
 *
 * @param {string} stateDir - Registered kickoff state directory.
 * @param {string} dispatchId - Orca Dispatch identity.
 * @returns {string} Exact record path.
 */
export function supervisionReportFile(stateDir, dispatchId) {
  if (typeof dispatchId !== "string" || !/^[A-Za-z0-9_-]+$/.test(dispatchId))
    throw new Error(
      "Supervision Dispatch id must be an opaque safe identifier",
    );
  return path.join(
    path.resolve(stateDir),
    REPORTING_DIRECTORY,
    `${dispatchId}.json`,
  );
}

/**
 * Reads a report written by {@link recordSupervisionObservation}.
 *
 * @param {string} stateDir - Registered kickoff state directory.
 * @param {string} dispatchId - Orca Dispatch identity.
 * @returns {object|null} Existing record, or null when the dispatch was not watched yet.
 */
export function readSupervisionReport(stateDir, dispatchId) {
  const file = supervisionReportFile(stateDir, dispatchId);
  return fs.existsSync(file) ? readJSON(file) : null;
}

/**
 * Lists a kickoff's stored supervision records without interpreting delivery
 * as recipient handling. Invalid partial files are ignored as unavailable
 * observation rather than treated as an all-clear.
 *
 * @param {string} stateDir - Registered kickoff state directory.
 * @returns {object[]} Durable records sorted by Dispatch id.
 */
export function listSupervisionReports(stateDir) {
  const directory = path.join(path.resolve(stateDir), REPORTING_DIRECTORY);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      try {
        return [readJSON(path.join(directory, name))];
      } catch {
        return [];
      }
    });
}

function validDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function evidenceObject(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.kind === "string" &&
    value.kind.trim() &&
    typeof value.key === "string" &&
    value.key.trim()
  );
}

function confirmedActionReceipt(observation, previous, nowMs) {
  const receipt = observation.actionReceipt;
  if (
    !receipt ||
    !["ask-progress", "inspect"].includes(receipt.action) ||
    receipt.status !== "performed" ||
    !validDate(receipt.at) ||
    Date.parse(receipt.at) > nowMs ||
    typeof receipt.id !== "string" ||
    !receipt.id.trim() ||
    !evidenceObject(receipt.evidence) ||
    previous?.actionReceiptIds?.includes(receipt.id)
  )
    return null;
  return receipt;
}

function handledDecision(observation) {
  const resolution = observation.pendingDecisionResolution;
  return (
    resolution?.status === "handled" &&
    validDate(resolution.at) &&
    evidenceObject(resolution.evidence)
  );
}

function reportDelay(observation, nowMs, policy) {
  const report = observation.report;
  const pendingAt = report?.pendingAt ?? observation.reportPendingAt;
  if (!DELAYED_REPORT_STATES.has(report?.state) || !validDate(pendingAt))
    return false;
  return nowMs - Date.parse(pendingAt) >= policy.progressCheckMs;
}

function decisionOwner(reason) {
  if (reason === "supervisor-absent")
    return {
      nextOwner: "director",
      nextAction: "restore-or-assign-a-supervisor-before-resuming-observation",
    };
  if (reason === "report-delayed")
    return {
      nextOwner: "pm",
      nextAction: "send-an-evidence-backed-report-or-escalate-the-blocker",
    };
  if (reason === "provider-overloaded")
    return {
      nextOwner: "pm",
      nextAction: "classify-provider-failure-without-retrying-or-taking-over",
    };
  return {
    nextOwner: "pm",
    nextAction:
      "inspect-the-official-Orca-observation-and-decide-the-next-step",
  };
}

function reportDecision({ observation, previous, policy }) {
  const now = observation.now ?? new Date().toISOString();
  const nowMs = new Date(now).getTime();
  if (Number.isNaN(nowMs)) throw new Error(`Invalid now: ${now}`);
  const evidence = observation.semanticProgressEvidence;
  const provenProgress =
    validDate(observation.semanticProgressAt) &&
    Date.parse(observation.semanticProgressAt) <= nowMs &&
    evidenceObject(evidence);
  const observedProgressAt = provenProgress
    ? observation.semanticProgressAt
    : null;
  const progressAdvanced =
    observedProgressAt &&
    (!previous?.lastProvenProgress?.at ||
      Date.parse(observedProgressAt) >
        Date.parse(previous.lastProvenProgress.at));
  const prior = progressAdvanced ? null : previous;
  const receipt = confirmedActionReceipt(observation, previous, nowMs);
  const unansweredRequests =
    (prior?.unansweredRequests ?? observation.unansweredRequests ?? 0) +
    Number(receipt?.action === "ask-progress");
  const inspections =
    (prior?.inspections ?? observation.inspections ?? 0) +
    Number(receipt?.action === "inspect");
  // A new observation can be unknown while the last verified artifact remains
  // relevant to the stall clock. It is not a new progress event and therefore
  // cannot clear an escalation cycle by itself.
  const semanticProgressAt =
    observedProgressAt ?? prior?.lastProvenProgress?.at ?? null;
  const base = {
    ...observation,
    // State-backed calls never silently fall back to output, heartbeat, or
    // lastActivityAt. A legacy caller that needs that behavior still calls the
    // compatibility function in status.mjs directly.
    semanticProgressAt,
    unansweredRequests,
    inspections,
    escalatedAt: prior?.escalation?.at ?? observation.escalatedAt,
    escalatedReason: prior?.escalation?.reason ?? observation.escalatedReason,
    now,
    policy,
  };
  const supervisorAbsent = observation.supervisor?.status === "absent";
  const delayed = reportDelay(observation, nowMs, policy);
  if (supervisorAbsent) {
    const already = base.escalatedReason === "supervisor-absent";
    return {
      action: already ? "wait" : "escalate",
      reason: already ? "already-escalated" : "supervisor-absent",
      semanticProgressAt,
      semanticProgressProof: provenProgress
        ? "proven"
        : semanticProgressAt
          ? "last-proven"
          : "unknown",
      activityAt: observation.lastActivityAt ?? null,
      display: "감독자 관측 불가",
    };
  }
  if (delayed) {
    const already = base.escalatedReason === "report-delayed";
    return {
      action: already ? "wait" : "escalate",
      reason: already ? "already-escalated" : "report-delayed",
      semanticProgressAt,
      semanticProgressProof: provenProgress
        ? "proven"
        : semanticProgressAt
          ? "last-proven"
          : "unknown",
      activityAt: observation.lastActivityAt ?? null,
      display: "보고 지연",
    };
  }
  const decision = nextSupervisionAction(base);
  return {
    ...decision,
    semanticProgressProof: provenProgress
      ? "proven"
      : semanticProgressAt
        ? "last-proven"
        : "unknown",
    progressAdvanced: Boolean(progressAdvanced),
    confirmedActionReceipt: receipt,
    effectiveUnansweredRequests: unansweredRequests,
    effectiveInspections: inspections,
  };
}

/**
 * Records one actual supervisor observation and suppresses repeated reports
 * until a different reason or evidence-backed semantic progress appears.
 * This function only stores local reporting evidence; it does not send a
 * prompt, restart a role, claim a recipient read it, or control Orca.
 *
 * @param {object} options - State-backed observation input.
 * @param {string} options.stateDir - Registered kickoff state directory.
 * @param {string} options.dispatchId - Orca Dispatch identity.
 * @param {object} options.observation - Official observation and report facts.
 * @param {object} options.policy - Effective supervision policy.
 * @returns {object} Decision plus a durable report receipt.
 */
export function recordSupervisionObservation({
  stateDir,
  dispatchId,
  observation,
  policy,
}) {
  if (!observation || typeof observation !== "object")
    throw new Error("Supervision observation required");
  const file = supervisionReportFile(stateDir, dispatchId);
  return withFileLock(`${file}.lock`, () => {
    const previous = fs.existsSync(file) ? readJSON(file) : null;
    const decision = reportDecision({ observation, previous, policy });
    const now = observation.now ?? new Date().toISOString();
    const progressAdvanced = decision.progressAdvanced === true;
    const receipt = decision.confirmedActionReceipt;
    const resolved = handledDecision(observation);
    const unansweredRequests = progressAdvanced
      ? 0
      : (decision.effectiveUnansweredRequests ??
        previous?.unansweredRequests ??
        observation.unansweredRequests ??
        0);
    const inspections = progressAdvanced
      ? 0
      : (decision.effectiveInspections ??
        previous?.inspections ??
        observation.inspections ??
        0);
    const next = {
      schemaVersion: 1,
      dispatchId,
      observedAt: now,
      source: observation.source ?? "official-orca-supervision-call",
      liveness: observation.liveness,
      lastProvenProgress: progressAdvanced
        ? {
            at: decision.semanticProgressAt,
            evidence: observation.semanticProgressEvidence,
            source: observation.semanticProgressSource ?? "supervisor-input",
          }
        : (previous?.lastProvenProgress ?? null),
      unansweredRequests,
      inspections,
      actionReceiptIds: receipt
        ? [...(previous?.actionReceiptIds ?? []), receipt.id].slice(-20)
        : (previous?.actionReceiptIds ?? []),
      escalation:
        decision.action === "escalate"
          ? { at: now, reason: decision.reason }
          : progressAdvanced
            ? null
            : (previous?.escalation ?? null),
      pendingDecision:
        decision.action === "escalate"
          ? { reason: decision.reason, ...decisionOwner(decision.reason) }
          : progressAdvanced || resolved
            ? null
            : (previous?.pendingDecision ?? null),
      report: {
        state: "stored",
        proof: "local-durable",
        delivery: "not-attempted",
        deduplicated:
          decision.reason === "already-escalated" &&
          previous?.report?.state === "stored",
      },
    };
    writeJSON(file, next);
    return { ...decision, supervision: next };
  });
}
