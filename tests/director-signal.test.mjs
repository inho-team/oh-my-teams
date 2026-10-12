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
  sendSignal,
  listInbox,
  replySignal,
  acknowledgeSignal,
  readSignal,
  findCloseReadySignal,
  SIGNAL_KINDS,
  processLiveness,
  recordDeliveryReceipt,
  acknowledgeDelivery,
  readDeliveryReceipt,
  listDeliveries,
} from "../plugins/oh-my-teams/scripts/director.mjs";
import { releaseKickoff } from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";
import {
  acquireResource,
  parseMeminfo,
  parseVmStat,
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
function makeProject(t, { withDirectorTerminal = false, runId = null } = {}) {
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
    runId,
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

test("kickoff-release closes that kickoff's pending signals and leaves other kickoffs alone", async (t) => {
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
  const released = await releaseKickoff(orgFile, {
    worktreeId,
    reason: "disbanded",
  });
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

test("replySignal stores the decision and notifies the bound Orca Run", async (t) => {
  const { orgFile, worktreeId } = makeProject(t, { runId: "run_pm" });
  const { id } = sendSignal(orgFile, {
    worktreeId,
    kind: "decision",
    text: "Choose the release path",
  });
  const calls = [];
  const result = await replySignal(orgFile, {
    signalId: id,
    text: "Use the checked commit",
    execute: async (argv) => {
      calls.push(argv);
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          result: { message: { id: "msg_1" } },
        }),
      };
    },
  });
  assert.equal(result.notified, true);
  assert.equal(result.record.reply, "Use the checked commit");
  assert.deepEqual(calls[0].slice(1, 5), [
    "orchestration",
    "send",
    "--to",
    "run:run_pm",
  ]);
  const replay = await replySignal(orgFile, {
    signalId: id,
    text: "Use the checked commit",
    execute: async () => {
      throw new Error("a replay must not send again");
    },
  });
  assert.equal(replay.replayed, true);
  assert.equal(calls.length, 1);
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

// Plays `orca terminal send` and `read`; `answers` is consumed in order and
// the last one repeats. An answer is a stage list, or { code, stderr } for a
// failed call.
function orcaNotify(answers, screen = [], terminals) {
  const calls = [];
  const queue = [...answers];
  // Every handle the tests below address by default (the Director's own
  // "term_director", a registry entry's "mock-handle", and a PM's "term_pm")
  // comes back as a confirmed agent session unless a test overrides the list.
  const defaultTerminals =
    terminals ??
    (() => [
      { handle: "term_director", agentIdentity: "claude" },
      { handle: "mock-handle", agentIdentity: "claude" },
      { handle: "term_pm", agentIdentity: "claude" },
    ]);
  const execute = async (argv, options) => {
    const args = argv.slice(1, -1);
    calls.push(args);
    if (args[1] === "list") {
      if (
        typeof defaultTerminals === "object" &&
        !Array.isArray(defaultTerminals) &&
        "code" in defaultTerminals
      ) {
        return {
          code: defaultTerminals.code,
          stdout: "",
          stderr: defaultTerminals.stderr || "",
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          result: {
            terminals:
              typeof defaultTerminals === "function"
                ? defaultTerminals()
                : defaultTerminals,
          },
        }),
      };
    }
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

// ─── Independent worktree delivery receipts ─────────────────────────────────

test("recordDeliveryReceipt persists truthful positive status and unacknowledged receipt", async (t) => {
  const { orgFile } = makeProject(t);
  const source = "/Users/jinsungkim/orca/workspaces/oh-my-teams/lawyer";
  const head = "6c8bdca24b2c5b8d0f7d3aadc2ddaad51f219dad";
  const pr = "https://github.com/inho-team/oh-my-teams/pull/161";

  const orca = orcaNotify(
    [["input_accepted", "turn_started"]],
    [],
    [{ handle: "term_director", agentIdentity: "claude" }],
  );

  const result = await recordDeliveryReceipt(
    orgFile,
    {
      source,
      head,
      pr,
      directorTerminal: "term_director",
      text: "pilot complete",
    },
    { execute: orca.execute },
  );

  assert.equal(result.delivered, true);
  assert.ok(result.record.id);
  assert.equal(result.record.source, source);
  assert.equal(result.record.head, head);
  assert.equal(result.record.pr, pr);
  assert.equal(result.record.target, pr);
  assert.equal(result.record.directorTerminal, "term_director");
  assert.equal(result.record.text, "pilot complete");
  assert.equal(result.record.acknowledged, false);
  assert.equal(result.record.status, "pending-acknowledgement");
  assert.equal(result.record.delivery.notified, true);
  assert.equal(result.record.delivery.sent, true);
  assert.equal(result.record.delivery.outcome, "submitted");

  const { deliveries } = listDeliveries(orgFile);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].id, result.record.id);

  const inbox = listInbox(orgFile);
  assert.equal(inbox.deliveries.length, 1);
  assert.equal(inbox.deliveries[0].id, result.record.id);

  const sends = orca.textSends();
  assert.equal(sends.length, 1);
  const prompt = sends[0][sends[0].indexOf("--text") + 1];
  assert.match(prompt, /\[omt delivery\]/);
  assert.match(prompt, new RegExp(head));
  assert.match(prompt, new RegExp(pr));
});

test("recordDeliveryReceipt persists truthful stale status when director terminal is stale or not found", async (t) => {
  const { orgFile } = makeProject(t);
  const source = "/Users/jinsungkim/orca/workspaces/oh-my-teams/lawyer";
  const head = "6c8bdca24b2c5b8d0f7d3aadc2ddaad51f219dad";
  const pr = "https://github.com/inho-team/oh-my-teams/pull/161";

  // Orca terminal list does not contain term_stale
  const orca = orcaNotify(
    [],
    [],
    [{ handle: "term_other", agentIdentity: "claude" }],
  );

  const result = await recordDeliveryReceipt(
    orgFile,
    {
      source,
      head,
      pr,
      directorTerminal: "term_stale",
    },
    { execute: orca.execute },
  );

  assert.equal(result.delivered, false);
  assert.equal(result.record.status, "stale-terminal");
  assert.equal(result.record.acknowledged, false);
  assert.equal(result.record.delivery.outcome, "stale");
  assert.equal(result.record.delivery.notified, false);
  assert.equal(result.record.delivery.sent, false);
  assert.match(result.record.delivery.notifyError, /terminal-identity-unknown/);

  const { deliveries } = listDeliveries(orgFile);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].status, "stale-terminal");
  assert.equal(deliveries[0].acknowledged, false);
});

test("recordDeliveryReceipt persists truthful failed and unclear status", async (t) => {
  const { orgFile } = makeProject(t);
  const source = "/Users/jinsungkim/orca/workspaces/oh-my-teams/lawyer";
  const head1 = "1111111111111111111111111111111111111111";
  const head2 = "2222222222222222222222222222222222222222";

  // Failed send: pane closed
  const failedOrca = orcaNotify(
    [{ code: 1, stderr: "terminal_not_writable: pane is closed" }],
    [],
    [{ handle: "term_director", agentIdentity: "claude" }],
  );

  const failedResult = await recordDeliveryReceipt(
    orgFile,
    {
      source,
      head: head1,
      target: "pr-1",
      directorTerminal: "term_director",
    },
    { execute: failedOrca.execute },
  );

  assert.equal(failedResult.delivered, false);
  assert.equal(failedResult.record.status, "failed");
  assert.equal(failedResult.record.delivery.outcome, "failed");
  assert.equal(failedResult.record.acknowledged, false);

  // Unclear send: input accepted without turn started
  const unclearOrca = orcaNotify(
    [["input_accepted"]],
    [],
    [{ handle: "term_director", agentIdentity: "claude" }],
  );

  const unclearResult = await recordDeliveryReceipt(
    orgFile,
    {
      source,
      head: head2,
      target: "pr-2",
      directorTerminal: "term_director",
    },
    { execute: unclearOrca.execute },
  );

  assert.equal(unclearResult.delivered, false);
  assert.equal(unclearResult.record.status, "unclear-submission");
  assert.equal(unclearResult.record.delivery.outcome, "unclear");
  assert.equal(unclearResult.record.delivery.sent, true);
  assert.equal(unclearResult.record.acknowledged, false);
});

test("recordDeliveryReceipt idempotency prevents duplicate records and duplicate terminal sends", async (t) => {
  const { orgFile } = makeProject(t);
  const source = "/Users/jinsungkim/orca/workspaces/oh-my-teams/lawyer";
  const head = "6c8bdca24b2c5b8d0f7d3aadc2ddaad51f219dad";
  const pr = "https://github.com/inho-team/oh-my-teams/pull/161";

  const orca = orcaNotify(
    [["input_accepted", "turn_started"]],
    [],
    [{ handle: "term_director", agentIdentity: "claude" }],
  );

  const first = await recordDeliveryReceipt(
    orgFile,
    {
      source,
      head,
      pr,
      directorTerminal: "term_director",
    },
    { execute: orca.execute },
  );

  assert.equal(first.delivered, true);
  assert.equal(orca.textSends().length, 1);
  assert.equal(listDeliveries(orgFile).deliveries.length, 1);

  // Second identical request
  const second = await recordDeliveryReceipt(
    orgFile,
    {
      source,
      head,
      pr,
      directorTerminal: "term_director",
    },
    { execute: orca.execute },
  );

  assert.equal(second.duplicate, true);
  assert.equal(second.replayed, true);
  assert.equal(second.record.id, first.record.id);
  // Terminal send was not invoked again!
  assert.equal(orca.textSends().length, 1);
  // No duplicate record file created!
  assert.equal(listDeliveries(orgFile).deliveries.length, 1);
});

test("safe retry updates existing delivery record in place without duplicating records", async (t) => {
  const { orgFile } = makeProject(t);
  const source = "/Users/jinsungkim/orca/workspaces/oh-my-teams/lawyer";
  const head = "6c8bdca24b2c5b8d0f7d3aadc2ddaad51f219dad";
  const pr = "https://github.com/inho-team/oh-my-teams/pull/161";

  // Initial attempt with stale terminal
  const staleOrca = orcaNotify(
    [],
    [],
    [{ handle: "term_live", agentIdentity: "claude" }],
  );

  const first = await recordDeliveryReceipt(
    orgFile,
    {
      source,
      head,
      pr,
      directorTerminal: "term_stale",
    },
    { execute: staleOrca.execute },
  );

  assert.equal(first.delivered, false);
  assert.equal(first.record.status, "stale-terminal");
  assert.equal(listDeliveries(orgFile).deliveries.length, 1);

  // Retry with updated valid director terminal
  const liveOrca = orcaNotify(
    [["input_accepted", "turn_started"]],
    [],
    [{ handle: "term_live", agentIdentity: "claude" }],
  );

  const retry = await recordDeliveryReceipt(
    orgFile,
    {
      source,
      head,
      pr,
      directorTerminal: "term_live",
    },
    { execute: liveOrca.execute },
  );

  assert.equal(retry.delivered, true);
  assert.equal(retry.retried, true);
  assert.equal(retry.record.id, first.record.id);
  assert.equal(retry.record.status, "pending-acknowledgement");
  assert.equal(retry.record.directorTerminal, "term_live");
  assert.equal(retry.record.delivery.outcome, "submitted");

  // Still exactly one record exists
  const { deliveries } = listDeliveries(orgFile);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].id, first.record.id);
  assert.equal(deliveries[0].status, "pending-acknowledgement");
});

test("safe retry sets retried: true even when createdAt and updatedAt share the exact same timestamp", async (t) => {
  const { orgFile } = makeProject(t);
  const source = "/Users/jinsungkim/orca/workspaces/oh-my-teams/lawyer";
  const head = "6c8bdca24b2c5b8d0f7d3aadc2ddaad51f219dad";
  const pr = "https://github.com/inho-team/oh-my-teams/pull/161";

  const staleOrca = orcaNotify(
    [],
    [],
    [{ handle: "term_live", agentIdentity: "claude" }],
  );

  const first = await recordDeliveryReceipt(
    orgFile,
    { source, head, pr, directorTerminal: "term_stale" },
    { execute: staleOrca.execute },
  );

  assert.equal(first.retried, false);

  const liveOrca = orcaNotify(
    [["input_accepted", "turn_started"]],
    [],
    [{ handle: "term_live", agentIdentity: "claude" }],
  );

  const retry = await recordDeliveryReceipt(
    orgFile,
    { source, head, pr, directorTerminal: "term_live" },
    { execute: liveOrca.execute },
  );

  assert.equal(retry.delivered, true);
  assert.equal(retry.retried, true);
  assert.equal(retry.record.id, first.record.id);
});

test("acknowledgeDelivery marks receipt acknowledged with verified Director identity and updates inbox", async (t) => {
  const { orgFile } = makeProject(t);
  const source = "/Users/jinsungkim/orca/workspaces/oh-my-teams/lawyer";
  const head = "6c8bdca24b2c5b8d0f7d3aadc2ddaad51f219dad";
  const pr = "https://github.com/inho-team/oh-my-teams/pull/161";

  const orca = orcaNotify(
    [["input_accepted", "turn_started"]],
    [],
    [{ handle: "term_director", agentIdentity: "claude" }],
  );

  const delivery = await recordDeliveryReceipt(
    orgFile,
    { source, head, pr, directorTerminal: "term_director" },
    { execute: orca.execute },
  );

  assert.equal(listInbox(orgFile).deliveries.length, 1);

  // Missing caller identity throws
  assert.throws(
    () => acknowledgeDelivery(orgFile, delivery.record.id, { env: {} }),
    /ORCA_TERMINAL_HANDLE or caller terminal is required/,
  );

  // Mismatched caller identity throws
  assert.throws(
    () =>
      acknowledgeDelivery(orgFile, delivery.record.id, {
        callerTerminal: "term_imposter",
      }),
    /does not match delivery director terminal/,
  );

  // Valid Director terminal succeeds
  const ack = acknowledgeDelivery(orgFile, delivery.record.id, {
    callerTerminal: "term_director",
  });
  assert.equal(ack.acknowledged, true);
  assert.equal(ack.record.status, "acknowledged");
  assert.equal(ack.record.acknowledged, true);
  assert.equal(ack.record.acknowledgedBy.role, "director");
  assert.equal(ack.record.acknowledgedBy.terminal, "term_director");
  assert.ok(ack.record.acknowledgedAt);

  // Unacknowledged list in inbox drops it
  assert.equal(listInbox(orgFile).deliveries.length, 0);

  // But listDeliveries keeps it with acknowledged status
  const persisted = readDeliveryReceipt(orgFile, delivery.record.id);
  assert.equal(persisted.status, "acknowledged");
  assert.equal(persisted.acknowledged, true);

  // Repeated delivery after acknowledgement is rejected as replayed duplicate
  const postAck = await recordDeliveryReceipt(
    orgFile,
    { source, head, pr, directorTerminal: "term_director" },
    { execute: orca.execute },
  );
  assert.equal(postAck.duplicate, true);
  assert.equal(postAck.record.status, "acknowledged");

  // Double acknowledgement throws
  assert.throws(
    () =>
      acknowledgeDelivery(orgFile, delivery.record.id, {
        callerTerminal: "term_director",
      }),
    /already acknowledged/,
  );

  // Unknown delivery ID throws
  assert.throws(
    () =>
      acknowledgeDelivery(orgFile, "ghost-delivery-id", {
        callerTerminal: "term_director",
      }),
    /not found/,
  );
});

test("recordDeliveryReceipt validates full 40-char commit HEAD, target, and explicit directorTerminal", async (t) => {
  const { orgFile } = makeProject(t);

  await assert.rejects(
    () =>
      recordDeliveryReceipt(orgFile, {
        head: "6c8bdca24b2c5b8d0f7d3aadc2ddaad51f219dad",
        pr: "https://example.com/pr",
        directorTerminal: "term_director",
      }),
    /Delivery source worktree is required/,
  );

  await assert.rejects(
    () =>
      recordDeliveryReceipt(orgFile, {
        source: "src",
        head: "6c8bdca", // short SHA
        pr: "https://example.com/pr",
        directorTerminal: "term_director",
      }),
    /Full commit HEAD.*required/,
  );

  await assert.rejects(
    () =>
      recordDeliveryReceipt(orgFile, {
        source: "src",
        head: "z".repeat(40), // invalid hex
        pr: "https://example.com/pr",
        directorTerminal: "term_director",
      }),
    /Full commit HEAD.*required/,
  );

  await assert.rejects(
    () =>
      recordDeliveryReceipt(orgFile, {
        source: "src",
        head: "6c8bdca24b2c5b8d0f7d3aadc2ddaad51f219dad",
        directorTerminal: "term_director",
      }),
    /Delivery PR URL or target is required/,
  );

  await assert.rejects(
    () =>
      recordDeliveryReceipt(orgFile, {
        source: "src",
        head: "6c8bdca24b2c5b8d0f7d3aadc2ddaad51f219dad",
        pr: "https://example.com/pr",
      }),
    /Explicit director terminal target is required/,
  );
});

test("recordDeliveryReceipt requires explicit Director target rather than selecting an unrelated kickoff", async (t) => {
  const { orgFile, worktreeId } = makeProject(t);

  // Even though makeProject registers a kickoff with director.terminalHandle,
  // recordDeliveryReceipt must reject calls without explicit directorTerminal.
  await assert.rejects(
    () =>
      recordDeliveryReceipt(orgFile, {
        source: "/Users/jinsungkim/orca/workspaces/oh-my-teams/lawyer",
        head: "6c8bdca24b2c5b8d0f7d3aadc2ddaad51f219dad",
        pr: "https://github.com/inho-team/oh-my-teams/pull/161",
      }),
    /Explicit director terminal target is required/,
  );
});

test("concurrent same-source/head requests must not double send", async (t) => {
  const { orgFile } = makeProject(t);
  const source = "/Users/jinsungkim/orca/workspaces/oh-my-teams/lawyer";
  const head = "6c8bdca24b2c5b8d0f7d3aadc2ddaad51f219dad";
  const pr = "https://github.com/inho-team/oh-my-teams/pull/161";

  let terminalSends = 0;
  const base = orcaNotify(
    [["input_accepted", "turn_started"]],
    [],
    [{ handle: "term_director", agentIdentity: "claude" }],
  );
  const slowExecute = async (argv, options) => {
    if (argv.includes("send")) {
      terminalSends++;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return base.execute(argv, options);
  };

  const [res1, res2] = await Promise.all([
    recordDeliveryReceipt(
      orgFile,
      { source, head, pr, directorTerminal: "term_director" },
      { execute: slowExecute },
    ),
    recordDeliveryReceipt(
      orgFile,
      { source, head, pr, directorTerminal: "term_director" },
      { execute: slowExecute },
    ),
  ]);

  // Exactly one call delivered to terminal, the other was deduplicated
  assert.equal(terminalSends, 1);
  const deliveredCount = [res1, res2].filter((r) => r.delivered).length;
  const duplicateCount = [res1, res2].filter((r) => r.duplicate).length;
  assert.equal(deliveredCount, 1);
  assert.equal(duplicateCount, 1);
  assert.equal(listDeliveries(orgFile).deliveries.length, 1);
});

test("persist intent before any terminal submission so process exit leaves an inspectable record", async (t) => {
  const { orgFile } = makeProject(t);
  const source = "/Users/jinsungkim/orca/workspaces/oh-my-teams/lawyer";
  const head = "6c8bdca24b2c5b8d0f7d3aadc2ddaad51f219dad";
  const pr = "https://github.com/inho-team/oh-my-teams/pull/161";

  let inspectRecordDuringSend = null;
  const base = orcaNotify(
    [["input_accepted", "turn_started"]],
    [],
    [{ handle: "term_director", agentIdentity: "claude" }],
  );
  const inspectingExecute = async (argv, options) => {
    if (argv.includes("send")) {
      const deliveries = listDeliveries(orgFile).deliveries;
      if (deliveries.length > 0) {
        inspectRecordDuringSend = deliveries[0];
      }
    }
    return base.execute(argv, options);
  };

  const res = await recordDeliveryReceipt(
    orgFile,
    { source, head, pr, directorTerminal: "term_director" },
    { execute: inspectingExecute },
  );

  assert.ok(inspectRecordDuringSend);
  assert.equal(inspectRecordDuringSend.status, "pending-submission");
  assert.equal(inspectRecordDuringSend.delivery.inFlight, true);
  assert.equal(inspectRecordDuringSend.delivery.outcome, "pending");
  assert.equal(inspectRecordDuringSend.delivery.owner.pid, process.pid);

  // After completion, settled record is recorded
  assert.equal(res.delivered, true);
  assert.equal(res.record.status, "pending-acknowledgement");
  assert.equal(res.record.delivery.inFlight, false);
});

test("once input may have been sent, retry must not send again without proof", async (t) => {
  const { orgFile } = makeProject(t);
  const source = "/Users/jinsungkim/orca/workspaces/oh-my-teams/lawyer";
  const head = "6c8bdca24b2c5b8d0f7d3aadc2ddaad51f219dad";
  const pr = "https://github.com/inho-team/oh-my-teams/pull/161";

  let sendCalls = 0;
  // Orca answers input_accepted (without turn_started and empty screen), so outcome becomes unclear and sent is true
  const base = orcaNotify(
    [["input_accepted"]],
    [],
    [{ handle: "term_director", agentIdentity: "claude" }],
  );
  const sendingExecute = async (argv, options) => {
    if (argv.includes("send")) {
      sendCalls++;
    }
    return base.execute(argv, options);
  };

  const first = await recordDeliveryReceipt(
    orgFile,
    { source, head, pr, directorTerminal: "term_director" },
    { execute: sendingExecute },
  );

  assert.equal(first.delivered, false);
  assert.equal(first.record.delivery.sent, true);
  assert.equal(first.record.status, "unclear-submission");
  const callsBeforeRetry = sendCalls;
  assert.ok(callsBeforeRetry >= 1);

  // Second attempt: because sent was true, retry must NOT send again to avoid duplicate keys!
  const retry = await recordDeliveryReceipt(
    orgFile,
    { source, head, pr, directorTerminal: "term_director" },
    { execute: sendingExecute },
  );

  assert.equal(retry.duplicate, true);
  assert.equal(retry.replayed, true);
  assert.equal(sendCalls, callsBeforeRetry); // Not invoked again!
});

test("kickoff compatibility: independent delivery receipts do not interfere with registered kickoffs", async (t) => {
  const { orgFile, worktreeId } = makeProject(t);

  const signal = sendSignal(orgFile, {
    worktreeId,
    kind: "close-ready",
    text: "kickoff ready",
    head: "1111111111111111111111111111111111111111",
    source: "/path/to/kickoff",
  });

  const delivery = await recordDeliveryReceipt(
    orgFile,
    {
      source: "/independent/worktree",
      head: "2222222222222222222222222222222222222222",
      pr: "https://example.com/pr/1",
      directorTerminal: "term_director",
    },
    {
      execute: async () => ({
        code: 0,
        stdout: JSON.stringify([
          { handle: "term_director", agentIdentity: "claude" },
        ]),
        stderr: "",
      }),
    },
  );

  const inbox = listInbox(orgFile);
  assert.equal(inbox.signals.length, 1);
  assert.equal(inbox.signals[0].id, signal.id);
  assert.equal(inbox.deliveries.length, 1);
  assert.equal(inbox.deliveries[0].id, delivery.record.id);

  // findCloseReadySignal still returns the kickoff signal unaffected
  const closeReady = findCloseReadySignal(orgFile, worktreeId);
  assert.equal(closeReady.id, signal.id);

  // acknowledgeSignal works on signal without affecting delivery
  acknowledgeSignal(orgFile, signal.id);
  assert.equal(listInbox(orgFile).signals.length, 0);
  assert.equal(listInbox(orgFile).deliveries.length, 1);
});
