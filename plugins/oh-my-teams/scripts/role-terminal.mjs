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
 */
import { assert, run } from "./core.mjs";
import { runOrcaJson, selectOrcaExecutable } from "./orca-adapter.mjs";

const PROMPT_MARK = /[%$#>❯]\s*$/;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
      title ?? `omt-${command.role}`,
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
 * @param {object} options - Launch options.
 * @param {string} options.worktree - Orca worktree selector for the terminal.
 * @param {object} options.command - Result of `roleCommand`.
 * @param {string} [options.title] - Terminal title.
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
  const launch = { orca, worktree, command, title, settleMs, readyMs, pollMs };
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
    ...(ready ? {} : { status: "blocked" }),
    screenCheck: "required",
    screen: seen.screen,
  };
}
