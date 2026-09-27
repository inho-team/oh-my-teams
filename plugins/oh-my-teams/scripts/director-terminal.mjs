/**
 * Opens a director session in an Orca terminal the user can see.
 *
 * The director is the host session that declares kickoffs, not a role
 * `role-terminal` opens, so handing the seat to a new session (a Claude
 * director replaced by a Codex one, or a director whose terminal was lost)
 * had no runtime path and each session rediscovered the Orca verbs by hand
 * (#141). `orca terminal create` in the owner checkout also produced a
 * terminal Orca's UI did not adopt (`orphaned: true`, #142): the director in
 * it worked, but the user had no tab to talk to it in. Splitting a terminal
 * the user already sees puts the new pane in that tab, so this module prefers
 * that path, checks `terminal show` for `orphaned` before typing anything,
 * and closes a terminal the UI did not adopt instead of starting a director
 * nobody can reach.
 *
 * The command is typed with `terminal send` rather than `terminal create
 * --command`: the latter timed out on a long command and, on other hosts,
 * left the command unsubmitted at the prompt. Submission and readiness are
 * then judged from the screen exactly as `role-terminal` does.
 */
import fs from "node:fs";
import path from "node:path";
import { assert, DIRECTOR_ROLE, run } from "./core.mjs";
import { runOrcaJson, selectOrcaExecutable } from "./orca-adapter.mjs";
import { questionOnScreen } from "./prompt-supervision.mjs";
import {
  launchLine,
  observeLaunch,
  pinTerminalTitle,
  settleTerminal,
} from "./role-terminal.mjs";

/** Tag a director tab title starts with. */
export const DIRECTOR_TITLE_TAG = "[Director]";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function realPath(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

function samePlace(a, b) {
  if (typeof a !== "string" || !a) return false;
  return realPath(a) === realPath(b);
}

async function showTerminal(orca, handle, execute) {
  const shown = await runOrcaJson(
    orca,
    ["terminal", "show", "--terminal", handle],
    { execute },
  );
  return shown.result?.terminal ?? {};
}

/**
 * Builds a director tab title that starts with the director tag.
 *
 * @param {string} checkout - Owner checkout the director sits in.
 * @param {string | null} [detail] - Text after the tag; the checkout name when omitted.
 * @returns {string} Title such as `[Director] oh-my-teams`.
 */
export function directorTitle(checkout, detail) {
  const text = String(detail ?? "").trim() || path.basename(realPath(checkout));
  if (text.startsWith(DIRECTOR_TITLE_TAG)) return text;
  return `${DIRECTOR_TITLE_TAG} ${text}`;
}

/**
 * Opens a director command in a visible terminal of the owner checkout.
 *
 * With `fromTerminal` (by default the calling terminal, from
 * `ORCA_TERMINAL_HANDLE`), the new terminal is a vertical split of that
 * terminal, which must sit in `checkout`; the split shares the tab the user
 * is looking at. Without it, `terminal create` opens a tab in the checkout,
 * and the result's `visible` says whether the UI adopted it. A terminal
 * reported `orphaned` is closed again before any command is typed, and the
 * call fails naming the fix, so no director ever runs where the user cannot
 * see it.
 *
 * The command is typed and submitted, then the screen is read until the
 * agent draws its interface, with one corrective Enter when the command
 * stays at the prompt. A folder trust question is not answered: the checkout
 * is the user's own, already trusted by the session that calls this, so a
 * question there is reported as `blocked` with the screen.
 *
 * @param {object} options - Launch options.
 * @param {string} options.checkout - Owner checkout the director works in.
 * @param {object} options.command - Result of `directorCommand`.
 * @param {string} [options.title] - Text after the director tag; the checkout name when omitted.
 * @param {string} [options.fromTerminal] - Visible terminal to split; omit to create a tab.
 * @param {string} [options.executable] - Orca executable to use.
 * @param {number} [options.settleMs=8000] - Wait before the corrective Enter.
 * @param {number} [options.readyMs=90000] - Wait for the agent's interface.
 * @param {number} [options.pollMs=1500] - Interval between screen reads.
 * @param {Function} [options.execute=run] - Injectable command runner.
 * @returns {Promise<object>} Terminal handle, how it was opened, visibility,
 *   submission, readiness and the final screen.
 * @throws {Error} When the source terminal is elsewhere, Orca opens no
 *   terminal, or the terminal is one the UI did not adopt.
 */
export async function openDirectorTerminal({
  checkout,
  command,
  title,
  fromTerminal,
  executable,
  settleMs = 8000,
  readyMs = 90000,
  pollMs = 1500,
  execute = run,
}) {
  assert(
    typeof checkout === "string" && checkout.trim(),
    "director-terminal needs the owner checkout path",
  );
  assert(
    Array.isArray(command?.argv) && command.argv.length > 0,
    "director-terminal needs a director command",
  );
  const orca = selectOrcaExecutable(executable);
  const { typed } = launchLine(command);
  const tabTitle = directorTitle(checkout, title);
  let handle;
  let opened;
  if (fromTerminal) {
    const source = await showTerminal(orca, fromTerminal, execute);
    assert(
      samePlace(source.worktreePath, checkout),
      `Terminal ${fromTerminal} sits in ${source.worktreePath ?? "an unknown worktree"}, not in the checkout ${checkout}; ` +
        "split a terminal of that checkout with --from-terminal, or omit it to create a tab",
    );
    const split = await runOrcaJson(
      orca,
      [
        "terminal",
        "split",
        "--terminal",
        fromTerminal,
        "--direction",
        "vertical",
      ],
      { execute },
    );
    handle = split.result?.split?.handle;
    opened = "split";
  } else {
    const created = await runOrcaJson(
      orca,
      [
        "terminal",
        "create",
        "--worktree",
        `path:${checkout}`,
        "--title",
        tabTitle,
      ],
      { execute },
    );
    handle = created.result?.terminal?.handle;
    opened = "create";
  }
  assert(handle, "Orca created no terminal handle");
  const shown = await showTerminal(orca, handle, execute);
  const visible =
    typeof shown.orphaned === "boolean" ? !shown.orphaned : "unknown";
  if (visible === false) {
    // An empty shell the UI did not adopt: nothing is lost by closing it, and
    // a director started there would be one the user cannot see (#142).
    await runOrcaJson(orca, ["terminal", "close", "--terminal", handle], {
      execute,
    });
    const fix = fromTerminal
      ? "Orca did not adopt the split pane; check that the source terminal is shown in the Orca window"
      : "run director-terminal from a terminal shown in the Orca window, or pass --from-terminal <handle> of one, so the director opens as a split of it";
    throw new Error(
      `Terminal ${handle} (${opened}) is orphaned: Orca's UI shows no tab for it, so it was closed again. ${fix}`,
    );
  }
  await runOrcaJson(
    orca,
    ["terminal", "send", "--terminal", handle, "--text", typed, "--enter"],
    { execute },
  );
  const until = async (budgetMs, done = (seen) => seen.started) => {
    const deadline = Date.now() + budgetMs;
    let seen = await observeLaunch(orca, handle, typed, execute);
    while (!done(seen) && Date.now() < deadline) {
      await sleep(pollMs);
      seen = await observeLaunch(orca, handle, typed, execute);
    }
    return seen;
  };
  let seen = await until(settleMs);
  let submission = "sent";
  // Enter while the shell is still echoing would run a cut-off command.
  if (!seen.started && seen.typing) {
    seen = await until(settleMs, (now) => now.started || !now.typing);
  }
  if (!seen.started && seen.pending) {
    await runOrcaJson(
      orca,
      ["terminal", "send", "--terminal", handle, "--text", "", "--enter"],
      { execute },
    );
    submission = "enter-sent";
  }
  if (!seen.started) seen = await until(readyMs);
  if (seen.started) {
    // The interface may still be drawing its header; let it settle so the
    // returned screen shows the model the caller must compare.
    await settleTerminal(orca, handle, execute);
    seen = await observeLaunch(orca, handle, typed, execute);
  }
  const questioned = questionOnScreen(seen.screen, {
    cli: command.provider,
    worktree: checkout,
  });
  const ready = seen.started && !questioned;
  const titlePinned = ready
    ? await pinTerminalTitle({ orca, handle, title: tabTitle, execute })
    : false;
  return {
    role: DIRECTOR_ROLE,
    profile: command.profile,
    provider: command.provider,
    terminal: handle,
    opened,
    fromTerminal: fromTerminal ?? null,
    tabId: shown.tabId ?? null,
    visible,
    checkout,
    command: command.command,
    launched: typed,
    permissionBypass: command.permissionBypass ?? null,
    modelRequested: command.modelRequested,
    effortRequested: command.effortRequested,
    submission,
    questioned,
    ready,
    title: tabTitle,
    titlePinned,
    ...(ready ? {} : { status: "blocked" }),
    screenCheck: "required",
    screen: seen.screen,
  };
}
