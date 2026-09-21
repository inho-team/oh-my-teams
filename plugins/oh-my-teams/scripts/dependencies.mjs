/** Owned, atomic installation and read-only diagnosis for the OpenCodex runtime. */
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  ownerHasExited,
  run,
  withAsyncFileLock,
  writeJSON,
} from "./core.mjs";
import { discoverOrcaRuntime } from "./orca-adapter.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, "..");
const MANIFEST = path.join(PACKAGE_DIR, "package.json");
const LOCKFILE = path.join(PACKAGE_DIR, "package-lock.json");
const CATALOG = path.join(
  PACKAGE_DIR,
  "resources",
  "runtime-dependencies.json",
);
const MINIMUM_NODE = [22, 13, 0];
const OPENCODEX_PACKAGE = "@bitkyc08/opencodex";
// The catalog capability that only checks tied to an OpenCodex turn may block.
const BACKEND_CAPABILITY = "opencodex-backend";

/**
 * Compares a Node version string with the catalog's minimum supported runtime.
 * @param {string} version - Node `--version` output.
 * @returns {boolean} Whether the version meets Node 22.13.0.
 */
export function supportedNode(version) {
  const found = String(version)
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!found) return false;
  const actual = found.slice(1).map(Number);
  return (
    actual.some(
      (part, index) =>
        part !== MINIMUM_NODE[index] &&
        actual
          .slice(0, index)
          .every((prior, priorIndex) => prior === MINIMUM_NODE[priorIndex]) &&
        part > MINIMUM_NODE[index],
    ) || actual.every((part, index) => part === MINIMUM_NODE[index])
  );
}

/**
 * Reads the pinned OpenCodex identity from package.json and its lockfile, the only sources of the version.
 * @returns {{version: string, fingerprint: string, manifest: Buffer, lockfile: Buffer}} OpenCodex package identity.
 * @throws {Error} When the dependency is not an exact version or the lockfile resolves a different one.
 */
export function runtimeIdentity() {
  const manifest = fs.readFileSync(MANIFEST);
  const lockfile = fs.readFileSync(LOCKFILE);
  const version = JSON.parse(manifest).dependencies?.[OPENCODEX_PACKAGE];
  assert(
    /^\d+\.\d+\.\d+$/.test(version ?? ""),
    "OpenCodex dependency must be exactly pinned in package.json",
  );
  const locked = JSON.parse(lockfile).packages ?? {};
  assert(
    locked[""]?.dependencies?.[OPENCODEX_PACKAGE] === version &&
      locked[`node_modules/${OPENCODEX_PACKAGE}`]?.version === version,
    "OpenCodex version in package-lock.json does not match package.json",
  );
  return {
    version,
    fingerprint: `sha256:${crypto.createHash("sha256").update(manifest).update(lockfile).digest("hex")}`,
    manifest,
    lockfile,
  };
}

/** @param {string} root - Owned runtime root. @returns {object} Runtime paths. */
export function runtimePaths(root) {
  const identity = runtimeIdentity();
  const fingerprint = identity.fingerprint.slice("sha256:".length);
  const base = path.resolve(root, "opencodex");
  return {
    ...identity,
    base,
    active: path.join(base, "active.json"),
    lock: path.join(base, "locks", `${fingerprint}.lock`),
    runtime: path.join(base, "runtimes", fingerprint),
  };
}

function check(id, status, evidence, requiredFor) {
  return requiredFor
    ? { id, status, evidence, requiredFor }
    : { id, status, evidence };
}

async function catalogChecks() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8")).dependencies;
  const platform = process.platform === "win32" ? "windows" : "macos";
  const checks = [];
  for (const dependency of catalog) {
    if (
      !dependency.platforms?.includes(platform) ||
      dependency.id === "opencodex"
    )
      continue;
    // Every result carries the capabilities its dependency is required for,
    // so a failure only blocks what actually needs it.
    const add = (item) =>
      checks.push({ ...item, requiredFor: dependency.requiredFor ?? [] });
    const command = dependency.detect?.command?.argv;
    if (dependency.id === "orca-cli" || dependency.id === "orca-desktop") {
      try {
        const runtime = await discoverOrcaRuntime();
        const status = await run([runtime.executable, "status", "--json"], {
          timeoutMs: 10000,
        });
        let desktop = false;
        try {
          desktop = JSON.parse(status.stdout).result?.app?.running === true;
        } catch {}
        add(
          check(
            dependency.id,
            dependency.id === "orca-desktop" && !desktop ? "fail" : "pass",
            dependency.id === "orca-desktop" && !desktop
              ? dependency.install?.[platform]
              : runtime.executable,
          ),
        );
      } catch {
        add(check(dependency.id, "fail", dependency.install?.[platform]));
      }
      continue;
    }
    if (!command) continue;
    const result = await run(command, { timeoutMs: 10000 });
    add(
      check(
        dependency.id,
        result.code === 0 && !result.timedOut ? "pass" : "fail",
        result.code === 0 && !result.timedOut
          ? result.stdout.trim()
          : (dependency.install?.[platform] ??
              "See the catalog repair guidance."),
      ),
    );
    for (const feature of dependency.detect?.featureChecks ?? []) {
      const featureResult = await run(feature.argv, { timeoutMs: 10000 });
      add(
        check(
          `${dependency.id}:${feature.argv.slice(1).join("-")}`,
          featureResult.code === 0 && !featureResult.timedOut ? "pass" : "fail",
          featureResult.code === 0 && !featureResult.timedOut
            ? feature.description
            : (dependency.install?.repair ??
                "See the catalog repair guidance."),
        ),
      );
    }
  }
  return checks;
}

/** @param {string} root - Owned runtime root. @returns {object} Read-only runtime diagnosis. */
export async function doctor(root) {
  const paths = runtimePaths(root);
  const checks = [];
  const node = await run([process.execPath, "--version"], { timeoutMs: 5000 });
  const nodeSupported = node.code === 0 && supportedNode(node.stdout);
  checks.push(
    check(
      "node",
      nodeSupported ? "pass" : "fail",
      nodeSupported
        ? node.stdout.trim()
        : `${node.stdout.trim() || "Node unavailable"}; requires >=22.13.0`,
    ),
  );
  if (!nodeSupported)
    return runtimeResult("runtime-doctor", "blocked", paths, checks);
  if (!fs.existsSync(paths.active)) {
    checks.push(check("runtime-install", "fail", "No active runtime pointer"));
    return runtimeResult("runtime-doctor", "needs-install", paths, checks);
  }
  let active;
  try {
    active = JSON.parse(fs.readFileSync(paths.active, "utf8"));
  } catch {
    checks.push(
      check("runtime-install", "fail", "Active runtime pointer is invalid"),
    );
    return runtimeResult("runtime-doctor", "needs-install", paths, checks);
  }
  if (
    active.fingerprint !== paths.fingerprint ||
    active.version !== paths.version ||
    !fs.existsSync(paths.runtime)
  ) {
    checks.push(
      check(
        "runtime-install",
        "fail",
        "Active runtime does not match the manifest lock fingerprint",
      ),
    );
    return runtimeResult("runtime-doctor", "needs-install", paths, checks);
  }
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(paths.runtime, "manifest.json"), "utf8"),
    );
    if (
      manifest.fingerprint !== paths.fingerprint ||
      manifest.version !== paths.version ||
      !fs
        .readFileSync(path.join(paths.runtime, "package.json"))
        .equals(paths.manifest) ||
      !fs
        .readFileSync(path.join(paths.runtime, "package-lock.json"))
        .equals(paths.lockfile)
    ) {
      throw new Error("runtime artifacts do not match active identity");
    }
  } catch {
    checks.push(
      check(
        "runtime-integrity",
        "fail",
        "Runtime manifest or lockfile does not match the active identity",
      ),
    );
    return runtimeResult("runtime-doctor", "needs-install", paths, checks);
  }
  const ocx =
    process.platform === "win32"
      ? path.join(paths.runtime, "node_modules", ".bin", "ocx.cmd")
      : path.join(paths.runtime, "node_modules", ".bin", "ocx");
  const probe = await run([ocx, "--version"], { timeoutMs: 15000 });
  const passed = probe.code === 0 && probe.stdout.includes(paths.version);
  checks.push(
    check(
      "runtime-install",
      passed ? "pass" : "fail",
      passed ? probe.stdout.trim() : probe.stderr.trim(),
    ),
  );
  // Unrelated catalog checks (gh, Orca desktop) describe other features. Only a
  // failure of a check required for the OpenCodex backend holds back a turn,
  // and none of them condemns a runtime whose own install, integrity and
  // health checks passed.
  const catalog = await catalogChecks();
  checks.push(...catalog);
  const blocked = catalog.some(
    (item) =>
      item.status === "fail" && item.requiredFor?.includes(BACKEND_CAPABILITY),
  );
  return runtimeResult(
    "runtime-doctor",
    passed ? (blocked ? "action-required" : "ready") : "needs-install",
    paths,
    checks,
    passed,
  );
}

function runtimeResult(command, status, paths, checks, runtimeHealthy = false) {
  return {
    schemaVersion: 1,
    command,
    status,
    runtimeHealthy,
    checkedAt: new Date().toISOString(),
    runtime: {
      id: "opencodex",
      version: paths.version,
      prefixFingerprint: paths.fingerprint,
    },
    checks,
    nextAction:
      status === "needs-install"
        ? "Run runtime-install; authentication is never automated."
        : status === "action-required"
          ? "Resolve the failing checks required for opencodex-backend; the installed runtime is healthy and is kept."
          : null,
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) =>
    server.listen(0, "127.0.0.1", resolve).on("error", reject),
  );
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Creates an isolated environment for health checks that removes API credentials
 * and redirects home directories to temporary locations.
 *
 * On Windows, HOME is derived from HOMEDRIVE + HOMEPATH (e.g. C: + \Users\Alice).
 * On macOS and Linux, HOME is standalone. Windows also uses USERPROFILE as the
 * modern home directory variable. This function isolates all of them.
 *
 * @param {string} home - Temporary home directory for general use.
 * @param {string} codexHome - Temporary Codex configuration directory.
 * @returns {object} Environment object with isolated paths and removed credentials.
 */
export function isolatedHealthEnvironment(home, codexHome) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      /(?:^|_)(?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|API)[A-Z_]*(?:KEY|TOKEN)(?:$|_)/i.test(
        key,
      ) ||
      key === "OPENCODEX_HOME" ||
      key === "CODEX_HOME" ||
      key === "HOME" ||
      key === "USERPROFILE" ||
      key === "HOMEDRIVE" ||
      key === "HOMEPATH"
    ) {
      delete environment[key];
    }
  }
  const isolated = {
    ...environment,
    OPENCODEX_HOME: home,
    CODEX_HOME: codexHome,
    HOME: home,
    USERPROFILE: home,
  };
  if (process.platform === "win32") {
    isolated.HOMEDRIVE = path.parse(home).root;
    isolated.HOMEPATH = path.relative(isolated.HOMEDRIVE, home);
  }
  return isolated;
}

/**
 * Spawns the runtime inside staging to verify it can start, health-check, and
 * isolate its home directories outside the staging directory so they are not
 * promoted to the active runtime tree.
 *
 * @param {string} ocx - Path to the ocx executable.
 * @param {string} staging - Staging directory where npm packages are installed.
 * @param {string} healthBase - Base directory for health check temporary homes.
 */
async function healthCheck(ocx, staging, healthBase) {
  const port = await freePort();
  const healthDir = path.join(
    healthBase,
    `health-${crypto.randomUUID().slice(0, 8)}`,
  );
  const home = path.join(healthDir, "home");
  const codexHome = path.join(healthDir, "codex");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({
      hostname: "127.0.0.1",
      port,
      runtimeRole: "hub",
      providers: {},
      clientIntegrations: { codex: false },
      claudeCode: { enabled: false, systemEnv: false, injectAgents: false },
    }),
  );
  const child = spawn(ocx, ["start", "--port", String(port)], {
    cwd: staging,
    env: isolatedHealthEnvironment(home, codexHome),
    stdio: "ignore",
    shell: false,
  });
  let exited = false;
  child.once("close", () => {
    exited = true;
  });
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (response.ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error("runtime-health-check-failed");
  } finally {
    if (child.exitCode === null && !exited) child.kill("SIGTERM");
    if (child.exitCode === null && !exited) {
      await Promise.race([
        new Promise((resolve) => child.once("close", resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    fs.rmSync(healthDir, { recursive: true, force: true });
  }
}

/**
 * Installs a locked runtime in staging and atomically changes the active pointer only after version verification.
 * @param {string} root - Owned runtime root.
 * @param {{dryRun?: boolean, repair?: boolean}} [options] - Installation options.
 * @returns {Promise<object>} Installation receipt.
 */
export async function installRuntime(root, options = {}) {
  const paths = runtimePaths(root);
  const before = await doctor(root);
  const command = options.repair ? "runtime-repair" : "runtime-install";
  if (options.dryRun) return { ...before, command, dryRun: true };
  // A runtime whose install, integrity and health checks pass is reused as it
  // is, whatever an unrelated catalog check says; replacing it would download
  // and swap files that are not broken.
  if (before.runtimeHealthy) return { ...before, command, reused: true };
  fs.mkdirSync(paths.base, { recursive: true, mode: 0o700 });
  return withAsyncFileLock(
    paths.lock,
    async () => {
      const staging = path.join(
        paths.base,
        "staging",
        `${paths.fingerprint.slice(7)}-${crypto.randomUUID()}`,
      );
      try {
        fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(staging, "package.json"), paths.manifest, {
          mode: 0o600,
        });
        fs.writeFileSync(
          path.join(staging, "package-lock.json"),
          paths.lockfile,
          { mode: 0o600 },
        );
        const installed = await run(["npm", "ci"], {
          cwd: staging,
          timeoutMs: 180000,
        });
        assert(
          installed.code === 0 && !installed.timedOut,
          `runtime-npm-install-failed: ${installed.stderr.trim()}`,
        );
        const ocx =
          process.platform === "win32"
            ? path.join(staging, "node_modules", ".bin", "ocx.cmd")
            : path.join(staging, "node_modules", ".bin", "ocx");
        const verified = await run([ocx, "--version"], {
          cwd: staging,
          timeoutMs: 30000,
        });
        assert(
          verified.code === 0 && verified.stdout.includes(paths.version),
          "runtime-version-mismatch",
        );
        const bun = path.join(staging, "node_modules", "bun", "bin", "bun.exe");
        const bunVersion = await run([bun, "--version"], {
          cwd: staging,
          timeoutMs: 30000,
        });
        assert(bunVersion.code === 0, "runtime-bun-unavailable");
        await healthCheck(ocx, staging, paths.base);
        writeJSON(path.join(staging, "manifest.json"), {
          fingerprint: paths.fingerprint,
          version: paths.version,
          verifiedAt: new Date().toISOString(),
        });
        fs.mkdirSync(path.dirname(paths.runtime), {
          recursive: true,
          mode: 0o700,
        });
        if (fs.existsSync(paths.runtime)) {
          fs.renameSync(paths.runtime, `${paths.runtime}.failed-${Date.now()}`);
        }
        fs.renameSync(staging, paths.runtime);
        const pending = `${paths.active}.${process.pid}.${Date.now()}`;
        writeJSON(pending, {
          fingerprint: paths.fingerprint,
          version: paths.version,
          ocxVersion: verified.stdout.trim(),
        });
        fs.renameSync(pending, paths.active);
        // The receipt reports what the checks now show, not a fixed "ready".
        return {
          ...(await doctor(root)),
          command,
          installed: true,
        };
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    },
    "runtime-install-locked",
  );
}

/**
 * Removes failed runtime directories and stale staging directories.
 *
 * Nothing is removed unless its real path, with every link followed, is a direct
 * child of the real `runtimes` or `staging` directory inside the ownership
 * prefix. The check runs when candidates are listed and again just before each
 * removal, so a link can neither point a removal outside the prefix nor be
 * swapped in between. The runtime an `active.json` points to, symbolic links,
 * and staging directories whose install lock is held by a live process are kept
 * and reported in `skipped`. `runtimes` and `staging` are handled independently,
 * so a missing one never hides the other.
 *
 * @param {string} root - Owned runtime root.
 * @param {{dryRun?: boolean}} [options] - Prune options; a dry run only lists.
 * @returns {object} Prune result; `deleted` lists what was (or with `dryRun`, would be) removed.
 */
export async function pruneRuntimes(root, options = {}) {
  const paths = runtimePaths(root);
  const result = {
    command: "runtime-prune",
    dryRun: Boolean(options.dryRun),
    deleted: [],
    skipped: [],
  };
  const skip = (target, reason) =>
    result.skipped.push({ path: target, reason });
  let realBase;
  try {
    realBase = fs.realpathSync(paths.base);
    const ownedBase = path.join(
      fs.realpathSync(path.dirname(paths.base)),
      path.basename(paths.base),
    );
    if (realBase !== ownedBase) {
      skip(paths.base, "the ownership prefix is a link to another location");
      return result;
    }
  } catch {
    return result;
  }
  let activeName = null;
  try {
    const { fingerprint } = JSON.parse(fs.readFileSync(paths.active, "utf8"));
    activeName = String(fingerprint).replace(/^sha256:/, "");
  } catch {}
  const lockHeld = (name) => {
    const own = /^([a-f0-9]{64})-/.exec(name)?.[1];
    const dir = path.dirname(paths.lock);
    let locks = [];
    try {
      locks = fs.readdirSync(dir).filter((file) => file.endsWith(".lock"));
    } catch {}
    // A name that carries no fingerprint cannot be tied to one lock.
    return locks
      .filter((file) => !own || file === `${own}.lock`)
      .some((file) => !ownerHasExited(path.join(dir, file)));
  };
  const candidates = [];
  const scan = (folder, accept) => {
    const dir = path.join(paths.base, folder);
    let realDir;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (realDir !== path.join(realBase, folder)) {
      skip(dir, "not a real directory inside the ownership prefix");
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      const expected = path.join(realDir, entry.name);
      if (entry.isSymbolicLink()) {
        skip(target, "symbolic link");
      } else if (entry.isDirectory()) {
        const reason = accept(entry.name);
        if (reason) skip(target, reason);
        else if (reason === null) candidates.push({ target, expected });
      }
    }
  };
  scan("runtimes", (name) => {
    if (!/\.failed-\d+$/.test(name)) return undefined;
    return name === activeName ? "active runtime" : null;
  });
  scan("staging", (name) =>
    lockHeld(name) ? "install lock held by another process" : null,
  );
  for (const { target, expected } of candidates) {
    if (options.dryRun) {
      result.deleted.push(target);
      continue;
    }
    try {
      // Re-resolved immediately before removal: a link swapped in since the
      // listing no longer resolves to the direct child that was checked.
      if (fs.realpathSync(target) !== expected) {
        skip(target, "no longer a real directory inside the ownership prefix");
        continue;
      }
      fs.rmSync(target, { recursive: true, force: true });
      result.deleted.push(target);
    } catch (error) {
      skip(target, error.message);
    }
  }
  return result;
}

/** @returns {string} Default owned runtime location outside plugin caches. */
export function defaultRuntimeRoot() {
  return path.join(os.homedir(), ".omt", "runtime");
}
