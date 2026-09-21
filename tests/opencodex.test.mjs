/** Fixed-account OpenCodex binding and command boundary coverage. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  openCodexCommand,
  openCodexEnvironment,
  validateOpenCodexRunner,
} from "../plugins/oh-my-teams/scripts/opencodex.mjs";
import { invoke } from "../plugins/oh-my-teams/scripts/providers.mjs";

const fingerprint = `sha256:${"a".repeat(64)}`;
const profile = {
  account: "codex-fixed",
  model: "gpt-6-astra",
  runner: {
    kind: "opencodex",
    mode: "fixed-account",
    accountHomeRef: "codex-fixed",
    runtimeFingerprint: fingerprint,
  },
};

test("fixed account bindings reject pools, current accounts and fingerprints", () => {
  assert.deepEqual(
    validateOpenCodexRunner(profile, { prefixFingerprint: fingerprint }),
    profile.runner,
  );
  assert.throws(
    () =>
      validateOpenCodexRunner(
        { ...profile, account: "current" },
        { prefixFingerprint: fingerprint },
      ),
    /unverified/,
  );
  assert.throws(
    () =>
      validateOpenCodexRunner(
        { ...profile, runner: { ...profile.runner, mode: "pool" } },
        { prefixFingerprint: fingerprint },
      ),
    /pool-unverified/,
  );
  assert.throws(
    () =>
      validateOpenCodexRunner(profile, {
        prefixFingerprint: `sha256:${"b".repeat(64)}`,
      }),
    /unverified/,
  );
});

test("runtime homes remain isolated and API-key fallback is blocked", () => {
  const binding = {
    accountHome: "/tmp/account",
    sessionHome: "/tmp/session",
    runtimePrefix: "/tmp/runtime",
  };
  assert.deepEqual(openCodexEnvironment(binding), {
    OPENCODEX_HOME: "/tmp/account",
    CODEX_HOME: "/tmp/session",
  });
  assert.throws(
    () =>
      openCodexEnvironment({ ...binding, env: { OPENAI_API_KEY: "SECRET" } }),
    /api-key-fallback-blocked/,
  );
  assert.throws(
    () => openCodexEnvironment({ ...binding, sessionHome: "/tmp/account" }),
    /unverified/,
  );
});

test("the OpenCodex runner invokes actual Codex JSONL with explicit proxy and model", () => {
  const argv = openCodexCommand({
    cwd: "/tmp/work",
    port: 43123,
    model: "gpt-6-astra",
    effort: "medium",
  });
  assert.deepEqual(argv.slice(0, 5), [
    "codex",
    "exec",
    "--json",
    "--cd",
    "/tmp/work",
  ]);
  assert.ok(argv.includes("openai_base_url=http://127.0.0.1:43123/v1"));
});

test("the public provider entrypoint refuses an unconfigured explicit runner without fallback", async () => {
  await assert.rejects(
    () =>
      invoke(
        {
          ...profile,
          provider: "codex",
          command: ["codex"],
          subscription: "test",
          effort: "medium",
        },
        "/tmp",
        "test",
        1000,
      ),
    /opencodex-action-required/,
  );
});
