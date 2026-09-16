/**
 * Opens a role's interactive CLI in an Orca terminal and confirms it started.
 *
 * `orca terminal create --command` types the command into the new shell but
 * does not always submit it: the line sits at the prompt, no agent starts, and
 * a task sent afterwards lands on the shell instead. A session following the
 * steps by hand misses this, so the launch, the one corrective Enter and the
 * screen the caller must check are done here in one place.
 *
 * Readiness is judged from the screen alone. Orca's `tui-idle` wait is also
 * satisfied by an idle shell holding the unsubmitted command, so it cannot
 * tell a started agent from a stuck prompt.
 *
 * The tab title names the role. A title given only at creation did not always
 * survive: a PM tab opened with one was later shown under the agent's own
 * session title, because Orca can rebuild a tab record without its custom
 * title. `terminal rename` sets that custom title again, and Orca shows a
 * custom title ahead of any title the agent sends.
 */
import { assert, run } from "./core.mjs";
import { runOrcaJson, selectOrcaExecutable } from "./orca-adapter.mjs";

const PROMPT_MARK = /[%$#>❯]\s*$/;

/** Tag each role's tab title starts with, so PM and PL tabs are told apart. */
export const ROLE_TITLE_TAGS = Object.freeze({
  pm: "[PM]",
  pl: "[PL]",
  senior: "[Senior]",
  junior: "[Junior]",
  intern: "[Intern]",
});

/**
 * Names the worktree a selector or Orca worktree ID points at.
 *
 * @param {string} [selector] - Selector such as `id:<repo>::<path>`, or an ID.
 * @returns {string | null} Last path segment or name, or null for `active`.
 */
export function worktreeLabel(selector) {
  const value = String(selector ?? "")
    .trim()
    .replace(/^(id|path|name|branch|identity|issue):/, "");
  if (!value || value === "active" || value === "current") return null;
  const place = value.includes("::")
    ? value.slice(value.lastIndexOf("::") + 2)
    : value;
  return place.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
}

/**
 * Builds a tab title that starts with the role's tag.
 *
 * A caller's text is kept after the tag rather than replacing it, so a title
 * written by hand still says which role the tab holds.
 *
 * @param {string} role - Role the terminal runs.
 * @param {string | null} [detail] - Worktree or task the tab is about.
 * @returns {string} Title such as `[PM] literacy-site-research-2`.
 */
export function roleTitle(role, detail) {
  const tag = ROLE_TITLE_TAGS[role];
  assert(tag, `No title tag for role ${role}`);
  const text = String(detail ?? "").trim();
  if (text.startsWith(tag)) return text;
  return text ? `${tag} ${text}` : tag;
}

/**
 * Finds the agent terminal and worktree a worker-start receipt names.
 *
 * @param {object} [receipt] - Orca's worker-start envelope.
 * @param {string} [terminal] - Terminal the caller handed the task to, if any.
 * @returns {{handle: string | null, place: string | null}} Terminal handle and
 *   worktree name, each null when the receipt does not name one.
 */
export function workerTerminal(receipt, terminal) {
  const effects = receipt?.result?.effects ?? [];
  const agent = effects.find(
    (effect) => effect?.kind === "terminal" && effect.role === "agent",
  );
  const worktree = effects.find((effect) => effect?.kind === "worktree");
  return {
    handle: agent?.id ?? terminal ?? null,
    place: worktreeLabel(worktree?.id),
  };
}

/**
 * Sets a terminal's tab title with `terminal rename`.
 *
 * A failed rename leaves an unnamed tab, not a broken role, so it is reported
 * as `false` instead of failing a launch that already started an agent.
 *
 * @param {object} options - Rename options.
 * @param {string} options.orca - Selected Orca executable.
 * @param {string} options.handle - Terminal to rename.
 * @param {string} options.title - Title to set.
 * @param {Function} [options.execute=run] - Injectable command runner.
 * @returns {Promise<boolean>} Whether Orca accepted the title.
 */
export async function pinTerminalTitle({ orca, handle, title, execute = run }) {
  try {
    await runOrcaJson(
      orca,
      ["terminal", "rename", "--terminal", handle, "--title", title],
      { execute },
    );
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// `worktree create` opens a plain shell tab that Orca names `Terminal <n>`;
// the runtime reports it with no title or with that default.
const DEFAULT_TAB_TITLE = /^Terminal \d+$/;

/**
 * Reports whether a screen shows a shell prompt and nothing else.
 *
 * @param {string[]} lines - Screen lines, oldest first.
 * @returns {boolean} Whether no command was typed or run in the shell.
 */
export function untouchedShell(lines) {
  const rows = (lines ?? []).filter((line) => line.trim());
  return rows.length === 1 && PROMPT_MARK.test(rows[0]);
}

/**
 * Closes the unused plain shells beside a role terminal.
 *
 * A new worktree comes with a shell tab, and next to the role's tab it read as
 * another role. Renaming it did not last: Orca kept `Terminal <n>` for a tab it
 * had not shown yet. The shell is closed instead, but only a tab with no agent,
 * no title beyond Orca's default, and a screen holding just the prompt, so a
 * shell someone named or used stays open.
 *
 * @param {object} options - Cleanup options.
 * @param {string} options.orca - Selected Orca executable.
 * @param {string} options.worktree - Worktree selector the role terminal is in.
 * @param {string} options.handle - The role terminal, which is left alone.
 * @param {Function} [options.execute=run] - Injectable command runner.
 * @returns {Promise<string[]>} Handles of the shells that were closed.
 */
export async function closeUnusedShells({
  orca,
  worktree,
  handle,
  execute = run,
}) {
  let terminals;
  try {
    const listed = await runOrcaJson(
      orca,
      ["terminal", "list", "--worktree", worktree],
      { execute },
    );
    terminals = listed.result?.terminals ?? [];
  } catch {
    return [];
  }
  const closed = [];
  for (const terminal of terminals) {
    const plain =
      terminal?.handle &&
      terminal.handle !== handle &&
      !terminal.agentIdentity &&
      (!terminal.title || DEFAULT_TAB_TITLE.test(terminal.title));
    if (!plain) continue;
    try {
      const screen = await readScreen(orca, terminal.handle, execute);
      if (!untouchedShell(screen)) continue;
      await runOrcaJson(
        orca,
        ["terminal", "close", "--terminal", terminal.handle],
        { execute },
      );
      closed.push(terminal.handle);
    } catch {
      // A shell that cannot be read or closed is only an extra tab.
    }
  }
  return closed;
}

// Wrapping splits a long command over rows and may drop the space at the
// break; quoting may differ from the typed string. Both are compared away.
const squeeze = (text) => text.replace(/[\s'"]+/g, "");

/**
 * Locates the launch command on a screen, including a command wrapped over rows.
 *
 * @param {string[]} lines - Screen lines, oldest first.
 * @param {string} command - Shell command the terminal was created with.
 * @returns {{rows: string[], start: number, end: number, prompt: string} | null}
 *   Non-empty rows, the rows the command spans, and the shell prompt before it.
 */
export function locateCommand(lines, command) {
  const rows = (lines ?? []).filter((line) => line.trim());
  const executable = command.split(/\s+/)[0];
  const typed = new RegExp(`[%$#>❯]\\s+${escapeRegExp(executable)}(\\s|$)`);
  const target = squeeze(command);
  for (let start = rows.length - 1; start >= 0; start -= 1) {
    const match = typed.exec(rows[start]);
    if (!match) continue;
    let text = squeeze(rows[start].slice(match.index + 1));
    let end = start;
    while (text.length < target.length && end + 1 < rows.length) {
      end += 1;
      text += squeeze(rows[end]);
    }
    if (!text.startsWith(target)) continue;
    return {
      rows,
      start,
      end,
      prompt: rows[start].slice(0, match.index + 1).trim(),
    };
  }
  return null;
}

/**
 * Reports whether a screen shows the launch command still waiting at a prompt.
 *
 * @param {string[]} lines - Screen lines, oldest first.
 * @param {string} command - Shell command the terminal was created with.
 * @returns {boolean} Whether the command is typed but nothing ran below it.
 */
export function commandPending(lines, command) {
  const found = locateCommand(lines, command);
  return Boolean(found) && found.end === found.rows.length - 1;
}

/**
 * Reports whether an agent has drawn its interface after the command.
 *
 * A screen whose last row is the same shell prompt again means the command ran
 * and exited, which is not a started agent. A screen that no longer shows the
 * command at all has been redrawn by a full-screen interface.
 *
 * @param {string[]} lines - Screen lines, oldest first.
 * @param {string} command - Shell command the terminal was created with.
 * @returns {boolean} Whether something other than the shell owns the screen.
 */
export function agentStarted(lines, command) {
  const found = locateCommand(lines, command);
  const rows = found?.rows ?? (lines ?? []).filter((line) => line.trim());
  if (rows.length === 0) return false;
  if (!found) return !PROMPT_MARK.test(rows.at(-1));
  if (found.end === rows.length - 1) return false;
  return rows.at(-1).trim() !== found.prompt;
}

// Agy asks once per folder whether to trust it, and every child worktree is a
// new folder. The bypass flag does not skip this question.
const TRUST_QUESTION =
  /Do you trust the contents of this (project|folder|directory)\?/;
const TRUST_SELECTED = /^\s*[>❯]\s*Yes, I trust this folder\s*$/;

/**
 * Reports whether a screen shows a folder trust question with "trust" selected.
 *
 * @param {string[]} lines - Screen lines, oldest first.
 * @returns {boolean} Whether one Enter would trust the folder and continue.
 */
export function trustQuestion(lines) {
  const rows = lines ?? [];
  return (
    rows.some((line) => TRUST_QUESTION.test(line)) &&
    rows.some((line) => TRUST_SELECTED.test(line))
  );
}

async function settle(orca, handle, execute) {
  try {
    await runOrcaJson(
      orca,
      [
        "terminal",
        "wait",
        "--terminal",
        handle,
        "--for",
        "tui-idle",
        "--timeout-ms",
        "15000",
      ],
      { timeoutMs: 45000, execute },
    );
  } catch {
    // Not idle yet is not a failure; the screen read below is what counts.
  }
}

async function readScreen(orca, handle, execute) {
  const read = await runOrcaJson(
    orca,
    ["terminal", "read", "--terminal", handle, "--screen"],
    { execute },
  );
  return read.result?.terminal?.tail ?? [];
}

async function observe(orca, handle, command, execute) {
  const screen = await readScreen(orca, handle, execute);
  return {
    screen,
    pending: commandPending(screen, command),
    started: agentStarted(screen, command),
  };
}

// Launches the command in a new terminal and answers a folder trust question
// when `answerTrust` allows it. The terminal is returned whatever its state.
async function launchOnce({
  orca,
  worktree,
  command,
  title,
  settleMs,
  readyMs,
  pollMs,
  answerTrust,
  execute,
}) {
  const created = await runOrcaJson(
    orca,
    [
      "terminal",
      "create",
      "--worktree",
      worktree,
      "--title",
      title,
      "--command",
      command.command,
    ],
    { execute },
  );
  const handle = created.result?.terminal?.handle;
  assert(handle, "Orca created no terminal handle");

  const until = async (budgetMs) => {
    const deadline = Date.now() + budgetMs;
    let seen = await observe(orca, handle, command.command, execute);
    while (!seen.started && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      seen = await observe(orca, handle, command.command, execute);
    }
    return seen;
  };

  let seen = await until(settleMs);
  let submission = "orca";
  if (!seen.started && seen.pending) {
    await runOrcaJson(
      orca,
      ["terminal", "send", "--terminal", handle, "--text", "", "--enter"],
      { execute },
    );
    submission = "enter-sent";
  }
  if (!seen.started) seen = await until(readyMs);
  let trust = "not-asked";
  if (seen.started) {
    // The interface may still be drawing its header; let it settle so the
    // returned screen shows the model the caller must compare.
    await settle(orca, handle, execute);
    seen = await observe(orca, handle, command.command, execute);
    if (answerTrust && trustQuestion(seen.screen)) {
      // The worktree was created for this role from the user's repository,
      // and the role already runs without approval prompts. Enter is sent
      // once, for the selected "trust" answer only.
      await runOrcaJson(
        orca,
        ["terminal", "send", "--terminal", handle, "--text", "", "--enter"],
        { execute },
      );
      trust = "accepted";
      await settle(orca, handle, execute);
      seen = await observe(orca, handle, command.command, execute);
    }
  }
  return { handle, seen, submission, trust };
}

/**
 * Creates a terminal running a role command and makes sure the command runs.
 *
 * The screen is read until the agent draws its interface. When the command is
 * still at the shell prompt after `settleMs`, Enter is sent exactly once; a
 * second Enter could reach the started agent as input. The result carries the
 * final screen, which the caller compares with the requested model before
 * handing the terminal any work.
 *
 * Answering Agy's folder trust question leaves the question in the terminal
 * buffer, and Orca's startup check blocks a worker whose buffer still asks
 * for trust. Once the answer is recorded, that terminal is closed and the
 * command is opened once more in a clean one. A question shown again there is
 * not answered: the trust was not recorded, and the terminal is reported
 * blocked instead of reopened in a loop.
 *
 * A ready terminal's tab title is set again once the agent runs, since the
 * title given at creation may not last, and the worktree's unused plain
 * shells are closed.
 *
 * @param {object} options - Launch options.
 * @param {string} options.worktree - Orca worktree selector for the terminal.
 * @param {object} options.command - Result of `roleCommand`.
 * @param {string} [options.title] - Text after the role tag; the worktree
 *   name when omitted.
 * @param {string} [options.executable] - Orca executable to use.
 * @param {number} [options.settleMs=8000] - Wait before sending Enter.
 * @param {number} [options.readyMs=90000] - Wait for the agent's interface.
 * @param {number} [options.pollMs=1500] - Interval between screen reads.
 * @param {Function} [options.execute=run] - Injectable command runner.
 * @returns {Promise<object>} Handle, submission, readiness and final screen.
 * @throws {Error} When the terminal cannot be created or read.
 */
export async function openRoleTerminal({
  worktree,
  command,
  title,
  executable,
  settleMs = 8000,
  readyMs = 90000,
  pollMs = 1500,
  execute = run,
}) {
  assert(worktree, "role-terminal needs a worktree selector");
  assert(
    Array.isArray(command?.argv) && command.argv.length > 0,
    "role-terminal needs a role command",
  );
  const orca = selectOrcaExecutable(executable);
  const tabTitle = roleTitle(command.role, title ?? worktreeLabel(worktree));
  const launch = {
    orca,
    worktree,
    command,
    title: tabTitle,
    settleMs,
    readyMs,
    pollMs,
  };
  const first = await launchOnce({ ...launch, answerTrust: true, execute });
  let { handle, seen, submission } = first;
  let reopened = null;
  let closeError = null;
  if (first.trust === "accepted" && !trustQuestion(seen.screen)) {
    try {
      await runOrcaJson(orca, ["terminal", "close", "--terminal", handle], {
        execute,
      });
      reopened = {
        closedTerminal: handle,
        reason: "trust-question-in-buffer",
      };
    } catch (error) {
      // A second terminal beside one that would not close only adds a
      // resource to reclaim, so the first is reported as it is.
      closeError = error.message;
    }
    if (reopened) {
      ({ handle, seen, submission } = await launchOnce({
        ...launch,
        answerTrust: false,
        execute,
      }));
    }
  }
  const trustBlocked = trustQuestion(seen.screen);
  const ready = seen.started && !trustBlocked && !closeError;
  const titlePinned = ready
    ? await pinTerminalTitle({ orca, handle, title: tabTitle, execute })
    : false;
  const shellsClosed = ready
    ? await closeUnusedShells({ orca, worktree, handle, execute })
    : [];
  return {
    role: command.role,
    profile: command.profile,
    provider: command.provider,
    terminal: handle,
    worktree,
    command: command.command,
    permissionBypass: command.permissionBypass ?? null,
    modelRequested: command.modelRequested,
    effortRequested: command.effortRequested,
    submission,
    trust: first.trust,
    reopened,
    ...(closeError ? { closeError } : {}),
    ready,
    title: tabTitle,
    titlePinned,
    shellsClosed,
    ...(ready ? {} : { status: "blocked" }),
    screenCheck: "required",
    screen: seen.screen,
  };
}
