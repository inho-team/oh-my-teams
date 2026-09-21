/**
 * Structured signal channel between PM and Director.
 *
 * PM sends a signal record to the Director's inbox and optionally notifies
 * the Director's terminal. The Director reads, replies, and acknowledges
 * records through this module. All writes go through the atomic primitives
 * in core.mjs and are placed in the owner project's `.omt/director/inbox/`
 * directory.
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
import { readLaunches } from "./usage-ledger.mjs";

/** Signal kinds PM may send to the Director. */
export const SIGNAL_KINDS = Object.freeze([
  "decision",
  "close-ready",
  "blocked",
  "progress",
]);

// Directory that holds one JSON file per signal record.
function inboxDir(orgFile) {
  return path.join(ownerProject(orgFile), ".omt", "director", "inbox");
}

// Lock file for the inbox directory.
function inboxLock(orgFile) {
  return path.join(ownerProject(orgFile), ".omt", "director", ".inbox.lock");
}

// Looks up the registry entry for a PM worktree, throwing if absent.
function requireEntry(orgFile, worktreeId) {
  const { kickoffs } = listKickoffs(path.resolve(orgFile));
  const entry = kickoffs.find((k) => k.pm.worktreeId === worktreeId);
  assert(
    entry,
    `Worktree ${worktreeId} is not registered in the kickoff registry`,
  );
  return entry;
}

// Reads all JSON files from the inbox in deterministic name order.
function readInbox(orgFile) {
  return readJsonDirectory(inboxDir(orgFile));
}

/**
 * Sends a structured signal from a PM worktree to the Director's inbox.
 *
 * The record is written atomically inside the inbox lock. A duplicate is
 * rejected when a pending signal with the same kind, text, and worktreeId
 * already exists in the inbox; a `close-ready` counts as a duplicate only
 * when its head and source match too. A `progress` signal is informational
 * and is stored already acknowledged (`autoAcknowledged: true`), so it never
 * waits in the pending list. A new `close-ready` supersedes every older
 * pending `close-ready` from the same worktree.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {object} request - Signal request.
 * @param {string} request.worktreeId - PM worktree sending the signal.
 * @param {string} request.kind - One of SIGNAL_KINDS.
 * @param {string} request.text - Human-readable signal body.
 * @param {string} [request.head] - HEAD SHA for close-ready signals.
 * @param {string} [request.source] - Integration worktree path for close-ready.
 * @returns {{signaled: boolean, id: string, entry: object, record: object, superseded: string[]}} Result.
 * @throws {Error} When the kind is invalid, the worktree is unknown, or a
 *   duplicate pending signal exists.
 */
export function sendSignal(orgFile, request) {
  assert(
    SIGNAL_KINDS.includes(request.kind),
    `Unknown signal kind: ${request.kind}`,
  );
  const entry = requireEntry(orgFile, request.worktreeId);
  const text = String(request.text ?? "").trim();
  assert(text, "Signal text is required");

  return withFileLock(inboxLock(orgFile), () => {
    const head = request.head !== undefined ? String(request.head) : undefined;
    const source =
      request.source !== undefined ? String(request.source) : undefined;
    const existing = readInbox(orgFile);
    const pendingSame = existing.filter(
      (r) =>
        r.status === "pending" &&
        r.kind === request.kind &&
        r.worktreeId === request.worktreeId,
    );
    // A close-ready for a new integration HEAD may repeat the same text; it
    // replaces the older one below instead of being refused.
    const duplicate = pendingSame.some(
      (r) =>
        r.text === text &&
        (request.kind !== "close-ready" ||
          (r.head === head && r.source === source)),
    );
    assert(
      !duplicate,
      `Duplicate pending ${request.kind} signal with the same text already exists`,
    );

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const record = {
      schemaVersion: 1,
      id,
      worktreeId: request.worktreeId,
      kind: request.kind,
      text,
      ...(request.kind === "progress"
        ? {
            status: "acknowledged",
            autoAcknowledged: true,
            acknowledgedAt: now,
          }
        : { status: "pending" }),
      sentAt: now,
      ...(head !== undefined ? { head } : {}),
      ...(source !== undefined ? { source } : {}),
    };

    writeJSON(path.join(inboxDir(orgFile), `${id}.json`), record);
    const superseded = [];
    if (request.kind === "close-ready") {
      for (const older of pendingSame) {
        writeJSON(path.join(inboxDir(orgFile), `${older.id}.json`), {
          ...older,
          status: "superseded",
          supersededBy: id,
          supersededAt: now,
        });
        superseded.push(older.id);
      }
    }
    return { signaled: true, id, entry, record, superseded };
  });
}

/**
 * Closes the pending signals of a kickoff that has been released.
 *
 * A released kickoff has no PM left to answer, so its pending signals would
 * otherwise stay in the inbox forever. Signals of other kickoffs are untouched.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree of the released kickoff.
 * @param {string} reason - Release reason recorded on each closed signal.
 * @returns {{closed: string[]}} IDs of the signals that were closed.
 */
export function closeKickoffSignals(orgFile, worktreeId, reason) {
  if (!fs.existsSync(inboxDir(orgFile))) return { closed: [] };
  return withFileLock(inboxLock(orgFile), () => {
    const closedAt = new Date().toISOString();
    const closed = [];
    for (const record of readInbox(orgFile)) {
      if (record.status !== "pending" || record.worktreeId !== worktreeId) {
        continue;
      }
      writeJSON(path.join(inboxDir(orgFile), `${record.id}.json`), {
        ...record,
        status: "closed",
        closedBy: "kickoff-release",
        closedReason: reason,
        closedAt,
      });
      closed.push(record.id);
    }
    return { closed };
  });
}

/**
 * Delivers a terminal notification to the Director after writing the signal.
 *
 * Call after `sendSignal`. When Orca delivery fails, the result carries
 * `notifyError` and `notified: false`; the record on disk is unaffected.
 *
 * @param {object} entry - Kickoff registry entry.
 * @param {object} record - Signal record returned by `sendSignal`.
 * @param {string} [orcaExecutable] - Orca binary path.
 * @returns {Promise<{notified: boolean, notifyError?: string}>} Notification result.
 */
export async function notifyDirector(entry, record, orcaExecutable) {
  const handle = entry.director?.terminalHandle;
  if (!handle) return { notified: false };
  const argv = [
    orcaExecutable ?? "orca",
    "terminal",
    "send",
    "--terminal",
    handle,
    "--text",
    `[omt] ${record.kind} from ${record.worktreeId}: ${record.text}`,
    "--enter",
  ];
  try {
    const result = await run(argv, { timeoutMs: 10000 });
    if (result.code !== 0) {
      return {
        notified: false,
        notifyError: result.stderr.trim() || `exit ${result.code}`,
      };
    }
    return { notified: true };
  } catch (error) {
    return { notified: false, notifyError: error.message };
  }
}

/**
 * Lists pending (unprocessed) signals in the Director's inbox.
 *
 * `progress` signals are stored acknowledged and superseded or closed signals
 * are settled, so none of them appear here.
 *
 * @param {string} orgFile - Organization JSON path.
 * @returns {{signals: object[]}} Pending signal records in filename order.
 */
export function listInbox(orgFile) {
  const all = readInbox(orgFile);
  return { signals: all.filter((r) => r.status === "pending") };
}

/**
 * Records the Director's reply on a signal and attempts PM terminal delivery.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {object} request - Reply request.
 * @param {string} request.signalId - Signal ID to reply to.
 * @param {string} request.text - Director's decision text.
 * @param {string} [request.orcaExecutable] - Orca binary for PM notification.
 * @param {Function} [request.listTerminals] - Injectable async lister returning
 *   Orca terminal records (`handle`, `title`, `worktreePath`), for tests.
 * @returns {Promise<{replied: boolean, record: object, notified: boolean, notifyError?: string, pmTerminal?: string}>}
 * @throws {Error} When the signal is not found or is not in pending status.
 */
export async function replySignal(orgFile, request) {
  const text = String(request.text ?? "").trim();
  assert(text, "Reply text is required");

  let updated;
  withFileLock(inboxLock(orgFile), () => {
    const file = path.join(inboxDir(orgFile), `${request.signalId}.json`);
    assert(fs.existsSync(file), `Signal ${request.signalId} not found`);
    const record = readJSON(file);
    assert(
      record.status === "pending",
      `Signal ${request.signalId} is already ${record.status}`,
    );
    updated = {
      ...record,
      status: "replied",
      reply: text,
      repliedAt: new Date().toISOString(),
    };
    writeJSON(file, updated);
  });

  // PM terminal notification. The kickoff registry does not store the PM's
  // terminal handle, because a PM can be relaunched in a new terminal. The
  // handle comes from the latest PM launch that role-terminal recorded for the
  // PM worktree, and is used only while Orca still lists that terminal in the
  // same worktree. A miss leaves the reply in the signal record, which the PM
  // reads through director-inbox, and is reported as notified: false.
  let notified = false;
  let notifyError;
  let pmTerminal;
  try {
    const { kickoffs } = listKickoffs(orgFile, updated.worktreeId);
    const entry = kickoffs[0];
    const orcaExec = request.orcaExecutable ?? "orca";
    pmTerminal =
      entry?.pm?.terminalHandle ??
      (entry?.pm?.path
        ? await findPmTerminal(orgFile, entry.pm.path, {
            orcaExecutable: orcaExec,
            listTerminals: request.listTerminals,
          })
        : undefined);
    if (pmTerminal) {
      const argv = [
        orcaExec,
        "terminal",
        "send",
        "--terminal",
        pmTerminal,
        "--text",
        `[omt reply] ${updated.reply}`,
        "--enter",
      ];
      const result = await run(argv, { timeoutMs: 10000 });
      if (result.code === 0) {
        notified = true;
      } else {
        notifyError = result.stderr.trim() || `exit ${result.code}`;
      }
    } else {
      notifyError = "no-pm-terminal-found";
    }
  } catch (error) {
    notifyError = error.message;
  }

  return {
    replied: true,
    record: updated,
    notified,
    ...(pmTerminal ? { pmTerminal } : {}),
    ...(notifyError ? { notifyError } : {}),
  };
}

// Lists Orca terminals as plain records; any failure yields an empty list so
// that a missing Orca only skips notification.
async function orcaTerminals(orcaExecutable) {
  const result = await run([orcaExecutable, "terminal", "list", "--json"], {
    timeoutMs: 10000,
  });
  if (result.code !== 0) return [];
  const payload = JSON.parse(result.stdout);
  const listed = payload?.result?.terminals ?? payload?.terminals ?? payload;
  return Array.isArray(listed) ? listed : [];
}

/**
 * Finds the Orca terminal currently running the PM of a PM worktree.
 *
 * The agent inside a terminal rewrites its title, so the `[PM]` tag is not a
 * reliable marker; the launch ledger records which terminal role-terminal
 * opened for the PM. The latest such launch wins, and it counts only while
 * Orca still lists that terminal in the same worktree.
 *
 * @param {string} orgFile - Organization JSON path whose ledger is read.
 * @param {string} pmPath - PM worktree path recorded in the kickoff registry.
 * @param {object} [options] - `orcaExecutable`, or an injectable `listTerminals`.
 * @returns {Promise<string | undefined>} The terminal handle, or undefined.
 */
export async function findPmTerminal(orgFile, pmPath, options = {}) {
  const target = path.resolve(pmPath);
  const launch = readLaunches(orgFile)
    .filter(
      (record) =>
        record.role === "pm" &&
        typeof record.terminal === "string" &&
        typeof record.worktreePath === "string" &&
        path.resolve(record.worktreePath) === target,
    )
    .at(-1);
  if (!launch) return undefined;
  const list =
    options.listTerminals ??
    (() => orcaTerminals(options.orcaExecutable ?? "orca"));
  const live = (await list()).some(
    (terminal) =>
      terminal?.handle === launch.terminal &&
      typeof terminal.worktreePath === "string" &&
      path.resolve(terminal.worktreePath) === target,
  );
  return live ? launch.terminal : undefined;
}

/**
 * Marks a signal as acknowledged without adding a text reply.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} signalId - Signal ID to acknowledge.
 * @returns {{acknowledged: boolean, record: object}} Updated record.
 * @throws {Error} When the signal is not found or is already acknowledged.
 */
export function acknowledgeSignal(orgFile, signalId) {
  let updated;
  withFileLock(inboxLock(orgFile), () => {
    const file = path.join(inboxDir(orgFile), `${signalId}.json`);
    assert(fs.existsSync(file), `Signal ${signalId} not found`);
    const record = readJSON(file);
    assert(
      record.status !== "acknowledged",
      `Signal ${signalId} is already acknowledged`,
    );
    updated = {
      ...record,
      status: "acknowledged",
      acknowledgedAt: new Date().toISOString(),
    };
    writeJSON(file, updated);
  });
  return { acknowledged: true, record: updated };
}

/**
 * Reads a specific signal record by ID.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} signalId - Signal ID to look up.
 * @returns {object} The signal record.
 * @throws {Error} When the file cannot be read or parsed.
 */
export function readSignal(orgFile, signalId) {
  return readJSON(path.join(inboxDir(orgFile), `${signalId}.json`));
}

/**
 * Returns the most recent close-ready signal for a PM worktree.
 *
 * Used by close to obtain the integration worktree path and HEAD SHA. A
 * signal superseded by a newer close-ready is ignored. Returns `undefined`
 * when no close-ready signal exists for the given worktree.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree whose close-ready record to find.
 * @returns {object|undefined} Signal record or undefined.
 */
export function findCloseReadySignal(orgFile, worktreeId) {
  const all = readInbox(orgFile);
  const candidates = all.filter(
    (r) =>
      r.worktreeId === worktreeId &&
      r.kind === "close-ready" &&
      r.status !== "superseded",
  );
  candidates.sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));
  return candidates[0];
}

// Hostname used to determine whether a process is local.
const THIS_HOST = os.hostname();

/**
 * Checks whether the process that owns a resource slot is still alive.
 *
 * Returns `"alive"`, `"dead"`, or `"unverifiable"` when the host does not
 * match or the liveness query fails.
 *
 * @param {{pid: number, hostname: string}} owner - Lock owner record.
 * @returns {"alive"|"dead"|"unverifiable"} Liveness verdict.
 */
export function processLiveness(owner) {
  if (!owner || typeof owner.pid !== "number" || owner.hostname !== THIS_HOST) {
    return "unverifiable";
  }
  try {
    process.kill(owner.pid, 0);
    return "alive";
  } catch (error) {
    return error.code === "ESRCH" ? "dead" : "unverifiable";
  }
}
