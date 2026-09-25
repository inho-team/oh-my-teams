/** Read-only organization run, gate, usage, and quota status projection. */
import fs from "node:fs";
import path from "node:path";
import { definedRoles, foldRole, readJSON, validateOrg } from "./core.mjs";
import { promptAnswerSummary } from "./prompt-supervision.mjs";
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

const LIVENESS = new Set(["live", "unverifiable", "exited"]);

/**
 * Decides a supervisor's next step for one worker that has not sent worker_done.
 *
 * A check timeout is a checkpoint, and without a rule a supervisor waits on a
 * silent worker indefinitely. The answer is one of `wait`, `ask-progress`,
 * `inspect` or `escalate`. Retrying or stopping always needs evidence someone
 * weighed, so no observation produces either one. An `unverifiable` worker is
 * never treated as alive, and an exit without worker_done is a failure to
 * classify rather than a worker to wait for.
 *
 * Every check that found no new activity counts toward the limit, whether it
 * asked for progress or inspected output, so a worker that stays unverifiable
 * or never shows activity is escalated instead of inspected forever. Once a
 * stall is escalated, the same stall is not escalated again until the worker
 * shows new activity.
 *
 * @param {object} observation - Current facts about the worker.
 * @param {string} observation.liveness - `live`, `unverifiable` or `exited`.
 * @param {string} [observation.lastActivityAt] - Last heartbeat, message or output change.
 * @param {string|number} [observation.now=Date.now()] - Time of this check.
 * @param {number} [observation.unansweredRequests=0] - Progress requests still unanswered.
 * @param {number} [observation.inspections=0] - Inspections since the last activity.
 * @param {string} [observation.escalatedAt] - When this stall was last escalated.
 * @param {string} [observation.escalatedReason] - Reason that escalation reported.
 * @param {object|null} [observation.agentWait] - `worker-show` evidence of a human prompt.
 * @param {object} observation.policy - Result of `supervisionPolicy`.
 * @returns {object} Action, reason, silence in minutes, and the user-facing label.
 * @throws {Error} When liveness, the clock or the policy is missing or unknown.
 */
export function nextSupervisionAction({
  liveness,
  lastActivityAt,
  now = Date.now(),
  unansweredRequests = 0,
  inspections = 0,
  escalatedAt,
  escalatedReason,
  agentWait = null,
  policy,
}) {
  if (!LIVENESS.has(liveness)) {
    throw new Error(`Unknown worker liveness: ${liveness}`);
  }
  if (!policy?.progressCheckMs || !policy.unansweredLimit) {
    throw new Error("Supervision policy required");
  }
  const nowMs = new Date(now).getTime();
  if (Number.isNaN(nowMs)) throw new Error(`Invalid now: ${now}`);
  const last = Date.parse(lastActivityAt ?? "");
  const silentMs = Number.isNaN(last) ? null : Math.max(0, nowMs - last);
  const silentMinutes = silentMs === null ? null : Math.floor(silentMs / 60000);
  const exhausted = unansweredRequests + inspections >= policy.unansweredLimit;
  const decide = (action, reason, extra = {}) => ({
    action,
    reason,
    silentMinutes,
    display:
      reason === "recent-activity"
        ? "진행 중"
        : silentMinutes === null
          ? "활동 기록 없음"
          : `무응답 ${silentMinutes}분`,
    ...extra,
  });

  const escalated = Date.parse(escalatedAt ?? "");
  // An exit or a human prompt is a new fact when the last escalation reported
  // something else, such as the stall before it, so both are checked before the
  // already-escalated rule. Once that same fact has been reported, repeating it
  // on every check only buries the report under copies of itself.
  const reported = (reason) =>
    !Number.isNaN(escalated) && escalatedReason === reason;
  if (liveness === "exited") {
    return reported("exited-without-worker-done")
      ? decide("wait", "already-escalated")
      : decide("escalate", "exited-without-worker-done", {
          readOutput: true,
          failureClassify: true,
        });
  }
  if (agentWait) {
    return reported("waiting-on-human-prompt")
      ? decide("wait", "already-escalated")
      : decide("escalate", "waiting-on-human-prompt", { readOutput: true });
  }
  if (!Number.isNaN(escalated) && (Number.isNaN(last) || last <= escalated)) {
    return decide("wait", "already-escalated");
  }
  if (liveness === "unverifiable") {
    return exhausted
      ? decide("escalate", "unverifiable-after-checks", { readOutput: true })
      : decide("inspect", "unverifiable");
  }
  if (silentMs === null) {
    return exhausted
      ? decide("escalate", "no-activity-after-checks", { readOutput: true })
      : decide("inspect", "no-observed-activity");
  }
  if (silentMs < policy.progressCheckMs) {
    return decide("wait", "recent-activity");
  }
  return exhausted
    ? decide("escalate", "silent-after-progress-requests", { readOutput: true })
    : decide("ask-progress", "silent");
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
 * @param {string | undefined} stateDir - Optional PM worktree `.omt` directory.
 * @returns {object} Runs, explicit usage gaps, quota-pool observations, and supervised prompt answers.
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
    promptAnswers: promptAnswerSummary(stateDir),
  };
}
