/** Owned, atomic installation and read-only diagnosis for the OpenCodex runtime. */
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, run, withAsyncFileLock, writeJSON } from "./core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, "..");
const MANIFEST = path.join(PACKAGE_DIR, "package.json");
const LOCKFILE = path.join(PACKAGE_DIR, "package-lock.json");

/** @returns {{version: string, fingerprint: string, manifest: Buffer, lockfile: Buffer}} OpenCodex package identity. */
export function runtimeIdentity() {
  const manifest = fs.readFileSync(MANIFEST);
  const lockfile = fs.readFileSync(LOCKFILE);
  const version = JSON.parse(manifest).dependencies?.["@bitkyc08/opencodex"];
  assert(
    /^2\.59\.0$/.test(version ?? ""),
    "OpenCodex dependency must be exactly pinned in package.json",
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

function check(id, status, evidence) {
  return { id, status, evidence };
}

/** @param {string} root - Owned runtime root. @returns {object} Read-only runtime diagnosis. */
export async function doctor(root) {
  const paths = runtimePaths(root);
  const checks = [];
  const node = await run([process.execPath, "--version"], { timeoutMs: 5000 });
  checks.push(
    check("node", node.code === 0 ? "pass" : "fail", node.stdout.trim()),
  );
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
  return runtimeResult(
    "runtime-doctor",
    passed ? "ready" : "needs-install",
    paths,
    checks,
  );
}

function runtimeResult(command, status, paths, checks) {
  return {
    schemaVersion: 1,
    command,
    status,
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

async function healthCheck(ocx, staging) {
  const port = await freePort();
  const home = path.join(staging, "health-home");
  const codexHome = path.join(staging, "health-codex-home");
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
    env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: codexHome },
    stdio: "ignore",
    shell: false,
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
    if (!child.killed) child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
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
  if (options.dryRun)
    return {
      ...before,
      command: options.repair ? "runtime-repair" : "runtime-install",
      dryRun: true,
    };
  if (before.status === "ready")
    return {
      ...before,
      command: options.repair ? "runtime-repair" : "runtime-install",
      reused: true,
    };
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
        await healthCheck(ocx, staging);
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
        return runtimeResult(
          options.repair ? "runtime-repair" : "runtime-install",
          "ready",
          paths,
          [check("runtime-install", "pass", verified.stdout.trim())],
        );
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    },
    "runtime-install-locked",
  );
}

/** @returns {string} Default owned runtime location outside plugin caches. */
export function defaultRuntimeRoot() {
  return path.join(os.homedir(), ".omt", "runtime");
}
