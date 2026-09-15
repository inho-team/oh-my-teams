/** Provider command construction, output normalization, and failure classification. */
import { assert, PROVIDER_EFFORTS, profileEnv, run } from "./core.mjs";

/** Headroom so a provider self-terminates before the runtime kills the process. */
const PRINT_TIMEOUT_MARGIN_MS = 5000;

/**
 * Converts the call budget into the provider's own print-mode wait.
 *
 * A provider killed mid-call still consumed shared-pool quota but returns no
 * usage envelope, so its own wait must expire first and report what it spent.
 *
 * @param {number} timeoutMs - Call budget the runtime enforces.
 * @returns {string} Go-style duration accepted by `--print-timeout`.
 */
function printTimeout(timeoutMs) {
  const budget = Math.max(timeoutMs - PRINT_TIMEOUT_MARGIN_MS, 1000);
  return `${Math.round(budget / 1000)}s`;
}

/**
 * Returns the effort a profile asks for after re-checking provider support.
 *
 * `validateOrg` already rejects an unsupported pairing, but a profile can also
 * reach here from a caller that never loaded an organization document. Silently
 * dropping the level would run the call at a different reasoning depth than the
 * report later claims, so an unsupported pairing fails instead.
 *
 * @param {object} profile - Provider profile, possibly carrying `effort`.
 * @returns {string | null} Validated effort, or `null` to keep the CLI default.
 * @throws {Error} When the provider cannot select the requested effort.
 */
function requestedEffort(profile) {
  if (profile.effort === undefined || profile.effort === null) return null;
  const accepted = PROVIDER_EFFORTS[profile.provider] ?? [];
  assert(
    accepted.includes(profile.effort),
    `Provider ${profile.provider} cannot select effort ${profile.effort}`,
  );
  return profile.effort;
}

/**
 * Builds a shell-free command for one supported model provider.
 *
 * Model identifiers are opaque configuration values. The runtime does not infer
 * price or quality, and it gives every provider read-only/no-tool constraints.
 *
 * A profile without `effort` sends no effort argument, so the provider keeps the
 * default its own account settings define. Each provider carries the level
 * differently: Agy takes an `--effort` flag, while Codex has no `exec` flag and
 * takes a `--config model_reasoning_effort=<value>` override.
 *
 * @param {object} profile - Valid provider profile with command and optional model.
 * @param {string} cwd - Workspace exposed as read-only model context.
 * @param {string} prompt - Literal prompt passed through stdin or argv.
 * @param {number} [timeoutMs=300000] - Call budget the runtime enforces.
 * @returns {{argv: string[], input: string}} Command arguments and stdin payload.
 * @throws {Error} When the provider is unsupported.
 */
export function providerCommand(profile, cwd, prompt, timeoutMs = 300000) {
  const argv = [...profile.command];
  const effort = requestedEffort(profile);
  if (profile.provider === "agy") {
    argv.push(
      "--mode",
      "plan",
      "--sandbox",
      "--add-dir",
      cwd,
      "--disable-slash-commands",
      "--output-format",
      "json",
      "--print-timeout",
      printTimeout(timeoutMs),
    );
    if (profile.model) argv.push("--model", profile.model);
    if (effort) argv.push("--effort", effort);
    argv.push("-p", prompt);
    return { argv, input: "" };
  }

  if (profile.provider === "claude") {
    argv.push(
      "--print",
      "--output-format",
      "json",
      "--tools",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
    );
    if (profile.model) argv.push("--model", profile.model);
    return { argv, input: prompt };
  }

  assert(profile.provider === "codex", "Unsupported provider");
  argv.push(
    "exec",
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--json",
    "--cd",
    cwd,
  );
  if (profile.model) argv.push("--model", profile.model);
  // The long name is deliberate: `-c` means `--continue` on the Agy CLI, so the
  // short form would read as the opposite of a one-shot call.
  if (effort) argv.push("--config", `model_reasoning_effort=${effort}`);
  argv.push("-");
  return { argv, input: prompt };
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseJsonLines(stdout) {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const event = tryParseJson(line);
    return event === undefined ? [] : [event];
  });
}

/**
 * Normalizes JSON-envelope and JSONL provider output into one result shape.
 *
 * @param {string} stdout - Raw provider standard output.
 * @returns {object} Text, usage, effective model, cost, and provider-error flag.
 */
export function decodeOutput(stdout) {
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
 * Compares the requested profile model with the model the provider reported.
 *
 * Routing, quota, and cost decisions are all made from the requested model, so
 * a provider that silently answers from another model invalidates them. Absent
 * model metadata stays `unproven` instead of being read as agreement.
 *
 * @param {object} profile - Provider profile carrying the requested model.
 * @param {object} decoded - Normalized output from {@link decodeOutput}.
 * @returns {{requested: string | null, effective: string | null, status: string}}
 * Status is `unrequested`, `unproven`, `matched`, or `mismatched`.
 */
export function modelBinding(profile, decoded) {
  const requested = profile?.model ?? null;
  const effective = decoded?.effectiveModel ?? null;
  if (requested === null)
    return { requested, effective, status: "unrequested" };
  if (effective === null) return { requested, effective, status: "unproven" };
  return {
    requested,
    effective,
    status: effective === requested ? "matched" : "mismatched",
  };
}

/**
 * Classifies a failed provider call without treating arbitrary `429` text as quota.
 *
 * Only a structured pool scope proves shared-pool exhaustion. Ambiguous quota
 * signals stop safely as `quota-unknown` instead of probing more pool members.
 *
 * @param {object} result - Raw command result.
 * @param {object} decoded - Normalized output from {@link decodeOutput}.
 * @returns {string | null} Stable failure class, or `null` for success.
 */
export function classifyProviderFailure(result, decoded) {
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
 * @param {object} decoded - Normalized output from {@link decodeOutput}.
 * @returns {string | null} Provider-reported reset window, or `null`.
 */
export function capacityResetHint(result, decoded) {
  if (!decoded.providerError) return null;
  const envelope = tryParseJson(result.stdout);
  const error = envelope?.error ?? envelope;
  const text = typeof error === "string" ? error : `${result.stdout ?? ""}`;
  const pattern =
    /\bresets?\s+in\s+([0-9]+(?:\.[0-9]+)?[hms](?:[0-9]+(?:\.[0-9]+)?[hms])*)/i;
  const match = pattern.exec(text);
  return match ? match[1] : null;
}

/**
 * Extracts a JSON object from plain, fenced, or prose-wrapped model text.
 *
 * @param {string} text - Model response text.
 * @returns {object} Parsed JSON payload.
 * @throws {Error | SyntaxError} When no valid JSON object can be found.
 */
export function parseModelJSON(text) {
  const direct = tryParseJson(text);
  if (direct !== undefined) return direct;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return JSON.parse(fenced[1]);

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  assert(start >= 0 && end > start, "Model did not return a JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Invokes one provider and returns raw plus normalized response metadata.
 *
 * @param {object} profile - Provider profile and environment references.
 * @param {string} cwd - Invocation workspace.
 * @param {string} prompt - Literal model prompt.
 * @param {number} timeoutMs - Maximum provider runtime.
 * @param {Function} [execute=run] - Injectable process runner.
 * @returns {Promise<object>} Process, output, usage, and failure metadata.
 */
export async function invoke(profile, cwd, prompt, timeoutMs, execute = run) {
  const { argv, input } = providerCommand(profile, cwd, prompt, timeoutMs);
  const result = await execute(argv, {
    cwd,
    input,
    timeoutMs,
    env: profileEnv(profile),
  });
  const decoded = decodeOutput(result.stdout);
  const failureClass = classifyProviderFailure(result, decoded);
  return {
    ...result,
    ...decoded,
    modelBinding: modelBinding(profile, decoded),
    failureClass,
    capacityResetsIn: capacityResetHint(result, decoded),
    exhausted: ["pool-exhausted", "quota-unknown", "rate-limit"].includes(
      failureClass,
    ),
  };
}
