/** OpenCodex runner provider support validation. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateOrg,
  saveOrg,
  readJSON,
  run,
  writeJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  OPENCODEX_RUNNER_PROVIDERS,
  validateOpenCodexRunner,
} from "../plugins/oh-my-teams/scripts/opencodex.mjs";
import { roleCommand } from "../plugins/oh-my-teams/scripts/role-launch.mjs";

const cli = path.resolve("plugins/oh-my-teams/scripts/teams-org.mjs");
const fingerprint = `sha256:${"a".repeat(64)}`;

const example = () =>
  readJSON(
    new URL(
      "../plugins/oh-my-teams/examples/organization.json",
      import.meta.url,
    ),
  );

const runnerFor = (account) => ({
  kind: "opencodex",
  mode: "fixed-account",
  accountHomeRef: account,
  runtimeFingerprint: fingerprint,
});

// The example organization with its PM moved onto a profile that carries a
// runner block, so the whole document (not just one profile) is validated.
function runnerOrg(provider, command = [provider]) {
  const org = example();
  org.profiles.ocx = {
    provider,
    command,
    account: "fixed-account",
    subscription: "Fixed subscription",
    model: "model-x",
    runner: runnerFor("fixed-account"),
  };
  org.roles.pm.profile = "ocx";
  return org;
}

const rejection = (id, provider) => ({
  message: `Invalid OpenCodex runner binding: ${id} (provider ${provider} does not support runners)`,
});

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-runner-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("OPENCODEX_RUNNER_PROVIDERS contains only supported providers", () => {
  assert.ok(Array.isArray(OPENCODEX_RUNNER_PROVIDERS));
  assert.ok(Object.isFrozen(OPENCODEX_RUNNER_PROVIDERS));
  assert.deepEqual(OPENCODEX_RUNNER_PROVIDERS, ["codex"]);
});

test("codex runner profile passes validation", () => {
  assert.doesNotThrow(() => validateOrg(runnerOrg("codex")));
});

test("claude provider with runner is rejected in validation with its profile ID and provider", () => {
  assert.throws(
    () => validateOrg(runnerOrg("claude")),
    rejection("ocx", "claude"),
  );
});

test("agy provider with runner is rejected in validation with its profile ID and provider", () => {
  assert.throws(() => validateOrg(runnerOrg("agy")), rejection("ocx", "agy"));
});

test("profile without runner is not affected by provider check", () => {
  const org = example();
  assert.equal(validateOrg(org), org);
});

test("runtime validation rejects claude and agy providers naming the profile ID", () => {
  for (const provider of ["claude", "agy"]) {
    const profile = {
      provider,
      account: "acct-x",
      model: "m1",
      runner: runnerFor("acct-x"),
    };
    const runtime = { prefixFingerprint: fingerprint };
    assert.throws(
      () => validateOpenCodexRunner(profile, runtime, "p-x"),
      rejection("p-x", provider),
    );
    // Without a caller-supplied ID the message still names the provider.
    assert.throws(
      () => validateOpenCodexRunner(profile, runtime),
      rejection("(unknown)", provider),
    );
  }
  const codex = {
    provider: "codex",
    account: "acct-x",
    model: "m1",
    runner: runnerFor("acct-x"),
  };
  assert.equal(
    validateOpenCodexRunner(codex, { prefixFingerprint: fingerprint }, "p-x"),
    codex.runner,
  );
});

test("roleCommand carries the profile ID and the executable it launches as actualRunner", () => {
  const org = runnerOrg("codex", ["claude"]);
  const { runner, argv } = roleCommand(org, "pm");
  assert.equal(argv[0], "claude");
  assert.equal(runner.logicalProvider, "codex");
  assert.equal(runner.actualRunner, "claude");
  assert.equal(runner.profileId, "ocx");
  assert.equal(
    roleCommand(runnerOrg("codex"), "pm").runner.actualRunner,
    "codex",
  );
  for (const command of ["codex.exe", "codex.cmd"]) {
    assert.equal(
      roleCommand(runnerOrg("codex", [command]), "pm").runner.actualRunner,
      "codex",
    );
  }
});

test("saveOrg rejects an unsupported runner provider on create and on edit", (t) => {
  const orgFile = path.join(tempDir(t), "org.json");
  assert.throws(
    () => saveOrg(orgFile, runnerOrg("claude")),
    rejection("ocx", "claude"),
  );
  assert.equal(fs.existsSync(orgFile), false);

  saveOrg(orgFile, example());
  assert.throws(
    () =>
      saveOrg(orgFile, runnerOrg("agy"), { update: true, expectedRevision: 1 }),
    rejection("ocx", "agy"),
  );
  assert.equal(readJSON(orgFile).revision, 1);
  assert.equal(readJSON(orgFile).profiles.ocx, undefined);
});

test("validate, init and edit commands reject an unsupported runner provider", async (t) => {
  const dir = tempDir(t);
  const bad = path.join(dir, "bad.json");
  writeJSON(bad, runnerOrg("claude"));
  const cliRun = (...args) =>
    run([process.execPath, cli, ...args], { cwd: dir });
  const pattern =
    /Invalid OpenCodex runner binding: ocx \(provider claude does not support runners\)/;

  const validated = await cliRun("validate", "--org", bad);
  assert.notEqual(validated.code, 0);
  assert.match(validated.stderr, pattern);

  const initFile = path.join(dir, "init.json");
  const initialized = await cliRun("init", "--org", initFile, "--from", bad);
  assert.notEqual(initialized.code, 0);
  assert.match(initialized.stderr, pattern);
  assert.equal(fs.existsSync(initFile), false);

  const orgFile = path.join(dir, "org.json");
  writeJSON(orgFile, example());
  const edited = await cliRun(
    "edit",
    "--org",
    orgFile,
    "--from",
    bad,
    "--revision",
    "1",
  );
  assert.notEqual(edited.code, 0);
  assert.match(edited.stderr, pattern);
  assert.equal(readJSON(orgFile).profiles.ocx, undefined);
});
