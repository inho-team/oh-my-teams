/** Regression tests for conservative kickoff worktree reconciliation. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evaluateKickoffCleanup,
  reclaimKickoffCleanup,
  scanKickoffCleanup,
} from "../plugins/oh-my-teams/scripts/kickoff-cleanup.mjs";
import {
  listKickoffs,
  registerKickoff,
  releaseKickoff,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";
import { readJSON } from "../plugins/oh-my-teams/scripts/core.mjs";

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
    worktreeInstanceId: "pm-instance",
    childWorktreeIds: [child],
    liveTerminalCount: 0,
  },
  {
    worktreeId: child,
    path: "/tmp/child",
    worktreeInstanceId: "child-instance",
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

test("a matching Orca PTY kill receipt proves a role launch ended", () => {
  const input = observed();
  input.workers = [exited(pm)];
  input.launches = [
    {
      at: "2026-09-29T00:10:00.000Z",
      worktreePath: "/tmp/child",
      terminal: "term-child",
      workerId: null,
    },
  ];
  input.closures = [
    {
      at: "2026-09-29T00:20:00.000Z",
      worktreeId: child,
      worktreePath: "/tmp/child",
      terminals: [
        {
          terminal: "term-child",
          dispatch: { result: { status: "clear" } },
          close: {
            receipt: {
              result: {
                close: {
                  handle: "term-child",
                  tabId: "tab-1",
                  ptyKilled: true,
                },
              },
            },
          },
          releases: [],
        },
      ],
      beforeReceipt: { result: { terminals: [{ handle: "term-child" }] } },
      afterReceipt: { result: { terminals: [] } },
    },
  ];
  assert.equal(
    evaluateKickoffCleanup(entry, input).candidates[1].status,
    "safe-to-remove",
  );
  input.closures[0].terminals[0].close.receipt.result.close.ptyKilled = false;
  assert.equal(
    evaluateKickoffCleanup(entry, input).candidates[1].status,
    "preserve",
  );
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

test("a removed local child can be verified despite unrelated remote host omissions", () => {
  const history = {
    ...entry,
    cleanup: {
      candidates: [
        {
          worktreeId: pm,
          path: "/tmp/pm",
          instanceId: "pm-instance",
          hostId: "local",
        },
        {
          worktreeId: child,
          path: "/tmp/child",
          instanceId: "child-instance",
          hostId: "local",
        },
      ],
    },
  };
  const input = observed();
  input.worktrees = [{ ...worktrees[0], childWorktreeIds: [] }];
  input.absentPaths = ["/tmp/child"];
  input.remoteHostsOmitted = true;
  input.hostIds = ["local"];
  assert.equal(
    evaluateKickoffCleanup(history, input).candidates[1].status,
    "already-removed",
  );
});

test("historical rescan retains removed child candidates without duplicating cleanup", () => {
  const history = {
    ...entry,
    cleanup: {
      candidates: [
        { worktreeId: pm, path: "/tmp/pm", instanceId: "pm-instance" },
        { worktreeId: child, path: "/tmp/child", instanceId: "child-instance" },
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

test("historical scan preserves a replacement worktree at the same path", () => {
  const history = {
    ...entry,
    cleanup: {
      candidates: [
        { worktreeId: pm, path: "/tmp/pm", instanceId: "old-pm-instance" },
        {
          worktreeId: child,
          path: "/tmp/child",
          instanceId: "old-child-instance",
        },
      ],
    },
  };
  const input = observed();
  const result = evaluateKickoffCleanup(history, input);
  assert.equal(result.candidates[0].status, "preserve");
  assert.ok(result.candidates[0].reasons.includes("worktree-instance-changed"));
  assert.equal(result.candidates[1].status, "preserve");
  assert.ok(result.candidates[1].reasons.includes("worktree-instance-changed"));
});

test("a completed archive retains child identity for read-only partial cleanup reentry", async (t) => {
  const project = fs.mkdtempSync(
    path.join(os.tmpdir(), "omt-cleanup-history-"),
  );
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const orgFile = path.join(project, ".omt", "organization.json");
  const pmPath = path.join(project, "pm");
  const childPath = path.join(project, "child");
  const brief = path.join(project, "brief.md");
  fs.mkdirSync(path.dirname(orgFile), { recursive: true });
  fs.mkdirSync(pmPath);
  fs.mkdirSync(childPath);
  fs.writeFileSync(brief, "Goal and acceptance criteria");
  fs.copyFileSync(
    path.resolve("plugins/oh-my-teams/examples/organization.json"),
    orgFile,
  );
  const pmId = `repo::${pmPath}`;
  const childId = `repo::${childPath}`;
  registerKickoff(orgFile, {
    goal: "reconcile worktrees",
    pm: { worktreeId: pmId, path: pmPath, stateDir: path.join(pmPath, ".omt") },
    organizationRevision: readJSON(orgFile).revision,
    brief,
    delivery: { mode: "none" },
  });
  let childPresent = true;
  const orca = async (_executable, args) => ({
    result:
      args[0] === "worktree"
        ? {
            worktrees: [
              {
                worktreeId: pmId,
                path: pmPath,
                worktreeInstanceId: "pm-fixture-instance",
                childWorktreeIds: childPresent ? [childId] : [],
              },
              ...(childPresent
                ? [
                    {
                      worktreeId: childId,
                      path: childPath,
                      worktreeInstanceId: "child-fixture-instance",
                      parentWorktreeId: pmId,
                    },
                  ]
                : []),
            ],
          }
        : { terminals: [] },
  });
  const cleanup = await scanKickoffCleanup(
    { orgFile, worktreeId: pmId },
    { orca },
  );
  assert.deepEqual(
    cleanup.candidates.map((candidate) => candidate.status),
    ["preserve", "preserve"],
  );
  const released = releaseKickoff(orgFile, {
    worktreeId: pmId,
    reason: "completed",
    cleanup,
  });
  assert.equal(readJSON(released.archived).cleanup.candidates.length, 2);
  assert.equal(
    readJSON(released.archived).cleanup.candidates[1].instanceId,
    "child-fixture-instance",
  );
  childPresent = false;
  fs.rmSync(childPath, { recursive: true });
  const rescanned = await scanKickoffCleanup(
    {
      orgFile,
      worktreeId: pmId,
      archiveFile: released.archived,
    },
    { orca },
  );
  assert.deepEqual(
    rescanned.candidates.map((candidate) => candidate.status),
    ["preserve", "already-removed"],
  );
  assert.equal(readJSON(released.archived).cleanup.candidates.length, 2);
});

function reclaimFixture(t) {
  const project = fs.mkdtempSync(
    path.join(os.tmpdir(), "omt-cleanup-reclaim-"),
  );
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const orgFile = path.join(project, ".omt", "organization.json");
  const brief = path.join(project, "brief.md");
  fs.mkdirSync(path.dirname(orgFile), { recursive: true });
  fs.copyFileSync(
    path.resolve("plugins/oh-my-teams/examples/organization.json"),
    orgFile,
  );
  fs.writeFileSync(brief, "Goal and acceptance criteria");
  const pmId = `repo::${path.join(project, "pm")}`;
  const firstId = `repo::${path.join(project, "first")}`;
  const secondId = `repo::${path.join(project, "second")}`;
  registerKickoff(orgFile, {
    goal: "reclaim completed kickoff",
    pm: {
      worktreeId: pmId,
      path: path.join(project, "pm"),
      stateDir: path.join(project, "pm", ".omt"),
    },
    organizationRevision: readJSON(orgFile).revision,
    brief,
    delivery: { mode: "none" },
    director: { terminalHandle: "term-director", checkoutPath: project },
  });
  const archived = releaseKickoff(orgFile, {
    worktreeId: pmId,
    reason: "completed",
    callerCwd: project,
    cleanup: {
      schemaVersion: 1,
      worktreeId: pmId,
      createdAt: listKickoffs(orgFile, pmId).kickoffs[0].createdAt,
      status: "cleanup-pending",
      candidates: [pmId, firstId, secondId].map((worktreeId) => ({
        worktreeId,
        status: "preserve",
      })),
    },
  }).archived;
  const removed = new Set();
  const preserved = new Set();
  const calls = [];
  const scan = async () => ({
    status: removed.size === 3 ? "clean" : "cleanup-pending",
    candidates: [pmId, firstId, secondId].map((worktreeId) => ({
      worktreeId,
      path: worktreeId.split("::")[1],
      parentWorktreeId: worktreeId === pmId ? null : pmId,
      instanceId: `${worktreeId}-instance`,
      hostId: "local",
      owner: "term-director",
      status: removed.has(worktreeId)
        ? "already-removed"
        : preserved.has(worktreeId)
          ? "preserve"
          : "safe-to-remove",
      reasons: preserved.has(worktreeId) ? ["local-evidence-unpreserved"] : [],
    })),
  });
  const show = async (_executable, args) => {
    const id = args[3].slice(3);
    return {
      result: {
        worktree: {
          id,
          path: id.split("::")[1],
          identity: {
            key: `wt2:local:${id}-instance`,
            executionHostId: "local",
            instanceId: `${id}-instance`,
          },
        },
      },
    };
  };
  const reclaim = async (_projectDir, { id }) => {
    calls.push(id);
    removed.add(id);
    return { result: { removed: id } };
  };
  const request = {
    orgFile,
    worktreeId: pmId,
    archiveFile: archived,
    callerCwd: project,
  };
  return {
    request,
    ids: { pmId, firstId, secondId },
    removed,
    preserved,
    calls,
    scan,
    show,
    reclaim,
  };
}

test("reclaim removes safe children before their PM and stores receipts", async (t) => {
  const fixture = reclaimFixture(t);
  const result = await reclaimKickoffCleanup(fixture.request, fixture);
  assert.deepEqual(fixture.calls, [
    fixture.ids.secondId,
    fixture.ids.firstId,
    fixture.ids.pmId,
  ]);
  assert.equal(result.attempts.length, 3);
  assert.ok(
    result.attempts.every(
      (attempt) => attempt.outcome === "removed" && attempt.receipt,
    ),
  );
  assert.equal(result.latest.status, "clean");
  assert.equal(readJSON(result.recordFile).attempts.length, 3);
});

test("an Orca removal error stays unverified and is not retried", async (t) => {
  const fixture = reclaimFixture(t);
  const result = await reclaimKickoffCleanup(fixture.request, {
    scan: fixture.scan,
    show: fixture.show,
    reclaim: async () => {
      throw new Error("Orca refused removal");
    },
  });
  assert.equal(result.latest.status, "cleanup-pending");
  assert.ok(
    result.attempts.every((attempt) => attempt.outcome === "unverified"),
  );
  assert.match(result.attempts[0].error, /Orca refused removal/);
  const retried = await reclaimKickoffCleanup(fixture.request, fixture);
  assert.equal(retried.attempts.length, result.attempts.length);
  assert.deepEqual(fixture.calls, []);
});

test("a replacement between scan and show is refused before Orca removal", async (t) => {
  const fixture = reclaimFixture(t);
  const result = await reclaimKickoffCleanup(fixture.request, {
    scan: fixture.scan,
    show: async (_executable, args) => {
      const id = args[3].slice(3);
      return {
        result: {
          worktree: {
            id,
            path: id.split("::")[1],
            identity: {
              key: "wt2:local:replacement",
              executionHostId: "local",
              instanceId: "replacement",
            },
          },
        },
      };
    },
    reclaim: fixture.reclaim,
  });
  assert.deepEqual(fixture.calls, []);
  assert.ok(result.attempts.every((attempt) => attempt.outcome === "refused"));
  assert.match(result.attempts[0].error, /identity changed/);
});

test("partial cleanup preserves a blocked sibling and reentry removes only remaining candidates", async (t) => {
  const fixture = reclaimFixture(t);
  fixture.preserved.add(fixture.ids.firstId);
  const first = await reclaimKickoffCleanup(fixture.request, fixture);
  assert.deepEqual(fixture.calls, [fixture.ids.secondId]);
  assert.equal(first.latest.status, "cleanup-pending");
  fixture.preserved.delete(fixture.ids.firstId);
  const second = await reclaimKickoffCleanup(fixture.request, fixture);
  assert.deepEqual(fixture.calls, [
    fixture.ids.secondId,
    fixture.ids.firstId,
    fixture.ids.pmId,
  ]);
  assert.equal(second.latest.status, "clean");
  assert.equal(second.attempts.length, 3);
});

test("an unobserved Orca removal is not repeated on reentry", async (t) => {
  const fixture = reclaimFixture(t);
  let scans = 0;
  const scan = async () => {
    scans += 1;
    if (scans === 3) throw new Error("post-removal inventory unavailable");
    return fixture.scan();
  };
  const uncertain = await reclaimKickoffCleanup(fixture.request, {
    scan,
    show: fixture.show,
    reclaim: async (_projectDir, { id }) => {
      fixture.calls.push(id);
      return { result: { accepted: true } };
    },
  });
  assert.equal(uncertain.attempts[0].outcome, "unverified");
  assert.match(uncertain.attempts[0].error, /inventory unavailable/);
  await reclaimKickoffCleanup(fixture.request, fixture);
  assert.equal(
    fixture.calls.filter((id) => id === fixture.ids.secondId).length,
    1,
  );
});
