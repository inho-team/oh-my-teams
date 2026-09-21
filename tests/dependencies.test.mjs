/** Deterministic OpenCodex runtime identity and dry-run diagnostics. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main as installMain } from "../scripts/install.mjs";
import {
  doctor,
  installRuntime,
  isolatedHealthEnvironment,
  pruneRuntimes,
  runtimeIdentity,
  runtimePaths,
  supportedNode,
} from "../plugins/oh-my-teams/scripts/dependencies.mjs";

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

const posixOnly = {
  skip: process.platform === "win32" && "the fake runtime uses POSIX scripts",
};

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

test("isolated health environment includes HOME and Windows home variables", async (t) => {
  const tmpHome = path.join(os.tmpdir(), "fake-home");
  fs.mkdirSync(tmpHome, { recursive: true });
  t.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
  };
  t.after(() => {
    Object.assign(process.env, saved);
  });

  process.env.HOME = "/old/home";
  process.env.USERPROFILE = "C:\\Users\\Old";
  process.env.HOMEDRIVE = "C:";
  process.env.HOMEPATH = "\\Users\\Old";

  const isolatedEnv = isolatedHealthEnvironment(tmpHome, tmpHome);

  assert.equal(isolatedEnv.HOME, tmpHome);
  assert.equal(isolatedEnv.USERPROFILE, tmpHome);
  if (process.platform === "win32") {
    assert.equal(isolatedEnv.HOMEDRIVE, path.parse(tmpHome).root);
  }
  assert.ok(isolatedEnv.OPENCODEX_HOME === tmpHome);
  assert.ok(isolatedEnv.CODEX_HOME === tmpHome);
});

test("prune removes failed runtimes and stale staging dirs", async (t) => {
  const box = healthyRuntime(t);
  const runtimesDir = path.join(box.paths.base, "runtimes");

  const failedDir = `${box.paths.runtime}.failed-${Date.now()}`;
  fs.mkdirSync(failedDir, { recursive: true });

  const stagingDir = path.join(box.paths.base, "staging");
  const staleStaging = path.join(stagingDir, "stale-staging");
  fs.mkdirSync(staleStaging, { recursive: true });

  const result = await pruneRuntimes(box.root, { dryRun: false });
  assert.equal(result.command, "runtime-prune");
  assert.equal(result.dryRun, false);
  assert.equal(
    fs.existsSync(failedDir),
    false,
    "failed runtime should be removed",
  );
  assert.equal(
    fs.existsSync(staleStaging),
    false,
    "stale staging should be removed",
  );
  assert.equal(
    fs.existsSync(box.paths.runtime),
    true,
    "active runtime should be preserved",
  );
});

test("prune --dry-run does not delete anything", async (t) => {
  const box = healthyRuntime(t);
  const failedDir = `${box.paths.runtime}.failed-${Date.now()}`;
  fs.mkdirSync(failedDir, { recursive: true });

  const result = await pruneRuntimes(box.root, { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.deleted.length, 1);
  assert.equal(fs.existsSync(failedDir), true, "dry-run should not delete");
});
