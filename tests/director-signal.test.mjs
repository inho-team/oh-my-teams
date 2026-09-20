/** Signal channel and resource slot tests. */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJSON, readJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  sendSignal,
  listInbox,
  replySignal,
  acknowledgeSignal,
  readSignal,
  findCloseReadySignal,
  SIGNAL_KINDS,
  processLiveness,
} from "../plugins/oh-my-teams/scripts/director.mjs";
import {
  acquireResource,
  releaseResource,
  RESOURCE_KINDS,
} from "../plugins/oh-my-teams/scripts/resources.mjs";

const exampleOrg = readJSON(
  new URL("../plugins/oh-my-teams/examples/organization.json", import.meta.url),
);

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
    kind: "progress",
    text: "halfway done",
  });

  assert.ok(result.signaled);
  assert.ok(result.id);

  const { signals } = listInbox(orgFile);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].id, result.id);
  assert.equal(signals[0].kind, "progress");
  assert.equal(signals[0].text, "halfway done");
  assert.equal(signals[0].status, "pending");
  assert.equal(signals[0].worktreeId, worktreeId);
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

  // Acquire first slot.
  const live = acquireResource(orgFile, { worktreeId, kind: "build" });
  assert.ok(live.acquired);

  // Acquire a second slot; the liveness check says the first owner is dead.
  const second = acquireResource(orgFile, {
    worktreeId,
    kind: "build",
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
