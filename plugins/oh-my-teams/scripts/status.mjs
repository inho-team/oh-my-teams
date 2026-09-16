/** Read-only organization run, gate, usage, and quota status projection. */
import fs from "node:fs";
import path from "node:path";
import { definedRoles, foldRole, readJSON, validateOrg } from "./core.mjs";
import { workflowStateFile } from "./workflow-store.mjs";
import { latestQuotaSnapshots, quotaStatus } from "./quota.mjs";
import {
  addCallUsage,
  createUsageAccumulator,
  finalizeUsage,
} from "./usage.mjs";

const TERMINAL_GOAL_STATUSES = new Set(["complete", "completed", "cancelled"]);

/**
 * Derives user-facing progress from authoritative Goal and worker observations.
 *
 * Plans, queued next steps, and existing commits are evidence of intended or
 * completed work, not evidence that an implementation process is currently live.
 *
 * @param {object} observation - Current Goal and worker-list observation.
 * @param {string} observation.goalStatus - Authoritative Goal status.
 * @param {Array<object>} observation.workers - Current worker-list entries.
 * @returns {{status:string,activeWorkers:number,unverifiableWorkers:number}}
 * A conservative user-facing status and the worker counts supporting it.
 * @throws {Error} When required authoritative observations are absent.
 */
export function supervisedProgressStatus({ goalStatus, workers }) {
  if (typeof goalStatus !== "string" || !goalStatus.trim())
    throw new Error("Authoritative Goal status required");
  if (!Array.isArray(workers))
    throw new Error("Authoritative worker-list required");

  const activeWorkers = workers.filter(
    (worker) => worker.liveness === "live",
  ).length;
  const unverifiableWorkers = workers.filter(
    (worker) => worker.liveness === "unverifiable",
  ).length;
  let status;
  if (goalStatus === "blocked") status = "blocked";
  else if (TERMINAL_GOAL_STATUSES.has(goalStatus)) status = goalStatus;
  else if (activeWorkers > 0) status = "in-progress";
  else if (unverifiableWorkers > 0) status = "unverifiable";
  else status = "stopped";
  return { status, activeWorkers, unverifiableWorkers };
}

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

// The roles a run folds onto: the ones its workflow uses at its current depth,
// or the organization's ladder for work that was never bound to a workflow.
// status only reads, so a workflow that cannot be found is not an error here.
function runRoles(org, stateDir, report) {
  const id = report.workflow?.id;
  if (id) {
    const file = workflowStateFile(stateDir, id);
    const roles = fs.existsSync(file) ? readJSON(file).roles : undefined;
    if (roles) return roles;
  }
  return definedRoles(org);
}

// A run may not use the role that owns a pending gate in a full ladder, either
// because the organization omits it or because the run's depth leaves it out,
// so the hint names the role that took the duty over rather than a role the
// reader cannot assign work to.
function nextOwner(roles, report, gateStatus, gates) {
  if (gates?.["review-complete"]?.status === "pending") {
    return foldRole(roles, "senior");
  }
  if (gates?.["outcome-accepted"]?.status === "pending") {
    return foldRole(roles, "pm");
  }
  if (gateStatus?.state === "accepted") return null;
  return report.status === "failed" ? report.role : null;
}

function runStatus(org, stateDir, runId, usage) {
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
    nextOwner: nextOwner(
      runRoles(org, stateDir, report),
      report,
      gateStatus,
      gates,
    ),
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
          .map((runId) => runStatus(org, stateDir, runId, usage))
      : [];
  return {
    runs,
    usage: finalizeUsage(usage),
    pools: poolStatuses(org, stateDir),
  };
}
