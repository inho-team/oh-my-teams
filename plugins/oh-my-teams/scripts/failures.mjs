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
 * @returns {{category: string, nextOwner: string, action: string, retryable: boolean}}
 * Routing decision. `retryable` means the same contract may be attempted again.
 */
export function classifyFailure(input = {}) {
  const message = String(input.message ?? input.reason ?? "");

  if (input.processState === "unknown" || input.timedOut) {
    return route("process-unknown", "pl", "reconcile-execution", false);
  }
  if (
    ["pool-exhausted", "quota-unknown"].includes(input.failureClass) ||
    /quota.?exhausted/i.test(message)
  ) {
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
