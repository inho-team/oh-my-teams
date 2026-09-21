/** Fail-closed OpenCodex fixed-account runner binding validation. */
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { assert } from "./core.mjs";

/**
 * Providers that support OpenCodex fixed-account runner binding.
 * @type {string[]}
 */
export const OPENCODEX_RUNNER_PROVIDERS = Object.freeze(["codex"]);

// Logical providers that run on a subscription OAuth account, with the
// provider name OpenCodex stores their account under and prefixes their models
// with. Codex (OpenAI) is not listed: its home and its model names are unchanged.
const OAUTH_PROVIDERS = Object.freeze({
  claude: "anthropic",
  agy: "google-antigravity",
});

/**
 * Returns the model an OpenCodex request history records for a profile model.
 * A model carrying its own provider's prefix is recorded without it; any other
 * model, and every Codex model, is recorded as written.
 * @param {string | undefined} provider - OMT logical provider identifier.
 * @param {string} model - Profile model `M`.
 * @returns {string} `strip(M)`.
 */
export function stripOpenCodexModelPrefix(provider, model) {
  const prefix = OAUTH_PROVIDERS[provider];
  return prefix && model.startsWith(`${prefix}/`)
    ? model.slice(prefix.length + 1)
    : model;
}

/**
 * Validates a profile's optional OpenCodex runner without changing legacy profile behavior.
 * @param {object} profile - Organization profile.
 * @param {object} activeRuntime - Active runtime identity.
 * @param {string} [profileId] - Organization profile ID (the key of `org.profiles`) named in a rejection message.
 * @param {readonly string[]} [supportedProviders] - Providers that may hold a runner; tests inject a list, callers use the exported one.
 * @returns {{kind: string, mode: string, accountHomeRef: string, runtimeFingerprint: string} | null} Valid runner or null for legacy.
 */
export function validateOpenCodexRunner(
  profile,
  activeRuntime,
  profileId,
  supportedProviders = OPENCODEX_RUNNER_PROVIDERS,
) {
  if (!profile.runner) return null;
  const runner = profile.runner;
  assert(runner.kind === "opencodex", "opencodex-binding-unverified");
  assert(runner.mode === "fixed-account", "opencodex-pool-unverified");
  if (profile.provider !== undefined) {
    assert(
      supportedProviders.includes(profile.provider),
      `Invalid OpenCodex runner binding: ${profileId ?? "(unknown)"} (provider ${profile.provider} does not support runners)`,
    );
  }
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
  // A prefix naming another provider would send the turn to that provider's
  // account, so it is refused before any turn starts.
  assert(
    !OAUTH_PROVIDERS[profile.provider] ||
      !Object.entries(OAUTH_PROVIDERS).some(
        ([logical, prefix]) =>
          logical !== profile.provider &&
          profile.model.startsWith(`${prefix}/`),
      ),
    "opencodex-binding-unverified: model prefix names another provider",
  );
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
  // `ocx start` can otherwise set a global macOS environment variable, install
  // a shell hook and rewrite the Claude agent roster. The runtime health-check
  // home turns these off, so a fixed-account home must too, or it is refused.
  const claudeCode = config.claudeCode;
  const guards = {
    runtimeRole: config.runtimeRole === "hub",
    "claudeCode.integration":
      claudeCode?.enabled === false ||
      (claudeCode?.systemEnv === false && claudeCode?.injectAgents === false),
  };
  const missing = Object.keys(guards).filter((name) => !guards[name]);
  assert(
    missing.length === 0,
    `opencodex-global-change-blocked: account home lacks ${missing.join(", ")}`,
  );
  return { provider: "openai", accountLogLabel };
}

const digest6 = (text) =>
  crypto.createHash("sha256").update(text).digest("hex").slice(0, 6);

/**
 * Computes the secret-free label OpenCodex records for an OAuth account.
 * Only the label is returned; the account id is never printed or stored.
 * @param {string} provider - `anthropic` or `google-antigravity`.
 * @param {string} accountId - Account id from `auth.json`.
 * @returns {string} `anthropic-p<hex6>` (the provider suffix) or `o<hex6>` (the attempt label).
 */
export function openCodexAccountLabel(provider, accountId) {
  return provider === "anthropic"
    ? `anthropic-p${digest6(accountId)}`
    : `o${digest6(`${provider}\0${accountId}`)}`;
}

function readHomeJson(accountHome, name) {
  const file = path.join(accountHome, name);
  assert(fs.existsSync(file), "opencodex-binding-unverified");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("opencodex-binding-unverified");
  }
}

// Absent, null, empty text, an empty list or an empty object.
const isEmpty = (value) =>
  value === undefined ||
  value === null ||
  value === "" ||
  (typeof value === "object" && Object.keys(value).length === 0);

/**
 * Verifies that a Claude or Antigravity account home holds exactly one OAuth
 * account and offers OpenCodex no other account, provider or key to route to.
 * Credential contents and account ids are never returned or persisted.
 * @param {string} accountHome - Isolated OpenCodex account directory.
 * @param {string} provider - `anthropic` or `google-antigravity`.
 * @param {string} [expectedLabel] - Label the profile names; when given it must equal the label computed from the account id.
 * @returns {{provider: string, accountLogLabel: string}} Fixed account proof with the computed label.
 */
export function validateFixedOpenCodexOAuthHome(
  accountHome,
  provider,
  expectedLabel,
) {
  assert(
    Object.values(OAUTH_PROVIDERS).includes(provider),
    "opencodex-binding-unverified",
  );
  const auth = readHomeJson(accountHome, "auth.json");
  const config = readHomeJson(accountHome, "config.json");
  const entry = auth[provider];
  const accounts = entry?.accounts;
  const account = accounts?.[0];
  // 1. Exactly one account, and it is the active one.
  assert(
    Array.isArray(accounts) &&
      accounts.length === 1 &&
      typeof account?.id === "string" &&
      account.id !== "" &&
      entry.activeAccountId === account.id,
    "opencodex-binding-unverified",
  );
  // 2. No other provider's account and no Codex pool a route could fall to.
  const storeFile = path.join(accountHome, "codex-accounts.json");
  assert(
    Object.keys(auth).every(
      (name) => name === provider || isEmpty(auth[name]?.accounts),
    ) &&
      isEmpty(config.codexAccounts) &&
      (!fs.existsSync(storeFile) ||
        isEmpty(readHomeJson(accountHome, "codex-accounts.json"))),
    "opencodex-binding-unverified",
  );
  // 3. A subscription login that does not need to sign in again.
  assert(
    account.credential?.source === "oauth" && !account.needsReauth,
    "opencodex-binding-unverified",
  );
  // 4. No combo and no API key entry: a bare model name could reach a key route.
  const configured = Object.values(config.providers ?? {});
  assert(
    isEmpty(config.combos) &&
      configured.every((item) =>
        Object.keys(item ?? {}).every(
          (key) => !/^apiKey/i.test(key) || isEmpty(item[key]),
        ),
      ),
    "opencodex-binding-unverified",
  );
  // 5. Routing: the target is the OAuth default and OpenAI is not active.
  const target = config.providers?.[provider];
  assert(
    target?.authMode === "oauth" &&
      target.disabled !== true &&
      config.defaultProvider === provider &&
      (config.providers.openai === undefined ||
        config.providers.openai.disabled === true),
    "opencodex-binding-unverified",
  );
  // 6. Anthropic keeps the pool switch on and nothing else about it.
  if (provider === "anthropic") {
    const pool = config.anthropicAccountPool;
    assert(
      pool?.enabled === true &&
        typeof pool === "object" &&
        Object.keys(pool).length === 1,
      "opencodex-pool-unverified",
    );
  }
  // 7. Antigravity has no generic account failover setting.
  assert(
    provider !== "google-antigravity" ||
      config.oauthAccountFailover === undefined,
    "opencodex-pool-unverified",
  );
  // 8. Starting the proxy must not change anything outside this home.
  const claudeCode = config.claudeCode;
  const guards = {
    runtimeRole: config.runtimeRole === "hub",
    "clientIntegrations.codex": config.clientIntegrations?.codex === false,
    "claudeCode.integration":
      claudeCode?.enabled === false ||
      (claudeCode?.systemEnv === false && claudeCode?.injectAgents === false),
  };
  const missing = Object.keys(guards).filter((name) => !guards[name]);
  assert(
    missing.length === 0,
    `opencodex-global-change-blocked: account home lacks ${missing.join(", ")}`,
  );
  // 9. The label the profile names is the one this account's id produces.
  const accountLogLabel = openCodexAccountLabel(provider, account.id);
  assert(
    expectedLabel === undefined || expectedLabel === accountLogLabel,
    "opencodex-binding-unverified",
  );
  return { provider, accountLogLabel };
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

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// The kernel's start time of a process, which tells a reused pid from the
// original. Null when it cannot be read.
function processStartTime(pid) {
  if (process.platform === "win32") return null;
  const listed = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
  });
  const started = listed.status === 0 ? listed.stdout.trim() : "";
  return started || null;
}

async function waitForEmptyGroup(group, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processGroupMembers(group)?.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Ends every member of a process group, not only its leader. A launcher that
// exited while a descendant kept running is still a live tree, so this never
// trusts the leader's exit; it passes only when the group is observed empty.
async function terminateGroup(group, graceMs) {
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

const LEASE_FILE = ".omt-opencodex-turn.lock";

function readRecord(file) {
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    return Number.isInteger(record?.pid) && typeof record.token === "string"
      ? record
      : null;
  } catch {
    return null;
  }
}

// Writes a record through a private file and publishes it with a link, so a
// reader never sees a half-written record and only one writer can create it.
function publishRecord(file, record) {
  const pending = `${file}.${process.pid}.${record.token}`;
  fs.writeFileSync(pending, JSON.stringify(record), { mode: 0o600 });
  try {
    fs.linkSync(pending, file);
  } finally {
    fs.rmSync(pending, { force: true });
  }
}

// Whether the process that wrote a record is still the one that wrote it. A
// missing start time on either side cannot show a reused pid, so a live pid
// then counts as the owner.
function recordOwnerLive(record) {
  if (!processAlive(record.pid)) return false;
  const started = processStartTime(record.pid);
  return (
    record.processStart === null ||
    started === null ||
    started === record.processStart
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The proxy group is recorded beside the lease under the lease's own token, so
// the lease file itself is never rewritten after it is published.
const proxyFile = (file, token) => `${file}.proxy.${token}`;
const reclaimFile = (file, token) => `${file}.reclaim.${token}`;

// One reclaimer at a time may take over a given stale lease. The mutex is named
// after that lease's token, so a mutex left behind by a dead reclaimer can only
// ever block that same lease, never a later one. It is never broken
// automatically: two breakers cannot be told apart from a live holder, and a
// wrongly broken mutex would let two reclaimers both take the home.
async function takeReclaimMutex(file, token, waitMs) {
  const mutex = reclaimFile(file, token);
  const record = {
    token: crypto.randomUUID(),
    pid: process.pid,
    processStart: processStartTime(process.pid),
  };
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      publishRecord(mutex, record);
      return () => {
        if (readRecord(mutex)?.token === record.token)
          fs.rmSync(mutex, { force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const holder = readRecord(mutex);
    // The holder may have released between the failed link and this read.
    if (!holder && !fs.existsSync(mutex)) continue;
    if (!holder || !recordOwnerLive(holder)) {
      // A holder that released and exited, or a new holder that took the
      // mutex after the read, is not a dead reclaimer: judge the file again.
      const again = readRecord(mutex);
      if (again?.token !== holder?.token) continue;
      if (!again && !fs.existsSync(mutex)) continue;
      throw new Error(
        `opencodex-lease-reclaim-stuck: a reclaimer that is gone left ${mutex}; ` +
          "remove it by hand once no process is reclaiming this home",
      );
    }
    if (Date.now() >= deadline)
      throw new Error(
        `opencodex-lease-held: pid ${holder.pid} is reclaiming this account home`,
      );
    await sleep(25);
  }
}

// Decides what an existing lease means and, when its owner is dead, takes it
// over. A live owner keeps the home. The dead owner's proxy group is ended with
// the same emptiness proof a stop needs, and only then is the lease removed;
// anything unprovable keeps it. The lease is read again under the reclaim
// mutex and removed only if it is still the record that was judged stale.
async function reclaimStaleLease(file, options) {
  const seen = readRecord(file);
  if (!seen) {
    // Absent means someone finished first; unreadable proves nothing.
    if (!fs.existsSync(file)) return { recovered: null };
    throw new Error("opencodex-lease-unverifiable: unreadable owner record");
  }
  if (recordOwnerLive(seen))
    throw new Error(
      `opencodex-lease-held: pid ${seen.pid} owns this account home`,
    );
  const release = await takeReclaimMutex(
    file,
    seen.token,
    options.reclaimWaitMs ?? 5000,
  );
  try {
    const lease = readRecord(file);
    // Gone or replaced while waiting: the caller judges what is there now.
    if (lease?.token !== seen.token) return { recovered: null };
    if (recordOwnerLive(lease))
      throw new Error(
        `opencodex-lease-held: pid ${lease.pid} owns this account home`,
      );
    const proxy = readRecord(proxyFile(file, lease.token));
    const group = proxy?.group ?? null;
    let terminated = false;
    if (group) {
      // A live leader with another start time means the group id was reused,
      // so the recorded group is already empty; anything else in it is not ours.
      const leaderStart = processAlive(group) ? processStartTime(group) : null;
      const reused =
        processAlive(group) &&
        proxy.processStart !== null &&
        leaderStart !== null &&
        leaderStart !== proxy.processStart;
      if (!reused && processGroupMembers(group)?.length !== 0) {
        try {
          await terminateGroup(group, options.stopGraceMs ?? 3000);
        } catch {
          throw new Error(
            `opencodex-lease-unverifiable: proxy group ${group} of dead owner ${lease.pid} is not proven gone`,
          );
        }
        terminated = true;
      }
    }
    if (readRecord(file)?.token === lease.token)
      fs.rmSync(file, { force: true });
    fs.rmSync(proxyFile(file, lease.token), { force: true });
    return { recovered: { owner: lease.pid, group, terminated } };
  } finally {
    release();
  }
}

/**
 * Acquires the account-home lease that makes a request-history boundary exclusive.
 *
 * The lease records its owner's pid and start time and is never rewritten;
 * once the proxy is spawned its process group is recorded in a file named by
 * the lease's token. A lease whose owner is gone is stale. One reclaimer at a
 * time, holding a mutex keyed to that lease, ends its group with the same
 * emptiness proof a stop needs and takes the home over. The lease is only ever
 * created with a link and removed by its owner or by that reclaimer, so two
 * owners can never hold one home. A live owner, a reclaim in progress, a
 * reclaimer that died, and an unprovable state are different failures.
 * @param {string} accountHome - Fixed-account OpenCodex home.
 * @param {{stopGraceMs?: number, reclaimWaitMs?: number}} [options] - Grace period for ending a dead owner's group and how long to wait for another reclaimer.
 * @returns {Promise<{release: () => void, setProxy: (group: number) => void, recovered: object | null}>} Lease receipt.
 * @throws {Error} `opencodex-lease-held` for a live owner or a reclaim in progress.
 * @throws {Error} `opencodex-lease-reclaim-stuck` when a dead reclaimer left its mutex.
 * @throws {Error} `opencodex-lease-unverifiable` when a dead owner's state cannot be proven clean.
 */
export async function acquireOpenCodexLease(accountHome, options = {}) {
  const file = path.join(accountHome, LEASE_FILE);
  const lease = {
    token: crypto.randomUUID(),
    pid: process.pid,
    processStart: processStartTime(process.pid),
    acquiredAt: new Date().toISOString(),
  };
  let recovered = null;
  for (let attempt = 0; ; attempt += 1) {
    try {
      publishRecord(file, lease);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (attempt >= 5)
        throw new Error("opencodex-lease-held: lease kept changing hands");
      const result = await reclaimStaleLease(file, options);
      recovered = result.recovered ?? recovered;
    }
  }
  let released = false;
  return {
    recovered,
    setProxy(group) {
      const pending = `${proxyFile(file, lease.token)}.pending`;
      fs.writeFileSync(
        pending,
        JSON.stringify({
          token: lease.token,
          pid: process.pid,
          group,
          processStart: processStartTime(group),
        }),
        { mode: 0o600 },
      );
      fs.renameSync(pending, proxyFile(file, lease.token));
    },
    release() {
      if (released) return;
      released = true;
      // Never remove a lease another owner has since taken over.
      if (readRecord(file)?.token === lease.token)
        fs.rmSync(file, { force: true });
      fs.rmSync(proxyFile(file, lease.token), { force: true });
    },
  };
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
 * the account-home lease stays held. The lease names its owner and proxy
 * group, so once that owner is dead a later turn ends the group with the same
 * proof and takes the home over, while a live owner is refused.
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
  const lease = await acquireOpenCodexLease(binding.accountHome, {
    stopGraceMs: binding.stopGraceMs,
    reclaimWaitMs: binding.reclaimWaitMs,
  });
  let port;
  let child;
  try {
    port = await unusedPort();
    // The proxy child gets a private HOME so a start-time hook or roster sync
    // cannot reach the user's shell profile or ~/.claude even if a guard is
    // missing; the account home already refuses configs that enable them.
    const proxyHome = path.join(binding.accountHome, ".omt-proxy-home");
    fs.mkdirSync(proxyHome, { recursive: true, mode: 0o700 });
    child = spawn(
      path.join(binding.runtimePrefix, "node_modules", ".bin", "ocx"),
      ["start", "--port", String(port)],
      {
        cwd: binding.runtimePrefix,
        env: {
          ...isolatedOpenCodexEnvironment(process.env, env),
          HOME: proxyHome,
        },
        stdio: "ignore",
        shell: false,
        detached: true,
      },
    );
    if (child.pid) lease.setProxy(child.pid);
  } catch (error) {
    lease.release();
    throw error;
  }
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
        ? await terminateGroup(child.pid, binding.stopGraceMs ?? 3000)
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

// The label an OAuth profile names: the provider suffix for Claude, the
// attempt label for Antigravity.
const OAUTH_LABEL_PATTERN = Object.freeze({
  claude: /^anthropic-p[a-f0-9]{6}$/,
  agy: /^o[a-f0-9]{6}$/,
});

/**
 * Returns the provider name recorded by OpenCodex for an OMT logical provider.
 * A Claude profile with its account label is recorded under that label, which
 * is the `anthropic-p<hex6>` suffix the account pool adds to the provider.
 * @param {string} provider - OMT logical provider identifier.
 * @param {string} [accountLogLabel] - Account label of the fixed-account binding.
 * @returns {string} OpenCodex request-history provider identifier.
 */
export function openCodexProvider(provider, accountLogLabel) {
  if (provider === "claude" && accountLogLabel) return accountLogLabel;
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
// prove, so any of them makes the request unowned by the fixed binding. A
// Claude attempt carries no account label; its account is proved by the
// provider suffix, which every attempt must equal.
function attemptsProveFixedAccount(entry, expectedProvider, input, model) {
  const attempts = entry?.attempts;
  return (
    Array.isArray(attempts) &&
    attempts.length > 0 &&
    attempts.every(
      (attempt, index) =>
        attempt?.ordinal === index + 1 &&
        (input.provider === "claude" ||
          attempt.accountLogLabel === input.accountLogLabel) &&
        attempt.provider === expectedProvider &&
        attempt.model === model &&
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
 * @returns {Promise<object>} `requestId`, every `requestIds`, `provider`,
 * `accountLogLabel`, `model` (the profile model), `resolvedModel` (the model
 * the history recorded), `usage`, and every owned request and attempt.
 * @throws {Error} `opencodex-binding-unverified` when ownership or any row is not proven.
 */
export async function readOpenCodexObservation(input, fetcher = fetch) {
  const capturedAt = input.historyBoundary?.capturedAt;
  assert(Number.isFinite(capturedAt), "opencodex-binding-unverified");
  assert(
    !OAUTH_LABEL_PATTERN[input.provider] ||
      OAUTH_LABEL_PATTERN[input.provider].test(input.accountLogLabel),
    "opencodex-binding-unverified",
  );
  const created = await ownedHistoryRows(input, fetcher);
  assert(created.length > 0, "opencodex-binding-unverified");
  const expectedProvider = openCodexProvider(
    input.provider,
    input.accountLogLabel,
  );
  // The history records a prefixed model without its prefix, so the executed
  // model is compared with `strip(M)` while the request is compared with `M`.
  const executedModel = stripOpenCodexModelPrefix(input.provider, input.model);
  const valid = (entry) => {
    const model = entry?.resolvedModel ?? entry?.model;
    const startedAt = rowTime(entry);
    return (
      typeof entry?.requestId === "string" &&
      startedAt !== null &&
      startedAt >= capturedAt &&
      entry.requestedModel === input.model &&
      model === executedModel &&
      entry.provider === expectedProvider &&
      Number.isInteger(entry.status) &&
      entry.status >= 200 &&
      entry.status < 300 &&
      entry.terminalStatus === "completed" &&
      attemptsProveFixedAccount(entry, expectedProvider, input, executedModel)
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
    // `model` stays the profile model `M`: the consumers compare it with the
    // profile, so returning `strip(M)` would refuse every prefixed turn.
    model: input.model,
    resolvedModel: executedModel,
    usage: created.length === 1 ? (created[0].usage ?? null) : null,
    attempts: created.flatMap((entry) => entry.attempts),
    requests: created,
  };
}

const openCodexRefKey = (ref) => ref.toUpperCase().replace(/[^A-Z0-9]/g, "_");

// Claude and Antigravity profiles take only their own account's session home.
// An OpenAI profile keeps the single shared variable as its fallback.
function openCodexSessionHome(profile, environment) {
  const key = openCodexRefKey(profile.runner.accountHomeRef);
  const own = environment[`OMT_OPENCODEX_${key}_SESSION_HOME`];
  return OAUTH_PROVIDERS[profile.provider]
    ? own
    : own || environment.OMT_OPENCODEX_SESSION_HOME;
}

/**
 * Checks that the runner accounts of one run keep their homes apart: no two
 * accounts share a session home, and no session home is any account's home.
 * Accounts whose homes are not configured are skipped; binding refuses them.
 * @param {object[]} profiles - Profiles the run uses; those without a runner are ignored.
 * @param {NodeJS.ProcessEnv} [environment=process.env] - Explicit caller configuration.
 * @returns {void}
 * @throws {Error} `opencodex-binding-unverified` when session homes overlap each other or an account home.
 */
export function assertDistinctOpenCodexHomes(
  profiles,
  environment = process.env,
) {
  const accounts = new Map();
  for (const profile of profiles) {
    const ref = profile?.runner?.accountHomeRef;
    if (typeof ref !== "string" || accounts.has(ref)) continue;
    const home = environment[`OMT_OPENCODEX_${openCodexRefKey(ref)}_HOME`];
    const session = openCodexSessionHome(profile, environment);
    accounts.set(ref, {
      home: home && path.resolve(home),
      session: session && path.resolve(session),
    });
  }
  const homes = [...accounts.values()].map((item) => item.home);
  const sessions = [...accounts.values()]
    .map((item) => item.session)
    .filter(Boolean);
  assert(
    new Set(sessions).size === sessions.length &&
      sessions.every((session) => !homes.includes(session)),
    "opencodex-binding-unverified: session homes must differ from each other and from every account home",
  );
}

/**
 * Resolves a named fixed-account binding from explicit process environment references.
 * @param {object} profile - Organization profile with an OpenCodex runner.
 * @param {object} runtime - Active runtime diagnosis result.
 * @param {NodeJS.ProcessEnv} [environment=process.env] - Explicit caller configuration.
 * @param {string} [profileId] - Organization profile ID named in a rejection message.
 * @param {readonly string[]} [supportedProviders] - Providers that may hold a runner; tests inject a list, callers use the exported one.
 * @returns {object} Secret-free fixed-account binding.
 */
export function resolveOpenCodexBinding(
  profile,
  runtime,
  environment = process.env,
  profileId,
  supportedProviders = OPENCODEX_RUNNER_PROVIDERS,
) {
  const runner = validateOpenCodexRunner(
    profile,
    runtime,
    profileId,
    supportedProviders,
  );
  if (!runner) return null;
  const key = openCodexRefKey(runner.accountHomeRef);
  const accountHome = environment[`OMT_OPENCODEX_${key}_HOME`];
  const accountLogLabel = environment[`OMT_OPENCODEX_${key}_LABEL`];
  const sessionHome = openCodexSessionHome(profile, environment);
  assert(
    accountHome && accountLogLabel && sessionHome,
    "opencodex-action-required: configure named account home, label and session home",
  );
  if (OAUTH_PROVIDERS[profile.provider]) {
    validateFixedOpenCodexOAuthHome(
      accountHome,
      OAUTH_PROVIDERS[profile.provider],
      accountLogLabel,
    );
  } else {
    validateFixedOpenCodexAccountHome(accountHome, accountLogLabel);
  }
  return {
    accountHome,
    accountLogLabel,
    sessionHome,
    runtimePrefix: runtime.runtimePrefix,
  };
}
