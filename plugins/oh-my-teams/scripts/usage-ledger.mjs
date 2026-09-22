/**
 * Launch ledger: which role was started where, when, and through which command.
 *
 * Provider session stores name a working directory and a time but never a
 * role, and neither an Orca terminal nor a headless worker leaves a lasting
 * record of the role it was opened for. Each launch command appends one line
 * here, beside the organization, so a usage report can later tell whose
 * session a transcript in a worktree was. The ledger is best-effort: a launch
 * that cannot be recorded still runs.
 */
import fs from "node:fs";
import path from "node:path";
import { assert, withFileLock } from "./core.mjs";
import { listKickoffs } from "./kickoff-registry.mjs";
import { pathWithin } from "./usage-sources.mjs";

/** Commands that append a launch line. */
export const LAUNCH_VIAS = Object.freeze([
  "role-terminal",
  "worker-start",
  "headless-start",
]);

const LOCK_ATTEMPTS = 40;
const LOCK_WAIT_MS = 25;

/**
 * Locates an organization's launch ledger.
 *
 * @param {string} orgFile - Organization JSON path.
 * @returns {string} `<organization dir>/usage/launches.jsonl`.
 */
export function ledgerFile(orgFile) {
  return path.join(
    path.dirname(path.resolve(orgFile)),
    "usage",
    "launches.jsonl",
  );
}

/**
 * Reads every launch line, skipping a line a crashed writer left incomplete.
 *
 * @param {string} orgFile - Organization JSON path.
 * @returns {object[]} Launch lines in the order they were appended.
 */
export function readLaunches(orgFile) {
  const file = ledgerFile(orgFile);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

/**
 * Provides a findLast method that reads the ledger backward indefinitely until
 * the predicate matches, avoiding loading the entire file into memory.
 *
 * @param {string} orgFile - Organization JSON path.
 * @returns {{findLast: Function}} Object duck-typing an array's findLast.
 */
export function lazyLaunchesBackward(orgFile) {
  return {
    findLast: (predicate) => {
      const file = ledgerFile(orgFile);
      if (!fs.existsSync(file)) return undefined;
      const fd = fs.openSync(file, "r");
      try {
        const stats = fs.fstatSync(fd);
        let position = stats.size;
        const chunkSize = 64 * 1024;
        let tail = "";
        while (position > 0) {
          const readSize = Math.min(chunkSize, position);
          position -= readSize;
          const buffer = Buffer.alloc(readSize);
          fs.readSync(fd, buffer, 0, readSize, position);
          const text = buffer.toString("utf8") + tail;
          const parts = text.split(/\r?\n/);
          tail = parts.shift() || "";
          for (let i = parts.length - 1; i >= 0; i -= 1) {
            const line = parts[i];
            if (line.trim()) {
              try {
                const entry = JSON.parse(line);
                if (predicate(entry)) return entry;
              } catch {}
            }
          }
        }
        if (tail.trim()) {
          try {
            const entry = JSON.parse(tail);
            if (predicate(entry)) return entry;
          } catch {}
        }
        return undefined;
      } finally {
        fs.closeSync(fd);
      }
    },
  };
}

function samePath(a, b) {
  return Boolean(a && b) && pathWithin(a, b) && pathWithin(b, a);
}

/**
 * Decides which running kickoff a launch belongs to.
 *
 * The state directory names the kickoff most directly. A launch run from
 * inside the PM worktree belongs to it too. A launch run from a worktree an
 * earlier launch of the kickoff opened, or from below it, belongs to the same kickoff, which is
 * how a PL's own launches are traced back through the PL's worktree.
 *
 * @param {object[]} kickoffs - Registry entries (`pm.worktreeId`, `pm.path`, `pm.stateDir`).
 * @param {object[]} launches - Earlier ledger lines.
 * @param {object} launch - `stateDir` and `callerCwd` of the new launch.
 * @returns {string | null} PM worktree id, or null when nothing ties it to one.
 */
export function resolveLaunchKickoff(kickoffs, launches, launch) {
  const byState = kickoffs.find((entry) =>
    samePath(launch.stateDir, entry.pm.stateDir),
  );
  if (byState) return byState.pm.worktreeId;
  const byCwd = kickoffs.find((entry) =>
    pathWithin(launch.callerCwd, entry.pm.path),
  );
  if (byCwd) return byCwd.pm.worktreeId;
  const active = new Set(kickoffs.map((entry) => entry.pm.worktreeId));
  const earlier = launches.findLast(
    (line) =>
      line.kickoffPmWorktreeId &&
      active.has(line.kickoffPmWorktreeId) &&
      pathWithin(launch.callerCwd, line.worktreePath),
  );
  return earlier?.kickoffPmWorktreeId ?? null;
}

// Launches from parallel roles may reach the ledger together; a short wait
// for the lock keeps one of them from being dropped as busy.
function withLedgerLock(file, callback) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return withFileLock(`${file}.lock`, callback, "Launch ledger busy");
    } catch (error) {
      if (error.message !== "Launch ledger busy" || attempt >= LOCK_ATTEMPTS)
        throw error;
      Atomics.wait(pause, 0, 0, LOCK_WAIT_MS);
    }
  }
}

/**
 * Appends one launch to the organization's ledger.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {object} launch - What was started.
 * @param {string} launch.via - One of `LAUNCH_VIAS`.
 * @param {string} launch.role - Role the launch holds.
 * @param {string | null} [launch.stateDir] - `--state` given to the command.
 * @param {string} [launch.callerCwd] - Directory the command ran from.
 * @param {string} [launch.handoffFrom] - Profile a handoff launch replaces.
 * @param {number} [launch.handoffIndex] - Handoff number of that task.
 * @param {string} [now] - Timestamp to record; the current time by default.
 * @returns {{recorded: true, file: string, line: object}} The stored line.
 * @throws {Error} When the ledger cannot be written.
 */
export function recordLaunch(orgFile, launch, now = new Date().toISOString()) {
  assert(
    LAUNCH_VIAS.includes(launch?.via),
    `Launch via must be one of: ${LAUNCH_VIAS.join(", ")}`,
  );
  assert(
    typeof launch.role === "string" && launch.role,
    "Launch role required",
  );
  const file = ledgerFile(orgFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLedgerLock(file, () => {
    const kickoffs = listKickoffs(orgFile).kickoffs;
    const callerCwd = path.resolve(launch.callerCwd ?? process.cwd());
    const line = {
      schemaVersion: 1,
      at: now,
      via: launch.via,
      role: launch.role,
      profile: launch.profile ?? null,
      provider: launch.provider ?? null,
      modelRequested: launch.modelRequested ?? null,
      effortRequested: launch.effortRequested ?? null,
      worktreePath: launch.worktreePath
        ? path.resolve(launch.worktreePath)
        : null,
      worktreeSelector: launch.worktreeSelector ?? null,
      terminal: launch.terminal ?? null,
      workerId: launch.workerId ?? null,
      callerCwd,
      workflowId: launch.workflowId ?? null,
      // A fallback profile that took a task over names the profile it
      // replaced, so a report does not count its work as the role's own.
      ...(launch.handoffFrom
        ? {
            handoffFrom: launch.handoffFrom,
            handoffIndex: launch.handoffIndex ?? null,
          }
        : {}),
      // worker-start records what it handed over, so the next hand-over to
      // the same terminal can tell a rework from a different task.
      ...(launch.via === "worker-start"
        ? {
            workflowTaskId: launch.workflowTaskId ?? null,
            orcaTaskId: launch.orcaTaskId ?? null,
            purpose: launch.purpose ?? null,
          }
        : {}),
      kickoffPmWorktreeId: resolveLaunchKickoff(
        kickoffs,
        lazyLaunchesBackward(orgFile),
        {
          stateDir: launch.stateDir ? path.resolve(launch.stateDir) : null,
          callerCwd,
        },
      ),
    };
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    return { recorded: true, file, line };
  });
}
