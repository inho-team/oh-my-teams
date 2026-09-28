/** Regressions for session-bound OMT worktree creation and headless rejection. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorktreeWithRoleSession } from "../plugins/oh-my-teams/scripts/orca-adapter.mjs";
import { readJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import { predictLaunchPath } from "../plugins/oh-my-teams/scripts/launch-matrix.mjs";
import {
  answerHeadless,
  startHeadlessWorker,
} from "../plugins/oh-my-teams/scripts/headless.mjs";
import {
  createRoleWorktree,
  main,
  recordLaunchSafely,
  reclaimIntegratedRoleWorktree,
} from "../plugins/oh-my-teams/scripts/teams-org.mjs";

const discovery = { executable: "orca", versionsMatch: true };
const roleOrganization = () =>
  readJSON(path.resolve("plugins/oh-my-teams/examples/organization.json"));
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
      read: () => ({
        state: {
          tasks: {
            "w2-00": {
              role: "junior",
              worktreeId: "repo::/repo/junior-rejected",
            },
            "senior-prior": {
              role: "senior",
              state: "accepted",
              worktreeId: "repo::/repo/senior-existing",
            },
          },
        },
      }),
      git: async (repo, argv) => {
        if (argv[0] === "status") return "";
        if (argv[0] === "rev-parse" && argv[1] === "HEAD")
          return repo === "/repo" ? "integration-a" : "senior-a";
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
      read: () => ({
        state: {
          tasks: {
            next: { role: "senior", state: "pending" },
            prior: {
              role: "senior",
              state: "accepted",
              worktreeId: "repo::/repo/senior-existing",
            },
          },
        },
      }),
      git: async (repo, argv) => {
        if (argv[0] === "status") return "";
        if (argv[0] === "rev-parse" && argv[1] === "HEAD")
          return repo === "/repo" ? "integration-a" : "senior-a";
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
      "close",
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
