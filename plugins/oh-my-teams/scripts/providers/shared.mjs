/**
 * Decoding, failure classification, and argument helpers shared by adapters.
 *
 * Adapters raise plain `Error`s instead of importing `assert` from `core.mjs`,
 * because `core.mjs` reads the adapter registry while deriving its own provider
 * tables. Keeping this module free of `core.mjs` imports removes the cycle
 * rather than relying on module evaluation order to hide it.
 */

/** Headroom so a provider self-terminates before the runtime kills the process. */
const PRINT_TIMEOUT_MARGIN_MS = 5000;

/**
 * Throws a provider configuration or protocol error when a condition fails.
 *
 * @param {unknown} condition - Value treated as a boolean assertion.
 * @param {string} message - Operator-facing failure description.
 * @returns {asserts condition}
 * @throws {Error} When the condition is falsy.
 */
export function assertProvider(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Converts the call budget into a provider's own print-mode wait.
 *
 * A provider killed mid-call still consumed shared-pool quota but returns no
 * usage envelope, so its own wait must expire first and report what it spent.
 *
 * @param {number} timeoutMs - Call budget the runtime enforces.
 * @returns {string} Go-style duration accepted by `--print-timeout`.
 */
export function printTimeout(timeoutMs) {
  const budget = Math.max(timeoutMs - PRINT_TIMEOUT_MARGIN_MS, 1000);
  return `${Math.round(budget / 1000)}s`;
}

/**
 * Parses text as JSON and reports failure as `undefined` rather than throwing.
 *
 * @param {string} text - Candidate JSON document.
 * @returns {unknown} Parsed value, or `undefined` when the text is not JSON.
 */
export function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Parses newline-delimited JSON, skipping lines that are not JSON values.
 *
 * @param {string} stdout - Raw provider standard output.
 * @returns {unknown[]} Every line that parsed as JSON, in emission order.
 */
export function parseJsonLines(stdout) {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const event = tryParseJson(line);
    return event === undefined ? [] : [event];
  });
}

/**
 * Normalizes JSON-envelope and JSONL agent-CLI output into one result shape.
 *
 * @param {string} stdout - Raw provider standard output.
 * @returns {object} Text, usage, effective model, cost, and provider-error flag.
 */
export function decodeAgentCli(stdout) {
  const envelope = tryParseJson(stdout);
  const events = parseJsonLines(stdout);
  let text =
    typeof envelope?.result === "string"
      ? envelope.result
      : typeof envelope?.response === "string"
        ? envelope.response
        : undefined;
  let usage = envelope?.usage ?? null;
  let effectiveModel =
    typeof envelope?.model === "string" ? envelope.model : null;

  for (const event of events) {
    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message"
    ) {
      text = event.item.text;
    }
    if (event.type === "result" && typeof event.result === "string") {
      text = event.result;
    }
    if (event.usage) usage = event.usage;
    if (typeof event.model === "string") effectiveModel = event.model;
    if (typeof event.model_id === "string") effectiveModel = event.model_id;
  }

  if (
    !text &&
    envelope &&
    (envelope.edits || envelope.citations || envelope.findings)
  ) {
    text = JSON.stringify(envelope);
  }
  const providerError =
    envelope?.is_error === true ||
    envelope?.error != null ||
    envelope?.type === "error" ||
    events.some((event) => event.type === "error");
  return {
    text: text ?? stdout,
    usage,
    effectiveModel,
    costUsd:
      typeof envelope?.total_cost_usd === "number"
        ? envelope.total_cost_usd
        : null,
    providerError,
  };
}

/**
 * Classifies a failed agent-CLI call without treating arbitrary `429` text as quota.
 *
 * Only a structured pool scope proves shared-pool exhaustion. Ambiguous quota
 * signals stop safely as `quota-unknown` instead of probing more pool members.
 *
 * @param {object} result - Raw command result.
 * @param {object} decoded - Normalized output from {@link decodeAgentCli}.
 * @returns {string | null} Stable failure class, or `null` for success.
 */
export function classifyAgentCliFailure(result, decoded) {
  if (result.code === 0 && !decoded.providerError) return null;

  const envelope = tryParseJson(result.stdout);
  const error = envelope?.error ?? envelope;
  const code = String(error?.code ?? error?.type ?? "").toLowerCase();
  const scope = String(error?.scope ?? error?.quotaScope ?? "").toLowerCase();
  if (
    (code.includes("pool_exhausted") || code.includes("resource_exhausted")) &&
    scope === "pool"
  ) {
    return "pool-exhausted";
  }

  // Text signals are read from the transport channel and from a payload the
  // provider itself marked as an error. A successful answer's stdout is the
  // model's own words: a task about rate limiting used to make its own output
  // read as capacity loss, and the caller then abandoned every remaining
  // fallback profile on what was only a model error.
  const transport = decoded.providerError
    ? `${result.stderr ?? ""}\n${result.stdout ?? ""}`
    : String(result.stderr ?? "");
  if (
    String(error?.status ?? "") === "429" ||
    code === "429" ||
    /RESOURCE_EXHAUSTED|quota.?exhausted/i.test(transport)
  ) {
    return "quota-unknown";
  }
  if (/rate.?limit|too many requests/i.test(transport)) return "rate-limit";
  return "model-error";
}

/**
 * Reads how long a provider says its exhausted capacity stays unavailable.
 *
 * Agy reports exhaustion as a prose string rather than structured fields, so
 * the reset it names is the only thing separating "retry after this window"
 * from "escalate now". Discarding it leaves an operator with a dead pool and
 * no idea when work can resume.
 *
 * @param {object} result - Raw command result.
 * @param {object} decoded - Normalized output from {@link decodeAgentCli}.
 * @returns {string | null} Provider-reported reset window, or `null`.
 */
export function agentCliResetHint(result, decoded) {
  if (!decoded.providerError) return null;
  const envelope = tryParseJson(result.stdout);
  const error = envelope?.error ?? envelope;
  const text = typeof error === "string" ? error : `${result.stdout ?? ""}`;
  const pattern =
    /\bresets?\s+in\s+([0-9]+(?:\.[0-9]+)?[hms](?:[0-9]+(?:\.[0-9]+)?[hms])*)/i;
  const match = pattern.exec(text);
  return match ? match[1] : null;
}
