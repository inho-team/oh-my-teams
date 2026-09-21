/**
 * Resource slot management for shared heavy-work coordination.
 *
 * Multiple kickoffs share compute resources (test runners, workers, build
 * jobs). This module records slot acquisition and release atomically in the
 * owner project's `.omt/resources/` directory, checks a minimum free-memory
 * threshold, and reclaims slots whose owner process has exited.
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
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

/**
 * Reads reclaimable pages from `vm_stat` output as bytes.
 *
 * macOS keeps otherwise idle memory as file cache, so `os.freemem()` reports
 * only the free pages and stays far below what a new process can get. Free,
 * inactive and speculative pages are all handed out without swapping.
 *
 * @param {string} text - `vm_stat` output.
 * @returns {number | null} Available bytes, or null when the text is not vm_stat.
 */
export function parseVmStat(text) {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!pageSize) return null;
  let pages = 0;
  for (const label of ["free", "inactive", "speculative"]) {
    const match = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.`, "m").exec(text);
    if (!match) return null;
    pages += Number(match[1]);
  }
  return pages * pageSize;
}

/**
 * Reads `MemAvailable` from `/proc/meminfo` output as bytes.
 *
 * @param {string} text - `/proc/meminfo` contents.
 * @returns {number | null} Available bytes, or null when the field is absent.
 */
export function parseMeminfo(text) {
  const kib = /^MemAvailable:\s+(\d+) kB/m.exec(text)?.[1];
  return kib ? Number(kib) * 1024 : null;
}

/**
 * Reports memory a new process can obtain without swapping, in bytes.
 *
 * Uses `vm_stat` on macOS and `MemAvailable` on Linux, and falls back to
 * `os.freemem()` when neither can be read, as on Windows where it is accurate.
 *
 * @returns {number} Available bytes.
 */
export function availableMemory() {
  try {
    if (process.platform === "darwin") {
      const bytes = parseVmStat(
        execFileSync("vm_stat", { encoding: "utf8", timeout: 5000 }),
      );
      if (bytes !== null) return bytes;
    } else if (process.platform === "linux") {
      const bytes = parseMeminfo(fs.readFileSync("/proc/meminfo", "utf8"));
      if (bytes !== null) return bytes;
    }
  } catch {
    // Fall through to the portable figure.
  }
  return os.freemem();
}

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
 * @param {number} [request.ownerPid] - Long-lived process that owns the slot.
 *   Omitted, the owner is recorded as unknown (`pid: null`) and the slot is
 *   never reclaimed automatically; release it with `releaseResource`.
 * @param {Function} [request.freeMemory] - Injectable free-memory reporter (bytes).
 * @param {Function} [request.liveness] - Injectable liveness checker for reclaim.
 * @returns {{acquired: boolean, id: string, record: object, reclaimedIds: string[], warning?: string}} Result.
 * @throws {Error} When the kind is invalid, `ownerPid` is not a positive
 *   integer, the worktree is unknown, or free memory is below the threshold.
 */
export function acquireResource(orgFile, request) {
  assert(
    RESOURCE_KINDS.includes(request.kind),
    `Unknown resource kind: ${request.kind}`,
  );
  const ownerPid = request.ownerPid ?? null;
  assert(
    ownerPid === null || (Number.isInteger(ownerPid) && ownerPid > 0),
    `ownerPid must be a positive integer: ${request.ownerPid}`,
  );

  // Verify that the worktree is registered.
  const { kickoffs } = listKickoffs(path.resolve(orgFile));
  const entry = kickoffs.find((k) => k.pm.worktreeId === request.worktreeId);
  assert(
    entry,
    `Worktree ${request.worktreeId} is not registered in the kickoff registry`,
  );

  const checkFreeMemory = request.freeMemory ?? availableMemory;
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
      // An unknown owner cannot be shown dead, so its slot is never reclaimed.
      if (slot.pid === null) continue;
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
    // The slot's owner must outlive this CLI process, which exits right after
    // acquire. Recording the CLI's own PID would make every slot look dead at
    // the next acquire, so an omitted owner is recorded as unknown instead.
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
    const result = { acquired: true, id, record, reclaimedIds };
    if (ownerPid === null) {
      result.warning =
        "No ownerPid was given: the slot is never reclaimed automatically. " +
        `Release it with resource-release --slot ${id}, or acquire with --owner-pid.`;
    }
    return result;
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

// Orca reports each worker's liveness as `projection.liveness.verdict`, one of
// `live`, `exited` or `unverifiable` (for example
// `{"verdict":"live","observedAt":1789958205199,"source":"agent_status"}`).
// Any other value is not Orca's, so it is read as unverifiable.
const ORCA_LIVENESS = new Set(["live", "exited", "unverifiable"]);

// True when a worker-list entry belongs to the PM worktree. The workspace id
// is `<uuid>::<path>`, so the path must match whole, not as a substring that
// a sibling worktree such as `<path>-2` would also satisfy.
function inPmWorktree(worker, entry) {
  const ids = [worker.resource?.worktreeId, worker.projection?.workspace?.id];
  const pmPath = entry.pm?.path;
  return ids.some(
    (id) =>
      typeof id === "string" &&
      (id === entry.pm?.worktreeId ||
        id === pmPath ||
        (pmPath && id.endsWith(`::${pmPath}`))),
  );
}

/**
 * Reports the current PM liveness status for a kickoff registry entry.
 *
 * Uses Orca's `worker-list` and keeps Orca's own vocabulary. A failed query,
 * an unknown value, or a PM worktree with no entry is preserved as
 * `"unverifiable"`. The PM is `"live"` when any of its worktree's entries is
 * live, and `"exited"` only when every one of them has exited. The mere
 * presence of an entry never proves the PM alive.
 *
 * @param {object} entry - Kickoff registry entry.
 * @param {string} [orcaExecutable] - Orca binary path.
 * @param {Function} [execute=run] - Injectable command runner.
 * @returns {Promise<"live"|"exited"|"unverifiable">} PM liveness verdict.
 */
export async function queryPmLiveness(entry, orcaExecutable, execute = run) {
  const argv = [
    orcaExecutable ?? "orca",
    "orchestration",
    "worker-list",
    "--json",
  ];
  try {
    const result = await execute(argv, { timeoutMs: 8000 });
    if (result.code !== 0) return "unverifiable";
    const parsed = JSON.parse(result.stdout);
    // Orca answers `{result: {workers: [...]}}`; a bare array is accepted for
    // older Orca versions.
    const workers = Array.isArray(parsed) ? parsed : parsed?.result?.workers;
    if (!Array.isArray(workers)) return "unverifiable";
    const verdicts = workers
      .filter((worker) => inPmWorktree(worker, entry))
      .map((worker) => {
        const liveness = worker.projection?.liveness;
        const verdict = liveness?.verdict ?? liveness;
        return ORCA_LIVENESS.has(verdict) ? verdict : "unverifiable";
      });
    if (verdicts.includes("live")) return "live";
    if (verdicts.length > 0 && verdicts.every((v) => v === "exited")) {
      return "exited";
    }
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
  const checkFreeMemory = options.freeMemory ?? availableMemory;
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
