/** Model-routing presets that reuse existing account/subscription profiles. */
import { assert, validateOrg } from "./core.mjs";

/** Supported routing presets keyed by their CLI identifier. */
export const PRESETS = {
  "opus-first": {
    description: "Use Opus for Agy implementation and review roles.",
    models: {
      senior: "claude-opus-4-6-thinking",
      junior: "claude-opus-4-6-thinking",
      intern: "claude-opus-4-6-thinking",
    },
    fallbacks: { senior: [], junior: [], intern: [] },
  },
  balanced: {
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
      intern: ["claude-sonnet-4-6", "claude-opus-4-6-thinking"],
    },
  },
};

function profileForModel(org, model) {
  const matches = Object.entries(org.profiles).filter(
    ([, profile]) => profile.provider === "agy" && profile.model === model,
  );
  assert(
    matches.length === 1,
    `Preset requires exactly one Agy profile for model ${model}; ` +
      "add or disambiguate it with team-edit first",
  );
  return matches[0][0];
}

/**
 * Builds, but does not persist, a preset-adjusted organization revision.
 *
 * PM and PL bindings remain untouched. The function resolves models to the
 * caller's existing profiles so it never invents an account or subscription.
 *
 * @param {object} org - Current validated organization.
 * @param {'opus-first' | 'balanced'} name - Preset identifier.
 * @returns {object} Preset metadata, changed role bindings, and proposed org.
 * @throws {Error} When the preset or a required model profile is unavailable.
 */
export function previewPreset(org, name) {
  validateOrg(org);
  const preset = PRESETS[name];
  assert(preset, `Unknown preset: ${name}`);

  const organization = structuredClone(org);
  const changes = [];
  for (const role of ["senior", "junior", "intern"]) {
    const profile = profileForModel(org, preset.models[role]);
    const fallbacks = preset.fallbacks[role].map((model) =>
      profileForModel(org, model),
    );
    const before = {
      profile: org.roles[role].profile,
      fallbacks: org.roles[role].fallbacks,
    };
    const after = { profile, fallbacks };
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
