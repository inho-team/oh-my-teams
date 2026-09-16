/** Model-routing presets that reuse existing account/subscription profiles. */
import { assert, definedRoles, validateOrg } from "./core.mjs";

/**
 * Supported presets keyed by their CLI identifier.
 *
 * A `models` preset re-routes implementation roles onto profiles the caller
 * already has. A `policy` preset leaves every model alone and changes only how
 * hard the team draws on the accounts behind those profiles, so it applies to
 * any provider and never assumes a model catalog.
 */
export const PRESETS = {
  "opus-first": {
    kind: "models",
    description: "Use Opus for implementation and review roles.",
    models: {
      senior: "claude-opus-4-6-thinking",
      junior: "claude-opus-4-6-thinking",
      intern: "claude-opus-4-6-thinking",
    },
    fallbacks: { senior: [], junior: [], intern: [] },
    concurrency: { senior: 1, junior: 1, intern: 1 },
  },
  balanced: {
    kind: "models",
    description:
      "Use Opus for judgment, Sonnet for implementation, and GPT-OSS for narrow edits.",
    models: {
      senior: "claude-opus-4-6-thinking",
      junior: "claude-sonnet-4-6",
      intern: "gpt-oss-120b-medium",
    },
    fallbacks: {
      senior: [],
      junior: ["claude-opus-4-6-thinking"],
      intern: ["claude-sonnet-4-6"],
    },
    concurrency: { senior: 1, junior: 1, intern: 1 },
  },
  "single-subscription": {
    kind: "policy",
    description:
      "Serialize every role and drop fallbacks that share one account's quota.",
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

function profileForModel(org, model) {
  const matches = Object.entries(org.profiles).filter(
    ([, profile]) => profile.model === model,
  );
  assert(
    matches.length === 1,
    `Preset requires exactly one profile for model ${model}; ` +
      "add or disambiguate it with the adjust skill first",
  );
  return matches[0][0];
}

function modelChanges(org, preset) {
  // A reduced organization may not declare every implementation role, and a
  // preset must not invent one, so only declared roles are re-routed.
  const roles = definedRoles(org).filter((role) =>
    Object.hasOwn(preset.models, role),
  );
  return roles.map((role) => ({
    role,
    after: {
      profile: profileForModel(org, preset.models[role]),
      fallbacks: preset.fallbacks[role].map((model) =>
        profileForModel(org, model),
      ),
      concurrency: preset.concurrency[role],
    },
  }));
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
 * A `models` preset leaves PM and PL bindings untouched and resolves models to
 * the caller's existing profiles, so it never invents an account or
 * subscription. A `policy` preset keeps every profile and touches only slots
 * and fallbacks.
 *
 * Presets also pin per-role concurrency. Roles sharing one quota pool draw from
 * it simultaneously, so slot count governs pool drain more than model choice.
 *
 * @param {object} org - Current validated organization.
 * @param {'opus-first' | 'balanced' | 'single-subscription'} name - Preset identifier.
 * @returns {object} Preset metadata, changed role bindings, and proposed org.
 * @throws {Error} When the preset or a required model profile is unavailable.
 */
export function previewPreset(org, name) {
  validateOrg(org);
  const preset = PRESETS[name];
  assert(preset, `Unknown preset: ${name}`);

  const organization = structuredClone(org);
  const changes = [];
  for (const { role, after } of preset.kind === "models"
    ? modelChanges(org, preset)
    : policyChanges(org)) {
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

  organization.modelPolicy = { preset: name, revision: org.revision + 1 };
  validateOrg(organization);
  return {
    preset: name,
    description: preset.description,
    changes,
    organization,
  };
}
