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

/**
 * Validates a profile's optional OpenCodex runner without changing legacy profile behavior.
 * @param {object} profile - Organization profile.
 * @param {object} activeRuntime - Active runtime identity.
 * @param {string} [profileId] - Organization profile ID (the key of `org.profiles`) named in a rejection message.
 * @returns {{kind: string, mode: string, accountHomeRef: string, runtimeFingerprint: string} | null} Valid runner or null for legacy.
 */
export function validateOpenCodexRunner(profile, activeRuntime, profileId) {
  if (!profile.runner) return null;
  const runner = profile.runner;
  assert(runner.kind === "opencodex", "opencodex-binding-unverified");
  assert(runner.mode === "fixed-account", "opencodex-pool-unverified");
  if (profile.provider !== undefined) {
    assert(
      OPENCODEX_RUNNER_PROVIDERS.includes(profile.provider),
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

// ---- Windows: no process groups, so an owned tree is a (pid, CreationDate) snapshot ----

const system32 = (...parts) =>
  path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", ...parts);

// Runs a PowerShell script from the fixed system directory, never from PATH.
// Null when it cannot run or fails, which proves nothing.
function powershell(script) {
  const result = spawnSync(
    system32("WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 30000 },
  );
  return result.status === 0 ? result.stdout : null;
}

/**
 * Lists Windows processes with the creation time that tells a reused pid from the original.
 * @param {number} [pid] - Only this pid; omitted lists every process.
 * @returns {{pid: number, ppid: number, created: string}[] | null} Rows (`created` is a FILETIME string, too large for a Number), or null when PowerShell cannot answer.
 */
export function windowsProcessTable(pid) {
  const filter = Number.isInteger(pid) ? ` -Filter 'ProcessId=${pid}'` : "";
  const listed = powershell(
    `Get-CimInstance Win32_Process${filter} | ForEach-Object { if ($_.CreationDate) { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc() } }`,
  );
  if (listed === null) return null;
  return listed.split(/\r?\n/).flatMap((line) => {
    const [, id, parent, created] = line.match(/^(\d+) (\d+) (\d+)$/) ?? [];
    return id ? [{ pid: Number(id), ppid: Number(parent), created }] : [];
  });
}

// The pids listening on a loopback port, or null when they cannot be listed.
function windowsListenerPids(port) {
  const listed = powershell(
    `Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }`,
  );
  if (listed === null) return null;
  const pids = listed
    .split(/\r?\n/)
    .filter((line) => /^\d+$/.test(line.trim()));
  return [...new Set(pids.map(Number))];
}

/**
 * Ends a Windows process and every process it started with `taskkill /T /F`.
 * The exit code is not evidence of anything; callers prove the exit themselves.
 * @param {number} pid - Root process id.
 * @returns {void}
 */
export function killWindowsProcessTree(pid) {
  spawnSync(system32("taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
    timeout: 15000,
  });
}

/**
 * Lists the live processes that belong to a Windows proxy tree.
 *
 * A record names the launcher `group`, its `processStart` (CreationDate) when it
 * could be read, `notBefore` (a time before the launcher was spawned), the
 * `snapshot` of `(pid, created)` pairs taken when the proxy was healthy and,
 * once the launcher was seen to exit, `launcherGoneBy` (a time by which it was
 * already gone). A process counts only when its identity is shown:
 * - a snapshot pair whose pid and creation time both match;
 * - the launcher, only when a live process at its pid has the recorded
 *   `processStart`. Without a recorded start, or with another one, the pid is
 *   unproven or reused, and neither it nor its children count;
 * - a child, only when its parent is an owned process that was created before
 *   it. Windows keeps an orphan's parent pid, so a child of a launcher that is
 *   gone counts only if `launcherGoneBy` is recorded and the child was created
 *   between `notBefore` (and the launcher's start, when known) and
 *   `launcherGoneBy`. The launcher's pid could not be reused before that time,
 *   so a stranger that later took the pid never qualifies.
 * @param {{pid: number, ppid: number, created: string}[]} table - Current process table.
 * @param {{group: number, processStart: string | null, notBefore: string, launcherGoneBy?: string, snapshot?: {pid: number, created: string}[]}} record - Recorded proxy tree.
 * @returns {{pid: number, created: string}[]} Live members of the tree.
 */
export function windowsOwnedProcesses(table, record) {
  const notBefore = BigInt(record.notBefore);
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const members = new Map();
  const add = (row) =>
    members.set(row.pid, { pid: row.pid, created: row.created });
  for (const known of record.snapshot ?? []) {
    const row = byPid.get(known.pid);
    if (row?.created === known.created) add(row);
  }
  const root = byPid.get(record.group);
  const start = record.processStart ? BigInt(record.processStart) : null;
  // Each entry is a proven parent: its pid, when it started, and the latest a
  // child of it may have been created (null: no bound, the parent is alive).
  const queue = [];
  if (root) {
    if (start !== null && root.created === record.processStart) {
      add(root);
      queue.push({ pid: root.pid, created: start, until: null });
    }
  } else if (record.launcherGoneBy) {
    queue.push({
      pid: record.group,
      created: start ?? notBefore,
      until: BigInt(record.launcherGoneBy),
    });
  }
  const seen = new Set(queue.map((parent) => parent.pid));
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const row of table) {
      if (row.ppid !== parent.pid || seen.has(row.pid)) continue;
      const created = BigInt(row.created);
      if (created < notBefore || created <= parent.created) continue;
      if (parent.until !== null && created > parent.until) continue;
      seen.add(row.pid);
      add(row);
      queue.push({ pid: row.pid, created, until: null });
    }
  }
  return [...members.values()];
}

/**
 * Tells whether a live process holds the launcher's pid without its identity being shown.
 * That is the case when no start time was recorded and no snapshot pair names
 * it: the process may be ours or a stranger that reused the pid, so it must
 * neither be ended nor be taken for gone.
 * @param {{pid: number, ppid: number, created: string}[]} table - Current process table.
 * @param {object} record - Recorded proxy tree, as for `windowsOwnedProcesses`.
 * @returns {boolean} True when the pid is live and its owner is unproven.
 */
export function windowsRootUnproven(table, record) {
  const root = table.find((row) => row.pid === record.group);
  if (!root || record.processStart) return false;
  return !(record.snapshot ?? []).some(
    (known) => known.pid === root.pid && known.created === root.created,
  );
}

/**
 * Names the one listener that a Windows proxy tree owns.
 *
 * Owned means the port has exactly one listening pid, that pid is a member of
 * the recorded tree, and the health response reported that same pid. Any other
 * listener, none, a listener outside the tree, or a health pid that names
 * another process proves nothing.
 * @param {{pid: number, ppid: number, created: string}[]} table - Current process table.
 * @param {object} record - Recorded proxy tree, as for `windowsOwnedProcesses`.
 * @param {number[]} listeners - Pids listening on the port.
 * @param {number} healthPid - The `pid` the health response reported.
 * @returns {number | null} The owned listener pid, or null when ownership is not proven.
 */
export function windowsOwnedListener(table, record, listeners, healthPid) {
  const [listener] = listeners;
  return listeners.length === 1 &&
    listener === healthPid &&
    windowsOwnedProcesses(table, record).some(
      (member) => member.pid === listener,
    )
    ? listener
    : null;
}

async function waitForWindowsExit(record, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const table = windowsProcessTable();
    if (table && windowsOwnedProcesses(table, record).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Ends a recorded Windows tree and shows that none of it remains. The proof is
// only as strong as the snapshot: a process that started after it and left the
// tree is missed, so the receipt says `exited-snapshot`, never `exited`, and
// `descendantsExited` stays false because a whole tree was not shown empty.
// The tree is recomputed from the process table on every pass, which can only
// add processes to what must be gone, never remove any.
async function terminateWindowsTree(record, graceMs) {
  assert(record?.group, "opencodex-proxy-exit-unverifiable");
  assert(
    /^\d+$/.test(record.notBefore ?? ""),
    "opencodex-proxy-exit-unverifiable",
  );
  for (let pass = 0; pass < 2; pass += 1) {
    const table = windowsProcessTable();
    assert(table, "opencodex-proxy-exit-unverifiable");
    assert(
      !windowsRootUnproven(table, record),
      "opencodex-proxy-exit-unverifiable",
    );
    const members = windowsOwnedProcesses(table, record);
    if (members.length === 0) break;
    for (const member of members) killWindowsProcessTree(member.pid);
    await waitForWindowsExit(record, graceMs);
  }
  const table = windowsProcessTable();
  assert(
    table &&
      !windowsRootUnproven(table, record) &&
      windowsOwnedProcesses(table, record).length === 0,
    "opencodex-proxy-exit-unverifiable",
  );
  return { termination: "exited-snapshot", descendantsExited: false };
}

// A Unix millisecond time as a FILETIME string, the unit of `CreationDate`.
const filetimeAt = (ms) => String((BigInt(ms) + 11644473600000n) * 10000n);

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
  if (process.platform === "win32")
    return windowsProcessTable(pid)?.[0]?.created ?? null;
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

// Ends what is left of a dead owner's Windows proxy tree. False when nothing
// of it is alive; unprovable state throws.
async function endWindowsProxy(record, graceMs) {
  const table = windowsProcessTable();
  assert(table, "opencodex-proxy-exit-unverifiable");
  assert(
    /^\d+$/.test(record.notBefore ?? ""),
    "opencodex-proxy-exit-unverifiable",
  );
  assert(
    !windowsRootUnproven(table, record),
    "opencodex-proxy-exit-unverifiable",
  );
  if (windowsOwnedProcesses(table, record).length === 0) return false;
  await terminateWindowsTree(record, graceMs);
  return true;
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
    if (group && process.platform === "win32") {
      try {
        terminated = await endWindowsProxy(proxy, options.stopGraceMs ?? 3000);
      } catch {
        throw new Error(
          `opencodex-lease-unverifiable: proxy tree ${group} of dead owner ${lease.pid} is not proven gone`,
        );
      }
    } else if (group) {
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
 * once the proxy is spawned its process group (on Windows, its process tree
 * snapshot) is recorded in a file named by the lease's token. A lease whose owner is gone is stale. One reclaimer at a
 * time, holding a mutex keyed to that lease, ends its group with the same
 * emptiness proof a stop needs and takes the home over. The lease is only ever
 * created with a link and removed by its owner or by that reclaimer, so two
 * owners can never hold one home. A live owner, a reclaim in progress, a
 * reclaimer that died, and an unprovable state are different failures.
 * @param {string} accountHome - Fixed-account OpenCodex home.
 * @param {{stopGraceMs?: number, reclaimWaitMs?: number}} [options] - Grace period for ending a dead owner's group and how long to wait for another reclaimer.
 * @returns {Promise<{release: Function, setProxy: (group: number, extra?: object) => object, recovered: object | null}>} Lease receipt; `setProxy` records the proxy.
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
    setProxy(group, extra = {}) {
      const pending = `${proxyFile(file, lease.token)}.pending`;
      const record = {
        group,
        processStart:
          "processStart" in extra
            ? extra.processStart
            : processStartTime(group),
        ...extra,
      };
      fs.writeFileSync(
        pending,
        JSON.stringify({ token: lease.token, pid: process.pid, ...record }),
        { mode: 0o600 },
      );
      fs.renameSync(pending, proxyFile(file, lease.token));
      return record;
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

// The health body when it names this port, otherwise null.
async function healthProvesPort(port) {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  return body?.status === "ok" && Number(body?.port) === port ? body : null;
}

/**
 * Names the executable and leading arguments that start OpenCodex from a runtime prefix.
 * On Windows this is this Node binary running the package's `bin/ocx.mjs`: an
 * npm `.cmd` shim cannot be spawned without a shell and would put a `cmd.exe`
 * layer into the process tree.
 * @param {string} runtimePrefix - Directory holding the runtime's `node_modules`.
 * @returns {{command: string, args: string[]}} What to spawn, before OpenCodex's own arguments.
 */
export function openCodexLaunch(runtimePrefix) {
  const modules = path.join(runtimePrefix, "node_modules");
  return process.platform === "win32"
    ? {
        command: process.execPath,
        args: [path.join(modules, "@bitkyc08", "opencodex", "bin", "ocx.mjs")],
      }
    : { command: path.join(modules, ".bin", "ocx"), args: [] };
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
 *
 * Windows has no process groups. There the launcher is this Node binary running
 * `bin/ocx.mjs`, and ownership needs three matching facts: exactly one
 * listener, that listener in the `(pid, CreationDate)` snapshot of the
 * launcher's tree, and the health body's `pid` equal to it. Stopping ends every
 * snapshot process with `taskkill /T /F` and passes once none of them is left,
 * but a process that started after the snapshot and left the tree is missed. It
 * resolves to `termination: "exited-snapshot"` with `descendantsExited: false`,
 * which never satisfies the `"exited"` a proven runner turn requires.
 * @param {object} binding - Runtime prefix and isolated fixed-account homes.
 * @returns {Promise<object>} Receipt with `port`, `pid`, `env`, `ownership` (listener pid and group, plus the snapshot on Windows) and `stop()`, which resolves to the exit proof.
 * @throws {Error} `opencodex-proxy-not-ready` when ownership or health is not proven,
 *   or `opencodex-proxy-exit-unverifiable` when the owned tree cannot be shown to have exited.
 */
export async function startOpenCodexProxy(binding) {
  const env = openCodexEnvironment(binding);
  const windows = process.platform === "win32";
  const lease = await acquireOpenCodexLease(binding.accountHome, {
    stopGraceMs: binding.stopGraceMs,
    reclaimWaitMs: binding.reclaimWaitMs,
  });
  let port;
  let child;
  let notBefore;
  let tree;
  try {
    port = await unusedPort();
    // The proxy child gets a private HOME so a start-time hook or roster sync
    // cannot reach the user's shell profile or ~/.claude even if a guard is
    // missing; the account home already refuses configs that enable them.
    const proxyHome = path.join(binding.accountHome, ".omt-proxy-home");
    fs.mkdirSync(proxyHome, { recursive: true, mode: 0o700 });
    const launch = openCodexLaunch(binding.runtimePrefix);
    // Nothing of this tree can predate the spawn; the margin absorbs clock skew.
    notBefore = filetimeAt(Date.now() - 2000);
    child = spawn(
      launch.command,
      [...launch.args, "start", "--port", String(port)],
      {
        cwd: binding.runtimePrefix,
        env: {
          ...isolatedOpenCodexEnvironment(process.env, env),
          HOME: proxyHome,
          ...(windows && {
            USERPROFILE: proxyHome,
            HOMEDRIVE: path.parse(proxyHome).root,
            HOMEPATH: path.relative(path.parse(proxyHome).root, proxyHome),
          }),
        },
        stdio: "ignore",
        shell: false,
        detached: !windows,
      },
    );
    if (child.pid)
      tree = lease.setProxy(child.pid, windows ? { notBefore } : {});
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
  // Our own handle keeps the launcher's pid from being reused until this event,
  // so a child of that pid created before now is the launcher's, not a stranger's.
  child.once("exit", () => {
    if (!windows || !tree) return;
    try {
      tree = lease.setProxy(child.pid, {
        ...tree,
        launcherGoneBy: filetimeAt(Date.now()),
      });
    } catch {
      // Without the bound, fewer processes count as owned, never more.
    }
  });
  // While that handle holds the pid, only the launcher can own it, so its start
  // time may be read from the process table when the spawn-time read failed.
  const withStart = (record, rows) => {
    const row = rows?.find((item) => item.pid === child.pid);
    return record.processStart ||
      record.launcherGoneBy ||
      !row ||
      BigInt(row.created) < BigInt(record.notBefore)
      ? record
      : { ...record, processStart: row.created };
  };
  // The lease is released only once the owned group is proven gone.
  let stopping = null;
  const stop = () => {
    stopping ??= (async () => {
      const graceMs = binding.stopGraceMs ?? 3000;
      if (windows && child.pid) {
        const filled = withStart(tree, windowsProcessTable(child.pid));
        if (filled !== tree) tree = lease.setProxy(child.pid, filled);
      }
      const receipt = !child.pid
        ? { termination: "exited", descendantsExited: true }
        : windows
          ? await terminateWindowsTree(tree, graceMs)
          : await terminateGroup(child.pid, graceMs);
      lease.release();
      return receipt;
    })();
    return stopping;
  };
  const deadline = Date.now() + (binding.readyTimeoutMs ?? 15000);
  while (Date.now() < deadline) {
    if (spawnError || exited) break;
    try {
      const health = await healthProvesPort(port);
      if (health) {
        let listenerPid = null;
        let method = "sole-listener-in-owned-process-group";
        let snapshot;
        if (windows && child.pid) {
          method = "sole-listener-in-owned-process-tree-snapshot";
          const table = windowsProcessTable();
          const listeners = windowsListenerPids(port);
          if (table && listeners) {
            tree = withStart(tree, table);
            listenerPid = windowsOwnedListener(
              table,
              tree,
              listeners,
              Number(health.pid),
            );
            snapshot = windowsOwnedProcesses(table, tree);
          }
        } else if (child.pid) {
          listenerPid = ownedListenerPid(port, child.pid);
        }
        if (!listenerPid || exited) break;
        if (snapshot) tree = lease.setProxy(child.pid, { ...tree, snapshot });
        return {
          port,
          pid: child.pid ?? null,
          env,
          ownership: {
            method,
            listenerPid,
            group: child.pid,
            ...(snapshot && { snapshot }),
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
 * @param {string} [profileId] - Organization profile ID named in a rejection message.
 * @returns {object} Secret-free fixed-account binding.
 */
export function resolveOpenCodexBinding(
  profile,
  runtime,
  environment = process.env,
  profileId,
) {
  const runner = validateOpenCodexRunner(profile, runtime, profileId);
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
