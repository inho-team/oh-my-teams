/** The tier-and-model draft form builds, and the defaults it records. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEPTH_ROLES,
  readJSON,
  resolveRole,
  run,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  DRAFT_DEFAULTS,
  draftOrganization,
} from "../plugins/oh-my-teams/scripts/org-draft.mjs";

const cli = path.resolve("plugins/oh-my-teams/scripts/teams-org.mjs");

function models(count) {
  return Array.from({ length: count }, () => "claude:default");
}

test("each ladder size declares its roles as a single chain under PM", () => {
  for (const [tiers, roles] of Object.entries(DEPTH_ROLES)) {
    const org = draftOrganization({
      name: "team",
      tiers: Number(tiers),
      models: models(roles.length),
    });
    assert.deepEqual(Object.keys(org.roles), roles);
    roles.forEach((role, index) => {
      assert.equal(
        org.roles[role].parent,
        index === 0 ? null : roles[index - 1],
      );
    });
  }
});

test("an omitted role's work folds onto the tier above it", () => {
  const org = draftOrganization({
    name: "team",
    tiers: 3,
    models: models(3),
  });
  // Three tiers drop PL and Intern. Narrow edits addressed to Intern must land
  // on Junior, and splitting work addressed to PL on PM, or they reach nobody.
  assert.equal(resolveRole(org, "intern"), "junior");
  assert.equal(resolveRole(org, "pl"), "pm");
});

test("a draft spends nothing beyond the models the user chose", () => {
  const org = draftOrganization({
    name: "team",
    tiers: 5,
    models: [
      "claude:default",
      "agy:claude-opus-4-6-thinking",
      "agy:gemini-3.1-pro-high",
      "agy:gemini-3.8-flash-high",
      "agy:gpt-oss-120b-medium",
    ],
  });
  // Formation asks for models only. Anything else it saved without asking has
  // to be the least costly value, so a user who never opens adjust is never
  // billed for a fallback, a parallel slot, or an assistant they did not pick.
  for (const binding of Object.values(org.roles)) {
    assert.equal(binding.concurrency, DRAFT_DEFAULTS.concurrency);
    assert.equal(binding.attempts, 1);
    assert.deepEqual(binding.fallbacks, []);
  }
  assert.equal(org.policy.onExhaustion, "stop");
  assert.deepEqual(org.policy.delegation, { strategy: "intern-first" });
  assert.equal(org.assistants, undefined);

  // Effort is left to each CLI until adjust sets it.
  for (const profile of Object.values(org.profiles)) {
    assert.equal(Object.hasOwn(profile, "effort"), false);
  }
});

test("Gemini choices become Agy profiles with the exact model IDs", () => {
  const org = draftOrganization({
    name: "team",
    tiers: 2,
    models: ["agy:gemini-3.1-pro-high", "agy:gemini-3.8-flash-high"],
  });
  const chosen = Object.values(org.profiles).map((profile) => [
    profile.provider,
    profile.model,
  ]);
  assert.deepEqual(chosen, [
    ["agy", "gemini-3.1-pro-high"],
    ["agy", "gemini-3.8-flash-high"],
  ]);
});

test("profiles of one provider share a pool, and a repeated model one profile", () => {
  const org = draftOrganization({
    name: "team",
    tiers: 3,
    models: ["codex:default", "agy:claude-sonnet-4-6", "agy:claude-sonnet-4-6"],
  });
  // The runtime skips an exhausted pool only for profiles grouped into it, so
  // ungrouped profiles of one account would keep retrying a spent quota.
  assert.deepEqual(Object.keys(org.pools).sort(), [
    "agy-current",
    "codex-current",
  ]);
  assert.equal(Object.keys(org.profiles).length, 2);
  assert.equal(org.roles.senior.profile, org.roles.junior.profile);
  assert.equal(org.profiles[org.roles.pm.profile].model, null);
});

test("a draft refuses what it cannot fill in without asking", () => {
  assert.throws(
    () => draftOrganization({ name: "t", tiers: 6, models: models(6) }),
    /tiers must be 1\.\.5/,
  );
  assert.throws(
    () => draftOrganization({ name: "t", tiers: 2, models: models(1) }),
    /exactly one model per tier/,
  );
  // An Ollama window cannot be guessed: a prompt larger than the window is
  // truncated silently and the answer still looks normal.
  assert.throws(
    () => draftOrganization({ name: "t", tiers: 1, models: ["ollama:qwen3"] }),
    /adjust after formation/,
  );
  assert.throws(
    () => draftOrganization({ name: "t", tiers: 1, models: ["opus"] }),
    /provider:model/,
  );
});

test("the CLI writes a draft init accepts, and never over an existing file", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-draft-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const draft = path.join(dir, "draft.json");
  const args = [
    "org-draft",
    "--name",
    "team",
    "--tiers",
    "2",
    "--models",
    "claude:default,agy:gemini-3.8-flash-high",
    "--output",
    draft,
  ];

  const first = await run([process.execPath, cli, ...args]);
  assert.equal(first.code, 0, first.stderr);

  const org = path.join(dir, ".omt", "organization.json");
  const init = await run([
    process.execPath,
    cli,
    "init",
    "--org",
    org,
    "--from",
    draft,
  ]);
  assert.equal(init.code, 0, init.stderr);
  assert.equal(readJSON(org).roles.junior.parent, "pm");

  // The draft path could be the live organization file; overwriting it would
  // bypass the rule that init never replaces an existing organization.
  const second = await run([process.execPath, cli, ...args]);
  assert.equal(second.code, 1);
  assert.match(second.stderr, /Draft output exists/);
});
