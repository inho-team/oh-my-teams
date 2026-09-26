/** Signal channel and resource slot tests. */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJSON, readJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  findPmTerminal,
  notifyDirector,
  notifyDirectorSignal,
  sendSignal,
  listInbox,
  replySignal,
  acknowledgeSignal,
  readSignal,
  findCloseReadySignal,
  SIGNAL_KINDS,
  processLiveness,
} from "../plugins/oh-my-teams/scripts/director.mjs";
import { releaseKickoff } from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";
import {
  acquireResource,
  directorWatch,
  parseMeminfo,
  parseVmStat,
  queryPmLiveness,
  releaseResource,
  RESOURCE_KINDS,
} from "../plugins/oh-my-teams/scripts/resources.mjs";

const exampleOrg = readJSON(
  new URL("../plugins/oh-my-teams/examples/organization.json", import.meta.url),
);

// A real captured Claude Code AskUserQuestion screen (#82's regression case),
// not a screen invented for this test file.
const askUserScreen = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "prompt-screens",
      "claude-2.1.278-askuser-default.json",
    ),
    "utf8",
  ),
).lines;

// Creates a temporary project directory with organization.json and a registered
// kickoff entry for a PM worktree. Returns { dir, orgFile, worktreeId }.
function makeProject(t, { withDirectorTerminal = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-dsig-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const omtDir = path.join(dir, ".omt");
  fs.mkdirSync(omtDir, { recursive: true });
  const orgFile = path.join(omtDir, "organization.json");
  writeJSON(orgFile, exampleOrg);

  const pmDir = path.join(dir, "pm-worktree");
  fs.mkdirSync(pmDir, { recursive: true });
  const pmOmtDir = path.join(pmDir, ".omt");
  fs.mkdirSync(pmOmtDir, { recursive: true });

  const worktreeId = `test-repo::${pmDir}`;
  const briefFile = path.join(dir, "brief.md");
  fs.writeFileSync(briefFile, "test brief\n");

  // Write a kickoff registry entry using the same digest logic as kickoff-registry.mjs.
  const entryName = crypto
    .createHash("sha256")
    .update(worktreeId)
    .digest("hex");
  const registryDir = path.join(omtDir, "kickoffs");
  fs.mkdirSync(registryDir, { recursive: true });
  writeJSON(path.join(registryDir, `${entryName}.json`), {
    schemaVersion: 1,
    goal: "test goal",
    pm: { worktreeId, path: pmDir, stateDir: pmOmtDir },
    runId: null,
    organizationRevision: exampleOrg.revision,
    brief: briefFile,
    delivery: { mode: "none" },
    createdAt: new Date().toISOString(),
    ...(withDirectorTerminal
      ? { director: { terminalHandle: "mock-handle", checkoutPath: dir } }
      : {}),
  });

  return { dir, orgFile, worktreeId };
}

// Registers a second kickoff in the same project and returns its worktree id.
function addKickoff(dir, orgFile, name) {
  const pmDir = path.join(dir, name);
  fs.mkdirSync(path.join(pmDir, ".omt"), { recursive: true });
  const worktreeId = `test-repo::${pmDir}`;
  const entryName = crypto
    .createHash("sha256")
    .update(worktreeId)
    .digest("hex");
  writeJSON(path.join(path.dirname(orgFile), "kickoffs", `${entryName}.json`), {
    schemaVersion: 1,
    goal: "other goal",
    pm: { worktreeId, path: pmDir, stateDir: path.join(pmDir, ".omt") },
    runId: null,
    organizationRevision: exampleOrg.revision,
    brief: path.join(dir, "brief.md"),
    delivery: { mode: "none" },
    createdAt: new Date().toISOString(),
  });
  return worktreeId;
}

// ─── SIGNAL_KINDS and RESOURCE_KINDS ─────────────────────────────────────────

test("SIGNAL_KINDS contains the four expected kinds", () => {
  assert.deepEqual(
    [...SIGNAL_KINDS],
    ["decision", "close-ready", "blocked", "progress"],
  );
});

test("RESOURCE_KINDS contains the three expected kinds", () => {
  assert.deepEqual([...RESOURCE_KINDS], ["test", "worker", "build"]);
});

// ─── sendSignal ───────────────────────────────────────────────────────────────

test("sendSignal writes a pending record and lists it in director-inbox", (t) => {
  const { orgFile, worktreeId } = makeProject(t);

  const result = sendSignal(orgFile, {
    worktreeId,
    kind: "blocked",
    text: "waiting on a decision",
  });

  assert.ok(result.signaled);
  assert.ok(result.id);

  const { signals } = listInbox(orgFile);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].id, result.id);
  assert.equal(signals[0].kind, "blocked");
  assert.equal(signals[0].text, "waiting on a decision");
  assert.equal(signals[0].status, "pending");
  assert.equal(signals[0].worktreeId, worktreeId);
});

test("a progress signal is stored acknowledged and never waits in the pending list", (t) => {
  const { orgFile, worktreeId } = makeProject(t);

  const first = sendSignal(orgFile, {
    worktreeId,
    kind: "progress",
    text: "halfway done",
  });
  assert.equal(first.record.status, "acknowledged");
  assert.equal(first.record.autoAcknowledged, true);
  assert.ok(first.record.acknowledgedAt);
  assert.deepEqual(listInbox(orgFile).signals, []);

  // Nothing is pending, so the same progress text may be sent again.
  const second = sendSignal(orgFile, {
    worktreeId,
    kind: "progress",
    text: "halfway done",
  });
  assert.notEqual(second.id, first.id);
  assert.equal(readSignal(orgFile, first.id).status, "acknowledged");
});

test("a new close-ready supersedes the older pending close-ready of the same worktree only", (t) => {
  const { orgFile, worktreeId, dir } = makeProject(t);
  const otherId = addKickoff(dir, orgFile, "pm-other");
  const otherReady = sendSignal(orgFile, {
    worktreeId: otherId,
    kind: "close-ready",
    text: "ready",
    head: "sha0",
  });

  const first = sendSignal(orgFile, {
    worktreeId,
    kind: "close-ready",
    text: "ready",
    head: "sha1",
    source: "/src",
  });
  const decision = sendSignal(orgFile, {
    worktreeId,
    kind: "decision",
    text: "keep me",
  });
  // The same text for a new HEAD is not a duplicate; it replaces the old one.
  const second = sendSignal(orgFile, {
    worktreeId,
    kind: "close-ready",
    text: "ready",
    head: "sha2",
    source: "/src",
  });
  assert.deepEqual(second.superseded, [first.id]);

  const old = readSignal(orgFile, first.id);
  assert.equal(old.status, "superseded");
  assert.equal(old.supersededBy, second.id);
  assert.ok(old.supersededAt);
  assert.deepEqual(
    listInbox(orgFile)
      .signals.map((s) => s.id)
      .sort(),
    [decision.id, second.id, otherReady.id].sort(),
  );
  assert.equal(findCloseReadySignal(orgFile, worktreeId).head, "sha2");

  // Resending the identical close-ready is still a duplicate.
  assert.throws(
    () =>
      sendSignal(orgFile, {
        worktreeId,
        kind: "close-ready",
        text: "ready",
        head: "sha2",
        source: "/src",
      }),
    /Duplicate pending/,
  );
  assert.equal(readSignal(orgFile, otherReady.id).status, "pending");
});

test("kickoff-release closes that kickoff's pending signals and leaves other kickoffs alone", (t) => {
  const { orgFile, worktreeId, dir } = makeProject(t);
  const otherId = addKickoff(dir, orgFile, "pm-other");
  const pending = sendSignal(orgFile, {
    worktreeId,
    kind: "decision",
    text: "still open",
  });
  const replied = sendSignal(orgFile, {
    worktreeId,
    kind: "blocked",
    text: "b",
  });
  acknowledgeSignal(orgFile, replied.id);
  const others = sendSignal(orgFile, {
    worktreeId: otherId,
    kind: "decision",
    text: "other kickoff",
  });

  const warn = t.mock.method(console, "warn", () => {});
  const released = releaseKickoff(orgFile, { worktreeId, reason: "disbanded" });
  assert.ok(warn.mock.callCount() >= 1);
  assert.deepEqual(released.closedSignals, [pending.id]);

  const closed = readSignal(orgFile, pending.id);
  assert.equal(closed.status, "closed");
  assert.equal(closed.closedBy, "kickoff-release");
  assert.equal(closed.closedReason, "disbanded");
  assert.ok(closed.closedAt);
  assert.equal(readSignal(orgFile, replied.id).status, "acknowledged");
  assert.deepEqual(
    listInbox(orgFile).signals.map((s) => s.id),
    [others.id],
  );
});

test("findCloseReadySignal ignores a superseded record even when its time sorts later", (t) => {
  const { orgFile, worktreeId } = makeProject(t);
  const first = sendSignal(orgFile, {
    worktreeId,
    kind: "close-ready",
    text: "v1",
    head: "sha1",
  });
  const second = sendSignal(orgFile, {
    worktreeId,
    kind: "close-ready",
    text: "v2",
    head: "sha2",
  });
  // Same-millisecond sends leave sentAt equal; the superseded one must still lose.
  const file = path.join(
    path.dirname(orgFile),
    "director",
    "inbox",
    `${first.id}.json`,
  );
  writeJSON(file, { ...readJSON(file), sentAt: "2999-01-01T00:00:00.000Z" });
  assert.equal(findCloseReadySignal(orgFile, worktreeId).id, second.id);
});

test("sendSignal rejects an unknown kind", (t) => {
  const { orgFile, worktreeId } = makeProject(t);
  assert.throws(
    () => sendSignal(orgFile, { worktreeId, kind: "invalid-kind", text: "x" }),
    /Unknown signal kind/,
  );
});

test("sendSignal rejects an unregistered worktree", (t) => {
  const { orgFile } = makeProject(t);
  assert.throws(
    () =>
      sendSignal(orgFile, {
        worktreeId: "ghost::path",
        kind: "progress",
        text: "x",
      }),
    /not registered/,
  );
});

test("sendSignal rejects a duplicate pending signal with the same kind and text", (t) => {
  const { orgFile, worktreeId } = makeProject(t);

  sendSignal(orgFile, { worktreeId, kind: "decision", text: "need a call" });

  assert.throws(
    () =>
      sendSignal(orgFile, {
        worktreeId,
        kind: "decision",
        text: "need a call",
      }),
    /Duplicate pending/,
  );
});

test("sendSignal allows a second identical signal after the first is acknowledged", (t) => {
  const { orgFile, worktreeId } = makeProject(t);

  const first = sendSignal(orgFile, {
    worktreeId,
    kind: "decision",
    text: "pick A or B",
  });
  acknowledgeSignal(orgFile, first.id);

  const second = sendSignal(orgFile, {
    worktreeId,
    kind: "decision",
    text: "pick A or B",
  });
  assert.ok(second.signaled);
  assert.notEqual(second.id, first.id);
});

// ─── close-ready record ───────────────────────────────────────────────────────

test("close-ready signal preserves head and source fields", (t) => {
  const { orgFile, worktreeId } = makeProject(t);

  sendSignal(orgFile, {
    worktreeId,
    kind: "close-ready",
    text: "ready",
    head: "abc123",
    source: "/path/to/integration",
  });

  const record = findCloseReadySignal(orgFile, worktreeId);
  assert.ok(record);
  assert.equal(record.head, "abc123");
  assert.equal(record.source, "/path/to/integration");
  assert.equal(record.kind, "close-ready");
});

test("findCloseReadySignal returns the most recent record when multiple exist", (t) => {
  const { orgFile, worktreeId } = makeProject(t);

  const first = sendSignal(orgFile, {
    worktreeId,
    kind: "close-ready",
    text: "ready v1",
    head: "sha1",
    source: "/src1",
  });
  acknowledgeSignal(orgFile, first.id);

  sendSignal(orgFile, {
    worktreeId,
    kind: "close-ready",
    text: "ready v2",
    head: "sha2",
    source: "/src2",
  });

  const found = findCloseReadySignal(orgFile, worktreeId);
  assert.equal(found.head, "sha2");
});

test("findCloseReadySignal returns undefined when no close-ready record exists", (t) => {
  const { orgFile, worktreeId } = makeProject(t);

  sendSignal(orgFile, { worktreeId, kind: "progress", text: "working" });

  const found = findCloseReadySignal(orgFile, worktreeId);
  assert.equal(found, undefined);
});

// ─── replySignal ──────────────────────────────────────────────────────────────

test("replySignal marks a signal replied and sets the reply text", async (t) => {
  const { orgFile, worktreeId } = makeProject(t);

  const { id } = sendSignal(orgFile, {
    worktreeId,
    kind: "decision",
    text: "go or stop?",
  });

  const result = await replySignal(orgFile, { signalId: id, text: "go ahead" });

  assert.ok(result.replied);
  assert.equal(result.record.status, "replied");
  assert.equal(result.record.reply, "go ahead");
  assert.ok(result.record.repliedAt);
});

test("replySignal rejects a non-existent signal id", async (t) => {
  const { orgFile } = makeProject(t);
  await assert.rejects(
    () => replySignal(orgFile, { signalId: "does-not-exist", text: "x" }),
    /not found/,
  );
});

test("replySignal rejects a signal that is already replied", async (t) => {
  const { orgFile, worktreeId } = makeProject(t);

  const { id } = sendSignal(orgFile, {
    worktreeId,
    kind: "decision",
    text: "q",
  });
  await replySignal(orgFile, { signalId: id, text: "a" });

  await assert.rejects(
    () => replySignal(orgFile, { signalId: id, text: "b" }),
    /already replied/,
  );
});

// ─── acknowledgeSignal ────────────────────────────────────────────────────────

test("acknowledgeSignal marks a signal acknowledged and removes it from pending list", (t) => {
  const { orgFile, worktreeId } = makeProject(t);

  const { id } = sendSignal(orgFile, {
    worktreeId,
    kind: "blocked",
    text: "stuck",
  });
  const result = acknowledgeSignal(orgFile, id);

  assert.ok(result.acknowledged);
  assert.equal(result.record.status, "acknowledged");

  const { signals } = listInbox(orgFile);
  assert.equal(signals.filter((s) => s.id === id).length, 0);
});

test("acknowledgeSignal rejects a non-existent signal id", (t) => {
  const { orgFile } = makeProject(t);
  assert.throws(() => acknowledgeSignal(orgFile, "ghost-id"), /not found/);
});

test("acknowledgeSignal rejects a signal that is already acknowledged", (t) => {
  const { orgFile, worktreeId } = makeProject(t);

  const { id } = sendSignal(orgFile, {
    worktreeId,
    kind: "blocked",
    text: "stuck",
  });
  acknowledgeSignal(orgFile, id);

  assert.throws(() => acknowledgeSignal(orgFile, id), /already acknowledged/);
});

// ─── readSignal ───────────────────────────────────────────────────────────────

test("readSignal reads a record by id", (t) => {
  const { orgFile, worktreeId } = makeProject(t);

  const { id } = sendSignal(orgFile, {
    worktreeId,
    kind: "progress",
    text: "75%",
  });
  const record = readSignal(orgFile, id);
  assert.equal(record.id, id);
  assert.equal(record.text, "75%");
});

// ─── resource-acquire and resource-release ────────────────────────────────────

test("acquireResource writes a slot record and releaseResource removes it", (t) => {
  const { orgFile, worktreeId } = makeProject(t);

  const acq = acquireResource(orgFile, {
    worktreeId,
    kind: "test",
    note: "running tests",
    freeMemory: () => 2 * 1024 * 1024 * 1024, // 2 GiB fixture, host-independent
  });
  assert.ok(acq.acquired);
  assert.ok(acq.id);
  assert.equal(acq.record.kind, "test");
  assert.equal(acq.record.worktreeId, worktreeId);

  const rel = releaseResource(orgFile, acq.id);
  assert.ok(rel.released);
  assert.equal(rel.id, acq.id);
});

test("acquireResource rejects an unknown kind", (t) => {
  const { orgFile, worktreeId } = makeProject(t);
  assert.throws(
    () => acquireResource(orgFile, { worktreeId, kind: "database" }),
    /Unknown resource kind/,
  );
});

test("acquireResource rejects an unregistered worktree", (t) => {
  const { orgFile } = makeProject(t);
  assert.throws(
    () => acquireResource(orgFile, { worktreeId: "ghost::path", kind: "test" }),
    /not registered/,
  );
});

test("acquireResource rejects when free memory is below threshold", (t) => {
  const { orgFile, worktreeId } = makeProject(t);
  assert.throws(
    () =>
      acquireResource(orgFile, {
        worktreeId,
        kind: "worker",
        freeMemory: () => 1,
      }),
    /Insufficient free memory/,
  );
});

test("acquireResource reclaims dead-owner slots and reports their ids", (t) => {
  const { orgFile, worktreeId } = makeProject(t);

  // Acquire first slot. The owner is named: a slot with no owner is never
  // reclaimed, so it could not exercise reclaim.
  const live = acquireResource(orgFile, {
    worktreeId,
    kind: "build",
    ownerPid: process.pid,
    freeMemory: () => 2 * 1024 * 1024 * 1024, // 2 GiB fixture, host-independent
  });
  assert.ok(live.acquired);

  // Acquire a second slot; the liveness check says the first owner is dead.
  const second = acquireResource(orgFile, {
    worktreeId,
    kind: "build",
    freeMemory: () => 2 * 1024 * 1024 * 1024, // 2 GiB fixture, host-independent
    liveness: (owner) => (owner.pid === live.record.pid ? "dead" : "alive"),
  });

  assert.ok(second.acquired);
  assert.ok(
    second.reclaimedIds.includes(live.id),
    "must reclaim the dead-owner slot",
  );
});

test("releaseResource rejects a non-existent slot id", (t) => {
  const { orgFile } = makeProject(t);
  assert.throws(() => releaseResource(orgFile, "does-not-exist"), /not found/);
});

// ─── processLiveness ──────────────────────────────────────────────────────────

test("processLiveness returns 'alive' for the current process", () => {
  const result = processLiveness({ pid: process.pid, hostname: os.hostname() });
  assert.equal(result, "alive");
});

test("processLiveness returns 'dead' or 'unverifiable' for a non-existent pid", () => {
  const result = processLiveness({ pid: 2147483647, hostname: os.hostname() });
  assert.ok(result === "dead" || result === "unverifiable");
});

test("processLiveness returns 'unverifiable' for a foreign hostname", () => {
  const result = processLiveness({
    pid: process.pid,
    hostname: "other-host.example",
  });
  assert.equal(result, "unverifiable");
});

test("processLiveness returns 'unverifiable' for null input", () => {
  assert.equal(processLiveness(null), "unverifiable");
});

test("acquireResource does not reclaim a slot whose ownerPid is still alive", (t) => {
  const { orgFile, worktreeId } = makeProject(t);

  // First acquire with the current process as owner (simulates a long-lived PM
  // process that passes its own PID via --owner-pid). The slot must survive a
  // second acquire that uses the real liveness check.
  const first = acquireResource(orgFile, {
    worktreeId,
    kind: "build",
    freeMemory: () => 2 * 1024 * 1024 * 1024, // 2 GiB fixture
    ownerPid: process.pid, // current process: definitely alive
  });
  assert.ok(first.acquired, "first acquire must succeed");

  // Second acquire with liveness = processLiveness (the real checker). Because
  // process.pid is the ownerPid of the first slot, liveness returns 'alive',
  // so the slot must NOT be reclaimed.
  const second = acquireResource(orgFile, {
    worktreeId,
    kind: "build",
    freeMemory: () => 2 * 1024 * 1024 * 1024, // 2 GiB fixture
    // liveness defaults to processLiveness; no override needed
  });
  assert.ok(second.acquired, "second acquire must succeed");
  assert.ok(
    !second.reclaimedIds.includes(first.id),
    "alive-owner slot must NOT be reclaimed by a subsequent acquire",
  );
});

// ─── 자원 슬롯 소유자 기본값 ─────────────────────────────────────────────────

const PLENTY_OF_MEMORY = () => 2 * 1024 * 1024 * 1024;

test("acquireResource without ownerPid records an unknown owner and warns", (t) => {
  const { orgFile, worktreeId } = makeProject(t);
  const result = acquireResource(orgFile, {
    worktreeId,
    kind: "test",
    freeMemory: PLENTY_OF_MEMORY,
  });
  assert.equal(result.record.pid, null, "the CLI's own pid is not the owner");
  assert.notEqual(result.record.pid, process.pid);
  assert.match(result.warning, /never reclaimed automatically/);
  assert.match(result.warning, new RegExp(result.id));
  const stored = readJSON(
    path.join(path.dirname(orgFile), "resources", `${result.id}.json`),
  );
  assert.equal(stored.pid, null);
});

test("a slot with an unknown owner survives every later acquire, even one that calls every owner dead", (t) => {
  const { orgFile, worktreeId } = makeProject(t);
  const unknown = acquireResource(orgFile, {
    worktreeId,
    kind: "test",
    freeMemory: PLENTY_OF_MEMORY,
  });
  for (const liveness of [undefined, () => "dead"]) {
    const next = acquireResource(orgFile, {
      worktreeId,
      kind: "test",
      ownerPid: process.pid,
      freeMemory: PLENTY_OF_MEMORY,
      liveness,
    });
    assert.ok(!next.reclaimedIds.includes(unknown.id));
    assert.equal(next.warning, undefined, "a known owner needs no warning");
    releaseResource(orgFile, next.id);
  }
  // Only an explicit release frees it.
  assert.ok(releaseResource(orgFile, unknown.id).released);
});

test("acquireResource refuses an ownerPid that is not a positive integer", (t) => {
  const { orgFile, worktreeId } = makeProject(t);
  for (const ownerPid of [0, -4, 1.5, Number.NaN, "123"]) {
    assert.throws(
      () =>
        acquireResource(orgFile, {
          worktreeId,
          kind: "test",
          ownerPid,
          freeMemory: PLENTY_OF_MEMORY,
        }),
      /ownerPid must be a positive integer/,
      String(ownerPid),
    );
  }
});

// ─── PM liveness: Orca 의 실제 verdict 값 ────────────────────────────────────

const PM_PATH = "/work/pm-worktree";
const PM_ENTRY = {
  pm: { worktreeId: `repo::${PM_PATH}`, path: PM_PATH },
};

// One `worker-list` entry in the shape a live Orca returns: the verdict sits in
// `projection.liveness` and the worktree in `projection.workspace.id`.
const orcaWorker = (workspacePath, liveness) => ({
  dispatchId: "ctx_fixture",
  workerState: "supervised",
  resource: null,
  projection: {
    workspace: {
      id: `repo::${workspacePath}`,
      kind: "folder_or_worktree",
    },
    liveness,
  },
});

const orcaAnswer = (workers) => async () => ({
  code: 0,
  stdout: JSON.stringify({
    id: "fixture",
    ok: true,
    result: { workers, counts: {}, page: {}, scope: {} },
  }),
});

const LIVE = {
  verdict: "live",
  observedAt: 1789958205199,
  source: "agent_status",
};
const STALE = {
  verdict: "unverifiable",
  reason: "stale_status",
  observedAt: 1789895814805,
};
const EXITED = { verdict: "exited", observedAt: 1789958205199 };

test("queryPmLiveness reads the verdicts Orca actually reports", async () => {
  const verdict = (liveness) =>
    queryPmLiveness(
      PM_ENTRY,
      undefined,
      orcaAnswer([orcaWorker(PM_PATH, liveness)]),
    );
  assert.equal(await verdict(LIVE), "live");
  assert.equal(await verdict(EXITED), "exited");
  assert.equal(await verdict(STALE), "unverifiable");
});

test("queryPmLiveness never turns absence, failure or an unknown value into live or exited", async () => {
  const ask = (execute) => queryPmLiveness(PM_ENTRY, undefined, execute);
  // Values the previous implementation invented; Orca does not report them.
  for (const verdict of ["alive", "dead", "running", "", null, 7]) {
    assert.equal(
      await ask(orcaAnswer([orcaWorker(PM_PATH, { verdict })])),
      "unverifiable",
      String(verdict),
    );
  }
  // The PM worktree is absent from the list: presence elsewhere proves nothing.
  assert.equal(await ask(orcaAnswer([])), "unverifiable");
  assert.equal(
    await ask(orcaAnswer([orcaWorker("/work/other", LIVE)])),
    "unverifiable",
  );
  // A sibling whose path merely starts with the PM path is another worktree.
  assert.equal(
    await ask(orcaAnswer([orcaWorker(`${PM_PATH}-2`, LIVE)])),
    "unverifiable",
  );
  // Failed and unreadable queries.
  assert.equal(
    await ask(async () => ({ code: 1, stdout: "" })),
    "unverifiable",
  );
  assert.equal(
    await ask(async () => ({ code: 0, stdout: "not json" })),
    "unverifiable",
  );
  assert.equal(
    await ask(async () => ({ code: 0, stdout: JSON.stringify({ ok: true }) })),
    "unverifiable",
  );
  assert.equal(
    await ask(async () => {
      throw new Error("spawn failed");
    }),
    "unverifiable",
  );
});

test("queryPmLiveness weighs every entry of the PM worktree, not the first one", async () => {
  const ask = (...livenesses) =>
    queryPmLiveness(
      PM_ENTRY,
      undefined,
      orcaAnswer(livenesses.map((liveness) => orcaWorker(PM_PATH, liveness))),
    );
  // An old settled dispatch listed first must not hide the live one.
  assert.equal(await ask(STALE, LIVE), "live");
  assert.equal(await ask(EXITED, LIVE), "live");
  // Exited is concluded only when nothing in the worktree is live or unknown.
  assert.equal(await ask(EXITED, EXITED), "exited");
  assert.equal(await ask(EXITED, STALE), "unverifiable");
});

test("queryPmLiveness asks Orca for worker-list with the given executable", async () => {
  const calls = [];
  await queryPmLiveness(PM_ENTRY, "/opt/orca", async (argv, options) => {
    calls.push({ argv, options });
    return { code: 0, stdout: "[]" };
  });
  assert.deepEqual(calls[0].argv, [
    "/opt/orca",
    "orchestration",
    "worker-list",
    "--json",
  ]);
  assert.ok(calls[0].options.timeoutMs > 0);
});

// ─── PM terminal discovery and available memory ─────────────────────────────

function recordPmLaunch(orgFile, worktreePath, terminal, provider = "claude") {
  const file = path.join(path.dirname(orgFile), "usage", "launches.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    `${JSON.stringify({ schemaVersion: 1, via: "role-terminal", role: "pm", worktreePath, terminal, provider })}\n`,
  );
}

test("findPmTerminal takes the latest PM launch only while Orca still lists it", async (t) => {
  const { orgFile, dir } = makeProject(t);
  const pmPath = path.join(dir, "pm-worktree");
  recordPmLaunch(orgFile, pmPath, "term_old");
  recordPmLaunch(orgFile, pmPath, "term_new");
  // The agent rewrites its title, so the title plays no part in the match.
  const listed = [
    { handle: "term_new", worktreePath: pmPath, title: "✳ agent-set title" },
    { handle: "term_old", worktreePath: pmPath, title: "[PM] stale" },
  ];
  assert.equal(
    await findPmTerminal(orgFile, pmPath, {
      listTerminals: async () => listed,
    }),
    "term_new",
  );
  assert.equal(
    await findPmTerminal(orgFile, pmPath, {
      listTerminals: async () => [listed[1]],
    }),
    undefined,
    "a closed latest PM terminal is not replaced by an older one",
  );
  assert.equal(
    await findPmTerminal(orgFile, pmPath, {
      listTerminals: async () => [
        { handle: "term_new", worktreePath: path.join(dir, "elsewhere") },
      ],
    }),
    undefined,
  );
});

// ─── directorWatch provider-overload judgement ───────────────────────────────

function orcaEnvelope(result) {
  return { code: 0, stdout: JSON.stringify({ ok: true, result }) };
}

test("directorWatch reports provider-overloaded from the PM's own terminal screen", async (t) => {
  const { orgFile, dir, worktreeId } = makeProject(t);
  const pmPath = path.join(dir, "pm-worktree");
  recordPmLaunch(orgFile, pmPath, "term_pm");

  const report = await directorWatch(orgFile, {
    orcaExecutable: "no-such-orca-binary",
    freeMemory: () => 1024 * 1024 * 1024,
    listTerminals: async () => [{ handle: "term_pm", worktreePath: pmPath }],
    execute: async () =>
      orcaEnvelope({
        terminal: {
          source: "screen",
          tail: ["> continue", "API Error: 529 Overloaded"],
        },
      }),
  });

  const kickoff = report.kickoffs.find((k) => k.worktreeId === worktreeId);
  assert.equal(kickoff.providerOverload, "provider-overloaded");
});

test("directorWatch reports none when the PM screen was read but does not show the 529 sentence", async (t) => {
  const { orgFile, dir, worktreeId } = makeProject(t);
  const pmPath = path.join(dir, "pm-worktree");
  recordPmLaunch(orgFile, pmPath, "term_pm");

  const report = await directorWatch(orgFile, {
    orcaExecutable: "no-such-orca-binary",
    freeMemory: () => 1024 * 1024 * 1024,
    listTerminals: async () => [{ handle: "term_pm", worktreePath: pmPath }],
    execute: async () =>
      orcaEnvelope({
        terminal: { source: "screen", tail: ["Ready for input."] },
      }),
  });

  const kickoff = report.kickoffs.find((k) => k.worktreeId === worktreeId);
  assert.equal(kickoff.providerOverload, "none");
});

test("directorWatch reports unknown instead of guessing when the PM terminal cannot be found", async (t) => {
  const { orgFile, worktreeId } = makeProject(t);
  // No PM launch was ever recorded, so findPmTerminal cannot resolve a handle.

  const report = await directorWatch(orgFile, {
    orcaExecutable: "no-such-orca-binary",
    freeMemory: () => 1024 * 1024 * 1024,
    listTerminals: async () => [],
  });

  const kickoff = report.kickoffs.find((k) => k.worktreeId === worktreeId);
  assert.equal(kickoff.providerOverload, "unknown");
});

test("directorWatch reports unknown instead of guessing when the PM screen cannot be read", async (t) => {
  const { orgFile, dir, worktreeId } = makeProject(t);
  const pmPath = path.join(dir, "pm-worktree");
  recordPmLaunch(orgFile, pmPath, "term_pm");

  const report = await directorWatch(orgFile, {
    orcaExecutable: "no-such-orca-binary",
    freeMemory: () => 1024 * 1024 * 1024,
    listTerminals: async () => [{ handle: "term_pm", worktreePath: pmPath }],
    // No `source: "screen"` in the envelope means the screen could not be
    // confirmed as the live one, the same failure readTerminalScreen reports
    // for a worker.
    execute: async () => orcaEnvelope({ terminal: { source: "buffer" } }),
  });

  const kickoff = report.kickoffs.find((k) => k.worktreeId === worktreeId);
  assert.equal(kickoff.providerOverload, "unknown");
});

// findPmTerminal reads the launch ledger's own provider field (fixed at
// launch time), never the organization's current pm profile, which a
// fallback can move to another provider after that launch.
async function watchesUnconfirmedProviderScreen(t, provider) {
  const { orgFile, dir, worktreeId } = makeProject(t);
  const pmPath = path.join(dir, "pm-worktree");
  recordPmLaunch(orgFile, pmPath, "term_pm", provider);

  const report = await directorWatch(orgFile, {
    orcaExecutable: "no-such-orca-binary",
    freeMemory: () => 1024 * 1024 * 1024,
    listTerminals: async () => [{ handle: "term_pm", worktreePath: pmPath }],
    execute: async () =>
      orcaEnvelope({
        terminal: {
          source: "screen",
          tail: ["> continue", "API Error: 529 Overloaded"],
        },
      }),
  });

  const kickoff = report.kickoffs.find((k) => k.worktreeId === worktreeId);
  assert.equal(kickoff.providerOverload, "unknown");
}

test("directorWatch does not judge a 529 sentence on a PM launched as codex", async (t) => {
  await watchesUnconfirmedProviderScreen(t, "codex");
});

test("directorWatch does not judge a 529 sentence on a PM launched as agy", async (t) => {
  await watchesUnconfirmedProviderScreen(t, "agy");
});

test("directorWatch does not judge a 529 sentence when no PM launch was ever recorded", async (t) => {
  const { orgFile, dir, worktreeId } = makeProject(t);
  const pmPath = path.join(dir, "pm-worktree");
  // No recordPmLaunch call: the ledger has no launch for this PM path at all.

  const report = await directorWatch(orgFile, {
    orcaExecutable: "no-such-orca-binary",
    freeMemory: () => 1024 * 1024 * 1024,
    listTerminals: async () => [{ handle: "term_pm", worktreePath: pmPath }],
    execute: async () =>
      orcaEnvelope({
        terminal: {
          source: "screen",
          tail: ["> continue", "API Error: 529 Overloaded"],
        },
      }),
  });

  const kickoff = report.kickoffs.find((k) => k.worktreeId === worktreeId);
  assert.equal(kickoff.providerOverload, "unknown");
});

test("directorWatch keeps every kickoff's own report when one PM terminal lookup breaks", async (t) => {
  const { orgFile, dir, worktreeId } = makeProject(t);
  const pmPath = path.join(dir, "pm-worktree");
  recordPmLaunch(orgFile, pmPath, "term_pm");

  // Simulates orcaTerminals' JSON.parse throwing on a truncated `orca
  // terminal list --json` answer: the failure surfaces at the same seam,
  // whichever line inside the lookup actually throws.
  const report = await directorWatch(orgFile, {
    orcaExecutable: "no-such-orca-binary",
    freeMemory: () => 1024 * 1024 * 1024,
    listTerminals: async () => {
      throw new SyntaxError("Unexpected end of JSON input");
    },
  });

  const kickoff = report.kickoffs.find((k) => k.worktreeId === worktreeId);
  assert.equal(kickoff.providerOverload, "unknown");
  // The rest of directorWatch's report is unaffected by the one kickoff's failure.
  assert.equal(typeof report.freeMemoryBytes, "number");
  assert.equal(kickoff.pmLiveness, "unverifiable");
});

test("replySignal reports that no PM terminal was found instead of claiming delivery", async (t) => {
  const { orgFile, worktreeId } = makeProject(t);
  const { id } = sendSignal(orgFile, {
    worktreeId,
    kind: "decision",
    text: "?",
  });
  const result = await replySignal(orgFile, {
    signalId: id,
    text: "go",
    listTerminals: async () => [],
  });
  assert.equal(result.notified, false);
  assert.equal(result.notifyError, "no-pm-terminal-found");
  assert.equal(result.record.reply, "go");
});

test("available memory counts reclaimable pages on macOS and MemAvailable on Linux", () => {
  const vmStat = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                               11000.",
    "Pages active:                            900000.",
    "Pages inactive:                          600000.",
    "Pages speculative:                         5000.",
    "Pages purgeable:                          40000.",
  ].join("\n");
  // free + inactive + speculative, not free alone as os.freemem() reports.
  assert.equal(parseVmStat(vmStat), (11000 + 600000 + 5000) * 16384);
  assert.equal(parseVmStat("not vm_stat"), null);
  assert.equal(
    parseMeminfo(
      "MemTotal:  16000000 kB\nMemFree:  300000 kB\nMemAvailable:  9000000 kB\n",
    ),
    9000000 * 1024,
  );
  assert.equal(parseMeminfo("MemTotal: 1 kB\n"), null);
});

test("signals sent within one millisecond keep their order through a sequence", async (t) => {
  const { orgFile, worktreeId } = makeProject(t);
  const realNow = Date.now;
  Date.now = () => 1790000000000;
  const realToISOString = Date.prototype.toISOString;
  Date.prototype.toISOString = () => "2026-09-21T00:00:00.000Z";
  t.after(() => {
    Date.now = realNow;
    Date.prototype.toISOString = realToISOString;
  });
  const first = sendSignal(orgFile, {
    worktreeId,
    kind: "close-ready",
    text: "ready",
    head: "a".repeat(40),
  });
  const second = sendSignal(orgFile, {
    worktreeId,
    kind: "close-ready",
    text: "ready",
    head: "b".repeat(40),
  });
  assert.equal(first.record.sentAt, second.record.sentAt);
  assert.ok(second.record.seq > first.record.seq);
  assert.equal(findCloseReadySignal(orgFile, worktreeId).id, second.id);
});

// ─── Terminal notifications keep acceptance and submission apart ────────────

const RULE = "─".repeat(60);
const NOTE = { kind: "progress", worktreeId: "wt-1", text: "tests are green" };
const NOTE_TEXT = "[omt] progress from wt-1: tests are green";

// Plays `orca terminal send` and `read`; `answers` is consumed in order and
// the last one repeats. An answer is a stage list, or { code, stderr } for a
// failed call.
function orcaNotify(answers, screen = []) {
  const calls = [];
  const queue = [...answers];
  const execute = async (argv) => {
    const args = argv.slice(1, -1);
    calls.push(args);
    if (args[1] === "read") {
      const tail = typeof screen === "function" ? screen(calls) : screen;
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          result: { terminal: { tail, source: "screen" } },
        }),
      };
    }
    if (args[args.indexOf("--text") + 1] === "") {
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          result: { send: { accepted: true } },
        }),
      };
    }
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    if (!Array.isArray(answer))
      return { code: answer.code, stdout: "", stderr: answer.stderr };
    return {
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        result: {
          send: {
            accepted: true,
            prompt: { requestId: "req-7", stages: answer, provider: "claude" },
          },
          mutation: {
            requestId: "req-7",
            replayed: args.includes("--retry-request"),
          },
        },
      }),
    };
  };
  // Matched by the argument in the "--text" position, not by scanning the
  // whole call for a substring, so a bundled multi-signal message counts too.
  const textSends = () =>
    calls.filter(
      (call) =>
        call[1] === "send" &&
        call[call.indexOf("--text") + 1] !== "" &&
        !call.includes("--retry-request"),
    );
  const enters = () =>
    calls.filter(
      (call) => call[1] === "send" && call[call.indexOf("--text") + 1] === "",
    );
  return { calls, execute, textSends, enters };
}

const withDirector = { director: { terminalHandle: "term_director" } };

test("notifyDirector reports a delivery only once the turn started", async () => {
  const orca = orcaNotify([["input_accepted", "turn_started"]]);
  const result = await notifyDirector(withDirector, NOTE, "orca", orca.execute);
  assert.equal(result.notified, true);
  assert.equal(result.notifyError, undefined);
  assert.equal(result.delivery.outcome, "submitted");
  assert.deepEqual(result.delivery.stages, ["input_accepted", "turn_started"]);
  assert.equal(result.delivery.requestId, "req-7");
  assert.deepEqual(orca.textSends()[0].slice(-2), ["--wait-submit", "5"]);
  assert.equal(orca.textSends().length, 1);
  assert.equal(orca.enters().length, 0);
});

test("notifyDirector does not call an accepted but unproven input delivered", async () => {
  // Nothing on the screen decides it: not delivered, request ID kept, no resend.
  const orca = orcaNotify([["input_accepted"]], []);
  const result = await notifyDirector(withDirector, NOTE, "orca", orca.execute);
  assert.equal(result.notified, false);
  assert.equal(result.delivery.outcome, "unclear");
  assert.deepEqual(result.delivery.stages, ["input_accepted"]);
  assert.equal(result.delivery.requestId, "req-7");
  assert.equal(result.notifyError, "no-input-box-on-screen");
  assert.equal(orca.textSends().length, 1);
  assert.equal(orca.enters().length, 0);
});

test("notifyDirector sends one Enter for a notification left in the input box", async () => {
  const held = [RULE, `❯ ${NOTE_TEXT}`, RULE, "  ⏵⏵ bypass permissions on"];
  const gone = [
    `❯ ${NOTE_TEXT}`,
    "✻ Working…",
    RULE,
    "❯",
    RULE,
    "  ⏵⏵ bypass permissions on",
  ];
  const orca = orcaNotify(
    [["input_accepted"], ["input_accepted", "turn_started"]],
    (calls) =>
      calls.some((call) => call[call.indexOf("--text") + 1] === "")
        ? gone
        : held,
  );
  const result = await notifyDirector(withDirector, NOTE, "orca", orca.execute);
  assert.equal(result.notified, true);
  assert.equal(result.delivery.outcome, "submitted");
  assert.equal(result.delivery.enterSent, true);
  assert.equal(orca.enters().length, 1);
  assert.equal(orca.textSends().length, 1);
});

test("notifyDirector keeps Orca's failure text and does not resend", async () => {
  const orca = orcaNotify([
    { code: 1, stderr: "terminal_not_writable: pane is closed" },
  ]);
  const result = await notifyDirector(withDirector, NOTE, "orca", orca.execute);
  assert.equal(result.notified, false);
  assert.match(result.notifyError, /terminal_not_writable: pane is closed/);
  assert.equal(result.delivery.outcome, "failed");
  assert.equal(result.delivery.requestId, null);
  // One screen read ahead of the send that then fails.
  assert.equal(orca.calls.length, 2);
  assert.deepEqual(await notifyDirector({}, NOTE, "orca", orca.execute), {
    notified: false,
  });
});

// ─── notifyDirector defers when the Director's screen cannot take input (#82) ──

test("notifyDirector defers without sending when a selection window is on screen", async () => {
  const orca = orcaNotify([["input_accepted", "turn_started"]], askUserScreen);
  const result = await notifyDirector(withDirector, NOTE, "orca", orca.execute);
  assert.equal(result.notified, false);
  assert.equal(result.deferred, true);
  assert.equal(result.notifyError, "blocked-by-user-question");
  // Only the screen read happened; no Enter, no text.
  assert.equal(orca.calls.length, 1);
  assert.equal(orca.textSends().length, 0);
  assert.equal(orca.enters().length, 0);
});

test("notifyDirector proceeds on a screen with a working indicator (not blocked)", async () => {
  // classifyPromptScreen only recognizes trust and AskUserQuestion screens;
  // anything else, busy or idle, is "unknown" and does not defer the send.
  const busyScreen = [RULE, "❯", "✻ Working…", RULE];
  const orca = orcaNotify([["input_accepted", "turn_started"]], busyScreen);
  const result = await notifyDirector(withDirector, NOTE, "orca", orca.execute);
  assert.equal(result.notified, true);
  assert.equal(result.deferred, undefined);
  assert.equal(result.delivery.outcome, "submitted");
});

test("notifyDirector proceeds on an idle, empty-prompt screen (not blocked)", async () => {
  const idleScreen = [RULE, "❯", RULE, "  ⏵⏵ bypass permissions on"];
  const orca = orcaNotify([["input_accepted", "turn_started"]], idleScreen);
  const result = await notifyDirector(withDirector, NOTE, "orca", orca.execute);
  assert.equal(result.notified, true);
  assert.equal(result.deferred, undefined);
  assert.equal(result.delivery.outcome, "submitted");
});

// ─── notifyDirectorSignal: defer, bundle once clear, never resend (#82, ac-3) ──

test("notifyDirectorSignal defers a blocked backlog, then bundles and delivers it once the screen clears, without resending", async (t) => {
  const { orgFile, worktreeId } = makeProject(t, {
    withDirectorTerminal: true,
  });

  const blocked = orcaNotify(
    [["input_accepted", "turn_started"]],
    askUserScreen,
  );
  const first = sendSignal(orgFile, {
    worktreeId,
    kind: "progress",
    text: "step 1 done",
  });
  const firstResult = await notifyDirectorSignal(
    orgFile,
    first.entry,
    first.record,
    "orca",
    blocked.execute,
  );
  assert.equal(firstResult.notified, false);
  assert.equal(firstResult.deferred, true);
  assert.deepEqual(firstResult.bundled, [first.id]);

  const second = sendSignal(orgFile, {
    worktreeId,
    kind: "progress",
    text: "step 2 done",
  });
  const secondResult = await notifyDirectorSignal(
    orgFile,
    first.entry,
    second.record,
    "orca",
    blocked.execute,
  );
  assert.equal(secondResult.notified, false);
  assert.deepEqual(
    secondResult.bundled.slice().sort(),
    [first.id, second.id].sort(),
  );
  // Both attempts only ever read the blocked screen; nothing was typed.
  assert.equal(blocked.calls.length, 2);
  assert.equal(blocked.textSends().length, 0);

  const clear = orcaNotify([["input_accepted", "turn_started"]], []);
  const third = sendSignal(orgFile, {
    worktreeId,
    kind: "progress",
    text: "step 3 done",
  });
  const thirdResult = await notifyDirectorSignal(
    orgFile,
    first.entry,
    third.record,
    "orca",
    clear.execute,
  );
  assert.equal(thirdResult.notified, true);
  assert.deepEqual(
    thirdResult.bundled.slice().sort(),
    [first.id, second.id, third.id].sort(),
  );
  const sends = clear.textSends();
  assert.equal(sends.length, 1);
  const sentText = sends[0][sends[0].indexOf("--text") + 1];
  assert.match(sentText, /step 1 done/);
  assert.match(sentText, /step 2 done/);
  assert.match(sentText, /step 3 done/);

  assert.equal(readSignal(orgFile, first.id).notify.notified, true);
  assert.equal(readSignal(orgFile, second.id).notify.notified, true);
  assert.equal(readSignal(orgFile, third.id).notify.notified, true);

  // A later signal's own attempt never re-bundles ones already delivered.
  const fourth = sendSignal(orgFile, {
    worktreeId,
    kind: "progress",
    text: "step 4 done",
  });
  const fourthOrca = orcaNotify([["input_accepted", "turn_started"]], []);
  const fourthResult = await notifyDirectorSignal(
    orgFile,
    first.entry,
    fourth.record,
    "orca",
    fourthOrca.execute,
  );
  assert.deepEqual(fourthResult.bundled, [fourth.id]);
});

// ─── notifyDirectorSignal: sent-but-unconfirmed is never resent (#82, review-1 finding director-signal-resend-conflates-unsent-and-unconfirmed) ──

test("notifyDirectorSignal never re-bundles a signal deliverPrompt already tried but could not confirm", async (t) => {
  const { orgFile, worktreeId } = makeProject(t, {
    withDirectorTerminal: true,
  });

  const first = sendSignal(orgFile, {
    worktreeId,
    kind: "decision",
    text: "attempted once",
  });
  // Accepted but nothing on screen decides it: deliverPrompt actually ran
  // (the screen was not blocked), so the keys may already have reached the
  // Director even though the outcome is "unclear", not "submitted".
  const unclearOrca = orcaNotify([["input_accepted"]], []);
  const firstResult = await notifyDirectorSignal(
    orgFile,
    first.entry,
    first.record,
    "orca",
    unclearOrca.execute,
  );
  assert.equal(firstResult.notified, false);
  assert.equal(firstResult.deferred, undefined);
  assert.equal(unclearOrca.textSends().length, 1);
  assert.equal(readSignal(orgFile, first.id).notify.sent, true);
  assert.equal(readSignal(orgFile, first.id).notify.notified, false);

  const second = sendSignal(orgFile, {
    worktreeId,
    kind: "decision",
    text: "second signal",
  });
  const clearOrca = orcaNotify([["input_accepted", "turn_started"]], []);
  const secondResult = await notifyDirectorSignal(
    orgFile,
    first.entry,
    second.record,
    "orca",
    clearOrca.execute,
  );
  assert.equal(secondResult.notified, true);
  // The unconfirmed-but-attempted first signal is never bundled again.
  assert.deepEqual(secondResult.bundled, [second.id]);
  const sends = clearOrca.textSends();
  assert.equal(sends.length, 1);
  const sentText = sends[0][sends[0].indexOf("--text") + 1];
  assert.doesNotMatch(sentText, /attempted once/);
  assert.match(sentText, /second signal/);
  // The first signal is never retried automatically, but it stays pending
  // and visible in director-inbox so the Director can still see and answer it.
  assert.equal(readSignal(orgFile, first.id).notify.notified, false);
  assert.equal(readSignal(orgFile, first.id).status, "pending");
  assert.ok(listInbox(orgFile).signals.some((s) => s.id === first.id));
});

// ─── notifyDirectorSignal: overlapping calls never both send (#82, review-1 finding director-signal-backlog-read-race) ──

test("notifyDirectorSignal defers instead of double-sending when a second call for the same worktree overlaps the first", async (t) => {
  const { orgFile, worktreeId } = makeProject(t, {
    withDirectorTerminal: true,
  });
  const first = sendSignal(orgFile, {
    worktreeId,
    kind: "progress",
    text: "first",
  });
  const second = sendSignal(orgFile, {
    worktreeId,
    kind: "progress",
    text: "second",
  });

  const orca = orcaNotify([["input_accepted", "turn_started"]], []);
  // Gates the first call's own screen read so it stays inside notifyTerminal
  // (past its own claim, which is synchronous) while the second call starts,
  // the way a first `director-signal` process still inside deliverPrompt's
  // wait-submit window overlaps a second one starting.
  let releaseFirst;
  const gate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const slowExecute = async (argv, options) => {
    await gate;
    return orca.execute(argv, options);
  };

  const firstPromise = notifyDirectorSignal(
    orgFile,
    first.entry,
    first.record,
    "orca",
    slowExecute,
  );
  const secondResult = await notifyDirectorSignal(
    orgFile,
    first.entry,
    second.record,
    "orca",
    orca.execute,
  );
  assert.equal(secondResult.notified, false);
  assert.equal(secondResult.deferred, true);
  assert.equal(secondResult.notifyError, "backlog-claimed");
  assert.deepEqual(secondResult.bundled, []);
  // The second call never touched the terminal at all.
  assert.equal(orca.calls.length, 0);

  releaseFirst();
  const firstResult = await firstPromise;
  assert.equal(firstResult.notified, true);
  // The first call claimed the whole backlog up front, so it bundles both.
  assert.deepEqual(
    firstResult.bundled.slice().sort(),
    [first.id, second.id].sort(),
  );
  assert.equal(orca.textSends().length, 1);
  const sentText =
    orca.textSends()[0][orca.textSends()[0].indexOf("--text") + 1];
  assert.match(sentText, /first/);
  assert.match(sentText, /second/);
  assert.equal(readSignal(orgFile, first.id).notify.notified, true);
  assert.equal(readSignal(orgFile, second.id).notify.notified, true);
});

test("notifyDirectorSignal never resends a batch left in-flight by a dead owner, and settles it as unconfirmed instead", async (t) => {
  const { orgFile, worktreeId } = makeProject(t, {
    withDirectorTerminal: true,
  });
  const stuck = sendSignal(orgFile, {
    worktreeId,
    kind: "decision",
    text: "orphaned attempt",
  });
  // Simulate a claim left behind by a process that has since exited: a pid
  // this host can prove dead, the same shape resources.mjs uses for its own
  // dead-owner slot reclaim.
  const file = path.join(
    path.dirname(orgFile),
    "director",
    "inbox",
    `${stuck.id}.json`,
  );
  writeJSON(file, {
    ...readJSON(file),
    notify: {
      inFlight: true,
      claimedAt: new Date(0).toISOString(),
      owner: { pid: 2147483647, hostname: os.hostname() },
    },
  });

  const second = sendSignal(orgFile, {
    worktreeId,
    kind: "progress",
    text: "new attempt",
  });
  const orca = orcaNotify([["input_accepted", "turn_started"]], []);
  const result = await notifyDirectorSignal(
    orgFile,
    second.entry,
    second.record,
    "orca",
    orca.execute,
  );
  assert.equal(result.notified, true);
  // The dead owner's signal is never reclaimed for a fresh send; only the new
  // signal goes out.
  assert.deepEqual(result.bundled, [second.id]);
  assert.equal(orca.textSends().length, 1);
  const sentText =
    orca.textSends()[0][orca.textSends()[0].indexOf("--text") + 1];
  assert.doesNotMatch(sentText, /orphaned attempt/);
  assert.match(sentText, /new attempt/);
  // Its outcome is settled as unconfirmed, the same shape as an attempt that
  // ran but could not confirm submission, so it never comes back into the
  // auto-resend backlog.
  const settled = readSignal(orgFile, stuck.id);
  assert.equal(settled.notify.notified, false);
  assert.equal(settled.notify.sent, true);
  assert.equal(settled.notify.notifyError, "owner-exited-before-confirming");
  assert.equal(settled.status, "pending");
  assert.ok(listInbox(orgFile).signals.some((s) => s.id === stuck.id));
});

test("notifyDirectorSignal sends a new signal and leaves a signal stuck under an unverifiable owner untouched", async (t) => {
  const { orgFile, worktreeId } = makeProject(t, {
    withDirectorTerminal: true,
  });
  const stuck = sendSignal(orgFile, {
    worktreeId,
    kind: "progress",
    text: "claimed on another host",
  });
  // A claim recorded by a different hostname: `processLiveness` can never
  // confirm this pid is dead (it does not even check), so it always reports
  // "unverifiable" and this claim would never clear on its own.
  const file = path.join(
    path.dirname(orgFile),
    "director",
    "inbox",
    `${stuck.id}.json`,
  );
  writeJSON(file, {
    ...readJSON(file),
    notify: {
      inFlight: true,
      claimedAt: new Date(0).toISOString(),
      owner: { pid: 4321, hostname: "some-other-host" },
    },
  });
  const before = readSignal(orgFile, stuck.id);

  const second = sendSignal(orgFile, {
    worktreeId,
    kind: "progress",
    text: "unaffected new signal",
  });
  const orca = orcaNotify([["input_accepted", "turn_started"]], []);
  const result = await notifyDirectorSignal(
    orgFile,
    second.entry,
    second.record,
    "orca",
    orca.execute,
  );
  // The new signal is delivered on its own; the stuck one is never bundled.
  assert.equal(result.notified, true);
  assert.deepEqual(result.bundled, [second.id]);
  assert.equal(orca.textSends().length, 1);
  const sentText =
    orca.textSends()[0][orca.textSends()[0].indexOf("--text") + 1];
  assert.doesNotMatch(sentText, /claimed on another host/);
  assert.match(sentText, /unaffected new signal/);
  // The stuck signal's own claim is left exactly as it was: not resent, not
  // settled, still visible as an unresolved claim in director-inbox.
  assert.deepEqual(readSignal(orgFile, stuck.id), before);
});

test("replySignal reports how far the PM notification got", async (t) => {
  const { orgFile, worktreeId, dir } = makeProject(t);
  const pmPath = path.join(dir, "pm-worktree");
  recordPmLaunch(orgFile, pmPath, "term_pm");
  const { id } = sendSignal(orgFile, {
    worktreeId,
    kind: "decision",
    text: "?",
  });
  const orca = orcaNotify([["input_accepted"]], []);
  const result = await replySignal(orgFile, {
    signalId: id,
    text: "go",
    listTerminals: async () => [{ handle: "term_pm", worktreePath: pmPath }],
    execute: orca.execute,
  });
  assert.equal(result.replied, true);
  assert.equal(result.pmTerminal, "term_pm");
  assert.equal(result.notified, false);
  assert.equal(result.delivery.outcome, "unclear");
  assert.equal(result.delivery.requestId, "req-7");
  assert.equal(result.record.reply, "go");
  assert.equal(orca.enters().length, 0);
});
