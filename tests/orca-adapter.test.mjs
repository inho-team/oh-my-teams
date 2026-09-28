/**
 * resolveTrustedOrcaScriptPath / trustedOrcaExecute: the fixed, per-platform
 * script resolution and pinned-interpreter execution identity confirmation
 * and auditor launch trust (B.6, decision B).
 *
 * Every test here injects exists/realpath/userInfo/spawnExecute rather than
 * touching the filesystem, a real child process, or process.env's own
 * ORCA_ and HOME values, so this suite passes on a machine with no Orca
 * install and on any platform, including linux CI.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  readTrustedOrcaVersion,
  resolveTrustedOrcaScriptPath,
  runOrcaJson,
  runTrustedOrcaJson,
  trustedOrcaExecute,
  TRUSTED_ORCA_EXECUTABLE_PLACEHOLDER,
  selectOrcaExecutable,
} from "../plugins/oh-my-teams/scripts/orca-adapter.mjs";

const REAL_DARWIN_REALPATHS = Object.freeze({
  "/usr/local/bin/orca": "/Applications/Orca.app/Contents/Resources/bin/orca",
});

test("resolveTrustedOrcaScriptPath returns the realpath of the first injected candidate that exists and matches", () => {
  const resolved = resolveTrustedOrcaScriptPath({
    candidates: ["/missing/orca", "/real/orca"],
    exists: (candidate) => candidate === "/real/orca",
    realpath: () => "/real/orca-target",
    expectedRealpaths: { "/real/orca": "/real/orca-target" },
  });
  assert.equal(resolved, "/real/orca-target");
});

test("resolveTrustedOrcaScriptPath prefers an earlier candidate over a later one that also exists", () => {
  const resolved = resolveTrustedOrcaScriptPath({
    candidates: ["/first/orca", "/second/orca"],
    exists: () => true,
    realpath: (candidate) => candidate,
    expectedRealpaths: {
      "/first/orca": "/first/orca",
      "/second/orca": "/second/orca",
    },
  });
  assert.equal(resolved, "/first/orca");
});

test("resolveTrustedOrcaScriptPath throws, without falling back to any other selection, when no candidate exists", () => {
  assert.throws(
    () =>
      resolveTrustedOrcaScriptPath({
        platform: "darwin",
        candidates: ["/missing/orca"],
        exists: () => false,
      }),
    /No trusted Orca executable found for platform "darwin"/,
  );
});

test("resolveTrustedOrcaScriptPath throws for a platform with no known trusted path, rather than guess one", () => {
  assert.throws(
    () =>
      resolveTrustedOrcaScriptPath({
        platform: "win32",
        exists: () => true,
      }),
    /No trusted Orca executable found for platform "win32"/,
  );
  assert.throws(
    () =>
      resolveTrustedOrcaScriptPath({
        platform: "linux",
        exists: () => true,
      }),
    /No trusted Orca executable found for platform "linux"/,
  );
});

// The error message is the only channel this function has to explain a
// fail-closed refusal, so it must name the reason (no fallback exists),
// not just that the search failed.
test("resolveTrustedOrcaScriptPath's not-found error explains it refuses --orca/ORCA_CLI_COMMAND/ORCA_DEV_REPO_ROOT/PATH fallback rather than guess", () => {
  assert.throws(
    () =>
      resolveTrustedOrcaScriptPath({
        platform: "darwin",
        candidates: [],
        exists: () => true,
      }),
    /--orca, ORCA_CLI_COMMAND, ORCA_DEV_REPO_ROOT, or PATH/,
  );
});

// Reproduces (f): a candidate that exists on disk but whose symlink was
// repointed since TRUSTED_ORCA_REALPATHS was written must still be refused.
test("resolveTrustedOrcaScriptPath (f) refuses a candidate whose realpath does not match the expected target", () => {
  assert.throws(
    () =>
      resolveTrustedOrcaScriptPath({
        platform: "darwin",
        candidates: ["/usr/local/bin/orca"],
        exists: () => true,
        realpath: () => "/tmp/forged-orca-replacement",
        expectedRealpaths: REAL_DARWIN_REALPATHS,
      }),
    /resolved to "\/tmp\/forged-orca-replacement".*not the expected "\/Applications\/Orca\.app/s,
  );
});

test("resolveTrustedOrcaScriptPath refuses a candidate with no expected realpath registered at all", () => {
  assert.throws(
    () =>
      resolveTrustedOrcaScriptPath({
        platform: "darwin",
        candidates: ["/usr/local/bin/orca"],
        exists: () => true,
        realpath: () => "/anything",
        expectedRealpaths: {},
      }),
    /no expected target registered/,
  );
});

// darwin's real, built-in candidate list (no injected `candidates`) is
// exercised with an injected `exists`/`realpath`, so this stays independent
// of whatever Orca install (if any) the machine running this test actually
// has, while still confirming /usr/local/bin/orca is on that list.
test("resolveTrustedOrcaScriptPath's real darwin candidate list includes /usr/local/bin/orca, matched against the real expected realpath table", () => {
  const resolved = resolveTrustedOrcaScriptPath({
    platform: "darwin",
    exists: (candidate) => candidate === "/usr/local/bin/orca",
    realpath: () => REAL_DARWIN_REALPATHS["/usr/local/bin/orca"],
  });
  assert.equal(resolved, REAL_DARWIN_REALPATHS["/usr/local/bin/orca"]);
});

// Production callers (audit.mjs's verifiedPm, teams-org.mjs's
// resolveAuditorLaunchExecution) must never pass `candidates`/`exists`: this
// only confirms the real, unpatched `existsSync` is what a call with no
// options consults, i.e. that a caller cannot silently disable the disk
// check.
test("resolveTrustedOrcaScriptPath with no exists/candidates options consults the real filesystem, not a fixed answer", () => {
  assert.throws(() =>
    resolveTrustedOrcaScriptPath({
      platform: "darwin",
      candidates: ["/nonexistent/path/for/omt-orca-adapter-test/orca"],
    }),
  );
});

function invocationOf(options) {
  const calls = [];
  const spawnExecute = (argv, callOptions) => {
    calls.push({ argv, callOptions });
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const execute = trustedOrcaExecute({
    candidates: ["/usr/local/bin/orca"],
    exists: () => true,
    realpath: () => REAL_DARWIN_REALPATHS["/usr/local/bin/orca"],
    expectedRealpaths: REAL_DARWIN_REALPATHS,
    userInfo: () => ({ homedir: "/Users/injected", username: "injected" }),
    spawnExecute,
    ...options,
  });
  return { execute, calls };
}

// (a) + (b, forged bash/dirname/readlink): whatever argv[0] a caller passes
// (even the name of a forged orca/bash/dirname/readlink sitting earlier on
// some PATH) is discarded; the actual spawn always targets /bin/bash by
// absolute path with the resolved script, and the constructed env's PATH is
// pinned to the system directories, never including any directory a forged
// PATH entry could have injected.
test("trustedOrcaExecute (a)(b) always spawns /bin/bash --noprofile --norc <resolved script>, ignoring argv[0] and any forged PATH", async () => {
  const { execute, calls } = invocationOf();
  await execute([
    "/tmp/forged-orca",
    "orchestration",
    "run-current",
    "--from",
    "term_x",
  ]);
  assert.equal(calls.length, 1);
  const [{ argv, callOptions }] = calls;
  assert.deepEqual(argv, [
    "/bin/bash",
    "--noprofile",
    "--norc",
    REAL_DARWIN_REALPATHS["/usr/local/bin/orca"],
    "orchestration",
    "run-current",
    "--from",
    "term_x",
  ]);
  assert.equal(callOptions.env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.ok(
    !callOptions.env.PATH.includes("/tmp"),
    "a forged directory must never appear on the child's PATH",
  );
});

// (c) BASH_ENV and ENV, which a non-interactive bash also consults for a
// startup script, are absent from the constructed environment.
test("trustedOrcaExecute (c) never includes BASH_ENV or ENV in the child environment", async () => {
  const { execute, calls } = invocationOf();
  await execute(["orca", "--version"]);
  const env = calls[0].callOptions.env;
  assert.equal(env.BASH_ENV, undefined);
  assert.equal(env.ENV, undefined);
});

// (d) Every variable the downstream Orca CLI or its Electron host reads to
// find runtime state, pairing, or identity is absent, not merely unset by
// the caller.
test("trustedOrcaExecute (d) never includes ORCA_*/NODE_OPTIONS/XDG_*/ELECTRON_* in the child environment", async () => {
  const { execute, calls } = invocationOf();
  await execute(["orca", "orchestration", "run-current", "--from", "term_x"]);
  const env = calls[0].callOptions.env;
  for (const key of [
    "ORCA_USER_DATA_PATH",
    "ORCA_REMOTE_PAIRING",
    "ORCA_PAIRING_CODE",
    "ORCA_ENVIRONMENT",
    "ORCA_DEV_CLI_INVOCATION",
    "ORCA_TERMINAL_HANDLE",
    "ORCA_CLI_COMMAND",
    "ORCA_DEV_REPO_ROOT",
    "NODE_OPTIONS",
    "XDG_CONFIG_HOME",
    "ELECTRON_RUN_AS_NODE",
  ]) {
    assert.equal(
      env[key],
      undefined,
      `${key} must not reach the trusted invocation's child`,
    );
  }
});

// (e) HOME (and USER/LOGNAME) come only from the injected identity source,
// never from the calling process's own environment, so a caller who set
// process.env.HOME to redirect ORCA_USER_DATA_PATH's default cannot affect
// the trusted invocation.
test("trustedOrcaExecute (e) takes HOME/USER/LOGNAME from userInfo, not from process.env", async () => {
  const originalHome = process.env.HOME;
  process.env.HOME = "/tmp/forged-home-for-omt-orca-adapter-test";
  try {
    const { execute, calls } = invocationOf({
      userInfo: () => ({
        homedir: "/Users/real-owner",
        username: "real-owner",
      }),
    });
    await execute(["orca", "--version"]);
    const env = calls[0].callOptions.env;
    assert.equal(env.HOME, "/Users/real-owner");
    assert.equal(env.USER, "real-owner");
    assert.equal(env.LOGNAME, "real-owner");
    assert.notEqual(env.HOME, process.env.HOME);
  } finally {
    process.env.HOME = originalHome;
  }
});

// (f) A realpath mismatch discovered while building the invocation is
// refused before anything is spawned, propagating resolveTrustedOrcaScriptPath's
// own refusal.
test("trustedOrcaExecute (f) refuses to build an invocation when the trusted path's realpath does not match", () => {
  assert.throws(
    () =>
      trustedOrcaExecute({
        candidates: ["/usr/local/bin/orca"],
        exists: () => true,
        realpath: () => "/tmp/forged-orca-replacement",
        expectedRealpaths: REAL_DARWIN_REALPATHS,
      }),
    /not the expected/,
  );
});

// (g) No path known, or none exists: refused before anything is spawned,
// on every platform this table names as fail-closed.
test("trustedOrcaExecute (g) refuses to build an invocation when no trusted path exists, or on linux/win32", () => {
  assert.throws(() =>
    trustedOrcaExecute({
      platform: "darwin",
      candidates: [],
      exists: () => true,
    }),
  );
  assert.throws(() =>
    trustedOrcaExecute({ platform: "linux", exists: () => true }),
  );
  assert.throws(() =>
    trustedOrcaExecute({ platform: "win32", exists: () => true }),
  );
});

// (h) selectOrcaExecutable's own fallback chain (--orca, ORCA_CLI_COMMAND,
// ORCA_DEV_REPO_ROOT, PATH) is untouched by this decision: only the trusted
// path adds a fixed-script requirement, never removes the existing
// function's behavior for its own callers.
test("trustedOrcaExecute (h) leaves selectOrcaExecutable's own fallback chain unchanged", () => {
  assert.equal(selectOrcaExecutable("explicit-orca"), "explicit-orca");
  assert.equal(
    selectOrcaExecutable(undefined, { ORCA_CLI_COMMAND: "orca-from-env" }),
    "orca-from-env",
  );
  assert.equal(
    selectOrcaExecutable(undefined, { ORCA_DEV_REPO_ROOT: "/repo" }),
    "orca-dev",
  );
});

test("trustedOrcaExecute's returned runner rejects an empty argv, rather than spawn the trusted script with no Orca subcommand", () => {
  const { execute } = invocationOf();
  assert.throws(() => execute([]), /non-empty argv array/);
});

test("TRUSTED_ORCA_EXECUTABLE_PLACEHOLDER is a non-empty string never resolved by trustedOrcaExecute's returned runner", async () => {
  assert.equal(typeof TRUSTED_ORCA_EXECUTABLE_PLACEHOLDER, "string");
  assert.ok(TRUSTED_ORCA_EXECUTABLE_PLACEHOLDER.length > 0);
  const { execute, calls } = invocationOf();
  await execute([TRUSTED_ORCA_EXECUTABLE_PLACEHOLDER, "status"]);
  assert.equal(calls[0].argv[0], "/bin/bash");
  assert.ok(!calls[0].argv.includes(TRUSTED_ORCA_EXECUTABLE_PLACEHOLDER));
});

// Counterexample required by decision B item 3: TRUSTED_ORCA_EXECUTABLE_PLACEHOLDER
// is deliberately not a plausible binary name (unlike the earlier "orca"
// value it replaced), specifically so a caller that reaches the general,
// PATH-based runOrcaJson with it — because it forgot to also route through
// runTrustedOrcaJson/trustedOrcaExecute — fails loudly here instead of
// silently resolving whatever "orca" happens to mean on PATH.
test("runOrcaJson refuses outright when passed TRUSTED_ORCA_EXECUTABLE_PLACEHOLDER as the executable, never spawning anything", async () => {
  let spawnCalls = 0;
  const execute = async () => {
    spawnCalls += 1;
    return {
      code: 0,
      timedOut: false,
      stdout: '{"ok":true,"result":{}}',
      stderr: "",
    };
  };
  await assert.rejects(
    () =>
      runOrcaJson(TRUSTED_ORCA_EXECUTABLE_PLACEHOLDER, ["status"], { execute }),
    /reached the general, PATH-based runOrcaJson/,
  );
  assert.equal(
    spawnCalls,
    0,
    "runOrcaJson must refuse the placeholder before spawning anything",
  );
});

// runTrustedOrcaJson is the single entry point identity confirmation
// (verifiedPm) and auditor launch should call instead of composing
// runOrcaJson with a separately injected trusted execute (decision B item
// 1): it builds the trusted invocation itself, from options passed straight
// through to trustedOrcaExecute, so there is no executable/execute pair for
// a caller to assemble or forget half of.
test("runTrustedOrcaJson builds its invocation through trustedOrcaExecute, discards the placeholder argv[0], and parses the envelope", async () => {
  const { calls } = invocationOf();
  const spawnExecute = (argv, callOptions) => {
    calls.push({ argv, callOptions });
    return Promise.resolve({
      code: 0,
      timedOut: false,
      stdout: JSON.stringify({
        ok: true,
        result: { run: { id: "run-1", coordinator_handle: "term_pm_1" } },
      }),
      stderr: "",
    });
  };
  const result = await runTrustedOrcaJson(
    ["orchestration", "run-current", "--from", "term_pm_1"],
    {
      candidates: ["/usr/local/bin/orca"],
      exists: () => true,
      realpath: () => REAL_DARWIN_REALPATHS["/usr/local/bin/orca"],
      expectedRealpaths: REAL_DARWIN_REALPATHS,
      userInfo: () => ({ homedir: "/Users/injected", username: "injected" }),
      spawnExecute,
    },
  );
  assert.equal(result.result.run.coordinator_handle, "term_pm_1");
  assert.equal(calls.length, 1);
  const [{ argv }] = calls;
  assert.deepEqual(argv, [
    "/bin/bash",
    "--noprofile",
    "--norc",
    REAL_DARWIN_REALPATHS["/usr/local/bin/orca"],
    "orchestration",
    "run-current",
    "--from",
    "term_pm_1",
    "--json",
  ]);
});

test("runTrustedOrcaJson rejects an ok:false envelope and a non-zero exit the same way runOrcaJson's shared parsing does", async () => {
  await assert.rejects(
    () =>
      runTrustedOrcaJson(["orchestration", "run-current", "--from", "term_x"], {
        candidates: ["/usr/local/bin/orca"],
        exists: () => true,
        realpath: () => REAL_DARWIN_REALPATHS["/usr/local/bin/orca"],
        expectedRealpaths: REAL_DARWIN_REALPATHS,
        userInfo: () => ({ homedir: "/Users/injected", username: "injected" }),
        spawnExecute: () =>
          Promise.resolve({
            code: 0,
            timedOut: false,
            stdout: JSON.stringify({
              ok: false,
              error: { code: "not_found", message: "no such run" },
            }),
            stderr: "",
          }),
      }),
    /no such run/,
  );
});

// runTrustedOrcaJson propagates trustedOrcaExecute's own refusal (no
// candidate exists, or a realpath mismatch) rather than attempting a spawn —
// this reproduces decision B.5's requirement that a caller with no trusted
// executor available fails, rather than silently falling back to PATH.
test("runTrustedOrcaJson propagates trustedOrcaExecute's refusal when no trusted path exists, without spawning anything", async () => {
  let spawnCalls = 0;
  await assert.rejects(
    () =>
      runTrustedOrcaJson(["status"], {
        platform: "darwin",
        candidates: [],
        exists: () => true,
        spawnExecute: async () => {
          spawnCalls += 1;
          return { code: 0, timedOut: false, stdout: "{}", stderr: "" };
        },
      }),
    /No trusted Orca executable found/,
  );
  assert.equal(spawnCalls, 0);
});

// readTrustedOrcaVersion is the auditor launch's dedicated Orca `--version`
// probe (B.6, decision B, item 2): it must build its invocation through the
// same trustedOrcaExecute path as runTrustedOrcaJson, spawning
// `/bin/bash --noprofile --norc <resolved script> --version` with the
// placeholder discarded as argv[0], rather than run an auditor-branch
// `versionExecutable` through a plain, uninjected execute.
test("readTrustedOrcaVersion builds its invocation through trustedOrcaExecute, discards the placeholder argv[0], and parses the leading semver token", async () => {
  const calls = [];
  const spawnExecute = (argv, callOptions) => {
    calls.push({ argv, callOptions });
    return Promise.resolve({
      code: 0,
      timedOut: false,
      stdout: "orca 4.2.1 (build abc123)\n",
      stderr: "",
    });
  };
  const version = await readTrustedOrcaVersion({
    candidates: ["/usr/local/bin/orca"],
    exists: () => true,
    realpath: () => REAL_DARWIN_REALPATHS["/usr/local/bin/orca"],
    expectedRealpaths: REAL_DARWIN_REALPATHS,
    userInfo: () => ({ homedir: "/Users/injected", username: "injected" }),
    spawnExecute,
  });
  assert.equal(version, "4.2.1");
  assert.equal(calls.length, 1);
  const [{ argv }] = calls;
  assert.deepEqual(argv, [
    "/bin/bash",
    "--noprofile",
    "--norc",
    REAL_DARWIN_REALPATHS["/usr/local/bin/orca"],
    "--version",
  ]);
});

test("readTrustedOrcaVersion returns null when the trusted script's output carries no semver token", async () => {
  const version = await readTrustedOrcaVersion({
    candidates: ["/usr/local/bin/orca"],
    exists: () => true,
    realpath: () => REAL_DARWIN_REALPATHS["/usr/local/bin/orca"],
    expectedRealpaths: REAL_DARWIN_REALPATHS,
    userInfo: () => ({ homedir: "/Users/injected", username: "injected" }),
    spawnExecute: () =>
      Promise.resolve({
        code: 0,
        timedOut: false,
        stdout: "orca (unknown build)\n",
        stderr: "",
      }),
  });
  assert.equal(version, null);
});

test("readTrustedOrcaVersion throws on a non-zero exit or a timeout, rather than return a fabricated version", async () => {
  await assert.rejects(
    () =>
      readTrustedOrcaVersion({
        candidates: ["/usr/local/bin/orca"],
        exists: () => true,
        realpath: () => REAL_DARWIN_REALPATHS["/usr/local/bin/orca"],
        expectedRealpaths: REAL_DARWIN_REALPATHS,
        userInfo: () => ({ homedir: "/Users/injected", username: "injected" }),
        spawnExecute: () =>
          Promise.resolve({
            code: 1,
            timedOut: false,
            stdout: "",
            stderr: "orca: command failed",
          }),
      }),
    /orca: command failed/,
  );
});

// runTrustedOrcaJson propagates trustedOrcaExecute's own refusal (no
// candidate exists, or a realpath mismatch); readTrustedOrcaVersion must do
// the same, never falling back to a caller-controlled versionExecutable.
test("readTrustedOrcaVersion propagates trustedOrcaExecute's refusal when no trusted path exists, without spawning anything", async () => {
  let spawnCalls = 0;
  await assert.rejects(
    () =>
      readTrustedOrcaVersion({
        platform: "darwin",
        candidates: [],
        exists: () => true,
        spawnExecute: async () => {
          spawnCalls += 1;
          return { code: 0, timedOut: false, stdout: "orca 1.0.0", stderr: "" };
        },
      }),
    /No trusted Orca executable found/,
  );
  assert.equal(spawnCalls, 0);
});
