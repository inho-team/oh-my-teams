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
    concurrency: { senior: 1, junior: 1, intern: 1 },
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
      intern: ["claude-sonnet-4-6"],
    },
    concurrency: { senior: 1, junior: 1, intern: 1 },
  },
};

function profileForModel(org, model) {
  const matches = Object.entries(org.profiles).filter(
    ([, profile]) => profile.provider === "agy" && profile.model === model,
  );
  assert(
    matches.length === 1,
    `Preset requires exactly one Agy profile for model ${model}; ` +
      "add or disambiguate it with team-adjust first",
  );
  return matches[0][0];
}

/**
 * Builds, but does not persist, a preset-adjusted organization revision.
 *
 * PM and PL bindings remain untouched. The function resolves models to the
 * caller's existing profiles so it never invents an account or subscription.
 *
 * Presets also pin per-role concurrency. Roles sharing one quota pool draw from
 * it simultaneously, so slot count governs pool drain more than model choice.
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
      concurrency: org.roles[role].concurrency,
    };
    const after = { profile, fallbacks, concurrency: preset.concurrency[role] };
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
