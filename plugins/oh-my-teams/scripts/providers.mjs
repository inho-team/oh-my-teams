/** Provider command construction, output normalization, and failure classification. */
import { assert, profileEnv, run } from "./core.mjs";

/**
 * Builds a shell-free command for one supported model provider.
 *
 * Model identifiers are opaque configuration values. The runtime does not infer
 * price or quality, and it gives every provider read-only/no-tool constraints.
 *
 * @param {object} profile - Valid provider profile with command and optional model.
 * @param {string} cwd - Workspace exposed as read-only model context.
 * @param {string} prompt - Literal prompt passed through stdin or argv.
 * @returns {{argv: string[], input: string}} Command arguments and stdin payload.
 * @throws {Error} When the provider is unsupported.
 */
export function providerCommand(profile, cwd, prompt) {
  const argv = [...profile.command];
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
      "5m",
    );
    if (profile.model) argv.push("--model", profile.model);
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
  if (requested === null) return { requested, effective, status: "unrequested" };
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

  const combined = `${result.stderr}\n${result.stdout}`;
  if (
    String(error?.status ?? "") === "429" ||
    code === "429" ||
    /RESOURCE_EXHAUSTED|quota.?exhausted/i.test(combined)
  ) {
    return "quota-unknown";
  }
  if (/rate.?limit|too many requests/i.test(combined)) return "rate-limit";
  return decoded.providerError || result.code !== 0 ? "model-error" : "unknown";
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
  const { argv, input } = providerCommand(profile, cwd, prompt);
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
    exhausted: ["pool-exhausted", "quota-unknown", "rate-limit"].includes(
      failureClass,
    ),
  };
}
