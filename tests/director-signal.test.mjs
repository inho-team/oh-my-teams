/** Signal channel and resource slot tests. */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
} from "../plugins/oh-my-teams/scripts/director.mjs";
import {
  acquireResource,
  parseMeminfo,
  parseVmStat,
  queryPmLiveness,
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

function recordPmLaunch(orgFile, worktreePath, terminal) {
  const file = path.join(path.dirname(orgFile), "usage", "launches.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    `${JSON.stringify({ schemaVersion: 1, via: "role-terminal", role: "pm", worktreePath, terminal })}\n`,
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
