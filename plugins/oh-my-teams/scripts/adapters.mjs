/** Execution runtime registry: one name to the adapter that speaks for it. */
import { assert } from "./core.mjs";
import {
  assertOrcaDiscovery,
  confirmOrcaWorkspace,
  readOrcaWorkspaceClaim,
  translateOrcaFailure,
} from "./orca-adapter.mjs";
import {
  assertLocalDiscovery,
  confirmLocalWorkspace,
  readLocalWorkspaceClaim,
  translateLocalCode,
} from "./local-adapter.mjs";

/**
 * Execution adapters keyed by the runtime name a caller can write down.
 *
 * This is the one place a runtime name is resolved. Adding a runtime means
 * adding its adapter and one entry here; nothing in failure routing or
 * workspace attachment changes, which is the property the port exists to hold.
 */
const EXECUTION_ADAPTERS = Object.freeze({
  orca: Object.freeze({
    translateCode: translateOrcaFailure,
    assertDiscovery: assertOrcaDiscovery,
    readWorkspaceClaim: readOrcaWorkspaceClaim,
    confirmWorkspace: confirmOrcaWorkspace,
  }),
  local: Object.freeze({
    translateCode: translateLocalCode,
    assertDiscovery: assertLocalDiscovery,
    readWorkspaceClaim: readLocalWorkspaceClaim,
    confirmWorkspace: confirmLocalWorkspace,
  }),
});

/** Runtime names a failure or workspace record may name, in registration order. */
export const EXECUTION_RUNTIMES = Object.freeze(
  Object.keys(EXECUTION_ADAPTERS),
);

/**
 * Resolves one registered runtime name to the adapter that speaks for it.
 *
 * @param {string} runtime - Registered execution runtime name.
 * @returns {object} Adapter exposing the port operations for that runtime.
 * @throws {Error} When the name is not registered.
 */
export function executionAdapter(runtime) {
  const adapter = EXECUTION_ADAPTERS[runtime];
  assert(
    adapter,
    `Unknown execution runtime: ${runtime}. ` +
      `Registered runtimes are ${EXECUTION_RUNTIMES.join(", ")}`,
  );
  return adapter;
}

/**
 * Translates a runtime's own failure code into the neutral signal.
 *
 * @param {string} runtime - Registered execution runtime that refused the work.
 * @param {string} code - The code that runtime reported.
 * @param {string} [message] - The explanation it reported alongside the code.
 * @returns {object} Validated neutral failure signal retaining the code.
 * @throws {Error} When the runtime is not registered or the signal is invalid.
 */
export function translateRuntimeFailure(runtime, code, message) {
  return executionAdapter(runtime).translateCode(code, message);
}

/**
 * Adds a runtime code's routing hints to a failure record before it is routed.
 *
 * A record that names no runtime is left exactly as it is, so the records that
 * already carry their own signals keep routing as they did. A record that names
 * one but omits the code is rejected rather than routed on half its evidence.
 *
 * @param {object} failure - Validated failure record about to be classified.
 * @returns {object} The record, with neutral hints merged in when it named one.
 * @throws {Error} When the runtime is named without a code, or is unregistered.
 */
export function withRuntimeSignal(failure) {
  if (!failure.runtime) return failure;
  assert(
    typeof failure.code === "string" && failure.code.trim(),
    "A failure naming a runtime must also name the code it reported",
  );
  const signal = translateRuntimeFailure(
    failure.runtime,
    failure.code,
    failure.message,
  );
  // The record's own message is the evidence a person wrote and stays intact;
  // only the routing hints the translation produced are added to it.
  return { ...failure, ...signal, message: failure.message };
}
