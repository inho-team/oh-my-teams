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
  openCodexHistoryBoundary,
  readOpenCodexObservation,
  validateFixedOpenCodexAccountHome,
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

test("read-only public invocation and writable headless invocation keep different argv", () => {
  const readonly = openCodexCommand({
    cwd: "/tmp/work",
    port: 43123,
    model: "gpt-6-astra",
    effort: "medium",
  });
  const writable = openCodexCommand({
    cwd: "/tmp/work",
    port: 43123,
    model: "gpt-6-astra",
    effort: "medium",
    writable: true,
  });
  assert.deepEqual(readonly.slice(0, 7), [
    "codex",
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--cd",
  ]);
  assert.ok(!readonly.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(writable.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(readonly.includes("model_provider=omt-opencodex"));
  assert.ok(
    readonly.includes(
      'model_providers.omt-opencodex.base_url="http://127.0.0.1:43123/v1"',
    ),
  );
  assert.ok(
    readonly.includes(
      "model_providers.omt-opencodex.requires_openai_auth=false",
    ),
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

test("fixed OpenAI homes require the vendor-valid pin and disabled native integration", (t) => {
  const accountHome = fs.mkdtempSync(path.join(os.tmpdir(), "omt-ocx-home-"));
  t.after(() => fs.rmSync(accountHome, { recursive: true, force: true }));
  const config = {
    codexAccounts: [{ id: "only", logLabel: "fixed-account" }],
    activeCodexAccountId: "only",
    activeCodexAccountPinned: "only",
    providers: { openai: { codexAccountMode: "pool" } },
    clientIntegrations: { codex: false },
  };
  fs.writeFileSync(
    path.join(accountHome, "config.json"),
    JSON.stringify(config),
  );
  fs.writeFileSync(
    path.join(accountHome, "codex-accounts.json"),
    JSON.stringify({ only: {} }),
  );
  assert.deepEqual(
    validateFixedOpenCodexAccountHome(accountHome, "fixed-account"),
    {
      provider: "openai",
      accountLogLabel: "fixed-account",
    },
  );
  fs.writeFileSync(
    path.join(accountHome, "config.json"),
    JSON.stringify({ ...config, activeCodexAccountPinned: true }),
  );
  assert.throws(
    () => validateFixedOpenCodexAccountHome(accountHome, "fixed-account"),
    /opencodex-pool-unverified/,
  );
});

test("proxy request history requires one new successful fixed-account row", async (t) => {
  const accountHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "omt-ocx-account-"),
  );
  t.after(() => fs.rmSync(accountHome, { recursive: true, force: true }));
  fs.writeFileSync(path.join(accountHome, "admin-api-token"), "test-token");
  const input = {
    accountHome,
    port: 43123,
    provider: "codex",
    model: "gpt-6-astra",
    accountLogLabel: "fixed-account",
  };
  let reads = 0;
  const fetcher = async (_url, init) => {
    assert.equal(init.headers["X-OpenCodex-API-Key"], "test-token");
    reads += 1;
    return {
      ok: true,
      json: async () => ({
        entries:
          reads === 1
            ? []
            : [
                {
                  requestId: "caller-owned-request",
                  timestamp: 1789963102082,
                  requestedModel: "gpt-6-astra",
                  resolvedModel: "gpt-6-astra",
                  provider: "openai-fixed-account",
                  status: 200,
                  terminalStatus: "completed",
                  usage: { input_tokens: 3 },
                  attempts: [
                    {
                      provider: "openai-fixed-account",
                      accountLogLabel: "fixed-account",
                    },
                  ],
                },
              ],
      }),
    };
  };
  const historyBoundary = await openCodexHistoryBoundary(input, fetcher);
  const observed = await readOpenCodexObservation(
    { ...input, historyBoundary },
    fetcher,
  );
  assert.deepEqual(observed, {
    requestId: "caller-owned-request",
    provider: "openai-fixed-account",
    accountLogLabel: "fixed-account",
    model: "gpt-6-astra",
    usage: { input_tokens: 3 },
    attempts: [
      { provider: "openai-fixed-account", accountLogLabel: "fixed-account" },
    ],
  });
});

test("request-history pagination and an unrelated concurrent row fail closed", async (t) => {
  const accountHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "omt-ocx-account-"),
  );
  t.after(() => fs.rmSync(accountHome, { recursive: true, force: true }));
  fs.writeFileSync(path.join(accountHome, "admin-api-token"), "test-token");
  const input = {
    accountHome,
    port: 43123,
    provider: "codex",
    model: "gpt-6-astra",
    accountLogLabel: "fixed-account",
  };
  let page = 0;
  const fetcher = async (url) => {
    page += 1;
    assert.equal(new URL(url).searchParams.get("limit"), "100");
    return {
      ok: true,
      json: async () =>
        page === 1
          ? { entries: [{ requestId: "old" }], nextCursor: "next" }
          : page === 2
            ? { entries: [] }
            : {
                entries: [
                  { requestId: "other" },
                  { requestId: "caller-owned-request" },
                ],
              },
    };
  };
  const historyBoundary = await openCodexHistoryBoundary(input, fetcher);
  await assert.rejects(
    () => readOpenCodexObservation({ ...input, historyBoundary }, fetcher),
    /opencodex-binding-unverified/,
  );
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
    /opencodex-(?:action-required|binding-unverified)/,
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
