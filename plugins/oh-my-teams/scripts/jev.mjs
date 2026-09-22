/**
 * Experimental TypeSafe Jev judgments recorded beside deterministic decisions.
 *
 * Jev answers narrow questions with typed judgments and probabilities instead
 * of generated text. A role that called it itself would spend a turn reading
 * the answer, so the calls here run inside runtime commands that already hold
 * the input. In `shadow` mode a judgment is only written to the state
 * directory; the command's result is unchanged, and no gate reads the record.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { hash, jevPolicy, writeJSON } from "./core.mjs";

/** TypeSafe System One endpoint. */
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/**
 * Input price in US dollars per million tokens, as published on 2026-09-22.
 *
 * Output tokens are free, so a judgment's cost is its input tokens alone.
 */
export const JEV_INPUT_USD_PER_MTOK = 0.042;

const STATE_DIRECTORY = "judgments";
const MESSAGE_CHARS = 2000;
const OUTPUT_TAIL_CHARS = 6000;
const SCREEN_TAIL_CHARS = 4000;
const FAILURE_CHARS = 4000;

const clip = (text, limit) => String(text ?? "").slice(0, limit);
const tail = (text, limit) => String(text ?? "").slice(-limit);

function noul(instructions, criteria) {
  return { type: "noul", instructions, criteria };
}

function choice(instructions, criteria) {
  return { type: "choice", instructions, criteria };
}

/**
 * Sends one System One request.
 *
 * No retry is made: every caller sits on a path that must not wait, and a
 * missing judgment only leaves the deterministic decision in place.
 *
 * @param {object} request - Request parts.
 * @param {string} request.apiKey - TypeSafe API key.
 * @param {string} request.model - Pinned model version.
 * @param {object} request.state - Facts every question reads.
 * @param {object} request.questions - Questions keyed by id.
 * @param {number} request.timeoutMs - Abort after this many milliseconds.
 * @param {Function} [request.fetchImpl=fetch] - Injectable fetch.
 * @returns {Promise<object>} `{model, answers, usage, requestId, elapsedMs}`.
 * @throws {Error} With `status` for an HTTP refusal, or the abort or network error.
 */
export async function callSystemOne({
  apiKey,
  model,
  state,
  questions,
  timeoutMs,
  fetchImpl = fetch,
}) {
  const started = Date.now();
  const response = await fetchImpl(JEV_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, state, questions }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const requestId = response.headers?.get?.("x-typesafe-request-id") ?? null;
  if (!response.ok) {
    const error = new Error(`TypeSafe refused the request: ${response.status}`);
    error.status = response.status;
    error.requestId = requestId;
    throw error;
  }
  const body = await response.json();
  return {
    model: typeof body.model === "string" ? body.model : null,
    answers:
      body.answers && typeof body.answers === "object" ? body.answers : {},
    usage: body.usage && typeof body.usage === "object" ? body.usage : null,
    requestId,
    elapsedMs: Date.now() - started,
  };
}

// One empty file per spent call, created exclusively, so parallel commands
// sharing a state directory cannot spend the same slot twice.
function claimSlot(directory, budget) {
  fs.mkdirSync(directory, { recursive: true });
  for (let slot = 1; slot <= budget; slot += 1) {
    try {
      fs.writeFileSync(path.join(directory, `.slot-${slot}`), "", {
        flag: "wx",
      });
      return slot;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  return null;
}

function costOf(usage) {
  const input = usage?.input_tokens;
  return Number.isFinite(input) ? (input * JEV_INPUT_USD_PER_MTOK) / 1e6 : null;
}

/**
 * Records one experimental judgment for a decision point.
 *
 * The record keeps a hash of the state, never the state itself: worker output
 * and screens can hold environment values, and a judgment file is not the
 * place to keep them. A call that fails is recorded and swallowed, so the
 * command it runs inside returns exactly what it would have returned.
 *
 * @param {object} options - Judgment inputs.
 * @param {object} options.org - Validated organization.
 * @param {string} [options.stateDir] - Shared coordinator state; nothing runs without it.
 * @param {string} options.point - One of `JEV_POINTS`.
 * @param {object} options.state - Facts sent to Jev.
 * @param {object} options.questions - Questions keyed by id.
 * @param {object} [options.context={}] - Small non-secret facts kept for later comparison.
 * @param {object} [options.env=process.env] - Environment holding `TYPESAFE_API_KEY`.
 * @param {Function} [options.fetchImpl=fetch] - Injectable fetch.
 * @returns {Promise<object | null>} The written record, or null when the point is off.
 */
export async function judge({
  org,
  stateDir,
  point,
  state,
  questions,
  context = {},
  env = process.env,
  fetchImpl = fetch,
}) {
  const policy = jevPolicy(org);
  if (!policy || !policy.points.includes(point) || !stateDir) return null;
  const directory = path.resolve(stateDir, STATE_DIRECTORY);
  const record = {
    schemaVersion: 1,
    id: `${point}-${crypto.randomUUID()}`,
    point,
    mode: policy.mode,
    callerRole: null,
    provider: "typesafe",
    profile: null,
    requestedModel: policy.model,
    effectiveModel: null,
    stateHash: hash(state),
    questionIds: Object.keys(questions),
    context,
    createdAt: new Date().toISOString(),
    responsibility:
      "shadow judgment; it changes no decision and approves nothing",
  };
  try {
    const apiKey = env.TYPESAFE_API_KEY;
    if (!apiKey) {
      return write(directory, {
        ...record,
        status: "unavailable",
        reason: "missing-api-key",
      });
    }
    const slot = claimSlot(
      path.join(directory, ".slots"),
      policy.budgetPerKickoff,
    );
    if (slot === null) {
      return write(directory, {
        ...record,
        status: "unavailable",
        reason: "budget-exhausted",
      });
    }
    try {
      const response = await callSystemOne({
        apiKey,
        model: policy.model,
        state,
        questions,
        timeoutMs: policy.timeoutMs,
        fetchImpl,
      });
      return write(directory, {
        ...record,
        status: "answered",
        slot,
        effectiveModel: response.model,
        answers: response.answers,
        usage: response.usage,
        costUsd: costOf(response.usage),
        requestId: response.requestId,
        elapsedMs: response.elapsedMs,
      });
    } catch (error) {
      return write(directory, {
        ...record,
        status: "failed",
        slot,
        reason: error.status ? `http-${error.status}` : error.name || "error",
        requestId: error.requestId ?? null,
      });
    }
  } catch {
    // A state directory that cannot be written must not fail the command.
    return null;
  }
}

function write(directory, record) {
  writeJSON(path.join(directory, `${record.id}.json`), record);
  return record;
}

/**
 * Judges whether a Delivery of status messages needed the supervisor.
 *
 * Only a Delivery made entirely of `status` messages is judged, because that is
 * the only kind a later filter could hold back: `worker_done`, `question` and
 * `escalation` always wake the supervisor.
 *
 * @param {object} options - `org`, `stateDir`, the `delivery` returned by the wait, and fetch/env overrides.
 * @returns {Promise<object | null>} The record, or null when nothing was judged.
 */
export async function shadowStatusFilter({ delivery, ...options }) {
  const messages = delivery?.messages ?? [];
  if (
    messages.length === 0 ||
    !messages.every((message) => message?.type === "status")
  )
    return null;
  return judge({
    ...options,
    point: "status-filter",
    state: {
      messages: messages.map((message) => ({
        type: message.type,
        subject: clip(message.subject, 300),
        body: clip(message.body ?? message.payload, MESSAGE_CHARS),
      })),
    },
    questions: {
      needs_action: noul(
        "Does any message in `messages` require the supervisor to act now, for example by answering a question, " +
          "deciding something, handling a blocker or failure, or accepting finished work? " +
          "A routine progress update that needs no reply is not an action.",
        {
          true: "At least one message needs the supervisor to act now.",
          false:
            "Every message is a routine progress update that needs no reply.",
        },
      ),
      kind: choice(
        "Which best describes the most important message in `messages`?",
        {
          progress:
            "Routine progress: the current step, finished and remaining items, and no blocker.",
          blocker:
            "Reports a blocker, a failure, or that the worker cannot continue.",
          question: "Asks the supervisor a question or requests a decision.",
          completion: "Says the assigned work is finished.",
          other: "None of the above.",
        },
      ),
    },
    context: {
      deliveryId: delivery.deliveryId ?? null,
      messageCount: messages.length,
    },
  });
}

// worker-read's page layout is Orca's; every string under `result` is kept in
// order, so a changed row shape still yields the text a person would read.
function outputText(envelope) {
  const parts = [];
  const visit = (value) => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object")
      Object.values(value).forEach(visit);
  };
  visit(envelope?.result);
  return parts.join("\n");
}

/**
 * Judges what a stalled worker is doing from the end of its output.
 *
 * @param {object} options - `org`, `stateDir`, `dispatchId`, the `decision` from
 *   `nextSupervisionAction`, the observed `liveness`, `readOutput` returning a
 *   worker-read envelope, and fetch/env overrides.
 * @returns {Promise<object | null>} The record, or null when nothing was judged.
 */
export async function shadowAutoObserve({
  dispatchId,
  decision,
  liveness,
  readOutput,
  ...options
}) {
  const policy = jevPolicy(options.org);
  if (
    !policy?.points.includes("auto-observe") ||
    !options.stateDir ||
    !dispatchId
  )
    return null;
  let text;
  try {
    text = outputText(await readOutput(dispatchId));
  } catch {
    return null;
  }
  if (!text.trim()) return null;
  return judge({
    ...options,
    point: "auto-observe",
    state: { worker_output_tail: tail(text, OUTPUT_TAIL_CHARS) },
    questions: {
      state: choice(
        "What is the worker doing, judged from the end of its output in `worker_output_tail`?",
        {
          working: "Still producing output or running tools on its task.",
          "waiting-for-input":
            "Stopped at a prompt, a permission question, or a question to a person.",
          "usage-limit": "Stopped by a usage, quota, or rate limit.",
          crashed: "The agent exited, crashed, or returned to a shell prompt.",
          finished: "Says its work is finished but has not reported it.",
          unclear: "The output does not show which of these applies.",
        },
      ),
    },
    context: {
      dispatchId,
      liveness: liveness ?? null,
      action: decision?.action ?? null,
      reason: decision?.reason ?? null,
    },
  });
}

/**
 * Judges whether a freshly opened role terminal shows the requested model.
 *
 * @param {object} options - `org`, `stateDir`, the `opened` result of
 *   `openRoleTerminal`, and fetch/env overrides.
 * @returns {Promise<object | null>} The record, or null when nothing was judged.
 */
export async function shadowModelCheck({ opened, ...options }) {
  if (!opened?.screen || !opened.modelRequested) return null;
  return judge({
    ...options,
    point: "model-check",
    state: {
      requested_model: opened.modelRequested,
      provider: opened.provider ?? null,
      screen: tail(opened.screen, SCREEN_TAIL_CHARS),
    },
    questions: {
      match: choice(
        "Does the terminal screen in `screen` show that the agent is running `requested_model`?",
        {
          matches:
            "The screen names the requested model or an unambiguous name for it.",
          "different-model": "The screen names a different model.",
          "not-shown": "The screen does not name any model.",
        },
      ),
    },
    context: {
      role: opened.role ?? null,
      profile: opened.profile ?? null,
      provider: opened.provider ?? null,
      modelRequested: opened.modelRequested,
      ready: opened.ready ?? null,
    },
  });
}

const FAILURE_CATEGORIES = {
  "process-unknown":
    "The worker process state is unknown or the call timed out.",
  "quota-exhausted": "A usage quota or subscription limit was exhausted.",
  "requirement-ambiguity": "The requirement is ambiguous or contradictory.",
  "scope-too-large":
    "The task or its context is too large and should be split.",
  "model-binding-mismatch":
    "A different model answered than the one requested.",
  "environment-context":
    "The work ran against the wrong tree or files missing from this workspace.",
  "environment-failure":
    "A tool, fixture, or environment dependency is missing or broken.",
  "contract-conflict": "A shared contract or dependency revision conflicts.",
  "review-rejection": "A review requested changes.",
  "implementation-error":
    "The implementation is wrong or a check or test failed.",
  unclear: "The evidence does not show the cause.",
};

/**
 * Judges the category of a failure the deterministic rules left `unknown`.
 *
 * @param {object} options - `org`, `stateDir`, the failure `input`, the
 *   deterministic `decision`, and fetch/env overrides.
 * @returns {Promise<object | null>} The record, or null when nothing was judged.
 */
export async function shadowFailureFallback({ input, decision, ...options }) {
  if (decision?.category !== "unknown") return null;
  const signals = {};
  for (const key of [
    "kind",
    "exitCode",
    "failureClass",
    "processState",
    "modelProof",
    "grounded",
  ]) {
    if (input?.[key] !== undefined) signals[key] = input[key];
  }
  return judge({
    ...options,
    point: "failure-fallback",
    state: { message: clip(input?.message, FAILURE_CHARS), signals },
    questions: {
      category: choice(
        "Which category best explains the failure described in `message` and `signals`?",
        FAILURE_CATEGORIES,
      ),
    },
    context: { deterministic: decision.category },
  });
}
