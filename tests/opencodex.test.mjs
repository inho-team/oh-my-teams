/** Fixed-account OpenCodex binding and command boundary coverage. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  isolatedOpenCodexEnvironment,
  openCodexCommand,
  openCodexEnvironment,
  openCodexHistoryBoundary,
  processGroupMembers,
  readOpenCodexObservation,
  startOpenCodexProxy,
  validateFixedOpenCodexAccountHome,
  validateOpenCodexRunner,
} from "../plugins/oh-my-teams/scripts/opencodex.mjs";
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

const posixOnly = {
  skip:
    process.platform === "win32" ||
    spawnSync("lsof", ["-v"]).error !== undefined
      ? "the proxy ownership proof needs POSIX process groups and lsof"
      : false,
};

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
  fs.mkdirSync(path.join(prefix, "node_modules", ".bin"), { recursive: true });
  const pids = path.join(dir, "pids");
  fs.mkdirSync(pids);
  const script = `#!${process.execPath}
const http = require("node:http");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const pids = ${JSON.stringify(pids)};
const record = (name, pid) => fs.writeFileSync(pids + "/" + name, String(pid));
const serve = "require('node:http').createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({status:'ok',port:" + port + "}))}).listen(" + port + ",'127.0.0.1');process.on('SIGTERM',()=>{if(!process.env.STUBBORN)process.exit(0)});setInterval(()=>{},1000)";
const mode = ${JSON.stringify(mode)};
record("launcher", process.pid);
if (mode === "serve" || mode === "stubborn-descendant") {
  http.createServer((q, r) => {
    r.setHeader("content-type", "application/json");
    r.end(JSON.stringify({ status: "ok", port }));
  }).listen(port, "127.0.0.1");
  if (mode === "stubborn-descendant") {
    const d = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
    record("descendant", d.pid);
  }
  process.on("SIGTERM", () => process.exit(0));
} else if (mode === "impostor") {
  // Another group answers health while the launcher stays alive.
  const d = spawn(process.execPath, ["-e", serve], { detached: true, stdio: "ignore" });
  d.unref();
  record("impostor", d.pid);
  setInterval(() => {}, 1000);
} else if (mode === "leaves-descendant") {
  // The launcher exits at once; a same-group descendant keeps the port.
  const d = spawn(process.execPath, ["-e", serve], { stdio: "ignore" });
  d.unref();
  record("descendant", d.pid);
} else if (mode === "wrong-health") {
  http.createServer((q, r) => r.end(JSON.stringify({ status: "ok", port: port + 1 }))).listen(port, "127.0.0.1");
  process.on("SIGTERM", () => process.exit(0));
}
`;
  const binary = path.join(prefix, "node_modules", ".bin", "ocx");
  fs.writeFileSync(binary, script, { mode: 0o755 });
  const read = (name) => {
    try {
      return Number(fs.readFileSync(path.join(pids, name), "utf8"));
    } catch {
      return null;
    }
  };
  t.after(() => {
    for (const name of fs.readdirSync(pids)) {
      const pid = read(name);
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, "SIGKILL");
        } catch {}
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    read,
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
  "an owned proxy is accepted only as the sole listener of its own process group",
  posixOnly,
  async (t) => {
    const runtime = fakeRuntime(t, "serve");
    const proxy = await startOpenCodexProxy(runtime.binding);
    assert.equal(proxy.ownership.group, proxy.pid);
    assert.equal(proxy.ownership.listenerPid, runtime.read("launcher"));
    assert.ok(
      processGroupMembers(proxy.pid).includes(proxy.ownership.listenerPid),
    );
    assert.equal(fs.existsSync(runtime.lease), true);
    const stopped = await proxy.stop();
    assert.deepEqual(stopped, {
      termination: "exited",
      descendantsExited: true,
    });
    assert.equal(await gone(runtime.read("launcher")), true);
    assert.equal(fs.existsSync(runtime.lease), false);
  },
);

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
  "a health body that does not name the port is refused",
  posixOnly,
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
  posixOnly,
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
  "stopping ends every member of the owned group, including one that ignores SIGTERM",
  posixOnly,
  async (t) => {
    const runtime = fakeRuntime(t, "stubborn-descendant");
    const proxy = await startOpenCodexProxy(runtime.binding);
    const descendant = runtime.read("descendant");
    assert.equal(alive(descendant), true);
    assert.deepEqual(await proxy.stop(), {
      termination: "exited",
      descendantsExited: true,
    });
    assert.equal(await gone(descendant), true);
    assert.equal(await gone(runtime.read("launcher")), true);
  },
);

test(
  "a tree whose exit cannot be inspected is unverifiable and keeps its lease",
  posixOnly,
  async (t) => {
    const runtime = fakeRuntime(t, "serve");
    const proxy = await startOpenCodexProxy(runtime.binding);
    const path0 = process.env.PATH;
    // Without `ps`, no process group can be shown empty.
    process.env.PATH = os.tmpdir() + path.sep + "omt-no-such-bin";
    try {
      await assert.rejects(
        () => proxy.stop(),
        /opencodex-proxy-exit-unverifiable/,
      );
    } finally {
      process.env.PATH = path0;
    }
    assert.equal(fs.existsSync(runtime.lease), true);
    // The lease stays, so a later turn on this home is refused rather than trusted.
    await assert.rejects(
      () => startOpenCodexProxy(runtime.binding),
      /opencodex-binding-unverified/,
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
