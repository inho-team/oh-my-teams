/**
 * Historical headless record readers.
 *
 * This module reads legacy records. Orca role terminals own current execution.
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
 * the historical usage collector needs: session, model, and usage. For files
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
