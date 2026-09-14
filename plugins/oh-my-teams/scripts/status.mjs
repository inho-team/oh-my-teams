/** Read-only organization run, gate, usage, and quota status projection. */
import fs from "node:fs";
import path from "node:path";
import { readJSON, validateOrg } from "./core.mjs";
import { latestQuotaSnapshots, quotaStatus } from "./quota.mjs";
import {
  addCallUsage,
  createUsageAccumulator,
  finalizeUsage,
} from "./usage.mjs";

function currentGateStatus(stateDir, report) {
  const file = path.join(stateDir, "gates", `${report.taskId}.json`);
  if (!fs.existsSync(file)) return null;
  const status = readJSON(file);
  return status.gates?.["contract-ready"]?.taskHash === report.taskHash &&
    status.runId === report.runId &&
    status.evidenceKey === report.evidence?.key
    ? status
    : null;
}

function nextOwner(report, gateStatus, gates) {
  if (gates?.["review-complete"]?.status === "pending") return "senior";
  if (gates?.["outcome-accepted"]?.status === "pending") return "pm";
  if (gateStatus?.state === "accepted") return null;
  return report.status === "failed" ? report.role : null;
}

function runStatus(stateDir, runId, usage) {
  const reportFile = path.join(stateDir, "runs", runId, "report.json");
  if (!fs.existsSync(reportFile)) {
    return {
      runId,
      status: "unsettled",
      note: "Check execution-host process liveness",
    };
  }

  const report = readJSON(reportFile);
  for (const call of report.calls ?? []) addCallUsage(usage, call);
  const gateStatus = currentGateStatus(stateDir, report);
  const gates = gateStatus?.gates ?? report.gates ?? null;
  return {
    runId,
    taskId: report.taskId,
    role: report.role,
    status: gateStatus?.state ?? report.status,
    nextOwner: nextOwner(report, gateStatus, gates),
    gates,
    issues: report.issues,
  };
}

function poolStatuses(org, stateDir) {
  const snapshots = stateDir ? latestQuotaSnapshots(stateDir) : {};
  return Object.fromEntries(
    Object.keys(org.pools ?? {}).map((poolId) => {
      const snapshot = snapshots[poolId];
      if (!snapshot) {
        return [
          poolId,
          {
            status: "unknown",
            reason: "No supported quota snapshot was supplied",
          },
        ];
      }
      return [
        poolId,
        {
          ...quotaStatus(snapshot),
          observedAt: snapshot.observedAt,
          source: snapshot.source,
        },
      ];
    }),
  );
}

/**
 * Builds the read-only status shown by the organization CLI.
 *
 * @param {object} org - Valid organization configuration.
 * @param {string | undefined} stateDir - Optional coordinator `.omt` directory.
 * @returns {object} Runs, explicit usage gaps, and quota-pool observations.
 * @throws {Error} When organization or persisted records are invalid.
 */
export function organizationStatus(org, stateDir) {
  validateOrg(org);
  const usage = createUsageAccumulator();
  const runsDir = stateDir && path.join(stateDir, "runs");
  const runs =
    runsDir && fs.existsSync(runsDir)
      ? fs
          .readdirSync(runsDir)
          .sort()
          .map((runId) => runStatus(stateDir, runId, usage))
      : [];
  return {
    runs,
    usage: finalizeUsage(usage),
    pools: poolStatuses(org, stateDir),
  };
}
