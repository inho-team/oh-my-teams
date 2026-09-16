/**
 * Provider adapter registry and the transport rules derived from it.
 *
 * Adding a provider means adding one adapter module and one entry here. The
 * supported provider list, the per-provider reasoning-effort table, and the
 * transport each profile uses are all read from this registry, so no other
 * module needs to name an individual provider.
 */
import agy from "./agy.mjs";
import claude from "./claude.mjs";
import codex from "./codex.mjs";
import ollama from "./ollama.mjs";
import { assertProvider } from "./shared.mjs";

/** Registered adapters keyed by the identifier a profile declares. */
export const ADAPTERS = Object.freeze({
  claude,
  codex,
  agy,
  ollama,
});

/** Provider identifiers accepted in an organization document. */
export const PROVIDER_IDS = Object.freeze(Object.keys(ADAPTERS));

/**
 * Reasoning-effort values each provider accepts, derived from its adapter.
 *
 * A level a provider accepts syntactically may still be unavailable on a given
 * model. The runtime carries no per-model catalog, so a rejected level surfaces
 * as an ordinary provider failure.
 */
export const PROVIDER_EFFORTS = Object.freeze(
  Object.fromEntries(
    Object.entries(ADAPTERS).map(([id, adapter]) => [id, adapter.efforts]),
  ),
);

/**
 * Looks up the adapter a profile names.
 *
 * @param {object} profile - Provider profile carrying a `provider` identifier.
 * @returns {object} The registered adapter.
 * @throws {Error} When the provider is not registered.
 */
export function adapterFor(profile) {
  const adapter = ADAPTERS[profile?.provider];
  assertProvider(adapter, `Unsupported provider: ${profile?.provider}`);
  return adapter;
}

/**
 * Decides which transport carries a profile's calls.
 *
 * Declaring an `endpoint` selects HTTP and declaring a `command` selects a child
 * process. Requiring the choice to be explicit keeps a profile that names both
 * from silently running over whichever transport the code happens to try first.
 *
 * @param {object} profile - Provider profile under inspection.
 * @returns {'http' | 'process'} Transport the adapter will be asked to build for.
 * @throws {Error} When the profile names no transport, or one the adapter lacks.
 */
export function transportFor(profile) {
  const adapter = adapterFor(profile);
  const hasEndpoint = profile.endpoint !== undefined;
  const hasCommand = Array.isArray(profile.command);
  assertProvider(
    hasEndpoint !== hasCommand,
    `Profile must declare exactly one of command or endpoint: ${adapter.id}`,
  );
  const transport = hasEndpoint ? "http" : "process";
  assertProvider(
    adapter.transports.includes(transport),
    `Provider ${adapter.id} does not support the ${transport} transport`,
  );
  return transport;
}
