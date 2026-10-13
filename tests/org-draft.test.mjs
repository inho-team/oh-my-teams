/** PM/Worker and resource organization draft tests. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveRole,
  validateOrg,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  DRAFT_DEFAULTS,
  draftResourceOrganization,
  draftThreeTierOrganization,
} from "../plugins/oh-my-teams/scripts/org-draft.mjs";

test("a model draft binds PM and Worker in one chain", () => {
  const org = draftThreeTierOrganization({
    name: "team",
    models: ["claude:default", "codex:default"],
  });
  assert.deepEqual(Object.keys(org.roles), ["pm", "worker"]);
  assert.equal(org.roles.pm.parent, null);
  assert.equal(org.roles.worker.parent, "pm");
  assert.equal(resolveRole(org, "worker"), "worker");
  for (const binding of Object.values(org.roles)) {
    assert.equal(binding.concurrency, DRAFT_DEFAULTS.concurrency);
    assert.equal(binding.attempts, 1);
    assert.deepEqual(binding.fallbacks, []);
  }
  assert.equal(org.policy.onExhaustion, "stop");
  for (const profile of Object.values(org.profiles)) {
    assert.equal(Object.hasOwn(profile, "effort"), false);
  }
});

test("model drafts share a provider pool and refuse incomplete choices", () => {
  const org = draftThreeTierOrganization({
    name: "team",
    models: ["agy:gemini-3.1-pro-high", "agy:gemini-3.8-flash-high"],
  });
  assert.deepEqual(Object.keys(org.pools), ["agy-current"]);
  assert.equal(Object.keys(org.profiles).length, 2);
  assert.throws(
    () =>
      draftThreeTierOrganization({ name: "team", models: ["codex:default"] }),
    /exactly one model per tier/,
  );
  assert.throws(
    () =>
      draftThreeTierOrganization({
        name: "team",
        models: ["ollama:qwen3", "codex:default"],
      }),
    /adjust after formation/,
  );
});

test("a resource draft records verified subscription capacity without role models", () => {
  const org = draftResourceOrganization({
    name: "team",
    resources: ["codex", "agy"],
    concurrency: 2,
    maxCalls: 5,
  });

  assert.equal(org.profiles, undefined);
  assert.deepEqual(Object.keys(org.resources).sort(), [
    "agy-current",
    "codex-current",
  ]);
  assert.equal(org.resources["codex-current"].pool, "codex-current");
  assert.equal(org.resources["agy-current"].concurrency, 2);
  assert.equal(org.resources["agy-current"].maxCalls, 5);
  for (const binding of Object.values(org.roles)) {
    assert.equal(Object.hasOwn(binding, "profile"), false);
    assert.deepEqual(binding.fallbacks, []);
  }
});

test("a resource draft refuses an unknown or duplicate resource", () => {
  assert.throws(
    () => draftResourceOrganization({ name: "team", resources: ["unknown"] }),
    /Unsupported provider/,
  );
  assert.throws(
    () =>
      draftResourceOrganization({
        name: "team",
        resources: ["codex", "codex"],
      }),
    /Duplicate subscription resource/,
  );
});

test("a resource organization rejects an unverified account or pool", () => {
  const org = draftResourceOrganization({ name: "team", resources: ["codex"] });
  org.resources["codex-current"].account = "other-account";
  assert.throws(() => validateOrg(org), /Invalid subscription resource/);
});
