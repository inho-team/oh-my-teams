/**
 * @module tests/model-drift.test
 * @description Integration tests for model drift warnings across CLI command paths.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { main } from "../plugins/oh-my-teams/scripts/teams-org.mjs";
import { recordLaunch } from "../plugins/oh-my-teams/scripts/usage-ledger.mjs";

test("model drift warning for model: null profiles via command paths", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-test-"));
  fs.mkdirSync(path.join(dir, ".omt"), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const orgFile = path.join(dir, ".omt", "organization.json");
  const orgData = {
    schemaVersion: 1,
    revision: 1,
    name: "test",
    pools: {},
    profiles: {
      p1: {
        provider: "claude",
        command: ["claude"],
        account: "current",
        subscription: "test",
        model: null,
        modelResolvedAtFormation: "opus",
      },
      p3: {
        provider: "claude",
        command: ["claude"],
        account: "current",
        subscription: "test",
        model: "sonnet",
      },
    },
    roles: {
      pm: {
        parent: null,
        profile: "p1",
        concurrency: 1,
        attempts: 1,
        fallbacks: [],
      },
      pl: {
        parent: "pm",
        profile: "p1",
        concurrency: 1,
        attempts: 1,
        fallbacks: [],
      },
      junior: {
        parent: "pm",
        profile: "p3",
        concurrency: 1,
        attempts: 1,
        fallbacks: [],
      },
    },
    policy: {
      maxCalls: 1,
      onExhaustion: "stop",
      timeoutMs: 60000,
      repeatFailureLimit: 1,
      supervision: { progressCheckMs: 60000, unansweredLimit: 2 },
    },
  };
  fs.writeFileSync(orgFile, JSON.stringify(orgData, null, 2));

  const fakeOrcaScript = path.join(dir, "fake-orca.mjs");
  fs.writeFileSync(
    fakeOrcaScript,
    `
    const argsStr = process.argv.join(" ");
    if (!argsStr.includes("terminal") && !argsStr.includes("worktree") && !argsStr.includes("orchestration") && !argsStr.includes("status") && !argsStr.includes("--version")) process.exit(0);
    let out = { ok: true };
    if (argsStr.includes("wait")) out = { ok: true, result: { wait: { satisfied: true } } };
    else if (argsStr.includes("dispatch")) out = { ok: true, result: { dispatch: { id: "d_1", run_id: "r_1" } } };
    else if (argsStr.includes("worker-start")) out = { ok: true, result: { dispatchId: "d_1", runId: "r_1" } };
    else if (argsStr.includes("create") && argsStr.includes("terminal")) out = { ok: true, result: { terminal: { handle: "term_1", tail: [] } } };
    else if (argsStr.includes("read") && argsStr.includes("terminal")) out = { ok: true, result: { terminal: { tail: ["STARTED"] } } };
    else if (argsStr.includes("status")) out = { ok: true, result: { runtime: { reachable: true, state: "ready" }, orca: { version: "3.2.0" } } };
    else if (argsStr.includes("show") && argsStr.includes("worktree")) out = { ok: true, result: { worktree: { id: "repo", path: "${dir.replace(/\\/g, "\\\\")}" } } };
    
    import fs from "node:fs";
    fs.appendFileSync("${dir.replace(/\\/g, "\\\\")}/orca-trace.txt", argsStr + "\\n");
    fs.writeSync(1, JSON.stringify(out) + "\\n");
    process.exit(0);
  `,
  );

  const fakeOrca = process.execPath;
  const origNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--import "file://${fakeOrcaScript.replace(/\\/g, "/")}"`;

  const claudeHome = path.join(dir, ".claude");
  fs.mkdirSync(claudeHome);
  const settingsFile = path.join(claudeHome, "settings.json");

  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  const origAnthropic = process.env.ANTHROPIC_MODEL;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.ANTHROPIC_MODEL = "";

  const setModel = (m) =>
    fs.writeFileSync(settingsFile, JSON.stringify({ model: m }));

  const origLog = console.log;
  t.after(() => {
    console.log = origLog;
    if (origNodeOptions !== undefined)
      process.env.NODE_OPTIONS = origNodeOptions;
    else delete process.env.NODE_OPTIONS;
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origUserProfile !== undefined)
      process.env.USERPROFILE = origUserProfile;
    else delete process.env.USERPROFILE;
    if (origAnthropic !== undefined)
      process.env.ANTHROPIC_MODEL = origAnthropic;
    else delete process.env.ANTHROPIC_MODEL;
  });

  const runCmd = async (args) => {
    let lastOutput = null;
    console.log = (out) => {
      lastOutput = out;
    };
    await main(args);
    return JSON.parse(lastOutput);
  };

  const wtArg = `id:repo::${dir.replace(/\\/g, "/")}`;

  setModel("sonnet");
  const res1 = await runCmd([
    "role-terminal",
    "--org",
    orgFile,
    "--role",
    "pm",
    "--worktree",
    wtArg,
    "--orca",
    fakeOrca,
  ]);
  assert.equal(
    res1.warnings.some((w) => w.includes("opus에서 sonnet")),
    true,
    "A: warning should be emitted for role-terminal drift",
  );

  setModel("haiku");
  const res2 = await runCmd([
    "worker-start",
    "--org",
    orgFile,
    "--role",
    "pl",
    "--repo",
    dir,
    "--terminal",
    "t1",
    "--task",
    "task1",
    "--orca",
    fakeOrca,
  ]);
  assert.equal(
    res2.warnings.some((w) => w.includes("sonnet에서 haiku")),
    true,
    "B: warning should be emitted for worker-start drift",
  );

  const res3 = await runCmd([
    "worker-start",
    "--org",
    orgFile,
    "--role",
    "pl",
    "--repo",
    dir,
    "--terminal",
    "t2",
    "--task",
    "task2",
    "--orca",
    fakeOrca,
  ]);
  assert.ok(
    !res3.warnings?.some((w) => w.includes("에서")),
    "C: no warning if model hasn't changed",
  );

  const res4 = await runCmd([
    "role-terminal",
    "--org",
    orgFile,
    "--role",
    "pm",
    "--worktree",
    wtArg,
    "--orca",
    fakeOrca,
  ]);
  assert.ok(
    !res4.warnings?.some((w) => w.includes("에서")),
    "C: no warning if model hasn't changed (role-terminal) - got: " +
      JSON.stringify(res4.warnings),
  );

  setModel("opus");
  const res5 = await runCmd([
    "role-terminal",
    "--org",
    orgFile,
    "--role",
    "junior",
    "--worktree",
    wtArg,
    "--orca",
    fakeOrca,
  ]);
  assert.ok(
    !res5.warnings?.some((w) => w.includes("에서")),
    "D: fixed model profile should not warn",
  );

  const res6 = await runCmd([
    "worker-start",
    "--org",
    orgFile,
    "--role",
    "junior",
    "--repo",
    dir,
    "--terminal",
    "t3",
    "--task",
    "task3",
    "--orca",
    fakeOrca,
  ]);
  assert.ok(
    !res6.warnings?.some((w) => w.includes("에서")),
    "D: fixed model profile should not warn (worker-start)",
  );
});
