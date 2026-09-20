/**
 * Read-only collectors of per-session model usage from the stores each
 * provider already writes: Claude transcripts, Codex rollouts, the Agy
 * conversation summary database, headless worker streams and harness reports.
 *
 * Only usage counters, model ids, working directories, timestamps, session ids
 * and step counts are read out of those stores. Message text, titles and
 * previews are never copied into a record, so a usage report can be shared
 * without leaking what a role was asked or answered. Every collector takes its
 * store location explicitly; defaults are resolved once by `usageHomes`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { readJSON } from "./core.mjs";
import { headlessTurns } from "./headless.mjs";
import { addTokenUsage, normalizeTokenUsage, TOKEN_FIELDS } from "./usage.mjs";

/** Columns read from Agy's `conversation_summaries` table, and no others. */
export const AGY_SUMMARY_COLUMNS = Object.freeze([
  "conversation_id",
  "workspace_uris",
  "step_count",
  "last_modified_time",
  "last_user_input_time",
]);

const HEADLESS_WORKER = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CONVERSATION_ID = /^[A-Za-z0-9-]{1,128}$/;

/**
 * Resolves where each provider keeps its session store.
 *
 * @param {object} [options] - Explicit `claudeHome`, `codexHome`, `agyHome`.
 * @param {object} [env=process.env] - Environment consulted for defaults.
 * @returns {{claudeHome: string, codexHome: string, agyHome: string}} Absolute
 *   directories; an explicit option wins over the environment and the home.
 */
export function usageHomes(options = {}, env = process.env) {
  const home = os.homedir();
  return {
    claudeHome: path.resolve(
      options.claudeHome ?? env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"),
    ),
    codexHome: path.resolve(
      options.codexHome ?? env.CODEX_HOME ?? path.join(home, ".codex"),
    ),
    agyHome: path.resolve(
      options.agyHome ??
        env.OMT_AGY_HOME ??
        path.join(home, ".gemini", "antigravity-cli"),
    ),
  };
}

/**
 * Tells whether a directory is a place or lies below it.
 *
 * The comparison stops at a separator, so `kickoff-a` does not contain
 * `kickoff-a-2`, and on Windows it ignores case and separator spelling, since
 * the same checkout is reported as `C:\x` by one CLI and `c:/x` by another.
 *
 * @param {string} child - Directory to test.
 * @param {string} parent - Place directory.
 * @param {string} [platform=process.platform] - Path rules to apply.
 * @returns {boolean} Whether `child` is `parent` or inside it.
 */
export function pathWithin(child, parent, platform = process.platform) {
  if (typeof child !== "string" || typeof parent !== "string") return false;
  if (!child || !parent) return false;
  const windows = platform === "win32";
  const lib = windows ? path.win32 : path.posix;
  const normal = (value) => {
    let result = lib.normalize(windows ? value.replace(/\//g, "\\") : value);
    result = result.replace(/[\\/]+$/, "");
    return windows ? result.toLowerCase() : result;
  };
  const inner = normal(child);
  const outer = normal(parent);
  return inner === outer || inner.startsWith(`${outer}${lib.sep}`);
}

/**
 * Spells a directory the way Claude Code names its project folder.
 *
 * @param {string} directory - Working directory of a session.
 * @returns {string} Every character other than a letter or digit replaced by `-`.
 */
export function encodeClaudeProject(directory) {
  return String(directory).replace(/[^A-Za-z0-9]/g, "-");
}

function toMs(value) {
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

function windowOf(window) {
  return {
    from: toMs(window?.from) ?? Number.NEGATIVE_INFINITY,
    to: toMs(window?.to) ?? Number.POSITIVE_INFINITY,
  };
}

function withinAny(directory, places, platform) {
  return places.some((place) => pathWithin(directory, place, platform));
}

/**
 * Builds a session record with every field present and unknowns left null.
 *
 * @param {object} fields - Values known for this session.
 * @returns {object} Normalized record shared by every collector.
 */
export function sessionRecord(fields) {
  const record = {
    kickoff: null,
    role: null,
    source: null,
    provider: null,
    profile: null,
    sessionKey: null,
    cwd: null,
    firstAt: null,
    lastAt: null,
    modelRequested: null,
    modelReported: [],
    modelVerdict: null,
    turns: null,
    calls: null,
    steps: null,
    costUsd: null,
    measured: false,
    reason: null,
    attribution: null,
    clippedEntries: 0,
  };
  for (const field of TOKEN_FIELDS) record[field] = null;
  const { usage, ...rest } = fields;
  Object.assign(record, rest);
  if (usage) for (const field of TOKEN_FIELDS) record[field] = usage[field];
  return record;
}

function measuredState(withUsage, total) {
  if (total === 0 || withUsage === 0) return false;
  return withUsage === total ? true : "partial";
}

function listFiles(directory, accept) {
  const found = [];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (accept(entry.name)) found.push(full);
    }
  }
  return found;
}

function modifiedSince(file, from) {
  try {
    return fs.statSync(file).mtimeMs >= from;
  } catch {
    return false;
  }
}

// Reads the file in fixed-size chunks and processes one line at a time, so
// only two chunks are held in memory at once regardless of file size. A
// visitor that returns `false` stops reading the file immediately.
// StringDecoder is used so multi-byte characters spanning chunk boundaries
// are never split.
function eachJsonLine(file, visit) {
  const CHUNK = 65536; // 64 KiB
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return;
  }
  const buf = Buffer.allocUnsafe(CHUNK);
  const decoder = new StringDecoder("utf8");
  let tail = "";
  let index = 0;
  let stopped = false;
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buf, 0, CHUNK, null);
      tail += decoder.write(buf.subarray(0, bytesRead));
      let start = 0;
      let pos;
      while ((pos = tail.indexOf("\n", start)) !== -1) {
        const line = tail.slice(start, pos).replace(/\r$/, "");
        start = pos + 1;
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          // A partial last line while the provider is still writing.
          continue;
        }
        if (visit(entry, index) === false) {
          stopped = true;
          break;
        }
        index += 1;
      }
      tail = stopped ? "" : tail.slice(start);
    } while (bytesRead === CHUNK && !stopped);
    // Flush any incomplete multi-byte sequence held by the decoder, then
    // process any remaining text without a trailing newline (partial last line).
    if (!stopped) {
      tail += decoder.end();
      if (tail.trim()) {
        try {
          visit(JSON.parse(tail), index);
        } catch {
          // Partial last line while the provider is still writing — ignore.
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function claudeProjectFiles(root, places) {
  const prefixes = places.map((place) =>
    encodeClaudeProject(place).toLowerCase(),
  );
  const files = [];
  for (const name of fs.readdirSync(root)) {
    // The folder name is only a prefilter; the entries' own cwd decides.
    if (!prefixes.some((prefix) => name.toLowerCase().startsWith(prefix)))
      continue;
    const dir = path.join(root, name);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(path.join(dir, entry.name));
      } else if (entry.isDirectory()) {
        const subagents = path.join(dir, entry.name, "subagents");
        if (!fs.existsSync(subagents)) continue;
        for (const file of fs.readdirSync(subagents)) {
          if (file.endsWith(".jsonl")) files.push(path.join(subagents, file));
        }
      }
    }
  }
  return files;
}

function claudeSession(sessions, key) {
  let session = sessions.get(key);
  if (!session) {
    session = {
      cwd: null,
      cwdFromSubagent: false,
      firstAt: null,
      lastAt: null,
      turns: 0,
      messages: new Map(),
      models: new Set(),
      subagentModels: new Set(),
    };
    sessions.set(key, session);
  }
  return session;
}

function readClaudeEntry(entry, sessions, clipped, places, range, platform) {
  if (entry?.type !== "assistant" && entry?.type !== "user") return;
  if (typeof entry.sessionId !== "string" || typeof entry.cwd !== "string")
    return;
  if (!withinAny(entry.cwd, places, platform)) return;
  const at = toMs(entry.timestamp);
  if (at === null) return;
  if (at < range.from || at > range.to) {
    clipped.set(entry.sessionId, (clipped.get(entry.sessionId) ?? 0) + 1);
    return;
  }
  const session = claudeSession(sessions, entry.sessionId);
  // The main conversation names the session's directory; a subagent's entry
  // stands in only until the main conversation has one inside the window.
  if (session.cwd === null || (session.cwdFromSubagent && !entry.isSidechain)) {
    session.cwd = entry.cwd;
    session.cwdFromSubagent = Boolean(entry.isSidechain);
  }
  session.firstAt = Math.min(session.firstAt ?? at, at);
  session.lastAt = Math.max(session.lastAt ?? at, at);
  if (entry.type === "user") {
    // A tool result, an injected meta message and a subagent's own prompt are
    // all user entries, but none of them is an instruction someone typed.
    if (!("toolUseResult" in entry) && !entry.isMeta && !entry.isSidechain)
      session.turns += 1;
    return;
  }
  const message = entry.message;
  if (!message?.id || message.model === "<synthetic>") return;
  (entry.isSidechain ? session.subagentModels : session.models).add(
    message.model,
  );
  // Claude writes one entry per content block of a response, each repeating
  // the response's usage, so a response is counted once by its id.
  const usage = normalizeTokenUsage("claude", message.usage);
  const known = session.messages.get(message.id);
  if (!known || (usage?.outputTokens ?? 0) >= (known?.outputTokens ?? 0)) {
    session.messages.set(message.id, usage);
  }
}

/**
 * Collects Claude Code sessions that ran in the given places during a window.
 *
 * @param {object} options - Collection options.
 * @param {string} options.claudeHome - Claude configuration directory.
 * @param {string[]} options.places - Directories whose sessions are wanted.
 * @param {object} [options.window] - `from` and `to` as ISO text or epoch ms.
 * @param {string} [options.platform] - Path rules for comparing directories.
 * @returns {{source: string, records: object[], unavailable: string | null}}
 *   One record per session; responses outside the window are clipped.
 */
export function collectClaudeTranscripts({
  claudeHome,
  places,
  window,
  platform = process.platform,
}) {
  const source = "claude-transcript";
  const root = path.join(claudeHome, "projects");
  if (!fs.existsSync(root)) {
    return { source, records: [], unavailable: "claude-projects-missing" };
  }
  const range = windowOf(window);
  const wanted = places.filter(Boolean);
  const sessions = new Map();
  const clipped = new Map();
  for (const file of claudeProjectFiles(root, wanted)) {
    if (!modifiedSince(file, range.from)) continue;
    eachJsonLine(file, (entry) => {
      readClaudeEntry(entry, sessions, clipped, wanted, range, platform);
    });
  }
  const records = [...sessions].map(([key, session]) => {
    const usages = [...session.messages.values()];
    const withUsage = usages.filter(Boolean).length;
    const measured = measuredState(withUsage, usages.length);
    return sessionRecord({
      source,
      provider: "claude",
      sessionKey: key,
      cwd: session.cwd,
      firstAt: iso(session.firstAt),
      lastAt: iso(session.lastAt),
      modelReported: [...session.models],
      subagentModels: [...session.subagentModels],
      turns: session.turns,
      calls: usages.length,
      usage: usages.reduce(addTokenUsage, null),
      measured,
      reason:
        measured === false
          ? usages.length
            ? "claude-transcript-without-usage"
            : "no-model-response-in-window"
          : null,
      clippedEntries: clipped.get(key) ?? 0,
    });
  });
  return { source, records, unavailable: null };
}

function subtractUsage(after, before) {
  if (!after) return null;
  const result = {};
  for (const field of TOKEN_FIELDS) {
    const later = after[field];
    const earlier = before?.[field] ?? 0;
    result[field] = later === null ? null : Math.max(0, later - earlier);
  }
  return result;
}

function sameUsage(a, b) {
  return TOKEN_FIELDS.every((field) => (a?.[field] ?? null) === b?.[field]);
}

function readCodexLine(line, state, range) {
  const at = toMs(line.timestamp);
  if (at === null) return;
  const payload = line.payload ?? {};
  if (at < range.from || at > range.to) {
    state.clipped += 1;
    if (at > range.to) return;
    if (line.type === "turn_context" && payload.model)
      state.modelBefore = payload.model;
    if (payload.type === "token_count") {
      state.before =
        normalizeTokenUsage("codex", payload.info?.total_token_usage) ??
        state.before;
    }
    return;
  }
  state.firstAt ??= at;
  state.lastAt = at;
  if (line.type === "turn_context" && payload.model)
    state.models.add(payload.model);
  if (line.type !== "event_msg") return;
  if (payload.type === "task_started") state.turns += 1;
  if (payload.type !== "token_count") return;
  // The rollout records a running session total, so usage is the last total
  // in the window minus the last one before it, never a sum of the totals.
  const total = normalizeTokenUsage("codex", payload.info?.total_token_usage);
  if (!total) return;
  if (!sameUsage(total, state.last ?? state.before)) state.calls += 1;
  state.last = total;
}

function readCodexRollout(file, places, range, platform) {
  let meta = null;
  const state = {
    before: null,
    last: null,
    calls: 0,
    turns: 0,
    models: new Set(),
    modelBefore: null,
    firstAt: null,
    lastAt: null,
    clipped: 0,
  };
  eachJsonLine(file, (line, index) => {
    if (index === 0) {
      // The first line names the session and its directory, so a rollout
      // from another place is not read past it.
      meta = line.type === "session_meta" ? line.payload : null;
      if (!meta || !withinAny(meta.cwd, places, platform)) return false;
    }
    readCodexLine(line, state, range);
    return true;
  });
  if (!meta || !withinAny(meta.cwd, places, platform)) return null;
  if (state.firstAt === null) return null;
  const models = state.models.size
    ? [...state.models]
    : [state.modelBefore].filter(Boolean);
  return sessionRecord({
    source: "codex-rollout",
    provider: "codex",
    sessionKey: meta.id ?? meta.session_id ?? path.basename(file, ".jsonl"),
    cwd: meta.cwd,
    firstAt: iso(state.firstAt),
    lastAt: iso(state.lastAt),
    modelReported: models,
    turns: state.turns,
    calls: state.last ? state.calls : null,
    usage: subtractUsage(state.last, state.before),
    measured: Boolean(state.last),
    reason: state.last ? null : "codex-rollout-without-token-count",
    clippedEntries: state.clipped,
  });
}

/**
 * Collects Codex sessions that ran in the given places during a window.
 *
 * Rollouts are found by modification time, not by the dated folder, because a
 * resumed session keeps appending to the file created on its first day.
 *
 * @param {object} options - Collection options.
 * @param {string} options.codexHome - Codex home directory.
 * @param {string[]} options.places - Directories whose sessions are wanted.
 * @param {object} [options.window] - `from` and `to` as ISO text or epoch ms.
 * @param {string} [options.platform] - Path rules for comparing directories.
 * @returns {{source: string, records: object[], unavailable: string | null}}
 *   One record per rollout that has events inside the window.
 */
export function collectCodexRollouts({
  codexHome,
  places,
  window,
  platform = process.platform,
}) {
  const source = "codex-rollout";
  const roots = ["sessions", "archived_sessions"]
    .map((name) => path.join(codexHome, name))
    .filter((root) => fs.existsSync(root));
  if (!roots.length) {
    return { source, records: [], unavailable: "codex-sessions-missing" };
  }
  const range = windowOf(window);
  const wanted = places.filter(Boolean);
  const records = roots
    .flatMap((root) =>
      listFiles(
        root,
        (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
      ),
    )
    .filter((file) => modifiedSince(file, range.from))
    .map((file) => readCodexRollout(file, wanted, range, platform))
    .filter(Boolean);
  return { source, records, unavailable: null };
}

function fileUriPath(uri) {
  const text = String(uri);
  if (!text.startsWith("file://")) return null;
  let rest;
  try {
    rest = decodeURIComponent(text.slice("file://".length));
  } catch {
    return null;
  }
  // `file:///c:/x` names a Windows drive; `file:///x` a POSIX root.
  const drive = /^\/?([A-Za-z]:)(\/.*)?$/.exec(rest);
  if (drive) return `${drive[1]}${(drive[2] ?? "/").replace(/\//g, "\\")}`;
  return rest.startsWith("/") ? rest : `/${rest}`;
}

function workspaceUris(value) {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [value];
  }
}

// Agy writes `2026-09-16 09:01:22.8588579+00:00`: a space for the `T` and
// seven fraction digits, which Date.parse does not accept as written.
function agyTime(value) {
  if (typeof value !== "string") return null;
  return toMs(value.replace(" ", "T").replace(/(\.\d{3})\d+/, "$1"));
}

// The summary table records when a conversation last changed but not when it
// began. The conversation's own file is only stat-ed, never opened, and its
// creation time stands in for the start.
function conversationStart(agyHome, id) {
  if (!CONVERSATION_ID.test(id)) return null;
  try {
    const stat = fs.statSync(path.join(agyHome, "conversations", `${id}.db`));
    return stat.birthtimeMs > 0 ? stat.birthtimeMs : null;
  } catch {
    return null;
  }
}

async function readAgyRows(file) {
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    return { unavailable: "node-sqlite-unavailable" };
  }
  let db;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT ${AGY_SUMMARY_COLUMNS.join(", ")} FROM conversation_summaries`,
      )
      .all();
    return { rows };
  } catch {
    return { unavailable: "agy-summary-db-unreadable" };
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a database that failed to open has nothing to release.
    }
  }
}

/**
 * Collects Agy conversations that ran in the given places during a window.
 *
 * Agy records no token usage for interactive conversations anywhere readable,
 * so every record is unmeasured; the step count is kept as the only indicator
 * of how much a conversation did.
 *
 * @param {object} options - Collection options.
 * @param {string} options.agyHome - Agy CLI data directory.
 * @param {string[]} options.places - Directories whose conversations are wanted.
 * @param {object} [options.window] - `from` and `to` as ISO text or epoch ms.
 * @param {string} [options.platform] - Path rules for comparing directories.
 * @returns {Promise<{source: string, records: object[], unavailable: string | null}>}
 *   One unmeasured record per conversation, or the reason none could be read.
 */
export async function collectAgyConversations({
  agyHome,
  places,
  window,
  platform = process.platform,
}) {
  const source = "agy-summary";
  const file = path.join(agyHome, "conversation_summaries.db");
  if (!fs.existsSync(file)) {
    return { source, records: [], unavailable: "agy-summary-db-missing" };
  }
  const { rows, unavailable } = await readAgyRows(file);
  if (unavailable) return { source, records: [], unavailable };
  const range = windowOf(window);
  const wanted = places.filter(Boolean);
  const records = [];
  for (const row of rows) {
    const cwd = workspaceUris(row.workspace_uris)
      .map(fileUriPath)
      .find((directory) => directory && withinAny(directory, wanted, platform));
    if (!cwd || typeof row.conversation_id !== "string") continue;
    const lastAt = agyTime(row.last_modified_time);
    const started = conversationStart(agyHome, row.conversation_id);
    const firstAt = started ?? agyTime(row.last_user_input_time) ?? lastAt;
    if (lastAt === null || lastAt < range.from || firstAt > range.to) continue;
    records.push(
      sessionRecord({
        source,
        provider: "agy",
        sessionKey: row.conversation_id,
        cwd,
        firstAt: iso(firstAt),
        firstAtSource:
          started === null ? "last-user-input" : "conversation-file",
        lastAt: iso(lastAt),
        steps: Number.isInteger(row.step_count) ? row.step_count : null,
        measured: false,
        reason: "agy-interactive-usage-not-recorded",
      }),
    );
  }
  return { source, records, unavailable: null };
}

function sumCosts(values) {
  const known = values.filter((value) => typeof value === "number");
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

/**
 * Collects headless workers recorded in a PM state directory.
 *
 * @param {string} stateDir - PM worktree state directory.
 * @param {object} [options] - `codexHome` for Codex model lookup and `window`.
 * @returns {{source: string, records: object[], unavailable: string | null}}
 *   One record per worker with turns started inside the window.
 */
export function collectHeadless(stateDir, { codexHome, window } = {}) {
  const source = "headless";
  const root = path.join(path.resolve(stateDir), "headless");
  if (!fs.existsSync(root)) return { source, records: [], unavailable: null };
  const range = windowOf(window);
  const records = [];
  for (const name of fs.readdirSync(root).sort()) {
    if (!HEADLESS_WORKER.test(name)) continue;
    let read;
    try {
      read = headlessTurns(stateDir, name, { codexHome });
    } catch {
      continue;
    }
    const { worker } = read;
    const turns = read.turns.filter((turn) => {
      const at = toMs(turn.startedAt);
      return at === null || (at >= range.from && at <= range.to);
    });
    if (!turns.length) continue;
    const sessions = [...new Set(turns.map((turn) => turn.session))].filter(
      Boolean,
    );
    const exited = turns.filter((turn) => turn.exited);
    const withUsage = turns.filter((turn) => turn.usage).length;
    const measured = measuredState(withUsage, turns.length);
    const numTurns = turns.map((turn) => turn.numTurns).filter(Number.isFinite);
    let reason = null;
    if (exited.length < turns.length) reason = "headless-turn-running";
    else if (measured !== true) reason = "headless-stream-without-usage";
    records.push(
      sessionRecord({
        source,
        role: worker.role,
        provider: worker.provider,
        profile: worker.profile,
        sessionKey: sessions[0] ?? `headless:${worker.id}`,
        sessionKeys: sessions,
        workerId: worker.id,
        cwd: worker.cwd,
        firstAt: turns[0].startedAt,
        lastAt: turns.at(-1).endedAt ?? turns.at(-1).startedAt,
        modelRequested: worker.modelRequested,
        modelReported: [
          ...new Set(turns.map((turn) => turn.model).filter(Boolean)),
        ],
        turns: turns.length,
        calls: numTurns.length ? numTurns.reduce((a, b) => a + b, 0) : null,
        usage: turns.reduce(
          (total, turn) => addTokenUsage(total, turn.usage),
          null,
        ),
        costUsd: sumCosts(turns.map((turn) => turn.costUsd)),
        measured,
        reason,
        attribution: { method: "declared", workerId: worker.id },
      }),
    );
  }
  return { source, records, unavailable: null };
}

function harnessRecord({ role, provider, profile, call, key, at }) {
  const usage = normalizeTokenUsage(provider, call.usage);
  return sessionRecord({
    source: "harness",
    role,
    provider,
    profile,
    sessionKey: call.sessionId ?? key,
    firstAt: iso(at),
    lastAt: iso(at),
    modelRequested: call.requestedModel ?? null,
    modelReported: call.effectiveModel ? [call.effectiveModel] : [],
    turns: 1,
    calls: 1,
    usage,
    costUsd: typeof call.costUsd === "number" ? call.costUsd : null,
    measured: Boolean(usage),
    reason: usage ? null : "harness-call-without-usage",
    attribution: { method: "declared" },
  });
}

function reportsIn(directory, pick) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .map((entry) => pick(directory, entry))
    .filter(Boolean);
}

/**
 * Collects the provider calls the local harness recorded in a state directory.
 *
 * Only each call's role, profile, provider, models, session id, usage and cost
 * are read; a report's summaries and findings are not.
 *
 * @param {string} stateDir - PM worktree state directory.
 * @param {object} [options] - `window`, and `org` to name an assist's provider.
 * @returns {{source: string, records: object[], unavailable: string | null}}
 *   One record per provider call whose report was written inside the window.
 */
export function collectHarnessReports(stateDir, { window, org } = {}) {
  const source = "harness";
  const range = windowOf(window);
  const state = path.resolve(stateDir);
  const records = [];
  const readReport = (file) => {
    try {
      const at = fs.statSync(file).mtimeMs;
      if (at < range.from || at > range.to) return null;
      return { report: readJSON(file), at };
    } catch {
      return null;
    }
  };
  const runs = reportsIn(path.join(state, "runs"), (dir, entry) =>
    entry.isDirectory() ? path.join(dir, entry.name, "report.json") : null,
  );
  for (const file of runs) {
    const read = readReport(file);
    if (!read || !Array.isArray(read.report.calls)) continue;
    read.report.calls.forEach((call, index) => {
      records.push(
        harnessRecord({
          role: read.report.role ?? null,
          provider: call.provider ?? null,
          profile: call.profile ?? null,
          call,
          key: `harness:${read.report.runId ?? path.basename(path.dirname(file))}:${index + 1}`,
          at: read.at,
        }),
      );
    });
  }
  const assists = reportsIn(path.join(state, "assists"), (dir, entry) =>
    entry.isFile() && entry.name.endsWith(".json")
      ? path.join(dir, entry.name)
      : null,
  );
  for (const file of assists) {
    const read = readReport(file);
    if (!read) continue;
    const { report } = read;
    records.push(
      harnessRecord({
        role: report.callerRole ?? null,
        provider: org?.profiles?.[report.profile]?.provider ?? null,
        profile: report.profile ?? null,
        call: report,
        key: `assist:${path.basename(file, ".json")}`,
        at: read.at,
      }),
    );
  }
  return { source, records, unavailable: null };
}
