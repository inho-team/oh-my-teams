/**
 * Historical headless record readers and a retired execution guard.
 *
 * This module reads legacy records and may request their recorded process to
 * stop. New workers and follow-up turns are deliberately rejected; Orca role
 * terminals own all current role execution.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, readJSON } from "./core.mjs";
import { addTokenUsage, normalizeTokenUsage } from "./usage.mjs";

const WORKER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MARKER = /^(DONE|QUESTION|FAILED):\s*(.*)$/;

function agyLimitKind(errorText) {
  if (/RESOURCE_EXHAUSTED/.test(errorText)) return "usage-limit";
  if (/UNAVAILABLE \(code 503\)|No capacity available/.test(errorText))
    return "capacity";
  return null;
}

const PROVIDERS = {
  claude: {
    read(events) {
      const init = events.find(
        (event) => event.type === "system" && event.subtype === "init",
      );
      const result = events.findLast((event) => event.type === "result");
      const rateLimited = events.some(
        (event) =>
          event.type === "rate_limit_event" &&
          event.rate_limit_info?.status &&
          event.rate_limit_info.status !== "allowed",
      );
      return {
        session: init?.session_id ?? result?.session_id ?? null,
        model: init?.model ?? null,
        text: typeof result?.result === "string" ? result.result : null,
        providerError: result?.is_error ? (result.subtype ?? "error") : null,
        rateLimited,
        limitKind: rateLimited ? "usage-limit" : null,
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
      const failureText = JSON.stringify(failure ?? "");
      return {
        session,
        model:
          session && lookupModel ? codexRolloutModel(session, codexHome) : null,
        text: messages.at(-1)?.item?.text ?? null,
        providerError: failure
          ? String(failure.message ?? failure.error?.message ?? failure.type)
          : null,
        rateLimited: /rate.?limit|usage limit|quota|at capacity/i.test(
          failureText,
        ),
        // The same sentences the rollout records beside `usage_limit_exceeded`
        // and `server_overloaded`.
        limitKind: /usage limit/i.test(failureText)
          ? "usage-limit"
          : /at capacity/i.test(failureText)
            ? "capacity"
            : null,
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
    read(events) {
      const init = events.find((event) => event.event === "init");
      const result = events.findLast((event) => event.event === "result");
      const status = result?.result?.status ?? null;
      // Only the error of a turn that failed is read: the response is the
      // model's own words, and a worker writing about rate limits in it was
      // once reported as rate limited.
      const errorText =
        status && status !== "SUCCESS"
          ? String(result?.result?.error || status)
          : "";
      const limit = agyLimitKind(errorText);
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
        providerError: errorText || null,
        // A 503 for missing model capacity asks for a retry later, the same
        // remedy as a rate limit, so it is reported as one.
        rateLimited: Boolean(limit) || /rate.?limit|quota/i.test(errorText),
        limitKind: limit,
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

/**
 * Process-lifetime cache: `"${home}:${threadId}"` → model string.
 * Prevents the sessions-tree walk from repeating on every polling call for the
 * same worker. Only populated when the model is known (non-null); a null result
 * is not cached so the next poll can retry once Codex writes `turn_context`.
 * Exported so tests can clear it between assertions.
 *
 * @type {Map<string, string>}
 */
export const _codexRolloutCache = new Map();

/**
 * Finds the model a Codex session ran on in its rollout record.
 *
 * Codex's JSON stream names no model, but its session rollout records one in
 * `turn_context`. Results are memoised for the life of the process so repeated
 * polling calls do not re-scan the sessions tree (F-01).
 *
 * @param {string} threadId - Session id from `thread.started`.
 * @param {string} [codexHome] - Codex home; `$CODEX_HOME` or `~/.codex` by default.
 * @returns {string | null} The last model the rollout recorded, or null.
 */
export function codexRolloutModel(threadId, codexHome) {
  const home =
    codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const cacheKey = `${home}:${threadId}`;
  if (_codexRolloutCache.has(cacheKey)) return _codexRolloutCache.get(cacheKey);
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
        // Only cache when the model is known. If turn_context has not been
        // written yet, model is null; caching null would permanently hide the
        // model once Codex writes it (cache-null-model-stale regression).
        if (model !== null) _codexRolloutCache.set(cacheKey, model);
        return model;
      }
    }
  }
  return null;
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

// Bytes read from the start of the stream to capture session/model events.
const STATUS_HEAD_BYTES = 4 * 1024;
// Bytes read from the end of the stream to capture result/marker events (F-02).
const STATUS_TAIL_BYTES = 64 * 1024;

/**
 * Reads only the head and tail of a stream.jsonl file to extract the fields
 * `headlessStatus` needs: session, model, marker, errors, and usage. For files
 * smaller than HEAD+TAIL bytes the whole file is read. For larger files only
 * the first STATUS_HEAD_BYTES and the last STATUS_TAIL_BYTES are loaded,
 * cutting RSS growth proportional to file size on every polling call (F-02).
 *
 * Session-id and model appear in the first few events; result, marker, usage
 * and provider errors appear in the last events. The middle of the stream
 * (intermediate tool calls) is not needed by the polling path.
 *
 * @param {string} provider - Provider that wrote the stream.
 * @param {string} filePath - Absolute path to the stream.jsonl file.
 * @param {object} [options] - `codexHome` and `lookupModel` forwarded to the provider reader.
 * @returns {object} Same shape as `readHeadlessStream`.
 */
function readHeadlessStreamFile(provider, filePath, options = {}) {
  if (!fs.existsSync(filePath))
    return readHeadlessStream(provider, "", options);
  const stat = fs.statSync(filePath);
  if (stat.size <= STATUS_HEAD_BYTES + STATUS_TAIL_BYTES) {
    return readHeadlessStream(
      provider,
      fs.readFileSync(filePath, "utf8"),
      options,
    );
  }
  // Read head and tail windows; skip the middle of the file.
  const fd = fs.openSync(filePath, "r");
  const headBuf = Buffer.allocUnsafe(STATUS_HEAD_BYTES);
  const headRead = fs.readSync(fd, headBuf, 0, STATUS_HEAD_BYTES, 0);
  const tailBuf = Buffer.allocUnsafe(STATUS_TAIL_BYTES);
  const tailRead = fs.readSync(
    fd,
    tailBuf,
    0,
    STATUS_TAIL_BYTES,
    stat.size - STATUS_TAIL_BYTES,
  );
  fs.closeSync(fd);
  // The head window may end in the middle of a line; drop that partial line so
  // it does not cause a JSON parse error and corrupt a subsequent tail line.
  const headText = headBuf.subarray(0, headRead).toString("utf8");
  const headLastNl = headText.lastIndexOf("\n");
  const safeHead = headLastNl >= 0 ? headText.slice(0, headLastNl + 1) : "";
  // The tail window may start in the middle of a line; drop up to the first \n.
  const tailText = tailBuf.subarray(0, tailRead).toString("utf8");
  const tailFirstNl = tailText.indexOf("\n");
  const safeTail =
    tailFirstNl >= 0 ? tailText.slice(tailFirstNl + 1) : tailText;
  return readHeadlessStream(provider, safeHead + safeTail, options);
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

import { StringDecoder } from "node:string_decoder";

/**
 * Turns a provider stream file into a readable transcript for people.
 * Reads the file synchronously in chunks to avoid OOM on large transcripts.
 *
 * @param {string} provider - Provider that wrote the stream.
 * @param {string} filePath - Absolute path to stream.jsonl.
 * @param {number} [limit=300] - Most recent entries to keep.
 * @returns {{kind: string, text: string, name?: string}[]}
 */
export function headlessTranscriptFile(provider, filePath, limit = 300) {
  const CHUNK = 65536;
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return [];
  }
  const buf = Buffer.allocUnsafe(CHUNK);
  const decoder = new StringDecoder("utf8");
  let tail = "";
  let bytesRead;
  const events = [];
  try {
    do {
      bytesRead = fs.readSync(fd, buf, 0, CHUNK, null);
      tail += decoder.write(buf.subarray(0, bytesRead));
      let start = 0;
      let pos;
      while ((pos = tail.indexOf("\n", start)) !== -1) {
        const line = tail.slice(start, pos).trim();
        start = pos + 1;
        if (!line) continue;
        try {
          events.push(JSON.parse(line));
        } catch {}
      }
      tail = tail.slice(start);
    } while (bytesRead > 0);
    const line = tail.trim();
    if (line) {
      try {
        events.push(JSON.parse(line));
      } catch {}
    }
  } finally {
    fs.closeSync(fd);
  }
  return (TRANSCRIBE[provider]?.(events) ?? []).slice(-limit);
}

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

// An explicit runner always executes the Codex CLI against the OpenCodex proxy,
// whichever provider the profile is logically for, so its stream is a Codex
// stream. Reading it with the profile's provider would misparse it.
const streamProvider = (worker) => (worker.runner ? "codex" : worker.provider);

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

/**
 * Refuses to start a new headless worker.
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
 * @param {object | null} [options.runner] - Secret-free explicit runner metadata.
 * @returns {never} This function always throws.
 * @throws {Error} Always, because new headless execution is retired.
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
  runner = null,
}) {
  throw new Error(
    "New headless execution was removed; read legacy records or start an Orca role terminal",
  );
}

function readTurn(worker, turnDir, options) {
  const file = (name) => path.join(turnDir, name);
  const stream = readHeadlessStreamFile(
    streamProvider(worker),
    file("stream.jsonl"),
    options,
  );
  const turn = fs.existsSync(file("turn.json"))
    ? readJSON(file("turn.json"))
    : {};
  const exit = fs.existsSync(file("exit.json"))
    ? readJSON(file("exit.json"))
    : null;
  const observationFile = file("opencodex.json");
  const observation = fs.existsSync(observationFile)
    ? readJSON(observationFile)
    : null;
  return {
    number: Number(path.basename(turnDir)),
    startedAt: turn.startedAt ?? null,
    endedAt: exit?.endedAt ?? null,
    exited: Boolean(exit),
    session: stream.session,
    model: observation?.model ?? stream.model,
    usage: stream.usage ?? observation?.usage ?? null,
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
 * Decides whether an explicit-runner turn proved every lifecycle stage.
 *
 * A zero exit code and a completion marker are not proof: the turn also needs
 * an observed upstream request set, and a lifecycle record that names that same
 * set and shows input, start, completion, exit and process-tree termination.
 * Anything absent or unequal is unverifiable, never success.
 *
 * @param {object | null} observation - The turn's `opencodex.json`, or null when it was not written.
 * @param {object | null} lifecycle - The turn's `lifecycle.json`, or null when it was not written.
 * @returns {boolean} True only when every stage is proven and correlated to the observed requests.
 */
export function runnerTurnProven(observation, lifecycle) {
  if (!observation || !lifecycle) return false;
  const observed = observation.requestIds;
  const recorded = lifecycle.requestIds;
  return (
    Array.isArray(observed) &&
    observed.length > 0 &&
    Array.isArray(recorded) &&
    recorded.length === observed.length &&
    observed.every((id) => recorded.includes(id)) &&
    lifecycle.inputAccepted === true &&
    lifecycle.turnStarted === true &&
    lifecycle.upstreamRequestStarted === true &&
    lifecycle.completed === true &&
    lifecycle.exitObserved === true &&
    lifecycle.descendantsExited === true &&
    lifecycle.proxyExited === true &&
    lifecycle.termination === "exited"
  );
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
  const stream = readHeadlessStreamFile(
    streamProvider(worker),
    streamFile,
    options,
  );
  const observationFile = path.join(turnDir, "opencodex.json");
  const observation = fs.existsSync(observationFile)
    ? readJSON(observationFile)
    : null;
  const lifecycleFile = path.join(turnDir, "lifecycle.json");
  const lifecycle = fs.existsSync(lifecycleFile)
    ? readJSON(lifecycleFile)
    : null;
  const turn = fs.existsSync(path.join(turnDir, "turn.json"))
    ? readJSON(path.join(turnDir, "turn.json"))
    : {};
  // Resuming needs the session of the latest turn that reported one.
  let session = stream.session;
  for (const earlier of turns.slice(0, -1).reverse()) {
    if (session) break;
    const file = path.join(earlier, "stream.jsonl");
    session = readHeadlessStreamFile(
      streamProvider(worker),
      file,
      options,
    ).session;
  }
  let outcome = null;
  if (exit) {
    if (exit.stopped) outcome = "stopped";
    else if (exit.timedOut) outcome = "timed-out";
    else if (exit.code !== 0 || exit.error || stream.providerError)
      // A failed turn the provider ended on a limit needs a different remedy
      // from a crash; a successful turn that merely mentions one does not.
      outcome = stream.rateLimited ? "rate-limited" : "exit-error";
    else if (turn.runner && !runnerTurnProven(observation, lifecycle))
      outcome = "unverifiable";
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
    lifecycle,
    session,
    modelRequested: worker.modelRequested,
    modelReported: observation?.model ?? stream.model,
    modelProof: modelVerdict(
      worker.modelRequested,
      observation?.model ?? stream.model,
    ),
    providerError: stream.providerError,
    rateLimited: stream.rateLimited,
    limitKind: stream.limitKind ?? null,
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
      transcript: headlessTranscriptFile(
        turn.runner ? "codex" : status.provider,
        path.join(turnDir, "stream.jsonl"),
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
 * Refuses a new headless follow-up turn.
 *
 * @param {string} stateDir - PM worktree state directory.
 * @param {string} workerId - Worker whose turn ended.
 * @param {string} text - Answer or follow-up instruction.
 * @param {object} [options] - `timeoutMs` and `codexHome`.
 * @returns {never} This function always throws.
 * @throws {Error} Always, because new headless execution is retired.
 */
export function answerHeadless(stateDir, workerId, text, options = {}) {
  throw new Error(
    "Headless follow-up turns were removed; preserve the legacy record and use an Orca role terminal",
  );
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
