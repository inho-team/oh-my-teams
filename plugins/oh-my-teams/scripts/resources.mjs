/**
 * Resource slot management for shared heavy-work coordination.
 *
 * Multiple kickoffs share compute resources (test runners, workers, build
 * jobs). This module records slot acquisition and release atomically in the
 * owner project's `.omt/resources/` directory, checks a minimum free-memory
 * threshold, and reclaims slots whose owner process has exited.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assert,
  readJSON,
  readJsonDirectory,
  run,
  withFileLock,
  writeJSON,
} from "./core.mjs";
import { listKickoffs, ownerProject } from "./kickoff-registry.mjs";
import { listInbox, processLiveness } from "./director.mjs";

/** Resource kinds that may be acquired. */
export const RESOURCE_KINDS = Object.freeze(["test", "worker", "build"]);

/**
 * Default minimum free memory in bytes below which acquisition is refused.
 * Overridable via the organization `policy.minFreeMemoryBytes` field.
 */
export const DEFAULT_MIN_FREE_MEMORY_BYTES = 512 * 1024 * 1024; // 512 MiB

// Directory that holds one JSON file per acquired resource slot.
function slotsDir(orgFile) {
  return path.join(ownerProject(orgFile), ".omt", "resources");
}

// Lock file for the slots directory.
function slotsLock(orgFile) {
  return path.join(ownerProject(orgFile), ".omt", ".resources.lock");
}

// Reads all slot JSON files in deterministic order.
function readSlots(orgFile) {
  return readJsonDirectory(slotsDir(orgFile));
}

// Reads the minimum free-memory threshold from the organization policy when
// present; falls back to the module default otherwise.
function minFreeMemory(orgFile) {
  try {
    const org = readJSON(orgFile);
    const value = org?.policy?.minFreeMemoryBytes;
    if (typeof value === "number" && value >= 0) return value;
  } catch {
    // Unreadable org: use default.
  }
  return DEFAULT_MIN_FREE_MEMORY_BYTES;
}

/**
 * Acquires a resource slot for a PM worktree.
 *
 * Checks free memory and reclaims dead-owner slots before writing the new
 * slot record. The worktree must be registered in the kickoff registry.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {object} request - Acquisition request.
 * @param {string} request.worktreeId - PM worktree acquiring the slot.
 * @param {string} request.kind - One of RESOURCE_KINDS.
 * @param {string} [request.note] - Optional description of the intended use.
 * @param {Function} [request.freeMemory] - Injectable free-memory reporter (bytes).
 * @param {Function} [request.liveness] - Injectable liveness checker for reclaim.
 * @returns {{acquired: boolean, id: string, record: object, reclaimedIds: string[]}} Result.
 * @throws {Error} When the kind is invalid, the worktree is unknown, or free
 *   memory is below the threshold.
 */
export function acquireResource(orgFile, request) {
  assert(
    RESOURCE_KINDS.includes(request.kind),
    `Unknown resource kind: ${request.kind}`,
  );

  // Verify that the worktree is registered.
  const { kickoffs } = listKickoffs(path.resolve(orgFile));
  const entry = kickoffs.find((k) => k.pm.worktreeId === request.worktreeId);
  assert(
    entry,
    `Worktree ${request.worktreeId} is not registered in the kickoff registry`,
  );

  const checkFreeMemory = request.freeMemory ?? (() => os.freemem());
  const checkLiveness = request.liveness ?? processLiveness;
  const threshold = minFreeMemory(orgFile);

  return withFileLock(slotsLock(orgFile), () => {
    // Check free memory before reclaim so the check reflects the actual system.
    const free = checkFreeMemory();
    assert(
      free >= threshold,
      `Insufficient free memory: ${free} bytes available, ${threshold} bytes required`,
    );

    // Reclaim slots whose owner process has exited.
    const existing = readSlots(orgFile);
    const reclaimedIds = [];
    for (const slot of existing) {
      const verdict = checkLiveness({ pid: slot.pid, hostname: slot.hostname });
      if (verdict === "dead") {
        const slotFile = path.join(slotsDir(orgFile), `${slot.id}.json`);
        try {
          fs.unlinkSync(slotFile);
          reclaimedIds.push(slot.id);
        } catch {
          // Already gone; ignore.
        }
      }
    }

    const id = crypto.randomUUID();
    // Use request.ownerPid when the caller knows which long-lived process owns
    // the slot (e.g. the PM process that spawned this CLI invocation). Falling
    // back to process.pid means the slot's owner is this CLI process, which
    // exits immediately after acquire; the next acquire call will then see the
    // slot as dead and reclaim it. Pass the actual owner PID to prevent that.
    const ownerPid = request.ownerPid ?? process.pid;
    const record = {
      schemaVersion: 1,
      id,
      worktreeId: request.worktreeId,
      kind: request.kind,
      note: request.note ?? "",
      pid: ownerPid,
      hostname: os.hostname(),
      acquiredAt: new Date().toISOString(),
    };
    writeJSON(path.join(slotsDir(orgFile), `${id}.json`), record);
    return { acquired: true, id, record, reclaimedIds };
  });
}

/**
 * Releases a previously acquired resource slot.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} slotId - Slot ID to release.
 * @returns {{released: boolean, id: string}} Result.
 * @throws {Error} When the slot file is not found.
 */
export function releaseResource(orgFile, slotId) {
  return withFileLock(slotsLock(orgFile), () => {
    const file = path.join(slotsDir(orgFile), `${slotId}.json`);
    assert(fs.existsSync(file), `Resource slot ${slotId} not found`);
    fs.unlinkSync(file);
    return { released: true, id: slotId };
  });
}

/**
 * Reports the current PM liveness status for a kickoff registry entry.
 *
 * Uses Orca to query the PM worktree. A failed query is preserved as
 * `"unverifiable"` rather than concluded as alive or terminated.
 *
 * @param {object} entry - Kickoff registry entry.
 * @param {string} [orcaExecutable] - Orca binary path.
 * @returns {Promise<"alive"|"dead"|"unverifiable">} PM liveness verdict.
 */
export async function queryPmLiveness(entry, orcaExecutable) {
  // Orca provides no reliable synchronous PM liveness query via its CLI in
  // non-interactive contexts. We attempt a brief status call; any error,
  // non-zero exit, or timeout results in "unverifiable".
  const argv = [
    orcaExecutable ?? "orca",
    "orchestration",
    "worker-list",
    "--json",
  ];
  try {
    const result = await run(argv, { timeoutMs: 8000 });
    if (result.code !== 0) return "unverifiable";
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return "unverifiable";
    }
    // Orca worker-list returns {result: {workers: [...], ...}} envelope.
    // Fall back to treating a top-level array as the worker list so tests and
    // older Orca versions that return a plain array still work.
    const workers = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.result?.workers)
        ? parsed.result.workers
        : null;
    if (!Array.isArray(workers)) return "unverifiable";
    const pmPath = entry.pm?.path;
    if (!pmPath) return "unverifiable";
    // Find the worker entry for the PM worktree.
    const found = workers.find(
      (w) => typeof w.worktree === "string" && w.worktree.includes(pmPath),
    );
    if (!found) return "unverifiable";
    // Use the projection.liveness field when present; do not infer alive from
    // the mere presence of an entry — the PM may have stopped responding.
    const liveness = found.projection?.liveness ?? found.liveness;
    if (liveness === "alive") return "alive";
    if (liveness === "dead") return "dead";
    return "unverifiable";
  } catch {
    return "unverifiable";
  }
}

/**
 * Summarises signals, resource slots, free memory, and PM liveness together.
 *
 * PM liveness queries that fail are preserved as `"unverifiable"` rather than
 * concluded as alive or terminated.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {object} [options] - Optional overrides.
 * @param {string} [options.orcaExecutable] - Orca binary path.
 * @param {Function} [options.freeMemory] - Injectable free-memory reporter.
 * @returns {Promise<object>} Watch report with signals, slots, memory, and kickoffs.
 */
export async function directorWatch(orgFile, options = {}) {
  const checkFreeMemory = options.freeMemory ?? (() => os.freemem());
  const freeBytes = checkFreeMemory();
  const { signals } = listInbox(orgFile);
  const slots = readSlots(orgFile);
  const { kickoffs } = listKickoffs(path.resolve(orgFile));

  const kickoffSummaries = await Promise.all(
    kickoffs.map(async (entry) => {
      const pmSignals = signals.filter(
        (s) => s.worktreeId === entry.pm.worktreeId,
      );
      const pmSlots = slots.filter((s) => s.worktreeId === entry.pm.worktreeId);
      const liveness = await queryPmLiveness(entry, options.orcaExecutable);
      return {
        worktreeId: entry.pm.worktreeId,
        goal: entry.goal,
        pendingSignals: pmSignals.length,
        signals: pmSignals,
        slots: pmSlots,
        pmLiveness: liveness,
      };
    }),
  );

  return {
    freeMemoryBytes: freeBytes,
    pendingSignals: signals.length,
    activeSlots: slots.length,
    kickoffs: kickoffSummaries,
  };
}
