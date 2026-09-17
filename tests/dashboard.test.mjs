/** The dashboard shows headless workers and acts on them only with its token. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  headlessTranscript,
  startHeadlessWorker,
  waitHeadless,
} from "../plugins/oh-my-teams/scripts/headless.mjs";
import { startDashboard } from "../plugins/oh-my-teams/scripts/dashboard.mjs";

const FAKE = path.resolve("tests/fake-agent.mjs");
const TOKEN = "test-token-0123456789";

function sandbox(t) {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "omt-dashboard-")),
  );
  t.after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  });
  const cwd = path.join(dir, "worktree");
  fs.mkdirSync(cwd);
  return { state: path.join(dir, "state"), cwd };
}

function start(box, provider, workerId, prompt) {
  return startHeadlessWorker({
    stateDir: box.state,
    workerId,
    role: "junior",
    profile: `${provider}-profile`,
    provider,
    binary: [process.execPath, FAKE, provider],
    model: null,
    effort: null,
    cwd: box.cwd,
    prompt,
  });
}

async function serve(t, box) {
  const started = await startDashboard({
    stateDir: box.state,
    port: 0,
    host: "127.0.0.1",
    token: TOKEN,
  });
  t.after(() => new Promise((resolve) => started.server.close(resolve)));
  const base = `http://127.0.0.1:${started.port}`;
  const call = async (
    pathname,
    { token = TOKEN, method = "GET", body } = {},
  ) => {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: {
        ...(token ? { "x-omt-token": token } : {}),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : body,
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // HTML or plain text.
    }
    return { status: response.status, text, json };
  };
  return { started, base, call };
}

test("each provider's stream becomes a readable transcript", () => {
  const lines = (events) =>
    events.map((event) => JSON.stringify(event)).join("\n");
  assert.deepEqual(
    headlessTranscript(
      "claude",
      lines([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "Bash",
                input: { command: "git status" },
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", content: "clean", is_error: false },
            ],
          },
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "DONE: ok" }] },
        },
      ]),
    ),
    [
      { kind: "tool", name: "Bash", text: "git status" },
      { kind: "output", text: "clean" },
      { kind: "text", text: "DONE: ok" },
    ],
  );
  assert.deepEqual(
    headlessTranscript(
      "codex",
      lines([
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "ls",
            aggregated_output: "boom",
            exit_code: 2,
          },
        },
        {
          type: "item.completed",
          item: { type: "agent_message", text: "FAILED: ls broke" },
        },
      ]),
    ),
    [
      { kind: "tool", name: "shell", text: "ls" },
      { kind: "error", text: "boom" },
      { kind: "text", text: "FAILED: ls broke" },
    ],
  );
  // Agy streams its reply in pieces; a step still open is shown as partial.
  assert.deepEqual(
    headlessTranscript(
      "agy",
      lines([
        {
          event: "step_update",
          step_update: {
            step_index: 1,
            step_type: "agent_response",
            state: "ACTIVE",
            text_delta: "DONE: ",
          },
        },
        {
          event: "step_update",
          step_update: {
            step_index: 1,
            step_type: "agent_response",
            state: "DONE",
            text_delta: "wrote",
          },
        },
        {
          event: "step_update",
          step_update: {
            step_index: 2,
            step_type: "tool",
            state: "DONE",
            tool_name: "view_file",
            tool_info: { parameters: { AbsolutePath: "/w/a.md" } },
          },
        },
        {
          event: "step_update",
          step_update: {
            step_index: 3,
            step_type: "agent_response",
            state: "ACTIVE",
            text_delta: "still",
          },
        },
      ]),
    ),
    [
      { kind: "text", text: "DONE: wrote" },
      { kind: "tool", name: "view_file", text: "/w/a.md" },
      { kind: "text", text: "still", partial: true },
    ],
  );
});

test("nothing is served without the token", async (t) => {
  const box = sandbox(t);
  const { call } = await serve(t, box);
  assert.equal((await call("/", { token: null })).status, 401);
  assert.equal((await call("/api/workers", { token: null })).status, 401);
  assert.equal(
    (await call("/api/workers", { token: "wrong-token-0123456789" })).status,
    401,
  );
  const page = await call("/?token=" + TOKEN, { token: null });
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>oh my teams 작업 현황<\/title>/);
  assert.deepEqual((await call("/api/workers")).json.workers, []);
  await assert.rejects(
    startDashboard({
      stateDir: box.state,
      port: 0,
      host: "127.0.0.1",
      token: "short",
    }),
    /at least 16 characters/,
  );
});

test("a question is shown and answered from the dashboard", async (t) => {
  const box = sandbox(t);
  const { call } = await serve(t, box);
  start(box, "claude", "asker", "ASK first");
  await waitHeadless(box.state, "asker", 15000, { pollMs: 100 });

  const list = (await call("/api/workers")).json.workers;
  assert.equal(list.length, 1);
  assert.equal(list[0].outcome, "question");
  const detail = (await call("/api/workers/asker")).json;
  assert.equal(detail.turns.length, 1);
  assert.match(detail.turns[0].prompt, /ASK first/);
  assert.equal(detail.turns[0].exit.code, 0);

  const answered = await call("/api/workers/asker/answer", {
    method: "POST",
    body: JSON.stringify({ text: "use notes.md" }),
  });
  assert.equal(answered.status, 200);
  assert.equal(answered.json.turn, 2);
  const done = await waitHeadless(box.state, "asker", 15000, { pollMs: 100 });
  assert.equal(done.outcome, "done");
  assert.equal((await call("/api/workers/asker")).json.turns[1].resumed, true);

  // An empty answer and a turn that has not ended are refused with a reason.
  const empty = await call("/api/workers/asker/answer", {
    method: "POST",
    body: "{}",
  });
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /answer is required/);
});

test("a running turn is stopped from the dashboard, and bad requests are refused", async (t) => {
  const box = sandbox(t);
  const { call } = await serve(t, box);
  start(box, "agy", "sleeper", "SLEEP until stopped");
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal((await call("/api/workers/sleeper")).json.liveness, "live");
  const early = await call("/api/workers/sleeper/answer", {
    method: "POST",
    body: JSON.stringify({ text: "hurry" }),
  });
  assert.equal(early.status, 400);
  assert.match(early.json.error, /is live/);

  assert.deepEqual(
    (await call("/api/workers/sleeper/stop", { method: "POST" })).json,
    {
      requested: true,
      turn: 1,
    },
  );
  const stopped = await waitHeadless(box.state, "sleeper", 15000, {
    pollMs: 200,
  });
  assert.equal(stopped.outcome, "stopped");

  assert.equal((await call("/api/workers/Not-Valid")).status, 404);
  assert.equal((await call("/api/workers/missing")).status, 400);
  assert.equal(
    (await call("/api/workers/sleeper", { method: "DELETE" })).status,
    405,
  );
  assert.equal(
    (
      await call("/api/workers/sleeper/answer", {
        method: "POST",
        body: "not json",
      })
    ).status,
    400,
  );
  const large = await call("/api/workers/sleeper/answer", {
    method: "POST",
    body: JSON.stringify({ text: "x".repeat(70 * 1024) }),
  }).catch((error) => ({ status: "closed", error }));
  assert.ok(large.status === 400 || large.status === "closed");
});
