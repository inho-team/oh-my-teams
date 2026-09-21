/** Fixed-account OpenCodex binding and command boundary coverage. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  acquireOpenCodexLease,
  isolatedOpenCodexEnvironment,
  killWindowsProcessTree,
  openCodexCommand,
  openCodexLaunch,
  openCodexEnvironment,
  openCodexHistoryBoundary,
  processGroupMembers,
  readOpenCodexObservation,
  startOpenCodexProxy,
  validateFixedOpenCodexAccountHome,
  validateOpenCodexRunner,
  windowsOwnedListener,
  windowsOwnedProcesses,
  windowsProcessTable,
} from "../plugins/oh-my-teams/scripts/opencodex.mjs";
import { killRecorded, writeFakeOcx } from "./fake-ocx.mjs";
import { run } from "../plugins/oh-my-teams/scripts/core.mjs";
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
    runtimeRole: "hub",
    claudeCode: { enabled: false, systemEnv: false, injectAgents: false },
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

test("a fixed-account home must carry the same global-change guards as the health-check home", (t) => {
  const accountHome = fs.mkdtempSync(path.join(os.tmpdir(), "omt-ocx-guard-"));
  t.after(() => fs.rmSync(accountHome, { recursive: true, force: true }));
  const config = {
    codexAccounts: [{ id: "only", logLabel: "fixed-account" }],
    activeCodexAccountId: "only",
    activeCodexAccountPinned: "only",
    providers: { openai: { codexAccountMode: "pool" } },
    clientIntegrations: { codex: false },
    runtimeRole: "hub",
    claudeCode: { enabled: false, systemEnv: false, injectAgents: false },
  };
  fs.writeFileSync(
    path.join(accountHome, "codex-accounts.json"),
    JSON.stringify({ only: {} }),
  );
  const check = (overrides) => {
    fs.writeFileSync(
      path.join(accountHome, "config.json"),
      JSON.stringify({ ...config, ...overrides }),
    );
    return () =>
      validateFixedOpenCodexAccountHome(accountHome, "fixed-account");
  };
  const blocked = /opencodex-global-change-blocked/;
  // The review's reproduction: everything else valid, integrations enabled.
  assert.throws(
    check({
      claudeCode: { enabled: true, systemEnv: true, injectAgents: true },
      runtimeRole: "standalone",
    }),
    blocked,
  );
  assert.throws(check({ runtimeRole: "standalone" }), /runtimeRole/);
  assert.throws(check({ runtimeRole: undefined }), blocked);
  assert.throws(check({ claudeCode: undefined }), blocked);
  assert.throws(check({ claudeCode: {} }), blocked);

  assert.throws(
    check({
      claudeCode: { enabled: true, systemEnv: true, injectAgents: false },
    }),
    blocked,
  );
  assert.throws(
    check({
      claudeCode: { enabled: true, systemEnv: false, injectAgents: true },
    }),
    blocked,
  );
  // Either way the vendor documents for turning the integration off is enough.
  assert.doesNotThrow(check({ claudeCode: { enabled: false } }));
  // Turning both individual actions off is enough even while the feature is on.
  assert.doesNotThrow(
    check({
      claudeCode: { enabled: true, systemEnv: false, injectAgents: false },
    }),
  );
  assert.doesNotThrow(
    check({ claudeCode: { systemEnv: false, injectAgents: false } }),
  );
  assert.doesNotThrow(check({}));
});

// A history endpoint that serves `pages` in order and repeats the last one.
function historyFixture(t, pages) {
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
    settleMs: 0,
  };
  let reads = 0;
  const fetcher = async (_url, init) => {
    assert.equal(init.headers["X-OpenCodex-API-Key"], "test-token");
    const page = pages[Math.min(reads, pages.length - 1)];
    reads += 1;
    return {
      ok: true,
      json: async () => (typeof page === "function" ? page() : page),
    };
  };
  return { input, fetcher, reads: () => reads };
}

const attempt = (overrides = {}) => ({
  ordinal: 1,
  provider: "openai-fixed-account",
  accountLogLabel: "fixed-account",
  model: "gpt-6-astra",
  status: 200,
  sendCount: 1,
  recoveryKinds: [],
  ...overrides,
});

// A completed fixed-account request created after the boundary was taken.
const row = (requestId, overrides = {}) => ({
  requestId,
  timestamp: Date.now() + 60000,
  requestedModel: "gpt-6-astra",
  resolvedModel: "gpt-6-astra",
  provider: "openai-fixed-account",
  status: 200,
  terminalStatus: "completed",
  usage: { input_tokens: 3 },
  attempts: [attempt()],
  ...overrides,
});

async function observe(t, entries, overrides = {}) {
  const fixture = historyFixture(t, [
    { entries: [{ requestId: "old" }] },
    { entries },
    ...(overrides.second ? [{ entries: overrides.second }] : []),
  ]);
  const historyBoundary = await openCodexHistoryBoundary(
    fixture.input,
    fixture.fetcher,
  );
  return readOpenCodexObservation(
    {
      ...fixture.input,
      historyBoundary: overrides.boundary ?? historyBoundary,
    },
    fixture.fetcher,
  );
}

const unverified = /opencodex-binding-unverified/;

test("one Codex turn with several upstream requests keeps the whole owned set", async (t) => {
  const first = row("turn-request-1");
  const second = row("turn-request-2", {
    attempts: [attempt({ durationMs: 12 })],
  });
  const observed = await observe(t, [second, first]);
  assert.deepEqual(observed.requestIds, ["turn-request-2", "turn-request-1"]);
  assert.equal(observed.requests.length, 2);
  assert.equal(observed.attempts.length, 2);
  // Usage of several requests is not summed here; unknown is not zero.
  assert.equal(observed.usage, null);
  assert.equal(observed.provider, "openai-fixed-account");
  assert.equal(observed.accountLogLabel, "fixed-account");
});

test("a single request keeps its usage and every attempt", async (t) => {
  const observed = await observe(t, [row("only")]);
  assert.deepEqual(observed.requestIds, ["only"]);
  assert.deepEqual(observed.usage, { input_tokens: 3 });
  assert.deepEqual(observed.attempts, [attempt()]);
});

test("any owned request or attempt that does not prove the fixed account rejects the set", async (t) => {
  const good = row("good");
  const bad = {
    "attempt on another account": row("bad", {
      attempts: [attempt({ accountLogLabel: "other-account" })],
    }),
    "attempt on another provider": row("bad", {
      attempts: [attempt({ provider: "anthropic" })],
    }),
    "attempt on another model": row("bad", {
      attempts: [attempt({ model: "gpt-other" })],
    }),
    "failed attempt behind a 2xx request": row("bad", {
      attempts: [attempt({ status: 429 }), attempt({ ordinal: 2 })],
    }),
    "attempt without a status": row("bad", {
      attempts: [attempt({ status: undefined })],
    }),
    "resent attempt": row("bad", { attempts: [attempt({ sendCount: 2 })] }),
    "recovered attempt": row("bad", {
      attempts: [attempt({ recoveryKinds: ["oauth-account-429"] })],
    }),
    "attempt with unknown recovery record": row("bad", {
      attempts: [attempt({ recoveryKinds: undefined })],
    }),
    "attempt ordinals that skip": row("bad", {
      attempts: [attempt(), attempt({ ordinal: 3 })],
    }),
    "request without attempts": row("bad", { attempts: [] }),
    "request that is not completed": row("bad", {
      terminalStatus: "streaming",
    }),
    "request that is not 2xx": row("bad", { status: 500 }),
    "request on another provider": row("bad", { provider: "anthropic" }),
    "request for another model": row("bad", { requestedModel: "gpt-other" }),
  };
  for (const [name, entry] of Object.entries(bad)) {
    await assert.rejects(
      () => observe(t, [good, entry]),
      unverified,
      `${name} must reject the whole set, not shrink it`,
    );
  }
});

test("rows that cannot be attributed to the caller's turn are refused", async (t) => {
  // A row created before the boundary was read is not this turn's.
  await assert.rejects(
    () => observe(t, [row("early", { timestamp: 1 })]),
    unverified,
  );
  // A row with no usable time cannot be placed after the boundary at all.
  await assert.rejects(
    () => observe(t, [row("undated", { timestamp: undefined })]),
    unverified,
  );
  // A boundary that does not record when it was taken correlates nothing.
  await assert.rejects(
    () => observe(t, [row("mine")], { boundary: new Set(["old"]) }),
    unverified,
  );
  // The same request id twice is not two requests.
  await assert.rejects(
    () => observe(t, [row("twin"), row("twin")]),
    unverified,
  );
  // No new row at all proves no upstream request happened.
  await assert.rejects(() => observe(t, []), unverified);
});

test("a row that appears only on the settling read refuses the observation", async (t) => {
  await assert.rejects(
    () =>
      observe(t, [row("first")], { second: [row("first"), row("straggler")] }),
    unverified,
  );
  await assert.rejects(
    () => observe(t, [row("first"), row("second")], { second: [row("first")] }),
    unverified,
  );
});

test("request-history pagination and an unrelated concurrent row fail closed", async (t) => {
  let page = 0;
  const fixture = historyFixture(t, [
    () => {
      page += 1;
      return page === 1
        ? { entries: [{ requestId: "old" }], nextCursor: "next" }
        : { entries: [] };
    },
    {
      entries: [{ requestId: "other" }, { requestId: "caller-owned-request" }],
    },
  ]);
  const historyBoundary = await openCodexHistoryBoundary(
    fixture.input,
    fixture.fetcher,
  );
  assert.ok(historyBoundary.has("old"));
  assert.ok(Number.isFinite(historyBoundary.capturedAt));
  await assert.rejects(
    () =>
      readOpenCodexObservation(
        { ...fixture.input, historyBoundary },
        fixture.fetcher,
      ),
    unverified,
  );
});

test("run reports whether the input reached the child and whether its exit was seen", async () => {
  const seen = await run(
    [process.execPath, "-e", "process.stdin.resume().on('end',()=>{})"],
    { input: "hello", timeoutMs: 10000 },
  );
  assert.equal(seen.inputAccepted, true);
  assert.equal(seen.exitObserved, true);
});

const win = process.platform === "win32";

// Windows proves ownership from a (pid, CreationDate) snapshot with PowerShell;
// POSIX proves it from process groups and lsof, so only lsof can be missing.
const proxyProof = {
  skip:
    !win && spawnSync("lsof", ["-v"]).error !== undefined
      ? "the POSIX proxy ownership proof needs lsof"
      : false,
};

// Tests that assert something only a POSIX process group or `ps` can show.
const posixOnly = {
  skip: win
    ? "Windows has no process groups; a sibling test covers the snapshot proof"
    : proxyProof.skip,
};

// Tests that assert something only the Windows snapshot proof produces.
const windowsOnly = {
  skip: win ? false : "the (pid, CreationDate) proof exists only on Windows",
};

// What stopping a proxy proves: a whole group on POSIX, only a snapshot on Windows.
const exitReceipt = win
  ? { termination: "exited-snapshot", descendantsExited: false }
  : { termination: "exited", descendantsExited: true };

// Makes every process inspection fail: `ps` and `lsof` come from PATH on POSIX,
// PowerShell from SystemRoot on Windows.
async function withBrokenInspection(action) {
  const key = win ? "SystemRoot" : "PATH";
  const saved = process.env[key];
  process.env[key] = path.join(os.tmpdir(), "omt-no-such-bin");
  try {
    return await action();
  } finally {
    process.env[key] = saved;
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && alive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !alive(pid);
}

// A runtime prefix whose `ocx` is a script. Its behaviour comes from MODE.
function fakeRuntime(t, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-ocx-proxy-"));
  const accountHome = path.join(dir, "account");
  const prefix = path.join(dir, "runtime");
  fs.mkdirSync(accountHome);
  const pids = path.join(dir, "pids");
  fs.mkdirSync(pids);
  writeFakeOcx(prefix, mode, pids);
  const readText = (name) => fs.readFileSync(path.join(pids, name), "utf8");
  const read = (name) => {
    try {
      return Number(fs.readFileSync(path.join(pids, name), "utf8"));
    } catch {
      return null;
    }
  };
  t.after(() => {
    killRecorded(pids);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    read,
    readText,
    lease: path.join(accountHome, ".omt-opencodex-turn.lock"),
    binding: {
      accountHome,
      sessionHome: path.join(dir, "session"),
      runtimePrefix: prefix,
      readyTimeoutMs: 4000,
      stopGraceMs: 600,
    },
  };
}

test(
  "an owned proxy is accepted only as the sole listener of its own process tree",
  proxyProof,
  async (t) => {
    const runtime = fakeRuntime(t, "serve");
    const proxy = await startOpenCodexProxy(runtime.binding);
    assert.equal(proxy.ownership.group, proxy.pid);
    assert.equal(proxy.ownership.listenerPid, runtime.read("launcher"));
    if (win) {
      assert.equal(
        proxy.ownership.method,
        "sole-listener-in-owned-process-tree-snapshot",
      );
      assert.ok(
        proxy.ownership.snapshot.some(
          (member) => member.pid === proxy.ownership.listenerPid,
        ),
      );
    } else {
      assert.ok(
        processGroupMembers(proxy.pid).includes(proxy.ownership.listenerPid),
      );
    }
    assert.equal(fs.existsSync(runtime.lease), true);
    const stopped = await proxy.stop();
    assert.deepEqual(stopped, exitReceipt);
    assert.equal(await gone(runtime.read("launcher")), true);
    assert.equal(fs.existsSync(runtime.lease), false);
  },
);

// POSIX only: this needs a launcher whose child leads another process group, and
// Windows has none. "outside-listener" below is the Windows counterpart.
test(
  "a healthy responder that another process group owns is refused",
  posixOnly,
  async (t) => {
    const runtime = fakeRuntime(t, "impostor");
    await assert.rejects(
      () => startOpenCodexProxy(runtime.binding),
      /opencodex-proxy-not-ready/,
    );
    // The launcher was ended and released; the foreign listener is not ours to end.
    assert.equal(await gone(runtime.read("launcher")), true);
    assert.equal(fs.existsSync(runtime.lease), false);
    assert.equal(alive(runtime.read("impostor")), true);
  },
);

test(
  "a healthy responder outside the launcher's process tree is refused",
  windowsOnly,
  async (t) => {
    const runtime = fakeRuntime(t, "outside-listener");
    await assert.rejects(
      () => startOpenCodexProxy(runtime.binding),
      /opencodex-proxy-not-ready/,
    );
    // The launcher was ended and released; the outside listener is not ours to end.
    assert.equal(await gone(runtime.read("launcher")), true);
    assert.equal(fs.existsSync(runtime.lease), false);
    assert.equal(alive(runtime.read("outside")), true);
  },
);

test(
  "a listener that is a child of the launcher is owned and ended with it",
  proxyProof,
  async (t) => {
    const runtime = fakeRuntime(t, "serve-child");
    const proxy = await startOpenCodexProxy(runtime.binding);
    const server = runtime.read("server");
    assert.equal(proxy.ownership.listenerPid, server);
    assert.notEqual(server, runtime.read("launcher"));
    assert.deepEqual(await proxy.stop(), exitReceipt);
    assert.equal(await gone(server), true);
    assert.equal(await gone(runtime.read("launcher")), true);
  },
);

test(
  "a health body naming another pid than the listener is refused",
  windowsOnly,
  async (t) => {
    const runtime = fakeRuntime(t, "wrong-pid");
    await assert.rejects(
      () => startOpenCodexProxy({ ...runtime.binding, readyTimeoutMs: 1200 }),
      /opencodex-proxy-not-ready/,
    );
    assert.equal(await gone(runtime.read("launcher")), true);
    assert.equal(fs.existsSync(runtime.lease), false);
  },
);

test(
  "a health body that does not name the port is refused",
  proxyProof,
  async (t) => {
    const runtime = fakeRuntime(t, "wrong-health");
    await assert.rejects(
      () => startOpenCodexProxy({ ...runtime.binding, readyTimeoutMs: 1200 }),
      /opencodex-proxy-not-ready/,
    );
    assert.equal(await gone(runtime.read("launcher")), true);
  },
);

test(
  "a descendant left behind by an exited launcher is ended, not ignored",
  proxyProof,
  async (t) => {
    const runtime = fakeRuntime(t, "leaves-descendant");
    await assert.rejects(
      () => startOpenCodexProxy(runtime.binding),
      /opencodex-proxy-not-ready/,
    );
    assert.ok(runtime.read("descendant"));
    assert.equal(await gone(runtime.read("descendant")), true);
    assert.equal(fs.existsSync(runtime.lease), false);
  },
);

test(
  "stopping ends every member of the owned tree, including one that ignores termination",
  proxyProof,
  async (t) => {
    const runtime = fakeRuntime(t, "stubborn-descendant");
    const proxy = await startOpenCodexProxy(runtime.binding);
    const descendant = runtime.read("descendant");
    assert.equal(alive(descendant), true);
    assert.deepEqual(await proxy.stop(), exitReceipt);
    assert.equal(await gone(descendant), true);
    assert.equal(await gone(runtime.read("launcher")), true);
  },
);

test(
  "a tree whose exit cannot be inspected is unverifiable and keeps its lease",
  proxyProof,
  async (t) => {
    const runtime = fakeRuntime(t, "serve");
    const proxy = await startOpenCodexProxy(runtime.binding);
    // Without `ps` or PowerShell, no owned tree can be shown gone.
    await withBrokenInspection(() =>
      assert.rejects(() => proxy.stop(), /opencodex-proxy-exit-unverifiable/),
    );
    assert.equal(fs.existsSync(runtime.lease), true);
    // The lease stays, so a later turn on this home is refused rather than trusted.
    await assert.rejects(
      () => startOpenCodexProxy(runtime.binding),
      /opencodex-lease-held/,
    );
  },
);

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

test(
  "the proxy child runs with a private HOME, not the user's",
  proxyProof,
  async (t) => {
    const runtime = fakeRuntime(t, "serve");
    const proxy = await startOpenCodexProxy(runtime.binding);
    try {
      assert.equal(
        runtime.readText("home"),
        path.join(runtime.binding.accountHome, ".omt-proxy-home"),
      );
      assert.notEqual(runtime.readText("home"), os.homedir());
      if (win)
        assert.equal(
          runtime.readText("userprofile"),
          path.join(runtime.binding.accountHome, ".omt-proxy-home"),
        );
    } finally {
      await proxy.stop();
    }
  },
);

// ---- Windows ownership proof: pure decisions, so they run on every platform ----

const FILETIME = 133000000000000000n;
const at = (offset) => String(FILETIME + BigInt(offset));
const pidsOf = (members) => members.map((member) => member.pid).sort();

test("a Windows proxy tree is the launcher and its descendants created after the spawn", () => {
  const table = [
    { pid: 10, ppid: 1, created: at(10) },
    { pid: 11, ppid: 10, created: at(20) },
    { pid: 12, ppid: 11, created: at(30) },
    // Created before the spawn: a reused pid, not a child of ours.
    { pid: 13, ppid: 10, created: at(-5) },
    { pid: 20, ppid: 1, created: at(40) },
  ];
  const record = { group: 10, processStart: at(10), notBefore: at(0) };
  assert.deepEqual(pidsOf(windowsOwnedProcesses(table, record)), [10, 11, 12]);
});

test("a dead launcher's descendants stay owned because Windows keeps their parent pid", () => {
  const table = [
    { pid: 11, ppid: 10, created: at(20) },
    { pid: 12, ppid: 11, created: at(30) },
    { pid: 20, ppid: 1, created: at(40) },
  ];
  const record = { group: 10, processStart: at(10), notBefore: at(0) };
  assert.deepEqual(pidsOf(windowsOwnedProcesses(table, record)), [11, 12]);
});

test("a reused launcher pid takes no children with it", () => {
  const table = [
    { pid: 10, ppid: 1, created: at(500) },
    { pid: 11, ppid: 10, created: at(510) },
  ];
  const record = { group: 10, processStart: at(10), notBefore: at(0) };
  assert.deepEqual(windowsOwnedProcesses(table, record), []);
});

test("a snapshot pair counts only when pid and creation time both match", () => {
  const table = [
    { pid: 20, ppid: 1, created: at(40) },
    { pid: 21, ppid: 1, created: at(50) },
  ];
  const record = {
    group: 10,
    processStart: at(10),
    notBefore: at(0),
    snapshot: [
      { pid: 20, created: at(40) },
      { pid: 21, created: at(49) },
      { pid: 22, created: at(60) },
    ],
  };
  assert.deepEqual(pidsOf(windowsOwnedProcesses(table, record)), [20]);
});

test("a Windows listener is owned only when it is the sole listener, in the tree and named by health", () => {
  const table = [
    { pid: 10, ppid: 1, created: at(10) },
    { pid: 11, ppid: 10, created: at(20) },
    { pid: 20, ppid: 1, created: at(40) },
  ];
  const record = { group: 10, processStart: at(10), notBefore: at(0) };
  assert.equal(windowsOwnedListener(table, record, [11], 11), 11);
  assert.equal(windowsOwnedListener(table, record, [10, 11], 11), null);
  assert.equal(windowsOwnedListener(table, record, [20], 20), null);
  assert.equal(windowsOwnedListener(table, record, [11], 10), null);
  assert.equal(windowsOwnedListener(table, record, [], 11), null);
});

test("the runtime launch names this Node for the package entry on Windows and the bin script elsewhere", () => {
  const prefix = path.join(os.tmpdir(), "omt-launch");
  const launch = openCodexLaunch(prefix);
  if (win) {
    assert.equal(launch.command, process.execPath);
    assert.deepEqual(launch.args, [
      path.join(
        prefix,
        "node_modules",
        "@bitkyc08",
        "opencodex",
        "bin",
        "ocx.mjs",
      ),
    ]);
  } else {
    assert.equal(
      launch.command,
      path.join(prefix, "node_modules", ".bin", "ocx"),
    );
    assert.deepEqual(launch.args, []);
  }
});

// ---- account lease: owner record and stale recovery ----

function leaseFixture(t) {
  const accountHome = fs.mkdtempSync(path.join(os.tmpdir(), "omt-ocx-lease-"));
  const file = path.join(accountHome, ".omt-opencodex-turn.lock");
  const children = [];
  t.after(() => {
    for (const pid of children) {
      if (win) killWindowsProcessTree(pid);
      else
        for (const target of [-pid, pid]) {
          try {
            process.kill(target, "SIGKILL");
          } catch {}
        }
    }
    fs.rmSync(accountHome, { recursive: true, force: true });
  });
  // A sleeping process that leads its own group (POSIX), as an orphaned proxy would.
  const sleeper = () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: !win,
      stdio: "ignore",
    });
    child.unref();
    children.push(child.pid);
    return child.pid;
  };
  const startOf = (pid) =>
    win
      ? windowsProcessTable(pid)[0].created
      : spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
          encoding: "utf8",
        }).stdout.trim();
  // A time before any process of these tests started, as the Windows proxy records.
  const notBefore = String(
    (BigInt(Date.now() - 600000) + 11644473600000n) * 10000n,
  );
  // A lease file, plus the proxy record kept beside it under the lease's token.
  const write = (record) => {
    if (typeof record === "string") return fs.writeFileSync(file, record);
    const { proxy, ...lease } = record;
    fs.writeFileSync(file, JSON.stringify(lease));
    if (proxy)
      fs.writeFileSync(
        `${file}.proxy.${lease.token}`,
        JSON.stringify({
          token: lease.token,
          pid: lease.pid,
          ...(win && { notBefore }),
          ...proxy,
        }),
      );
  };
  // A pid that certainly no longer exists.
  const deadPid = () => {
    const done = spawnSync(process.execPath, ["-e", "0"]);
    return done.pid;
  };
  return { accountHome, file, sleeper, startOf, write, deadPid };
}

test(
  "a lease records its owner and, after spawn, the proxy group",
  proxyProof,
  async (t) => {
    const box = leaseFixture(t);
    const lease = await acquireOpenCodexLease(box.accountHome);
    const first = JSON.parse(fs.readFileSync(box.file, "utf8"));
    assert.equal(first.pid, process.pid);
    assert.equal(first.processStart, box.startOf(process.pid));
    assert.equal(fs.existsSync(`${box.file}.proxy.${first.token}`), false);
    const group = box.sleeper();
    lease.setProxy(group);
    // The lease itself is never rewritten; the proxy is recorded beside it.
    assert.deepEqual(JSON.parse(fs.readFileSync(box.file, "utf8")), first);
    const proxy = JSON.parse(
      fs.readFileSync(`${box.file}.proxy.${first.token}`, "utf8"),
    );
    assert.equal(proxy.group, group);
    assert.equal(proxy.processStart, box.startOf(group));
    lease.release();
    assert.equal(fs.existsSync(box.file), false);
    assert.equal(fs.existsSync(`${box.file}.proxy.${first.token}`), false);
  },
);

test(
  "a live owner keeps the home and is told apart from a dead one",
  proxyProof,
  async (t) => {
    const box = leaseFixture(t);
    const owner = box.sleeper();
    box.write({
      token: "t1",
      pid: owner,
      processStart: box.startOf(owner),
      proxy: null,
    });
    await assert.rejects(
      () => acquireOpenCodexLease(box.accountHome),
      /opencodex-lease-held/,
    );
    assert.equal(JSON.parse(fs.readFileSync(box.file, "utf8")).token, "t1");
  },
);

test(
  "a dead owner's lease is taken over and its orphaned proxy group is ended",
  proxyProof,
  async (t) => {
    const box = leaseFixture(t);
    const orphan = box.sleeper();
    box.write({
      token: "t2",
      pid: box.deadPid(),
      processStart: "Mon Jan  1 00:00:00 2001",
      proxy: { group: orphan, processStart: box.startOf(orphan) },
    });
    assert.equal(
      win ? alive(orphan) : processGroupMembers(orphan).length > 0,
      true,
    );
    const lease = await acquireOpenCodexLease(box.accountHome, {
      stopGraceMs: 600,
    });
    assert.equal(lease.recovered.terminated, true);
    assert.equal(lease.recovered.group, orphan);
    assert.equal(await gone(orphan), true);
    assert.equal(
      JSON.parse(fs.readFileSync(box.file, "utf8")).pid,
      process.pid,
    );
    lease.release();
  },
);

test(
  "a reused owner pid does not count as a live owner",
  proxyProof,
  async (t) => {
    const box = leaseFixture(t);
    const stranger = box.sleeper();
    box.write({
      token: "t3",
      pid: stranger,
      processStart: "Mon Jan  1 00:00:00 2001",
      proxy: null,
    });
    const lease = await acquireOpenCodexLease(box.accountHome);
    assert.equal(lease.recovered.owner, stranger);
    // The stranger is not the recorded owner's group and is left alone.
    assert.equal(alive(stranger), true);
    lease.release();
  },
);

test("a reused proxy group id is not ended", proxyProof, async (t) => {
  const box = leaseFixture(t);
  const stranger = box.sleeper();
  box.write({
    token: "t4",
    pid: box.deadPid(),
    processStart: null,
    proxy: { group: stranger, processStart: "Mon Jan  1 00:00:00 2001" },
  });
  const lease = await acquireOpenCodexLease(box.accountHome);
  assert.equal(lease.recovered.terminated, false);
  assert.equal(alive(stranger), true);
  lease.release();
});

test(
  "a lease whose state cannot be proven clean is kept and reported as unverifiable",
  proxyProof,
  async (t) => {
    const box = leaseFixture(t);
    box.write("not json");
    await assert.rejects(
      () => acquireOpenCodexLease(box.accountHome),
      /opencodex-lease-unverifiable/,
    );
    assert.equal(fs.readFileSync(box.file, "utf8"), "not json");
    // A dead owner whose group cannot be inspected is not assumed empty.
    const orphan = box.sleeper();
    box.write({
      token: "t5",
      pid: box.deadPid(),
      processStart: null,
      proxy: { group: orphan, processStart: null },
    });
    await withBrokenInspection(() =>
      assert.rejects(
        () => acquireOpenCodexLease(box.accountHome, { stopGraceMs: 200 }),
        /opencodex-lease-unverifiable/,
      ),
    );
    assert.equal(JSON.parse(fs.readFileSync(box.file, "utf8")).token, "t5");
  },
);

test(
  "a turn killed with SIGKILL leaves a lease and proxy that the next turn cleans up",
  proxyProof,
  async (t) => {
    const runtime = fakeRuntime(t, "serve");
    const moduleUrl = new URL(
      "../plugins/oh-my-teams/scripts/opencodex.mjs",
      import.meta.url,
    ).href;
    const script = `import(${JSON.stringify(moduleUrl)}).then(async (m) => {
    await m.startOpenCodexProxy(${JSON.stringify(runtime.binding)});
    console.log("ready");
    setInterval(() => {}, 1000);
  });`;
    const runner = spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    t.after(() => runner.kill("SIGKILL"));
    await new Promise((resolve, reject) => {
      runner.stdout.once("data", resolve);
      runner.once("exit", () => reject(new Error("runner exited early")));
    });
    const orphan = runtime.read("launcher");
    assert.equal(alive(orphan), true);
    runner.kill("SIGKILL");
    await new Promise((resolve) => runner.once("exit", resolve));
    // The dead runner never ran its cleanup, so the lease remains. On POSIX the
    // proxy remains too; on Windows libuv puts children in a kill-on-close job,
    // so the proxy dies with its runner and the next turn finds nothing to end.
    if (win) assert.equal(await gone(orphan), true);
    else assert.equal(alive(orphan), true);
    assert.equal(fs.existsSync(runtime.lease), true);
    const proxy = await startOpenCodexProxy(runtime.binding);
    try {
      assert.equal(await gone(orphan), true);
      assert.notEqual(proxy.pid, orphan);
    } finally {
      await proxy.stop();
    }
  },
);

// Replays the review's interleaving on the real module: while a reclaimer works
// on a dead owner's lease, live owners appear at each syscall it makes on the
// lease path. Whatever they publish must survive.
test(
  "a live owner that appears during a reclaim is never displaced",
  proxyProof,
  async (t) => {
    const box = leaseFixture(t);
    const dead = { token: "dead", pid: box.deadPid(), processStart: null };
    box.write(dead);
    const live = (token) => ({
      token,
      pid: process.pid,
      processStart: box.startOf(process.pid),
    });
    const { renameSync, linkSync } = fs;
    const renamedFromLease = [];
    let injected = 0;
    fs.renameSync = (from, to) => {
      if (from === box.file) renamedFromLease.push(String(to));
      return renameSync(from, to);
    };
    fs.linkSync = (from, to) => {
      // Just before the reclaimer publishes its own lease, another owner does.
      if (to === box.file && injected === 0 && !fs.existsSync(box.file)) {
        injected += 1;
        fs.writeFileSync(`${box.file}.injected`, JSON.stringify(live("L1")));
        linkSync(`${box.file}.injected`, box.file);
      }
      return linkSync(from, to);
    };
    try {
      await assert.rejects(
        () => acquireOpenCodexLease(box.accountHome),
        /opencodex-lease-held/,
      );
    } finally {
      fs.renameSync = renameSync;
      fs.linkSync = linkSync;
    }
    assert.equal(injected, 1);
    // The injected owner's lease is intact, and no lease was ever moved aside.
    assert.equal(JSON.parse(fs.readFileSync(box.file, "utf8")).token, "L1");
    assert.deepEqual(renamedFromLease, []);
    assert.equal(
      fs
        .readdirSync(box.accountHome)
        .some((name) => name.includes(".reclaim.")),
      false,
      "the reclaim mutex is released",
    );
  },
);

test(
  "a reclaimer that finds the lease replaced while it waited leaves the new owner alone",
  proxyProof,
  async (t) => {
    const box = leaseFixture(t);
    box.write({ token: "stale", pid: box.deadPid(), processStart: null });
    const mutex = `${box.file}.reclaim.stale`;
    // Another reclaimer holds the mutex, then takes the home over and leaves.
    fs.writeFileSync(
      mutex,
      JSON.stringify({
        token: "m",
        pid: process.pid,
        processStart: box.startOf(process.pid),
      }),
    );
    const pending = acquireOpenCodexLease(box.accountHome, {
      reclaimWaitMs: 5000,
    });
    const outcome = pending.then(
      () => "acquired",
      (error) => error.message,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    fs.rmSync(box.file);
    fs.writeFileSync(
      box.file,
      JSON.stringify({
        token: "L2",
        pid: process.pid,
        processStart: box.startOf(process.pid),
      }),
    );
    fs.rmSync(mutex);
    assert.match(await outcome, /opencodex-lease-held/);
    assert.equal(JSON.parse(fs.readFileSync(box.file, "utf8")).token, "L2");
  },
);

// Several processes race to take over one dead owner's lease. Whoever wins
// stays alive holding it, so at any moment at most one may report success.
const RACER = `
const [moduleUrl, home, go] = process.argv.slice(1);
import(moduleUrl).then(async (m) => {
  while (!require("node:fs").existsSync(go)) await new Promise((r) => setTimeout(r, 2));
  try {
    const lease = await m.acquireOpenCodexLease(home, { reclaimWaitMs: 8000 });
    console.log("acquired " + process.pid + " " + Boolean(lease.recovered));
    setInterval(() => {}, 1000);
  } catch (error) {
    console.log("refused " + process.pid + " " + error.message.split(":")[0]);
    process.exit(0);
  }
});
`;

test(
  "many acquirers racing for a dead owner's lease leave exactly one holder",
  proxyProof,
  async (t) => {
    const moduleUrl = new URL(
      "../plugins/oh-my-teams/scripts/opencodex.mjs",
      import.meta.url,
    ).href;
    // PowerShell makes each Windows acquirer slow, so fewer rounds keep the test short.
    for (let round = 0; round < (win ? 2 : 4); round += 1) {
      const box = leaseFixture(t);
      box.write({
        token: `dead-${round}`,
        pid: box.deadPid(),
        processStart: null,
      });
      const go = path.join(box.accountHome, "go");
      const racers = Array.from({ length: 6 }, () => {
        const child = spawn(
          process.execPath,
          ["-e", RACER, moduleUrl, box.accountHome, go],
          {
            stdio: ["ignore", "pipe", "inherit"],
          },
        );
        const lines = [];
        child.stdout.on("data", (chunk) => lines.push(String(chunk)));
        const done = new Promise((resolve) => {
          const timer = setInterval(() => {
            if (lines.join("").includes("\n") || child.exitCode !== null) {
              clearInterval(timer);
              resolve(lines.join("").trim());
            }
          }, 10);
        });
        t.after(() => child.kill("SIGKILL"));
        return { child, done };
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      fs.writeFileSync(go, "");
      const results = await Promise.all(racers.map((racer) => racer.done));
      const winners = results.filter((line) => line.startsWith("acquired"));
      assert.equal(winners.length, 1, `round ${round}: ${results.join(" | ")}`);
      for (const line of results.filter((line) => line.startsWith("refused"))) {
        assert.match(line, /opencodex-lease-held/);
      }
      // The lease belongs to the one winner, and the reclaim left no mutex.
      const winnerPid = Number(winners[0].split(" ")[1]);
      assert.equal(
        JSON.parse(fs.readFileSync(box.file, "utf8")).pid,
        winnerPid,
      );
      assert.equal(
        fs
          .readdirSync(box.accountHome)
          .some((name) => name.includes(".reclaim.")),
        false,
      );
      for (const racer of racers) racer.child.kill("SIGKILL");
    }
  },
);

test(
  "a reclaim mutex left by a dead reclaimer blocks only that lease and is reported as stuck",
  proxyProof,
  async (t) => {
    const box = leaseFixture(t);
    box.write({ token: "stale", pid: box.deadPid(), processStart: null });
    const mutex = `${box.file}.reclaim.stale`;
    fs.writeFileSync(
      mutex,
      JSON.stringify({ token: "m", pid: box.deadPid(), processStart: null }),
    );
    await assert.rejects(
      () => acquireOpenCodexLease(box.accountHome),
      /opencodex-lease-reclaim-stuck/,
    );
    // Nothing was taken over and nothing was broken automatically.
    assert.equal(JSON.parse(fs.readFileSync(box.file, "utf8")).token, "stale");
    assert.equal(fs.existsSync(mutex), true);
    // A different stale lease is not affected by that leftover mutex.
    box.write({ token: "other", pid: box.deadPid(), processStart: null });
    const lease = await acquireOpenCodexLease(box.accountHome);
    assert.equal(lease.recovered.owner > 0, true);
    lease.release();
  },
);

test(
  "a reclaim in progress by a live process is waited for, then reported as held",
  proxyProof,
  async (t) => {
    const box = leaseFixture(t);
    box.write({ token: "stale", pid: box.deadPid(), processStart: null });
    const mutex = `${box.file}.reclaim.stale`;
    fs.writeFileSync(
      mutex,
      JSON.stringify({
        token: "m",
        pid: process.pid,
        processStart: box.startOf(process.pid),
      }),
    );
    const started = Date.now();
    await assert.rejects(
      () => acquireOpenCodexLease(box.accountHome, { reclaimWaitMs: 300 }),
      /opencodex-lease-held: pid \d+ is reclaiming/,
    );
    assert.equal(Date.now() - started >= 250, true);
    assert.equal(JSON.parse(fs.readFileSync(box.file, "utf8")).token, "stale");
  },
);
