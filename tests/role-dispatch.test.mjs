/** Covers launching a role from its saved profile instead of hand-built argv. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ROLES,
  readJSON,
  run,
  writeJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  attachExecution,
  createWorkflow,
  readWorkflow,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";
import {
  assertWorktreeUnshared,
  launchBinding,
  PERMISSION_BYPASS,
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
  // The incident: PL was bound to a Codex profile, yet the PM typed
  // `worker-start --agent codex` with no --model and PL ran on another model.
  const launch = resolveRoleLaunch(example(), "pl", {}, { terminal: "t1" });
  assert.equal(launch.role, "pl");
  assert.equal(launch.provider, "codex");
  assert.equal(launch.agent, "codex");
  assert.equal(launch.via, "terminal");
  assert.equal(launch.model, "gpt-5.6-sol");
  assert.equal(launch.effort, null);
});

test("a host-default profile launches without a model and says so", () => {
  const org = draftOrganization({
    name: "team",
    tiers: 2,
    models: ["claude:default", "codex:default"],
  });
  const launch = resolveRoleLaunch(org, "junior", {}, { terminal: "t1" });
  assert.equal(launch.agent, "codex");
  assert.equal(launch.model, null);

  const binding = launchBinding(launch);
  assert.equal(binding.modelRequested, null);
  assert.equal(binding.modelProof, "unrequested");
});

test("no Claude or Codex role is started by agent id, which cannot carry the bypass flag", () => {
  // A Codex PL started with `worker-start --agent codex --model` stopped at
  // "Would you like to run the following command?": worker-start has no
  // argument option, and Orca's per-agent default arguments are a user
  // setting that was empty for claude and codex. Every role is opened with
  // role-terminal, whose command carries the flag and the model, and handed
  // its task with --terminal.
  const org = example();
  org.roles.junior.profile = "claude-current";
  org.profiles["claude-current"].model = "sonnet";
  for (const [role, provider] of [
    ["pl", "codex"],
    ["junior", "claude"],
    ["senior", "agy"],
  ]) {
    assert.throws(
      () => resolveRoleLaunch(org, role),
      new RegExp(`${provider}.*role-terminal.*--terminal`, "s"),
    );
    // Restating the profile does not reopen a launch by agent id either.
    const { agent, model } = resolveRoleLaunch(
      org,
      role,
      {},
      { terminal: "t1" },
    );
    assert.throws(
      () => resolveRoleLaunch(org, role, { agent, model }),
      /role-terminal/,
    );
    const command = roleCommand(org, role);
    assert.equal(command.argv[1], PERMISSION_BYPASS[provider]);
    assert.equal(command.argv[command.argv.indexOf("--model") + 1], model);
  }
});

test("an Agy role starts in a terminal opened with its model, never by agent id", () => {
  // Senior in the example is an Agy profile. Orca's --model covers Claude,
  // Codex and Cursor only, so refusing Agy outright left every Agy role with
  // no sanctioned launch at all.
  assert.throws(
    () => resolveRoleLaunch(example(), "senior"),
    /agy.*role-terminal.*--terminal/s,
  );
  const launch = resolveRoleLaunch(example(), "senior", {}, { terminal: "t1" });
  assert.equal(launch.via, "terminal");
  assert.equal(launch.agent, "antigravity");
  assert.equal(launch.model, "gemini-3.8-flash-high");
  const binding = launchBinding(launch);
  assert.equal(binding.modelProof, "unproven");
  assert.equal(binding.screenCheck, "required");

  const command = roleCommand(example(), "senior");
  assert.deepEqual(command.argv, [
    "agy",
    "--dangerously-skip-permissions",
    "--model",
    "gemini-3.8-flash-high",
  ]);

  // Ollama has no interactive agent in Orca; its roles run through `work`.
  const org = example();
  org.profiles.local = {
    provider: "ollama",
    endpoint: "http://127.0.0.1:11434",
    account: "current",
    subscription: "Local",
    model: "qwen3:8b",
    contextTokens: 32768,
  };
  org.roles.intern.profile = "local";
  assert.throws(
    () => resolveRoleLaunch(org, "intern", {}, { terminal: "t1" }),
    /ollama.*work/s,
  );
});

test("a reused terminal takes no launch values, matching or not", () => {
  // Orca refuses --model and --effort with --terminal. Accepting a matching
  // value there while dropping it silently read as if it had been applied.
  for (const explicit of [
    { model: "gpt-5.6-sol" },
    { effort: "high" },
    { agent: "codex" },
  ]) {
    assert.throws(
      () => resolveRoleLaunch(example(), "pl", explicit, { terminal: "t1" }),
      /--terminal/,
    );
  }
});

test("a named account or a path command cannot be launched as a plain name", () => {
  const org = example();
  org.profiles["codex-current"] = {
    ...org.profiles["codex-current"],
    account: "work",
    command: ["codex", "--profile", "work"],
  };
  assert.throws(
    () => resolveRoleLaunch(org, "pl", {}, { terminal: "t1" }),
    /current account/,
  );
  // PowerShell runs a quoted path as a string, not as a command.
  const pathOrg = example();
  pathOrg.profiles["claude-current"].command = ["C:\\Tools\\claude.cmd"];
  assert.throws(() => roleCommand(pathOrg, "pm"), /bare executable name/);
});

test("PM is never started as a worker", () => {
  assert.throws(
    () => resolveRoleLaunch(example(), "pm"),
    /PM runs in its own terminal/,
  );
  // A reduced team folds PL's work onto PM, which then does it itself.
  const org = draftOrganization({
    name: "team",
    tiers: 2,
    models: ["claude:default", "codex:default"],
  });
  assert.throws(() => resolveRoleLaunch(org, "pl"), /pl is not declared/);
  // A declared role left out of this run's depth says so instead.
  assert.throws(
    () => resolveRoleLaunch(example(), "pl", {}, { roles: ["pm", "junior"] }),
    /pl is not in this run's roles/,
  );
});

test("a role handed its task in a terminal proves its model on the screen only", () => {
  // Orca records no model for a --terminal start, and the terminal keeps the
  // model its command was opened with, so only the screen can confirm it.
  const terra = example();
  terra.roles.pl.profile = "codex-terra";
  const launch = resolveRoleLaunch(terra, "pl", {}, { terminal: "t1" });
  const binding = launchBinding(launch);
  assert.equal(binding.via, "terminal");
  assert.equal(binding.modelRequested, "gpt-5.6-terra");
  assert.equal(binding.effortRequested, "high");
  assert.equal(binding.modelProof, "unproven");
  assert.equal(binding.screenCheck, "required");
});

test("the PM command carries the model the PM profile pins", () => {
  // `orca worktree create --agent` has no --model, so a pinned PM model was
  // silently dropped. The PM is launched from this argv instead.
  const org = example();
  org.profiles["claude-current"].model = "opus[1m]";
  const pm = roleCommand(org, "pm");
  assert.deepEqual(pm.argv, [
    "claude",
    "--dangerously-skip-permissions",
    "--model",
    "opus[1m]",
  ]);
  // Brackets are a glob in POSIX shells, so the command string quotes them.
  assert.equal(
    pm.command,
    "claude --dangerously-skip-permissions --model 'opus[1m]'",
  );

  org.roles.pm.profile = "codex-terra";
  assert.deepEqual(roleCommand(org, "pm").argv, [
    "codex",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    "gpt-5.6-terra",
    "--config",
    "model_reasoning_effort=high",
  ]);

  org.roles.pm.profile = "claude-current";
  org.profiles["claude-current"].model = null;
  const unpinned = roleCommand(org, "pm");
  assert.deepEqual(unpinned.argv, ["claude", "--dangerously-skip-permissions"]);
  assert.equal(unpinned.modelRequested, null);

  org.roles.pm.profile = "agy-opus";
  assert.deepEqual(roleCommand(org, "pm").argv, [
    "agy",
    "--dangerously-skip-permissions",
    "--model",
    "claude-opus-4-6-thinking",
  ]);
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
  // Every worker reads only its spec, so the BLUF rule rides in the header
  // and points at a reference that exists wherever the worker runs.
  assert.match(
    header,
    /보고는 두괄식으로 쓴다\. 첫 줄은 `완료`·`부분 완료`·`실패`·`차단`/,
  );
  const bluf = header.match(/^두괄식 기준 전문: (.+)$/m)?.[1];
  assert.ok(bluf && path.isAbsolute(bluf) && fs.existsSync(bluf), bluf);

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
    /folds to pm/,
  );

  // A nested supervisor is told where the organization and the workflow live.
  const located = roleSpec(example(), "pl", "나눈다.", {
    orgFile: "/p/.omt/organization.json",
    workflowId: "wf-1",
    stateDir: "/c/.omt",
  });
  assert.match(located, /조직 파일: \/p\/\.omt\/organization\.json/);
  assert.match(located, /workflow: wf-1 \(state \/c\/\.omt\)/);
  assert.throws(
    () =>
      resolveRoleLaunch(
        example(),
        "intern",
        {},
        { roles: ["pm", "pl"], terminal: "t1" },
      ),
    /intern is not in this run's roles; its work folds to pl/,
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
  // The refusal happens while reading the profile, so no Orca executable is
  // ever resolved; a missing binary would otherwise mask it.
  for (const role of ["pl", "senior"]) {
    await assert.rejects(
      () =>
        main([
          "worker-start",
          "--repo",
          dir,
          "--org",
          orgFile,
          "--role",
          role,
          "--spec",
          "x",
          "--orca",
          path.join(dir, "missing-orca"),
        ]),
      /role-terminal/,
    );
  }
  // The injection exception exists for Orca's Agy idle check; a Claude or
  // Codex terminal that is not idle is busy or blocked, not unseen.
  await assert.rejects(
    () =>
      main([
        "worker-start",
        "--repo",
        dir,
        "--org",
        orgFile,
        "--role",
        "pl",
        "--spec",
        "x",
        "--terminal",
        "term_1",
        "--inject-fallback",
        "사용자가 주입을 승인했다",
        "--orca",
        path.join(dir, "missing-orca"),
      ]),
    /--inject-fallback applies only to agy/,
  );
  // Orca creates no worktree for a reused terminal, so the pair is refused
  // before the idle probe spends its wait.
  await assert.rejects(
    () =>
      main([
        "worker-start",
        "--repo",
        dir,
        "--org",
        orgFile,
        "--role",
        "pl",
        "--spec",
        "x",
        "--terminal",
        "term_1",
        "--worktree",
        "new-child",
        "--orca",
        path.join(dir, "missing-orca"),
      ]),
    /--terminal cannot start in new-child/,
  );
});

test("a terminal is opened and handed work only for a role the run holds", async (t) => {
  // role-command folded against the live file while worker-start folded
  // against the run, so an Agy terminal built for Intern was accepted as the
  // Codex Junior the run folded Intern onto.
  const org = example();
  org.profiles["codex-55"] = {
    provider: "codex",
    command: ["codex"],
    account: "current",
    subscription: "Codex",
    model: "gpt-5.5",
  };
  org.roles.junior.profile = "codex-55";
  org.roles.intern.profile = "agy-oss";
  const roles = ["pm", "senior", "junior"];
  assert.throws(
    () => roleCommand(org, "intern", { roles }),
    /intern is not in this run's roles.*junior/s,
  );
  assert.throws(
    () => resolveRoleLaunch(org, "intern", {}, { roles, terminal: "t1" }),
    /intern is not in this run's roles.*junior/s,
  );
  assert.equal(
    resolveRoleLaunch(org, "junior", {}, { roles, terminal: "t1" }).role,
    "junior",
  );
  // Asking for the role that does hold the work is fine, and PM is PM.
  assert.equal(roleCommand(org, "junior", { roles }).argv[3], "gpt-5.5");
  assert.equal(roleCommand(org, "pm", { roles }).role, "pm");
  assert.throws(
    () => roleCommand(org, "pl", { roles }),
    /not in this run's roles/,
  );

  // Through the CLI, role-command reads the frozen organization and roles.
  const state = tempDir(t);
  const repo = await workflowRepo(t);
  await createWorkflow(
    state,
    {
      schemaVersion: 1,
      id: "wf-2",
      goal: "Fix a typo",
      repo: ".",
      depth: 3,
      tasks: [{ file: "task-a.json", role: "junior" }],
      policy: { maxRunning: 1, maxReviewPending: 1 },
      budget: { maxAttempts: 1, maxCalls: 1 },
    },
    org,
    repo,
  );
  const live = example();
  live.profiles["agy-oss"].model = "gpt-oss-120b-medium";
  live.roles.junior.profile = "codex-luna";
  const orgFile = path.join(repo, "organization.json");
  writeJSON(orgFile, live);
  const common = ["--org", orgFile, "--workflow-id", "wf-2", "--state", state];
  const printed = await capture(() =>
    main(["role-command", "--role", "junior", ...common]),
  );
  assert.deepEqual(JSON.parse(printed).argv, [
    "codex",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    "gpt-5.5",
  ]);
  await assert.rejects(
    () => main(["role-command", "--role", "intern", ...common]),
    /not in this run's roles/,
  );
});

test("a role does not start in the worktree another role's task works in", async (t) => {
  // literacy-test: PM opened the Agy Senior reviewer in Junior's worktree
  // because Agy had been trusted there, and the review's Playwright files were
  // left uncommitted beside Junior's report.
  const juniorId = "repo-1::/w/literacy-test/literacy-report-junior";
  const plId = "repo-1::/w/literacy-test/literacy-pl";
  const state = {
    tasks: {
      report: {
        role: "junior",
        execution: { worktreeId: juniorId },
        attempts: [{ receipt: { worktreeId: juniorId, role: "junior" } }],
      },
      split: { role: "pl", attempts: [{ receipt: { worktreeId: plId } }] },
      waiting: { role: "intern", attempts: [{ id: "reserved" }] },
    },
  };
  const pmWorktree = "/w/literacy-test/literacy-site-research-2";
  assert.throws(
    () => assertWorktreeUnshared(state, "senior", `id:${juniorId}`, pmWorktree),
    /literacy-report-junior is where junior works on task report; senior does not start there/,
  );
  assert.throws(
    () =>
      assertWorktreeUnshared(
        state,
        "senior",
        "current",
        "/w/literacy-test/literacy-report-junior",
      ),
    /where junior works/,
  );
  assert.throws(
    () =>
      assertWorktreeUnshared(
        state,
        "pl",
        `path:/w/literacy-test/literacy-report-junior`,
        pmWorktree,
      ),
    /where junior works/,
  );
  // The owner itself, a role the owner supervises, a new child worktree, the
  // PM's own worktree, and a launch outside any workflow all pass.
  assertWorktreeUnshared(state, "junior", `id:${juniorId}`, pmWorktree);
  assertWorktreeUnshared(
    state,
    "senior",
    "current",
    "/w/literacy-test/literacy-pl",
  );
  assertWorktreeUnshared(
    state,
    "senior",
    "new-child",
    "/w/literacy-test/literacy-report-junior",
  );
  assertWorktreeUnshared(state, "senior", "current", pmWorktree);
  assertWorktreeUnshared(undefined, "senior", `id:${juniorId}`, pmWorktree);

  // Through the CLI, role-terminal reads the workflow's record and refuses
  // before any terminal is created.
  const stateDir = tempDir(t);
  const repo = await workflowRepo(t);
  await createWorkflow(
    stateDir,
    {
      schemaVersion: 1,
      id: "wf-share",
      goal: "Write a report",
      repo: ".",
      depth: 5,
      tasks: [{ file: "task-a.json", role: "junior" }],
      policy: { maxRunning: 1, maxReviewPending: 1 },
      budget: { maxAttempts: 1, maxCalls: 2 },
    },
    example(),
    repo,
  );
  const { revision } = readWorkflow(stateDir, "wf-share").state;
  attachExecution(stateDir, "wf-share", revision, {
    schemaVersion: 1,
    eventId: "attach-1",
    attemptId: "attempt-1",
    taskId: "task-a",
    receipt: {
      executionId: "ctx_1",
      runId: "run_1",
      taskId: "task_1",
      dispatchId: "ctx_1",
      worktreeId: juniorId,
    },
  });
  const orgFile = path.join(repo, "organization.json");
  writeJSON(orgFile, example());
  const common = [
    "--org",
    orgFile,
    "--workflow-id",
    "wf-share",
    "--state",
    stateDir,
  ];
  for (const command of [
    ["role-terminal", "--role", "senior", "--worktree", `id:${juniorId}`],
    [
      "worker-start",
      "--role",
      "senior",
      "--repo",
      repo,
      "--spec",
      "x",
      "--worktree",
      `id:${juniorId}`,
      "--terminal",
      "term_1",
    ],
  ]) {
    await assert.rejects(
      () =>
        main([
          ...command,
          ...common,
          "--orca",
          path.join(repo, "missing-orca"),
        ]),
      /is where junior works on task task-a; senior does not start there/,
    );
  }
});

test("the launch documents keep each role out of another role's worktree", () => {
  const read = (file) =>
    fs.readFileSync(
      new URL(`../plugins/oh-my-teams/${file}`, import.meta.url),
      "utf8",
    );
  const runtime = read("references/orca-runtime.md");
  assert.match(runtime, /### 역할과 워크트리/);
  assert.match(runtime, /검토 대상을 \*\*경로와 커밋으로 읽고\*\*/);
  assert.match(runtime, /is where <역할> works on task <task>/);
  for (const skill of ["skills/pm/SKILL.md", "skills/pl/SKILL.md"]) {
    assert.match(read(skill), /`역할과 워크트리` 절/);
  }
});

async function workflowRepo(t) {
  const repo = tempDir(t);
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "t@example.invalid"],
    ["config", "user.name", "t"],
    ["commit", "-q", "--allow-empty", "-m", "base"],
  ]) {
    assert.equal((await run(["git", ...args], { cwd: repo })).code, 0);
  }
  writeJSON(path.join(repo, "task-a.json"), {
    ...readJSON(
      new URL("../plugins/oh-my-teams/examples/task.v2.json", import.meta.url),
    ),
    id: "task-a",
    baseRef: "HEAD",
  });
  return repo;
}

async function capture(action) {
  const output = [];
  const log = console.log;
  console.log = (line) => output.push(line);
  try {
    await action();
  } finally {
    console.log = log;
  }
  return output.join("\n");
}

test("a workflow launch reads the organization snapshot the workflow froze", async (t) => {
  const state = tempDir(t);
  const repo = tempDir(t);
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "t@example.invalid"],
    ["config", "user.name", "t"],
    ["commit", "-q", "--allow-empty", "-m", "base"],
  ]) {
    assert.equal((await run(["git", ...args], { cwd: repo })).code, 0);
  }
  writeJSON(path.join(repo, "task-a.json"), {
    ...readJSON(
      new URL("../plugins/oh-my-teams/examples/task.v2.json", import.meta.url),
    ),
    id: "task-a",
    baseRef: "HEAD",
  });
  const frozen = example();
  frozen.roles.pl.profile = "codex-terra";
  await createWorkflow(
    state,
    {
      schemaVersion: 1,
      id: "wf-1",
      goal: "Split the work",
      repo: ".",
      tasks: [{ file: "task-a.json", role: "junior" }],
      policy: { maxRunning: 1, maxReviewPending: 1 },
      budget: { maxAttempts: 1, maxCalls: 1 },
    },
    frozen,
    repo,
  );

  // The live organization later drops PL entirely.
  const live = example();
  delete live.roles.pl;
  live.roles.senior.parent = "pm";
  const orgFile = path.join(repo, "organization.json");
  writeJSON(orgFile, live);

  const output = [];
  const log = console.log;
  console.log = (line) => output.push(line);
  try {
    await main([
      "role-spec",
      "--org",
      orgFile,
      "--role",
      "pl",
      "--spec",
      "나눈다.",
      "--workflow-id",
      "wf-1",
      "--state",
      state,
    ]);
  } finally {
    console.log = log;
  }
  const spec = JSON.parse(output.join("\n")).spec;
  assert.match(spec, /역할: PL/);
  assert.match(spec, /workflow: wf-1/);

  await assert.rejects(
    () =>
      main([
        "worker-start",
        "--org",
        orgFile,
        "--role",
        "pl",
        "--repo",
        repo,
        "--spec",
        "x",
        "--workflow-id",
        "wf-1",
        "--state",
        state,
        "--orca",
        path.join(repo, "missing-orca"),
      ]),
    // The live file no longer declares PL; the frozen snapshot binds it to terra.
    /Role pl uses codex \(profile codex-terra\)/,
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

  const slow = await resolveHostDefaults({
    home: tempDir(t),
    env: {},
    execute: async () => ({ code: -1, stdout: "", stderr: "", timedOut: true }),
  });
  assert.match(slow.codex.error, /timed out/);

  const odd = await resolveHostDefaults({
    home: tempDir(t),
    env: {},
    execute: async () => ({
      code: 0,
      stdout: JSON.stringify({
        models: [
          { slug: "b", visibility: "list", priority: "x" },
          { slug: "a", visibility: "list", priority: 2 },
        ],
      }),
      stderr: "",
      timedOut: false,
    }),
  });
  assert.deepEqual(odd.codex.listed, ["a", "b"]);
});
