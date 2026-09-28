/** Read-only reconciliation of a completed kickoff's Orca worktrees and Git evidence. */
import fs from "node:fs";
import path from "node:path";
import { assert, readJSON } from "./core.mjs";
import { git } from "./evidence.mjs";
import {
  listKickoffs,
  ownerProject,
  validateEntry,
} from "./kickoff-registry.mjs";
import { runOrcaJson, selectOrcaExecutable } from "./orca-adapter.mjs";

function archivedEntry(orgFile, archiveFile, worktreeId) {
  const directory = path.join(path.dirname(path.resolve(orgFile)), "history");
  const file = path.resolve(archiveFile);
  assert(
    path.dirname(file) === directory,
    "Archive must be in the organization's history directory",
  );
  const entry = validateEntry(readJSON(file));
  assert(
    entry.pm.worktreeId === worktreeId,
    "Archive belongs to another PM worktree",
  );
  assert(
    entry.releaseReason === "completed",
    "Only completed kickoff archives have cleanup candidates",
  );
  return entry;
}

function candidateIds(entry, worktrees) {
  const byId = new Map(worktrees.map((item) => [item.worktreeId, item]));
  const byParent = new Map();
  for (const item of worktrees) {
    if (!item.parentWorktreeId) continue;
    const siblings = byParent.get(item.parentWorktreeId) ?? [];
    siblings.push(item.worktreeId);
    byParent.set(item.parentWorktreeId, siblings);
  }
  const known = (entry.cleanup?.candidates ?? []).map(
    (item) => item.worktreeId,
  );
  const ids = new Set([entry.pm.worktreeId, ...known]);
  const queue = [...ids];
  while (queue.length) {
    const current = queue.shift();
    const children = [
      ...(byId.get(current)?.childWorktreeIds ?? []),
      ...(byParent.get(current) ?? []),
    ];
    for (const child of children) {
      if (ids.has(child)) continue;
      ids.add(child);
      queue.push(child);
    }
  }
  return [...ids];
}

function worktreePath(id, item, entry) {
  if (id === entry.pm.worktreeId) return entry.pm.path;
  return (
    item?.path ??
    entry.cleanup?.candidates?.find((candidate) => candidate.worktreeId === id)
      ?.path ??
    null
  );
}

function workerWorkspace(row) {
  return row?.projection?.workspace?.id ?? row?.resource?.worktreeId ?? null;
}

function cleanWorker(row) {
  return (
    row?.projection?.liveness?.verdict === "exited" &&
    row.terminalState === "released"
  );
}

/**
 * Evaluates a bounded Orca inventory without treating an absent terminal as process exit.
 *
 * @param {object} entry - Active or archived kickoff entry.
 * @param {object} observed - Worktree, terminal, worker, and Git observations.
 * @returns {object} Candidate states and a resumable cleanup summary.
 */
export function evaluateKickoffCleanup(entry, observed) {
  const worktrees = observed.worktrees ?? [];
  const terminals = observed.terminals ?? [];
  const workers = observed.workers ?? [];
  const inventoryComplete = observed.inventoryComplete === true;
  const byId = new Map(worktrees.map((item) => [item.worktreeId, item]));
  const candidates = candidateIds(entry, worktrees).map((id) => {
    const item = byId.get(id);
    const location = worktreePath(id, item, entry);
    const gitState = observed.git?.[id] ?? null;
    const attached = terminals.filter((terminal) => terminal.worktreeId === id);
    const assigned = workers.filter((worker) => workerWorkspace(worker) === id);
    const reasons = [];
    if (!inventoryComplete) reasons.push("inventory-incomplete");
    if (!item) reasons.push("orca-worktree-unlisted");
    if (!item && observed.remoteHostsOmitted)
      reasons.push("remote-hosts-omitted");
    if (item && !gitState) reasons.push("git-unverifiable");
    if (gitState?.dirty) reasons.push("uncommitted-changes");
    if (gitState?.ignored) reasons.push("local-evidence-unpreserved");
    if (gitState && !gitState.included) reasons.push("head-not-delivered");
    if (
      attached.length > 0 ||
      item?.liveTerminalCount > 0 ||
      item?.hasAttachedPty
    )
      reasons.push("terminal-or-process-live");
    if (assigned.some((worker) => !cleanWorker(worker)))
      reasons.push("worker-unsettled-or-unverifiable");
    if (assigned.length === 0) reasons.push("process-exit-unproven");
    if (id === entry.pm.worktreeId && !entry.releasedAt)
      reasons.push("pm-kickoff-active");
    const removed = !item && observed.absentPaths?.includes(location);
    return {
      worktreeId: id,
      path: location,
      owner: entry.director?.terminalHandle ?? entry.pm.worktreeId,
      status:
        removed && inventoryComplete && !observed.remoteHostsOmitted
          ? "already-removed"
          : reasons.length
            ? "preserve"
            : "safe-to-remove",
      reasons:
        removed && inventoryComplete && !observed.remoteHostsOmitted
          ? []
          : reasons,
      git: gitState,
      terminalHandles: attached.map((terminal) => terminal.handle),
      workerDispatches: assigned.map((worker) => worker.dispatchId),
    };
  });
  return {
    schemaVersion: 1,
    worktreeId: entry.pm.worktreeId,
    createdAt: entry.createdAt,
    runId: entry.runId,
    scannedAt: observed.scannedAt ?? new Date().toISOString(),
    inventoryComplete,
    status: candidates.every((item) => item.status === "already-removed")
      ? "clean"
      : "cleanup-pending",
    candidates,
    errors: observed.errors ?? [],
  };
}

async function gitObservation(location, delivered, projectDir, gitCommand) {
  if (!location || !fs.existsSync(location)) return null;
  try {
    const [status, ignored, head] = await Promise.all([
      gitCommand(location, ["status", "--porcelain=v1", "-uall"]),
      gitCommand(location, [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
      ]),
      gitCommand(location, ["rev-parse", "HEAD"]),
    ]);
    let included = false;
    if (delivered?.mergeCommit) {
      try {
        await gitCommand(projectDir, [
          "merge-base",
          "--is-ancestor",
          head,
          delivered.mergeCommit,
        ]);
        included = true;
      } catch {
        included = false;
      }
    }
    const ignoredPaths = ignored.split("\0").filter(Boolean);
    const localEvidence = ignoredPaths.filter(
      (file) => file !== "node_modules" && !file.startsWith("node_modules/"),
    );
    return {
      head,
      dirty: Boolean(status),
      ignored: localEvidence.length > 0,
      ignoredCount: localEvidence.length,
      included,
    };
  } catch {
    return null;
  }
}

/**
 * Reads active or archived kickoff candidates without changing Orca or Git state.
 *
 * @param {object} request - Organization, PM worktree, and optional archive path.
 * @param {object} [ports] - Injectable Orca and Git readers for deterministic tests.
 * @returns {Promise<object>} Conservative cleanup inventory.
 */
export async function scanKickoffCleanup(
  { orgFile, worktreeId, archiveFile, executable },
  { orca = runOrcaJson, gitCommand = git } = {},
) {
  const entry = archiveFile
    ? archivedEntry(orgFile, archiveFile, worktreeId)
    : listKickoffs(orgFile, worktreeId).kickoffs[0];
  assert(entry, `Worktree ${worktreeId} has no registered kickoff`);
  const selected = selectOrcaExecutable(executable);
  const errors = [];
  const results = await Promise.allSettled([
    orca(selected, ["worktree", "ps"]),
    orca(selected, ["terminal", "list"]),
    entry.runId
      ? orca(selected, [
          "orchestration",
          "worker-list",
          "--run",
          entry.runId,
          "--include-remote",
        ])
      : Promise.resolve(null),
  ]);
  const values = results.map((result, index) => {
    if (result.status === "fulfilled") return result.value?.result ?? null;
    errors.push(["worktree-ps", "terminal-list", "worker-list"][index]);
    return null;
  });
  const [treeResult, terminalResult, workerResult] = values;
  const worktrees = Array.isArray(treeResult?.worktrees)
    ? treeResult.worktrees
    : [];
  const terminals = Array.isArray(terminalResult?.terminals)
    ? terminalResult.terminals
    : [];
  const workers = Array.isArray(workerResult?.workers)
    ? workerResult.workers
    : [];
  if (!Array.isArray(treeResult?.worktrees))
    errors.push("worktree-inventory-unavailable");
  if (!Array.isArray(terminalResult?.terminals))
    errors.push("terminal-inventory-unavailable");
  if (entry.runId && !Array.isArray(workerResult?.workers))
    errors.push("worker-inventory-unavailable");
  if (workerResult?.page?.hasMore) errors.push("worker-inventory-truncated");
  if (treeResult?.truncated || terminalResult?.truncated)
    errors.push("orca-inventory-truncated");
  const remoteHostsOmitted = Boolean(
    treeResult?.hostScope?.omittedHostIds?.length ||
    terminalResult?.hostScope?.omittedHostIds?.length,
  );
  const ids = candidateIds(entry, worktrees);
  const byId = new Map(worktrees.map((item) => [item.worktreeId, item]));
  const gitStates = {};
  const absentPaths = [];
  for (const id of ids) {
    const location = worktreePath(id, byId.get(id), entry);
    if (location && !fs.existsSync(location)) absentPaths.push(location);
    gitStates[id] = await gitObservation(
      location,
      entry.delivered,
      ownerProject(orgFile),
      gitCommand,
    );
  }
  return evaluateKickoffCleanup(entry, {
    worktrees,
    terminals,
    workers,
    git: gitStates,
    absentPaths,
    errors,
    remoteHostsOmitted,
    inventoryComplete: errors.length === 0,
  });
}
