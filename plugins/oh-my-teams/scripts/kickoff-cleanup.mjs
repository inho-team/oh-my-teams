/** Read-only reconciliation of a completed kickoff's Orca worktrees and Git evidence. */
import fs from "node:fs";
import path from "node:path";
import { assert, readJSON, withAsyncFileLock, writeJSON } from "./core.mjs";
import { git } from "./evidence.mjs";
import {
  listKickoffs,
  ownerProject,
  validateEntry,
} from "./kickoff-registry.mjs";
import {
  reclaimWorktree,
  runOrcaJson,
  selectOrcaExecutable,
} from "./orca-adapter.mjs";
import { readLaunches, readTerminalClosures } from "./usage-ledger.mjs";

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
    entry.cleanup?.candidates?.find((candidate) => candidate.worktreeId === id)
      ?.path ??
    item?.path ??
    null
  );
}

function workerWorkspace(row) {
  return row?.projection?.workspace?.id ?? row?.resource?.worktreeId ?? null;
}

function workerInCandidate(row, id, location) {
  const workspace = workerWorkspace(row);
  return (
    workspace === id ||
    (location && workspace === location) ||
    (location &&
      typeof workspace === "string" &&
      workspace.endsWith(`::${location}`))
  );
}

function cleanWorker(row) {
  return (
    row?.projection?.liveness?.verdict === "exited" &&
    row.terminalState === "released"
  );
}

function settledContextDispatch(row) {
  return (
    row?.workerState === "unsupervised" &&
    ["completed", "failed"].includes(row.dispatchStatus) &&
    row.terminalState === "retained" &&
    (row.projection?.liveness?.verdict === "exited" ||
      (row.projection?.liveness?.verdict === "unverifiable" &&
        row.projection.liveness.reason === "unsupervised_settled"))
  );
}

function receiptBody(receipt) {
  return receipt?.result ?? receipt ?? {};
}

function closureProvesLaunch(closure, launch, worktreeId, location) {
  if (
    closure?.worktreeId !== worktreeId ||
    path.resolve(closure.worktreePath ?? "") !== path.resolve(location) ||
    !closure.at ||
    !launch.at ||
    closure.at < launch.at
  )
    return false;
  const terminal = closure.terminals?.find(
    (item) => item.terminal === launch.terminal,
  );
  const close = receiptBody(terminal?.close?.receipt).close;
  const closeEvidence = JSON.stringify(terminal?.close?.receipt ?? {});
  const before = receiptBody(closure.beforeReceipt).terminals;
  const after = receiptBody(closure.afterReceipt).terminals;
  const release = terminal?.releases?.find(
    (item) => item.dispatchId === launch.workerId,
  );
  const released = receiptBody(release?.receipt);
  return (
    terminal?.dispatch?.result?.status === "clear" &&
    Array.isArray(before) &&
    before.some((item) => item.handle === launch.terminal) &&
    close?.handle === launch.terminal &&
    (typeof close.tabId === "string" || Number.isInteger(close.tabId)) &&
    close.ptyKilled === true &&
    !closeEvidence.includes('"ptyKilled":false') &&
    !closeEvidence.includes("terminal_stop_unverifiable") &&
    !closeEvidence.includes("terminalStopUnverifiable") &&
    Array.isArray(after) &&
    after.length === 0 &&
    (launch.workerId === null ||
      (released.dispatchId === launch.workerId &&
        released.state === "retained" &&
        released.reason === "external_terminal" &&
        released.processAction === "none"))
  );
}

function closedLaunchesProven(launches, closures, id, location) {
  if (typeof location !== "string") return false;
  const owned = launches.filter((launch) => launch.worktreePath === location);
  return (
    owned.length > 0 &&
    owned.every(
      (launch) =>
        typeof launch.terminal === "string" &&
        closures.some((closure) =>
          closureProvesLaunch(closure, launch, id, location),
        ),
    )
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
    const previous = entry.cleanup?.candidates?.find(
      (candidate) => candidate.worktreeId === id,
    );
    const parentWorktreeId =
      item?.parentWorktreeId ??
      previous?.parentWorktreeId ??
      worktrees.find((parent) => parent.childWorktreeIds?.includes(id))
        ?.worktreeId ??
      null;
    const gitState = observed.git?.[id] ?? null;
    const attached = terminals.filter((terminal) => terminal.worktreeId === id);
    const assigned = workers.filter((worker) =>
      workerInCandidate(worker, id, location),
    );
    const reasons = [];
    if (!inventoryComplete) reasons.push("inventory-incomplete");
    if (!item) reasons.push("orca-worktree-unlisted");
    if (
      item?.path &&
      location &&
      path.resolve(item.path) !== path.resolve(location)
    )
      reasons.push("worktree-path-changed");
    if (item && previous && (!previous.instanceId || !item.worktreeInstanceId))
      reasons.push("worktree-instance-unverified");
    if (
      item?.worktreeInstanceId &&
      previous?.instanceId &&
      item.worktreeInstanceId !== previous.instanceId
    )
      reasons.push("worktree-instance-changed");
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
    if (
      assigned.length === 0 &&
      !closedLaunchesProven(
        observed.launches ?? [],
        observed.closures ?? [],
        id,
        location,
      )
    )
      reasons.push("process-exit-unproven");
    if (id === entry.pm.worktreeId && !entry.releasedAt)
      reasons.push("pm-kickoff-active");
    const removed = !item && observed.absentPaths?.includes(location);
    const hostVerified =
      previous?.hostId && observed.hostIds?.includes(previous.hostId);
    const absenceVerified =
      inventoryComplete && (!observed.remoteHostsOmitted || hostVerified);
    return {
      worktreeId: id,
      path: location,
      parentWorktreeId,
      instanceId: item?.worktreeInstanceId ?? previous?.instanceId ?? null,
      hostId: item?.hostId ?? previous?.hostId ?? null,
      owner: entry.director?.terminalHandle ?? entry.pm.worktreeId,
      status:
        removed && absenceVerified
          ? "already-removed"
          : reasons.length
            ? "preserve"
            : "safe-to-remove",
      reasons: removed && absenceVerified ? [] : reasons,
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
    unattributedWorkers: observed.unattributedWorkers ?? [],
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
    return {
      head,
      dirty: Boolean(status),
      ignored: ignoredPaths.length > 0,
      ignoredCount: ignoredPaths.length,
      included,
    };
  } catch {
    return null;
  }
}

async function allWorkerObservations(executable, orca, requiredRunId) {
  const runs = [];
  let cursor;
  const seen = new Set();
  do {
    const args = ["orchestration", "run-list", "--limit", "100"];
    if (cursor) args.push("--cursor", cursor);
    const result = receiptBody(await orca(executable, args));
    assert(Array.isArray(result.runs), "Orca Run inventory is unavailable");
    runs.push(...result.runs);
    cursor = result.nextCursor ?? null;
    assert(!cursor || !seen.has(cursor), "Orca Run inventory cursor repeated");
    if (cursor) seen.add(cursor);
  } while (cursor);
  const workers = [];
  const ids = [
    ...new Set([
      ...runs.map((run) => run.id),
      ...(requiredRunId ? [requiredRunId] : []),
    ]),
  ];
  assert(
    ids.every((id) => typeof id === "string" && id),
    "Orca Run inventory has an invalid ID",
  );
  for (let offset = 0; offset < ids.length; offset += 8) {
    const batch = ids.slice(offset, offset + 8);
    const listed = await Promise.all(
      batch.map(async (runId) => {
        const rows = [];
        let pageCursor;
        const pageSeen = new Set();
        do {
          const args = [
            "orchestration",
            "worker-list",
            "--run",
            runId,
            "--include-remote",
            "--limit",
            "100",
          ];
          if (pageCursor) args.push("--cursor", pageCursor);
          const result = receiptBody(await orca(executable, args));
          assert(
            Array.isArray(result.workers),
            `Orca worker inventory for ${runId} is unavailable`,
          );
          rows.push(...result.workers);
          pageCursor = result.page?.hasMore ? result.page.nextCursor : null;
          assert(
            !result.page?.hasMore || pageCursor,
            `Orca worker inventory for ${runId} is truncated`,
          );
          assert(
            !pageCursor || !pageSeen.has(pageCursor),
            `Orca worker cursor repeated for ${runId}`,
          );
          if (pageCursor) pageSeen.add(pageCursor);
        } while (pageCursor);
        return rows;
      }),
    );
    workers.push(...listed.flat());
  }
  return { result: { workers } };
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
  {
    orca = runOrcaJson,
    gitCommand = git,
    workerInventory = allWorkerObservations,
  } = {},
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
    workerInventory(selected, orca, entry.runId),
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
  if (!Array.isArray(workerResult?.workers))
    errors.push("worker-inventory-unavailable");
  const unattributedWorkers = workers.filter(
    (worker) =>
      !workerWorkspace(worker) &&
      !cleanWorker(worker) &&
      !settledContextDispatch(worker),
  );
  if (unattributedWorkers.length) errors.push("worker-workspace-unattributed");
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
    launches: readLaunches(orgFile),
    closures: readTerminalClosures(orgFile),
    git: gitStates,
    absentPaths,
    errors,
    unattributedWorkers: unattributedWorkers.map((worker) => ({
      runId: worker.runId,
      dispatchId: worker.dispatchId,
      agentTerminalHandle: worker.agentTerminalHandle,
      workerState: worker.workerState,
      dispatchStatus: worker.dispatchStatus,
      terminalState: worker.terminalState,
      liveness: worker.projection?.liveness,
    })),
    remoteHostsOmitted,
    hostIds: treeResult?.hostScope?.hostIds ?? [],
    inventoryComplete: errors.length === 0,
  });
}

function isDescendant(candidate, ancestorId, candidates) {
  const byId = new Map(candidates.map((item) => [item.worktreeId, item]));
  const seen = new Set();
  let parent = candidate.parentWorktreeId;
  while (parent && !seen.has(parent)) {
    if (parent === ancestorId) return true;
    seen.add(parent);
    parent = byId.get(parent)?.parentWorktreeId;
  }
  return false;
}

/**
 * Revalidates archived candidates and asks Orca to remove only proven safe worktrees.
 * Every request and its post-removal observation are stored for later reentry.
 *
 * @param {object} request - Completed archive, PM worktree, and caller identity.
 * @param {object} [ports] - Injectable read-only scanner and Orca reclaimer.
 * @returns {Promise<object>} Durable per-candidate cleanup result.
 */
export async function reclaimKickoffCleanup(
  { orgFile, worktreeId, archiveFile, executable, callerCwd = process.cwd() },
  {
    scan = scanKickoffCleanup,
    show = runOrcaJson,
    reclaim = reclaimWorktree,
  } = {},
) {
  const entry = archivedEntry(orgFile, archiveFile, worktreeId);
  assert(
    entry.director?.checkoutPath,
    "Completed cleanup requires a recorded director checkout",
  );
  assert(
    path.resolve(callerCwd) === path.resolve(entry.director.checkoutPath),
    "Completed cleanup must run from the recorded director checkout",
  );
  const archive = path.resolve(archiveFile);
  const recordFile = path.join(
    path.dirname(archive),
    `cleanup-${path.basename(archive)}`,
  );
  const request = { orgFile, worktreeId, archiveFile: archive, executable };
  return withAsyncFileLock(
    `${recordFile}.lock`,
    async () => {
      const record = fs.existsSync(recordFile)
        ? readJSON(recordFile)
        : {
            schemaVersion: 1,
            archive,
            worktreeId,
            createdAt: entry.createdAt,
            attempts: [],
          };
      assert(
        record.schemaVersion === 1 &&
          record.archive === archive &&
          record.worktreeId === worktreeId &&
          record.createdAt === entry.createdAt &&
          Array.isArray(record.attempts),
        "Cleanup record belongs to another kickoff or is malformed",
      );
      let latest = await scan(request);
      record.latest = latest;
      writeJSON(recordFile, record);
      const ids = latest.candidates
        .map((candidate) => candidate.worktreeId)
        .reverse();
      for (const id of ids) {
        latest = await scan(request);
        const candidate = latest.candidates.find(
          (item) => item.worktreeId === id,
        );
        if (!candidate || candidate.status !== "safe-to-remove") {
          record.latest = latest;
          writeJSON(recordFile, record);
          continue;
        }
        const pendingChild = latest.candidates.some(
          (item) =>
            item.worktreeId !== id &&
            item.status !== "already-removed" &&
            (id === worktreeId || isDescendant(item, id, latest.candidates)),
        );
        if (
          pendingChild ||
          record.attempts.some(
            (attempt) =>
              attempt.worktreeId === id &&
              ["attempting", "unverified"].includes(attempt.outcome),
          )
        ) {
          record.latest = latest;
          writeJSON(recordFile, record);
          continue;
        }
        const attempt = {
          worktreeId: id,
          instanceId: candidate.instanceId,
          startedAt: new Date().toISOString(),
          before: candidate,
          outcome: "attempting",
        };
        record.attempts.push(attempt);
        record.latest = latest;
        writeJSON(recordFile, record);
        let identityKey;
        try {
          attempt.showReceipt = await show(
            selectOrcaExecutable(executable),
            ["worktree", "show", "--worktree", `id:${id}`],
            { cwd: ownerProject(orgFile) },
          );
          const shown = receiptBody(attempt.showReceipt).worktree;
          assert(
            shown?.id === id &&
              shown.path === candidate.path &&
              shown.identity?.instanceId === candidate.instanceId &&
              shown.identity?.executionHostId === candidate.hostId &&
              typeof shown.identity?.key === "string" &&
              shown.identity.key,
            `Worktree ${id} identity changed or could not be verified; preserve it`,
          );
          identityKey = shown.identity.key;
        } catch (error) {
          attempt.outcome = "refused";
          attempt.error = error.message;
        }
        if (identityKey) {
          try {
            attempt.receipt = await reclaim(ownerProject(orgFile), {
              id,
              identityKey,
              executable,
            });
          } catch (error) {
            attempt.outcome = "unverified";
            attempt.error = error.message;
          }
        }
        if (attempt.outcome === "attempting") {
          try {
            const after = await scan(request);
            attempt.after =
              after.candidates.find((item) => item.worktreeId === id) ?? null;
            attempt.outcome =
              attempt.after?.status === "already-removed"
                ? "removed"
                : "unverified";
            record.latest = after;
          } catch (error) {
            attempt.outcome = "unverified";
            attempt.error = error.message;
          }
        }
        writeJSON(recordFile, record);
      }
      try {
        record.latest = await scan(request);
      } catch (error) {
        record.scanError = error.message;
      }
      writeJSON(recordFile, record);
      return { recordFile, ...record };
    },
    "Cleanup reconciliation already in progress",
  );
}
