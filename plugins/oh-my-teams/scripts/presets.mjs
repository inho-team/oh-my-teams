/** Model-routing presets that reuse existing account/subscription profiles. */
import { assert, definedRoles, validateOrg } from "./core.mjs";

/**
 * Supported presets keyed by their CLI identifier.
 *
 * A `policy` preset leaves every model alone and changes only how hard the
 * team draws on the accounts behind those profiles, so it applies to any
 * provider and never assumes a model catalog. The `models` and `tiers` kinds
 * name the compatibility surface for presets that used to pin fixed model
 * versions to roles, fallbacks, and advisors; `previewPreset` now refuses to
 * run them (see its docstring) because the fixed tables that made those
 * assignments are gone. Their `modelPolicy.preset` name and history entries
 * still read and validate, since `MODEL_POLICY_PRESETS` in core.mjs is the
 * compatibility list and does not depend on this object.
 */
export const PRESETS = {
  "opus-first": {
    kind: "models",
    description: "Use Opus for implementation and review roles.",
  },
  balanced: {
    kind: "models",
    description: "Use Opus for judgment and Sonnet for implementation.",
  },
  "single-subscription": {
    kind: "policy",
    description:
      "Serialize every role and drop fallbacks that share one account's quota.",
  },
  "advisor-codex": {
    kind: "tiers",
    description:
      "Route the Codex ladder to one account, with an advisor at decision gates.",
  },
  "advisor-claude": {
    kind: "tiers",
    description:
      "Route the Claude ladder to one account, with an advisor at decision gates.",
  },
};

/** Profiles that draw on the same quota as `profile`, and so cannot relieve it. */
function sharesQuotaWith(profile, candidate) {
  if (profile.pool || candidate.pool) return profile.pool === candidate.pool;
  return (
    profile.provider === candidate.provider &&
    profile.account === candidate.account
  );
}

function policyChanges(org) {
  return definedRoles(org).map((role) => {
    const binding = org.roles[role];
    const profile = org.profiles[binding.profile];
    return {
      role,
      after: {
        profile: binding.profile,
        // A fallback on the same quota is already exhausted when the primary
        // reports exhaustion, so worker.mjs skips it anyway; keeping it only
        // spends the call budget a usable profile would need.
        fallbacks: binding.fallbacks.filter(
          (id) => !sharesQuotaWith(profile, org.profiles[id]),
        ),
        concurrency: 1,
      },
    };
  });
}

/**
 * Builds, but does not persist, a preset-adjusted organization revision.
 *
 * Only a `policy` preset runs: it keeps every profile and touches only slots
 * and fallbacks, so it never assumes a model catalog and applies to any
 * provider. A `models` or `tiers` preset used to pin fixed model versions to
 * roles, fallbacks, and advisors from a table baked into this file; that table
 * is gone, so calling `previewPreset` with one of those names throws instead of
 * assigning anything. The name keeps validating in `modelPolicy.preset` and in
 * history for organizations saved before this change; only running the preset
 * again is refused. Callers that want a specific model use `edit` to set a
 * role's profile directly, after checking what each executor currently lists
 * with the `model-catalog` command.
 *
 * Presets also pin per-role concurrency. Roles sharing one quota pool draw from
 * it simultaneously, so slot count governs pool drain more than model choice.
 *
 * @param {object} org - Current validated organization.
 * @param {string} name - Preset identifier, a key of `PRESETS`.
 * @returns {object} Preset metadata, changed role bindings, and proposed org.
 * @throws {Error} When the preset is unknown, or names a `models`/`tiers`
 *   preset whose fixed-assignment table has been removed.
 */
export function previewPreset(org, name) {
  validateOrg(org);
  const preset = PRESETS[name];
  assert(preset, `Unknown preset: ${name}`);
  assert(
    preset.kind === "policy",
    `Preset ${name} no longer assigns fixed models, fallbacks, or advisors. ` +
      "Use edit to set a role's profile directly, after checking what each " +
      "executor currently lists with the model-catalog command.",
  );

  const organization = structuredClone(org);
  const changes = [];
  const routed = policyChanges(org);
  for (const { role, after } of routed) {
    const before = {
      profile: org.roles[role].profile,
      fallbacks: org.roles[role].fallbacks,
      concurrency: org.roles[role].concurrency,
    };
    organization.roles[role] = { ...organization.roles[role], ...after };
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({ role, before, after });
    }
  }

  const result = { preset: name, description: preset.description, changes };
  organization.modelPolicy = { preset: name, revision: org.revision + 1 };
  validateOrg(organization);
  return { ...result, organization };
}
