/**
 * Headless supervisor: roles as non-interactive provider processes, no Orca.
 *
 * Each worker is a directory under `<pm-state>/headless/<id>` holding one
 * directory per turn. A turn is run by a detached runner that owns the
 * provider process and records its exit, so liveness, completion, the model
 * and the session to resume are all read from files rather than inferred from
 * a terminal screen. A question ends a turn with a marker; the answer resumes
 * the same provider session as the next turn. The design and the first-step
 * measurements are in docs/plan/headless-runtime.md and
 * experiments/HEADLESS_POC.md.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, readJSON, writeJSON } from "./core.mjs";
import { printTimeout } from "./providers/shared.mjs";
import { addTokenUsage, normalizeTokenUsage } from "./usage.mjs";

const RUNNER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "headless-runner.mjs",
);
const WORKER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MARKER = /^(DONE|QUESTION|FAILED):\s*(.*)$/;

/** Rules appended to every headless instruction; no one watches the process. */
export const HEADLESS_PROTOCOL = [
  "## 비대화형 실행 규약",
  "",
  "- 이 작업은 사람이 지켜보지 않는 비대화형 프로세스로 실행된다. 질문이나 권한을 묻는 대화형 도구(예: ask_question, ask_permission)를 쓰지 않는다. 그런 도구는 응답을 받지 못한 채 제한 시간까지 멈춘다.",
  "- 진행할 수 없는 질문이 생기면 작업을 멈추고, 응답의 마지막 줄을 `QUESTION: <질문>`으로 끝낸다. 답은 같은 세션의 다음 지시로 온다.",
  "- 작업을 마치면 응답의 마지막 줄을 `DONE: <변경 요약과 커밋 SHA>`로, 마칠 수 없으면 `FAILED: <이유>`로 끝낸다.",
  "- 임시 스크립트, 의존성 설치, 내려받은 파일은 작업 워크트리 밖의 임시 디렉터리에서 만든다.",
].join("\n");

const PROVIDERS = {
  claude: {
    command({ binary, model, effort, prompt, session }) {
      const argv = [
        ...binary,
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ];
      if (session) argv.push("--resume", session);
      if (model) argv.push("--model", model);
      if (effort) argv.push("--effort", effort);
      return { argv, stdin: prompt };
    },
    read(events) {
      const init = events.find(
        (event) => event.type === "system" && event.subtype === "init",
      );
      const result = events.findLast((event) => event.type === "result");
      return {
        session: init?.session_id ?? result?.session_id ?? null,
        model: init?.model ?? null,
        text: typeof result?.result === "string" ? result.result : null,
        providerError: result?.is_error ? (result.subtype ?? "error") : null,
        rateLimited: events.some(
          (event) =>
            event.type === "rate_limit_event" &&
            event.rate_limit_info?.status &&
            event.rate_limit_info.status !== "allowed",
        ),
        ...PROVIDERS.claude.usage(events),
      };
    },
    // The result event totals the whole `-p` invocation. Its cost is the
    // API-equivalent estimate Claude prints, not what a subscription is billed.
    usage(events) {
      const result = events.findLast((event) => event.type === "result");
      return {
        usage: normalizeTokenUsage("claude", result?.usage),
        costUsd:
          typeof result?.total_cost_usd === "number"
            ? result.total_cost_usd
            : null,
        numTurns:
          typeof result?.num_turns === "number" ? result.num_turns : null,
      };
    },
  },
  codex: {
    command({ binary, model, effort, prompt, session }) {
      const argv = [...binary, "exec"];
      if (session) argv.push("resume", session);
      argv.push("--json", "--dangerously-bypass-approvals-and-sandbox");
      if (model) argv.push("-m", model);
      if (effort) argv.push("-c", `model_reasoning_effort=${effort}`);
      argv.push(prompt);
      return { argv, stdin: null };
    },
    read(events, { codexHome, lookupModel = true } = {}) {
      const thread = events.find((event) => event.type === "thread.started");
      const messages = events.filter(
        (event) =>
          event.type === "item.completed" &&
          event.item?.type === "agent_message",
      );
      const failure = events.findLast((event) =>
        ["error", "turn.failed"].includes(event.type),
      );
      const session = thread?.thread_id ?? null;
      return {
        session,
        model:
          session && lookupModel ? codexRolloutModel(session, codexHome) : null,
        text: messages.at(-1)?.item?.text ?? null,
        providerError: failure
          ? String(failure.message ?? failure.error?.message ?? failure.type)
          : null,
        rateLimited: /rate.?limit|usage limit|quota/i.test(
          JSON.stringify(failure ?? ""),
        ),
        ...PROVIDERS.codex.usage(events),
      };
    },
    // `codex exec --json` reports usage per model turn, so the turns are summed.
    usage(events) {
      const completed = events.filter(
        (event) => event.type === "turn.completed",
      );
      return {
        usage: completed.reduce(
          (total, event) =>
            addTokenUsage(total, normalizeTokenUsage("codex", event.usage)),
          null,
        ),
        costUsd: null,
        numTurns: completed.length || null,
      };
    },
  },
  agy: {
    command({ binary, model, prompt, session, timeoutMs }) {
      const argv = [
        ...binary,
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
      ];
      if (timeoutMs != null)
        argv.push("--print-timeout", printTimeout(timeoutMs));
      if (session) argv.push("--conversation", session);
      if (model) argv.push("--model", model);
      argv.push("-p", prompt);
      return { argv, stdin: null };
    },
    read(events) {
      const init = events.find((event) => event.event === "init");
      const result = events.findLast((event) => event.event === "result");
      const status = result?.result?.status ?? null;
      return {
        session:
          init?.conversation_id ?? result?.result?.conversation_id ?? null,
        model: init?.init?.model ?? null,
        text:
          typeof result?.result?.response === "string"
            ? result.result.response
            : null,
        // The result's `error` is the server's own explanation; the status is
        // only the word ERROR, which told the reader nothing about the cause.
        providerError:
          status && status !== "SUCCESS"
            ? String(result?.result?.error || status)
            : null,
        // A 503 for missing model capacity asks for a retry later, the same
        // remedy as a rate limit, so it is reported as one.
        rateLimited:
          /RESOURCE_EXHAUSTED|rate.?limit|quota|UNAVAILABLE \(code 503\)|No capacity available/i.test(
            JSON.stringify(result ?? ""),
          ),
        ...PROVIDERS.agy.usage(events),
      };
    },
    // Agy's `--output-format json` puts usage and num_turns at the top level.
    // In stream-json they sit inside the result event's `result`, observed with
    // agy 1.2.4 on Windows, including a run that ended in a 503 after spending
    // input tokens. The event itself is still read for the top-level shape.
    usage(events) {
      const result = events.findLast((event) => event.event === "result");
      const body = result?.result;
      const raw = body?.usage ?? result?.usage ?? null;
      const turns = body?.num_turns ?? result?.num_turns;
      return {
        usage: normalizeTokenUsage("agy", raw),
        costUsd: null,
        numTurns: typeof turns === "number" ? turns : null,
      };
    },
  },
};

/** Providers this runtime can run headless. */
export const HEADLESS_PROVIDERS = Object.freeze(Object.keys(PROVIDERS));

/**
 * Finds the model a Codex session ran on in its rollout record.
 *
 * Codex's JSON stream names no model, but its session rollout records one in
 * `turn_context`.
 *
 * @param {string} threadId - Session id from `thread.started`.
 * @param {string} [codexHome] - Codex home; `$CODEX_HOME` or `~/.codex` by default.
 * @returns {string | null} The last model the rollout recorded, or null.
 */
export function codexRolloutModel(threadId, codexHome) {
  const home =
    codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const root = path.join(home, "sessions");
  if (!fs.existsSync(root)) return null;
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.name.endsWith(`${threadId}.jsonl`)) {
        let model = null;
        for (const line of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
          if (!line.includes('"turn_context"')) continue;
          try {
            model = JSON.parse(line).payload?.model ?? model;
          } catch {
            // A partial last line while Codex is still writing.
          }
        }
        return model;
      }
    }
  }
  return null;
}

/**
 * Builds the argv and stdin of one headless turn for a provider.
 *
 * @param {object} options - Provider, executable argv, model, effort, prompt, session, and timeoutMs.
 * @param {string} options.provider - `claude`, `codex` or `agy`.
 * @param {string[]} options.binary - Executable argv, e.g. `["claude"]`.
 * @param {string | null} [options.model] - Model to request.
 * @param {string | null} [options.effort] - Reasoning effort to request.
 * @param {string} options.prompt - Instruction for this turn.
 * @param {string | null} [options.session] - Session to resume.
 * @param {number | null} [options.timeoutMs] - Per-turn time limit passed as --print-timeout (agy only).
 * @returns {{argv: string[], stdin: string | null}} Command and stdin payload.
 * @throws {Error} When the provider cannot run headless.
 */
export function headlessCommand({ provider, ...options }) {
  const adapter = PROVIDERS[provider];
  assert(adapter, `Provider ${provider} has no headless runtime`);
  return adapter.command(options);
}

/**
 * Parses a provider stream into what the supervisor needs.
 *
 * @param {string} provider - Provider that wrote the stream.
 * @param {string} stream - Raw JSONL output.
 * @param {object} [options] - `codexHome` for Codex model lookup.
 * @returns {object} Session, model, final text, marker, and provider signals.
 */
export function readHeadlessStream(provider, stream, options = {}) {
  const events = [];
  for (const line of String(stream).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Lines that are not JSON (for example a CLI notice) carry no event.
    }
  }
  const read = PROVIDERS[provider].read(events, options);
  const lines = String(read.text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const markerLine = lines.findLast((line) => MARKER.test(line));
  const [, kind, detail] = markerLine ? MARKER.exec(markerLine) : [];
  return {
    ...read,
    eventCount: events.length,
    marker: kind ? { kind: kind.toLowerCase(), detail } : null,
  };
}

const clip = (text, limit) => {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
};

function toolSummary(input) {
  if (!input || typeof input !== "object") return "";
  const preferred =
    input.command ??
    input.CommandLine ??
    input.file_path ??
    input.TargetFile ??
    input.AbsolutePath ??
    input.path ??
    input.description;
  return clip(preferred ?? JSON.stringify(input), 400);
}

const TRANSCRIBE = {
  claude(events) {
    const entries = [];
    for (const event of events) {
      const content = event.message?.content;
      if (event.type === "assistant" && Array.isArray(content)) {
        for (const part of content) {
          if (part.type === "text" && part.text?.trim()) {
            entries.push({ kind: "text", text: part.text });
          } else if (part.type === "tool_use") {
            entries.push({
              kind: "tool",
              name: part.name,
              text: toolSummary(part.input),
            });
          }
        }
      } else if (event.type === "user" && Array.isArray(content)) {
        for (const part of content) {
          if (part.type !== "tool_result") continue;
          const text = Array.isArray(part.content)
            ? part.content.map((item) => item.text ?? "").join("\n")
            : part.content;
          entries.push({
            kind: part.is_error ? "error" : "output",
            text: clip(text, 2000),
          });
        }
      } else if (event.type === "result" && event.is_error) {
        entries.push({
          kind: "error",
          text: String(event.result ?? event.subtype),
        });
      }
    }
    return entries;
  },
  codex(events) {
    const entries = [];
    for (const event of events) {
      const item = event.item;
      if (event.type === "item.completed" && item?.type === "agent_message") {
        entries.push({ kind: "text", text: item.text ?? "" });
      } else if (
        event.type === "item.completed" &&
        item?.type === "command_execution"
      ) {
        entries.push({
          kind: "tool",
          name: "shell",
          text: clip(item.command, 400),
        });
        entries.push({
          kind: item.exit_code === 0 ? "output" : "error",
          text: clip(item.aggregated_output, 2000),
        });
      } else if (["error", "turn.failed"].includes(event.type)) {
        entries.push({
          kind: "error",
          text: String(event.message ?? event.error?.message ?? event.type),
        });
      }
    }
    return entries;
  },
  agy(events) {
    const entries = [];
    const texts = new Map();
    for (const event of events) {
      const step = event.step_update;
      if (step?.step_type === "agent_response" && step.text_delta) {
        texts.set(
          step.step_index,
          (texts.get(step.step_index) ?? "") + step.text_delta,
        );
      }
      if (step?.step_type === "agent_response" && step.state === "DONE") {
        const text = texts.get(step.step_index);
        if (text?.trim()) entries.push({ kind: "text", text });
        texts.delete(step.step_index);
      } else if (step?.step_type === "tool" && step.state === "DONE") {
        entries.push({
          kind: "tool",
          name: step.tool_name,
          text: toolSummary(step.tool_info?.parameters),
        });
      } else if (
        event.event === "result" &&
        event.result?.status !== "SUCCESS"
      ) {
        entries.push({ kind: "error", text: String(event.result?.status) });
      }
    }
    // A turn still running has text that no DONE step closed yet.
    for (const text of texts.values()) {
      if (text.trim()) entries.push({ kind: "text", text, partial: true });
    }
    return entries;
  },
};

/**
 * Turns a provider stream into a readable transcript for people.
 *
 * @param {string} provider - Provider that wrote the stream.
 * @param {string} stream - Raw JSONL output.
 * @param {number} [limit=300] - Most recent entries to keep.
 * @returns {{kind: string, text: string, name?: string}[]} Text, tool, output
 *   and error entries in order.
 */
export function headlessTranscript(provider, stream, limit = 300) {
  const events = [];
  for (const line of String(stream).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Not an event.
    }
  }
  return (TRANSCRIBE[provider]?.(events) ?? []).slice(-limit);
}

/**
 * Compares the model a turn requested with the one its provider reported.
 *
 * @param {string | null} requested - Model the profile asked for.
 * @param {string | null} reported - Model the stream or rollout reported.
 * @returns {string} `matched`, `mismatched`, `alias`, `unrequested` or `unproven`.
 */
export function modelVerdict(requested, reported) {
  if (!requested) return "unrequested";
  if (!reported) return "unproven";
  if (reported === requested) return "matched";
  // An alias such as `sonnet` names a family the reported id belongs to.
  if (
    !/\d/.test(requested) &&
    reported.toLowerCase().includes(requested.toLowerCase())
  ) {
    return "alias";
  }
  return "mismatched";
}

function workerDir(stateDir, workerId) {
  assert(
    WORKER_ID.test(String(workerId)),
    `Invalid headless worker id: ${workerId}`,
  );
  return path.join(path.resolve(stateDir), "headless", workerId);
}

function turnDirs(dir) {
  const turns = path.join(dir, "turns");
  if (!fs.existsSync(turns)) return [];
  return fs
    .readdirSync(turns)
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .sort((a, b) => a - b)
    .map((number) => path.join(turns, String(number)));
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * Decides a turn's liveness from its runner process and its exit record.
 *
 * The runner writes exit.json and only then ends, so the process is observed
 * before exit.json is read. Read the other way round, a turn that recorded
 * its exit and ended between the two reads showed neither a record nor a
 * process, and a cleanly finished worker was reported unverifiable. Callers
 * read the turn's output only after this, so an exit record never pairs with
 * output from before the turn ended.
 *
 * @param {object} reads - How to observe the turn.
 * @param {() => boolean} reads.runnerAlive - Whether the runner process exists now.
 * @param {() => object | null} reads.readExit - The exit record, or null.
 * @returns {{liveness: string, exit: object | null}} `exited`, `live` or
 *   `unverifiable`, with the exit record when there is one.
 */
export function turnLiveness({ runnerAlive, readExit }) {
  const running = runnerAlive();
  const exit = readExit();
  if (exit) return { liveness: "exited", exit };
  return { liveness: running ? "live" : "unverifiable", exit: null };
}

function launchTurn(dir, worker, { prompt, session, timeoutMs }) {
  const number = turnDirs(dir).length + 1;
  const turnDir = path.join(dir, "turns", String(number));
  fs.mkdirSync(turnDir, { recursive: true });
  const resolvedTimeoutMs = timeoutMs ?? worker.timeoutMs;
  const { argv, stdin } = headlessCommand({
    provider: worker.provider,
    binary: worker.binary,
    model: worker.modelRequested,
    effort: worker.effortRequested,
    prompt,
    session,
    timeoutMs: resolvedTimeoutMs,
  });
  fs.writeFileSync(path.join(turnDir, "prompt.txt"), prompt);
  if (stdin !== null) fs.writeFileSync(path.join(turnDir, "stdin.txt"), stdin);
  writeJSON(path.join(turnDir, "turn.json"), {
    number,
    argv,
    stdinFile: stdin === null ? null : "stdin.txt",
    cwd: worker.cwd,
    session: session ?? null,
    timeoutMs: resolvedTimeoutMs,
    startedAt: new Date().toISOString(),
  });
  const runner = spawn(process.execPath, [RUNNER, turnDir], {
    cwd: worker.cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  runner.unref();
  writeJSON(path.join(turnDir, "runner.json"), { pid: runner.pid ?? null });
  return { turn: number, runnerPid: runner.pid ?? null };
}

/**
 * Starts a headless worker and its first turn.
 *
 * @param {object} options - Worker definition.
 * @param {string} options.stateDir - PM worktree state directory.
 * @param {string} options.workerId - Caller-owned id (lowercase, digits, hyphens).
 * @param {string} options.role - Role the worker holds.
 * @param {string} options.profile - Profile id the role resolved to.
 * @param {string} options.provider - Provider of that profile.
 * @param {string[]} options.binary - Executable argv for the provider.
 * @param {string | null} options.model - Requested model.
 * @param {string | null} options.effort - Requested effort.
 * @param {string} options.cwd - Worktree the worker runs in.
 * @param {string} options.prompt - Full instruction, protocol included.
 * @param {number} [options.timeoutMs=1800000] - Per-turn time limit.
 * @returns {object} The worker record and the turn it started.
 * @throws {Error} When the id is taken or the provider cannot run headless.
 */
export function startHeadlessWorker({
  stateDir,
  workerId,
  role,
  profile,
  provider,
  binary,
  model,
  effort,
  cwd,
  prompt,
  timeoutMs = 30 * 60 * 1000,
}) {
  assert(PROVIDERS[provider], `Provider ${provider} has no headless runtime`);
  assert(fs.existsSync(cwd), `Worktree does not exist: ${cwd}`);
  const dir = workerDir(stateDir, workerId);
  assert(!fs.existsSync(dir), `Headless worker already exists: ${workerId}`);
  fs.mkdirSync(dir, { recursive: true });
  const worker = {
    schemaVersion: 1,
    id: workerId,
    role,
    profile,
    provider,
    binary,
    modelRequested: model ?? null,
    effortRequested: effort ?? null,
    cwd: path.resolve(cwd),
    timeoutMs,
    createdAt: new Date().toISOString(),
  };
  writeJSON(path.join(dir, "worker.json"), worker);
  return { worker, ...launchTurn(dir, worker, { prompt }) };
}

function readTurn(worker, turnDir, options) {
  const file = (name) => path.join(turnDir, name);
  const stream = readHeadlessStream(
    worker.provider,
    fs.existsSync(file("stream.jsonl"))
      ? fs.readFileSync(file("stream.jsonl"), "utf8")
      : "",
    options,
  );
  const turn = fs.existsSync(file("turn.json"))
    ? readJSON(file("turn.json"))
    : {};
  const exit = fs.existsSync(file("exit.json"))
    ? readJSON(file("exit.json"))
    : null;
  return {
    number: Number(path.basename(turnDir)),
    startedAt: turn.startedAt ?? null,
    endedAt: exit?.endedAt ?? null,
    exited: Boolean(exit),
    session: stream.session,
    model: stream.model,
    usage: stream.usage,
    costUsd: stream.costUsd,
    numTurns: stream.numTurns,
  };
}

/**
 * Reads what each turn of a headless worker reported, without its text.
 *
 * @param {string} stateDir - PM worktree state directory.
 * @param {string} workerId - Worker to read.
 * @param {object} [options] - `codexHome` for Codex model lookup.
 * @returns {{worker: object, turns: object[]}} The worker record and, per turn,
 *   its times, session, reported model, normalized usage, cost and model turns.
 * @throws {Error} When the worker does not exist.
 */
export function headlessTurns(stateDir, workerId, options = {}) {
  const dir = workerDir(stateDir, workerId);
  assert(fs.existsSync(dir), `No headless worker ${workerId}`);
  const worker = readJSON(path.join(dir, "worker.json"));
  return {
    worker,
    turns: turnDirs(dir).map((turnDir) => readTurn(worker, turnDir, options)),
  };
}

/**
 * Reports a headless worker's state from its files.
 *
 * @param {string} stateDir - PM worktree state directory.
 * @param {string} workerId - Worker to read.
 * @param {object} [options] - `codexHome` for Codex model lookup.
 * @returns {object} Liveness, outcome, marker, session, model verdict, and paths.
 * @throws {Error} When the worker does not exist.
 */
export function headlessStatus(stateDir, workerId, options = {}) {
  const dir = workerDir(stateDir, workerId);
  assert(fs.existsSync(dir), `No headless worker ${workerId}`);
  const worker = readJSON(path.join(dir, "worker.json"));
  const turns = turnDirs(dir);
  const turnDir = turns.at(-1);
  const exitFile = path.join(turnDir, "exit.json");
  const runner = fs.existsSync(path.join(turnDir, "runner.json"))
    ? readJSON(path.join(turnDir, "runner.json")).pid
    : null;
  // Liveness is sampled before the stream is read. The runner writes
  // exit.json only after the provider's output is complete, so an exit record
  // seen here always pairs with a whole stream; read the other way round, a
  // turn that ended between the two reads was exited with the output from
  // before its marker.
  const { liveness, exit } = turnLiveness({
    runnerAlive: () => alive(runner),
    readExit: () => (fs.existsSync(exitFile) ? readJSON(exitFile) : null),
  });
  const streamFile = path.join(turnDir, "stream.jsonl");
  const stream = readHeadlessStream(
    worker.provider,
    fs.existsSync(streamFile) ? fs.readFileSync(streamFile, "utf8") : "",
    options,
  );
  // Resuming needs the session of the latest turn that reported one.
  let session = stream.session;
  for (const earlier of turns.slice(0, -1).reverse()) {
    if (session) break;
    const file = path.join(earlier, "stream.jsonl");
    if (fs.existsSync(file)) {
      session = readHeadlessStream(
        worker.provider,
        fs.readFileSync(file, "utf8"),
        options,
      ).session;
    }
  }
  let outcome = null;
  if (exit) {
    if (exit.stopped) outcome = "stopped";
    else if (exit.timedOut) outcome = "timed-out";
    else if (exit.code !== 0 || stream.providerError) outcome = "exit-error";
    else outcome = stream.marker?.kind ?? "no-marker";
  }
  return {
    worker: worker.id,
    role: worker.role,
    profile: worker.profile,
    provider: worker.provider,
    cwd: worker.cwd,
    turn: turns.length,
    liveness,
    outcome,
    marker: stream.marker,
    exit,
    session,
    modelRequested: worker.modelRequested,
    modelReported: stream.model,
    modelProof: modelVerdict(worker.modelRequested, stream.model),
    providerError: stream.providerError,
    rateLimited: stream.rateLimited,
    ...headlessUsageSummary(worker, turns, options),
    stream: streamFile,
  };
}

// Earlier turns are read only for their usage and session, so the Codex model
// lookup, which walks the rollout directory, is not repeated for each of them.
function headlessUsageSummary(worker, turns, options) {
  const read = turns.map((turnDir) =>
    readTurn(worker, turnDir, { ...options, lookupModel: false }),
  );
  const sessions = [];
  for (const turn of read) {
    if (turn.session && !sessions.includes(turn.session))
      sessions.push(turn.session);
  }
  const measured = read.filter((turn) => turn.usage);
  return {
    sessions,
    usage: read.reduce((total, turn) => addTokenUsage(total, turn.usage), null),
    usageTurns: { measured: measured.length, total: read.length },
  };
}

/**
 * Reports a worker with every turn's prompt, exit and readable transcript.
 *
 * @param {string} stateDir - PM worktree state directory.
 * @param {string} workerId - Worker to read.
 * @param {object} [options] - `codexHome` for Codex model lookup.
 * @returns {object} The worker's status plus its turns, oldest first.
 * @throws {Error} When the worker does not exist.
 */
export function headlessDetail(stateDir, workerId, options = {}) {
  const status = headlessStatus(stateDir, workerId, options);
  const dir = workerDir(stateDir, workerId);
  const read = (file) =>
    fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const turns = turnDirs(dir).map((turnDir) => {
    const turn = fs.existsSync(path.join(turnDir, "turn.json"))
      ? readJSON(path.join(turnDir, "turn.json"))
      : {};
    const exitFile = path.join(turnDir, "exit.json");
    // As in headlessStatus, the exit record is read before the output it ends.
    const exit = fs.existsSync(exitFile) ? readJSON(exitFile) : null;
    const stderr = read(path.join(turnDir, "stderr.txt"));
    return {
      number: turn.number,
      startedAt: turn.startedAt ?? null,
      resumed: Boolean(turn.session),
      prompt: clip(read(path.join(turnDir, "prompt.txt")), 6000),
      exit,
      transcript: headlessTranscript(
        status.provider,
        read(path.join(turnDir, "stream.jsonl")),
      ),
      stderrTail: stderr.length > 2000 ? stderr.slice(-2000) : stderr,
    };
  });
  return { ...status, turns };
}

/**
 * Waits until a worker's current turn is no longer live, or the wait ends.
 *
 * @param {string} stateDir - PM worktree state directory.
 * @param {string} workerId - Worker to wait for.
 * @param {number} waitMs - Longest time to wait.
 * @param {object} [options] - `pollMs` and `codexHome`.
 * @returns {Promise<object>} The status at the end of the wait.
 */
export async function waitHeadless(stateDir, workerId, waitMs, options = {}) {
  const deadline = Date.now() + waitMs;
  const pollMs = options.pollMs ?? 1000;
  let status = headlessStatus(stateDir, workerId, options);
  while (status.liveness === "live" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    status = headlessStatus(stateDir, workerId, options);
  }
  return status;
}

/**
 * Answers a worker's question by resuming its session as the next turn.
 *
 * @param {string} stateDir - PM worktree state directory.
 * @param {string} workerId - Worker whose turn ended.
 * @param {string} text - Answer or follow-up instruction.
 * @param {object} [options] - `timeoutMs` and `codexHome`.
 * @returns {object} The turn started.
 * @throws {Error} When the worker is still running or has no session to resume.
 */
export function answerHeadless(stateDir, workerId, text, options = {}) {
  assert(typeof text === "string" && text.trim(), "An answer is required");
  const status = headlessStatus(stateDir, workerId, options);
  assert(
    status.liveness === "exited",
    `Worker ${workerId} is ${status.liveness}; answer only a turn that ended`,
  );
  assert(status.session, `Worker ${workerId} reported no session to resume`);
  const dir = workerDir(stateDir, workerId);
  const worker = readJSON(path.join(dir, "worker.json"));
  return launchTurn(dir, worker, {
    prompt: `${text.trim()}\n\n${HEADLESS_PROTOCOL}`,
    session: status.session,
    timeoutMs: options.timeoutMs,
  });
}

/**
 * Requests that a worker's running turn stop.
 *
 * @param {string} stateDir - PM worktree state directory.
 * @param {string} workerId - Worker to stop.
 * @returns {{requested: boolean, turn: number}} Whether a request was written.
 */
export function stopHeadless(stateDir, workerId) {
  const dir = workerDir(stateDir, workerId);
  const turnDir = turnDirs(dir).at(-1);
  assert(turnDir, `No headless worker ${workerId}`);
  const requested = !fs.existsSync(path.join(turnDir, "exit.json"));
  if (requested) {
    fs.writeFileSync(
      path.join(turnDir, "stop.request"),
      new Date().toISOString(),
    );
  }
  return { requested, turn: turnDirs(dir).length };
}

/**
 * Lists the headless workers recorded in a state directory.
 *
 * @param {string} stateDir - PM worktree state directory.
 * @param {object} [options] - `codexHome` for Codex model lookup.
 * @returns {object[]} Status of every worker.
 */
export function listHeadless(stateDir, options = {}) {
  const root = path.join(path.resolve(stateDir), "headless");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => WORKER_ID.test(name))
    .sort()
    .map((name) => headlessStatus(stateDir, name, options));
}
