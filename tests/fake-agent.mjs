#!/usr/bin/env node
/**
 * A stand-in provider CLI for headless runtime tests.
 *
 * Run as `node fake-agent.mjs <claude|codex|agy> <provider argv...>`, it reads
 * the prompt and the session to resume the way each real CLI does, and writes
 * that provider's JSON event shapes. The prompt steers it: `ASK` ends with a
 * question, `SLEEP` runs until it is stopped, `CRASH` exits non-zero, and a
 * resumed session answers with the first line it was given. With
 * `FAKE_CODEX_HOME` set, the Codex mode also writes a session rollout.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [provider, ...args] = process.argv.slice(2);
const MODEL = {
  claude: "claude-sonnet-5",
  codex: "gpt-fake",
  agy: "gemini-fake",
};

function after(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

function modelArg() {
  return after("--model") ?? after("-m");
}

let session;
let prompt;
if (provider === "claude") {
  session = after("--resume");
  prompt = fs.readFileSync(0, "utf8");
} else if (provider === "codex") {
  session = args[1] === "resume" ? args[2] : null;
  prompt = args.at(-1);
} else {
  session = after("--conversation");
  prompt = after("-p");
}
const id = session ?? crypto.randomUUID();
const model = modelArg() ?? MODEL[provider];

let reply;
if (session)
  reply = `resumed: ${prompt.split("\n")[0]}\nDONE: finished after answer`;
else if (prompt.includes("ASK"))
  reply = "I need a decision.\nQUESTION: which file name?";
else reply = "work complete\nDONE: wrote the file";

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (provider === "claude") {
  emit({ type: "system", subtype: "init", session_id: id, model });
} else if (provider === "codex") {
  emit({ type: "thread.started", thread_id: id });
  const home = process.env.FAKE_CODEX_HOME;
  if (home) {
    const dir = path.join(home, "sessions", "2026", "09", "17");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, `rollout-2026-09-17T00-00-00-${id}.jsonl`),
      `${JSON.stringify({ type: "turn_context", payload: { model } })}\n`,
    );
  }
} else {
  emit({ event: "init", conversation_id: id, init: { model } });
}

if (prompt.includes("CRASH")) process.exit(3);
if (prompt.includes("SLEEP")) {
  setInterval(() => {}, 1000);
} else if (provider === "claude") {
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: id,
    result: reply,
  });
} else if (provider === "codex") {
  emit({
    type: "item.completed",
    item: { type: "agent_message", text: reply },
  });
  emit({ type: "turn.completed", usage: {} });
} else {
  emit({
    event: "result",
    result: { conversation_id: id, status: "SUCCESS", response: reply },
  });
}
