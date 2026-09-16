/** Covers launching a role from its saved profile instead of hand-built argv. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ROLES,
  readJSON,
  writeJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  launchBinding,
  readRoleCharter,
  resolveRoleLaunch,
  roleCommand,
  roleSpec,
} from "../plugins/oh-my-teams/scripts/role-launch.mjs";
import { resolveHostDefaults } from "../plugins/oh-my-teams/scripts/host-defaults.mjs";
import { draftOrganization } from "../plugins/oh-my-teams/scripts/org-draft.mjs";
import { main } from "../plugins/oh-my-teams/scripts/teams-org.mjs";

const example = () =>
  readJSON(
    new URL(
      "../plugins/oh-my-teams/examples/organization.json",
      import.meta.url,
    ),
  );

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-role-launch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a role launches with the agent and model its profile pins", () => {
  // The incident: PL was bound to a Codex profile, yet the coordinator typed
  // `worker-start --agent codex` with no --model and PL ran on another model.
  const launch = resolveRoleLaunch(example(), "pl");
  assert.equal(launch.role, "pl");
  assert.equal(launch.provider, "codex");
  assert.equal(launch.agent, "codex");
  assert.equal(launch.model, "gpt-5.6-sol");
  assert.equal(launch.effort, null);
});

test("a host-default profile launches without a model and says so", () => {
  const org = draftOrganization({
    name: "team",
    tiers: 2,
    models: ["claude:default", "codex:default"],
  });
  const launch = resolveRoleLaunch(org, "junior");
  assert.equal(launch.agent, "codex");
  assert.equal(launch.model, null);

  const binding = launchBinding(launch, { receipt: { result: {} } });
  assert.equal(binding.modelRequested, null);
  assert.equal(binding.modelProof, "unrequested");
});

test("an explicit agent, model or effort that contradicts the profile is refused", () => {
  const org = example();
  assert.throws(
    () => resolveRoleLaunch(org, "pl", { agent: "claude" }),
    /agent claude contradicts .*codex/,
  );
  assert.throws(
    () => resolveRoleLaunch(org, "pl", { model: "gpt-6-astra" }),
    /model gpt-6-astra contradicts .*gpt-5\.6-sol/,
  );
  assert.throws(
    () => resolveRoleLaunch(org, "pl", { effort: "high" }),
    /effort high contradicts/,
  );
  // Naming a model for a host-default profile would claim a choice the user
  // never saved.
  org.roles.pl.profile = "claude-current";
  assert.throws(
    () => resolveRoleLaunch(org, "pl", { model: "opus" }),
    /model opus contradicts .*host default/,
  );
  // Restating the saved values is not a contradiction.
  org.roles.pl.profile = "codex-terra";
  const launch = resolveRoleLaunch(org, "pl", {
    agent: "codex",
    model: "gpt-5.6-terra",
    effort: "high",
  });
  assert.equal(launch.effort, "high");
});

test("a provider Orca cannot launch with a model points at the custom argv path", () => {
  // Senior in the example is an Agy profile. Orca has no `agy` agent and its
  // --model covers Claude, Codex and Cursor only.
  assert.throws(
    () => resolveRoleLaunch(example(), "senior"),
    /agy.*custom argv.*orca-runtime\.md/s,
  );
});

test("a named account cannot be expressed by an Orca agent id", () => {
  const org = example();
  org.profiles["codex-current"] = {
    ...org.profiles["codex-current"],
    account: "work",
    command: ["codex", "--profile", "work"],
  };
  assert.throws(
    () => resolveRoleLaunch(org, "pl"),
    /current account.*custom argv/s,
  );
});

test("PM is the coordinator and is never started as a worker", () => {
  assert.throws(() => resolveRoleLaunch(example(), "pm"), /coordinator/);
  // A reduced team folds PL's work onto PM, which then does it itself.
  const org = draftOrganization({
    name: "team",
    tiers: 2,
    models: ["claude:default", "codex:default"],
  });
  assert.throws(() => resolveRoleLaunch(org, "pl"), /pl.*folds to pm/s);
});

test("the launch receipt proves the model only when Orca applied the request", () => {
  const launch = resolveRoleLaunch(example(), "pl");
  const receipt = (effective) => ({
    receipt: { result: { launch: { requested: {}, effective } } },
  });
  assert.equal(
    launchBinding(launch, receipt({ model: "gpt-5.6-sol" })).modelProof,
    "matched",
  );
  assert.equal(
    launchBinding(launch, receipt({ model: "gpt-6-astra" })).modelProof,
    "mismatched",
  );
  assert.equal(launchBinding(launch, receipt(null)).modelProof, "unproven");
  assert.equal(
    launchBinding(launch, receipt({ model: "gpt-5.6-sol" }), {
      reusedTerminal: true,
    }).modelProof,
    "unproven",
  );
});

test("the coordinator command carries the model the PM profile pins", () => {
  // `orca worktree create --agent` has no --model, so a pinned PM model was
  // silently dropped. The coordinator is launched from this argv instead.
  const org = example();
  org.profiles["claude-current"].model = "opus[1m]";
  const pm = roleCommand(org, "pm");
  assert.deepEqual(pm.argv, ["claude", "--model", "opus[1m]"]);
  // Brackets are a glob in POSIX shells, so the command string quotes them.
  assert.equal(pm.command, "claude --model 'opus[1m]'");

  org.roles.pm.profile = "codex-terra";
  assert.deepEqual(roleCommand(org, "pm").argv, [
    "codex",
    "--model",
    "gpt-5.6-terra",
    "--config",
    "model_reasoning_effort=high",
  ]);

  org.roles.pm.profile = "claude-current";
  org.profiles["claude-current"].model = null;
  const unpinned = roleCommand(org, "pm");
  assert.deepEqual(unpinned.argv, ["claude"]);
  assert.equal(unpinned.modelRequested, null);

  org.roles.pm.profile = "agy-opus";
  assert.throws(() => roleCommand(org, "pm"), /custom argv/);
});

test("every role skill states its authority, responsibility and limits", () => {
  for (const role of ROLES) {
    const charter = readRoleCharter(role);
    assert.match(charter, /^## 권한·책임·한계/);
    for (const part of ["### 권한", "### 책임", "### 한계"]) {
      assert.ok(charter.includes(part), `${role} charter lacks ${part}`);
    }
    // The next section must not leak into the charter a worker receives.
    assert.equal(charter.match(/^## /gm).length, 1);
  }
});

test("a spec handed to a subordinate opens with that role's charter", () => {
  const org = draftOrganization({
    name: "team",
    tiers: 3,
    models: ["claude:default", "codex:default", "codex:default"],
  });
  const spec = roleSpec(org, "junior", "value.txt의 오타를 고친다.");
  const [header, task] = spec.split("\n# 작업\n");
  assert.match(header, /^# oh my teams 역할 지시\n역할: Junior/);
  assert.match(header, /보고 대상: Senior/);
  // Intern is not declared in a three-tier team, so Junior carries its work.
  assert.match(header, /이번 실행에 없어 이어받는 역할: Intern/);
  assert.match(header, /직접 배정할 수 있는 역할: 없음/);
  assert.ok(header.includes(readRoleCharter("junior")));
  assert.equal(task.trim(), "value.txt의 오타를 고친다.");

  const pl = roleSpec(example(), "pl", "분할한다.");
  assert.match(pl, /직접 배정할 수 있는 역할: Senior, Junior, Intern/);

  // A run at a shallower depth folds with its own role list, not the ladder.
  const shallow = roleSpec(example(), "junior", "고친다.", {
    roles: ["pm", "junior"],
  });
  assert.match(shallow, /보고 대상: PM/);
  assert.match(shallow, /이번 실행에 없어 이어받는 역할: Intern/);
  assert.throws(
    () => resolveRoleLaunch(example(), "pl", {}, { roles: ["pm", "junior"] }),
    /pl.*folds to pm/s,
  );
  assert.equal(
    resolveRoleLaunch(example(), "intern", {}, { roles: ["pm", "pl"] }).role,
    "pl",
  );
});

test("worker-start requires the organization and role and refuses before Orca", async (t) => {
  const dir = tempDir(t);
  const orgFile = path.join(dir, "organization.json");
  writeJSON(orgFile, example());

  await assert.rejects(
    () =>
      main(["worker-start", "--repo", dir, "--spec", "x", "--agent", "codex"]),
    /--org required/,
  );
  // The Agy refusal happens while reading the profile, so no Orca executable
  // is ever resolved; a missing binary would otherwise mask it.
  await assert.rejects(
    () =>
      main([
        "worker-start",
        "--repo",
        dir,
        "--org",
        orgFile,
        "--role",
        "senior",
        "--spec",
        "x",
        "--orca",
        path.join(dir, "missing-orca"),
      ]),
    /custom argv/,
  );
});

test("host defaults name what a default profile runs today", async (t) => {
  const home = tempDir(t);
  const codexHome = path.join(home, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  const catalog = JSON.stringify({
    models: [
      { slug: "gpt-5.6-sol", visibility: "list", priority: 4 },
      { slug: "gpt-reserve", visibility: "hide", priority: 0 },
      { slug: "gpt-6-astra", visibility: "list", priority: 1 },
    ],
  });
  const execute = async (argv) => {
    assert.deepEqual(argv, ["codex", "debug", "models"]);
    return { code: 0, stdout: catalog, stderr: "", timedOut: false };
  };

  const unset = await resolveHostDefaults({ home, env: {}, execute });
  // The incident: no `model` key, so Codex ran the first listed model.
  assert.equal(unset.codex.model, "gpt-6-astra");
  assert.equal(unset.codex.source, "catalog");
  assert.deepEqual(unset.codex.listed, ["gpt-6-astra", "gpt-5.6-sol"]);
  assert.equal(unset.claude.model, null);
  assert.equal(unset.claude.source, null);

  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    'personality = "pragmatic"\nmodel = "gpt-5.6-sol"\n\n[profiles.x]\nmodel = "gpt-5.5"\n',
  );
  fs.mkdirSync(path.join(home, ".claude"));
  writeJSON(path.join(home, ".claude", "settings.json"), { model: "opus[1m]" });
  const pinned = await resolveHostDefaults({ home, env: {}, execute });
  assert.equal(pinned.codex.model, "gpt-5.6-sol");
  assert.equal(pinned.codex.source, "config.toml");
  assert.equal(pinned.claude.model, "opus[1m]");

  const overridden = await resolveHostDefaults({
    home,
    env: { ANTHROPIC_MODEL: "sonnet" },
    execute,
  });
  assert.equal(overridden.claude.model, "sonnet");
  assert.equal(overridden.claude.source, "env:ANTHROPIC_MODEL");

  // Orca may launch Codex with its own CODEX_HOME; that home is what counts.
  const launcherHome = tempDir(t);
  const fromLauncher = await resolveHostDefaults({
    home,
    env: {},
    codexHome: launcherHome,
    execute,
  });
  assert.equal(fromLauncher.codex.model, "gpt-6-astra");
  assert.equal(
    fromLauncher.codex.configFile,
    path.join(launcherHome, "config.toml"),
  );

  const missing = await resolveHostDefaults({
    home: tempDir(t),
    env: {},
    execute: async () => ({
      code: 1,
      stdout: "",
      stderr: "nope",
      timedOut: false,
    }),
  });
  assert.equal(missing.codex.model, null);
  assert.match(missing.codex.error, /nope/);
});
