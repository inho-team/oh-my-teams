/** Execution runtime registry: one name to the adapter that speaks for it. */
import { assert } from "./core.mjs";
import { translateOrcaFailure } from "./orca-adapter.mjs";
import { translateLocalCode } from "./local-adapter.mjs";

/**
 * Code translators keyed by the runtime that produced the code.
 *
 * This is the one place a runtime name is resolved. Adding a runtime means
 * adding its adapter and one entry here; nothing in failure routing changes,
 * which is the property the execution port exists to hold.
 */
const RUNTIME_TRANSLATORS = Object.freeze({
  orca: translateOrcaFailure,
  local: translateLocalCode,
});

/** Runtime names a failure record may name, in registration order. */
export const EXECUTION_RUNTIMES = Object.freeze(
  Object.keys(RUNTIME_TRANSLATORS),
);

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
  const translate = RUNTIME_TRANSLATORS[runtime];
  assert(
    translate,
    `Unknown execution runtime: ${runtime}. ` +
      `Registered runtimes are ${EXECUTION_RUNTIMES.join(", ")}`,
  );
  return translate(code, message);
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
