/** Regression tests for conservative kickoff worktree reconciliation. */
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateKickoffCleanup } from "../plugins/oh-my-teams/scripts/kickoff-cleanup.mjs";

const pm = "repo::/tmp/pm";
const child = "repo::/tmp/child";
const entry = {
  pm: { worktreeId: pm, path: "/tmp/pm" },
  director: { terminalHandle: "director-terminal" },
  createdAt: "2026-09-29T00:00:00.000Z",
  releasedAt: "2026-09-29T01:00:00.000Z",
  runId: "run-1",
};
const worktrees = [
  {
    worktreeId: pm,
    path: "/tmp/pm",
    childWorktreeIds: [child],
    liveTerminalCount: 0,
  },
  {
    worktreeId: child,
    path: "/tmp/child",
    parentWorktreeId: pm,
    liveTerminalCount: 0,
  },
];
const exited = (id) => ({
  dispatchId: `dispatch-${id}`,
  projection: { workspace: { id }, liveness: { verdict: "exited" } },
  terminalState: "released",
});
const clean = { head: "head", dirty: false, ignored: false, included: true };
const observed = () => ({
  worktrees,
  terminals: [],
  workers: [exited(pm), exited(child)],
  git: { [pm]: clean, [child]: clean },
  inventoryComplete: true,
});

test("completed kickoff classifies delivered, clean, exited worktrees as safe", () => {
  const result = evaluateKickoffCleanup(entry, observed());
  assert.deepEqual(
    result.candidates.map((item) => item.status),
    ["safe-to-remove", "safe-to-remove"],
  );
  assert.equal(result.status, "cleanup-pending");
  assert.equal(result.candidates[0].owner, "director-terminal");
});

test("dirty, ignored, undelivered, and live evidence preserves its own candidate", () => {
  const input = observed();
  input.git[child] = {
    head: "other",
    dirty: true,
    ignored: true,
    included: false,
  };
  input.terminals = [{ handle: "live", worktreeId: child }];
  const result = evaluateKickoffCleanup(entry, input);
  assert.equal(result.candidates[0].status, "safe-to-remove");
  assert.equal(result.candidates[1].status, "preserve");
  assert.deepEqual(result.candidates[1].reasons, [
    "uncommitted-changes",
    "local-evidence-unpreserved",
    "head-not-delivered",
    "terminal-or-process-live",
  ]);
});

test("missing process proof and incomplete inventories refuse reclamation", () => {
  const input = observed();
  input.workers = [];
  input.inventoryComplete = false;
  const result = evaluateKickoffCleanup(entry, input);
  assert.equal(result.candidates[0].status, "preserve");
  assert.ok(result.candidates[0].reasons.includes("process-exit-unproven"));
  assert.ok(result.candidates[0].reasons.includes("inventory-incomplete"));
});

test("a sessionless child stays preserved without an explicit exit receipt", () => {
  const input = observed();
  input.workers = [exited(pm)];
  input.remoteHostsOmitted = true;
  input.worktrees = [
    worktrees[0],
    { ...worktrees[1], hasAttachedPty: false, agents: [] },
  ];
  const result = evaluateKickoffCleanup(entry, input);
  assert.equal(result.candidates[1].status, "preserve");
  assert.ok(result.candidates[1].reasons.includes("process-exit-unproven"));
});

test("an absent child remains preserved when remote hosts were omitted", () => {
  const input = observed();
  input.worktrees = [{ ...worktrees[0], childWorktreeIds: [child] }];
  input.absentPaths = ["/tmp/child"];
  input.remoteHostsOmitted = true;
  const result = evaluateKickoffCleanup(entry, input);
  assert.equal(result.candidates[1].status, "preserve");
  assert.ok(result.candidates[1].reasons.includes("remote-hosts-omitted"));
});

test("historical rescan retains removed child candidates without duplicating cleanup", () => {
  const history = {
    ...entry,
    cleanup: {
      candidates: [
        { worktreeId: pm, path: "/tmp/pm" },
        { worktreeId: child, path: "/tmp/child" },
      ],
    },
  };
  const input = observed();
  input.worktrees = [worktrees[0]];
  input.worktrees[0] = { ...worktrees[0], childWorktreeIds: [] };
  input.absentPaths = ["/tmp/child"];
  const result = evaluateKickoffCleanup(history, input);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[1].status, "already-removed");
  assert.equal(result.candidates[0].status, "safe-to-remove");
});
