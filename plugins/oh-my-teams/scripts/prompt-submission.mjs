/**
 * Tells an accepted terminal prompt apart from a submitted one.
 *
 * `orca terminal send --enter` reports `accepted: true` once the input reached
 * the terminal. That proves nothing about the agent: the Enter can be swallowed
 * and leave the text in the input box, and a receipt that stops at
 * `input_accepted` is also what a working agent gives when nobody waited for
 * the turn (observed on Orca 1.4.206: a default send returned only
 * `input_accepted` while the Claude turn was already running). Sending the
 * prompt again on that silence would run the work twice.
 *
 * The judgement here is a pure function of the receipt's stages and the screen.
 * Enter is pressed again only when the approved text is seen waiting in the
 * input box, and never more than once.
 */
import { run } from "./core.mjs";
import { runOrcaJson } from "./orca-adapter.mjs";

/**
 * Outcomes of judging a delivery.
 *
 * - `submitted`: Orca proved the agent's turn started (`turn_started`).
 * - `already-started`: the input box is empty and the text is in the
 *   transcript, so the turn started or the input was queued; no Enter.
 * - `unsubmitted`: the approved text waits alone in the input box; Enter once.
 * - `foreign-input`: the input box holds something other than the approved
 *   text; Enter would submit it, so nothing is sent.
 * - `unclear`: neither the receipt nor the screen decides; repeat the same
 *   request with `--retry-request`, never a new send.
 * - `failed`: Orca refused or did not answer, so no receipt exists.
 */
export const DELIVERY_OUTCOMES = Object.freeze([
  "submitted",
  "already-started",
  "unsubmitted",
  "foreign-input",
  "unclear",
  "failed",
]);

// Wrapping may drop the space at a break and quoting may differ from the
// typed string, so both are compared away.
const squeeze = (text) => String(text ?? "").replace(/[\s'"]+/g, "");

const INPUT_ROW = /^\s*[❯›>](?:\s+(.*))?$/;
const SEPARATOR_ROW = /^[\s─━═\-_]*$/;
const CONTINUATION_ROW = /^\s{2,}\S/;
// Rows an agent draws under its input box: a rule and a status line or two.
const MAX_ROWS_BELOW_INPUT = 2;

/**
 * Reads the delivery facts out of Orca's `terminal send --json` response.
 *
 * @param {object} response - Parsed `terminal send --json` envelope.
 * @returns {{accepted: boolean, requestId: string | null, stages: string[],
 *   provider: string | null, observation: string | null, replayed: boolean,
 *   warnings: string[]}} Receipt facts; missing fields are empty, not guessed.
 */
export function readSendReceipt(response) {
  const result = response?.result ?? {};
  const prompt = result.send?.prompt ?? null;
  return {
    accepted: result.send?.accepted === true,
    requestId: prompt?.requestId ?? result.mutation?.requestId ?? null,
    stages: Array.isArray(prompt?.stages) ? prompt.stages.map(String) : [],
    provider: prompt?.provider ?? null,
    observation: prompt?.observation ?? null,
    replayed: result.mutation?.replayed === true,
    warnings: Array.isArray(result.warnings) ? result.warnings.map(String) : [],
  };
}

/**
 * Finds the agent's input box on a screen: the lowest row that starts with a
 * prompt mark, plus the indented rows a long input wraps onto.
 *
 * @param {string[]} screen - Screen lines, oldest first.
 * @returns {{text: string, index: number, below: string[]} | null} The text
 *   typed in the box, its first row, and the rows under it; null when no row
 *   starts with a prompt mark.
 */
export function inputLine(screen) {
  const rows = (screen ?? []).map(String);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const match = INPUT_ROW.exec(rows[index]);
    if (!match) continue;
    let text = (match[1] ?? "").trim();
    let end = index;
    while (
      end + 1 < rows.length &&
      CONTINUATION_ROW.test(rows[end + 1]) &&
      !SEPARATOR_ROW.test(rows[end + 1])
    ) {
      end += 1;
      text += ` ${rows[end].trim()}`;
    }
    return { text, index, below: rows.slice(end + 1) };
  }
  return null;
}

const verdict = (outcome, reason) => ({
  outcome,
  reason,
  enter: outcome === "unsubmitted",
});

/**
 * Decides what a delivered prompt is, and whether one Enter may follow.
 *
 * `enter` is true only for `unsubmitted`: the approved text is alone in the
 * input box, and nothing under the box looks like agent output.
 *
 * @param {object} facts - What is known after the send.
 * @param {object} facts.receipt - Result of `readSendReceipt`.
 * @param {string[]} [facts.screen] - Screen lines, oldest first.
 * @param {string} facts.text - The approved text that was sent.
 * @returns {{outcome: string, reason: string, enter: boolean}} One of
 *   `DELIVERY_OUTCOMES` except `failed`, the evidence, and the Enter decision.
 */
export function judgeDelivery({ receipt, screen, text }) {
  if (!receipt?.accepted) return verdict("unclear", "not-accepted");
  if (receipt.stages?.includes("turn_started")) {
    return verdict("submitted", "turn-started");
  }
  const line = inputLine(screen);
  if (!line) return verdict("unclear", "no-input-box-on-screen");
  const shown = squeeze(line.text);
  const approved = squeeze(text);
  if (!shown) {
    const above = squeeze((screen ?? []).slice(0, line.index).join(""));
    return above.includes(approved)
      ? verdict("already-started", "input-left-the-box")
      : verdict("unclear", "empty-box-without-the-text");
  }
  if (shown === approved) {
    const rowsBelow = line.below.filter((row) => !SEPARATOR_ROW.test(row));
    return rowsBelow.length <= MAX_ROWS_BELOW_INPUT
      ? verdict("unsubmitted", "approved-text-in-box")
      : verdict("unclear", "text-in-a-row-with-output-below");
  }
  if (approved.startsWith(shown))
    return verdict("unclear", "text-still-arriving");
  return verdict("foreign-input", "box-holds-other-text");
}

// Only a rendered screen may earn an Enter. When Orca cannot render one it
// answers with `source: "screen-unavailable"` and returns accumulated output,
// where repainted lines pile up as fragments; a host that predates the field
// leaves `source` out. Neither shows what the input box holds, so both count
// as an empty screen and the judgement falls to `unclear`.
async function readScreen(orca, terminal, execute) {
  try {
    const read = await runOrcaJson(
      orca,
      ["terminal", "read", "--terminal", terminal, "--screen"],
      { execute },
    );
    const { source, tail } = read.result?.terminal ?? {};
    return source === "screen" ? (tail ?? []) : [];
  } catch {
    // An unreadable screen decides nothing; the judgement falls to `unclear`.
    return [];
  }
}

/**
 * Judges a `worker-start` hand-off that came back `ready` without `turn_started`.
 *
 * `worker-start` types Orca's own preamble around the approved spec or task
 * text, not that text itself (confirmed against this task's own start
 * receipt: the screen held Orca's preamble, never the literal spec), so
 * `judgeDelivery`'s exact-text comparison would read that preamble as
 * `foreign-input` and refuse to press Enter on a delivery that is in fact
 * only unsubmitted. The Dispatch's task id is the one anchor both the
 * receipt and the screen name unchanged, and Orca's own preamble states it
 * verbatim (e.g. "Your task ID is: task_..."), so it stands in for the text
 * match here: Enter follows only when that id turns up inside the input
 * box's own text, never merely because the box holds something. A box that
 * holds text naming no task id could be another dispatch's leftover input or
 * someone typing by hand, so `judgeDelivery`'s `foreign-input` reasoning
 * still applies to that case; without the exact approved text to compare
 * against, the anchor either turns up or it does not, and the verdict for
 * "does not" is `unclear` rather than `foreign-input`, since the caller must
 * withhold Enter exactly the same way regardless of which is true.
 *
 * @param {object} facts - What is known after the start.
 * @param {string[]} facts.stages - `result.prompt.stages` from the worker receipt.
 * @param {string[]} [facts.screen] - Screen lines, oldest first.
 * @param {string | null} [facts.taskId] - The Dispatch's task id, when known.
 * @returns {{outcome: string, reason: string, enter: boolean}} One of
 *   `DELIVERY_OUTCOMES` except `foreign-input` and `failed`.
 */
export function judgeWorkerStartDelivery({ stages, screen, taskId }) {
  if ((stages ?? []).includes("turn_started")) {
    return verdict("submitted", "turn-started");
  }
  const line = inputLine(screen);
  if (!line) return verdict("unclear", "no-input-box-on-screen");
  if (line.text) {
    return taskId && squeeze(line.text).includes(squeeze(taskId))
      ? verdict("unsubmitted", "text-in-box")
      : verdict("unclear", "text-in-box-without-task-id");
  }
  const above = squeeze((screen ?? []).slice(0, line.index).join(""));
  if (taskId && above.includes(squeeze(taskId))) {
    return verdict("already-started", "task-id-in-transcript");
  }
  return verdict("unclear", "empty-box-without-task-id");
}

/**
 * Confirms a `worker-start` hand-off by reading the terminal's screen once
 * and, when `judgeWorkerStartDelivery` finds the task still sitting
 * unsubmitted, pressing Enter exactly once.
 *
 * @param {object} options - Confirmation options.
 * @param {string} options.orca - Orca executable.
 * @param {string} options.terminal - Terminal handle worker-start reused.
 * @param {string[]} options.stages - `result.prompt.stages` from the worker receipt.
 * @param {string | null} [options.taskId] - The Dispatch's task id, when known.
 * @param {Function} [options.execute=run] - Injectable command runner.
 * @returns {Promise<{outcome: string, reason: string, enterSent: boolean, error?: string}>}
 *   The verdict and whether Enter was sent; `error` keeps Orca's own text when the send failed.
 */
export async function confirmWorkerSubmission({
  orca,
  terminal,
  stages,
  taskId,
  execute = run,
}) {
  const screen = await readScreen(orca, terminal, execute);
  const judged = judgeWorkerStartDelivery({ stages, screen, taskId });
  if (!judged.enter) {
    return { outcome: judged.outcome, reason: judged.reason, enterSent: false };
  }
  try {
    await runOrcaJson(
      orca,
      ["terminal", "send", "--terminal", terminal, "--text", "", "--enter"],
      { execute },
    );
    return { outcome: judged.outcome, reason: judged.reason, enterSent: true };
  } catch (caught) {
    return {
      outcome: judged.outcome,
      reason: judged.reason,
      enterSent: false,
      error: caught.message,
    };
  }
}

/**
 * Sends a prompt with Enter and reports whether it was really submitted.
 *
 * The text is sent once, with `--wait-submit`. When the receipt does not prove
 * the turn and the screen does not settle it, the same request is replayed with
 * `--retry-request`, which observes without typing again. Only a screen showing
 * the approved text alone in the input box earns a bare Enter, once, followed
 * by one more replay. A `foreign-input` or `unclear` result presses nothing.
 *
 * @param {object} options - Delivery options.
 * @param {string} options.orca - Orca executable.
 * @param {string} options.terminal - Terminal handle receiving the prompt.
 * @param {string} options.text - Approved prompt text.
 * @param {number} [options.waitSeconds=5] - Seconds each send observes for the turn.
 * @param {Function} [options.execute=run] - Injectable command runner.
 * @returns {Promise<{outcome: string, reason: string, delivered: boolean,
 *   enterSent: boolean, retried: boolean, requestId: string | null,
 *   stages: string[], observation: string | null, warnings: string[],
 *   error?: string}>} Verdict, and the receipt facts that back it. `error`
 *   keeps Orca's own text when a call failed.
 */
export async function deliverPrompt({
  orca,
  terminal,
  text,
  waitSeconds = 5,
  execute = run,
}) {
  const timeoutMs = (waitSeconds + 15) * 1000;
  const send = (extra) =>
    runOrcaJson(
      orca,
      [
        "terminal",
        "send",
        "--terminal",
        terminal,
        "--text",
        text,
        "--enter",
        "--wait-submit",
        String(waitSeconds),
        ...extra,
      ],
      { execute, timeoutMs },
    );
  const state = { enterSent: false, retried: false };
  let receipt;
  let error;
  try {
    receipt = readSendReceipt(await send([]));
  } catch (caught) {
    return {
      outcome: "failed",
      reason: "send-failed",
      delivered: false,
      ...state,
      requestId: null,
      stages: [],
      observation: null,
      warnings: [],
      error: caught.message,
    };
  }
  // The same request ID replays the receipt with fresh observation and types
  // nothing, so a replay can never duplicate the prompt.
  const replay = async () => {
    if (!receipt.requestId) return;
    state.retried = true;
    try {
      receipt = readSendReceipt(
        await send(["--retry-request", receipt.requestId]),
      );
    } catch (caught) {
      error = caught.message;
    }
  };
  const judge = async () =>
    receipt.stages.includes("turn_started")
      ? judgeDelivery({ receipt, text })
      : judgeDelivery({
          receipt,
          text,
          screen: await readScreen(orca, terminal, execute),
        });

  let judged = await judge();
  if (judged.outcome === "unclear" && receipt.requestId) {
    await replay();
    judged = await judge();
  }
  if (judged.enter) {
    state.enterSent = true;
    try {
      await runOrcaJson(
        orca,
        ["terminal", "send", "--terminal", terminal, "--text", "", "--enter"],
        { execute },
      );
      await replay();
    } catch (caught) {
      error = caught.message;
    }
    judged = await judge();
  }
  return {
    outcome: judged.outcome,
    reason: judged.reason,
    delivered: ["submitted", "already-started"].includes(judged.outcome),
    ...state,
    requestId: receipt.requestId,
    stages: receipt.stages,
    observation: receipt.observation,
    warnings: receipt.warnings,
    ...(error ? { error } : {}),
  };
}
