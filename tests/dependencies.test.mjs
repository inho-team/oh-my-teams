/** Deterministic OpenCodex runtime identity and dry-run diagnostics. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main as installMain } from "../scripts/install.mjs";
import {
  doctor,
  healthCheck,
  installRuntime,
  isolatedHealthEnvironment,
  pruneRuntimes,
  runtimeIdentity,
  runtimePaths,
  supportedNode,
} from "../plugins/oh-my-teams/scripts/dependencies.mjs";
import { killWindowsProcessTree } from "../plugins/oh-my-teams/scripts/opencodex.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omt-dependencies-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("the exact package lock produces a stable owned runtime fingerprint", () => {
  const identity = runtimeIdentity();
  const manifest = JSON.parse(
    fs.readFileSync("plugins/oh-my-teams/package.json", "utf8"),
  );
  assert.equal(identity.version, manifest.dependencies["@bitkyc08/opencodex"]);
  assert.match(identity.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(
    runtimePaths("/tmp/omt-runtime").runtime.includes(
      identity.fingerprint.slice(7),
    ),
    true,
  );
});

test("runtime diagnosis rejects Node versions below the accepted catalog floor", () => {
  assert.equal(supportedNode("v22.12.9"), false);
  assert.equal(supportedNode("v22.13.0"), true);
  assert.equal(supportedNode("v23.0.0"), true);
  assert.equal(supportedNode("invalid"), false);
});

test("missing and dry-run runtime checks do not write an active pointer", async (t) => {
  const root = fixture(t);
  const missing = await doctor(root);
  assert.equal(missing.status, "needs-install");
  const dryRun = await installRuntime(root, { dryRun: true });
  assert.equal(dryRun.dryRun, true);
  assert.equal(fs.existsSync(runtimePaths(root).active), false);
});

test("the pinned OpenCodex version lives only in package.json and its lockfile", () => {
  const { version } = runtimeIdentity();
  const source = fs.readFileSync(
    fileURLToPath(
      new URL(
        "../plugins/oh-my-teams/scripts/dependencies.mjs",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  assert.equal(source.includes(version), false);
  assert.equal(source.includes(version.replaceAll(".", "\\.")), false);
  const lock = JSON.parse(
    fs.readFileSync("plugins/oh-my-teams/package-lock.json", "utf8"),
  );
  assert.equal(
    lock.packages["node_modules/@bitkyc08/opencodex"].version,
    version,
  );
});

// Kept POSIX only: these fake a whole toolchain (`npm`, `codex`, `git`, `node`)
// as `/bin/sh` scripts found through PATH, and a Windows PATH lookup finds
// `.cmd` shims instead. The launcher and health-check tree cleanup that the
// Windows install path depends on are covered by the health-check test below,
// which runs on every platform.
const posixOnly = {
  skip: process.platform === "win32" && "the fake runtime uses POSIX scripts",
};

const windowsOnly = {
  skip:
    process.platform !== "win32" &&
    "POSIX health-check children are not ended as a tree",
};

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitGone(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive(pid))
    await new Promise((resolve) => setTimeout(resolve, 50));
  return !isAlive(pid);
}

// A launcher that starts a child holding the port, then stays alive, as a
// package launcher that delegates to another process would.
function delegatingLauncher(t) {
  const root = fixture(t);
  const pids = path.join(root, "pids");
  fs.mkdirSync(pids);
  const script = path.join(root, "launcher.mjs");
  fs.writeFileSync(
    script,
    `const { spawn } = process.getBuiltinModule("node:child_process");
const fs = process.getBuiltinModule("node:fs");
const port = process.argv[process.argv.indexOf("--port") + 1];
const server = "require('node:http').createServer((q,r)=>r.end('ok')).listen(" + port + ",'127.0.0.1');setInterval(()=>{},1000)";
const child = spawn(process.execPath, ["-e", server], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(path.join(pids, "server"))}, String(child.pid));
fs.writeFileSync(${JSON.stringify(path.join(pids, "launcher"))}, String(process.pid));
setInterval(() => {}, 1000);
`,
  );
  const read = (name) => Number(fs.readFileSync(path.join(pids, name), "utf8"));
  t.after(() => {
    for (const name of ["server", "launcher"]) {
      try {
        if (process.platform === "win32") killWindowsProcessTree(read(name));
        else process.kill(read(name), "SIGKILL");
      } catch {}
    }
  });
  return {
    root,
    read,
    launch: { command: process.execPath, args: [script] },
  };
}

test("a passing health check ends the launcher it started", async (t) => {
  const box = delegatingLauncher(t);
  const staging = fixture(t);
  await healthCheck(box.launch, staging, box.root);
  assert.equal(await waitGone(box.read("launcher")), true);
  assert.deepEqual(
    fs.readdirSync(box.root).filter((name) => name.startsWith("health-")),
    [],
  );
});

// POSIX only signals the launcher here, as before; Windows has no process group
// to signal, so the check ends the whole tree with taskkill and this shows it.
test(
  "a health check on Windows ends the launcher's child, not only the launcher",
  windowsOnly,
  async (t) => {
    const box = delegatingLauncher(t);
    await healthCheck(box.launch, fixture(t), box.root);
    assert.equal(await waitGone(box.read("launcher")), true);
    assert.equal(await waitGone(box.read("server")), true);
  },
);

// A valid active runtime under a temp root, and a PATH holding only fakes.
function healthyRuntime(t, { codexWorks = true } = {}) {
  const root = fixture(t);
  const paths = runtimePaths(root);
  fs.mkdirSync(path.join(paths.runtime, "node_modules", ".bin"), {
    recursive: true,
  });
  fs.writeFileSync(path.join(paths.runtime, "package.json"), paths.manifest);
  fs.writeFileSync(
    path.join(paths.runtime, "package-lock.json"),
    paths.lockfile,
  );
  fs.writeFileSync(
    path.join(paths.runtime, "manifest.json"),
    JSON.stringify({ fingerprint: paths.fingerprint, version: paths.version }),
  );
  fs.writeFileSync(
    path.join(paths.runtime, "node_modules", ".bin", "ocx"),
    `#!${process.execPath}\nconsole.log("opencodex ${paths.version}");\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    paths.active,
    JSON.stringify({
      fingerprint: paths.fingerprint,
      version: paths.version,
    }),
  );
  const bin = path.join(root, "bin");
  const log = path.join(root, "npm.log");
  fs.mkdirSync(bin);
  const fake = (name, body) =>
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, {
      mode: 0o755,
    });
  // Any npm call is recorded and fails, as with no network.
  fake("npm", `echo "npm $@" >> "${log}"\nexit 1`);
  fake("codex", codexWorks ? "exit 0" : "exit 1");
  fake("git", "exit 0");
  fake("node", `exec "${process.execPath}" "$@"`);
  const before = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => {
    process.env.PATH = before;
  });
  const snapshot = () =>
    JSON.stringify(
      fs
        .readdirSync(path.join(paths.base, "runtimes"), { recursive: true })
        .sort(),
    ) + fs.readFileSync(paths.active, "utf8");
  return { root, paths, log, snapshot };
}

test(
  "a healthy runtime is reused when only unrelated catalog checks fail",
  posixOnly,
  async (t) => {
    const box = healthyRuntime(t);
    const diagnosis = await doctor(box.root);
    // gh is not on the fake PATH; it is not required for the OpenCodex backend.
    const gh = diagnosis.checks.find((item) => item.id === "gh");
    assert.equal(gh.status, "fail");
    assert.equal(gh.requiredFor.includes("opencodex-backend"), false);
    assert.equal(diagnosis.runtimeHealthy, true);
    assert.equal(diagnosis.status, "ready");
    const before = box.snapshot();
    const receipt = await installRuntime(box.root);
    assert.equal(receipt.reused, true);
    assert.equal(receipt.status, "ready");
    assert.equal(fs.existsSync(box.log), false, "no npm ci may run");
    assert.equal(box.snapshot(), before, "no file may change");
    const repaired = await installRuntime(box.root, { repair: true });
    assert.equal(repaired.reused, true);
    assert.equal(fs.existsSync(box.log), false);
  },
);

test(
  "a failing check the backend requires blocks turns but never replaces a healthy runtime",
  posixOnly,
  async (t) => {
    const box = healthyRuntime(t, { codexWorks: false });
    const diagnosis = await doctor(box.root);
    const codex = diagnosis.checks.find((item) => item.id === "codex");
    assert.equal(codex.status, "fail");
    assert.equal(codex.requiredFor.includes("opencodex-backend"), true);
    assert.equal(diagnosis.status, "action-required");
    assert.equal(diagnosis.runtimeHealthy, true);
    const before = box.snapshot();
    const receipt = await installRuntime(box.root);
    assert.equal(receipt.reused, true);
    assert.equal(receipt.status, "action-required");
    assert.equal(fs.existsSync(box.log), false);
    assert.equal(box.snapshot(), before);
  },
);

test("an unhealthy runtime is still reinstalled", posixOnly, async (t) => {
  const box = healthyRuntime(t);
  fs.writeFileSync(
    path.join(box.paths.runtime, "node_modules", ".bin", "ocx"),
    "#!/bin/sh\nexit 1\n",
    { mode: 0o755 },
  );
  assert.equal((await doctor(box.root)).status, "needs-install");
  await assert.rejects(
    () => installRuntime(box.root),
    /runtime-npm-install-failed/,
  );
  assert.match(fs.readFileSync(box.log, "utf8"), /npm ci/);
});

test(
  "the installer reports the plan when the runtime install fails after the plugins",
  posixOnly,
  async (t) => {
    const box = healthyRuntime(t);
    fs.rmSync(box.paths.active);
    const desired = JSON.parse(
      fs.readFileSync("plugins/oh-my-teams/.claude-plugin/plugin.json", "utf8"),
    ).version;
    const codexVersion = JSON.parse(
      fs.readFileSync("plugins/oh-my-teams/.codex-plugin/plugin.json", "utf8"),
    ).version;
    const installed = (id, version) => ({ id, version, enabled: true });
    const commandRunner = async (argv) => ({
      code: 0,
      timedOut: false,
      stderr: "",
      stdout: JSON.stringify(
        argv[0] === "claude"
          ? [installed("oh-my-teams@oh-my-teams", desired)]
          : {
              installed: [
                {
                  pluginId: "oh-my-teams@oh-my-teams",
                  version: codexVersion,
                  enabled: true,
                },
              ],
            },
      ),
    });
    const lines = [];
    const write = console.log;
    console.log = (line) => lines.push(String(line));
    try {
      await assert.rejects(
        () =>
          installMain(["both"], {
            root: path.resolve("."),
            commandRunner,
            runtimeRoot: box.root,
          }),
        /runtime-npm-install-failed/,
      );
    } finally {
      console.log = write;
    }
    const plan = JSON.parse(lines.at(-1));
    assert.equal(plan.runtime.status, "install-failed");
    assert.match(plan.runtime.error, /runtime-npm-install-failed/);
    assert.equal(plan.clients.claude.newCurrent, true);
  },
);

test(
  "healthCheck clears timer on normal exit and sends SIGKILL if stubborn",
  posixOnly,
  async (t) => {
    const box = healthyRuntime(t);

    // Fake the fetch to return ok instantly
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true });
    t.after(() => {
      global.fetch = originalFetch;
    });

    const events = [];
    let closeCb;
    const mockChild = {
      exitCode: null,
      kill: (signal) => {
        events.push("kill:" + signal);
        if (signal === "SIGTERM") {
          setTimeout(() => {
            if (mockChild.shouldClose) {
              mockChild.exitCode = 0;
              if (closeCb) closeCb();
            }
          }, 50);
        }
      },
      once: (event, cb) => {
        if (event === "close") closeCb = cb;
      },
    };

    const spawnImpl = () => mockChild;
    // healthCheck is called directly rather than through installRuntime,
    // because this fixture's fake npm always fails and an install would end at
    // `runtime-npm-install-failed` before any runtime is started.
    const launch = { command: "ocx", args: [] };
    const healthBase = path.join(box.root, "health");
    fs.mkdirSync(healthBase, { recursive: true });

    // Test 1: normal close
    mockChild.shouldClose = true;
    mockChild.exitCode = null;
    events.length = 0;
    const start1 = Date.now();
    await healthCheck(launch, box.paths.runtime, healthBase, spawnImpl);
    assert.deepEqual(events, ["kill:SIGTERM"]);
    assert.ok(
      Date.now() - start1 < 3000,
      "Should close quickly, clearing the 3s timer",
    );

    // Test 2: stubborn child
    mockChild.shouldClose = false;
    mockChild.exitCode = null;
    events.length = 0;
    const start2 = Date.now();
    await healthCheck(launch, box.paths.runtime, healthBase, spawnImpl);
    assert.deepEqual(events, ["kill:SIGTERM", "kill:SIGKILL"]);
    assert.ok(Date.now() - start2 >= 3000, "Should wait 3s before SIGKILL");
  },
);

// Sets variables for one test; a variable that was unset is deleted again,
// because assigning undefined to process.env would leave the string "undefined".
function withEnv(t, values) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("the isolated health environment maps each variable to its own temporary path", (t) => {
  const home = fixture(t);
  const codexHome = fixture(t);
  withEnv(t, {
    HOME: "/real/home",
    USERPROFILE: "C:\\Users\\Real",
    HOMEDRIVE: "C:",
    HOMEPATH: "\\Users\\Real",
    OPENCODEX_HOME: "/real/opencodex",
    CODEX_HOME: "/real/codex",
  });
  const env = isolatedHealthEnvironment(home, codexHome);
  assert.equal(env.HOME, home);
  assert.equal(env.USERPROFILE, home);
  assert.equal(env.OPENCODEX_HOME, home);
  assert.equal(env.CODEX_HOME, codexHome);
  if (process.platform === "win32") {
    assert.equal(env.HOMEDRIVE, path.parse(home).root);
    assert.equal(env.HOMEPATH, path.relative(path.parse(home).root, home));
  } else {
    // Nothing that derives a home may be inherited from the real environment.
    assert.equal("HOMEDRIVE" in env, false);
    assert.equal("HOMEPATH" in env, false);
  }
});

test("withEnv leaves process.env exactly as it found it", async (t) => {
  const before = { ...process.env };
  await t.test("inner", (inner) => {
    withEnv(inner, { HOME: "/x", HOMEDRIVE: undefined, ABSENT_FOR_TEST: "1" });
    assert.equal(process.env.ABSENT_FOR_TEST, "1");
  });
  assert.deepEqual({ ...process.env }, before);
  assert.equal("ABSENT_FOR_TEST" in process.env, false);
});

// An installable runtime under a temp root: a fake npm ci that lays down a fake
// ocx and Bun, and a fake ocx whose `start` records the environment it got and
// writes into HOME and CODEX_HOME, as a real runtime might.
function installableRuntime(t, { startWorks = true } = {}) {
  const root = fixture(t);
  const paths = runtimePaths(root);
  const bin = path.join(root, "bin");
  const seed = path.join(root, "seed");
  fs.mkdirSync(bin);
  fs.mkdirSync(seed);
  const observed = path.join(root, "observed.json");
  const script = (name, dir, body) => {
    fs.writeFileSync(path.join(dir, name), `#!${process.execPath}\n${body}\n`, {
      mode: 0o755,
    });
  };
  script(
    "ocx",
    seed,
    `const fs = require("node:fs");
const http = require("node:http");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("opencodex ${paths.version}");
  process.exit(0);
}
const env = process.env;
fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({
  HOME: env.HOME, USERPROFILE: env.USERPROFILE, HOMEDRIVE: env.HOMEDRIVE ?? null,
  HOMEPATH: env.HOMEPATH ?? null, OPENCODEX_HOME: env.OPENCODEX_HOME, CODEX_HOME: env.CODEX_HOME,
}));
fs.writeFileSync(env.HOME + "/written-by-runtime", "x");
fs.writeFileSync(env.CODEX_HOME + "/written-by-runtime", "x");
if (${startWorks}) {
  http.createServer((request, response) => response.end("ok")).listen(Number(args[args.indexOf("--port") + 1]), "127.0.0.1");
} else {
  setInterval(() => {}, 1000);
}`,
  );
  script("bun.exe", seed, 'console.log("1.0.0");');
  script(
    "npm",
    bin,
    `const fs = require("node:fs");
const path = require("node:path");
const ocx = path.join(process.cwd(), "node_modules", ".bin");
const bun = path.join(process.cwd(), "node_modules", "bun", "bin");
fs.mkdirSync(ocx, { recursive: true });
fs.mkdirSync(bun, { recursive: true });
fs.copyFileSync(${JSON.stringify(path.join(seed, "ocx"))}, path.join(ocx, "ocx"));
fs.copyFileSync(${JSON.stringify(path.join(seed, "bun.exe"))}, path.join(bun, "bun.exe"));
fs.chmodSync(path.join(ocx, "ocx"), 0o755);
fs.chmodSync(path.join(bun, "bun.exe"), 0o755);`,
  );
  for (const [name, body] of [
    ["codex", "exit 0"],
    ["git", "exit 0"],
    ["node", `exec "${process.execPath}" "$@"`],
  ]) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, {
      mode: 0o755,
    });
  }
  withEnv(t, { PATH: bin });
  return {
    root,
    paths,
    observed: () => JSON.parse(fs.readFileSync(observed, "utf8")),
  };
}

// Health directories anywhere under the owned tree, including the active runtime.
function healthLeftovers(paths) {
  return fs
    .readdirSync(paths.base, { recursive: true })
    .filter((name) => /(^|[\\/])health/.test(name));
}

test(
  "a successful install leaves no health directory in the active tree or the owned base",
  posixOnly,
  async (t) => {
    const box = installableRuntime(t);
    const receipt = await installRuntime(box.root);
    assert.equal(receipt.installed, true);
    assert.equal(fs.existsSync(box.paths.runtime), true);
    // The status check really ran under the owned base, so the scan is not vacuous.
    assert.match(box.observed().HOME, /[\\/]health-[^\\/]+[\\/]/);
    assert.equal(box.observed().HOME.startsWith(box.paths.base), true);
    assert.deepEqual(healthLeftovers(box.paths), []);
  },
);

test(
  "a failed status check also leaves no health directory behind",
  posixOnly,
  async (t) => {
    const box = installableRuntime(t, { startWorks: false });
    await assert.rejects(
      () => installRuntime(box.root),
      /runtime-health-check-failed/,
    );
    assert.equal(fs.existsSync(box.paths.runtime), false);
    assert.equal(fs.existsSync(box.paths.active), false);
    assert.equal(box.observed().HOME.startsWith(box.paths.base), true);
    assert.deepEqual(healthLeftovers(box.paths), []);
  },
);

test(
  "the status check under a fake HOME never writes to the real HOME",
  posixOnly,
  async (t) => {
    const realHome = fixture(t);
    fs.writeFileSync(path.join(realHome, ".sentinel"), "keep");
    const listing = () =>
      fs
        .readdirSync(realHome, { recursive: true })
        .sort()
        .map((name) => [name, fs.statSync(path.join(realHome, name)).mtimeMs]);
    const before = listing();
    withEnv(t, {
      HOME: realHome,
      USERPROFILE: realHome,
      HOMEDRIVE: undefined,
      HOMEPATH: undefined,
      CODEX_HOME: path.join(realHome, ".codex"),
    });
    const box = installableRuntime(t);
    await installRuntime(box.root);
    const seen = box.observed();
    for (const key of ["HOME", "USERPROFILE", "OPENCODEX_HOME", "CODEX_HOME"]) {
      assert.equal(
        seen[key].startsWith(box.paths.base),
        true,
        `${key} is isolated`,
      );
      assert.equal(
        seen[key].startsWith(realHome),
        false,
        `${key} is not the real HOME`,
      );
    }
    assert.equal(seen.HOMEDRIVE, null);
    assert.equal(seen.HOMEPATH, null);
    assert.deepEqual(listing(), before, "the real HOME is unchanged");
  },
);

// A temp root whose owned base already holds `runtimes` and `staging` trees.
function pruneBox(t) {
  const root = fixture(t);
  const paths = runtimePaths(root);
  const fingerprint = paths.fingerprint.slice(7);
  const runtimes = path.join(paths.base, "runtimes");
  const staging = path.join(paths.base, "staging");
  const outside = fixture(t);
  const dir = (...parts) => {
    const target = path.join(...parts);
    fs.mkdirSync(target, { recursive: true });
    return target;
  };
  return { root, paths, fingerprint, runtimes, staging, outside, dir };
}

test("prune removes failed runtimes and stale staging directories", async (t) => {
  const box = pruneBox(t);
  const failed = box.dir(
    box.runtimes,
    `${box.fingerprint}.failed-1700000000000`,
  );
  const stale = box.dir(box.staging, `${box.fingerprint}-old`);
  const result = await pruneRuntimes(box.root);
  assert.equal(result.command, "runtime-prune");
  assert.equal(result.dryRun, false);
  assert.deepEqual(result.deleted.sort(), [failed, stale].sort());
  assert.equal(fs.existsSync(failed), false);
  assert.equal(fs.existsSync(stale), false);
});

test("prune removes stale staging even when runtimes does not exist", async (t) => {
  const box = pruneBox(t);
  const stale = box.dir(
    box.staging,
    `${box.fingerprint}-interrupted-first-install`,
  );
  assert.equal(fs.existsSync(box.runtimes), false);
  await pruneRuntimes(box.root);
  assert.equal(fs.existsSync(stale), false);
});

test("prune keeps the runtime the active pointer names, and installed runtimes", async (t) => {
  const box = pruneBox(t);
  const installed = box.dir(box.runtimes, box.fingerprint);
  const named = box.dir(box.runtimes, "abc123.failed-5");
  const other = box.dir(box.runtimes, "def456.failed-6");
  fs.writeFileSync(
    box.paths.active,
    JSON.stringify({ fingerprint: "sha256:abc123.failed-5" }),
  );
  const result = await pruneRuntimes(box.root);
  assert.equal(fs.existsSync(installed), true);
  assert.equal(fs.existsSync(named), true, "the pointed-to runtime is kept");
  assert.equal(fs.existsSync(other), false);
  assert.deepEqual(result.skipped, [{ path: named, reason: "active runtime" }]);
});

test("prune keeps staging whose lock a live process holds, and removes it once the owner is gone", async (t) => {
  const box = pruneBox(t);
  const live = box.dir(box.staging, `${box.fingerprint}-installing`);
  const unrelated = box.dir(box.staging, "0".repeat(64) + "-old");
  const unnamed = box.dir(box.staging, "live-install");
  fs.mkdirSync(path.dirname(box.paths.lock), { recursive: true });
  const lock = (pid) =>
    fs.writeFileSync(
      box.paths.lock,
      JSON.stringify({ pid, hostname: os.hostname() }),
    );
  lock(process.pid);
  const held = await pruneRuntimes(box.root);
  assert.equal(fs.existsSync(live), true, "locked by a live process");
  assert.equal(
    fs.existsSync(unnamed),
    true,
    "a name with no fingerprint is kept while any lock is live",
  );
  assert.equal(
    fs.existsSync(unrelated),
    false,
    "another fingerprint has no live lock",
  );
  assert.equal(held.skipped.length, 2);
  assert.match(held.skipped[0].reason, /lock held/);
  // A lock whose recorded owner has exited no longer protects its staging.
  lock(spawnSync(process.execPath, ["-e", ""]).pid);
  await pruneRuntimes(box.root);
  assert.equal(fs.existsSync(live), false);
  assert.equal(fs.existsSync(unnamed), false);
});

// POSIX only: it links directories with symlinks, which Windows creates only with
// a privilege, and pruning is outside the Windows proxy task, so it is not ported.
test(
  "prune never removes anything outside the ownership prefix through a link",
  posixOnly,
  async (t) => {
    // Each case links one part of the tree to a directory outside the prefix.
    const cases = {
      "staging is a link": (box) => {
        fs.mkdirSync(box.paths.base, { recursive: true });
        fs.symlinkSync(box.outside, box.staging);
        return box.dir(box.outside, "precious");
      },
      "runtimes is a link": (box) => {
        fs.mkdirSync(box.paths.base, { recursive: true });
        fs.symlinkSync(box.outside, box.runtimes);
        return box.dir(box.outside, "x.failed-1");
      },
      "the owned base is a link": (box) => {
        fs.mkdirSync(path.dirname(box.paths.base), { recursive: true });
        fs.symlinkSync(box.outside, box.paths.base);
        return box.dir(box.outside, "runtimes", "x.failed-1");
      },
      "a failed runtime entry is a link": (box) => {
        box.dir(box.runtimes);
        const target = box.dir(box.outside, "precious");
        fs.symlinkSync(target, path.join(box.runtimes, "y.failed-2"));
        return target;
      },
      "a staging entry is a link": (box) => {
        box.dir(box.staging);
        const target = box.dir(box.outside, "precious");
        fs.symlinkSync(
          target,
          path.join(box.staging, `${box.fingerprint}-linked`),
        );
        return target;
      },
    };
    for (const [name, arrange] of Object.entries(cases)) {
      const box = pruneBox(t);
      const precious = arrange(box);
      fs.writeFileSync(path.join(precious, "data"), "keep");
      await pruneRuntimes(box.root);
      assert.equal(fs.existsSync(path.join(precious, "data")), true, name);
      assert.equal(fs.existsSync(precious), true, name);
    }
  },
);

test("prune --dry-run lists what it would remove and removes nothing", async (t) => {
  const box = pruneBox(t);
  const failed = box.dir(box.runtimes, `${box.fingerprint}.failed-1`);
  const stale = box.dir(box.staging, `${box.fingerprint}-old`);
  fs.writeFileSync(path.join(stale, "partial"), "x");
  const result = await pruneRuntimes(box.root, { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.deleted.sort(), [failed, stale].sort());
  assert.equal(fs.existsSync(failed), true);
  assert.equal(fs.existsSync(path.join(stale, "partial")), true);
});
