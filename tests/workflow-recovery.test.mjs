/** Crash-window regression tests for workflow journals and dead-owner locks. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  readJSON,
  writeJSON,
  withFileLock,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  appendWorkflowEvent,
  withWorkflowUpdate,
  readWorkflowSnapshot,
  saveWorkflowState,
  workflowDirectory,
} from "../plugins/oh-my-teams/scripts/workflow-store.mjs";

test("a killed lock owner can be recovered but an unknown owner cannot", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teams-crash-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "state.lock");
  const module = new URL(
    "../plugins/oh-my-teams/scripts/core.mjs",
    import.meta.url,
  ).href;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `import { withFileLock } from ${JSON.stringify(module)}; withFileLock(process.argv[1], () => ` +
      `{process.stdout.write('locked'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, ` +
      `0);});`,
    lock,
  ]);
  t.after(() => child.kill("SIGKILL"));
  await once(child.stdout, "data");
  assert.throws(() => withFileLock(lock, () => true), /progress/);
  const closed = once(child, "close");
  child.kill("SIGKILL");
  await closed;
  assert.equal(
    withFileLock(lock, () => "recovered"),
    "recovered",
  );
  fs.writeFileSync(lock, "unknown");
  assert.throws(() => withFileLock(lock, () => true), /progress/);
});

test("committed journal survives interruption before state and event materialization", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teams-journal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workflow = path.join(dir, "workflows", "recovery");
  writeJSON(path.join(workflow, "organization.json"), {});
  writeJSON(path.join(workflow, "state.json"), {
    revision: 1,
    tasks: {},
    eventIds: [],
  });
  const state = { revision: 2, tasks: {}, eventIds: ["event-1"] };
  const event = { id: "event-1", type: "execution-attached" };
  writeJSON(path.join(workflow, "transaction.json"), {
    state,
    events: [{ name: "000001-event-1.json", event }],
  });
  assert.equal(readWorkflowSnapshot(dir, "recovery").state.revision, 2);
  withWorkflowUpdate(dir, "recovery", () =>
    assert.deepEqual(readJSON(path.join(workflow, "state.json")), state),
  );
  assert.deepEqual(
    readJSON(path.join(workflow, "events", "000001-event-1.json")),
    event,
  );
  assert.equal(fs.existsSync(path.join(workflow, "transaction.json")), false);
});

test("state.json round-trip preserves array format for eventIds", (t) => {
  // Verifies STATE-01 fix: eventIds stored as array in file, not as Set ({}).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teams-roundtrip-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wfDir = path.join(dir, "workflows", "rt");
  writeJSON(path.join(wfDir, "organization.json"), {});
  const initial = { revision: 1, tasks: {}, eventIds: ["ev-a", "ev-b"] };
  writeJSON(path.join(wfDir, "state.json"), initial);
  withWorkflowUpdate(dir, "rt", () => {
    const { state } = readWorkflowSnapshot(dir, "rt");
    saveWorkflowState(dir, "rt", state);
  });
  const persisted = readJSON(path.join(wfDir, "state.json"));
  assert.ok(
    Array.isArray(persisted.eventIds),
    "eventIds must be an array after save",
  );
  assert.deepEqual(persisted.eventIds, ["ev-a", "ev-b"]);
});

test("appendWorkflowEvent rejects duplicates and accepts new IDs via Set cache", (t) => {
  // Verifies STATE-01 fix: duplicate detection uses O(1) Set lookup, not Array.includes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teams-setlookup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wfDir = path.join(dir, "workflows", "sl");
  writeJSON(path.join(wfDir, "organization.json"), {});
  const state = { revision: 1, tasks: {}, eventIds: ["existing-1"] };
  writeJSON(path.join(wfDir, "state.json"), state);
  const { state: loaded } = readWorkflowSnapshot(dir, "sl");
  // Duplicate of an ID already in the persisted array must be rejected.
  assert.equal(appendWorkflowEvent(wfDir, loaded, { id: "existing-1" }), false);
  // A new ID must be accepted.
  assert.equal(appendWorkflowEvent(wfDir, loaded, { id: "new-1" }), true);
  // Same new ID a second time must be rejected (Set cache updated).
  assert.equal(appendWorkflowEvent(wfDir, loaded, { id: "new-1" }), false);
  assert.deepEqual(loaded.eventIds, ["existing-1", "new-1"]);
});
