/** Regressions for session-bound OMT worktree creation and headless rejection. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWorktreeWithRoleSession,
  reclaimWorktree,
} from "../plugins/oh-my-teams/scripts/orca-adapter.mjs";
import { readJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import { predictLaunchPath } from "../plugins/oh-my-teams/scripts/launch-matrix.mjs";
import { runTurn } from "../plugins/oh-my-teams/scripts/headless-runner.mjs";
import * as headlessRuntime from "../plugins/oh-my-teams/scripts/headless.mjs";
import {
  answerHeadless,
  startHeadlessWorker,
} from "../plugins/oh-my-teams/scripts/headless.mjs";
import {
  ALLOWED_OPTIONS,
  createRoleWorktree,
  main,
  parseArgs,
  recordLaunchSafely,
  reclaimIntegratedRoleWorktree,
} from "../plugins/oh-my-teams/scripts/teams-org.mjs";
import { draftResourceOrganization } from "../plugins/oh-my-teams/scripts/org-draft.mjs";
import {
  readTerminalClosures,
  terminalClosureLedgerFile,
} from "../plugins/oh-my-teams/scripts/usage-ledger.mjs";

const discovery = { executable: "orca", versionsMatch: true };
const roleOrganization = () =>
  readJSON(path.resolve("plugins/oh-my-teams/examples/organization.json"));
const workflowSnapshot = (state, organization = roleOrganization()) => ({
  state,
  organization,
});
const environment = async () => ({
  platform: "darwin",
  shell: "posix",
  trustRecordExists: true,
  codexTrustRecordExists: true,
  orcaVersion: "1.4.210",
  cliVersion: "1.2.11",
});
const supervised = () => ({
  path: "supervised-terminal",
  reason: [],
  nextAction: "",
});

function workspaceReceipt() {
  return JSON.stringify({
    ok: true,
    result: { worktree: { id: "wt_1", path: "/repo/child" } },
  });
}

function releasedExternalTerminal(dispatchId) {
  return {
    result: {
      dispatchId,
      state: "retained",
      reason: "external_terminal",
      processAction: "none",
    },
  };
}

function closedTerminal(terminal) {
  return {
    result: {
      close: {
        handle: terminal,
        tabId: `tab-${terminal}`,
        ptyKilled: true,
      },
    },
  };
}

test("a new worktree is reclaimed only when role-session absence is proven", async () => {
  const calls = [];
  const execute = async (argv) => {
    calls.push(argv);
    return {
      code: 0,
      stderr: "",
      timedOut: false,
      stdout: argv.includes("create")
        ? workspaceReceipt()
        : JSON.stringify({ ok: true, result: { removed: "wt_1" } }),
    };
  };
  await assert.rejects(
    () =>
      createWorktreeWithRoleSession("/repo", {
        name: "role-child",
        base: "a".repeat(40),
        discovery,
        execute,
        openRoleSession: async () => ({ ready: false, sessionObserved: false }),
      }),
    /was reclaimed/,
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].slice(1, 4), ["worktree", "remove", "--worktree"]);
  assert.equal(calls[1][4], "id:wt_1");
});

test("a completed cleanup uses the exact Orca identity selector without force", async () => {
  const calls = [];
  const execute = async (argv) => {
    calls.push(argv);
    return {
      code: 0,
      stderr: "",
      timedOut: false,
      stdout: JSON.stringify({ ok: true, result: { removed: true } }),
    };
  };
  await reclaimWorktree("/repo", {
    id: "repo::/repo/child",
    identityKey: "wt2:local:instance-1",
    discovery,
    execute,
  });
  assert.deepEqual(calls[0].slice(1, 5), [
    "worktree",
    "remove",
    "--worktree",
    "identity:wt2:local:instance-1",
  ]);
  assert.equal(calls[0].includes("--force"), false);
});

test("an ambiguous role launch preserves the new worktree for reconciliation", async () => {
  const calls = [];
  const execute = async (argv) => {
    calls.push(argv);
    return { code: 0, stderr: "", timedOut: false, stdout: workspaceReceipt() };
  };
  await assert.rejects(
    () =>
      createWorktreeWithRoleSession("/repo", {
        name: "role-child",
        base: "b".repeat(40),
        discovery,
        execute,
        openRoleSession: async () => ({ ready: false, sessionObserved: true }),
      }),
    /preserved for reconciliation/,
  );
  assert.equal(calls.length, 1);
});

test("a failed automatic reclamation retains the actual Orca worktree id", async () => {
  const execute = async (argv) => ({
    code: argv.includes("remove") ? 1 : 0,
    stderr: argv.includes("remove") ? "default shell still attached" : "",
    timedOut: false,
    stdout: argv.includes("create") ? workspaceReceipt() : "",
  });
  await assert.rejects(
    () =>
      createWorktreeWithRoleSession("/repo", {
        name: "role-child",
        base: "f".repeat(40),
        discovery,
        execute,
        openRoleSession: async () => ({ ready: false, sessionObserved: false }),
      }),
    (error) => {
      assert.equal(error.reclaimWorktreeId, "wt_1");
      assert.equal(error.workspace.id, "wt_1");
      assert.match(error.reclaimError, /default shell/);
      return true;
    },
  );
});

test("the launch matrix refuses before role-worktree creation", async () => {
  let created = false;
  await assert.rejects(
    () =>
      createRoleWorktree(
        {
          org: "/repo/.omt/organization.json",
          role: "junior",
          repo: "/repo",
          name: "blocked-task",
          base: "a".repeat(40),
        },
        {
          organization: roleOrganization,
          environment,
          matrix: () => ({
            path: "blocked",
            reason: ["test-block"],
            nextAction: "report",
          }),
          create: async () => {
            created = true;
          },
        },
      ),
    /before worktree creation: test-block/,
  );
  assert.equal(created, false);
});

test("workflow task ownership rejects before every role-worktree effect", async () => {
  for (const [label, args, tasks, pattern] of [
    [
      "role-mismatch-new",
      {},
      { current: { role: "pm", state: "pending" } },
      /assigned to pm, not senior/,
    ],
    [
      "unknown-task-cross-workflow-reuse",
      {
        "prior-workflow-id": "accepted-workflow",
        "prior-task-id": "accepted-task",
        worktree: "repo::/repo/senior-existing",
      },
      {},
      /Unknown workflow task missing/,
    ],
    [
      "unreviewed-junior-to-senior",
      { worktree: "repo::/repo/senior-existing" },
      {
        current: {
          role: "junior",
          state: "pending",
          worktreeId: "repo::/repo/junior-rejected",
        },
      },
      /assigned to junior, not senior/,
    ],
  ]) {
    const effects = [];
    await assert.rejects(
      () =>
        createRoleWorktree(
          {
            org: "/repo/.omt/organization.json",
            role: "senior",
            repo: "/repo",
            name: "ownership-rejection",
            base: "a".repeat(40),
            state: "/repo/.omt",
            "workflow-id": "current-workflow",
            "workflow-task":
              label === "unknown-task-cross-workflow-reuse"
                ? "missing"
                : "current",
            ...args,
          },
          {
            organization: roleOrganization,
            environment,
            matrix: supervised,
            read: () => workflowSnapshot({ tasks }),
            create: async () => effects.push("create"),
            open: async () => effects.push("open"),
            active: async () => effects.push("active"),
            release: async () => effects.push("release"),
            close: async () => effects.push("close"),
            list: async () => effects.push("list"),
          },
        ),
      pattern,
      label,
    );
    assert.deepEqual(effects, [], label);
  }
});

test("role-worktree workflow options reject a state-only context before creation", async () => {
  const effects = [];
  await assert.rejects(
    () =>
      createRoleWorktree(
        {
          org: "/repo/.omt/organization.json",
          role: "senior",
          repo: "/repo",
          name: "state-only-context",
          base: "a".repeat(40),
          state: "/repo/.omt",
        },
        {
          organization: roleOrganization,
          environment,
          matrix: supervised,
          create: async () => effects.push("create"),
          open: async () => effects.push("open"),
        },
      ),
    /--workflow-id, --workflow-task, and --state must be provided together/,
  );
  assert.deepEqual(effects, []);
});

test("workflow worktree preflight uses the frozen organization snapshot", async (t) => {
  await t.test("preserves the legacy frozen-profile path", async () => {
    const frozen = roleOrganization();
    frozen.revision = 15;
    const live = structuredClone(frozen);
    live.revision = 16;
    live.profiles[live.roles.senior.profile] = {
      ...live.profiles[live.roles.senior.profile],
      provider: "claude",
      model: "claude-sonnet-5",
    };
    let liveReads = 0;
    let created = false;
    let preflight;
    await assert.rejects(
      () =>
        createRoleWorktree(
          {
            org: "/repo/.omt/organization.json",
            role: "senior",
            repo: "/repo",
            name: "frozen-preflight",
            base: "a".repeat(40),
            state: "/repo/.omt",
            "workflow-id": "workflow-r15",
            "workflow-task": "senior-task",
          },
          {
            organization: () => {
              liveReads += 1;
              return live;
            },
            read: () =>
              workflowSnapshot(
                {
                  tasks: {
                    "senior-task": { role: "senior", state: "pending" },
                  },
                },
                frozen,
              ),
            environment: async () => ({
              platform: "win32",
              shell: "powershell",
              trustRecordExists: false,
              codexTrustRecordExists: false,
              orcaVersion: "1.4.210",
              cliVersion: "1.2.11",
            }),
            matrix: (input) => {
              preflight = input;
              return predictLaunchPath(input);
            },
            create: async () => {
              created = true;
            },
          },
        ),
      /agy-interactive-terminal-unavailable/,
    );
    assert.equal(liveReads, 0);
    assert.equal(created, false);
    assert.equal(preflight.runner, "agy");
    assert.equal(preflight.model, "gemini-3.8-flash-high");
  });

  const organization = draftResourceOrganization({
    name: "resource-preflight",
    resources: ["codex"],
  });
  const choice = {
    resourceId: "codex-current",
    model: "gpt-5.6-sol",
    effort: "high",
  };
  const staffing = {
    director: { allowedResources: [choice.resourceId] },
    tasks: { "resource-task": { choice } },
    poolStates: {},
  };
  const args = {
    org: "/repo/.omt/organization.json",
    role: "worker",
    repo: "/repo",
    name: "resource-preflight",
    base: "b".repeat(40),
    state: "/repo/.omt",
    "workflow-id": "resource-workflow",
    "workflow-task": "resource-task",
  };
  const resourceState = (nextStaffing) => ({
    roles: ["pm", "worker"],
    staffing: nextStaffing,
    tasks: { "resource-task": { role: "worker", state: "pending" } },
  });

  await t.test(
    "uses the frozen resource choice before opening its role session",
    async () => {
      let prediction;
      let created = false;
      const result = await createRoleWorktree(args, {
        organization: () => {
          throw new Error("the live organization must not be read");
        },
        read: () => workflowSnapshot(resourceState(staffing), organization),
        environment,
        matrix: (input) => {
          prediction = input;
          return supervised();
        },
        create: async (_repo, options) => {
          created = true;
          const workspace = { id: "wt_resource", path: "/repo/resource" };
          return {
            workspace,
            session: await options.openRoleSession(workspace),
          };
        },
        open: async (workspace) => ({
          ready: true,
          terminal: "resource-terminal",
          role: "worker",
          worktree: `id:${workspace.id}`,
          modelRequested: choice.model,
        }),
      });
      assert.equal(created, true);
      assert.equal(result.session.modelRequested, choice.model);
      assert.equal(prediction.runner, "codex");
      assert.equal(prediction.model, choice.model);
    },
  );

  for (const [label, nextStaffing, pattern] of [
    [
      "missing choice",
      { ...staffing, tasks: {} },
      /No staffing choice recorded for resource-task/,
    ],
    [
      "inconsistent choice",
      {
        ...staffing,
        tasks: {
          "resource-task": {
            choice: { ...choice, resourceId: "missing-resource" },
          },
        },
      },
      /Frozen staffing references unknown resource missing-resource/,
    ],
    [
      "exhausted pool",
      {
        ...staffing,
        poolStates: { "codex-current": { status: "exhausted" } },
      },
      /Staffing pool codex-current is exhausted/,
    ],
  ]) {
    await t.test(`${label} refuses before create or open`, async () => {
      const effects = [];
      await assert.rejects(
        () =>
          createRoleWorktree(args, {
            read: () =>
              workflowSnapshot(resourceState(nextStaffing), organization),
            environment,
            matrix: supervised,
            create: async () => effects.push("create"),
            open: async () => effects.push("open"),
          }),
        pattern,
      );
      assert.deepEqual(effects, []);
    });
  }
});

test("the operational role-worktree command opens the session inside creation", async () => {
  let creation;
  let opened;
  const result = await createRoleWorktree(
    {
      org: "/repo/.omt/organization.json",
      role: "junior",
      repo: "/repo",
      name: "task-a",
      base: "c".repeat(40),
    },
    {
      organization: roleOrganization,
      environment,
      matrix: supervised,
      create: async (_repo, options) => {
        creation = options;
        const session = await options.openRoleSession({ id: "wt_a" });
        return { workspace: { id: "wt_a", path: "/repo/task-a" }, session };
      },
      open: async (workspace) => {
        opened = workspace;
        return { ready: true, terminal: "term_a" };
      },
    },
  );
  assert.equal(creation.name, "task-a");
  assert.equal(creation.base, "c".repeat(40));
  assert.equal(opened.id, "wt_a");
  assert.equal(result.session.terminal, "term_a");
});

test("a Junior-to-Senior rework reuses a clean, session-bound Senior worktree", async () => {
  let created = false;
  let promotion;
  const result = await createRoleWorktree(
    {
      org: "/repo/.omt/organization.json",
      role: "senior",
      repo: "/repo",
      name: "task-a-senior",
      base: "d".repeat(40),
      state: "/repo/.omt",
      "workflow-id": "workflow-w2-00",
      "workflow-task": "w2-00",
      worktree: "repo::/repo/senior-existing",
    },
    {
      organization: roleOrganization,
      environment,
      matrix: supervised,
      create: async () => {
        created = true;
        throw new Error("promotion must reuse the Senior worktree");
      },
      read: () =>
        workflowSnapshot({
          tasks: {
            "w2-00": {
              role: "junior",
              state: "reviewed",
              worktreeId: "repo::/repo/junior-rejected",
            },
            "senior-prior": {
              role: "senior",
              state: "accepted",
              worktreeId: "repo::/repo/senior-existing",
            },
          },
        }),
      git: async (repo, argv) => {
        if (argv[0] === "status") return "";
        if (argv[0] === "rev-parse" && argv[1] === "HEAD")
          return repo === path.resolve("/repo") ? "integration-a" : "senior-a";
        if (argv[0] === "rev-parse") return "integration-a";
        if (argv[0] === "merge-base") return "";
        throw new Error(`unexpected git: ${argv.join(" ")}`);
      },
      launches: () => [
        {
          via: "worker-start",
          workflowId: "workflow-w2-00",
          workflowTaskId: "senior-prior",
          worktreePath: "/repo/senior-existing",
          terminal: "senior-prior-terminal",
          workerId: "senior-prior-dispatch",
        },
      ],
      closures: () => [],
      recordClosure: () => {},
      active: async () => ({ status: "clear" }),
      release: async (dispatchId) => releasedExternalTerminal(dispatchId),
      close: async (_orca, argv) => closedTerminal(argv.at(-1)),
      list: (() => {
        let calls = 0;
        return async () => ({
          result: {
            terminals:
              calls++ === 0 ? [{ handle: "senior-prior-terminal" }] : [],
          },
        });
      })(),
      open: async (workspace) => ({
        ready: true,
        terminal: "senior-terminal",
        role: "senior",
        worktree: `id:${workspace.id}`,
        modelRequested: "gpt-5.6-sol",
      }),
      promote: async (...args) => {
        promotion = args;
        return { transition: { id: "promotion-w2-00" } };
      },
    },
  );
  assert.equal(created, false);
  assert.equal(result.id, "repo::/repo/senior-existing");
  assert.equal(result.session.terminal, "senior-terminal");
  assert.equal(promotion[3].fromWorktreeId, "repo::/repo/junior-rejected");
  assert.equal(promotion[3].toWorktreeId, "repo::/repo/senior-existing");
  assert.equal(promotion[3].base, "d".repeat(40));
  assert.equal(result.transition.id, "promotion-w2-00");
});

test("a new same-role task reuses only an accepted, integrated, idle worktree", async () => {
  let created = false;
  let listed = 0;
  const result = await createRoleWorktree(
    {
      org: "/repo/.omt/organization.json",
      role: "senior",
      repo: "/repo",
      name: "next-senior-task",
      base: "e".repeat(40),
      state: "/repo/.omt",
      "workflow-id": "workflow-reuse",
      "workflow-task": "next",
      worktree: "repo::/repo/senior-existing",
    },
    {
      organization: roleOrganization,
      environment,
      matrix: supervised,
      create: async () => {
        created = true;
      },
      read: () =>
        workflowSnapshot({
          tasks: {
            next: { role: "senior", state: "pending" },
            prior: {
              role: "senior",
              state: "accepted",
              worktreeId: "repo::/repo/senior-existing",
            },
          },
        }),
      git: async (repo, argv) => {
        if (argv[0] === "status") return "";
        if (argv[0] === "rev-parse" && argv[1] === "HEAD")
          return repo === path.resolve("/repo") ? "integration-a" : "senior-a";
        if (argv[0] === "rev-parse") return "integration-a";
        if (argv[0] === "merge-base") return "";
        throw new Error(`unexpected git: ${argv.join(" ")}`);
      },
      launches: () => [
        {
          via: "worker-start",
          workflowId: "workflow-reuse",
          workflowTaskId: "prior",
          worktreePath: "/repo/senior-existing",
          terminal: "senior-prior-terminal",
          workerId: "senior-prior-dispatch",
        },
      ],
      closures: () => [],
      recordClosure: () => {},
      active: async () => ({ status: "clear" }),
      release: async (dispatchId) => releasedExternalTerminal(dispatchId),
      close: async (_orca, argv) => closedTerminal(argv.at(-1)),
      list: async () => ({
        result: {
          terminals:
            listed++ === 0 ? [{ handle: "senior-prior-terminal" }] : [],
        },
      }),
      open: async (workspace) => ({
        ready: true,
        terminal: "new-senior-terminal",
        role: "senior",
        worktree: `id:${workspace.id}`,
        modelRequested: "gpt-5.6-sol",
      }),
    },
  );
  assert.equal(created, false);
  assert.equal(result.session.terminal, "new-senior-terminal");
});

test("two consecutive role-worktree reuses retain and verify prior closure proofs", async (t) => {
  const closureDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "omt-closure-reuse-"),
  );
  t.after(() => fs.rmSync(closureDir, { recursive: true, force: true }));
  const activeTerminals = [];
  const releasedDispatches = [];
  const listCalls = [0, 0];
  let cycle = 0;
  const args = {
    org: path.join(closureDir, "organization.json"),
    role: "senior",
    repo: "/repo",
    name: "reused-senior-task",
    base: "c".repeat(40),
    state: "/repo/.omt",
    "workflow-id": "current-workflow",
    "workflow-task": "next-task",
    "prior-workflow-id": "accepted-workflow",
    "prior-task-id": "accepted-task",
    worktree: "repo::/repo/senior-existing",
  };
  const ports = {
    organization: roleOrganization,
    environment,
    matrix: supervised,
    read: (_stateDir, workflowId) =>
      workflowSnapshot(
        workflowId === "current-workflow"
          ? { tasks: { "next-task": { role: "senior", state: "pending" } } }
          : {
              tasks: {
                "accepted-task": {
                  role: "senior",
                  state: "accepted",
                  worktreeId: "repo::/repo/senior-existing",
                },
              },
            },
      ),
    git: async (repo, argv) => {
      if (argv[0] === "status") return "";
      if (argv[0] === "rev-parse" && argv[1] === "HEAD")
        return repo === path.resolve("/repo") ? "integration-a" : "senior-a";
      if (argv[0] === "rev-parse") return "integration-a";
      if (argv[0] === "merge-base") return "";
      throw new Error(`unexpected git: ${argv.join(" ")}`);
    },
    launches: () => [
      {
        via: "worker-start",
        workflowId: "accepted-workflow",
        workflowTaskId: "accepted-task",
        worktreePath: "/repo/senior-existing",
        terminal: "past-terminal",
        workerId: "past-dispatch",
      },
      ...(cycle === 0
        ? []
        : [
            {
              via: "worker-start",
              workflowId: "current-workflow",
              workflowTaskId: "next-task",
              worktreePath: "/repo/senior-existing",
              terminal: "first-reuse-terminal",
              workerId: "first-reuse-dispatch",
            },
          ]),
    ],
    active: async (terminal) => {
      activeTerminals.push(terminal);
      return { status: "clear" };
    },
    release: async (dispatchId) => {
      releasedDispatches.push(dispatchId);
      return releasedExternalTerminal(dispatchId);
    },
    close: async (_orca, argv) => closedTerminal(argv.at(-1)),
    list: async () => ({
      result: {
        terminals:
          listCalls[cycle]++ % 2 === 0
            ? [
                {
                  handle:
                    cycle === 0 ? "past-terminal" : "first-reuse-terminal",
                },
              ]
            : [],
      },
    }),
    open: async (workspace) => ({
      ready: true,
      terminal: cycle === 0 ? "first-reuse-terminal" : "second-reuse-terminal",
      role: "senior",
      worktree: `id:${workspace.id}`,
      modelRequested: "gpt-5.6-sol",
    }),
  };

  const first = await createRoleWorktree(args, ports);
  cycle = 1;
  const [firstClosure] = readTerminalClosures(args.org);
  firstClosure.terminals[0].close.receipt.result.close.ptyKilled = false;
  fs.writeFileSync(
    terminalClosureLedgerFile(args.org),
    `${JSON.stringify(firstClosure)}\n`,
  );
  await assert.rejects(
    () => createRoleWorktree(args, ports),
    /Another or unowned terminal is connected/,
  );
  listCalls[1] = 0;
  firstClosure.terminals[0].close.receipt.result.close.ptyKilled = true;
  fs.writeFileSync(
    terminalClosureLedgerFile(args.org),
    `${JSON.stringify(firstClosure)}\n`,
  );
  const second = await createRoleWorktree(args, ports);
  const closureProofs = readTerminalClosures(args.org);

  assert.equal(first.session.terminal, "first-reuse-terminal");
  assert.equal(second.session.terminal, "second-reuse-terminal");
  assert.deepEqual(activeTerminals, [
    "past-terminal",
    "past-terminal",
    "first-reuse-terminal",
    "first-reuse-terminal",
  ]);
  assert.deepEqual(releasedDispatches, [
    "past-dispatch",
    "first-reuse-dispatch",
  ]);
  assert.equal(closureProofs.length, 2);
  assert.equal(
    closureProofs[0].terminals[0].close.receipt.result.close.ptyKilled,
    true,
  );
  assert.equal(
    closureProofs[0].terminals[0].close.receipt.result.close.handle,
    "past-terminal",
  );
  assert.equal(
    closureProofs[0].terminals[0].close.receipt.result.close.tabId,
    "tab-past-terminal",
  );
  assert.equal(
    closureProofs[0].terminals[0].releases[0].receipt.result.dispatchId,
    "past-dispatch",
  );
  assert.deepEqual(closureProofs[0].afterReceipt.result.terminals, []);
});

test("a named accepted task in another workflow can safely reuse its same-role worktree", async () => {
  const reads = [];
  let listed = 0;
  const result = await createRoleWorktree(
    {
      org: "/repo/.omt/organization.json",
      role: "senior",
      repo: "/repo",
      name: "cross-workflow-senior",
      base: "f".repeat(40),
      state: "/repo/.omt",
      "workflow-id": "current-workflow",
      "workflow-task": "next-task",
      "prior-workflow-id": "accepted-workflow",
      "prior-task-id": "accepted-task",
      worktree: "repo::/repo/senior-existing",
    },
    {
      organization: roleOrganization,
      environment,
      matrix: supervised,
      read: (_stateDir, workflowId) => {
        reads.push(workflowId);
        return workflowSnapshot(
          workflowId === "current-workflow"
            ? { tasks: { "next-task": { role: "senior", state: "pending" } } }
            : {
                tasks: {
                  "accepted-task": {
                    state: "accepted",
                    executionRole: "senior",
                    worktreeId: "repo::/repo/senior-existing",
                  },
                },
              },
        );
      },
      git: async (repo, argv) => {
        if (argv[0] === "status") return "";
        if (argv[0] === "rev-parse" && argv[1] === "HEAD")
          return repo === path.resolve("/repo") ? "integration-a" : "senior-a";
        if (argv[0] === "rev-parse") return "integration-a";
        if (argv[0] === "merge-base") return "";
        throw new Error(`unexpected git: ${argv.join(" ")}`);
      },
      launches: () => [
        {
          via: "worker-start",
          workflowId: "accepted-workflow",
          workflowTaskId: "accepted-task",
          worktreePath: "/repo/senior-existing",
          terminal: "senior-prior-terminal",
          workerId: "senior-prior-dispatch",
        },
      ],
      closures: () => [],
      recordClosure: () => {},
      active: async () => ({ status: "clear" }),
      release: async (dispatchId) => releasedExternalTerminal(dispatchId),
      close: async (_orca, argv) => closedTerminal(argv.at(-1)),
      list: async () => ({
        result: {
          terminals:
            listed++ === 0 ? [{ handle: "senior-prior-terminal" }] : [],
        },
      }),
      open: async (workspace) => ({
        ready: true,
        terminal: "cross-workflow-senior-terminal",
        role: "senior",
        worktree: `id:${workspace.id}`,
        modelRequested: "gpt-5.6-sol",
      }),
    },
  );
  assert.deepEqual(reads, ["current-workflow", "accepted-workflow"]);
  assert.deepEqual(result.reusedFrom, {
    workflowId: "accepted-workflow",
    workflowTaskId: "accepted-task",
  });
});

test("cross-workflow reuse refuses an unnamed or non-accepted source task", async () => {
  for (const [label, args, sourceState] of [
    [
      "unnamed",
      {},
      { tasks: { prior: { state: "accepted", role: "senior" } } },
    ],
    [
      "not-accepted",
      {
        "prior-workflow-id": "other-workflow",
        "prior-task-id": "other-task",
      },
      {
        tasks: {
          "other-task": {
            state: "rejected",
            role: "senior",
            worktreeId: "repo::/repo/senior-existing",
          },
        },
      },
    ],
  ]) {
    let opened = false;
    await assert.rejects(
      () =>
        createRoleWorktree(
          {
            org: "/repo/.omt/organization.json",
            role: "senior",
            repo: "/repo",
            name: "cross-workflow-refusal",
            base: "0".repeat(40),
            state: "/repo/.omt",
            "workflow-id": "current-workflow",
            "workflow-task": "next-task",
            worktree: "repo::/repo/senior-existing",
            ...args,
          },
          {
            organization: roleOrganization,
            environment,
            matrix: supervised,
            read: (_stateDir, workflowId) =>
              workflowSnapshot(
                workflowId === "current-workflow"
                  ? {
                      tasks: {
                        "next-task": { role: "senior", state: "pending" },
                      },
                    }
                  : sourceState,
              ),
            open: async () => {
              opened = true;
            },
          },
        ),
      /accepted prior task|explicit prior workflow\/task/,
      label,
    );
    assert.equal(opened, false, label);
  }
});

test("cross-workflow reuse refuses a worktree claimed by another current task", async () => {
  let opened = false;
  await assert.rejects(
    () =>
      createRoleWorktree(
        {
          org: "/repo/.omt/organization.json",
          role: "senior",
          repo: "/repo",
          name: "cross-workflow-conflict",
          base: "0".repeat(40),
          state: "/repo/.omt",
          "workflow-id": "current-workflow",
          "workflow-task": "next-task",
          "prior-workflow-id": "accepted-workflow",
          "prior-task-id": "accepted-task",
          worktree: "repo::/repo/senior-existing",
        },
        {
          organization: roleOrganization,
          environment,
          matrix: supervised,
          read: (_stateDir, workflowId) =>
            workflowSnapshot(
              workflowId === "current-workflow"
                ? {
                    tasks: {
                      "next-task": { role: "senior", state: "pending" },
                      "other-task": {
                        role: "senior",
                        state: "running",
                        worktreeId: "repo::/repo/senior-existing",
                      },
                    },
                  }
                : {
                    tasks: {
                      "accepted-task": {
                        role: "senior",
                        state: "accepted",
                        worktreeId: "repo::/repo/senior-existing",
                      },
                    },
                  },
            ),
          open: async () => {
            opened = true;
          },
        },
      ),
    /also owned by current workflow task other-task/,
  );
  assert.equal(opened, false);
});

test("CLI usage admits only an explicit paired cross-workflow reuse source", () => {
  const allowed = ALLOWED_OPTIONS["role-worktree-create"];
  assert.ok(allowed.includes("prior-workflow-id"));
  assert.ok(allowed.includes("prior-task-id"));
  assert.deepEqual(
    parseArgs([
      "role-worktree-create",
      "--prior-workflow-id",
      "accepted-workflow",
      "--prior-task-id",
      "accepted-task",
    ]),
    {
      command: "role-worktree-create",
      "prior-workflow-id": "accepted-workflow",
      "prior-task-id": "accepted-task",
    },
  );
  assert.match(
    fs.readFileSync("plugins/oh-my-teams/scripts/teams-org.mjs", "utf8"),
    /\[--prior-workflow-id ID --prior-task-id ID\]/,
  );
});

test("an integrated child is reclaimed only after every lifecycle proof", async () => {
  const calls = [];
  const result = await reclaimIntegratedRoleWorktree(
    {
      org: "/repo/.omt/organization.json",
      state: "/repo/.omt",
      "workflow-id": "workflow-a",
      "workflow-task": "task-a",
      repo: "/repo/integration",
      worktree: "repo::/repo/child",
      "merge-commit": "merge-a",
    },
    {
      read: () => ({
        state: {
          status: "accepted",
          integration: { decision: { evidenceKey: "integration" } },
          tasks: {
            "task-a": {
              state: "accepted",
              worktreeId: "repo::/repo/child",
            },
          },
        },
      }),
      launches: () => [
        {
          via: "worker-start",
          workflowId: "workflow-a",
          workflowTaskId: "task-a",
          worktreePath: "/repo/child",
          terminal: "term-a",
          workerId: "dispatch-earlier",
        },
        {
          via: "worker-start",
          workflowId: "workflow-a",
          workflowTaskId: "task-a",
          worktreePath: "/repo/child",
          terminal: "term-a",
          workerId: "dispatch-a",
        },
      ],
      closures: () => [],
      recordClosure: () => {},
      active: async () => ({ status: "clear" }),
      git: async (_repo, argv) => {
        calls.push(`git:${argv.join(" ")}`);
        if (argv[0] === "status") return "";
        if (argv[0] === "rev-parse" && argv[1] === "HEAD") return "child-a";
        return "";
      },
      release: async (id) => {
        calls.push(`release:${id}`);
        return releasedExternalTerminal(id);
      },
      close: async (_orca, argv) => {
        calls.push(`close:${argv.at(-1)}`);
        return closedTerminal(argv.at(-1));
      },
      list: (() => {
        let calls = 0;
        return async () => ({
          result: { terminals: calls++ === 0 ? [{ handle: "term-a" }] : [] },
        });
      })(),
      reclaim: async (_repo, options) => {
        calls.push(`reclaim:${options.id}`);
        return { result: { removed: true } };
      },
    },
  );
  assert.equal(result.head, "child-a");
  assert.deepEqual(calls.slice(-5), [
    "release:dispatch-earlier",
    "release:dispatch-a",
    "close:term-a",
    "git:status --porcelain=v1 -uall",
    "reclaim:repo::/repo/child",
  ]);
});

test("an active or unproven child is preserved instead of reclaimed", async () => {
  let reclaimed = false;
  await assert.rejects(
    () =>
      reclaimIntegratedRoleWorktree(
        {
          org: "/repo/.omt/organization.json",
          state: "/repo/.omt",
          "workflow-id": "workflow-a",
          "workflow-task": "task-a",
          repo: "/repo/integration",
          worktree: "repo::/repo/child",
          "merge-commit": "merge-a",
        },
        {
          read: () => ({
            state: {
              status: "accepted",
              integration: { decision: {} },
              tasks: {
                "task-a": {
                  state: "accepted",
                  worktreeId: "repo::/repo/child",
                },
              },
            },
          }),
          launches: () => [
            {
              via: "worker-start",
              workflowId: "workflow-a",
              workflowTaskId: "task-a",
              worktreePath: "/repo/child",
              terminal: "term-a",
              workerId: "dispatch-a",
            },
          ],
          active: async () => ({ status: "active" }),
          git: async (_repo, argv) => {
            if (argv[0] === "status") return "";
            if (argv[0] === "rev-parse" && argv[1] === "HEAD") return "child-a";
            return "merge-a";
          },
          reclaim: async () => {
            reclaimed = true;
          },
        },
      ),
    /do not reuse or reclaim/,
  );
  assert.equal(reclaimed, false);
});

test("ambiguous Orca release, close, or terminal-list receipts preserve the child", async () => {
  for (const [label, ports] of [
    [
      "release",
      {
        release: async () => ({
          result: {
            dispatchId: "owned-dispatch",
            state: "retained",
            reason: "external_terminal",
            processAction: "stopped",
          },
        }),
      },
    ],
    [
      "wrong-dispatch",
      {
        release: async () => releasedExternalTerminal("another-dispatch"),
      },
    ],
    [
      "ambiguous-release",
      {
        release: async () => ({
          result: {
            dispatchId: "owned-dispatch",
            state: "retained",
            reason: "external_terminal",
          },
        }),
      },
    ],
    [
      "pty-killed-false",
      {
        close: async () => ({
          result: {
            close: {
              handle: "owned-terminal",
              tabId: "tab-owned-terminal",
              ptyKilled: false,
            },
          },
        }),
      },
    ],
    [
      "wrong-terminal",
      {
        close: async () => closedTerminal("another-terminal"),
      },
    ],
    [
      "missing-tab",
      {
        close: async () => ({
          result: { close: { handle: "owned-terminal", ptyKilled: true } },
        }),
      },
    ],
    ["extra-terminal", { extraTerminal: true }],
    ["remaining-terminal", { remainingTerminal: true }],
  ]) {
    let reclaimed = false;
    let listed = 0;
    await assert.rejects(
      () =>
        reclaimIntegratedRoleWorktree(
          {
            org: "/repo/.omt/organization.json",
            state: "/repo/.omt",
            "workflow-id": "workflow-a",
            "workflow-task": "task-a",
            repo: "/repo/integration",
            worktree: "repo::/repo/child",
            "merge-commit": "merge-a",
          },
          {
            read: () => ({
              state: {
                tasks: {
                  "task-a": {
                    state: "accepted",
                    worktreeId: "repo::/repo/child",
                  },
                },
              },
            }),
            launches: () => [
              {
                via: "worker-start",
                workflowId: "workflow-a",
                workflowTaskId: "task-a",
                worktreePath: "/repo/child",
                terminal: "owned-terminal",
                workerId: "owned-dispatch",
              },
            ],
            active: async () => ({ status: "clear" }),
            git: async (_repo, argv) => {
              if (argv[0] === "status") return "";
              if (argv[0] === "rev-parse" && argv[1] === "HEAD")
                return "child-a";
              return "merge-a";
            },
            release:
              ports.release ??
              (async (dispatchId) => releasedExternalTerminal(dispatchId)),
            close:
              ports.close ??
              (async (_orca, argv) => closedTerminal(argv.at(-1))),
            list: async () => ({
              result: {
                terminals:
                  listed++ === 0
                    ? [
                        { handle: "owned-terminal" },
                        ...(ports.extraTerminal
                          ? [{ handle: "other-shell" }]
                          : []),
                      ]
                    : ports.remainingTerminal
                      ? [{ handle: "owned-terminal" }]
                      : [],
              },
            }),
            reclaim: async () => {
              reclaimed = true;
            },
          },
        ),
      /preserve|termination|Another or unowned|connected terminal remains/,
      label,
    );
    assert.equal(reclaimed, false, label);
  }
});

test("an accepted promotion can reclaim its retired Junior worktree", async () => {
  let listed = 0;
  const result = await reclaimIntegratedRoleWorktree(
    {
      org: "/repo/.omt/organization.json",
      state: "/repo/.omt",
      "workflow-id": "workflow-promotion",
      "workflow-task": "w2-00",
      repo: "/repo/integration",
      worktree: "repo::/repo/junior-rejected",
      "merge-commit": "merge-a",
    },
    {
      read: () => ({
        state: {
          tasks: {
            "w2-00": {
              state: "accepted",
              role: "junior",
              worktreeId: "repo::/repo/senior-fixed",
              worktreeTransitions: [
                {
                  usedAt: "2026-09-29T00:00:00.000Z",
                  fromWorktreeId: "repo::/repo/junior-rejected",
                },
              ],
            },
          },
        },
      }),
      launches: () => [
        {
          via: "worker-start",
          workflowId: "workflow-promotion",
          workflowTaskId: "w2-00",
          worktreePath: "/repo/junior-rejected",
          terminal: "junior-terminal",
          workerId: "junior-dispatch",
        },
      ],
      closures: () => [],
      recordClosure: () => {},
      active: async () => ({ status: "clear" }),
      git: async (_repo, argv) => {
        if (argv[0] === "status") return "";
        if (argv[0] === "rev-parse" && argv[1] === "HEAD") return "junior-a";
        return "merge-a";
      },
      release: async (dispatchId) => releasedExternalTerminal(dispatchId),
      close: async (_orca, argv) => closedTerminal(argv.at(-1)),
      list: async () => ({
        result: {
          terminals: listed++ === 0 ? [{ handle: "junior-terminal" }] : [],
        },
      }),
      reclaim: async (_repo, options) => ({ removed: options.id }),
    },
  );
  assert.equal(result.worktreeId, "repo::/repo/junior-rejected");
  assert.equal(result.reclaimed.removed, "repo::/repo/junior-rejected");
});

test("an interactive terminal launch keeps its session when its ledger write fails", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-ledger-failure-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const orgFile = path.join(dir, "organization.json");
  fs.writeFileSync(orgFile, JSON.stringify(roleOrganization()));
  fs.writeFileSync(path.join(dir, "usage"), "not a directory");
  const result = recordLaunchSafely(orgFile, "2026-09-29T00:00:00.000Z", {
    via: "role-terminal",
    role: "senior",
    terminal: "already-open-terminal",
  });
  assert.match(result.ledgerError, /EEXIST|ENOTDIR|not a directory/);
  assert.equal(result.ledger, undefined);
});

test("the CLI rejects new headless launches and Windows Agy has no sessionless fallback", async () => {
  await assert.rejects(() => main(["headless-start"]), /Unknown command/);
  const result = predictLaunchPath({
    runner: "agy",
    model: "gemini-3.1-pro-high",
    platform: "win32",
    shell: "powershell",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    orcaVersion: "1.4.210",
    cliVersion: "1.2.11",
  });
  assert.equal(result.path, "blocked");
  assert.ok(result.reason.includes("agy-interactive-terminal-unavailable"));
});

test("direct headless exports fail closed", () => {
  assert.throws(
    () => startHeadlessWorker({}),
    /New headless execution was removed/,
  );
  assert.throws(
    () => answerHeadless("/legacy", "old", "continue"),
    /Headless follow-up turns were removed/,
  );
});

test("headless record reader has no retained launch implementation", () => {
  const runtime = fs.readFileSync(
    path.resolve("plugins/oh-my-teams/scripts/headless.mjs"),
    "utf8",
  );
  assert.equal(Object.hasOwn(headlessRuntime, "headlessCommand"), false);
  assert.doesNotMatch(runtime, /\blaunchTurn\b/);
  assert.doesNotMatch(runtime, /\bspawn\s*\(/);
  assert.doesNotMatch(runtime, /headless-runner\.mjs/);
});

test("headless runner rejects public and node entry execution before any provider spawn", async (t) => {
  const turnDir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-retired-runner-"));
  t.after(() => fs.rmSync(turnDir, { recursive: true, force: true }));
  await assert.rejects(
    () => runTurn(turnDir),
    /New headless runner execution was removed/,
  );
  assert.equal(fs.existsSync(path.join(turnDir, "pids.json")), false);
  const runner = path.resolve(
    "plugins/oh-my-teams/scripts/headless-runner.mjs",
  );
  const direct = spawnSync(process.execPath, [runner, turnDir], {
    encoding: "utf8",
  });
  assert.equal(direct.status, 1);
  assert.match(direct.stderr, /New headless runner execution was removed/);
  assert.equal(fs.existsSync(path.join(turnDir, "pids.json")), false);
});
