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

/**
 * Lists the live members of a POSIX process group.
 * @param {number} group - Process group id, which is the pid of a detached leader.
 * @returns {number[] | null} Member pids, or null when the platform or `ps` cannot answer.
 */
export function processGroupMembers(group) {
  if (process.platform === "win32") return null;
  const listed = spawnSync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8" });
  if (listed.status !== 0) return null;
  return listed.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, pgid]) => Number.isInteger(pid) && pgid === group)
    .map(([pid]) => pid);
}

// The one process listening on the port, when it belongs to the owned group.
// Any other listener, an absent one, or a failing lsof proves nothing.
function ownedListenerPid(port, group) {
  if (process.platform === "win32") return null;
  const listeners = spawnSync(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    { encoding: "utf8" },
  );
  if (listeners.status !== 0) return null;
  const members = processGroupMembers(group);
  if (!members) return null;
  // Blank lines are not pids: Number("") is 0 and would count as a listener.
  const pids = listeners.stdout
    .split("\n")
    .filter((line) => /^\d+$/.test(line.trim()))
    .map(Number);
  return pids.length === 1 && members.includes(pids[0]) ? pids[0] : null;
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

async function waitForEmptyGroup(group, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processGroupMembers(group)?.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Ends every member of the owned group, not only its leader. A launcher that
// exited while a descendant kept running is still a live owned tree, so this
// never trusts the leader's exit; it passes only when the group is observed empty.
async function stopOwnedProxy(child, graceMs) {
  const group = child.pid;
  assert(group, "opencodex-proxy-exit-unverifiable");
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    if (processGroupMembers(group)?.length === 0) break;
    try {
      process.kill(-group, signal);
    } catch {}
    await waitForEmptyGroup(group, graceMs);
  }
  assert(
    processGroupMembers(group)?.length === 0,
    "opencodex-proxy-exit-unverifiable",
  );
  return { termination: "exited", descendantsExited: true };
}

async function healthProvesPort(port) {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  if (!response.ok) return false;
  const body = await response.json().catch(() => null);
  return body?.status === "ok" && Number(body?.port) === port;
}

/**
 * Starts an owned loopback OpenCodex process and waits for its health endpoint.
 * This never invokes a login command and only terminates the child it started.
 *
 * The port is chosen before the child binds it, so a healthy response alone
 * proves nothing. The proxy is accepted only when its health body names the
 * port and the sole listener on that port is a member of the process group
 * this call created. Any other listener, or a listener that cannot be
 * inspected, is refused. Stopping succeeds only after the whole group is
 * observed gone; otherwise it throws `opencodex-proxy-exit-unverifiable` and
 * the account-home lease stays held, so no later turn reuses that home.
 * @param {object} binding - Runtime prefix and isolated fixed-account homes.
 * @returns {Promise<object>} Receipt with `port`, `pid`, `env`, `ownership` (listener pid and group) and `stop()`, which resolves to the exit proof.
 * @throws {Error} `opencodex-proxy-not-ready` when ownership or health is not proven,
 *   or `opencodex-proxy-exit-unverifiable` when the owned tree cannot be shown to have exited.
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
    "ocx",
  );
  const child = spawn(binary, ["start", "--port", String(port)], {
    cwd: binding.runtimePrefix,
    env: isolatedOpenCodexEnvironment(process.env, env),
    stdio: "ignore",
    shell: false,
    detached: true,
  });
  let exited = false;
  let spawnError = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.once("close", () => {
    exited = true;
  });
  // The lease is released only once the owned group is proven gone.
  let stopping = null;
  const stop = () => {
    stopping ??= (async () => {
      const receipt = child.pid
        ? await stopOwnedProxy(child, binding.stopGraceMs ?? 3000)
        : { termination: "exited", descendantsExited: true };
      lease.release();
      return receipt;
    })();
    return stopping;
  };
  const deadline = Date.now() + (binding.readyTimeoutMs ?? 15000);
  while (Date.now() < deadline) {
    if (spawnError || exited) break;
    try {
      if (await healthProvesPort(port)) {
        const listenerPid = child.pid
          ? ownedListenerPid(port, child.pid)
          : null;
        if (!listenerPid || exited) break;
        return {
          port,
          pid: child.pid ?? null,
          env,
          ownership: {
            method: "sole-listener-in-owned-process-group",
            listenerPid,
            group: child.pid,
          },
          stop,
        };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stop();
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
 * The set also records when it was taken, so a later row can be required to
 * postdate it.
 * @param {object} input - Loopback proxy and account directory.
 * @param {typeof fetch} [fetcher=fetch] - Injectable loopback fetch implementation.
 * @returns {Promise<Set<string> & {capturedAt: number}>} Existing request IDs and capture time.
 */
export async function openCodexHistoryBoundary(input, fetcher = fetch) {
  const entries = await readOpenCodexHistory(input, fetcher);
  const boundary = new Set(
    entries.map((entry) => entry?.requestId).filter(Boolean),
  );
  boundary.capturedAt = Date.now();
  return boundary;
}

function rowTime(entry) {
  const time =
    typeof entry?.timestamp === "number"
      ? entry.timestamp
      : Date.parse(entry?.timestamp);
  return Number.isFinite(time) ? time : null;
}

// Every attempt of a request must itself be a single, first-try success on the
// fixed account. A recovery, a resend or a failed attempt inside a request that
// ended 2xx would hide an account or provider transition this adapter cannot
// prove, so any of them makes the request unowned by the fixed binding.
function attemptsProveFixedAccount(entry, expectedProvider, input) {
  const attempts = entry?.attempts;
  return (
    Array.isArray(attempts) &&
    attempts.length > 0 &&
    attempts.every(
      (attempt, index) =>
        attempt?.ordinal === index + 1 &&
        attempt.accountLogLabel === input.accountLogLabel &&
        attempt.provider === expectedProvider &&
        attempt.model === input.model &&
        Number.isInteger(attempt.status) &&
        attempt.status >= 200 &&
        attempt.status < 300 &&
        attempt.sendCount === 1 &&
        Array.isArray(attempt.recoveryKinds) &&
        attempt.recoveryKinds.length === 0,
    )
  );
}

async function ownedHistoryRows(input, fetcher) {
  const entries = await readOpenCodexHistory(input, fetcher);
  const before = input.historyBoundary ?? new Set();
  return entries.filter((entry) => !before.has(entry?.requestId));
}

/**
 * Reads the caller-owned request-history observation after a boundary.
 * The management token is sent only to loopback and is never returned.
 *
 * A Codex turn may send several upstream requests, so the observation is the
 * whole set of rows created after the boundary. That set is attributed to the
 * caller only because the account home is leased, the proxy is the one this
 * caller started, and every row postdates the boundary read. The set must also
 * be identical on a second read, so a row still being recorded cannot be
 * missed. Each row and each of its attempts must prove the fixed account,
 * provider, model and a 2xx status; any unowned, incomplete, duplicate or
 * unstable row rejects the observation instead of shrinking it.
 * @param {object} input - Loopback proxy and requested binding data.
 * @param {typeof fetch} [fetcher=fetch] - Injectable loopback fetch implementation.
 * @returns {Promise<object>} `requestId`, every `requestIds`, `provider`, `accountLogLabel`, `model`, `usage`, and every owned request and attempt.
 * @throws {Error} `opencodex-binding-unverified` when ownership or any row is not proven.
 */
export async function readOpenCodexObservation(input, fetcher = fetch) {
  const capturedAt = input.historyBoundary?.capturedAt;
  assert(Number.isFinite(capturedAt), "opencodex-binding-unverified");
  const created = await ownedHistoryRows(input, fetcher);
  assert(created.length > 0, "opencodex-binding-unverified");
  const expectedProvider = openCodexProvider(
    input.provider,
    input.accountLogLabel,
  );
  const valid = (entry) => {
    const model = entry?.resolvedModel ?? entry?.model;
    const startedAt = rowTime(entry);
    return (
      typeof entry?.requestId === "string" &&
      startedAt !== null &&
      startedAt >= capturedAt &&
      entry.requestedModel === input.model &&
      model === input.model &&
      entry.provider === expectedProvider &&
      Number.isInteger(entry.status) &&
      entry.status >= 200 &&
      entry.status < 300 &&
      entry.terminalStatus === "completed" &&
      attemptsProveFixedAccount(entry, expectedProvider, input)
    );
  };
  assert(created.every(valid), "opencodex-binding-unverified");
  const ids = created.map((entry) => entry.requestId);
  assert(new Set(ids).size === ids.length, "opencodex-binding-unverified");
  await new Promise((resolve) => setTimeout(resolve, input.settleMs ?? 250));
  const settled = (await ownedHistoryRows(input, fetcher)).map(
    (entry) => entry?.requestId,
  );
  assert(
    settled.length === ids.length && ids.every((id) => settled.includes(id)),
    "opencodex-binding-unverified",
  );
  return {
    requestId: created[0].requestId,
    requestIds: ids,
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
