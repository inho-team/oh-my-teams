/** Fixed-account OpenCodex binding and command boundary coverage. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isolatedOpenCodexEnvironment,
  openCodexCommand,
  openCodexEnvironment,
  readOpenCodexObservation,
  validateOpenCodexRunner,
} from "../plugins/oh-my-teams/scripts/opencodex.mjs";
import {
  invoke,
  providerCommand,
} from "../plugins/oh-my-teams/scripts/providers.mjs";

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
  assert.ok(argv.includes("model_provider=omt-opencodex"));
  assert.ok(
    argv.includes(
      'model_providers.omt-opencodex.base_url="http://127.0.0.1:43123/v1"',
    ),
  );
  assert.ok(
    argv.includes("model_providers.omt-opencodex.requires_openai_auth=false"),
  );
});

test("the isolated runner strips inherited API credentials", () => {
  const environment = isolatedOpenCodexEnvironment(
    {
      PATH: "/bin",
      OPENAI_API_KEY: "must-not-reach-child",
      ANTHROPIC_API_KEY: "must-not-reach-child",
      OPENCODEX_HOME: "/wrong/home",
    },
    { OPENCODEX_HOME: "/account", CODEX_HOME: "/session" },
  );
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.ANTHROPIC_API_KEY, undefined);
  assert.equal(environment.OPENCODEX_HOME, "/account");
});

test("proxy request history, not CLI JSONL, proves the fixed account and model", async (t) => {
  const accountHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "omt-ocx-account-"),
  );
  t.after(() => fs.rmSync(accountHome, { recursive: true, force: true }));
  fs.writeFileSync(path.join(accountHome, "admin-api-token"), "test-token");
  const observed = await readOpenCodexObservation(
    {
      accountHome,
      port: 43123,
      startedAt: 0,
      provider: "codex",
      model: "gpt-6-astra",
      accountLogLabel: "fixed-account",
    },
    async (_url, init) => {
      assert.equal(init.headers["X-OpenCodex-API-Key"], "test-token");
      return {
        ok: true,
        json: async () => ({
          entries: [
            {
              timestamp: "2026-09-21T00:00:00.000Z",
              requestedModel: "gpt-6-astra",
              resolvedModel: "gpt-6-astra",
              provider: "openai",
              usage: { input_tokens: 3 },
              attempts: [
                { provider: "openai", accountLogLabel: "fixed-account" },
              ],
            },
          ],
        }),
      };
    },
  );
  assert.deepEqual(observed, {
    provider: "openai",
    accountLogLabel: "fixed-account",
    model: "gpt-6-astra",
    usage: { input_tokens: 3 },
  });
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

test("headless command construction cannot bypass an explicit OpenCodex runner", () => {
  assert.throws(
    () =>
      providerCommand(
        { ...profile, provider: "codex", command: ["codex"] },
        "/tmp",
        "test",
      ),
    /opencodex-headless-unverified/,
  );
});
