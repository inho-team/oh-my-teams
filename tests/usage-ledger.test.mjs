/** Test suite for usage ledger appending and reading. */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recordLaunch,
  recordTerminalClosure,
  readLaunches,
  readTerminalClosures,
  resolveLaunchKickoff,
} from "../plugins/oh-my-teams/scripts/usage-ledger.mjs";

test("P-09: readLaunches and recordLaunch", () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-ledger-"));
  const orgFile = path.join(tmpdir, "organization.json");
  recordLaunch(orgFile, { role: "senior", via: "role-terminal" });
  const launches = readLaunches(orgFile);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].role, "senior");
  assert.equal(launches[0].via, "role-terminal");
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

test("terminal closure evidence survives a later role-worktree reuse", () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-closure-ledger-"));
  const orgFile = path.join(tmpdir, "organization.json");
  recordTerminalClosure(orgFile, {
    worktreeId: "repo::/repo/child",
    worktreePath: "/repo/child",
    terminals: [
      {
        terminal: "term_closed",
        workerIds: ["dispatch_closed"],
        dispatch: { result: { status: "clear" } },
        releases: [
          {
            dispatchId: "dispatch_closed",
            receipt: {
              result: {
                dispatchId: "dispatch_closed",
                state: "retained",
                reason: "external_terminal",
                processAction: "none",
              },
            },
          },
        ],
        close: {
          terminal: "term_closed",
          receipt: {
            result: {
              close: {
                handle: "term_closed",
                tabId: "tab_closed",
                ptyKilled: true,
              },
            },
          },
        },
      },
    ],
    beforeReceipt: { result: { terminals: [{ handle: "term_closed" }] } },
    afterReceipt: { result: { terminals: [] } },
  });
  const [closure] = readTerminalClosures(orgFile);
  assert.equal(closure.worktreePath, "/repo/child");
  assert.equal(closure.terminals[0].close.receipt.result.close.ptyKilled, true);
  assert.equal(closure.terminals[0].releases[0].dispatchId, "dispatch_closed");
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

test("P-09: resolveLaunchKickoff", () => {
  const kickoffs = [
    { pm: { worktreeId: "wt-1", stateDir: "/state/wt1", path: "/pm/wt1" } },
    { pm: { worktreeId: "wt-2", stateDir: "/state/wt2", path: "/pm/wt2" } },
  ];

  assert.equal(
    resolveLaunchKickoff(kickoffs, [], {
      stateDir: "/state/wt1",
      callerCwd: "/other",
    }),
    "wt-1",
  );

  assert.equal(
    resolveLaunchKickoff(kickoffs, [], {
      stateDir: "/state/wt3",
      callerCwd: "/pm/wt2/sub",
    }),
    "wt-2",
  );
});
