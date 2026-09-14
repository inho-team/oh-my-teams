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
  withWorkflowUpdate,
  readWorkflowSnapshot,
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
