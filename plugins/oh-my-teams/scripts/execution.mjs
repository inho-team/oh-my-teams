/** Execution-runtime port: the receipt contract every adapter must satisfy. */
import { assert } from "./core.mjs";

/**
 * Liveness verdicts an execution adapter is allowed to report.
 *
 * `unverifiable` is absence rather than an intermediate state: it says the
 * adapter could not establish whether the worker runs. Folding it into `live`
 * or `exited` is exactly what lets an unobserved start read as a finished one,
 * so the three verdicts stay distinct and no adapter may invent a fourth.
 */
export const LIVENESS_VALUES = Object.freeze([
  "live",
  "unverifiable",
  "exited",
]);

/**
 * Routing kinds `classifyFailure` understands, shared by every adapter.
 *
 * An adapter translates its own runtime's vocabulary into these, so the
 * classifier never has to learn one runtime's error strings and a second
 * runtime can be added without touching failure routing.
 */
export const NEUTRAL_FAILURE_KINDS = Object.freeze([
  "requirement",
  "scope",
  "model-binding",
  "execution-unconfigured",
  // The runtime refused a launch before handing any work over, so nothing
  // started and there is no process to reconcile.
  "not-started",
  // A post-launch refusal that disagrees with the compatibility table's
  // prediction: the table itself must be revised before a retry helps.
  "matrix-mismatch",
  "workspace-context",
  "environment",
  "contract",
  "review",
  "implementation",
]);


/**
 * Validates the workspace receipt an execution adapter returns.
 *
 * @param {object} receipt - Adapter receipt naming the prepared workspace.
 * @returns {object} The same receipt, unchanged.
 * @throws {Error} When the workspace identity or path is missing.
 */
export function assertWorkspaceReceipt(receipt) {
  assert(
    receipt && typeof receipt.id === "string" && receipt.id.trim(),
    "Workspace receipt requires an identifier",
  );
  assert(
    typeof receipt.path === "string" && receipt.path.trim(),
    "Workspace receipt requires a path",
  );
  return receipt;
}

/**
 * Validates one translated failure signal before it reaches classification.
 *
 * The runtime's own code travels beside the neutral hints so that evidence
 * survives translation: a reader can still tell which runtime refused and with
 * which code, while routing depends only on the neutral fields.
 *
 * @param {object} signal - Failure translated by an execution adapter.
 * @returns {object} The same signal, unchanged.
 * @throws {Error} When the message, runtime code, or routing hint is invalid.
 */
export function assertFailureSignal(signal) {
  assert(
    signal && typeof signal.message === "string" && signal.message.trim(),
    "Failure signal requires a message",
  );
  assert(
    typeof signal.code === "string" && signal.code.trim(),
    "Failure signal requires the runtime's original code",
  );
  assert(
    signal.kind === undefined || NEUTRAL_FAILURE_KINDS.includes(signal.kind),
    `Failure signal carries an unknown kind: ${signal.kind}`,
  );
  assert(
    signal.processState === undefined || signal.processState === "unknown",
    "Failure signal may only mark process state as unknown",
  );
  // Routing reads an unknown process state before anything else, so a signal
  // carrying both would have its `kind` silently dropped. Rejecting the pair
  // keeps an adapter from believing it asked for a route it never got.
  assert(
    signal.kind === undefined || signal.processState === undefined,
    "Failure signal cannot claim both a routing kind and an unknown process",
  );
  return signal;
}

/**
 * Validates the worker receipt an execution adapter returns.
 *
 * A receipt states liveness explicitly and either carries a translated failure
 * or an explicit `null`. An absent field would let a caller read "no failure
 * recorded" as "started successfully", which is the confusion this port exists
 * to prevent. `residualResources` is required for the same reason: a reconciler
 * has to distinguish "nothing was left behind" from "nobody recorded it", and
 * only the adapter that made the resources can tell the difference.
 *
 * @param {object} receipt - Adapter receipt naming one started worker.
 * @returns {object} The same receipt, unchanged.
 * @throws {Error} When identity, liveness, or the failure signal is invalid.
 */
export function assertWorkerReceipt(receipt) {
  assert(
    receipt && typeof receipt.workerId === "string" && receipt.workerId.trim(),
    "Worker receipt requires an identifier",
  );
  assert(
    LIVENESS_VALUES.includes(receipt.liveness),
    `Worker receipt carries an unknown liveness: ${receipt.liveness}`,
  );
  assert(
    Array.isArray(receipt.residualResources),
    "Worker receipt requires the resources left behind, empty when there are none",
  );
  assert(
    receipt.failure === null || typeof receipt.failure === "object",
    "Worker receipt requires a failure signal or an explicit null",
  );
  if (receipt.failure !== null) assertFailureSignal(receipt.failure);
  return receipt;
}
