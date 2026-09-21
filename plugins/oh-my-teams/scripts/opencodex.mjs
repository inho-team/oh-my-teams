/** Fail-closed OpenCodex fixed-account runner binding validation. */
import path from "node:path";
import { assert } from "./core.mjs";

/**
 * Validates a profile's optional OpenCodex runner without changing legacy profile behavior.
 * @param {object} profile - Organization profile.
 * @param {object} activeRuntime - Active runtime identity.
 * @returns {{kind: string, mode: string, accountHomeRef: string, runtimeFingerprint: string} | null} Valid runner or null for legacy.
 */
export function validateOpenCodexRunner(profile, activeRuntime) {
  if (!profile.runner) return null;
  const runner = profile.runner;
  assert(runner.kind === "opencodex", "opencodex-binding-unverified");
  assert(runner.mode === "fixed-account", "opencodex-pool-unverified");
  assert(
    typeof runner.accountHomeRef === "string" &&
      runner.accountHomeRef === profile.account,
    "opencodex-binding-unverified",
  );
  assert(
    runner.runtimeFingerprint === activeRuntime?.prefixFingerprint,
    "opencodex-binding-unverified",
  );
  assert(profile.model !== null, "opencodex-binding-unverified");
  return runner;
}

/**
 * Builds isolated environment variables for a fixed account turn.
 * @param {object} binding - Validated binding input.
 * @returns {Record<string, string>} Environment additions.
 */
export function openCodexEnvironment(binding) {
  assert(
    binding.accountHome && binding.sessionHome && binding.runtimePrefix,
    "opencodex-binding-unverified",
  );
  assert(
    path.resolve(binding.accountHome) !== path.resolve(binding.sessionHome),
    "opencodex-binding-unverified",
  );
  assert(
    path.resolve(binding.accountHome) !== path.resolve(binding.runtimePrefix),
    "opencodex-binding-unverified",
  );
  assert(
    !Object.keys(binding.env ?? {}).some((key) => /API[_-]?KEY/i.test(key)),
    "api-key-fallback-blocked",
  );
  return {
    OPENCODEX_HOME: binding.accountHome,
    CODEX_HOME: binding.sessionHome,
  };
}
