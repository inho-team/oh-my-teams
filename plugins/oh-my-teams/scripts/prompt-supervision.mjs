/**
 * Supervisor path for questions that stop a role's terminal.
 *
 * A role terminal can stop at a folder trust question or at a question the CLI
 * asks its user. Nobody types at that terminal, so the role's supervisor
 * answers it here: the Run-bound PM, or a PL for the roles it started from its
 * own worktree. Every answer goes through the same steps.
 *
 * 1. The caller is proven to supervise the role (its Orca Run, the launch
 *    ledger and the workflow record), and the terminal is proven to sit in a
 *    worktree Orca records as created under the kickoff's PM worktree (its
 *    repository and its explicit parent lineage, read with `orca worktree
 *    show`), the one the ledger names for that role.
 * 2. The screen is read, and `classifyPromptScreen` decides. Only `send-key`
 *    sends a key, `redirect` sends the worker a message without any key, and
 *    everything else goes back to the caller as a report for the level above.
 *    A screen the classifier does not recognize is judged by Orca's own state
 *    of the terminal: a reported stop (`blockedReason`) escalates, without a
 *    key, and a state that cannot be read is refused, never taken as clear.
 * 3. One key is sent for one screen state. The screen is then read again: a
 *    question that is still there is never answered a second time.
 * 4. Every attempt, including one that sent nothing, is appended to
 *    `<state>/prompt-answers.jsonl`.
 *
 * Limits. The caller is identified by the `ORCA_TERMINAL_HANDLE` environment
 * variable, and nothing here can prove that value: a process that knows the
 * handle of a supervising terminal and sets the variable passes as that
 * supervisor. The checks therefore protect against a call by a terminal with no
 * supervising relation to the role, made by mistake. They are not a defence
 * against a hostile process on the same machine. The record keeps only the rows
 * of a recognized question, and none of a screen that shows no question.
 *
 * Esc is never sent, and no user configuration file is read or written.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assert, run, withAsyncFileLock } from "./core.mjs";
import { kickoffOwner } from "./delivery.mjs";
import { listKickoffs } from "./kickoff-registry.mjs";
import {
  probeTerminalBlock,
  runOrcaJson,
  selectOrcaExecutable,
} from "./orca-adapter.mjs";
import { classifyPromptScreen } from "./prompt-answers.mjs";
import { readSendReceipt } from "./prompt-submission.mjs";
import { DISPATCH_AUTHORITY, assertWorktreeUnshared } from "./role-launch.mjs";
import { readLaunches, resolveLaunchKickoff } from "./usage-ledger.mjs";
import { pathWithin } from "./usage-sources.mjs";
import { readWorkflow } from "./workflow.mjs";

/** Reasons `prompt-answer` refuses before it reads or answers anything. */
export const PROMPT_ANSWER_REFUSALS = Object.freeze([
  "caller-unknown",
  "self-target",
  "workflow-unreadable",
  "state-mismatch",
  "terminal-not-launched",
  "role-mismatch",
  "workflow-mismatch",
  "kickoff-not-active",
  "not-supervisor",
  "terminal-unreadable",
  "worktree-mismatch",
  "worktree-not-role-owned",
  "worktree-shared",
  "worktree-lineage-unproven",
  "screen-unavailable",
  "orca-state-unavailable",
  "key-not-allowed",
  "already-answered",
  "answer-in-progress",
]);

/** Where a recorded attempt ended. */
export const PROMPT_ANSWER_STATUSES = Object.freeze([
  "sending",
  "resolved",
  "advanced",
  "unresolved",
  "redirected",
  "escalate",
  "no-question",
  "refused",
]);

// Only the two keys the captures sent or the screens showed are ever sent. Esc
// quits Claude, so it is refused by name and by its escape sequence.
const ALLOWED_KEYS = Object.freeze({
  Enter: { text: "", enter: true },
  Down: { text: "\u001b[B", enter: false },
});

const RECORD_FILE = "prompt-answers.jsonl";
const EXCERPT_ROWS = 12;
const ROW_LIMIT = 200;
const DEFAULT_SETTLE_MS = 1500;
const DEFAULT_RECHECKS = 3;

const sleepFor = (ms) =>
  ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

/** A refusal that names its code, so a caller can act on it without parsing text. */
class Refusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function samePath(a, b) {
  return Boolean(a && b) && pathWithin(a, b) && pathWithin(b, a);
}

/**
 * Locates the record of supervised prompt answers.
 *
 * @param {string} stateDir - PM worktree `.omt` directory.
 * @returns {string} `<state>/prompt-answers.jsonl`.
 */
export function promptAnswerFile(stateDir) {
  return path.join(path.resolve(stateDir), RECORD_FILE);
}

/**
 * Reads the recorded attempts, one entry per attempt.
 *
 * An attempt writes a reservation line before its key is sent and a final line
 * after the screen is read again, both with the same `id`. The final line
 * replaces the reservation, so a crash between the two leaves the attempt
 * visible as `sending`.
 *
 * @param {string} stateDir - PM worktree `.omt` directory.
 * @returns {object[]} Attempts in the order they began.
 */
export function readPromptAnswers(stateDir) {
  const file = promptAnswerFile(stateDir);
  if (!fs.existsSync(file)) return [];
  const byId = new Map();
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      byId.set(record.id, record);
    } catch {
      // A line a crashed writer left incomplete decides nothing.
    }
  }
  return [...byId.values()];
}

function appendRecord(stateDir, record) {
  const file = promptAnswerFile(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/**
 * Summarizes the recorded attempts for `status`.
 *
 * @param {string | undefined} stateDir - PM worktree `.omt` directory.
 * @returns {{total: number, sent: number, byStatus: object, unresolved: object[], recent: object[]}}
 *   Counts by status, the attempts that still need a report upward, and the last few.
 */
export function promptAnswerSummary(stateDir) {
  const records = stateDir ? readPromptAnswers(stateDir) : [];
  const byStatus = {};
  for (const record of records)
    byStatus[record.status] = (byStatus[record.status] ?? 0) + 1;
  const brief = (record) => ({
    id: record.id,
    at: record.at,
    role: record.role,
    terminal: record.terminal,
    kind: record.kind,
    status: record.status,
    refusal: record.refusal,
    blockedReason: record.blockedReason ?? null,
    key: record.key?.name ?? null,
    keyBasis: record.key?.basis ?? null,
    sent: record.sent,
    verification: record.verification?.result ?? null,
    supervisor: record.supervisor?.handle ?? null,
  });
  return {
    total: records.length,
    sent: records.filter((record) => record.sent).length,
    byStatus,
    unresolved: records
      .filter((record) =>
        ["unresolved", "escalate", "refused", "sending"].includes(
          record.status,
        ),
      )
      .map(brief),
    recent: records.slice(-5).map(brief),
  };
}

// Rows of the screen are compared without the selection mark and spacing the
// CLI draws before a choice.
const squeezeRow = (line) =>
  String(line ?? "")
    .replace(/^[\s>›❯▶*]+/, "")
    .trim();

// The record keeps only what identifies the question: the rows the classifier
// matched, or the question text it extracted. A screen with no recognized
// question is ordinary work output, which may hold a secret or a user's
// settings, so nothing of it is kept.
function excerptOf(lines, classification) {
  if (
    !classification ||
    (classification.kind === "unknown" && classification.cli === null)
  )
    return [];
  const own = Array.isArray(classification.excerpt)
    ? classification.excerpt
    : null;
  const matched = (classification.evidence?.matched ?? [])
    .map(squeezeRow)
    .filter((row) => row.length >= 4);
  const rows = own
    ? own.map((line) => String(line ?? "").trimEnd())
    : (lines ?? [])
        .map((line) => String(line ?? "").trimEnd())
        .filter((line) => {
          const row = squeezeRow(line);
          return (
            row.length >= 4 &&
            matched.some((one) => row.includes(one) || one.includes(row))
          );
        });
  return rows
    .filter((line) => line.trim())
    .slice(-EXCERPT_ROWS)
    .map((line) => line.slice(0, ROW_LIMIT));
}

/**
 * Fingerprints one state of a question screen.
 *
 * The state is the terminal, the recognized question, the choices compared and
 * the selected choice. Claude's trust question opens on "No, exit" and moves to
 * "Yes, I trust this folder" after Down, so the two states differ and each is
 * answered once; a screen that did not change keeps its fingerprint.
 *
 * @param {string} terminal - Terminal handle the screen was read from.
 * @param {object} classification - Result of `classifyPromptScreen`.
 * @returns {string} Hex digest that names the state.
 */
export function screenFingerprint(terminal, classification) {
  const { kind, cli, evidence } = classification;
  const state = [
    terminal,
    kind,
    cli,
    evidence?.selected ?? null,
    evidence?.matched ?? null,
    classification.key?.name ?? null,
  ];
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(state))
    .digest("hex")
    .slice(0, 24);
}

/**
 * Digests the text of a question the classifier extracted.
 *
 * The fingerprint of a user-question screen holds only its header and footer
 * rows, so two different questions can share it. The redirect names a state by
 * the fingerprint and this digest together, and a screen without extracted text
 * gets an empty digest. The key path does not use it.
 *
 * @param {object} classification - Result of `classifyPromptScreen`.
 * @returns {string} Hex digest of the question text, or "" when it has none.
 */
export function questionDigest(classification) {
  const rows = Array.isArray(classification.excerpt)
    ? classification.excerpt.map(squeezeRow).filter(Boolean)
    : [];
  if (!rows.length) return "";
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(rows))
    .digest("hex")
    .slice(0, 24);
}

async function readTerminalScreen(orca, terminal, execute) {
  try {
    const read = await runOrcaJson(
      orca,
      ["terminal", "read", "--terminal", terminal, "--screen"],
      { execute },
    );
    const { source, tail } = read.result?.terminal ?? {};
    return source === "screen"
      ? { rendered: true, lines: tail ?? [] }
      : { rendered: false, lines: [] };
  } catch (error) {
    return { rendered: false, lines: [], error: error.message };
  }
}

/**
 * Proves that a caller supervises a role's terminal.
 *
 * The caller's Orca terminal handle must be the coordinator of a Run it is
 * bound to. That Run must be the Run the kickoff's PM bound, or the caller must
 * be a PL that the launch ledger shows started this role from its own worktree.
 * The kickoff is the one the terminal's launch was recorded under, so a
 * terminal from another kickoff, or one nobody launched, is refused.
 *
 * The caller's handle comes from the `ORCA_TERMINAL_HANDLE` environment
 * variable and is not itself proven: a process that sets it to the handle of a
 * supervising terminal passes. This check guards against a call by a terminal
 * that supervises nothing, made by mistake, and not against a malicious process.
 *
 * @param {object} options - What is known about the terminal and the caller.
 * @param {string} options.orgFile - Organization JSON path.
 * @param {string} options.callerHandle - Orca terminal handle of the caller.
 * @param {string} options.role - Role the terminal runs.
 * @param {string} options.kickoffPmWorktreeId - Kickoff the launch was recorded under.
 * @param {string} options.launchCwd - Directory the launch ran from.
 * @param {string} options.orca - Orca executable.
 * @param {Function} [options.execute=run] - Injectable command runner.
 * @returns {Promise<{handle: string, role: string, runId: string, kickoff: object}>} The supervisor.
 * @throws {Error} With a `code` from `PROMPT_ANSWER_REFUSALS` when the caller does not supervise.
 */
export async function verifySupervisor({
  orgFile,
  callerHandle,
  role,
  kickoffPmWorktreeId,
  launchCwd,
  orca,
  execute = run,
}) {
  const kickoff = listKickoffs(orgFile).kickoffs.find(
    (entry) => entry.pm.worktreeId === kickoffPmWorktreeId,
  );
  if (!kickoff)
    throw new Refusal(
      "kickoff-not-active",
      `The launch belongs to kickoff ${kickoffPmWorktreeId}, which is not running, so nobody supervises it`,
    );
  let bound = null;
  try {
    const current = await runOrcaJson(
      orca,
      ["orchestration", "run-current", "--from", callerHandle],
      { execute },
    );
    bound = current.result?.run ?? null;
  } catch {
    bound = null;
  }
  // Orca reports the Run a coordinator terminal is bound to; a run whose
  // coordinator is somebody else proves nothing about this caller.
  if (!bound || bound.coordinator_handle !== callerHandle)
    throw new Refusal(
      "not-supervisor",
      `Caller ${callerHandle} is not bound to any Run, so it supervises no role`,
    );
  if (kickoff.runId && bound.id === kickoff.runId) {
    if (!DISPATCH_AUTHORITY.pm.includes(role))
      throw new Refusal("not-supervisor", `PM does not supervise ${role}`);
    return { handle: callerHandle, role: "pm", runId: bound.id, kickoff };
  }
  const parent = readLaunches(orgFile).findLast(
    (line) =>
      line.terminal === callerHandle &&
      line.kickoffPmWorktreeId === kickoffPmWorktreeId &&
      DISPATCH_AUTHORITY[line.role]?.includes(role) &&
      pathWithin(launchCwd, line.worktreePath),
  );
  if (!parent)
    throw new Refusal(
      "not-supervisor",
      `Caller ${callerHandle} is neither the PM bound to this kickoff's Run nor a PL that started ${role} from its own worktree`,
    );
  return { handle: callerHandle, role: parent.role, runId: bound.id, kickoff };
}

function keyOf(classification) {
  const { key } = classification;
  if (!key) return null;
  const allowed = ALLOWED_KEYS[key.name];
  if (
    !allowed ||
    key.send?.text !== allowed.text ||
    key.send?.enter !== allowed.enter
  )
    throw new Refusal(
      "key-not-allowed",
      `Key ${key.name} is not one of the keys this path sends (${Object.keys(ALLOWED_KEYS).join(", ")}); Esc is never sent`,
    );
  return key;
}

async function sendKey(orca, terminal, key, execute) {
  const args = [
    "terminal",
    "send",
    "--terminal",
    terminal,
    "--text",
    key.send.text,
    ...(key.send.enter ? ["--enter"] : []),
  ];
  try {
    const receipt = readSendReceipt(await runOrcaJson(orca, args, { execute }));
    return { accepted: receipt.accepted, requestId: receipt.requestId };
  } catch (error) {
    // Whether the key arrived is unknown, so it counts as sent and the
    // screen decides; it is never sent again.
    return { accepted: false, requestId: null, error: error.message };
  }
}

// Reads the screen after a key and judges what became of the question.
async function reconfirm({
  orca,
  terminal,
  context,
  fingerprint,
  settleMs,
  rechecks,
  sleep,
  execute,
}) {
  let last = { result: "unreadable", lines: [] };
  for (let round = 0; round < rechecks; round += 1) {
    await sleep(settleMs);
    const read = await readTerminalScreen(orca, terminal, execute);
    if (!read.rendered) {
      last = { result: "unreadable", lines: [], error: read.error };
      continue;
    }
    const after = classifyPromptScreen(read.lines, context);
    const excerpt = excerptOf(read.lines, after);
    if (after.kind === "unknown" && after.cli === null) {
      return { result: "resolved", kind: after.kind, excerpt };
    }
    if (screenFingerprint(terminal, after) !== fingerprint) {
      return {
        result: after.action === "send-key" ? "advanced" : "unrecognized",
        kind: after.kind,
        selected: after.evidence?.selected ?? null,
        excerpt,
      };
    }
    last = { result: "unchanged", kind: after.kind, excerpt };
  }
  return last;
}

// A screen the classifier does not recognize is not necessarily clear: a command
// approval or an update notice nobody captured is unknown to it, yet Orca's
// tui-idle wait, which the launch pre-check reads, stops on it and names a
// `blockedReason`. Without this step the pre-check refuses the terminal and
// sends the supervisor back here, which would answer "no question" forever.
// No key is sent for such a screen. When Orca reports the stop, the attempt
// escalates with that reason; when Orca reports none, it is `no-question`; when
// Orca's state cannot be read, the screen is not judged clear.
async function judgeUnrecognizedScreen({
  orca,
  terminal,
  stateDir,
  lines,
  description,
  finish,
  execute,
}) {
  const probe = await probeTerminalBlock(orca, terminal, { execute });
  if (probe.state === "unknown")
    return finish({
      ...description,
      status: "refused",
      refusal: "orca-state-unavailable",
      sent: false,
      key: null,
      reason: `The classifier does not recognize this screen and Orca's state of the terminal could not be read (${probe.detail}), so it is not judged clear`,
      next: "report-upstream",
    });
  if (probe.state !== "blocked")
    return finish({
      ...description,
      orcaState: probe.state,
      status: "no-question",
      sent: false,
      key: null,
      next: "resume-precheck",
    });
  // Only the digest of the rows is kept, never the rows: the screen is
  // unrecognized work output. A supervision loop that reads the same stopped
  // screen again gets the earlier attempt back instead of one more line, and
  // any change of the screen or of Orca's reason is a new attempt.
  const { blockedReason } = probe;
  const fingerprint = crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        terminal,
        "blocked",
        blockedReason,
        lines.map((line) => String(line ?? "").trimEnd()),
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  const earlier = readPromptAnswers(stateDir).findLast(
    (record) => record.terminal === terminal,
  );
  if (earlier?.status === "escalate" && earlier.fingerprint === fingerprint)
    return { ...earlier, repeated: true, repeatOf: earlier.id };
  return finish({
    ...description,
    orcaState: "blocked",
    blockedReason,
    fingerprint,
    status: "escalate",
    sent: false,
    key: null,
    reason: `The classifier does not recognize this screen, and Orca reports the terminal held at a question (${blockedReason}); no key is sent`,
    next: "report-upstream",
  });
}

/**
 * Reads a terminal's screen and answers its question once, when it may be.
 *
 * The caller has already proven that `supervisor` supervises `role` and that
 * `terminal` sits in `worktree`. This function holds the record's lock from the
 * duplicate check to the final line, so two callers cannot both answer one
 * screen state, and it never sends a second key for a state it already sent
 * one for.
 *
 * @param {object} options - The terminal, what runs in it and who answers.
 * @param {string} options.orca - Orca executable.
 * @param {string} options.terminal - Terminal handle to read and answer.
 * @param {string} options.role - Role the terminal runs.
 * @param {string} options.provider - `claude`, `codex` or `agy`.
 * @param {string} options.worktree - Worktree the role was launched in.
 * @param {string} options.stateDir - PM worktree `.omt` directory holding the record.
 * @param {{handle: string, role: string, runId: string}} options.supervisor - The proven supervisor.
 * @param {string | null} [options.workflowId] - Workflow the launch belongs to.
 * @param {number} [options.settleMs=1500] - Wait before each re-read after a key.
 * @param {number} [options.rechecks=3] - Re-reads before an unchanged screen is reported.
 * @param {Function} [options.sleep] - Injectable delay.
 * @param {Function} [options.execute=run] - Injectable command runner.
 * @returns {Promise<object>} The final record line, with `status` and `next`.
 */
export async function answerTerminalPrompt({
  orca,
  terminal,
  role,
  provider,
  worktree,
  stateDir,
  supervisor,
  workflowId = null,
  settleMs = DEFAULT_SETTLE_MS,
  rechecks = DEFAULT_RECHECKS,
  sleep = sleepFor,
  execute = run,
}) {
  assert(supervisor?.handle, "A proven supervisor is required to answer");
  const base = {
    schemaVersion: 1,
    event: "prompt-answer",
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    role,
    provider,
    terminal,
    worktree,
    workflowId,
    supervisor: {
      handle: supervisor.handle,
      role: supervisor.role,
      runId: supervisor.runId,
    },
  };
  const finish = (fields) => {
    const record = { ...base, ...fields };
    appendRecord(stateDir, record);
    return record;
  };
  const screen = await readTerminalScreen(orca, terminal, execute);
  if (!screen.rendered)
    return finish({
      status: "refused",
      refusal: "screen-unavailable",
      sent: false,
      key: null,
      reason:
        "Orca did not return a rendered screen, so nothing is judged or sent",
      next: "report-upstream",
    });
  const context = { cli: provider, worktree };
  const found = classifyPromptScreen(screen.lines, context);
  const description = {
    kind: found.kind,
    cli: found.cli,
    action: found.action,
    reason: found.reason,
    evidence: found.evidence,
    excerpt: excerptOf(screen.lines, found),
  };
  if (found.kind === "unknown" && found.cli === null)
    return judgeUnrecognizedScreen({
      orca,
      terminal,
      stateDir,
      lines: screen.lines,
      description,
      finish,
      execute,
    });
  const fingerprint = screenFingerprint(terminal, found);
  if (found.action === "redirect") {
    // The worker is told once per screen state, under the same lock as a key,
    // so a supervision loop that reads the same question again does not pile
    // the same instruction onto the worker. The state includes the question
    // text: another question under the same header is told again.
    const digest = questionDigest(found);
    const redirectLock = `${promptAnswerFile(stateDir)}.lock`;
    try {
      return await withAsyncFileLock(
        redirectLock,
        async () => {
          const told = readPromptAnswers(stateDir).find(
            (record) =>
              record.fingerprint === fingerprint &&
              (record.questionDigest ?? "") === digest &&
              record.action === "redirect" &&
              (record.redirect?.sent === true || record.status === "sending"),
          );
          if (told)
            return finish({
              ...description,
              fingerprint,
              questionDigest: digest,
              status: "refused",
              refusal: "already-answered",
              sent: false,
              key: null,
              reason: `The worker was already told about this screen state by attempt ${told.id}; it is not told again`,
              next: "await-worker",
            });
          const reservation = {
            ...base,
            ...description,
            fingerprint,
            questionDigest: digest,
            status: "sending",
            sent: false,
            key: null,
          };
          appendRecord(stateDir, reservation);
          const sent = await redirectWorker({
            orca,
            terminal,
            found,
            supervisor,
            execute,
          });
          const record = {
            ...reservation,
            status: sent.sent ? "redirected" : "unresolved",
            redirect: sent,
            next: sent.sent ? "await-worker" : "report-upstream",
          };
          appendRecord(stateDir, record);
          return record;
        },
        "Prompt answer in progress",
      );
    } catch (error) {
      if (error.message !== "Prompt answer in progress") throw error;
      return finish({
        ...description,
        fingerprint,
        status: "refused",
        refusal: "answer-in-progress",
        sent: false,
        key: null,
        reason: "Another answer for this record is running",
        next: "report-upstream",
      });
    }
  }
  if (found.action !== "send-key")
    return finish({
      ...description,
      fingerprint,
      status: "escalate",
      sent: false,
      key: null,
      next: "report-upstream",
    });
  const key = keyOf(found);
  const lock = `${promptAnswerFile(stateDir)}.lock`;
  try {
    return await withAsyncFileLock(
      lock,
      async () => {
        const answered = readPromptAnswers(stateDir).find(
          (record) => record.fingerprint === fingerprint && record.sent,
        );
        if (answered)
          return finish({
            ...description,
            fingerprint,
            status: "refused",
            refusal: "already-answered",
            sent: false,
            key: null,
            reason: `The same screen state was answered by attempt ${answered.id}; a question that is still there is reported, not answered again`,
            next: "report-upstream",
          });
        const sentKey = { name: key.name, basis: key.basis, send: key.send };
        // The reservation is on disk before the key leaves, so a crash cannot
        // let the next caller send the same key again.
        appendRecord(stateDir, {
          ...base,
          ...description,
          fingerprint,
          status: "sending",
          sent: true,
          key: sentKey,
        });
        const delivery = await sendKey(orca, terminal, key, execute);
        const verification = await reconfirm({
          orca,
          terminal,
          context,
          fingerprint,
          settleMs,
          rechecks,
          sleep,
          execute,
        });
        const status =
          verification.result === "resolved" ||
          verification.result === "advanced"
            ? verification.result
            : "unresolved";
        const next = {
          resolved: "resume-precheck",
          advanced: "answer-again",
          unresolved: "report-upstream",
        }[status];
        const record = {
          ...base,
          ...description,
          fingerprint,
          status,
          sent: true,
          key: sentKey,
          delivery,
          verification,
          next,
        };
        appendRecord(stateDir, record);
        return record;
      },
      "Prompt answer in progress",
    );
  } catch (error) {
    if (error.message !== "Prompt answer in progress") throw error;
    return finish({
      ...description,
      fingerprint,
      status: "refused",
      refusal: "answer-in-progress",
      sent: false,
      key: null,
      reason: "Another answer for this record is running",
      next: "report-upstream",
    });
  }
}

// A question the CLI asks its user is not answered with a key. The worker is
// told through a message to ask the supervisor instead.
async function redirectWorker({ orca, terminal, found, supervisor, execute }) {
  const subject = "질문 화면: orchestration ask로 다시 물어 주세요";
  try {
    await runOrcaJson(
      orca,
      [
        "orchestration",
        "send",
        "--to",
        terminal,
        "--from",
        supervisor.handle,
        "--type",
        "status",
        "--subject",
        subject,
        "--body",
        found.instruction ?? found.reason ?? subject,
      ],
      { execute },
    );
    return { sent: true, subject };
  } catch (error) {
    return { sent: false, subject, error: error.message };
  }
}

function launchOf(orgFile, terminal) {
  const lines = readLaunches(orgFile).filter(
    (line) => line.terminal === terminal,
  );
  if (lines.length === 0) return null;
  const latest = lines.at(-1);
  const located = lines.findLast((line) => line.worktreePath);
  return {
    ...latest,
    worktreePath: located?.worktreePath ?? null,
    kickoffPmWorktreeId:
      latest.kickoffPmWorktreeId ??
      lines.findLast((line) => line.kickoffPmWorktreeId)?.kickoffPmWorktreeId ??
      null,
  };
}

/**
 * Reports whether any of the captured questions, or a screen that resembles
 * one, is still on a screen.
 *
 * A trust or user question counts, and so does a screen that matches part of a
 * captured question of the CLI: an unrecognized change must keep blocking the
 * caller. A screen that resembles no captured question of the CLI is clear.
 *
 * @param {string[]} lines - Screen lines, oldest first.
 * @param {{cli?: string, worktree?: string}} [context] - Provider and worktree of the terminal.
 * @returns {boolean} True when a question, or a partial match of one, remains.
 */
export function questionOnScreen(lines, context = {}) {
  const found = classifyPromptScreen(lines, context);
  return !(found.kind === "unknown" && found.cli === null);
}

/**
 * Builds the record line of an attempt that was refused, and appends it.
 *
 * @param {string | undefined} stateDir - PM state directory; nothing is written without one.
 * @param {object} fields - What is known: `terminal`, `role`, `workflowId`, `provider`, `worktree`, `caller`.
 * @param {string} refusal - Code from `PROMPT_ANSWER_REFUSALS`.
 * @param {string} message - Why, in words.
 * @returns {object} The record line.
 */
export function recordRefusal(stateDir, fields, refusal, message) {
  const record = {
    schemaVersion: 1,
    event: "prompt-answer",
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    role: fields.role ?? null,
    terminal: fields.terminal ?? null,
    workflowId: fields.workflowId ?? null,
    provider: fields.provider ?? null,
    worktree: fields.worktree ?? null,
    status: "refused",
    refusal,
    reason: message,
    sent: false,
    key: null,
    supervisor: fields.caller ? { handle: fields.caller } : null,
    next: "report-upstream",
  };
  if (stateDir) {
    try {
      appendRecord(stateDir, record);
    } catch {
      // The refusal is still returned when the state directory cannot be written.
    }
  }
  return record;
}

// Orca records where a worktree came from, independently of whoever launches a
// terminal in it: the repository it belongs to, the worktree it was created
// under, and how that parent was captured. A worktree counts as this kickoff's
// only when following those parents reaches the kickoff's PM worktree, through
// worktrees of the same repository, each created by an explicit `--parent-worktree`
// CLI call. Anything Orca does not report, or reports differently, is unproven.
const MAX_LINEAGE_HOPS = 8;

async function assertKickoffLineage({ actual, kickoff, orca, execute }) {
  const pmId = kickoff.pm.worktreeId;
  const separator = pmId.indexOf("::");
  const unproven = (why) =>
    new Refusal(
      "worktree-lineage-unproven",
      `Orca does not show ${actual} as a worktree created under this kickoff's PM worktree (${why}), so no key is sent there`,
    );
  if (separator <= 0)
    throw unproven("the kickoff's PM worktree id names no repository");
  const repoId = pmId.slice(0, separator);
  const visited = new Set();
  let id = `${repoId}::${actual}`;
  for (let hop = 0; hop < MAX_LINEAGE_HOPS; hop += 1) {
    if (visited.has(id)) throw unproven("its lineage loops");
    visited.add(id);
    let worktree;
    try {
      const shown = await runOrcaJson(
        orca,
        ["worktree", "show", "--worktree", `id:${id}`],
        { execute },
      );
      worktree = shown.result?.worktree;
    } catch (error) {
      throw unproven(`orca worktree show failed: ${error.message}`);
    }
    if (worktree?.id !== id || worktree.repoId !== repoId)
      throw unproven(`${id} is not a worktree of the kickoff's repository`);
    const parent = worktree.parentWorktreeId;
    const lineage = worktree.lineage;
    if (typeof parent !== "string" || !parent)
      throw unproven(`${id} has no parent worktree`);
    if (
      lineage?.worktreeId !== id ||
      lineage.parentWorktreeId !== parent ||
      lineage.origin !== "cli" ||
      lineage.capture?.confidence !== "explicit"
    )
      throw unproven(
        `the lineage of ${id} is not an explicit CLI-created parent record`,
      );
    if (parent === pmId) return;
    id = parent;
  }
  throw unproven("its lineage is longer than a kickoff creates");
}

// The terminal's worktree must be the one the ledger names for the role,
// Orca must show it as created under the kickoff's PM worktree, and no other
// role may work there.
async function assertRoleWorktree({
  terminal,
  role,
  kickoff,
  expectedWorktree,
  workflowState,
  orca,
  execute,
}) {
  const shown = await runOrcaJson(
    orca,
    ["terminal", "show", "--terminal", terminal],
    { execute },
  ).catch((error) => {
    throw new Refusal("terminal-unreadable", error.message);
  });
  const actual = shown.result?.terminal?.worktreePath ?? null;
  if (!actual || (expectedWorktree && !samePath(actual, expectedWorktree)))
    throw new Refusal(
      "worktree-mismatch",
      `Terminal ${terminal} is in ${actual ?? "an unknown worktree"}, not in ${expectedWorktree ?? "a worktree Orca reports"}`,
    );
  if (kickoffOwner(actual) || samePath(actual, kickoff.pm.path))
    throw new Refusal(
      "worktree-not-role-owned",
      `${actual} is the owner checkout or the PM's worktree, not a worktree created under this kickoff's PM worktree for ${role}`,
    );
  try {
    assertWorktreeUnshared(workflowState, role, `path:${actual}`, actual);
  } catch (error) {
    throw new Refusal("worktree-shared", error.message);
  }
  await assertKickoffLineage({ actual, kickoff, orca, execute });
  return actual;
}

/**
 * Proves, at launch time, that the caller may answer a new role terminal.
 *
 * `role-terminal` opens a terminal before the ledger names it, so the kickoff
 * comes from the state directory and the caller's directory instead of a
 * ledger line. The same supervisor and worktree checks as `prompt-answer` then
 * apply, so the trust question of a new terminal is answered by the role's
 * supervisor only, and only in a worktree Orca records under the kickoff's PM
 * worktree, so the folder the launcher chose is not taken on its word.
 *
 * @param {object} options - What the launch knows.
 * @param {string} options.orgFile - Organization JSON path.
 * @param {string} options.stateDir - PM worktree `.omt` directory.
 * @param {string} options.workflowId - Workflow the launch belongs to.
 * @param {string} options.role - Role the terminal opens.
 * @param {string} options.terminal - Handle of the terminal just created.
 * @param {string} options.launchCwd - Directory the launch runs from.
 * @param {string | null} [options.expectedWorktree] - Worktree the selector named, when it names a directory.
 * @param {string} [options.orca] - Orca executable.
 * @param {NodeJS.ProcessEnv} [options.env=process.env] - Environment naming the caller's terminal.
 * @param {Function} [options.execute=run] - Injectable command runner.
 * @returns {Promise<{supervisor: object, worktree: string}>} The supervisor and the terminal's worktree.
 * @throws {Error} With a `code` from `PROMPT_ANSWER_REFUSALS`.
 */
export async function authorizeLaunch({
  orgFile,
  stateDir,
  workflowId,
  role,
  terminal,
  launchCwd,
  expectedWorktree = null,
  orca,
  env = process.env,
  execute = run,
}) {
  const caller = env.ORCA_TERMINAL_HANDLE ?? null;
  if (!caller)
    throw new Refusal(
      "caller-unknown",
      "ORCA_TERMINAL_HANDLE is not set, so the caller cannot be identified as a supervisor",
    );
  let snapshot;
  try {
    snapshot = readWorkflow(path.resolve(stateDir), workflowId);
  } catch (error) {
    throw new Refusal("workflow-unreadable", error.message);
  }
  const { kickoffs } = listKickoffs(orgFile);
  const tied = resolveLaunchKickoff(kickoffs, readLaunches(orgFile), {
    stateDir: path.resolve(stateDir),
    callerCwd: path.resolve(launchCwd),
  });
  const kickoff = kickoffs.find((entry) => entry.pm.worktreeId === tied);
  if (!kickoff)
    throw new Refusal(
      "kickoff-not-active",
      "The launch is tied to no running kickoff, so nobody supervises it",
    );
  const supervisor = await verifySupervisor({
    orgFile,
    callerHandle: caller,
    role,
    kickoffPmWorktreeId: kickoff.pm.worktreeId,
    launchCwd,
    orca,
    execute,
  });
  const worktree = await assertRoleWorktree({
    terminal,
    role,
    kickoff,
    expectedWorktree,
    workflowState: snapshot.state,
    orca,
    execute,
  });
  return { supervisor, worktree };
}

/**
 * Answers the question that stops a role's terminal, as its supervisor.
 *
 * Implements the `prompt-answer` command. A refusal is returned as a record
 * with `status: "refused"` and a `refusal` code from `PROMPT_ANSWER_REFUSALS`,
 * and is written to the record like any other attempt, before any screen is
 * read or key sent.
 *
 * @param {object} options - Command options.
 * @param {string} options.orgFile - Organization JSON path.
 * @param {string} options.terminal - Terminal handle of the stopped role.
 * @param {string} options.workflowId - Workflow the role was launched for.
 * @param {string} options.stateDir - PM worktree `.omt` directory holding the workflow and the record.
 * @param {string} [options.role] - Role the caller expects; checked against the launch ledger.
 * @param {string} [options.executable] - Orca executable.
 * @param {NodeJS.ProcessEnv} [options.env=process.env] - Environment naming the caller's terminal.
 * @param {number} [options.settleMs] - Wait before each re-read after a key.
 * @param {number} [options.rechecks] - Re-reads before an unchanged screen is reported.
 * @param {Function} [options.sleep] - Injectable delay.
 * @param {Function} [options.execute=run] - Injectable command runner.
 * @returns {Promise<object>} The recorded attempt; `status` says whether the question was answered.
 */
export async function answerPrompt({
  orgFile,
  terminal,
  workflowId,
  stateDir,
  role,
  executable,
  env = process.env,
  settleMs,
  rechecks,
  sleep,
  execute = run,
}) {
  assert(terminal, "--terminal is required");
  assert(stateDir, "--state is required");
  const orca = selectOrcaExecutable(executable, env);
  const caller = env.ORCA_TERMINAL_HANDLE ?? null;
  const known = { role, terminal, workflowId, caller };
  try {
    if (!caller)
      throw new Refusal(
        "caller-unknown",
        "ORCA_TERMINAL_HANDLE is not set, so the caller cannot be identified as a supervisor",
      );
    if (caller === terminal)
      throw new Refusal(
        "self-target",
        "A terminal does not answer its own prompt",
      );
    let snapshot;
    try {
      snapshot = readWorkflow(path.resolve(stateDir), workflowId);
    } catch (error) {
      throw new Refusal("workflow-unreadable", error.message);
    }
    const launch = launchOf(orgFile, terminal);
    if (!launch)
      throw new Refusal(
        "terminal-not-launched",
        `No role-terminal or worker-start of this organization recorded terminal ${terminal}`,
      );
    known.role = launch.role;
    known.provider = launch.provider;
    if (role && launch.role !== role)
      throw new Refusal(
        "role-mismatch",
        `Terminal ${terminal} was launched for ${launch.role}, not ${role}`,
      );
    if (launch.workflowId !== workflowId)
      throw new Refusal(
        "workflow-mismatch",
        `Terminal ${terminal} was launched for workflow ${launch.workflowId ?? "none"}, not ${workflowId}`,
      );
    const kickoff = listKickoffs(orgFile).kickoffs.find(
      (entry) => entry.pm.worktreeId === launch.kickoffPmWorktreeId,
    );
    if (!kickoff)
      throw new Refusal(
        "kickoff-not-active",
        `Terminal ${terminal} is tied to no running kickoff`,
      );
    if (!samePath(kickoff.pm.stateDir, stateDir))
      throw new Refusal(
        "state-mismatch",
        `--state ${path.resolve(stateDir)} is not the PM state of the kickoff that launched this terminal (${kickoff.pm.stateDir})`,
      );
    const supervisor = await verifySupervisor({
      orgFile,
      callerHandle: caller,
      role: launch.role,
      kickoffPmWorktreeId: kickoff.pm.worktreeId,
      launchCwd: launch.callerCwd,
      orca,
      execute,
    });
    if (!launch.worktreePath)
      throw new Refusal(
        "worktree-mismatch",
        `The launch of terminal ${terminal} recorded no worktree to compare with`,
      );
    known.worktree = launch.worktreePath;
    const worktree = await assertRoleWorktree({
      terminal,
      role: launch.role,
      kickoff,
      expectedWorktree: launch.worktreePath,
      workflowState: snapshot.state,
      orca,
      execute,
    });
    return await answerTerminalPrompt({
      orca,
      terminal,
      role: launch.role,
      provider: launch.provider,
      worktree,
      stateDir,
      supervisor,
      workflowId,
      settleMs,
      rechecks,
      sleep,
      execute,
    });
  } catch (error) {
    if (!error.code || !PROMPT_ANSWER_REFUSALS.includes(error.code))
      throw error;
    return recordRefusal(stateDir, known, error.code, error.message);
  }
}
