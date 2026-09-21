/** Fail-closed OpenCodex fixed-account runner binding validation. */
import path from "node:path";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { assert } from "./core.mjs";

/**
 * Validates a profile's optional OpenCodex runner without changing legacy profile behavior.
 * @param {object} profile - Organization profile.
 * @param {object} activeRuntime - Active runtime identity.
 * @returns {{kind: string, mode: string, accountHomeRef: string, runtimeFingerprint: string} | null} Valid runner or null for legacy.
 */
export function validateOpenCodexRunner(profile, activeRuntime) {
  if (!profile.runner) return null;
  const runner = profile.runner;
  assert(runner.kind === "opencodex", "opencodex-binding-unverified");
  assert(runner.mode === "fixed-account", "opencodex-pool-unverified");
  assert(
    typeof runner.accountHomeRef === "string" &&
      runner.accountHomeRef === profile.account,
    "opencodex-binding-unverified",
  );
  assert(
    runner.runtimeFingerprint === activeRuntime?.prefixFingerprint,
    "opencodex-binding-unverified",
  );
  assert(profile.model !== null, "opencodex-binding-unverified");
  return runner;
}

/**
 * Builds isolated environment variables for a fixed account turn.
 * @param {object} binding - Validated binding input.
 * @returns {Record<string, string>} Environment additions.
 */
export function openCodexEnvironment(binding) {
  assert(
    binding.accountHome && binding.sessionHome && binding.runtimePrefix,
    "opencodex-binding-unverified",
  );
  assert(
    path.resolve(binding.accountHome) !== path.resolve(binding.sessionHome),
    "opencodex-binding-unverified",
  );
  assert(
    path.resolve(binding.accountHome) !== path.resolve(binding.runtimePrefix),
    "opencodex-binding-unverified",
  );
  assert(
    !Object.keys(binding.env ?? {}).some((key) => /API[_-]?KEY/i.test(key)),
    "api-key-fallback-blocked",
  );
  return {
    OPENCODEX_HOME: binding.accountHome,
    CODEX_HOME: binding.sessionHome,
  };
}

/**
 * Keeps an OpenCodex child from inheriting an API-key or another OpenCodex home.
 * @param {NodeJS.ProcessEnv} environment - Parent process environment.
 * @param {Record<string, string>} homes - Verified turn homes.
 * @returns {NodeJS.ProcessEnv} Isolated child environment.
 */
export function isolatedOpenCodexEnvironment(environment, homes) {
  const safe = { ...environment };
  for (const key of Object.keys(safe)) {
    if (
      /(?:^|_)(?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|API)[A-Z_]*(?:KEY|TOKEN)(?:$|_)/i.test(
        key,
      ) ||
      key === "OPENCODEX_HOME" ||
      key === "CODEX_HOME"
    ) {
      delete safe[key];
    }
  }
  return { ...safe, ...homes };
}

/**
 * Verifies that an OpenAI account home cannot select a second account or native path.
 * Credential contents are not returned or persisted.
 * @param {string} accountHome - Isolated OpenCodex account directory.
 * @param {string} accountLogLabel - Expected secret-free account label.
 * @returns {{provider: string, accountLogLabel: string}} Fixed account proof.
 */
export function validateFixedOpenCodexAccountHome(
  accountHome,
  accountLogLabel,
) {
  const configFile = path.join(accountHome, "config.json");
  const storeFile = path.join(accountHome, "codex-accounts.json");
  assert(
    fs.existsSync(configFile) && fs.existsSync(storeFile),
    "opencodex-binding-unverified",
  );
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  const credentials = JSON.parse(fs.readFileSync(storeFile, "utf8"));
  const accounts = config.codexAccounts;
  assert(
    Array.isArray(accounts) &&
      accounts.length === 1 &&
      Object.keys(credentials).length === 1 &&
      accounts[0]?.id === config.activeCodexAccountId &&
      accounts[0]?.id in credentials &&
      accounts[0]?.logLabel === accountLogLabel,
    "opencodex-binding-unverified",
  );
  assert(
    config.activeCodexAccountPinned === accounts[0]?.id &&
      config.providers?.openai?.codexAccountMode === "pool" &&
      config.clientIntegrations?.codex === false,
    "opencodex-pool-unverified",
  );
  return { provider: "openai", accountLogLabel };
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) =>
    server.listen(0, "127.0.0.1", resolve).on("error", reject),
  );
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function processGroupMembers(group) {
  if (process.platform === "win32") return null;
  const listed = spawnSync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8" });
  if (listed.status !== 0) return null;
  return listed.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, pgid]) => Number.isInteger(pid) && pgid === group)
    .map(([pid]) => pid);
}

function listenerOwnedByGroup(port, group) {
  if (process.platform === "win32") return false;
  const listeners = spawnSync(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    {
      encoding: "utf8",
    },
  );
  if (listeners.status !== 0) return false;
  const members = processGroupMembers(group);
  if (!members) return false;
  const pids = listeners.stdout
    .split("\n")
    .map(Number)
    .filter(Number.isInteger);
  return pids.length === 1 && members.includes(pids[0]);
}

/**
 * Acquires the account-home lease that makes a request-history boundary exclusive.
 * @param {string} accountHome - Fixed-account OpenCodex home.
 * @returns {{release: () => void}} Lease receipt.
 */
export function acquireOpenCodexLease(accountHome) {
  const file = path.join(accountHome, ".omt-opencodex-turn.lock");
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch {
    throw new Error("opencodex-binding-unverified");
  }
  return {
    release() {
      if (fd === null) return;
      fs.closeSync(fd);
      fd = null;
      try {
        fs.unlinkSync(file);
      } catch {}
    },
  };
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function stopOwnedProxy(child) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {}
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (processAlive(child.pid)) {
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch {}
    await Promise.race([
      new Promise((resolve) => child.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
  const members = processGroupMembers(child.pid);
  assert(
    !processAlive(child.pid) && members?.length === 0,
    "opencodex-proxy-exit-unverifiable",
  );
}

/**
 * Starts an owned loopback OpenCodex process and waits for its health endpoint.
 * This never invokes a login command and only terminates the child it started.
 * @param {object} binding - Runtime prefix and isolated fixed-account homes.
 * @returns {Promise<{port: number, pid: number | null, env: Record<string, string>, stop: () => Promise<void>}>} Owned proxy receipt.
 */
export async function startOpenCodexProxy(binding) {
  const env = openCodexEnvironment(binding);
  assert(
    process.platform !== "win32",
    "opencodex-proxy-ownership-unverifiable",
  );
  const lease = acquireOpenCodexLease(binding.accountHome);
  const port = await unusedPort();
  const binary = path.join(
    binding.runtimePrefix,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "ocx.cmd" : "ocx",
  );
  const child = spawn(binary, ["start", "--port", String(port)], {
    cwd: binding.runtimePrefix,
    env: isolatedOpenCodexEnvironment(process.env, env),
    stdio: "ignore",
    shell: false,
    detached: process.platform !== "win32",
  });
  let exited = false;
  let spawnError = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.once("close", () => {
    exited = true;
  });
  const deadline = Date.now() + (binding.readyTimeoutMs ?? 15000);
  while (Date.now() < deadline) {
    if (spawnError || exited) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok && child.pid && !exited) {
        if (!listenerOwnedByGroup(port, child.pid)) break;
        return {
          port,
          pid: child.pid ?? null,
          env,
          stop: async () => {
            try {
              if (child.exitCode === null && !exited)
                await stopOwnedProxy(child);
            } finally {
              lease.release();
            }
          },
        };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    if (child.exitCode === null && !exited) await stopOwnedProxy(child);
  } finally {
    lease.release();
  }
  throw new Error("opencodex-proxy-not-ready");
}

/**
 * Builds the actual Codex CLI argv for an already-ready OpenCodex proxy.
 * @param {object} request - Requested model, effort, cwd and proxy port.
 * @returns {string[]} Shell-free Codex argv.
 */
export function openCodexCommand(request) {
  assert(request.model, "opencodex-binding-unverified");
  assert(request.effort, "opencodex-binding-unverified");
  assert(Number.isInteger(request.port), "opencodex-proxy-not-ready");
  const argv = [
    "codex",
    "exec",
    ...(request.session ? ["resume", request.session] : []),
    "--json",
    ...(request.writable
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : ["--sandbox", "read-only", "--ephemeral"]),
    "--cd",
    request.cwd,
    "--model",
    request.model,
    "--config",
    `model_reasoning_effort=${request.effort}`,
    "--config",
    "model_provider=omt-opencodex",
    "--config",
    'model_providers.omt-opencodex.name="OpenCodex OMT proxy"',
    "--config",
    `model_providers.omt-opencodex.base_url="http://127.0.0.1:${request.port}/v1"`,
    "--config",
    'model_providers.omt-opencodex.wire_api="responses"',
    "--config",
    "model_providers.omt-opencodex.requires_openai_auth=false",
    "--config",
    "model_providers.omt-opencodex.request_max_retries=0",
    "--config",
    "model_providers.omt-opencodex.stream_max_retries=0",
    "-",
  ];
  return argv;
}

/**
 * Returns the provider name recorded by OpenCodex for an OMT logical provider.
 * @param {string} provider - OMT logical provider identifier.
 * @returns {string} OpenCodex request-history provider identifier.
 */
export function openCodexProvider(provider, accountLogLabel) {
  return (
    (provider === "codex" && accountLogLabel
      ? `openai-${accountLogLabel}`
      : { claude: "anthropic", agy: "google-antigravity" }[provider]) ??
    provider
  );
}

/**
 * Reads every page of request history using the endpoint's opaque cursor.
 * @param {object} input - Loopback proxy and account directory.
 * @param {typeof fetch} fetcher - Injectable loopback fetch implementation.
 * @returns {Promise<object[]>} Complete history, newest first.
 */
async function readOpenCodexHistory(input, fetcher) {
  const tokenFile = path.join(input.accountHome, "admin-api-token");
  assert(fs.existsSync(tokenFile), "opencodex-binding-unverified");
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  assert(token, "opencodex-binding-unverified");
  const entries = [];
  let cursor = null;
  const cursors = new Set();
  do {
    const url = new URL(`http://127.0.0.1:${input.port}/api/request-history`);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetcher(url, {
      headers: { "X-OpenCodex-API-Key": token },
    });
    assert(response.ok, "opencodex-binding-unverified");
    const page = await response.json();
    assert(Array.isArray(page.entries), "opencodex-binding-unverified");
    entries.push(...page.entries);
    cursor =
      typeof page.nextCursor === "string" && page.nextCursor
        ? page.nextCursor
        : null;
    assert(
      page.hasMore !== true || Boolean(cursor),
      "opencodex-binding-unverified",
    );
    assert(!cursor || !cursors.has(cursor), "opencodex-binding-unverified");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return entries;
}

/**
 * Captures the request IDs that existed before a caller-owned invocation.
 * @param {object} input - Loopback proxy and account directory.
 * @param {typeof fetch} [fetcher=fetch] - Injectable loopback fetch implementation.
 * @returns {Promise<Set<string>>} Existing request IDs.
 */
export async function openCodexHistoryBoundary(input, fetcher = fetch) {
  const entries = await readOpenCodexHistory(input, fetcher);
  return new Set(entries.map((entry) => entry?.requestId).filter(Boolean));
}

/**
 * Reads the caller-owned request-history observation after a boundary.
 * The management token is sent only to loopback and is never returned.
 * @param {object} input - Loopback proxy and requested binding data.
 * @param {typeof fetch} [fetcher=fetch] - Injectable loopback fetch implementation.
 * @returns {Promise<{provider: string, accountLogLabel: string, model: string, usage: object | null}>}
 */
export async function readOpenCodexObservation(input, fetcher = fetch) {
  const entries = await readOpenCodexHistory(input, fetcher);
  const before = input.historyBoundary ?? new Set();
  const created = entries.filter((entry) => !before.has(entry?.requestId));
  assert(created.length > 0, "opencodex-binding-unverified");
  const expectedProvider = openCodexProvider(
    input.provider,
    input.accountLogLabel,
  );
  const valid = (entry) => {
    const attempts = entry?.attempts;
    const model = entry?.resolvedModel ?? entry?.model;
    return (
      typeof entry?.requestId === "string" &&
      entry.requestedModel === input.model &&
      model === input.model &&
      entry.provider === expectedProvider &&
      Number.isInteger(entry.status) &&
      entry.status >= 200 &&
      entry.status < 300 &&
      entry.terminalStatus === "completed" &&
      Array.isArray(attempts) &&
      attempts.length > 0 &&
      attempts.every(
        (attempt) =>
          attempt?.accountLogLabel === input.accountLogLabel &&
          attempt?.provider === expectedProvider &&
          attempt?.model === input.model,
      )
    );
  };
  assert(created.every(valid), "opencodex-binding-unverified");
  return {
    requestId: created[0].requestId,
    requestIds: created.map((entry) => entry.requestId),
    provider: expectedProvider,
    accountLogLabel: input.accountLogLabel,
    model: input.model,
    usage: created.length === 1 ? (created[0].usage ?? null) : null,
    attempts: created.flatMap((entry) => entry.attempts),
    requests: created,
  };
}

/**
 * Resolves a named fixed-account binding from explicit process environment references.
 * @param {object} profile - Organization profile with an OpenCodex runner.
 * @param {object} runtime - Active runtime diagnosis result.
 * @param {NodeJS.ProcessEnv} [environment=process.env] - Explicit caller configuration.
 * @returns {object} Secret-free fixed-account binding.
 */
export function resolveOpenCodexBinding(
  profile,
  runtime,
  environment = process.env,
) {
  const runner = validateOpenCodexRunner(profile, runtime);
  if (!runner) return null;
  const key = runner.accountHomeRef.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const accountHome = environment[`OMT_OPENCODEX_${key}_HOME`];
  const accountLogLabel = environment[`OMT_OPENCODEX_${key}_LABEL`];
  const sessionHome = environment.OMT_OPENCODEX_SESSION_HOME;
  assert(
    accountHome && accountLogLabel && sessionHome,
    "opencodex-action-required: configure named account home, label and session home",
  );
  validateFixedOpenCodexAccountHome(accountHome, accountLogLabel);
  return {
    accountHome,
    accountLogLabel,
    sessionHome,
    runtimePrefix: runtime.runtimePrefix,
  };
}
