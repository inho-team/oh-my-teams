/** Regressions for session-bound OMT worktree creation and headless rejection. */
import test from "node:test";
import assert from "node:assert/strict";
import { createWorktreeWithRoleSession } from "../plugins/oh-my-teams/scripts/orca-adapter.mjs";
import { predictLaunchPath } from "../plugins/oh-my-teams/scripts/launch-matrix.mjs";
import {
  answerHeadless,
  startHeadlessWorker,
} from "../plugins/oh-my-teams/scripts/headless.mjs";
import {
  createRoleWorktree,
  main,
  reclaimIntegratedRoleWorktree,
} from "../plugins/oh-my-teams/scripts/teams-org.mjs";

const discovery = { executable: "orca", versionsMatch: true };

function workspaceReceipt() {
  return JSON.stringify({
    ok: true,
    result: { worktree: { id: "wt_1", path: "/repo/child" } },
  });
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
          },
        },
      }),
      git: async (_repo, argv) => {
        assert.deepEqual(argv, ["status", "--porcelain=v1", "-uall"]);
        return "";
      },
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
        return { released: true };
      },
      close: async (_orca, argv) => {
        calls.push(`close:${argv.at(-1)}`);
        return { result: { closed: true } };
      },
      reclaim: async (_repo, options) => {
        calls.push(`reclaim:${options.id}`);
        return { result: { removed: true } };
      },
    },
  );
  assert.equal(result.head, "child-a");
  assert.deepEqual(calls.slice(-4), [
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
          reclaim: async () => {
            reclaimed = true;
          },
        },
      ),
    /do not reclaim/,
  );
  assert.equal(reclaimed, false);
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
