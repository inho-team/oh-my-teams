/** Claude and Antigravity fixed-account runner: home validation, proof rules and session homes. */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertDistinctOpenCodexHomes,
  openCodexAccountLabel,
  openCodexHistoryBoundary,
  openCodexProvider,
  OPENCODEX_RUNNER_PROVIDERS,
  readOpenCodexObservation,
  resolveOpenCodexBinding,
  stripOpenCodexModelPrefix,
  validateFixedOpenCodexOAuthHome,
  validateOpenCodexRunner,
} from "../plugins/oh-my-teams/scripts/opencodex.mjs";
import { modelBinding } from "../plugins/oh-my-teams/scripts/providers.mjs";
import { modelVerdict } from "../plugins/oh-my-teams/scripts/headless.mjs";

const fingerprint = `sha256:${"a".repeat(64)}`;
const runtime = {
  prefixFingerprint: fingerprint,
  runtimePrefix: "/omt/runtime",
};
// The list a later task will publish; injected so the exported one stays untouched.
const WITH_OAUTH = Object.freeze(["codex", "claude", "agy"]);
const ACCOUNT_ID = {
  anthropic: "fake-anthropic-account-id",
  "google-antigravity": "fake-agy-account-id",
};
const LOGICAL = { anthropic: "claude", "google-antigravity": "agy" };
const digest6 = (text) =>
  crypto.createHash("sha256").update(text).digest("hex").slice(0, 6);
// Computed here rather than through the code under test, so the algorithm is pinned.
const labelOf = (provider) =>
  provider === "anthropic"
    ? `anthropic-p${digest6(ACCOUNT_ID[provider])}`
    : `o${digest6(`google-antigravity\0${ACCOUNT_ID[provider]}`)}`;

// A home that passes every condition; `edit` breaks one of them.
function oauthHome(t, provider, edit = () => {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "omt-oauth-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const id = ACCOUNT_ID[provider];
  const files = {
    auth: {
      [provider]: {
        activeAccountId: id,
        accounts: [{ id, credential: { source: "oauth" } }],
      },
    },
    config: {
      runtimeRole: "hub",
      clientIntegrations: { codex: false },
      claudeCode: { enabled: false },
      defaultProvider: provider,
      providers: { [provider]: { authMode: "oauth" } },
      ...(provider === "anthropic"
        ? { anthropicAccountPool: { enabled: true } }
        : {}),
    },
  };
  edit(files);
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify(files.auth));
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify(files.config),
  );
  if (files.store !== undefined)
    fs.writeFileSync(
      path.join(home, "codex-accounts.json"),
      JSON.stringify(files.store),
    );
  return home;
}

const unverified = /opencodex-binding-unverified/;

// One entry per condition of the design's A1 list; each breaks exactly one.
const REJECTIONS = {
  "two accounts": [
    ({ auth }, p) =>
      auth[p].accounts.push({ id: "second", credential: { source: "oauth" } }),
    unverified,
  ],
  "activeAccountId that is not the account": [
    ({ auth }, p) => (auth[p].activeAccountId = "someone-else"),
    unverified,
  ],
  "no account": [({ auth }, p) => (auth[p].accounts = []), unverified],
  "another provider's account": [
    ({ auth }, p) =>
      (auth[p === "anthropic" ? "google-antigravity" : "anthropic"] = {
        activeAccountId: "x",
        accounts: [{ id: "x", credential: { source: "oauth" } }],
      }),
    unverified,
  ],
  "a remaining Codex account in config": [
    ({ config }) => (config.codexAccounts = [{ id: "c" }]),
    unverified,
  ],
  "a remaining Codex account store": [
    (files) => (files.store = { c: {} }),
    unverified,
  ],
  "a credential that is not an OAuth login": [
    ({ auth }, p) => (auth[p].accounts[0].credential.source = "local-cli"),
    unverified,
  ],
  "a credential without a source": [
    ({ auth }, p) => (auth[p].accounts[0].credential = {}),
    unverified,
  ],
  "an account that needs to sign in again": [
    ({ auth }, p) => (auth[p].accounts[0].needsReauth = true),
    unverified,
  ],
  combos: [
    ({ config }) => (config.combos = [{ name: "c", models: ["a"] }]),
    unverified,
  ],
  "an API key entry": [
    ({ config }) => (config.providers.extra = { apiKeyRef: "KEY" }),
    unverified,
  ],
  "a target that is not OAuth": [
    ({ config }, p) => (config.providers[p].authMode = "key"),
    unverified,
  ],
  "a disabled target": [
    ({ config }, p) => (config.providers[p].disabled = true),
    unverified,
  ],
  "a missing target entry": [
    ({ config }, p) => delete config.providers[p],
    unverified,
  ],
  "another default provider": [
    ({ config }) => (config.defaultProvider = "openai"),
    unverified,
  ],
  "an active OpenAI provider": [
    ({ config }) => (config.providers.openai = { authMode: "oauth" }),
    unverified,
  ],
  "a missing runtime role": [
    ({ config }) => (config.runtimeRole = "standalone"),
    /opencodex-global-change-blocked.*runtimeRole/,
  ],
  "an enabled Codex client integration": [
    ({ config }) => (config.clientIntegrations.codex = true),
    /opencodex-global-change-blocked.*clientIntegrations\.codex/,
  ],
  "an enabled Claude integration": [
    ({ config }) => (config.claudeCode = { enabled: true, systemEnv: true }),
    /opencodex-global-change-blocked.*claudeCode/,
  ],
};

test("a single OAuth account passes and yields only its computed label", (t) => {
  for (const provider of Object.keys(ACCOUNT_ID)) {
    const home = oauthHome(t, provider);
    const proof = validateFixedOpenCodexOAuthHome(
      home,
      provider,
      labelOf(provider),
    );
    assert.deepEqual(proof, { provider, accountLogLabel: labelOf(provider) });
    assert.ok(!JSON.stringify(proof).includes(ACCOUNT_ID[provider]));
    // Leftovers that route nowhere do not count as another account.
    const harmless = {
      "an empty Codex store, combo list and account list": (files) => {
        files.store = {};
        files.config.combos = [];
        files.config.codexAccounts = [];
      },
      "a disabled OpenAI provider": ({ config }) => {
        config.providers.openai = { disabled: true };
      },
      "both integration actions off instead of the feature switch": ({
        config,
      }) => {
        config.claudeCode = { systemEnv: false, injectAgents: false };
      },
    };
    for (const [name, edit] of Object.entries(harmless))
      assert.doesNotThrow(
        () =>
          validateFixedOpenCodexOAuthHome(
            oauthHome(t, provider, edit),
            provider,
          ),
        `${provider}: ${name}`,
      );
  }
});

test("each condition of the fixed OAuth home is refused when broken", (t) => {
  for (const provider of Object.keys(ACCOUNT_ID))
    for (const [name, [edit, error]] of Object.entries(REJECTIONS)) {
      const home = oauthHome(t, provider, (files) => edit(files, provider));
      assert.throws(
        () => validateFixedOpenCodexOAuthHome(home, provider),
        error,
        `${provider}: ${name}`,
      );
    }
});

test("a label that its account does not produce is refused", (t) => {
  for (const [provider, other] of [
    ["anthropic", "anthropic-p000000"],
    ["google-antigravity", "o000000"],
  ])
    assert.throws(
      () =>
        validateFixedOpenCodexOAuthHome(
          oauthHome(t, provider),
          provider,
          other,
        ),
      unverified,
      provider,
    );
});

test("anthropic home: the pool switch must be on and alone", (t) => {
  const pool = /opencodex-pool-unverified/;
  const refuse = (edit) =>
    assert.throws(
      () =>
        validateFixedOpenCodexOAuthHome(
          oauthHome(t, "anthropic", edit),
          "anthropic",
        ),
      pool,
    );
  refuse(({ config }) => delete config.anthropicAccountPool);
  refuse(({ config }) => (config.anthropicAccountPool = { enabled: false }));
  for (const key of [
    "autoSwitchThreshold",
    "strategy",
    "stickyLimit",
    "quotaWindow",
  ])
    refuse(
      ({ config }) =>
        (config.anthropicAccountPool = { enabled: true, [key]: 1 }),
    );
});

test("agy home: a generic account failover setting is refused, and a pool block is not required", (t) => {
  assert.throws(
    () =>
      validateFixedOpenCodexOAuthHome(
        oauthHome(t, "google-antigravity", ({ config }) => {
          config.oauthAccountFailover = { enabled: false };
        }),
        "google-antigravity",
      ),
    /opencodex-pool-unverified/,
  );
  assert.doesNotThrow(() =>
    validateFixedOpenCodexOAuthHome(
      oauthHome(t, "google-antigravity"),
      "google-antigravity",
    ),
  );
});

test("a home for another provider, or a missing or unreadable file, is not a fixed OAuth home", (t) => {
  const anthropicHome = oauthHome(t, "anthropic");
  assert.throws(
    () => validateFixedOpenCodexOAuthHome(anthropicHome, "google-antigravity"),
    unverified,
  );
  assert.throws(
    () => validateFixedOpenCodexOAuthHome(anthropicHome, "openai"),
    unverified,
  );
  fs.writeFileSync(path.join(anthropicHome, "auth.json"), "{ not json");
  assert.throws(
    () => validateFixedOpenCodexOAuthHome(anthropicHome, "anthropic"),
    unverified,
  );
  fs.rmSync(path.join(anthropicHome, "auth.json"));
  assert.throws(
    () => validateFixedOpenCodexOAuthHome(anthropicHome, "anthropic"),
    unverified,
  );
});

test("account labels are computed from the account id and never carry it", () => {
  for (const provider of Object.keys(ACCOUNT_ID)) {
    const label = openCodexAccountLabel(provider, ACCOUNT_ID[provider]);
    assert.equal(label, labelOf(provider));
    assert.ok(!label.includes(ACCOUNT_ID[provider]));
  }
  assert.match(labelOf("anthropic"), /^anthropic-p[a-f0-9]{6}$/);
  assert.match(labelOf("google-antigravity"), /^o[a-f0-9]{6}$/);
});

// ---- request-history proof -------------------------------------------------

const MODEL = {
  claude: "anthropic/claude-sonnet-4-6",
  agy: "google-antigravity/claude-sonnet-4-6",
};
const EXECUTED = "claude-sonnet-4-6";
const HISTORY_PROVIDER = {
  claude: labelOf("anthropic"),
  agy: "google-antigravity",
};

const attemptFor = (logical, overrides = {}) => ({
  ordinal: 1,
  provider: HISTORY_PROVIDER[logical],
  // A Claude attempt has no account label; the provider suffix is its mark.
  ...(logical === "agy"
    ? { accountLogLabel: labelOf("google-antigravity") }
    : {}),
  model: EXECUTED,
  status: 200,
  sendCount: 1,
  recoveryKinds: [],
  ...overrides,
});

const rowFor = (logical, requestId, overrides = {}) => ({
  requestId,
  timestamp: Date.now() + 60000,
  requestedModel: MODEL[logical],
  model: EXECUTED,
  resolvedModel: EXECUTED,
  provider: HISTORY_PROVIDER[logical],
  status: 200,
  terminalStatus: "completed",
  usage: { input_tokens: 3 },
  attempts: [attemptFor(logical)],
  ...overrides,
});

async function observeOAuth(t, logical, entries, overrides = {}) {
  const accountHome = fs.mkdtempSync(path.join(os.tmpdir(), "omt-oauth-hist-"));
  t.after(() => fs.rmSync(accountHome, { recursive: true, force: true }));
  fs.writeFileSync(path.join(accountHome, "admin-api-token"), "test-token");
  const input = {
    accountHome,
    port: 43123,
    provider: logical,
    model: MODEL[logical],
    accountLogLabel:
      logical === "claude"
        ? labelOf("anthropic")
        : labelOf("google-antigravity"),
    settleMs: 0,
    ...overrides,
  };
  const pages = [{ entries: [{ requestId: "old" }] }, { entries }];
  let reads = 0;
  const fetcher = async () => {
    const page = pages[Math.min(reads, pages.length - 1)];
    reads += 1;
    return { ok: true, json: async () => page };
  };
  const historyBoundary = await openCodexHistoryBoundary(input, fetcher);
  return readOpenCodexObservation({ ...input, historyBoundary }, fetcher);
}

test("a prefixed profile model is proved as M requested and strip(M) executed, and returned as M", async (t) => {
  for (const logical of ["claude", "agy"]) {
    const observed = await observeOAuth(t, logical, [
      rowFor(logical, "a"),
      rowFor(logical, "b"),
    ]);
    assert.equal(observed.provider, HISTORY_PROVIDER[logical]);
    // Returning strip(M) as `model` would make every consumer reject the turn.
    assert.equal(observed.model, MODEL[logical]);
    assert.equal(observed.resolvedModel, EXECUTED);
    assert.deepEqual(observed.requestIds, ["a", "b"]);
    assert.equal(
      modelBinding(
        { model: MODEL[logical] },
        { effectiveModel: observed.model },
      ).status,
      "matched",
    );
    assert.equal(modelVerdict(MODEL[logical], observed.model), "matched");
    assert.equal(
      modelBinding(
        { model: MODEL[logical] },
        { effectiveModel: observed.resolvedModel },
      ).status,
      "mismatched",
    );
    assert.equal(
      modelVerdict(MODEL[logical], observed.resolvedModel),
      "mismatched",
    );
  }
});

test("the model of any row or attempt that is not the expected one refuses the turn", async (t) => {
  for (const logical of ["claude", "agy"]) {
    const bad = {
      "request recorded without the prefix": rowFor(logical, "x", {
        requestedModel: EXECUTED,
      }),
      "executed model that still carries the prefix": rowFor(logical, "x", {
        model: MODEL[logical],
        resolvedModel: MODEL[logical],
      }),
      "executed model of another name": rowFor(logical, "x", {
        resolvedModel: "claude-other",
      }),
      "attempt model that still carries the prefix": rowFor(logical, "x", {
        attempts: [attemptFor(logical, { model: MODEL[logical] })],
      }),
      "attempt model of another name": rowFor(logical, "x", {
        attempts: [attemptFor(logical, { model: "claude-other" })],
      }),
    };
    for (const [name, entry] of Object.entries(bad))
      await assert.rejects(
        () => observeOAuth(t, logical, [rowFor(logical, "ok"), entry]),
        unverified,
        name,
      );
  }
});

test("claude: every row of a turn must carry the expected provider suffix", async (t) => {
  const other = "anthropic-p000000";
  assert.notEqual(other, labelOf("anthropic"));
  const bad = {
    "a different suffix": rowFor("claude", "x", { provider: other }),
    "no suffix": rowFor("claude", "x", { provider: "anthropic" }),
    "an attempt on a different suffix": rowFor("claude", "x", {
      attempts: [attemptFor("claude", { provider: other })],
    }),
    "an attempt without a suffix": rowFor("claude", "x", {
      attempts: [attemptFor("claude", { provider: "anthropic" })],
    }),
    "a recovered attempt": rowFor("claude", "x", {
      attempts: [
        attemptFor("claude", { recoveryKinds: ["oauth-account-429"] }),
      ],
    }),
    "a failed attempt before the success": rowFor("claude", "x", {
      attempts: [
        attemptFor("claude", { status: 429 }),
        attemptFor("claude", { ordinal: 2 }),
      ],
    }),
  };
  for (const [name, entry] of Object.entries(bad))
    await assert.rejects(
      () => observeOAuth(t, "claude", [rowFor("claude", "ok"), entry]),
      unverified,
      `${name} must refuse the whole turn`,
    );
  // A profile label that is not a provider suffix cannot name an account.
  for (const label of ["fixed-account", "anthropic", "pabcdef", "o123456"])
    await assert.rejects(
      () =>
        observeOAuth(t, "claude", [rowFor("claude", "ok")], {
          accountLogLabel: label,
        }),
      unverified,
      label,
    );
});

test("agy: every attempt must carry the expected account label", async (t) => {
  const bad = {
    "another label": rowFor("agy", "x", {
      attempts: [attemptFor("agy", { accountLogLabel: "o000000" })],
    }),
    "no label": rowFor("agy", "x", {
      attempts: [attemptFor("agy", { accountLogLabel: undefined })],
    }),
    "another provider": rowFor("agy", "x", { provider: "anthropic" }),
  };
  for (const [name, entry] of Object.entries(bad))
    await assert.rejects(
      () => observeOAuth(t, "agy", [rowFor("agy", "ok"), entry]),
      unverified,
      name,
    );
  for (const label of ["fixed-account", "p123456", "anthropic-p123456"])
    await assert.rejects(
      () =>
        observeOAuth(t, "agy", [rowFor("agy", "ok")], {
          accountLogLabel: label,
        }),
      unverified,
      label,
    );
});

test("an unprefixed Claude model is compared as written, and Codex is untouched", async (t) => {
  assert.equal(stripOpenCodexModelPrefix("claude", EXECUTED), EXECUTED);
  assert.equal(stripOpenCodexModelPrefix("claude", MODEL.claude), EXECUTED);
  // A prefix that names another provider is not this provider's to strip.
  assert.equal(stripOpenCodexModelPrefix("claude", MODEL.agy), MODEL.agy);
  for (const model of ["gpt-6-astra", MODEL.claude, MODEL.agy])
    assert.equal(stripOpenCodexModelPrefix("codex", model), model);
  assert.equal(
    stripOpenCodexModelPrefix(undefined, MODEL.claude),
    MODEL.claude,
  );
  const observed = await observeOAuth(
    t,
    "claude",
    [
      rowFor("claude", "u", {
        requestedModel: EXECUTED,
        model: EXECUTED,
        resolvedModel: undefined,
      }),
    ],
    { model: EXECUTED },
  );
  assert.equal(observed.model, EXECUTED);
  assert.equal(observed.resolvedModel, EXECUTED);
});

test("the expected history provider of each logical provider", () => {
  assert.equal(
    openCodexProvider("claude", labelOf("anthropic")),
    labelOf("anthropic"),
  );
  assert.equal(openCodexProvider("claude"), "anthropic");
  assert.equal(openCodexProvider("agy"), "google-antigravity");
  assert.equal(
    openCodexProvider("codex", "fixed-account"),
    "openai-fixed-account",
  );
});

// ---- profile validation and the supported list ------------------------------

const runnerFor = (account) => ({
  kind: "opencodex",
  mode: "fixed-account",
  accountHomeRef: account,
  runtimeFingerprint: fingerprint,
});

const profileFor = (provider, model, account = "acct") => ({
  provider,
  account,
  model,
  runner: runnerFor(account),
});

test("a prefix that names another provider is refused before any turn", () => {
  const validate = (provider, model) =>
    validateOpenCodexRunner(
      profileFor(provider, model),
      runtime,
      "p",
      WITH_OAUTH,
    );
  assert.throws(() => validate("claude", MODEL.agy), unverified);
  assert.throws(() => validate("agy", MODEL.claude), unverified);
  assert.doesNotThrow(() => validate("claude", MODEL.claude));
  assert.doesNotThrow(() => validate("agy", MODEL.agy));
  assert.doesNotThrow(() => validate("claude", EXECUTED));
  // The OpenAI comparison does not read prefixes.
  assert.doesNotThrow(() => validate("codex", MODEL.claude));
  assert.doesNotThrow(() => validate("codex", "gpt-6-astra"));
});

test("claude and agy runner profiles stay unsupported until the list names them", (t) => {
  assert.deepEqual(OPENCODEX_RUNNER_PROVIDERS, ["codex"]);
  const home = oauthHome(t, "anthropic");
  const environment = {
    OMT_OPENCODEX_ACCT_HOME: home,
    OMT_OPENCODEX_ACCT_LABEL: labelOf("anthropic"),
    OMT_OPENCODEX_ACCT_SESSION_HOME: "/omt/session",
  };
  for (const provider of ["claude", "agy"]) {
    const profile = profileFor(provider, MODEL[provider]);
    assert.throws(() => validateOpenCodexRunner(profile, runtime, "p-x"), {
      message: `Invalid OpenCodex runner binding: p-x (provider ${provider} does not support runners)`,
    });
    assert.throws(
      () => resolveOpenCodexBinding(profile, runtime, environment, "p-x"),
      /does not support runners/,
    );
  }
});

// ---- binding and session homes ----------------------------------------------

function bindingEnvironment(ref, home, label, extra = {}) {
  const key = ref.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return {
    [`OMT_OPENCODEX_${key}_HOME`]: home,
    [`OMT_OPENCODEX_${key}_LABEL`]: label,
    ...extra,
  };
}

test("a Claude or Antigravity binding is validated with its own home rules and its own session home", (t) => {
  for (const provider of Object.keys(ACCOUNT_ID)) {
    const logical = LOGICAL[provider];
    const home = oauthHome(t, provider);
    const profile = profileFor(logical, MODEL[logical], "my-acct");
    const own = "OMT_OPENCODEX_MY_ACCT_SESSION_HOME";
    const bind = (environment) =>
      resolveOpenCodexBinding(profile, runtime, environment, "p", WITH_OAUTH);
    const base = bindingEnvironment("my-acct", home, labelOf(provider));
    assert.deepEqual(bind({ ...base, [own]: "/omt/session-a" }), {
      accountHome: home,
      accountLogLabel: labelOf(provider),
      sessionHome: "/omt/session-a",
      runtimePrefix: "/omt/runtime",
    });
    // The single shared variable is ignored, never a fallback.
    assert.throws(
      () => bind({ ...base, OMT_OPENCODEX_SESSION_HOME: "/omt/shared" }),
      /opencodex-action-required/,
    );
    assert.throws(
      () =>
        bind({
          ...base,
          OMT_OPENCODEX_SESSION_HOME: "/omt/shared",
          [own]: "",
        }),
      /opencodex-action-required/,
    );
    assert.throws(
      () =>
        bind({
          ...bindingEnvironment("my-acct", home, "o000000"),
          [own]: "/x",
        }),
      unverified,
    );
    // A home that breaks a condition is refused at binding time.
    const two = oauthHome(t, provider, ({ auth }) =>
      auth[provider].accounts.push({
        id: "b",
        credential: { source: "oauth" },
      }),
    );
    assert.throws(
      () =>
        bind({
          ...bindingEnvironment("my-acct", two, labelOf(provider)),
          [own]: "/omt/session-a",
        }),
      unverified,
    );
  }
});

test("a Claude profile cannot bind an Antigravity home", (t) => {
  const agyHome = oauthHome(t, "google-antigravity");
  const profile = profileFor("claude", MODEL.claude, "acct");
  assert.throws(
    () =>
      resolveOpenCodexBinding(
        profile,
        runtime,
        bindingEnvironment("acct", agyHome, labelOf("google-antigravity"), {
          OMT_OPENCODEX_ACCT_SESSION_HOME: "/omt/session",
        }),
        "p",
        WITH_OAUTH,
      ),
    unverified,
  );
});

// A minimal OpenAI account home, only to show the Codex binding is unchanged.
function codexHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "omt-codex-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({
      codexAccounts: [{ id: "only", logLabel: "fixed-account" }],
      activeCodexAccountId: "only",
      activeCodexAccountPinned: "only",
      providers: { openai: { codexAccountMode: "pool" } },
      clientIntegrations: { codex: false },
      runtimeRole: "hub",
      claudeCode: { enabled: false },
    }),
  );
  fs.writeFileSync(
    path.join(home, "codex-accounts.json"),
    JSON.stringify({ only: {} }),
  );
  return home;
}

test("an OpenAI binding takes the account's session home when set and the shared variable otherwise", (t) => {
  const home = codexHome(t);
  const profile = profileFor("codex", "gpt-6-astra", "acct");
  const base = bindingEnvironment("acct", home, "fixed-account");
  const bind = (extra) =>
    resolveOpenCodexBinding(profile, runtime, { ...base, ...extra })
      .sessionHome;
  assert.equal(
    bind({ OMT_OPENCODEX_SESSION_HOME: "/omt/shared" }),
    "/omt/shared",
  );
  assert.equal(
    bind({
      OMT_OPENCODEX_SESSION_HOME: "/omt/shared",
      OMT_OPENCODEX_ACCT_SESSION_HOME: "/omt/own",
    }),
    "/omt/own",
  );
  assert.throws(() => bind({}), /opencodex-action-required/);
  // A profile that names no provider is a legacy OpenAI profile.
  const legacy = { ...profile };
  delete legacy.provider;
  assert.equal(
    resolveOpenCodexBinding(legacy, runtime, {
      ...base,
      OMT_OPENCODEX_SESSION_HOME: "/omt/shared",
    }).sessionHome,
    "/omt/shared",
  );
});

test("one run's session homes must differ from each other and from every account home", () => {
  const profiles = (...refs) =>
    refs.map((ref) => profileFor("codex", "gpt-6-astra", ref));
  const env = (entries) => {
    const environment = {};
    for (const [ref, home, session] of entries) {
      environment[`OMT_OPENCODEX_${ref}_HOME`] = home;
      if (session) environment[`OMT_OPENCODEX_${ref}_SESSION_HOME`] = session;
    }
    return environment;
  };
  const overlap = /session homes must differ/;
  assert.doesNotThrow(() =>
    assertDistinctOpenCodexHomes(
      profiles("a", "b"),
      env([
        ["A", "/h/a", "/s/a"],
        ["B", "/h/b", "/s/b"],
      ]),
    ),
  );
  // The same session home for two accounts.
  assert.throws(
    () =>
      assertDistinctOpenCodexHomes(
        profiles("a", "b"),
        env([
          ["A", "/h/a", "/s/x"],
          ["B", "/h/b", "/s/x/../x"],
        ]),
      ),
    overlap,
  );
  // A session home that is an account home, the account's own or another's.
  assert.throws(
    () =>
      assertDistinctOpenCodexHomes(
        profiles("a", "b"),
        env([
          ["A", "/h/a", "/s/a"],
          ["B", "/h/b", "/h/a"],
        ]),
      ),
    overlap,
  );
  assert.throws(
    () =>
      assertDistinctOpenCodexHomes(profiles("a"), env([["A", "/h/a", "/h/a"]])),
    overlap,
  );
  // Two OpenAI accounts on the one shared variable would share a CODEX_HOME.
  assert.throws(
    () =>
      assertDistinctOpenCodexHomes(profiles("a", "b"), {
        ...env([
          ["A", "/h/a"],
          ["B", "/h/b"],
        ]),
        OMT_OPENCODEX_SESSION_HOME: "/s/shared",
      }),
    overlap,
  );
  // Roles on the same profile are one account, not two.
  assert.doesNotThrow(() =>
    assertDistinctOpenCodexHomes(
      profiles("a", "a"),
      env([["A", "/h/a", "/s/a"]]),
    ),
  );
  // Profiles without a runner and accounts not configured yet are skipped.
  assert.doesNotThrow(() =>
    assertDistinctOpenCodexHomes(
      [
        { provider: "claude", account: "current" },
        undefined,
        ...profiles("a", "b"),
      ],
      env([["A", "/h/a", "/s/a"]]),
    ),
  );
  // Claude and Antigravity accounts never fall back to the shared variable.
  const oauth = [
    profileFor("claude", MODEL.claude, "a"),
    profileFor("agy", MODEL.agy, "b"),
  ];
  assert.doesNotThrow(() =>
    assertDistinctOpenCodexHomes(oauth, {
      ...env([
        ["A", "/h/a"],
        ["B", "/h/b"],
      ]),
      OMT_OPENCODEX_SESSION_HOME: "/s/shared",
    }),
  );
  assert.throws(
    () =>
      assertDistinctOpenCodexHomes(
        oauth,
        env([
          ["A", "/h/a", "/s/x"],
          ["B", "/h/b", "/s/x"],
        ]),
      ),
    overlap,
  );
});
