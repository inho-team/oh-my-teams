/** Drafts a first organization from a ladder size and one model per tier. */
import {
  DEPTH_ROLES,
  FULL_DEPTH,
  SUPERVISION_DEFAULTS,
  assert,
  validateOrg,
} from "./core.mjs";

/**
 * Operating values a drafted organization starts with.
 *
 * None of them spends more than the models the user chose: one worker per role,
 * one attempt, no fallback onto another profile, a stop on exhaustion, and no
 * assistant calls. A silent worker is asked for progress and then escalated on
 * the supervision defaults, which never retry or stop anything by themselves.
 * `adjust` changes any of them later.
 */
export const DRAFT_DEFAULTS = Object.freeze({
  concurrency: 1,
  attempts: 1,
  policy: Object.freeze({
    delegation: Object.freeze({ strategy: "intern-first" }),
    onExhaustion: "stop",
    maxCalls: 3,
    timeoutMs: 300000,
    repeatFailureLimit: 1,
    supervision: SUPERVISION_DEFAULTS,
  }),
});

const DRAFT_PROVIDERS = { claude: "Claude", codex: "Codex", agy: "Agy" };

/**
 * Parses one `provider:model` tier choice, where `default` means host default.
 *
 * Ollama is refused here rather than half-configured: its profile needs an
 * endpoint and a context window read from `ollama show`, and a guessed window
 * lets a truncated prompt pass as a normal answer.
 *
 * @param {string} choice - Choice such as `agy:gemini-3.1-pro-high`.
 * @returns {{provider: string, model: string | null}} Parsed choice.
 * @throws {Error} When the shape or provider is not supported by a draft.
 */
export function parseModelChoice(choice) {
  const match = /^([a-z]+):(\S+)$/.exec(choice ?? "");
  assert(match, `Model choice must be provider:model, got: ${choice}`);
  const [, provider, model] = match;
  assert(
    provider !== "ollama",
    "Ollama needs an endpoint and contextTokens; add it with adjust after formation",
  );
  assert(
    Object.hasOwn(DRAFT_PROVIDERS, provider),
    `Unsupported provider for a draft: ${provider}`,
  );
  return { provider, model: model === "default" ? null : model };
}

function profileId({ provider, model }) {
  const slug = (model ?? "default")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${provider}-${slug}`;
}

/**
 * Builds a validated organization for the chosen ladder and tier models.
 *
 * Profiles use the current account of each provider, and every profile of one
 * provider shares a pool, because the runtime skips an exhausted pool only when
 * the profiles drawing on it are grouped. No profile records an effort, so each
 * CLI applies its own default until `adjust` sets one.
 *
 * @param {object} request - Draft request.
 * @param {string} request.name - Organization name.
 * @param {number} [request.tiers=FULL_DEPTH] - Ladder size from 1 to 5.
 * @param {string[]} request.models - One `provider:model` choice per tier.
 * @returns {object} Validated organization ready for `init --from`.
 * @throws {Error} When the ladder, a choice, or the result is invalid.
 */
export function draftOrganization({ name, tiers = FULL_DEPTH, models }) {
  // Formation declares every role; how many a run uses is chosen per kickoff.
  // A smaller ladder stays available for an organization that cannot staff one.
  const roles = DEPTH_ROLES[tiers];
  assert(roles, "tiers must be 1..5");
  assert(
    Array.isArray(models) && models.length === roles.length,
    `Choose exactly one model per tier: ${roles.length} expected`,
  );

  const pools = {};
  const profiles = {};
  const bindings = {};
  roles.forEach((role, tier) => {
    const choice = parseModelChoice(models[tier]);
    const id = profileId(choice);
    const pool = `${choice.provider}-current`;
    pools[pool] ??= {
      label: `${DRAFT_PROVIDERS[choice.provider]} current account`,
    };
    profiles[id] ??= {
      provider: choice.provider,
      command: [choice.provider],
      account: "current",
      subscription: `${DRAFT_PROVIDERS[choice.provider]} (current account)`,
      model: choice.model,
      pool,
    };
    bindings[role] = {
      parent: tier === 0 ? null : roles[tier - 1],
      profile: id,
      concurrency: DRAFT_DEFAULTS.concurrency,
      attempts: DRAFT_DEFAULTS.attempts,
      fallbacks: [],
    };
  });

  return validateOrg({
    schemaVersion: 1,
    revision: 1,
    name,
    modelPolicy: { preset: "custom", revision: 1 },
    pools,
    profiles,
    roles: bindings,
    policy: {
      ...DRAFT_DEFAULTS.policy,
      supervision: { ...DRAFT_DEFAULTS.policy.supervision },
    },
  });
}
