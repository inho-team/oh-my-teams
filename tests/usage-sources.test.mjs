/** Usage collectors: provider session stores read for counters, never for text. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  headlessStatus,
  readHeadlessStream,
} from "../plugins/oh-my-teams/scripts/headless.mjs";
import {
  AGY_SUMMARY_COLUMNS,
  collectAgyConversations,
  collectClaudeTranscripts,
  collectCodexRollouts,
  collectHarnessReports,
  collectHeadless,
  encodeClaudeProject,
  pathWithin,
  usageHomes,
} from "../plugins/oh-my-teams/scripts/usage-sources.mjs";
import { decodeOutput } from "../plugins/oh-my-teams/scripts/providers.mjs";

// Every fixture writes this into message text, titles and previews. A report
// that contains it has copied content it must never carry.
const CANARY = "CANARY-7f3a-message-text";
const MINUTE = 60 * 1000;

function tempDir(t, prefix = "omt-usage-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() =>
    fs.rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    }),
  );
  return dir;
}

function writeLines(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
}

const at = (base, minutes) => new Date(base + minutes * MINUTE).toISOString();

function claudeAssistant(base, minutes, fields) {
  return {
    type: "assistant",
    timestamp: at(base, minutes),
    sessionId: fields.sessionId ?? "claude-s1",
    cwd: fields.cwd,
    isSidechain: fields.isSidechain ?? false,
    message: {
      id: fields.id,
      model: fields.model ?? "claude-opus-5",
      role: "assistant",
      content: [{ type: "text", text: `${CANARY} answer` }],
      usage: fields.usage,
    },
  };
}

test("Claude transcripts count each response once and read only counters", (t) => {
  const home = tempDir(t);
  const worktree = path.join(home, "work", "kickoff-a");
  const sibling = path.join(home, "work", "kickoff-a-2");
  const base = Date.parse("2026-09-10T10:00:00.000Z");
  const usage = {
    input_tokens: 10,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 5,
    output_tokens: 20,
    output_tokens_details: { thinking_tokens: 7 },
  };
  const project = path.join(home, "projects", encodeClaudeProject(worktree));
  writeLines(path.join(project, "claude-s1.jsonl"), [
    // Before the kickoff began: clipped, not counted.
    claudeAssistant(base, -60, { cwd: worktree, id: "msg-old", usage }),
    {
      type: "user",
      timestamp: at(base, 1),
      sessionId: "claude-s1",
      cwd: worktree,
      message: { role: "user", content: `${CANARY} prompt` },
    },
    {
      type: "user",
      isMeta: true,
      timestamp: at(base, 1),
      sessionId: "claude-s1",
      cwd: worktree,
      message: { role: "user", content: [{ type: "text", text: CANARY }] },
    },
    // One response written as two content blocks repeats its usage.
    claudeAssistant(base, 2, { cwd: worktree, id: "msg-1", usage }),
    claudeAssistant(base, 2, { cwd: worktree, id: "msg-1", usage }),
    {
      type: "user",
      timestamp: at(base, 3),
      sessionId: "claude-s1",
      cwd: worktree,
      toolUseResult: { stdout: CANARY },
      message: { role: "user", content: [{ type: "tool_result" }] },
    },
    claudeAssistant(base, 3, {
      cwd: worktree,
      id: "msg-synthetic",
      model: "<synthetic>",
      usage: { input_tokens: 999, output_tokens: 999 },
    }),
    // A subfolder of the worktree is still the worktree.
    claudeAssistant(base, 4, {
      cwd: path.join(worktree, "src"),
      id: "msg-2",
      usage: {
        input_tokens: 1,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 0,
        output_tokens: 3,
      },
    }),
  ]);
  writeLines(path.join(project, "claude-s1", "subagents", "agent-x.jsonl"), [
    claudeAssistant(base, 5, {
      cwd: worktree,
      id: "msg-sub",
      model: "claude-sonnet-5",
      isSidechain: true,
      usage: { input_tokens: 2, output_tokens: 4 },
    }),
  ]);
  // A sibling whose name starts with the worktree's is another place.
  writeLines(
    path.join(home, "projects", encodeClaudeProject(sibling), "other.jsonl"),
    [
      claudeAssistant(base, 2, {
        sessionId: "claude-other",
        cwd: sibling,
        id: "msg-x",
        usage,
      }),
    ],
  );

  const { records, unavailable } = collectClaudeTranscripts({
    claudeHome: home,
    places: [worktree],
    window: { from: base, to: base + 60 * MINUTE },
  });
  assert.equal(unavailable, null);
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.sessionKey, "claude-s1");
  assert.equal(record.calls, 3);
  assert.equal(record.turns, 1);
  assert.equal(record.promptTokens, 115 + 51 + 2);
  assert.equal(record.cachedInputTokens, 150);
  assert.equal(record.cacheCreationTokens, 5);
  assert.equal(record.outputTokens, 27);
  assert.equal(record.reasoningTokens, 7);
  assert.deepEqual(record.modelReported, ["claude-opus-5"]);
  assert.deepEqual(record.subagentModels, ["claude-sonnet-5"]);
  assert.equal(record.measured, true);
  assert.equal(record.clippedEntries, 1);
  assert.equal(record.cwd, worktree);
  assert.ok(!JSON.stringify(records).includes(CANARY));

  assert.equal(
    collectClaudeTranscripts({
      claudeHome: path.join(home, "missing"),
      places: [worktree],
    }).unavailable,
    "claude-projects-missing",
  );
});

function tokenCount(base, minutes, total) {
  return {
    timestamp: at(base, minutes),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: total,
        last_token_usage: total,
      },
    },
  };
}

test("Codex rollouts take the cumulative total's change inside the window", (t) => {
  const home = tempDir(t);
  const worktree = path.join(home, "work", "pl");
  const base = Date.parse("2026-09-10T10:00:00.000Z");
  const meta = (id, cwd) => ({
    timestamp: at(base, -24 * 60),
    type: "session_meta",
    payload: { id, session_id: id, cwd, timestamp: at(base, -24 * 60) },
  });
  // A resumed session keeps writing to the file of the day it began.
  writeLines(
    path.join(
      home,
      "sessions",
      "2026",
      "08",
      "01",
      "rollout-2026-08-01-th1.jsonl",
    ),
    [
      meta("th1", worktree),
      {
        timestamp: at(base, -120),
        type: "turn_context",
        payload: { cwd: worktree, model: "gpt-5.6-sol" },
      },
      tokenCount(base, -110, {
        input_tokens: 1000,
        cached_input_tokens: 800,
        output_tokens: 100,
        reasoning_output_tokens: 10,
        total_tokens: 1100,
      }),
      {
        timestamp: at(base, 5),
        type: "event_msg",
        payload: { type: "task_started", turn_id: "t2" },
      },
      {
        timestamp: at(base, 5),
        type: "turn_context",
        payload: { cwd: worktree, model: "gpt-6-astra" },
      },
      {
        timestamp: at(base, 6),
        type: "response_item",
        payload: {
          type: "message",
          content: [{ type: "input_text", text: CANARY }],
        },
      },
      tokenCount(base, 7, {
        input_tokens: 1500,
        cached_input_tokens: 1100,
        output_tokens: 160,
        reasoning_output_tokens: 15,
        total_tokens: 1660,
      }),
      tokenCount(base, 8, {
        input_tokens: 1500,
        cached_input_tokens: 1100,
        output_tokens: 160,
        reasoning_output_tokens: 15,
        total_tokens: 1660,
      }),
      tokenCount(base, 9, {
        input_tokens: 1800,
        cached_input_tokens: 1300,
        output_tokens: 200,
        reasoning_output_tokens: 20,
        total_tokens: 2000,
      }),
      tokenCount(base, 24 * 60, {
        input_tokens: 9000,
        cached_input_tokens: 0,
        output_tokens: 900,
        total_tokens: 9900,
      }),
    ],
  );
  writeLines(
    path.join(home, "archived_sessions", "rollout-2026-09-10-th2.jsonl"),
    [
      meta("th2", worktree),
      {
        timestamp: at(base, 10),
        type: "event_msg",
        payload: { type: "task_started", turn_id: "t1" },
      },
    ],
  );
  writeLines(path.join(home, "sessions", "rollout-2026-09-10-th3.jsonl"), [
    meta("th3", path.join(home, "work", "elsewhere")),
    tokenCount(base, 10, { input_tokens: 5, output_tokens: 5 }),
  ]);

  const { records } = collectCodexRollouts({
    codexHome: home,
    places: [worktree],
    window: { from: base, to: base + 60 * MINUTE },
  });
  const byKey = Object.fromEntries(
    records.map((record) => [record.sessionKey, record]),
  );
  assert.deepEqual(Object.keys(byKey).sort(), ["th1", "th2"]);
  const measured = byKey.th1;
  assert.equal(measured.promptTokens, 800);
  assert.equal(measured.cachedInputTokens, 500);
  assert.equal(measured.inputTokens, 300);
  assert.equal(measured.outputTokens, 100);
  assert.equal(measured.reasoningTokens, 10);
  assert.equal(measured.calls, 2);
  assert.equal(measured.turns, 1);
  assert.deepEqual(measured.modelReported, ["gpt-6-astra"]);
  assert.equal(measured.measured, true);
  assert.ok(measured.clippedEntries >= 1);

  assert.equal(byKey.th2.measured, false);
  assert.equal(byKey.th2.reason, "codex-rollout-without-token-count");
  assert.equal(byKey.th2.promptTokens, null);
  assert.ok(!JSON.stringify(records).includes(CANARY));
  assert.equal(
    collectCodexRollouts({ codexHome: path.join(home, "none"), places: [] })
      .unavailable,
    "codex-sessions-missing",
  );
});

function agyTime(ms) {
  return new Date(ms)
    .toISOString()
    .replace("T", " ")
    .replace("Z", "0000+00:00");
}

test("Agy conversations are unmeasured and read only whitelisted columns", async (t) => {
  const home = tempDir(t);
  const worktree = path.join(home, "work", "senior");
  const base = Date.now() - 30 * MINUTE;
  assert.deepEqual(AGY_SUMMARY_COLUMNS, [
    "conversation_id",
    "workspace_uris",
    "step_count",
    "last_modified_time",
    "last_user_input_time",
  ]);
  const missing = await collectAgyConversations({
    agyHome: home,
    places: [worktree],
  });
  assert.deepEqual(missing, {
    source: "agy-summary",
    records: [],
    unavailable: "agy-summary-db-missing",
  });

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(home, "conversation_summaries.db"));
  db.exec(`CREATE TABLE conversation_summaries (
    conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT,
    step_count INTEGER, last_modified_time datetime, workspace_uris TEXT,
    last_user_input_time datetime, raw_summary BLOB)`);
  const insert = db.prepare(
    "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const uri = (directory) =>
    `file:///${directory.replace(/\\/g, "/").replace(/^\//, "")}`;
  insert.run(
    "11111111-aaaa-bbbb-cccc-000000000001",
    CANARY,
    CANARY,
    12,
    agyTime(base + 10 * MINUTE),
    JSON.stringify([uri(path.join(worktree, "app"))]),
    agyTime(base + 9 * MINUTE),
    Buffer.from(CANARY),
  );
  insert.run(
    "11111111-aaaa-bbbb-cccc-000000000002",
    CANARY,
    CANARY,
    40,
    agyTime(base + 10 * MINUTE),
    JSON.stringify([uri(path.join(home, "work", "senior-2"))]),
    agyTime(base + 9 * MINUTE),
    null,
  );
  db.close();

  const { records, unavailable } = await collectAgyConversations({
    agyHome: home,
    places: [worktree],
    window: { from: base, to: base + 60 * MINUTE },
  });
  assert.equal(unavailable, null);
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.provider, "agy");
  assert.equal(record.steps, 12);
  assert.equal(record.measured, false);
  assert.equal(record.reason, "agy-interactive-usage-not-recorded");
  assert.equal(record.promptTokens, null);
  assert.equal(record.outputTokens, null);
  assert.equal(record.firstAtSource, "last-user-input");
  assert.ok(pathWithin(record.cwd, worktree));
  assert.ok(!JSON.stringify(records).includes(CANARY));
});

function headlessWorker(stateDir, id, worker, turns) {
  const dir = path.join(stateDir, "headless", id);
  writeJSON(path.join(dir, "worker.json"), {
    schemaVersion: 1,
    id,
    binary: [worker.provider],
    effortRequested: null,
    timeoutMs: 1000,
    ...worker,
  });
  turns.forEach((turn, index) => {
    const turnDir = path.join(dir, "turns", String(index + 1));
    writeJSON(path.join(turnDir, "turn.json"), {
      number: index + 1,
      startedAt: turn.startedAt,
    });
    writeLines(path.join(turnDir, "stream.jsonl"), turn.events);
    if (turn.endedAt) {
      writeJSON(path.join(turnDir, "exit.json"), {
        code: 0,
        endedAt: turn.endedAt,
      });
    }
  });
}

test("headless streams report usage for each provider, summed over turns", (t) => {
  const dir = tempDir(t);
  const state = path.join(dir, "state");
  const codexHome = path.join(dir, "empty-codex-home");
  const base = Date.parse("2026-09-10T10:00:00.000Z");
  const claudeResult = (tokens) => ({
    type: "result",
    session_id: "claude-headless",
    result: `${CANARY}\nDONE: ok`,
    usage: {
      input_tokens: tokens,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 10,
      output_tokens: 30,
    },
    total_cost_usd: 0.25,
    num_turns: 4,
  });
  const claudeRead = readHeadlessStream(
    "claude",
    JSON.stringify(claudeResult(5)),
  );
  assert.deepEqual(claudeRead.usage, {
    promptTokens: 115,
    inputTokens: 5,
    cachedInputTokens: 100,
    cacheCreationTokens: 10,
    outputTokens: 30,
    reasoningTokens: null,
  });
  assert.equal(claudeRead.costUsd, 0.25);
  assert.equal(claudeRead.numTurns, 4);

  const codexEvents = [
    { type: "thread.started", thread_id: "codex-headless" },
    {
      type: "turn.completed",
      usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 7 },
    },
    {
      type: "turn.completed",
      usage: { input_tokens: 50, cached_input_tokens: 40, output_tokens: 3 },
    },
  ];
  const codexRead = readHeadlessStream(
    "codex",
    codexEvents.map((event) => JSON.stringify(event)).join("\n"),
    { codexHome },
  );
  assert.equal(codexRead.usage.promptTokens, 150);
  assert.equal(codexRead.usage.cachedInputTokens, 100);
  assert.equal(codexRead.usage.outputTokens, 10);
  assert.equal(codexRead.numTurns, 2);

  // Where stream-json puts Agy's usage is unconfirmed; both spots are read.
  const agyUsage = {
    input_tokens: 70,
    output_tokens: 9,
    thinking_tokens: 4,
    cache_read_tokens: 20,
    total_tokens: 83,
  };
  for (const event of [
    {
      event: "result",
      result: { conversation_id: "agy-h", status: "SUCCESS", usage: agyUsage },
    },
    {
      event: "result",
      usage: agyUsage,
      num_turns: 2,
      result: { conversation_id: "agy-h", status: "SUCCESS" },
    },
  ]) {
    const read = readHeadlessStream("agy", JSON.stringify(event));
    assert.equal(read.usage.promptTokens, 70);
    assert.equal(read.usage.cachedInputTokens, 20);
    assert.equal(read.usage.reasoningTokens, 4);
  }
  assert.equal(readHeadlessStream("agy", "{}").usage, null);

  headlessWorker(
    state,
    "junior-1",
    {
      role: "junior",
      profile: "claude-profile",
      provider: "claude",
      modelRequested: "claude-sonnet-5",
      cwd: path.join(dir, "junior"),
      createdAt: at(base, 1),
    },
    [
      {
        startedAt: at(base, 1),
        endedAt: at(base, 2),
        events: [
          {
            type: "system",
            subtype: "init",
            session_id: "claude-headless",
            model: "claude-sonnet-5",
          },
          claudeResult(5),
        ],
      },
      {
        startedAt: at(base, 3),
        endedAt: at(base, 4),
        events: [claudeResult(15)],
      },
    ],
  );
  const status = headlessStatus(state, "junior-1", { codexHome });
  assert.deepEqual(status.sessions, ["claude-headless"]);
  assert.equal(status.usage.promptTokens, 115 + 125);
  assert.deepEqual(status.usageTurns, { measured: 2, total: 2 });

  headlessWorker(
    state,
    "senior-1",
    {
      role: "senior",
      profile: "codex-profile",
      provider: "codex",
      modelRequested: "gpt-5.6-luna",
      cwd: path.join(dir, "senior"),
      createdAt: at(base, 5),
    },
    [
      { startedAt: at(base, 5), endedAt: at(base, 6), events: codexEvents },
      { startedAt: at(base, 7), endedAt: null, events: [] },
    ],
  );
  const { records } = collectHeadless(state, {
    codexHome,
    window: { from: base, to: base + 60 * MINUTE },
  });
  const byWorker = Object.fromEntries(
    records.map((record) => [record.workerId, record]),
  );
  assert.equal(byWorker["junior-1"].role, "junior");
  assert.equal(byWorker["junior-1"].turns, 2);
  assert.equal(byWorker["junior-1"].calls, 8);
  assert.equal(byWorker["junior-1"].costUsd, 0.5);
  assert.equal(byWorker["junior-1"].measured, true);
  assert.deepEqual(byWorker["junior-1"].modelReported, ["claude-sonnet-5"]);
  assert.equal(byWorker["senior-1"].measured, "partial");
  assert.equal(byWorker["senior-1"].reason, "headless-turn-running");
  assert.equal(byWorker["senior-1"].sessionKey, "codex-headless");
  assert.ok(!JSON.stringify(records).includes(CANARY));
});

test("harness calls keep the session id that lets a report skip duplicates", (t) => {
  const dir = tempDir(t);
  const decoded = decodeOutput(
    [
      JSON.stringify({ type: "thread.started", thread_id: "th-harness" }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 9, output_tokens: 1 },
      }),
    ].join("\n"),
  );
  assert.equal(decoded.sessionId, "th-harness");
  assert.equal(
    decodeOutput(JSON.stringify({ result: "x", session_id: "s-9" })).sessionId,
    "s-9",
  );
  assert.equal(decodeOutput("plain text").sessionId, null);

  writeJSON(path.join(dir, "runs", "run-1", "report.json"), {
    runId: "run-1",
    role: "junior",
    summary: CANARY,
    calls: [
      {
        profile: "codex-current",
        provider: "codex",
        requestedModel: "gpt-5.6-sol",
        effectiveModel: "gpt-5.6-sol",
        sessionId: "th-harness",
        usage: { input_tokens: 90, cached_input_tokens: 30, output_tokens: 5 },
        costUsd: null,
      },
      {
        profile: "codex-current",
        provider: "codex",
        requestedModel: "gpt-5.6-sol",
        effectiveModel: null,
        usage: null,
      },
    ],
  });
  writeJSON(path.join(dir, "assists", "a-1.json"), {
    callerRole: "junior",
    profile: "agy-oss",
    requestedModel: "gpt-oss-120b-medium",
    effectiveModel: null,
    summary: CANARY,
    usage: { input_tokens: 40, output_tokens: 2 },
    costUsd: null,
  });
  const { records } = collectHarnessReports(dir, {
    org: { profiles: { "agy-oss": { provider: "agy" } } },
  });
  assert.equal(records.length, 3);
  const [first, second, assist] = records;
  assert.equal(first.sessionKey, "th-harness");
  assert.equal(first.promptTokens, 90);
  assert.equal(first.role, "junior");
  assert.equal(second.measured, false);
  assert.equal(second.reason, "harness-call-without-usage");
  assert.equal(second.sessionKey, "harness:run-1:2");
  assert.equal(assist.role, "junior");
  assert.equal(assist.provider, "agy");
  assert.equal(assist.promptTokens, 40);
  assert.ok(!JSON.stringify(records).includes(CANARY));
});

test("eachJsonLine reads multi-byte characters that span chunk boundaries correctly", (t) => {
  // Each line contains a 3-byte Korean character (U+AC00, UTF-8: 0xEA 0xB0 0x80).
  // Lines are ~65 bytes so a 64 KiB chunk boundary will fall inside a multi-byte
  // sequence eventually; collectClaudeTranscripts must still parse every record.
  const home = tempDir(t);
  const worktree = path.join(home, "work", "mb-test");
  const base = Date.parse("2026-09-10T10:00:00.000Z");
  const usage = { input_tokens: 1, output_tokens: 1 };
  // Build entries whose sessionId includes a multi-byte character.
  const entries = Array.from({ length: 200 }, (_, i) => ({
    type: "assistant",
    timestamp: new Date(base + i * 1000).toISOString(),
    sessionId: "가나다",
    cwd: worktree,
    isSidechain: false,
    message: {
      id: `msg-${i}`,
      model: "claude-opus-5",
      role: "assistant",
      content: [],
      usage,
    },
  }));
  const project = path.join(home, "projects", encodeClaudeProject(worktree));
  writeLines(path.join(project, "mb-session.jsonl"), entries);

  const { records, unavailable } = collectClaudeTranscripts({
    claudeHome: home,
    places: [worktree],
    window: { from: base - 1000, to: base + 200 * 1000 },
  });
  assert.equal(unavailable, null);
  assert.equal(records.length, 1);
  assert.equal(records[0].calls, 200);
});

test("eachJsonLine stops immediately when visitor returns false", (t) => {
  // collectCodexRollouts uses eachJsonLine with return false on first line
  // if the session is for a different place; it must not read the rest.
  const home = tempDir(t);
  const elsewhere = path.join(home, "work", "elsewhere");
  const base = Date.parse("2026-09-10T10:00:00.000Z");
  // Write a rollout for a cwd not in our places list.
  const meta = {
    timestamp: new Date(base - 24 * 60 * 60 * 1000).toISOString(),
    type: "session_meta",
    payload: {
      id: "th-stop",
      session_id: "th-stop",
      cwd: elsewhere,
      timestamp: new Date(base - 24 * 60 * 60 * 1000).toISOString(),
    },
  };
  // Add a line after meta that would produce a record if reading continued.
  const tokenCount = {
    timestamp: new Date(base + 5000).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 99, output_tokens: 99 } },
    },
  };
  writeLines(path.join(home, "sessions", "rollout-early-stop.jsonl"), [
    meta,
    tokenCount,
  ]);
  const { records } = collectCodexRollouts({
    codexHome: home,
    places: [path.join(home, "work", "other")],
    window: { from: base, to: base + 60 * 60 * 1000 },
  });
  assert.equal(records.length, 0);
});

test("eachJsonLine streams large file without holding the whole content in memory", (t) => {
  // Write a file large enough (> 1 MB) and collect from it; the test verifies
  // functional correctness (all lines visited, no data loss) not memory usage
  // (RSS measurement is done in the appendix with an out-of-tree script).
  const home = tempDir(t);
  const worktree = path.join(home, "work", "large-file");
  const base = Date.parse("2026-09-10T10:00:00.000Z");
  const COUNT = 5000; // ~200 B/line ≈ 1 MB
  const usage = { input_tokens: 10, output_tokens: 20 };
  const entries = Array.from({ length: COUNT }, (_, i) => ({
    type: "assistant",
    timestamp: new Date(base + i * 1000).toISOString(),
    sessionId: "large-s1",
    cwd: worktree,
    isSidechain: false,
    message: {
      id: `msg-${i}`,
      model: "claude-opus-5",
      role: "assistant",
      content: [],
      usage,
    },
  }));
  const project = path.join(home, "projects", encodeClaudeProject(worktree));
  writeLines(path.join(project, "large.jsonl"), entries);

  const { records, unavailable } = collectClaudeTranscripts({
    claudeHome: home,
    places: [worktree],
    window: { from: base - 1000, to: base + COUNT * 1000 },
  });
  assert.equal(unavailable, null);
  assert.equal(records.length, 1);
  assert.equal(records[0].calls, COUNT);
});

test("paths compare at separators, and without case on Windows", () => {
  assert.ok(pathWithin("C:/Work/Kickoff/src", "c:\\work\\kickoff", "win32"));
  assert.ok(pathWithin("c:\\work\\kickoff\\", "C:\\Work\\Kickoff", "win32"));
  assert.ok(!pathWithin("C:\\work\\kickoff-2", "C:\\work\\kickoff", "win32"));
  assert.ok(!pathWithin("/work/Kickoff", "/work/kickoff", "linux"));
  assert.ok(pathWithin("/work/kickoff/a", "/work/kickoff", "linux"));
  assert.ok(!pathWithin(null, "/work", "linux"));

  const homes = usageHomes(
    { codexHome: "/explicit/codex" },
    { CLAUDE_CONFIG_DIR: "/env/claude", CODEX_HOME: "/env/codex" },
  );
  assert.equal(homes.claudeHome, path.resolve("/env/claude"));
  assert.equal(homes.codexHome, path.resolve("/explicit/codex"));
  assert.equal(
    homes.agyHome,
    path.join(os.homedir(), ".gemini", "antigravity-cli"),
  );
});
