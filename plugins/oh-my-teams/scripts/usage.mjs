/**
 * Deterministic model-usage aggregation helpers.
 *
 * Missing usage and cost stay missing; callers must never interpret an absent
 * provider metric as zero consumption or zero monetary cost.
 */

/**
 * Creates an empty mutable accumulator for provider call metrics.
 *
 * @returns {object} Usage accumulator accepted by {@link addCallUsage}.
 */
export function createUsageAccumulator() {
  return {
    calls: 0,
    callsWithUsage: 0,
    tokens: {},
    callsWithCost: 0,
    knownCostUsd: null,
    requestedModels: [],
    requestedEfforts: [],
    effectiveModels: [],
    selectionReasons: [],
  };
}

function appendUnique(values, value, { includeNull = false } = {}) {
  if (
    ((value !== null && value !== undefined) || includeNull) &&
    !values.includes(value)
  ) {
    values.push(value);
  }
}

/**
 * Adds one provider call to an existing usage accumulator.
 *
 * @param {object} accumulator - Mutable value from `createUsageAccumulator`.
 * @param {object} call - Provider call record from a worker report.
 * @returns {object} The same accumulator for convenient chaining.
 */
export function addCallUsage(accumulator, call) {
  accumulator.calls += 1;
  appendUnique(
    accumulator.requestedModels,
    call.requestedModel ?? call.model ?? null,
    { includeNull: true },
  );
  // A call that ran at another reasoning depth is not comparable with the rest,
  // so the depth is kept beside the model instead of being averaged away.
  appendUnique(accumulator.requestedEfforts, call.requestedEffort ?? null, {
    includeNull: true,
  });
  appendUnique(accumulator.effectiveModels, call.effectiveModel);
  appendUnique(accumulator.selectionReasons, call.selectionReason);

  if (call.usage) {
    accumulator.callsWithUsage += 1;
    for (const [key, value] of Object.entries(call.usage)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        accumulator.tokens[key] = (accumulator.tokens[key] ?? 0) + value;
      }
    }
  }

  if (typeof call.costUsd === "number" && Number.isFinite(call.costUsd)) {
    accumulator.callsWithCost += 1;
    accumulator.knownCostUsd = (accumulator.knownCostUsd ?? 0) + call.costUsd;
  }
  return accumulator;
}

/**
 * Returns a serializable usage summary with explicit missing-metric counts.
 *
 * @param {object} accumulator - Mutable usage accumulator.
 * @returns {object} Final summary; missing values are counts, not fabricated zeroes.
 */
export function finalizeUsage(accumulator) {
  return {
    ...accumulator,
    missingUsageCalls: accumulator.calls - accumulator.callsWithUsage,
    missingCostCalls: accumulator.calls - accumulator.callsWithCost,
  };
}

/**
 * Groups call metrics by the profile that actually handled each invocation.
 *
 * @param {object[]} calls - Worker call records.
 * @returns {Record<string, object>} Finalized usage summaries keyed by profile.
 */
export function groupUsageByProfile(calls) {
  const groups = Object.create(null);
  for (const call of calls) {
    const group = (groups[call.profile] ??= createUsageAccumulator());
    addCallUsage(group, call);
  }
  return Object.fromEntries(
    Object.entries(groups).map(([profile, group]) => [
      profile,
      finalizeUsage(group),
    ]),
  );
}

/** Token fields every normalized usage record carries, in display order. */
export const TOKEN_FIELDS = Object.freeze([
  "promptTokens",
  "inputTokens",
  "cachedInputTokens",
  "cacheCreationTokens",
  "outputTokens",
  "reasoningTokens",
]);

function count(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sumKnown(...values) {
  const known = values.filter((value) => value !== null);
  return known.length ? known.reduce((total, value) => total + value, 0) : null;
}

// Each provider counts the prompt differently. Claude reports the uncached part
// and the two cache parts separately, so the prompt is their sum. Codex reports
// the whole prompt with the cached part inside it. Agy reports `input_tokens`
// beside `cache_read_tokens`, and whether the first includes the second is not
// documented, so its prompt is `input_tokens` alone and may undercount.
function usageStyle(provider, raw) {
  if (["claude", "codex", "agy"].includes(provider)) return provider;
  if ("cache_read_input_tokens" in raw || "cache_creation_input_tokens" in raw)
    return "claude";
  if ("cached_input_tokens" in raw) return "codex";
  if ("cache_read_tokens" in raw || "thinking_tokens" in raw) return "agy";
  return "plain";
}

/**
 * Maps one provider's raw token counters onto the shared usage fields.
 *
 * A counter the provider did not report stays `null`; nothing is filled with
 * zero, so a missing figure is never read as no consumption.
 *
 * @param {string | null} provider - `claude`, `codex`, `agy`, or another id.
 * @param {object | null} raw - Usage object as the provider wrote it.
 * @returns {object | null} Normalized counters, or null when none were numbers.
 */
export function normalizeTokenUsage(provider, raw) {
  if (!raw || typeof raw !== "object") return null;
  const style = usageStyle(provider, raw);
  let usage;
  if (style === "claude") {
    const input = count(raw.input_tokens);
    const cached = count(raw.cache_read_input_tokens);
    const creation = count(raw.cache_creation_input_tokens);
    usage = {
      promptTokens: sumKnown(input, cached, creation),
      inputTokens: input,
      cachedInputTokens: cached,
      cacheCreationTokens: creation,
      outputTokens: count(raw.output_tokens),
      reasoningTokens: count(raw.output_tokens_details?.thinking_tokens),
    };
  } else if (style === "codex") {
    const prompt = count(raw.input_tokens);
    const cached = count(raw.cached_input_tokens);
    usage = {
      promptTokens: prompt,
      inputTokens: prompt === null ? null : Math.max(0, prompt - (cached ?? 0)),
      cachedInputTokens: cached,
      cacheCreationTokens: count(raw.cache_write_input_tokens),
      outputTokens: count(raw.output_tokens),
      reasoningTokens: count(raw.reasoning_output_tokens),
    };
  } else {
    usage = {
      promptTokens: count(raw.input_tokens),
      inputTokens: count(raw.input_tokens),
      cachedInputTokens: count(raw.cache_read_tokens),
      cacheCreationTokens: null,
      outputTokens: count(raw.output_tokens),
      reasoningTokens: count(raw.thinking_tokens),
    };
  }
  return TOKEN_FIELDS.some((field) => usage[field] !== null) ? usage : null;
}

/**
 * Adds normalized token counters field by field, keeping unknown as unknown.
 *
 * @param {object | null} total - Running total, or null before the first value.
 * @param {object | null} usage - Normalized counters to add.
 * @returns {object | null} New total; a field stays null until some value has it.
 */
export function addTokenUsage(total, usage) {
  if (!usage) return total;
  const next = {};
  for (const field of TOKEN_FIELDS) {
    next[field] = sumKnown(total?.[field] ?? null, usage[field] ?? null);
  }
  return next;
}
