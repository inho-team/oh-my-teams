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
import { classifyPromptScreen } from "./prompt-answers.mjs";
import { deliverPrompt, readTerminalScreen } from "./prompt-submission.mjs";
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

// Directory that holds one JSON file per independent delivery receipt.
function deliveriesDir(orgFile) {
  return path.join(ownerProject(orgFile), ".omt", "director", "deliveries");
}

// Lock file for the deliveries directory.
function deliveriesLock(orgFile) {
  return path.join(
    ownerProject(orgFile),
    ".omt",
    "director",
    ".deliveries.lock",
  );
}

// Reads all JSON files from the deliveries directory in deterministic name order.
function readDeliveries(orgFile) {
  return readJsonDirectory(deliveriesDir(orgFile));
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
    // Signals sent within one millisecond share sentAt, so a sequence taken
    // under the inbox lock orders them; records written before it count as 0.
    const seq = Math.max(0, ...existing.map((r) => r.seq ?? 0)) + 1;
    const record = {
      schemaVersion: 1,
      id,
      seq,
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

// Sends one notification into a terminal and keeps how far it got. Before
// anything is typed, the terminal's agentIdentity is verified using
// `orca terminal list --json` (via `orcaTerminals`, the same list-parsing
// `findPmTerminal` uses, so the two never diverge on what counts as a
// terminal record) to confirm it is an agent session. Only a non-empty string
// agentIdentity counts as an agent session; `null` means a shell-only
// terminal, and anything else (the field absent, the handle missing from the
// list, the list itself unreadable, a non-string, or an empty string) cannot
// be judged. Both cases defer the notification without sending anything and
// record a notifyError: `shell-terminal` for the former, and
// `terminal-identity-unknown` for the latter. Once the terminal is confirmed
// to be an agent session, the terminal's own screen is read with
// `readTerminalScreen` (reused from prompt-submission.mjs, so the two modules
// never diverge on what counts as "the screen could not be read") and
// classified with `classifyPromptScreen` (reused from prompt-answers.mjs, no
// new screen judgement): a folder-trust question or a Claude
// `AskUserQuestion` screen means the terminal cannot safely take this input,
// and an unreadable screen means the state cannot be judged at all, so both
// come back `deferred: true, sent: false` without a single key being sent.
// Only once the screen is clear does the existing accepted-vs-submitted
// judgement in `deliverPrompt` run; from that point on `sent` is true
// regardless of the outcome, because a call that reaches `deliverPrompt` may
// already have typed the text before failing or going unconfirmed, and a
// caller must not treat "not proven delivered" as "safe to retry from
// scratch". `notified` is true only once the input was submitted or is
// already being handled, so an input Orca merely accepted is not reported as
// delivered. Orca's own error text and warnings are kept as they came, and
// nothing is sent twice.
async function notifyTerminal(orca, terminal, text, execute) {
  let terminalRecord;
  try {
    const terminals = await orcaTerminals(orca, execute);
    terminalRecord = terminals.find((t) => t?.handle === terminal);
  } catch {
    terminalRecord = undefined;
  }

  if (!terminalRecord) {
    return {
      notified: false,
      deferred: true,
      sent: false,
      notifyError: "terminal-identity-unknown",
    };
  }

  const identity = terminalRecord.agentIdentity;
  if (identity === null) {
    return {
      notified: false,
      deferred: true,
      sent: false,
      notifyError: "shell-terminal",
    };
  }

  if (typeof identity !== "string" || identity === "") {
    return {
      notified: false,
      deferred: true,
      sent: false,
      notifyError: "terminal-identity-unknown",
    };
  }

  const screen = await readTerminalScreen(orca, terminal, execute);
  if (!screen.ok) {
    return {
      notified: false,
      deferred: true,
      sent: false,
      notifyError: "screen-unavailable",
    };
  }
  const asked = classifyPromptScreen(screen.lines);
  if (asked.kind === "trust" || asked.kind === "user-question") {
    return {
      notified: false,
      deferred: true,
      sent: false,
      notifyError: `blocked-by-${asked.kind}`,
    };
  }
  const result = await deliverPrompt({ orca, terminal, text, execute });
  const { delivered, error, ...delivery } = result;
  return {
    notified: delivered,
    sent: true,
    ...(delivered ? {} : { notifyError: error ?? result.reason }),
    delivery,
  };
}

/**
 * Delivers a terminal notification to the Director after writing the signal.
 *
 * Call after `sendSignal`. Before anything is sent, the Director's terminal is
 * checked to confirm it is an agent session (using `orca terminal list --json`
 * to inspect `agentIdentity`). If the terminal is a shell (agentIdentity is
 * null) or the identity cannot be determined, the notification is deferred
 * (`notified: false, deferred: true`) without pressing a single key. Once the
 * terminal is confirmed to be an agent session, the Director's screen is read
 * and classified: a folder-trust question or an `AskUserQuestion` screen, or a
 * screen that cannot be read at all, defers the notification without pressing
 * a single key. Once the screen is clear, the notification counts as delivered
 * only when the Director's agent started its turn or took the input; an input
 * Orca accepted but nobody submitted comes back as `notified: false`. `delivery`
 * carries the outcome, the receipt stages and the request ID, and `notifyError`
 * keeps Orca's own error text, with `shell-terminal` for shell-only terminals
 * and `terminal-identity-unknown` for indeterminable terminals. The text is
 * never sent a second time: the follow-up calls replay the same request ID, and
 * one bare Enter follows only when the text is seen waiting in the input box.
 * The record on disk is unaffected; `notifyDirectorSignal` is the entry point
 * that also persists and retries.
 *
 * @param {object} entry - Kickoff registry entry.
 * @param {object} record - Signal record returned by `sendSignal`.
 * @param {string} [orcaExecutable] - Orca binary path.
 * @param {Function} [execute] - Injectable command runner.
 * @returns {Promise<{notified: boolean, deferred?: boolean, sent?: boolean, notifyError?: string, delivery?: object}>} Notification result.
 */
export async function notifyDirector(
  entry,
  record,
  orcaExecutable,
  execute = run,
) {
  const handle = entry.director?.terminalHandle;
  if (!handle) return { notified: false };
  return notifyTerminal(
    orcaExecutable ?? "orca",
    handle,
    `[omt] ${record.kind} from ${record.worktreeId}: ${record.text}`,
    execute,
  );
}

// Signals for a worktree that have not yet reached the Director's terminal: a
// pending decision/blocked/close-ready, or a progress signal (auto-acknowledged
// on arrival, so `status` alone would hide it), whose last notification attempt
// did not confirm delivery *and* never actually typed anything (`notify.sent`
// is not `true`). A signal `notifyTerminal` had to defer before calling
// `deliverPrompt` (screen unreadable or blocked by a question) stays eligible
// here; one where `deliverPrompt` ran but came back unsubmitted, unclear,
// foreign-input, or failed is not, because resending it could run the same
// work twice if the original keys did in fact reach the agent. A signal
// `claimBatch` found claimed by an owner it could prove dead is settled the
// same way, for the same reason (see `finalizeUnconfirmedClaim`). Either kind
// stays pending and keeps showing up in director-inbox, just never
// auto-bundled again. A signal the Director already replied to or
// acknowledged by hand is left out too, since that already proves it was seen.
function undeliveredSignals(orgFile, worktreeId) {
  return readInbox(orgFile).filter(
    (record) =>
      record.worktreeId === worktreeId &&
      (record.status === "pending" || record.autoAcknowledged === true) &&
      record.notify?.notified !== true &&
      record.notify?.sent !== true,
  );
}

// Stamps every record of a notification attempt with its outcome, so a
// signal already confirmed delivered is never retried, and one still deferred
// keeps waiting for the next attempt (unless `sent` is true — see
// `undeliveredSignals`). This also clears any claim `claimBatch` left on the
// record, since `notify` is replaced outright. Records superseded or closed
// since the attempt started are left untouched.
function recordNotifyOutcome(orgFile, records, outcome) {
  withFileLock(inboxLock(orgFile), () => {
    for (const record of records) {
      const file = path.join(inboxDir(orgFile), `${record.id}.json`);
      if (!fs.existsSync(file)) continue;
      writeJSON(file, {
        ...readJSON(file),
        notify: outcome.notified
          ? { notified: true, notifiedAt: outcome.at }
          : {
              notified: false,
              sent: outcome.sent === true,
              deferredAt: outcome.at,
              ...(outcome.notifyError
                ? { notifyError: outcome.notifyError }
                : {}),
            },
      });
    }
  });
}

// Claims every signal `notifyDirectorSignal` is about to try to deliver: the
// undelivered backlog plus the signal just written, both read fresh from disk
// (not from the `record` argument alone) so this call also sees a claim an
// overlapping call already placed on that very signal — e.g. one started
// while an earlier call is still inside `deliverPrompt`'s wait-submit window.
// A signal already claimed by an owner that is alive or cannot be judged
// (`processLiveness` returns anything but `"dead"`) is left exactly as it is:
// still claimed, not resent, and not counted as claimable, per "when it
// cannot be judged, do not send". This is what keeps two overlapping live
// calls for the same worktree from both sending the same content (see the
// "overlaps the first" test) — and, unlike the previous all-or-nothing
// version, it no longer holds back the rest of the batch: the signal just
// written and any other backlog signal that is not itself stuck this way are
// claimed and sent normally, so one signal parked under an owner this host
// can never prove dead (for instance, one recorded on a different host, since
// `processLiveness` always reports a foreign hostname as "unverifiable") only
// ever stalls that one signal, not the whole worktree's notifications.
//
// A signal claimed by an owner `processLiveness` *can* prove dead is handled
// differently again: `finalizeUnconfirmedClaim` settles it in place rather
// than reclaiming it for a fresh send, because the same crash-window gap
// `notifyTerminal` already lives with (see its own comment) makes "the prior
// attempt already typed this text" indistinguishable from "it never ran" —
// resending here would risk the very double-send this whole scheme exists to
// avoid. Claiming and the terminal I/O that follows are deliberately not one
// lock hold: holding the inbox lock across a send would also block
// `sendSignal`, which needs the same lock just to record a new signal.
// Instead the claim records this process as the owner (pid + hostname, same
// shape `processLiveness` already reads for resources.mjs's dead-owner slot
// reclaim) and `recordNotifyOutcome` clears it again once the attempt is
// over, whatever it decided.
//
// Returns `null`, writing nothing but any dead-owner finalization above, when
// nothing in the batch is claimable — e.g. the signal just written was itself
// already swept into a still-live overlapping call's claim.
function claimBatch(orgFile, worktreeId, record) {
  return withFileLock(inboxLock(orgFile), () => {
    const pending = undeliveredSignals(orgFile, worktreeId);
    const batch = pending.some((item) => item.id === record.id)
      ? pending
      : [...pending, record];
    const claimedAt = new Date().toISOString();
    const claimable = [];
    for (const item of batch) {
      if (item.notify?.inFlight !== true) {
        claimable.push(item);
        continue;
      }
      if (processLiveness(item.notify.owner) === "dead") {
        finalizeUnconfirmedClaim(orgFile, item.id, claimedAt);
      }
      // "alive" or "unverifiable": leave the existing claim exactly as it is.
    }
    if (claimable.length === 0) return null;
    const owner = { pid: process.pid, hostname: THIS_HOST };
    for (const item of claimable) {
      const file = path.join(inboxDir(orgFile), `${item.id}.json`);
      if (!fs.existsSync(file)) continue;
      writeJSON(file, {
        ...readJSON(file),
        notify: { inFlight: true, claimedAt, owner },
      });
    }
    return claimable;
  });
}

// Settles a signal whose in-flight claim belongs to an owner `processLiveness`
// can prove dead, instead of reclaiming it into a fresh send attempt. The
// owner may have crashed strictly between `deliverPrompt` typing the text and
// `recordNotifyOutcome` persisting that fact (the same residual gap
// `notifyTerminal` documents), which makes this signal indistinguishable from
// one already sent, so it is recorded the same way `notifyTerminal` records
// an attempt it could not confirm (`sent: true, notified: false`) rather than
// tried again. `undeliveredSignals` already treats that shape as settled, so
// this permanently drops the signal out of the auto-resend backlog; a
// `decision`/`blocked`/`close-ready` record stays `pending` regardless and
// keeps showing in director-inbox and director-watch, and the Director can
// tell this case apart from an ordinary unconfirmed attempt by its
// `notifyError`. Called from inside `claimBatch`'s own lock hold, so it writes
// directly instead of re-acquiring a lock it already holds.
function finalizeUnconfirmedClaim(orgFile, id, at) {
  const file = path.join(inboxDir(orgFile), `${id}.json`);
  if (!fs.existsSync(file)) return;
  writeJSON(file, {
    ...readJSON(file),
    notify: {
      notified: false,
      sent: true,
      deferredAt: at,
      notifyError: "owner-exited-before-confirming",
    },
  });
}

/**
 * Delivers a signal to the Director's terminal together with every earlier
 * signal for the same PM worktree that has not yet reached it (a decision,
 * `blocked`, or `close-ready` still pending, or a `progress` signal never
 * confirmed delivered — and never one `deliverPrompt` already attempted, see
 * `undeliveredSignals`), bundled into one message. This is the resend path
 * for a signal `notifyDirector` had to defer: call it again from
 * `director-signal` the next time that Director is signalled, and once its
 * terminal is confirmed to be an agent session and its screen is no longer
 * blocked by a question, the whole backlog goes out together. If the
 * terminal is a shell (agentIdentity is null) or the identity cannot be
 * determined, signals stay deferred with `notifyError: "shell-terminal"` or
 * `"terminal-identity-unknown"`. A signal is marked delivered only once
 * `notified` comes back true, so it is never sent twice; a deferred attempt
 * leaves every record in the batch exactly as undelivered as it already was.
 * `claimBatch` also guards against two overlapping calls for the same
 * worktree both sending: a signal an overlapping live call already claimed is
 * left out of this call's batch instead of being resent, and if that leaves
 * nothing claimable at all (e.g. this very signal was itself swept into the
 * other call's claim), the result is `deferred: true, notifyError:
 * "backlog-claimed"` without touching the terminal. A signal claimed by an
 * owner this host can prove dead is settled in place (never resent, see
 * `finalizeUnconfirmedClaim`) rather than blocking the rest of the batch, so
 * one signal parked under a stuck or unverifiable claim never stalls the other
 * signals in it.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {object} entry - Kickoff registry entry naming the Director terminal.
 * @param {object} record - Signal record just written by `sendSignal`.
 * @param {string} [orcaExecutable] - Orca binary path.
 * @param {Function} [execute] - Injectable command runner.
 * @returns {Promise<{notified: boolean, deferred?: boolean, sent?: boolean, notifyError?: string, delivery?: object, bundled: string[]}>}
 *   Notification result; `bundled` lists every signal id the message actually
 *   carried (empty when nothing in the batch was claimable).
 */
export async function notifyDirectorSignal(
  orgFile,
  entry,
  record,
  orcaExecutable,
  execute = run,
) {
  const handle = entry.director?.terminalHandle;
  if (!handle) return { notified: false, bundled: [] };
  const batch = claimBatch(orgFile, record.worktreeId, record);
  if (!batch) {
    return {
      notified: false,
      deferred: true,
      notifyError: "backlog-claimed",
      bundled: [],
    };
  }
  const text = batch
    .map((item) => `[omt] ${item.kind} from ${item.worktreeId}: ${item.text}`)
    .join("\n");
  const sent = await notifyTerminal(
    orcaExecutable ?? "orca",
    handle,
    text,
    execute,
  );
  recordNotifyOutcome(orgFile, batch, {
    notified: sent.notified,
    sent: sent.sent,
    notifyError: sent.notifyError,
    at: new Date().toISOString(),
  });
  return { ...sent, bundled: batch.map((item) => item.id) };
}

/**
 * Lists pending (unprocessed) signals in the Director's inbox and unacknowledged
 * independent worktree delivery receipts.
 *
 * `progress` signals are stored acknowledged and superseded or closed signals
 * are settled, so none of them appear here.
 *
 * @param {string} orgFile - Organization JSON path.
 * @returns {{signals: object[], deliveries: object[]}} Pending signal records and unacknowledged deliveries.
 */
export function listInbox(orgFile) {
  const all = readInbox(orgFile);
  const { deliveries } = listDeliveries(orgFile, { unacknowledgedOnly: true });
  return {
    signals: all.filter((r) => r.status === "pending"),
    deliveries,
  };
}

/**
 * Records the Director's reply on a signal and attempts PM terminal delivery.
 *
 * The reply is always recorded on the signal file immediately, regardless of
 * notification outcome, so it remains readable through director-inbox. The PM
 * terminal is found from the launch ledger (if the PM was launched in a new
 * terminal since the signal was written, it may not be located). Before
 * sending, the PM terminal is confirmed to be an agent session (using
 * agentIdentity); if the terminal is a shell or the identity cannot be
 * determined, the reply is left in the signal record and `notified: false` is
 * returned along with a notifyError. The signal record remains updated with
 * the reply text, so the PM can read it through director-inbox even if the
 * terminal notification fails.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {object} request - Reply request.
 * @param {string} request.signalId - Signal ID to reply to.
 * @param {string} request.text - Director's decision text.
 * @param {string} [request.orcaExecutable] - Orca binary for PM notification.
 * @param {Function} [request.listTerminals] - Injectable async lister returning
 *   Orca terminal records (`handle`, `title`, `worktreePath`), for tests.
 * @param {Function} [request.execute] - Injectable command runner for the PM notification.
 * @returns {Promise<{replied: boolean, record: object, notified: boolean, notifyError?: string, pmTerminal?: string, delivery?: object}>}
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
  let delivery;
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
      const sent = await notifyTerminal(
        orcaExec,
        pmTerminal,
        `[omt reply] ${updated.reply}`,
        request.execute ?? run,
      );
      notified = sent.notified;
      notifyError = sent.notifyError;
      delivery = sent.delivery;
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
    ...(delivery ? { delivery } : {}),
  };
}

// Lists Orca terminals as plain records; any failure yields an empty list so
// that a missing Orca only skips notification. `execute` is the same
// injectable command runner every other Orca call in this module takes, so
// `notifyTerminal` and `findPmTerminal` parse one terminal-list response the
// same way instead of each keeping its own copy.
async function orcaTerminals(orcaExecutable, execute = run) {
  const result = await execute([orcaExecutable, "terminal", "list", "--json"], {
    timeoutMs: 10000,
  });
  if (result.code !== 0) return [];
  const payload = JSON.parse(result.stdout);
  const listed = payload?.result?.terminals ?? payload?.terminals ?? payload;
  return Array.isArray(listed) ? listed : [];
}

/**
 * Finds the most recent recorded launch of the PM in a PM worktree.
 *
 * The launch ledger is the only record of what a PM terminal was actually
 * opened with (`role-terminal`'s `provider` field, fixed at launch time), as
 * opposed to the organization's current `pm` profile, which a fallback can
 * change afterward. Callers that need to know the PM's provider, not just its
 * terminal, read this record rather than assume the organization's present
 * configuration still describes what is running.
 *
 * @param {string} orgFile - Organization JSON path whose ledger is read.
 * @param {string} pmPath - PM worktree path recorded in the kickoff registry.
 * @returns {object | undefined} The latest matching launch line, or undefined.
 */
export function findPmLaunch(orgFile, pmPath) {
  const target = path.resolve(pmPath);
  return readLaunches(orgFile)
    .filter(
      (record) =>
        record.role === "pm" &&
        typeof record.terminal === "string" &&
        typeof record.worktreePath === "string" &&
        path.resolve(record.worktreePath) === target,
    )
    .at(-1);
}

/**
 * Finds the Orca terminal currently running the PM of a PM worktree.
 *
 * The agent inside a terminal rewrites its title, so the `[PM]` tag is not a
 * reliable marker; the launch ledger records which terminal role-terminal
 * opened for the PM ({@link findPmLaunch}). The latest such launch wins, and
 * it counts only while Orca still lists that terminal in the same worktree.
 *
 * @param {string} orgFile - Organization JSON path whose ledger is read.
 * @param {string} pmPath - PM worktree path recorded in the kickoff registry.
 * @param {object} [options] - `orcaExecutable`, or an injectable `listTerminals`.
 * @returns {Promise<string | undefined>} The terminal handle, or undefined.
 */
export async function findPmTerminal(orgFile, pmPath, options = {}) {
  const target = path.resolve(pmPath);
  const launch = findPmLaunch(orgFile, pmPath);
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
 * @param {object} [options] - Optional caller options for delivery acknowledgement.
 * @returns {{acknowledged: boolean, record: object}} Updated record.
 * @throws {Error} When the signal is not found or is already acknowledged.
 */
export function acknowledgeSignal(orgFile, signalId, options = {}) {
  let updated;
  withFileLock(inboxLock(orgFile), () => {
    const file = path.join(inboxDir(orgFile), `${signalId}.json`);
    if (fs.existsSync(file)) {
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
      return;
    }
    const deliveryFile = path.join(deliveriesDir(orgFile), `${signalId}.json`);
    if (fs.existsSync(deliveryFile)) {
      return;
    }
    assert(false, `Signal ${signalId} not found`);
  });
  const deliveryFile = path.join(deliveriesDir(orgFile), `${signalId}.json`);
  if (fs.existsSync(deliveryFile)) {
    return acknowledgeDelivery(orgFile, signalId, options);
  }
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
  candidates.sort(
    (a, b) =>
      (b.seq ?? 0) - (a.seq ?? 0) ||
      String(b.sentAt).localeCompare(String(a.sentAt)),
  );
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

/**
 * Records an independent Orca worktree completion delivery receipt and attempts
 * Director terminal notification.
 *
 * Persists the source worktree, 40-character commit HEAD, PR URL or delivery target,
 * Director terminal handle, send outcome, and unacknowledged status. Reuses existing
 * Orca adapters and terminal safeguards. Repeated requests for the same source and HEAD
 * are idempotent: if already acknowledged or successfully notified, prompts are not
 * resent and records are not duplicated; stale or failed deliveries are safely updated
 * in place.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {object} request - Delivery receipt request.
 * @param {string} request.source - Source worktree directory or identifier.
 * @param {string} request.head - Full 40-character commit SHA.
 * @param {string} [request.pr] - Pull request URL.
 * @param {string} [request.target] - Delivery target (defaults to pr if omitted).
 * @param {string} request.directorTerminal - Explicit Director terminal handle.
 * @param {string} [request.text] - Optional summary or note.
 * @param {string} [request.orcaExecutable] - Optional Orca executable path.
 * @param {Function} [request.execute] - Optional command runner.
 * @param {object} [options] - Injectable options for testing.
 * @param {string} [options.orcaExecutable] - Orca binary path.
 * @param {Function} [options.execute] - Injectable command runner.
 * @returns {Promise<{delivered: boolean, replayed?: boolean, retried?: boolean, duplicate?: boolean, inFlight?: boolean, record: object}>}
 *   Delivery result and persisted record.
 * @throws {Error} When source, head, target, or directorTerminal is missing or invalid.
 */
export async function recordDeliveryReceipt(orgFile, request, options = {}) {
  const source = String(request?.source ?? "").trim();
  assert(source.length > 0, "Delivery source worktree is required");

  const head = String(request?.head ?? "").trim();
  assert(
    /^[0-9a-f]{40}$/i.test(head),
    `Full commit HEAD (40-character hex SHA) is required: got ${request?.head}`,
  );

  const target = String(request?.pr ?? request?.target ?? "").trim();
  assert(target.length > 0, "Delivery PR URL or target is required");

  const directorTerminal = String(request?.directorTerminal ?? "").trim();
  assert(
    directorTerminal.length > 0,
    "Explicit director terminal target is required for independent delivery receipt",
  );

  const text =
    request?.text !== undefined ? String(request.text).trim() : undefined;
  const pr = request?.pr !== undefined ? String(request.pr).trim() : undefined;

  const orcaExecutable =
    options.orcaExecutable ?? request?.orcaExecutable ?? "orca";
  const execute = options.execute ?? request?.execute ?? run;

  let intent;
  let earlyReturn;

  withFileLock(deliveriesLock(orgFile), () => {
    const all = readDeliveries(orgFile);
    const existing = all.find((d) => d.source === source && d.head === head);

    if (existing) {
      if (existing.acknowledged === true) {
        earlyReturn = {
          delivered: false,
          duplicate: true,
          replayed: true,
          record: existing,
        };
        return;
      }
      if (existing.delivery?.notified === true) {
        earlyReturn = {
          delivered: true,
          duplicate: true,
          replayed: true,
          record: existing,
        };
        return;
      }
      // Once input may have been sent, retry must not send again without proof.
      if (existing.delivery?.sent === true) {
        earlyReturn = {
          delivered: false,
          duplicate: true,
          replayed: true,
          record: existing,
        };
        return;
      }
      if (existing.delivery?.inFlight === true) {
        const liveness = processLiveness(existing.delivery.owner);
        if (liveness !== "dead") {
          earlyReturn = {
            delivered: false,
            duplicate: true,
            inFlight: true,
            record: existing,
          };
          return;
        }
        // Settle dead owner in place rather than resending to avoid duplicate sends.
        const now = new Date().toISOString();
        const settled = {
          ...existing,
          status: "failed",
          delivery: {
            ...existing.delivery,
            inFlight: false,
            sent: true,
            outcome: "failed",
            notifyError: "owner-exited-before-confirming",
          },
          updatedAt: now,
        };
        writeJSON(
          path.join(deliveriesDir(orgFile), `${existing.id}.json`),
          settled,
        );
        earlyReturn = {
          delivered: false,
          duplicate: true,
          replayed: true,
          record: settled,
        };
        return;
      }

      // Safe in-place retry when sent !== true: persist updated intent before submitting.
      const now = new Date().toISOString();
      intent = {
        ...existing,
        target,
        ...(pr ? { pr } : {}),
        directorTerminal,
        ...(text ? { text } : {}),
        status: "pending-submission",
        delivery: {
          notified: false,
          sent: false,
          inFlight: true,
          owner: { pid: process.pid, hostname: THIS_HOST },
          attemptedAt: now,
          outcome: "pending",
        },
        updatedAt: now,
      };
      writeJSON(
        path.join(deliveriesDir(orgFile), `${existing.id}.json`),
        intent,
      );
      return;
    }

    // Persist intent before terminal submission so process exit leaves an inspectable record.
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    intent = {
      schemaVersion: 1,
      id,
      source,
      head,
      target,
      ...(pr ? { pr } : {}),
      directorTerminal,
      ...(text ? { text } : {}),
      status: "pending-submission",
      acknowledged: false,
      acknowledgedAt: null,
      delivery: {
        notified: false,
        sent: false,
        inFlight: true,
        owner: { pid: process.pid, hostname: THIS_HOST },
        attemptedAt: now,
        outcome: "pending",
      },
      createdAt: now,
      updatedAt: now,
    };
    writeJSON(path.join(deliveriesDir(orgFile), `${id}.json`), intent);
  });

  if (earlyReturn) {
    return earlyReturn;
  }

  const promptText = `[omt delivery] from ${source}: HEAD ${head} delivered to ${target}${text ? ` (${text})` : ""}`;
  let sent;
  try {
    sent = await notifyTerminal(
      orcaExecutable,
      directorTerminal,
      promptText,
      execute,
    );
  } catch (error) {
    sent = {
      notified: false,
      sent: false,
      notifyError: error.message,
      delivery: { outcome: "failed" },
    };
  }

  let outcome = "failed";
  let status = "failed";

  if (sent.notified) {
    outcome = "submitted";
    status = "pending-acknowledgement";
  } else if (
    sent.notifyError === "terminal-identity-unknown" ||
    sent.notifyError?.includes("stale") ||
    sent.delivery?.outcome === "stale"
  ) {
    outcome = "stale";
    status = "stale-terminal";
  } else if (sent.notifyError === "shell-terminal") {
    outcome = "failed";
    status = "shell-terminal";
  } else if (
    sent.deferred ||
    sent.notifyError?.startsWith("blocked-by-") ||
    sent.notifyError === "screen-unavailable"
  ) {
    outcome = "deferred";
    status = "deferred";
  } else if (sent.delivery?.outcome === "unclear") {
    outcome = "unclear";
    status = "unclear-submission";
  } else {
    outcome = "failed";
    status = "failed";
  }

  const now = new Date().toISOString();
  let finalRecord;

  withFileLock(deliveriesLock(orgFile), () => {
    const file = path.join(deliveriesDir(orgFile), `${intent.id}.json`);
    const current = fs.existsSync(file) ? readJSON(file) : intent;
    finalRecord = {
      ...current,
      status,
      delivery: {
        notified: Boolean(sent.notified),
        sent: sent.sent === true,
        inFlight: false,
        outcome,
        ...(sent.notifyError ? { notifyError: sent.notifyError } : {}),
        ...(sent.delivery?.requestId
          ? { requestId: sent.delivery.requestId }
          : {}),
        ...(sent.delivery?.stages ? { stages: sent.delivery.stages } : {}),
        attemptedAt: intent.delivery.attemptedAt,
        settledAt: now,
      },
      updatedAt: now,
    };
    writeJSON(file, finalRecord);
  });

  return {
    delivered: Boolean(sent.notified),
    retried: intent.updatedAt !== intent.createdAt,
    record: finalRecord,
  };
}

/**
 * Acknowledges an independent worktree delivery receipt by ID with proven Director identity.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} deliveryId - Delivery receipt ID to acknowledge.
 * @param {object} [options] - Caller options.
 * @param {string} [options.callerTerminal] - Caller terminal handle.
 * @param {string} [options.terminal] - Alternative caller terminal handle.
 * @param {object} [options.env] - Environment containing ORCA_TERMINAL_HANDLE.
 * @returns {{acknowledged: boolean, record: object}} Updated delivery record.
 * @throws {Error} When the delivery receipt is not found, already acknowledged,
 *   or caller cannot prove Director identity.
 */
export function acknowledgeDelivery(orgFile, deliveryId, options = {}) {
  let updated;
  withFileLock(deliveriesLock(orgFile), () => {
    const file = path.join(deliveriesDir(orgFile), `${deliveryId}.json`);
    assert(fs.existsSync(file), `Delivery ${deliveryId} not found`);
    const record = readJSON(file);
    assert(
      !record.acknowledged,
      `Delivery ${deliveryId} is already acknowledged`,
    );

    const env = options.env ?? process.env;
    const callerHandle =
      options.callerTerminal ?? options.terminal ?? env.ORCA_TERMINAL_HANDLE;
    assert(
      callerHandle && String(callerHandle).trim().length > 0,
      "ORCA_TERMINAL_HANDLE or caller terminal is required to prove Director identity for acknowledgement",
    );
    const normalizedCaller = String(callerHandle).trim();

    if (record.directorTerminal) {
      assert(
        normalizedCaller === record.directorTerminal,
        `Caller terminal ${normalizedCaller} does not match delivery director terminal ${record.directorTerminal}`,
      );
    }

    const now = new Date().toISOString();
    updated = {
      ...record,
      status: "acknowledged",
      acknowledged: true,
      acknowledgedAt: now,
      acknowledgedBy: {
        role: "director",
        terminal: normalizedCaller,
      },
      updatedAt: now,
    };
    writeJSON(file, updated);
  });
  return { acknowledged: true, record: updated };
}

/**
 * Reads a specific delivery receipt by ID.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} deliveryId - Delivery receipt ID.
 * @returns {object} The delivery receipt record.
 * @throws {Error} When the delivery receipt is not found.
 */
export function readDeliveryReceipt(orgFile, deliveryId) {
  const file = path.join(deliveriesDir(orgFile), `${deliveryId}.json`);
  assert(fs.existsSync(file), `Delivery ${deliveryId} not found`);
  return readJSON(file);
}

/**
 * Lists independent worktree delivery receipts.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {object} [options] - Options.
 * @param {boolean} [options.unacknowledgedOnly=false] - Only unacknowledged receipts.
 * @returns {{deliveries: object[]}} Delivery records in filename order.
 */
export function listDeliveries(orgFile, options = {}) {
  const all = readDeliveries(orgFile);
  const unacknowledgedOnly = Boolean(options.unacknowledgedOnly);
  return {
    deliveries: unacknowledgedOnly ? all.filter((d) => !d.acknowledged) : all,
  };
}
