/** Regressions for session-bound OMT worktree creation and headless rejection. */
import { durableSuccessSupported } from "./directory-durability-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWorktreeWithRoleSession,
  reclaimWorktree,
} from "../plugins/oh-my-teams/scripts/orca-adapter.mjs";
import {
  readJSON,
  assertDirectorySync,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import { predictLaunchPath } from "../plugins/oh-my-teams/scripts/launch-matrix.mjs";
import * as headlessRuntime from "../plugins/oh-my-teams/scripts/headless.mjs";
import {
  ALLOWED_OPTIONS,
  createRoleWorktree,
  executeCommand,
  main,
  parseArgs,
  recordLaunchSafely,
  reclaimIntegratedRoleWorktree,
} from "../plugins/oh-my-teams/scripts/teams-org.mjs";
import { draftResourceOrganization } from "../plugins/oh-my-teams/scripts/org-draft.mjs";
import {
  readLaunches,
  readTerminalClosures,
  terminalClosureLedgerFile,
} from "../plugins/oh-my-teams/scripts/usage-ledger.mjs";

import {
  registerKickoff,
  registryDirectory,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";
import { minimalRequirements } from "./requirements-draft-fixture.mjs";

function reclaimSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omt-role-reclaim-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const org = path.join(root, ".omt", "organization.json");
  fs.mkdirSync(path.dirname(org), { recursive: true });
  const organization = roleOrganization();
  fs.writeFileSync(org, JSON.stringify(organization));
  const brief = path.join(root, "brief.md");
  fs.writeFileSync(brief, "reclaim fixture");
  fs.mkdirSync(path.join(root, "integration"));
  const pmId = `repo::${root}/integration`;
  registerKickoff(org, {
    goal: "reclaim fixture",
    pm: {
      worktreeId: pmId,
      path: `${root}/integration`,
      stateDir: `${root}/.omt`,
    },
    brief,
    delivery: { mode: "none" },
    organizationRevision: organization.revision,
    requirements: minimalRequirements(org, pmId),
    director: { terminalHandle: "director", checkoutPath: root },
  });
  return {
    root,
    scan: async () => ({
      inventoryComplete: true,
      candidates: ["child", "junior-rejected"].map((name) => ({
        worktreeId: `repo::${root}/${name}`,
        status: "safe-to-remove",
      })),
    }),
    show: async (_executable, args) =>
      args[1] === "ps"
        ? { result: { worktrees: [] } }
        : {
            result: {
              worktree: {
                id: args.at(-1).slice(3),
                parentWorktreeId: pmId,
                identity: {
                  key: "exact-child",
                  instanceId: "child-instance",
                  executionHostId: "local",
                },
              },
            },
          },
  };
}

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
          role: "worker",
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
      /assigned to pm, not worker/,
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
      "cross-role-task-reuse",
      { worktree: "repo::/repo/senior-existing" },
      {
        current: {
          role: "pm",
          state: "pending",
          worktreeId: "repo::/repo/junior-rejected",
        },
      },
      /assigned to pm, not worker/,
    ],
  ]) {
    const effects = [];
    await assert.rejects(
      () =>
        createRoleWorktree(
          {
            org: "/repo/.omt/organization.json",
            role: "worker",
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
          role: "worker",
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
  await t.test(
    "uses the frozen profile during worktree preflight",
    async () => {
      const frozen = roleOrganization();
      frozen.revision = 15;
      const live = structuredClone(frozen);
      live.revision = 16;
      live.profiles[live.roles.worker.profile] = {
        ...live.profiles[live.roles.worker.profile],
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
              role: "worker",
              repo: "/repo",
              name: "frozen-preflight",
              base: "a".repeat(40),
              state: "/repo/.omt",
              "workflow-id": "workflow-r15",
              "workflow-task": "senior-task",
              "fresh-reason": "This Senior task needs an isolated checkout",
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
                      "senior-task": { role: "worker", state: "pending" },
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
      assert.equal(preflight.model, "claude-opus-4-6-thinking");
    },
  );

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
    "fresh-reason": "The Worker needs its own isolated checkout",
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

  await t.test(
    "the first PM of a resource organization uses one director-verified bootstrap selection",
    async (t) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "omt-pm-bootstrap-"),
      );
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const organization = draftResourceOrganization({
        name: "pm-bootstrap",
        resources: ["codex"],
      });
      const orgFile = path.join(directory, "organization.json");
      fs.writeFileSync(orgFile, JSON.stringify(organization));
      const sha256 = (text) =>
        crypto.createHash("sha256").update(text).digest("hex");
      const choice = {
        resourceId: "codex-current",
        model: "gpt-5.6-sol",
        effort: "high",
      };
      const selection = {
        schemaVersion: 1,
        organization: {
          revision: organization.revision,
          sha256: sha256(fs.readFileSync(orgFile)),
        },
        catalog: {
          verifiedAt: "2026-10-07T00:00:00.000Z",
          catalogRevision: "catalog-r1",
          providerRevision: "codex-r1",
        },
        allowedResources: [choice.resourceId],
        allowedPools: [choice.resourceId],
        choice,
        reason: "The director selected the PM resource for this kickoff.",
      };
      const selectionFile = path.join(directory, "selection.json");
      fs.writeFileSync(selectionFile, JSON.stringify(selection));
      const args = {
        org: orgFile,
        role: "pm",
        repo: "/repo/director",
        name: "pm-bootstrap",
        base: "p".repeat(40),
        "pm-selection": selectionFile,
      };
      const ports = {
        organization: () => organization,
        callerCwd: "/repo/director",
        kickoffs: () => ({
          kickoffs: [{ pm: { worktreeId: "other-kickoff" } }],
        }),
        catalog: async () => ({ catalogRevision: "catalog-r1" }),
        revalidate: (_catalog, entries) => ({
          savable: entries[0].model === choice.model,
          catalogRevision: "catalog-r1",
          providerRevisions: { codex: "codex-r1" },
          selections: [{ savable: entries[0].model === choice.model }],
        }),
        environment,
        matrix: supervised,
        create: async (_repo, options) => {
          const workspace = { id: "pm-wt", path: "/repo/pm" };
          return {
            workspace,
            session: await options.openRoleSession(workspace),
          };
        },
        open: async (workspace) => ({
          ready: true,
          terminal: "pm-terminal",
          role: "pm",
          worktree: `id:${workspace.id}`,
          modelRequested: choice.model,
        }),
      };
      const result = await createRoleWorktree(args, ports);
      assert.equal(result.session.modelRequested, choice.model);
      assert.equal(
        result.pmBootstrap.selection.choice.resourceId,
        choice.resourceId,
      );
      assert.equal(
        result.pmBootstrap.inputSha256,
        sha256(fs.readFileSync(selectionFile)),
      );

      for (const [label, update, pattern] of [
        [
          "missing selection",
          (next) => {
            delete next["pm-selection"];
          },
          /requires --pm-selection/,
        ],
        [
          "other role",
          (next) => ({ ...next, role: "worker" }),
          /only valid for role pm/,
        ],
        [
          "organization drift",
          () => fs.writeFileSync(orgFile, `${JSON.stringify(organization)}\n`),
          /SHA256 has drifted/,
        ],
        [
          "schema required field",
          () => {
            const invalid = structuredClone(selection);
            delete invalid.catalog.verifiedAt;
            fs.writeFileSync(selectionFile, JSON.stringify(invalid));
          },
          /schema rejects selection.catalog: missing verifiedAt/,
        ],
        [
          "schema additional field",
          () => {
            const invalid = structuredClone(selection);
            invalid.catalog.unapproved = true;
            fs.writeFileSync(selectionFile, JSON.stringify(invalid));
          },
          /schema rejects selection.catalog: unexpected unapproved/,
        ],
        [
          "schema type",
          () => {
            const invalid = structuredClone(selection);
            invalid.allowedResources = choice.resourceId;
            fs.writeFileSync(selectionFile, JSON.stringify(invalid));
          },
          /schema rejects selection.allowedResources: expected array/,
        ],
        ["catalog drift", () => {}, /catalog revision has drifted/],
      ]) {
        await t.test(`${label} refuses before Orca creation`, async () => {
          fs.writeFileSync(orgFile, JSON.stringify(organization));
          fs.writeFileSync(selectionFile, JSON.stringify(selection));
          let created = false;
          const next = structuredClone(args);
          const replacement = update(next);
          const rejectedArgs = replacement ?? next;
          await assert.rejects(
            () =>
              createRoleWorktree(rejectedArgs, {
                ...ports,
                create: async () => {
                  created = true;
                },
                ...(label === "catalog drift"
                  ? {
                      revalidate: () => ({
                        savable: true,
                        catalogRevision: "catalog-r2",
                        providerRevisions: { codex: "codex-r2" },
                        selections: [{ savable: true }],
                      }),
                    }
                  : {}),
              }),
            pattern,
          );
          assert.equal(created, false);
        });
      }
    },
  );
});

test("the operational role-worktree command opens the session inside creation", async () => {
  let creation;
  let opened;
  const result = await createRoleWorktree(
    {
      org: "/repo/.omt/organization.json",
      role: "worker",
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

test("a new same-role task reuses only an accepted, integrated, idle worktree", async () => {
  let created = false;
  let listed = 0;
  const result = await createRoleWorktree(
    {
      org: "/repo/.omt/organization.json",
      role: "worker",
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
            next: { role: "worker", state: "pending" },
            prior: {
              role: "worker",
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
        role: "worker",
        worktree: `id:${workspace.id}`,
        modelRequested: "gpt-5.6-sol",
      }),
    },
  );
  assert.equal(created, false);
  assert.equal(result.session.terminal, "new-senior-terminal");
});

test("an accepted same-role worktree prevents silent creation of another child", async () => {
  let created = false;
  const args = {
    org: "/repo/.omt/organization.json",
    role: "worker",
    repo: "/repo",
    name: "next-senior-task",
    base: "e".repeat(40),
    state: "/repo/.omt",
    "workflow-id": "workflow-reuse",
    "workflow-task": "next",
  };
  const ports = {
    organization: roleOrganization,
    environment,
    matrix: supervised,
    read: () =>
      workflowSnapshot({
        tasks: {
          next: { role: "worker", state: "pending" },
          prior: {
            role: "worker",
            state: "accepted",
            worktreeId: "repo::/repo/senior-existing",
          },
        },
      }),
    create: async () => {
      created = true;
      return {
        workspace: { id: "repo::/repo/new-senior", path: "/repo/new-senior" },
        session: { ready: true, terminal: "senior-terminal" },
      };
    },
  };
  await assert.rejects(
    () => createRoleWorktree(args, ports),
    /A new workflow child requires --fresh-reason/,
  );
  assert.equal(created, false);
  const result = await createRoleWorktree(
    {
      ...args,
      "fresh-reason": "The prior role worktree still has a live session",
    },
    ports,
  );
  assert.equal(created, true);
  assert.equal(result.id, "repo::/repo/new-senior");
  assert.equal(
    result.freshReason,
    "The prior role worktree still has a live session",
  );
  assert.deepEqual(result.worktreeSelection, {
    schemaVersion: 1,
    decision: "new-child",
    scope: "current-workflow-and-automatic-discovery",
    workflowId: "workflow-reuse",
    workflowTaskId: "next",
    role: "worker",
    currentWorkflowAcceptedSameRole: [
      { taskId: "prior", worktreeId: "repo::/repo/senior-existing" },
    ],
    reuseRejections: [],
    isolationReason: "The prior role worktree still has a live session",
  });
});

test("a new workflow child without an isolation reason is refused before creation", async () => {
  let created = false;
  await assert.rejects(
    () =>
      createRoleWorktree(
        {
          org: "/repo/.omt/organization.json",
          role: "worker",
          repo: "/repo",
          name: "first-child",
          base: "b".repeat(40),
          state: "/repo/.omt",
          "workflow-id": "first-workflow",
          "workflow-task": "first-task",
        },
        {
          organization: roleOrganization,
          environment,
          matrix: supervised,
          read: () =>
            workflowSnapshot({
              tasks: { "first-task": { role: "worker", state: "pending" } },
            }),
          create: async () => {
            created = true;
            throw new Error("Orca creation must not be reached");
          },
        },
      ),
    /A new workflow child requires --fresh-reason/,
  );
  assert.equal(created, false);
});

test("new child selection reaches its role-session launch ledger", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-worktree-selection-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const orgFile = path.join(dir, "organization.json");
  fs.writeFileSync(orgFile, JSON.stringify(roleOrganization()));
  const worktreeId = `repo::${path.join(dir, "child")}`;
  const result = await createRoleWorktree(
    {
      org: orgFile,
      role: "worker",
      repo: dir,
      name: "new-child",
      base: "a".repeat(40),
      state: path.join(dir, ".omt"),
      "workflow-id": "selection-workflow",
      "workflow-task": "selection-task",
      "fresh-reason": "This role session needs an isolated checkout",
    },
    {
      organization: roleOrganization,
      environment,
      matrix: supervised,
      reuseRejections: [
        {
          worktreeId: "repo::/repo/unavailable",
          reason: "source-not-completed",
        },
      ],
      read: () =>
        workflowSnapshot({
          tasks: { "selection-task": { role: "worker", state: "pending" } },
        }),
      create: async (_repo, options) => {
        const workspace = { id: worktreeId, path: path.join(dir, "child") };
        return { workspace, session: await options.openRoleSession(workspace) };
      },
      open: async (workspace, launchArgs) => {
        assert.equal(launchArgs.viaRoleWorktreeCreate, true);
        const terminalArgs = { ...launchArgs };
        delete terminalArgs.state;
        delete terminalArgs["workflow-id"];
        delete terminalArgs["workflow-task"];
        return executeCommand(terminalArgs, undefined, {
          readLaunchEnvironment: environment,
          openRoleTerminal: async ({ command }) => ({
            ready: true,
            terminal: "selection-terminal",
            role: command.role,
            worktree: `id:${workspace.id}`,
            modelRequested: command.modelRequested,
          }),
        });
      },
    },
  );
  const recorded = readLaunches(orgFile)[0].worktreeSelection;
  assert.equal(result.id, worktreeId);
  assert.deepEqual(recorded, result.worktreeSelection);
  assert.equal(
    recorded.isolationReason,
    "This role session needs an isolated checkout",
  );
  assert.deepEqual(recorded.currentWorkflowAcceptedSameRole, []);
  assert.deepEqual(recorded.reuseRejections, [
    { worktreeId: "repo::/repo/unavailable", reason: "source-not-completed" },
  ]);
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
    role: "worker",
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
          ? { tasks: { "next-task": { role: "worker", state: "pending" } } }
          : {
              tasks: {
                "accepted-task": {
                  role: "worker",
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
      role: "worker",
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
      role: "worker",
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
            ? { tasks: { "next-task": { role: "worker", state: "pending" } } }
            : {
                tasks: {
                  "accepted-task": {
                    state: "accepted",
                    executionRole: "worker",
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
        role: "worker",
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
      { tasks: { prior: { state: "accepted", role: "worker" } } },
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
            role: "worker",
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
            role: "worker",
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
                        "next-task": { role: "worker", state: "pending" },
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
          role: "worker",
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
                      "next-task": { role: "worker", state: "pending" },
                      "other-task": {
                        role: "worker",
                        state: "running",
                        worktreeId: "repo::/repo/senior-existing",
                      },
                    },
                  }
                : {
                    tasks: {
                      "accepted-task": {
                        role: "worker",
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
    fs.readFileSync("plugins/oh-my-teams/scripts/cli-spec.mjs", "utf8"),
    /\[--prior-workflow-id ID --prior-task-id ID\]/,
  );
});

test("an integrated child is reclaimed only after every lifecycle proof", async (t) => {
  if (!durableSuccessSupported(t)) return;
  const f = reclaimSandbox(t);
  const calls = [];
  const result = await reclaimIntegratedRoleWorktree(
    {
      org: `${f.root}/.omt/organization.json`,
      state: `${f.root}/.omt`,
      "workflow-id": "workflow-a",
      "workflow-task": "task-a",
      repo: `${f.root}/integration`,
      worktree: `repo::${f.root}/child`,
      "merge-commit": "merge-a",
    },
    {
      show: f.show,
      scan: f.scan,
      read: () => ({
        state: {
          status: "accepted",
          integration: { decision: { evidenceKey: "integration" } },
          tasks: {
            "task-a": {
              state: "accepted",
              worktreeId: `repo::${f.root}/child`,
            },
          },
        },
      }),
      launches: () => [
        {
          via: "worker-start",
          workflowId: "workflow-a",
          workflowTaskId: "task-a",
          worktreePath: `${f.root}/child`,
          terminal: "term-a",
          workerId: "dispatch-earlier",
        },
        {
          via: "worker-start",
          workflowId: "workflow-a",
          workflowTaskId: "task-a",
          worktreePath: `${f.root}/child`,
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
    `reclaim:repo::${f.root}/child`,
  ]);
});

test("an active or unproven child is preserved instead of reclaimed", async (t) => {
  if (!durableSuccessSupported(t)) return;
  const f = reclaimSandbox(t);
  let reclaimed = false;
  await assert.rejects(
    () =>
      reclaimIntegratedRoleWorktree(
        {
          org: `${f.root}/.omt/organization.json`,
          state: `${f.root}/.omt`,
          "workflow-id": "workflow-a",
          "workflow-task": "task-a",
          repo: `${f.root}/integration`,
          worktree: `repo::${f.root}/child`,
          "merge-commit": "merge-a",
        },
        {
          show: f.show,
          scan: f.scan,
          read: () => ({
            state: {
              status: "accepted",
              integration: { decision: {} },
              tasks: {
                "task-a": {
                  state: "accepted",
                  worktreeId: `repo::${f.root}/child`,
                },
              },
            },
          }),
          launches: () => [
            {
              via: "worker-start",
              workflowId: "workflow-a",
              workflowTaskId: "task-a",
              worktreePath: `${f.root}/child`,
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

test("ambiguous Orca release, close, or terminal-list receipts preserve the child", async (t) => {
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
    const f = reclaimSandbox(t);
    let reclaimed = false;
    let listed = 0;
    await assert.rejects(
      () =>
        reclaimIntegratedRoleWorktree(
          {
            org: `${f.root}/.omt/organization.json`,
            state: `${f.root}/.omt`,
            "workflow-id": "workflow-a",
            "workflow-task": "task-a",
            repo: `${f.root}/integration`,
            worktree: `repo::${f.root}/child`,
            "merge-commit": "merge-a",
          },
          {
            show: f.show,
            scan: f.scan,
            read: () => ({
              state: {
                tasks: {
                  "task-a": {
                    state: "accepted",
                    worktreeId: `repo::${f.root}/child`,
                  },
                },
              },
            }),
            launches: () => [
              {
                via: "worker-start",
                workflowId: "workflow-a",
                workflowTaskId: "task-a",
                worktreePath: `${f.root}/child`,
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

test("an interactive terminal launch keeps its session when its ledger write fails", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-ledger-failure-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const orgFile = path.join(dir, "organization.json");
  fs.writeFileSync(orgFile, JSON.stringify(roleOrganization()));
  fs.writeFileSync(path.join(dir, "usage"), "not a directory");
  const result = recordLaunchSafely(orgFile, "2026-09-29T00:00:00.000Z", {
    via: "role-terminal",
    role: "worker",
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

test("headless record reader has no retained launch implementation", () => {
  const runtime = fs.readFileSync(
    path.resolve("plugins/oh-my-teams/scripts/headless.mjs"),
    "utf8",
  );
  assert.equal(Object.hasOwn(headlessRuntime, "headlessCommand"), false);
  assert.doesNotMatch(runtime, /\blaunchTurn\b/);
  assert.doesNotMatch(runtime, /\bspawn\s*\(/);
  assert.equal(Object.hasOwn(headlessRuntime, "startHeadlessWorker"), false);
  assert.equal(Object.hasOwn(headlessRuntime, "answerHeadless"), false);
});

function previouslyClosedRole(f) {
  const worktreeId = `repo::${f.root}/child`;
  const worktreePath = `${f.root}/child`;
  const launch = {
    via: "worker-start",
    at: "2026-01-01T00:00:00.000Z",
    terminal: "old-terminal",
    workerId: "old-dispatch",
    worktreePath,
  };
  const closure = {
    worktreeId,
    worktreePath,
    at: "2026-01-01T00:01:00.000Z",
    identity: { key: "exact-child" },
    terminals: [
      {
        terminal: "old-terminal",
        dispatch: { result: { status: "clear" } },
        releases: [
          {
            dispatchId: "old-dispatch",
            receipt: releasedExternalTerminal("old-dispatch"),
          },
        ],
        close: { receipt: closedTerminal("old-terminal") },
      },
    ],
    afterReceipt: { result: { terminals: [] } },
  };
  return { worktreeId, worktreePath, launch, closure };
}

test("an exact past closure and current empty inventory allow safe role reclaim", async (t) => {
  if (!durableSuccessSupported(t)) return;
  const f = reclaimSandbox(t);
  const old = previouslyClosedRole(f);
  const result = await reclaimIntegratedRoleWorktree(
    {
      org: `${f.root}/.omt/organization.json`,
      state: `${f.root}/.omt`,
      "workflow-id": "closed-flow",
      "workflow-task": "closed-task",
      repo: `${f.root}/integration`,
      worktree: old.worktreeId,
      "merge-commit": "head",
    },
    {
      read: () => ({
        state: {
          tasks: {
            "closed-task": { state: "accepted", worktreeId: old.worktreeId },
          },
        },
      }),
      show: f.show,
      scan: f.scan,
      launches: () => [old.launch],
      closures: () => [old.closure],
      recordClosure: () =>
        assert.fail("past closure must not be rewritten as an empty proof"),
      active: async () => assert.fail("historically closed terminal"),
      release: async () => assert.fail("already released"),
      close: async () => assert.fail("already closed"),
      list: async () => ({ result: { terminals: [] } }),
      git: async (_repo, args) => (args[0] === "rev-parse" ? "head" : ""),
      reclaim: async (_repo, options) => ({ removed: options.id }),
    },
  );
  assert.equal(result.reclaimed.removed, old.worktreeId);
  assert.deepEqual(result.terminals, []);
});

test("an empty inventory with no ownership history cannot authorize reclaim", async (t) => {
  if (!durableSuccessSupported(t)) return;
  const f = reclaimSandbox(t);
  const old = previouslyClosedRole(f);
  await assert.rejects(
    () =>
      reclaimIntegratedRoleWorktree(
        {
          org: `${f.root}/.omt/organization.json`,
          state: `${f.root}/.omt`,
          "workflow-id": "closed-flow",
          "workflow-task": "closed-task",
          repo: `${f.root}/integration`,
          worktree: old.worktreeId,
          "merge-commit": "head",
        },
        {
          read: () => ({
            state: {
              tasks: {
                "closed-task": {
                  state: "accepted",
                  worktreeId: old.worktreeId,
                },
              },
            },
          }),
          show: f.show,
          scan: f.scan,
          launches: () => [],
          closures: () => [old.closure],
          list: async () => ({ result: { terminals: [] } }),
          git: async (_repo, args) => (args[0] === "rev-parse" ? "head" : ""),
          reclaim: async () => assert.fail("unknown ownership"),
        },
      ),
    /No owned Dispatch/,
  );
});

function unavailableDirectorySync(t) {
  const sync = fs.fsyncSync;
  t.mock.method(fs, "fsyncSync", (fd) => {
    if (fs.fstatSync(fd).isDirectory())
      throw Object.assign(new Error("directory flush unsupported"), {
        code: "EINVAL",
      });
    return sync(fd);
  });
}

function legacyLifecycleFixture(
  t,
  { protocol = false, connected = false } = {},
) {
  const f = reclaimSandbox(t);
  const org = `${f.root}/.omt/organization.json`;
  const registry = registryDirectory(org);
  const file = fs
    .readdirSync(registry)
    .find(
      (name) =>
        name.endsWith(".json") &&
        readJSON(path.join(registry, name)).pm?.worktreeId,
    );
  const ownerFile = path.join(registry, file);
  const owner = readJSON(ownerFile);
  // Models a persisted pre-upgrade registration, never a production enrollment.
  if (!protocol) delete owner.reuseProtocol;
  fs.writeFileSync(ownerFile, JSON.stringify(owner));
  const createdAt = Date.parse(owner.createdAt) + 100;
  const old = previouslyClosedRole(f);
  const parent = {
    id: owner.pm.worktreeId,
    path: owner.pm.path,
    repoId: "repo",
    identity: {
      key: "parent-key",
      instanceId: "parent-instance",
      executionHostId: "local",
    },
  };
  const child = {
    id: old.worktreeId,
    path: old.worktreePath,
    repoId: "repo",
    parentWorktreeId: parent.id,
    head: "head",
    createdAt,
    identity: {
      key: "exact-child",
      instanceId: "child-instance",
      executionHostId: "local",
    },
    lineage: {
      worktreeId: old.worktreeId,
      worktreeInstanceId: "child-instance",
      parentWorktreeId: parent.id,
      parentWorktreeInstanceId: "parent-instance",
      origin: "cli",
      capture: { confidence: "explicit" },
      createdAt,
    },
  };
  Object.assign(old.launch, {
    at: new Date(createdAt + 100).toISOString(),
    kickoffPmWorktreeId: parent.id,
    workflowId: "closed-flow",
    workflowTaskId: "closed-task",
  });
  Object.assign(old.closure, {
    at: new Date(createdAt + 200).toISOString(),
    identity: child.identity,
  });
  const roleLaunch = {
    via: "role-terminal",
    at: new Date(createdAt + 10).toISOString(),
    terminal: old.launch.terminal,
    worktreePath: child.path,
    kickoffPmWorktreeId: parent.id,
    workflowId: "closed-flow",
  };
  const history = [roleLaunch, old.launch];
  const task = { role: "worker", state: "reviewed", worktreeId: child.id };
  const mutations = [];
  let attached = connected;
  const ports = {
    callerCwd: owner.pm.path,
    read: () => workflowSnapshot({ tasks: { "closed-task": task } }),
    environment,
    matrix: supervised,
    scan: f.scan,
    show: async (_exe, args) => ({
      result:
        args[1] === "ps"
          ? { worktrees: [] }
          : {
              worktree: structuredClone(
                args.at(-1).slice(3) === parent.id ? parent : child,
              ),
            },
    }),
    launches: () => history,
    closures: () => (connected ? [] : [old.closure]),
    recordClosure: (receipt) => {
      assert.equal(receipt.identity.key, child.identity.key);
    },
    active: async () => ({ status: "clear" }),
    release: async (id) => {
      mutations.push("release");
      return releasedExternalTerminal(id);
    },
    close: async () => {
      mutations.push("close");
      attached = false;
      return closedTerminal("old-terminal");
    },
    list: async () => ({
      result: { terminals: attached ? [{ handle: "old-terminal" }] : [] },
    }),
    git: async (_repo, args) => (args[0] === "rev-parse" ? "head" : ""),
    create: async () => assert.fail("must not create"),
    reclaim: async (_repo, options) => {
      mutations.push("remove");
      return { removed: options.id };
    },
  };
  const args = {
    org,
    state: `${f.root}/.omt`,
    "workflow-id": "closed-flow",
    "workflow-task": "closed-task",
    repo: owner.pm.path,
    role: "worker",
    name: "unused",
    base: "head",
    worktree: child.id,
    "merge-commit": "head",
  };
  const run = () => {
    task.state = "accepted";
    return reclaimIntegratedRoleWorktree(args, ports);
  };
  return {
    ...f,
    org,
    old,
    owner,
    parent,
    child,
    history,
    task,
    ports,
    args,
    mutations,
    run,
  };
}

test("unsupported directory durability preserves proven legacy reclaim without claiming protocol support", async (t) => {
  for (const kind of ["reclaim"]) {
    for (const connected of [false, true]) {
      await t.test(
        `${kind}: ${connected ? "connected owned terminal" : "exact historical closure"}`,
        async (t) => {
          const f = legacyLifecycleFixture(t, { connected });
          unavailableDirectorySync(t);
          const result = await f.run();
          assert.equal(result.legacyLifecycle.mode, "legacy-same-task");
          assert.equal(result.legacyLifecycle.durable, false);
          assert.deepEqual(f.mutations, [
            ...(connected ? ["release", "close"] : []),
            "remove",
          ]);
          assert.equal(
            fs.existsSync(
              path.join(path.dirname(f.org), "worktree-transitions.json"),
            ),
            false,
          );
        },
      );
    }
  }
});

test("unsupported new-protocol reclaim makes zero external mutations", async (t) => {
  for (const kind of ["reclaim"])
    await t.test(kind, async (t) => {
      const f = legacyLifecycleFixture(t, { protocol: true, connected: true });
      unavailableDirectorySync(t);
      await assert.rejects(() => f.run(), {
        code: "worktree-durability-unavailable",
      });
      assert.deepEqual(f.mutations, []);
    });
});

test("legacy compatibility rejects new owners, journal resources and ambiguous historic instance proofs", async (t) => {
  const changes = {
    "journal-owned": (f) =>
      fs.writeFileSync(
        path.join(path.dirname(f.org), "worktree-transitions.json"),
        JSON.stringify({
          schemaVersion: 1,
          entries: [
            {
              type: "reuse",
              status: "completed",
              worktreeId: f.child.id,
              targetWorktreeId: f.parent.id,
              workflowId: "closed-flow",
              taskId: "closed-task",
            },
          ],
        }),
      ),
    "unpaired-role-terminal": (f) => {
      f.history[0].terminal = "unowned-terminal";
    },
    "foreign-role-owner": (f) => {
      f.history[0].kickoffPmWorktreeId = "other-owner";
    },
    "foreign-role-workflow": (f) => {
      f.history[0].workflowId = "other-workflow";
    },
    "explicit-foreign-role-task": (f) => {
      f.history[0].workflowTaskId = "other-task";
    },
    "role-terminal-after-dispatch": (f) => {
      f.history[0].at = new Date(Date.parse(f.old.launch.at) + 1).toISOString();
    },
    "missing-worker-task": (f) => {
      delete f.old.launch.workflowTaskId;
    },
    "new-protocol-only": (f) => {
      f.old.launch.worktreeProtocolVersion = 1;
    },
    "foreign-owner": (f) => {
      f.old.launch.kickoffPmWorktreeId = "new-protocol-pm";
    },
    "foreign-task": (f) => {
      f.old.launch.workflowTaskId = "another-task";
    },
    "recreated-instance": (f) => {
      f.child.createdAt = Date.parse(f.old.launch.at) + 1;
      f.child.lineage.createdAt = f.child.createdAt;
    },
    "missing-instance-age": (f) => {
      delete f.child.createdAt;
    },
    "manual-lineage": (f) => {
      f.child.lineage.origin = "manual";
    },
    "parent-instance": (f) => {
      f.child.lineage.parentWorktreeInstanceId = "replacement";
    },
    "wrong-closure": (f) => {
      f.old.closure.identity = { key: "another-instance" };
    },
    "unknown-dispatch": (f) => {
      f.ports.active = async () => ({ status: "unknown" });
      f.ports.closures = () => [];
    },
    "another-task-claim": (f) => {
      f.ports.read = () =>
        workflowSnapshot({
          tasks: {
            "closed-task": f.task,
            "other-task": { state: "accepted", worktreeId: f.child.id },
          },
        });
    },
    "identity-changed-after-scan": (f) => {
      const scan = f.ports.scan;
      f.ports.scan = async (...args) => {
        const result = await scan(...args);
        f.child.identity.key = "replacement-after-scan";
        return result;
      };
    },
    "dirty-git": (f) => {
      f.ports.git = async (_repo, args) =>
        args[0] === "status" ? " M dirty" : "head";
    },
    "incomplete-global-inventory": (f) => {
      f.ports.scan = async () => ({ inventoryComplete: false, candidates: [] });
    },
  };
  for (const [label, change] of Object.entries(changes))
    for (const kind of ["reclaim"]) {
      await t.test(`${kind}: ${label}`, async (t) => {
        const f = legacyLifecycleFixture(t);
        change(f);
        unavailableDirectorySync(t);
        await assert.rejects(() => f.run());
        assert.deepEqual(f.mutations, []);
      });
    }
});

test("a durable prepare failure never falls back to legacy compatibility after a successful capability probe", async (t) => {
  for (const kind of ["reclaim"])
    await t.test(kind, async (t) => {
      const f = legacyLifecycleFixture(t);
      try {
        assertDirectorySync(path.dirname(f.org));
      } catch (error) {
        assert.equal(error.code, "worktree-durability-unavailable");
        return t.skip(
          "Initial capability is unavailable; subsequent-write failure requires supported directory sync",
        );
      }
      const sync = fs.fsyncSync;
      let directoryCalls = 0;
      t.mock.method(fs, "fsyncSync", (fd) => {
        if (fs.fstatSync(fd).isDirectory() && ++directoryCalls === 2)
          throw Object.assign(new Error("later directory failure"), {
            code: "EINVAL",
          });
        return sync(fd);
      });
      try {
        await f.run();
        assert.fail("must refuse interrupted preparation");
      } catch (error) {
        assert.equal(error.code, "worktree-durability-unavailable");
      }
      assert.deepEqual(f.mutations, []);
    });
});
