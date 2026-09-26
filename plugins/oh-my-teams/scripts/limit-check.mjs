/**
 * Usage-limit detection for terminal workers, read from provider session records.
 *
 * A provider CLI writes the error that ended a turn into its own session log
 * as a structured field, while its screen wraps and restyles the same text.
 * The session log is therefore the evidence; the screen is read only when no
 * log can be tied to the worker.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert } from "./core.mjs";
import { RESET_IN_PATTERN } from "./providers/shared.mjs";

/** Providers whose session records this module can read. */
export const LIMIT_PROVIDERS = Object.freeze(["claude", "codex", "agy"]);

/**
 * Agy retries a quota error inside one turn and gave up after this attempt in
 * every recorded case, so an earlier attempt means the turn is still running.
 */
export const AGY_FINAL_ATTEMPT = 8;

const CODEX_LIMIT_CODES = Object.freeze({
  usage_limit_exceeded: "usage-limit",
  server_overloaded: "capacity",
});
const TAIL_BYTES = 4 * 1024 * 1024;
const AGY_SCAN_LIMIT = 200;
const SCREEN_LINES = 40;

function resetHints(message) {
  const at = /try again at (.+?(?:AM|PM))/i.exec(message);
  const within = RESET_IN_PATTERN.exec(message);
  return {
    ...(at ? { resetsAt: at[1] } : {}),
    ...(within ? { resetsIn: within[1] } : {}),
  };
}

function agyError(message) {
  const attempt = /attempt (\d+)/.exec(message);
  const found = (kind) => ({
    kind,
    message,
    ...(attempt ? { attempt: Number(attempt[1]) } : {}),
    ...resetHints(message),
  });
  if (/RESOURCE_EXHAUSTED \(code 429\)/.test(message))
    return found("usage-limit");
  if (/UNAVAILABLE \(code 503\)/.test(message)) return found("capacity");
  return null;
}

/**
 * Classifies one provider session record as a usage limit or a capacity error.
 *
 * @param {string} provider - `claude`, `codex` or `agy`.
 * @param {object} record - One parsed line of the provider's session log.
 * @returns {{kind: string, message: string, attempt?: number, resetsAt?: string, resetsIn?: string} | null}
 * The limit it reports, or null for any other record.
 */
export function classifyLimitRecord(provider, record) {
  if (!record || typeof record !== "object") return null;
  if (provider === "codex") {
    const payload = record.payload;
    if (record.type !== "event_msg" || payload?.type !== "task_complete")
      return null;
    const kind = CODEX_LIMIT_CODES[payload.error?.codex_error_info];
    if (!kind) return null;
    const message = String(payload.error.message ?? "");
    return { kind, message, ...resetHints(message) };
  }
  if (provider === "claude") {
    if (!record.isApiErrorMessage || record.error !== "rate_limit") return null;
    const content = record.message?.content;
    const message = Array.isArray(content)
      ? content.map((part) => part?.text ?? "").join("")
      : String(content ?? "");
    return { kind: "usage-limit", message, ...resetHints(message) };
  }
  if (provider === "agy") {
    if (record.source !== "SYSTEM" || record.type !== "ERROR_MESSAGE")
      return null;
    return agyError(String(record.error ?? ""));
  }
  return null;
}

function readTail(file) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const handle = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    fs.readSync(handle, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    // A tail that starts mid-file begins with a partial line.
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    fs.closeSync(handle);
  }
}

function readFirstLine(file) {
  const handle = fs.openSync(file, "r");
  try {
    const chunks = [];
    const buffer = Buffer.alloc(64 * 1024);
    for (let position = 0; position < TAIL_BYTES;) {
      const read = fs.readSync(handle, buffer, 0, buffer.length, position);
      if (read === 0) break;
      const end = buffer.subarray(0, read).indexOf(10);
      chunks.push(Buffer.from(buffer.subarray(0, end < 0 ? read : end)));
      if (end >= 0) break;
      position += read;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    fs.closeSync(handle);
  }
}

function parseLines(lines) {
  return lines.flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      // A partial last line while the provider is still writing.
      return [];
    }
  });
}

function newestFirst(files) {
  return files
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime)
    .map(({ file }) => file);
}

function walk(root, accept) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (accept(entry.name)) found.push(full);
    }
  }
  return found;
}

function realWorktree(worktree) {
  assert(fs.existsSync(worktree), `Worktree not found: ${worktree}`);
  return fs.realpathSync(worktree);
}

/**
 * Default record locations, overridable for tests and non-default homes.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment to read homes from.
 * @returns {{codexHome: string, claudeHome: string, agyHome: string}} Provider homes.
 */
export function providerHomes(env = process.env) {
  return {
    codexHome: env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
    claudeHome: env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
    agyHome: path.join(os.homedir(), ".gemini", "antigravity-cli"),
  };
}

/**
 * Finds the newest session log a provider wrote for one worker.
 *
 * Codex and Claude record the working directory, and role workers never share
 * a worktree, so the worktree names the session. Agy records no directory; its
 * session is the one whose first input carries the brief's checkpoint command
 * for this workflow task.
 *
 * @param {string} provider - `claude`, `codex` or `agy`.
 * @param {object} target - Worker to look for.
 * @param {string} target.worktree - Worker worktree path.
 * @param {string} [target.workflowId] - Workflow ID, required for Agy.
 * @param {string} [target.workflowTask] - Workflow task ID, required for Agy.
 * @param {object} [homes=providerHomes()] - Provider homes.
 * @returns {string | null} Session log path, or null when none is tied to the worker.
 * @throws {Error} When the provider is unknown or the worktree does not exist.
 */
export function findProviderSession(
  provider,
  { worktree, workflowId, workflowTask },
  homes = providerHomes(),
) {
  assert(LIMIT_PROVIDERS.includes(provider), `Unknown provider: ${provider}`);
  const cwd = realWorktree(worktree);
  if (provider === "codex") {
    const rollouts = walk(
      path.join(homes.codexHome, "sessions"),
      (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
    );
    return (
      newestFirst(rollouts).find((file) => {
        const [meta] = parseLines([readFirstLine(file)]);
        return meta?.type === "session_meta" && meta.payload?.cwd === cwd;
      }) ?? null
    );
  }
  if (provider === "claude") {
    const dir = path.join(
      homes.claudeHome,
      "projects",
      cwd.replace(/[^A-Za-z0-9]/g, "-"),
    );
    if (!fs.existsSync(dir)) return null;
    const logs = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => path.join(dir, name));
    return newestFirst(logs)[0] ?? null;
  }
  if (!workflowId || !workflowTask) return null;
  const marker = `--workflow-id ${workflowId} --workflow-task ${workflowTask}`;
  const brain = path.join(homes.agyHome, "brain");
  if (!fs.existsSync(brain)) return null;
  const transcripts = fs
    .readdirSync(brain)
    .map((id) =>
      path.join(
        brain,
        id,
        ".system_generated",
        "logs",
        "transcript_full.jsonl",
      ),
    )
    .filter((file) => fs.existsSync(file));
  return (
    newestFirst(transcripts)
      .slice(0, AGY_SCAN_LIMIT)
      .find((file) => {
        const [first] = parseLines([readFirstLine(file)]);
        return String(first?.content ?? "").includes(marker);
      }) ?? null
  );
}

// Each provider's last turn is judged from the record that ended it; a later
// input or a turn still running means the limit, if any, is already behind.
function lastTurn(provider, lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].trim()) continue;
    let record;
    try {
      record = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (provider === "codex") {
      if (
        ["task_started", "task_complete", "turn_aborted"].includes(
          record.payload?.type,
        )
      ) {
        return {
          ended: record.payload.type !== "task_started",
          limit: classifyLimitRecord(provider, record),
        };
      }
      continue;
    }
    if (provider === "claude") {
      if (["user", "assistant"].includes(record.type)) {
        return { ended: true, limit: classifyLimitRecord(provider, record) };
      }
      continue;
    }
    if (provider === "agy") {
      const limit = classifyLimitRecord(provider, record);
      const ended =
        limit?.kind === "usage-limit" && limit.attempt >= AGY_FINAL_ATTEMPT;
      return { ended, limit };
    }
  }
  if (provider === "codex") return { ended: false, limit: null };
  if (provider === "claude") return { ended: true, limit: null };
  return { ended: false, limit: null };
}

function verdictOf(limit, ended) {
  if (!limit) return "none";
  if (!ended) return "wait";
  return limit.kind === "usage-limit" ? "handoff" : "retry";
}

/**
 * Judges whether a session log's last turn ended on a limit.
 *
 * @param {string} provider - `claude`, `codex` or `agy`.
 * @param {string} file - Session log path.
 * @returns {{verdict: string, limit: object | null}} `handoff` for a usage
 * limit, `retry` for a capacity error, `wait` while the provider still retries,
 * `none` otherwise.
 */
export function readSessionLimit(provider, file) {
  const { ended, limit } = lastTurn(provider, readTail(file));
  return { verdict: verdictOf(limit, ended), limit };
}

const SCREEN_PATTERNS = {
  codex: [
    ["usage-limit", /You've hit your usage limit/],
    ["capacity", /Selected model is at capacity/],
  ],
  claude: [["usage-limit", /You're out of usage credits/]],
  agy: [
    ["usage-limit", /RESOURCE_EXHAUSTED \(code 429\)|Individual quota reached/],
    ["capacity", /UNAVAILABLE \(code 503\)|No capacity available/],
  ],
};

/**
 * Reads a limit from the bottom of a terminal screen, the weaker evidence.
 *
 * The screen wraps a sentence at the terminal width and mixes straight and
 * curly apostrophes, so lines are joined and quotes folded before matching.
 * Only the last lines are read, so a worker quoting the phrase earlier in its
 * own output is not taken for the provider's error.
 *
 * @param {string} provider - `claude`, `codex` or `agy`.
 * @param {string[]} lines - Screen lines, oldest first.
 * @returns {{verdict: string, limit: object | null}} Same shape as {@link readSessionLimit}.
 */
export function readScreenLimit(provider, lines) {
  const text = lines
    .slice(-SCREEN_LINES)
    .map((line) => line.trim())
    .join(" ")
    .replace(/[‘’]/g, "'");
  for (const [kind, pattern] of SCREEN_PATTERNS[provider] ?? []) {
    const match = pattern.exec(text);
    if (!match) continue;
    const message = text.slice(match.index, match.index + 300);
    const limit = { kind, message, ...resetHints(message) };
    return { verdict: verdictOf(limit, true), limit };
  }
  return { verdict: "none", limit: null };
}

const OVERLOAD_SCREEN_PATTERN = /API Error: 529 Overloaded/;

/**
 * Reads Claude's own 529 overloaded error from the bottom of a terminal screen.
 *
 * The sentence is Claude's own error text and no other provider prints it, so
 * this takes no provider argument the way {@link readScreenLimit} does. The
 * verdict is kept out of that function's capacity routing on purpose: a
 * capacity verdict there resolves to `retry`, an automatic same-profile retry,
 * but a turn that ended on a 529 cannot be judged safe to resend without
 * seeing how far the turn got, so it is reported upward instead of resent
 * (see references/orca-runtime.md, "무응답 worker 감독").
 *
 * @param {string[]} lines - Screen lines, oldest first.
 * @returns {boolean} Whether the screen ends on Claude's 529 overloaded error.
 */
export function readScreenOverload(lines) {
  const text = lines
    .slice(-SCREEN_LINES)
    .map((line) => line.trim())
    .join(" ");
  return OVERLOAD_SCREEN_PATTERN.test(text);
}

/**
 * Checks whether a terminal worker stopped on a usage limit.
 *
 * @param {object} options - Worker and evidence sources.
 * @param {string} options.provider - `claude`, `codex` or `agy`.
 * @param {string} options.worktree - Worker worktree path.
 * @param {string} [options.workflowId] - Workflow ID, used to find Agy sessions.
 * @param {string} [options.workflowTask] - Workflow task ID, used to find Agy sessions.
 * @param {() => Promise<string[]>} [options.readScreen] - Reads the worker's screen when no session log is found.
 * @param {object} [options.homes] - Provider homes.
 * @returns {Promise<object>} Verdict, limit, and the evidence it came from. When
 * the evidence is the worker's screen and the provider is `claude`, an
 * `overload` boolean reports whether that screen ends on the 529 error, so a
 * caller can escalate on it without waiting for `verdict` to resolve.
 * @throws {Error} When the provider is unknown or the worktree does not exist.
 */
export async function workerLimitCheck({
  provider,
  worktree,
  workflowId,
  workflowTask,
  readScreen,
  homes = providerHomes(),
}) {
  const session = findProviderSession(
    provider,
    { worktree, workflowId, workflowTask },
    homes,
  );
  if (session) {
    return {
      provider,
      source: "session",
      session,
      ...readSessionLimit(provider, session),
    };
  }
  if (readScreen) {
    const lines = await readScreen();
    return {
      provider,
      source: "screen",
      ...readScreenLimit(provider, lines),
      ...(provider === "claude" ? { overload: readScreenOverload(lines) } : {}),
    };
  }
  return { provider, source: "none", verdict: "unknown", limit: null };
}
