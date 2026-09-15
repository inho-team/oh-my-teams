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
