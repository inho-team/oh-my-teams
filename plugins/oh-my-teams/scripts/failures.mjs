/** Deterministic failure classification and evidence validation. */
import { assert } from "./core.mjs";

function route(category, nextOwner, action, retryable) {
  return { category, nextOwner, action, retryable };
}

/**
 * Maps observable failure signals to an owner and recovery action.
 *
 * Signal priority matters: an unknown process must be reconciled before its
 * textual error is interpreted as an implementation or environment failure.
 *
 * @param {object} [input={}] - Structured signals plus an optional message.
 * A limit is routed to `capacity-handoff` only when `onExhaustion` is
 * `fallback` and `fallbackAvailable` is true.
 * @returns {{category: string, nextOwner: string, action: string, retryable: boolean}}
 * Routing decision. `retryable` means the same contract may be attempted again.
 */
export function classifyFailure(input = {}) {
  const message = String(input.message ?? input.reason ?? "");

  if (input.processState === "unknown" || input.timedOut) {
    return route("process-unknown", "pl", "reconcile-execution", false);
  }
  const limited = input.kind === "rate-limited";
  // Missing capacity clears on its own, so the same profile is tried again
  // before any other profile takes the task over.
  if (limited && input.limitKind === "capacity") {
    return route("provider-capacity", "pm", "retry-after-capacity", true);
  }
  if (
    limited ||
    ["pool-exhausted", "quota-unknown"].includes(input.failureClass) ||
    /quota.?exhausted/i.test(message)
  ) {
    // A limit hands the task to a declared fallback of another provider only
    // when the organization chose fallback and one is still unused; the
    // caller that knows the organization supplies both facts.
    if (input.onExhaustion === "fallback" && input.fallbackAvailable === true) {
      return route("capacity-handoff", "pm", "handoff-to-fallback", true);
    }
    return route(
      "quota-exhausted",
      "pm",
      "apply-saved-quota-policy",
      input.failureClass === "pool-exhausted",
    );
  }
  if (
    input.kind === "requirement" ||
    /ambiguous|contradictory requirement/i.test(message)
  ) {
    return route("requirement-ambiguity", "pm", "revise-contract", false);
  }
  if (
    input.kind === "scope" ||
    /context too large|split large|scope too large/i.test(message)
  ) {
    return route("scope-too-large", "pl", "split-task", false);
  }
  // A model that answered from another model is a profile problem, not a
  // workspace problem: rebinding the workspace would leave the wrong model in
  // place, and retrying the same profile reproduces the mismatch.
  if (
    input.kind === "model-binding" ||
    input.modelProof === "mismatched" ||
    /answered from .+ while .+ was requested|routing evidence is invalid/i.test(
      message,
    )
  ) {
    return route("model-binding-mismatch", "pm", "rebind-profile-model", false);
  }
  // An execution runtime that does not know the requested agent refuses every
  // attempt carrying the same profile, so a retry reproduces the refusal. Only
  // rebinding the profile to an agent that runtime does launch changes the
  // outcome, and that binding is owned by the role that assigned the profile.
  if (input.kind === "execution-unconfigured") {
    return route("execution-unconfigured", "pm", "rebind-profile-agent", false);
  }
  // A launch refused before any work was handed over started nothing, so
  // reconciling a process would inspect one that never existed. The same
  // terminal refuses again, and choosing another launch path is PM's
  // decision at every run depth.
  if (input.kind === "not-started") {
    return route("start-refused", "pm", "change-launch-path", false);
  }
  // A post-launch refusal that the compatibility matrix predicted would succeed
  // means the table itself is wrong: retrying the same combination reproduces
  // the failure, and only revising the matrix changes the outcome.
  if (input.kind === "matrix-mismatch") {
    return route("matrix-prediction-failure", "pm", "revise-matrix", false);
  }
  if (
    input.kind === "workspace-context" ||
    input.grounded === false ||
    /different tree|do not exist in this workspace/i.test(message)
  ) {
    return route("environment-context", "pl", "rebind-workspace", true);
  }
  if (
    input.kind === "environment" ||
    input.exitCode === 127 ||
    /fixture|tool not found|environment/i.test(message)
  ) {
    return route("environment-failure", "pl", "repair-environment", true);
  }
  if (
    input.kind === "contract" ||
    /contract conflict|dependency revision/i.test(message)
  ) {
    return route("contract-conflict", "pl", "revise-shared-contract", false);
  }
  if (
    input.kind === "review" ||
    /changes-requested|review rejected/i.test(message)
  ) {
    return route("review-rejection", "junior", "resolve-findings", true);
  }
  if (
    input.kind === "implementation" ||
    input.checkFailed ||
    /check failed|test failed|implementation/i.test(message)
  ) {
    return route("implementation-error", "junior", "fix-implementation", true);
  }
  return route("unknown", "senior", "classify-with-evidence", false);
}

/**
 * Validates the minimum durable evidence required for failure routing.
 *
 * @param {object} input - Failure record with message and evidence reference.
 * @returns {object} The same validated input.
 * @throws {Error} When the message or evidence reference is absent.
 */
export function validateFailureEvidence(input) {
  assert(
    input && typeof input.message === "string" && input.message.trim(),
    "Failure message required",
  );
  assert(
    typeof input.evidence === "string" && input.evidence.trim(),
    "Failure evidence reference required",
  );
  return input;
}
