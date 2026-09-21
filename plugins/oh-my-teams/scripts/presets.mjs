/** Model-routing presets that reuse existing account/subscription profiles. */
import { assert, definedRoles, validateOrg } from "./core.mjs";

/**
 * Supported presets keyed by their CLI identifier.
 *
 * A `models` preset re-routes implementation roles onto profiles the caller
 * already has. A `policy` preset leaves every model alone and changes only how
 * hard the team draws on the accounts behind those profiles, so it applies to
 * any provider and never assumes a model catalog. A `tiers` preset routes the
 * whole ladder within one provider, a leading model for PM and cheaper models
 * for the roles that carry most calls, and names an advisor model that the
 * planning roles consult through `advise` instead of holding it all run long.
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
  "advisor-codex": {
    kind: "tiers",
    provider: "codex",
    description:
      "Sol leads, Terra and Luna carry the volume, and Astra advises at decision gates.",
    models: {
      pm: "gpt-5.6-sol",
      pl: "gpt-5.6-terra",
      senior: "gpt-5.6-terra",
      junior: "gpt-5.6-luna",
      intern: "gpt-5.6-luna",
    },
    advisor: "gpt-6-astra",
  },
  "advisor-claude": {
    kind: "tiers",
    provider: "claude",
    description:
      "Opus leads, Sonnet and Haiku carry the volume, and Fable advises at decision gates.",
    models: {
      pm: "opus",
      pl: "sonnet",
      senior: "sonnet",
      junior: "sonnet",
      intern: "haiku",
    },
    advisor: "fable",
  },
};

/**
 * Roles a `tiers` preset lets consult the advisor.
 *
 * These are the roles that plan, split, and review. Implementation roles ask
 * the role above them instead, so the costliest model is reached only where a
 * wrong call is expensive to undo.
 */
export const ADVISED_ROLES = ["pm", "pl", "senior"];

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

// A tiers preset may name a model the organization has no profile for yet. The
// new profile copies an existing profile of the same provider, so it reuses
// that login, subscription, and quota pool and never invents an account.
function tierProfile(organization, provider, model, added) {
  const matches = Object.entries(organization.profiles).filter(
    ([, profile]) => profile.provider === provider && profile.model === model,
  );
  assert(
    matches.length <= 1,
    `Preset found ${matches.length} ${provider} profiles for model ${model}; ` +
      "disambiguate them with the adjust skill first",
  );
  if (matches.length === 1) return matches[0][0];
  const pmProfile = organization.profiles[organization.roles.pm.profile];
  const template =
    pmProfile.provider === provider
      ? pmProfile
      : Object.entries(organization.profiles)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, profile]) => profile)
          .find((profile) => profile.provider === provider);
  assert(
    template,
    `Preset needs an existing ${provider} profile to copy the account from`,
  );
  const slug = model.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  let id = `${provider}-${slug}`;
  for (let suffix = 2; Object.hasOwn(organization.profiles, id); suffix += 1) {
    id = `${provider}-${slug}-${suffix}`;
  }
  const profile = { ...structuredClone(template), model };
  delete profile.effort;
  organization.profiles[id] = profile;
  added.push({ id, model, copiedFrom: template.subscription });
  return id;
}

function tierChanges(organization, preset, added) {
  // Only roles already running on the preset's provider move. A role on another
  // provider draws on a different quota, and pulling it over would load the
  // very account the preset exists to relieve.
  const roles = definedRoles(organization).filter(
    (role) =>
      Object.hasOwn(preset.models, role) &&
      organization.profiles[organization.roles[role].profile].provider ===
        preset.provider,
  );
  const changes = roles.map((role) => ({
    role,
    after: {
      profile: tierProfile(
        organization,
        preset.provider,
        preset.models[role],
        added,
      ),
      fallbacks: [],
      concurrency: 1,
    },
  }));
  const advisor = tierProfile(
    organization,
    preset.provider,
    preset.advisor,
    added,
  );
  const advisors = Object.fromEntries(
    definedRoles(organization)
      .filter((role) => ADVISED_ROLES.includes(role))
      .map((role) => [role, [advisor]]),
  );
  return { changes, advisors };
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
 * and fallbacks. A `tiers` preset re-routes the declared roles that already run
 * on its provider, leaving roles on other providers and their quotas alone,
 * sets the advisor allowlist for the planning roles, and adds a
 * profile for a missing model only by copying an existing profile of that
 * provider, so the new profile reuses its account and pool.
 *
 * Presets also pin per-role concurrency. Roles sharing one quota pool draw from
 * it simultaneously, so slot count governs pool drain more than model choice.
 *
 * @param {object} org - Current validated organization.
 * @param {string} name - Preset identifier, a key of `PRESETS`.
 * @returns {object} Preset metadata, changed role bindings, and proposed org.
 * @throws {Error} When the preset or a required model profile is unavailable.
 */
export function previewPreset(org, name) {
  validateOrg(org);
  const preset = PRESETS[name];
  assert(preset, `Unknown preset: ${name}`);

  const organization = structuredClone(org);
  const changes = [];
  const addedProfiles = [];
  let advisors = null;
  let routed;
  if (preset.kind === "tiers") {
    ({ changes: routed, advisors } = tierChanges(
      organization,
      preset,
      addedProfiles,
    ));
  } else {
    routed =
      preset.kind === "models" ? modelChanges(org, preset) : policyChanges(org);
  }
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
  if (preset.kind === "tiers") {
    organization.advisors = advisors;
    result.addedProfiles = addedProfiles;
    result.advisors = { before: org.advisors ?? null, after: advisors };
  }
  organization.modelPolicy = { preset: name, revision: org.revision + 1 };
  validateOrg(organization);
  return { ...result, organization };
}
