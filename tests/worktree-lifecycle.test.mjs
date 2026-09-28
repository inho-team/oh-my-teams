/** Regressions for session-bound OMT worktree creation and headless rejection. */
import test from "node:test";
import assert from "node:assert/strict";
import { createWorktreeWithRoleSession } from "../plugins/oh-my-teams/scripts/orca-adapter.mjs";
import { predictLaunchPath } from "../plugins/oh-my-teams/scripts/launch-matrix.mjs";
import { main } from "../plugins/oh-my-teams/scripts/teams-org.mjs";

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
