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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, run } from "./core.mjs";
import {
  checkTerminalIdle,
  runOrcaJson,
  selectOrcaExecutable,
} from "./orca-adapter.mjs";
import {
  predictLaunchPath,
  normalizeModelFamily,
  VERIFIED_ORCA_VERSION,
  VERIFIED_CLI_VERSION,
} from "./launch-matrix.mjs";

/**
 * 실제 환경에서 매트릭스 입력값을 읽습니다.
 *
 * 알 수 없는 값은 낙관적 기본값 대신 `unknown`으로 반환합니다.
 * 사용자 설정 파일은 읽기만 하고 쓰지 않습니다.
 *
 * @param {object} options - 주입 가능한 의존성.
 * @param {string} [options.worktreePath] - 신뢰 여부를 확인할 워크트리 경로.
 * @param {string} [options.orcaExecutable] - Orca 실행 파일 경로.
 * @param {string} [options.homedir=os.homedir()] - 홈 디렉터리 (테스트용 주입).
 * @param {string} [options.codexHome] - Codex 설정 디렉터리 (테스트용 주입, 미지정 시 CODEX_HOME 환경변수 또는 ~/.codex 사용).
 * @param {Function} [options.execute=run] - 명령 실행기 (테스트용 주입).
 * @returns {Promise<object>} 환경 값 객체.
 */
export async function readLaunchEnvironment({
  worktreePath,
  orcaExecutable,
  homedir = os.homedir(),
  codexHome,
  execute = run,
} = {}) {
  const platform = process.platform;
  const shell = platform === "win32" ? "powershell" : "posix";
  const launchErrors = [];

  // Orca 버전 읽기
  let orcaVersion = "unknown";
  try {
    const selected = selectOrcaExecutable(orcaExecutable);
    const result = await execute([selected, "--version"], { timeoutMs: 10000 });
    if (result.code === 0) {
      const ver = String(result.stdout ?? "")
        .trim()
        .split(/\s+/)
        .find((t) => /^\d+\.\d+\.\d+/.test(t));
      if (ver) orcaVersion = ver;
    }
  } catch (error) {
    launchErrors.push(error);
  }

  // Agy CLI 버전 읽기
  let cliVersion = "unknown";
  try {
    const result = await execute(["agy", "--version"], { timeoutMs: 10000 });
    if (result.code === 0) {
      const ver = String(result.stdout ?? "")
        .trim()
        .split(/\s+/)
        .find((t) => /^\d+\.\d+\.\d+/.test(t));
      if (ver) cliVersion = ver;
    }
  } catch (error) {
    launchErrors.push(error);
  }

  // Agy 신뢰 기록: ~/.gemini/antigravity-cli/settings.json의 trustedWorkspaces
  let trustRecordExists = "unknown";
  const agySettingsFile = path.join(
    homedir,
    ".gemini",
    "antigravity-cli",
    "settings.json",
  );
  try {
    const text = fs.readFileSync(agySettingsFile, "utf8");
    const settings = JSON.parse(text);
    const trusted = settings.trustedWorkspaces;
    if (
      worktreePath &&
      Array.isArray(trusted) &&
      trusted.some((t) => String(t) === worktreePath)
    ) {
      trustRecordExists = true;
    } else if (Array.isArray(trusted)) {
      trustRecordExists = false;
    }
  } catch (error) {
    launchErrors.push(error);
  }

  // Claude skipDangerousModePermissionPrompt: ~/.claude/settings.json
  let skipDangerousModePermissionPrompt = "unknown";
  const claudeSettingsFile = path.join(homedir, ".claude", "settings.json");
  try {
    const text = fs.readFileSync(claudeSettingsFile, "utf8");
    const settings = JSON.parse(text);
    if (typeof settings.skipDangerousModePermissionPrompt === "boolean") {
      skipDangerousModePermissionPrompt =
        settings.skipDangerousModePermissionPrompt;
    }
  } catch (error) {
    launchErrors.push(error);
  }

  // Codex 신뢰 기록: CODEX_HOME/config.toml 또는 ~/.codex/config.toml
  // [projects."<주 저장소 루트>"] 아래 trust_level = "trusted"인지 읽기만 한다.
  // 주 저장소 루트: worktreePath에서 git rev-parse --path-format=absolute --git-common-dir 결과의 부모.
  let codexTrustRecordExists = "unknown";
  if (worktreePath) {
    try {
      let repoRoot = null;
      const gitPath = path.join(worktreePath, ".git");
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) {
        repoRoot = worktreePath;
      } else {
        const gitFile = fs.readFileSync(gitPath, "utf8");
        const match = gitFile.match(/^gitdir:\s*(.+)$/m);
        if (match) {
          const gitDir = path.resolve(worktreePath, match[1].trim());
          repoRoot = path.dirname(path.dirname(path.dirname(gitDir)));
        }
      }

      if (repoRoot) {
        // 경로 정규화: 대소문자 통일(Windows), 구분자 통일
        const normPath = (p) =>
          p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
        const normalizedRoot = normPath(repoRoot);

        const resolvedCodexHome = codexHome ?? process.env.CODEX_HOME;
        const codexConfigFile = resolvedCodexHome
          ? path.join(resolvedCodexHome, "config.toml")
          : path.join(homedir, ".codex", "config.toml");

        try {
          const tomlText = fs.readFileSync(codexConfigFile, "utf8");
          // [projects."<경로>"] 또는 [projects.'<경로>'] 섹션에서 trust_level 검출.
          // 큰따옴표 키: TOML 기본 문자열 → \\ → \, \" → " 풀기.
          // 작은따옴표 키: TOML 리터럴 문자열 → 이스케이프 없이 그대로 사용.
          const sectionReDouble =
            /^\s*\[projects\."((?:[^"\\]|\\.)*)"\]\s*$/gim;
          const sectionReSingle = /^\s*\[projects\.'([^']*)'\]\s*$/gim;

          /** TOML 기본 문자열(큰따옴표) 이스케이프 해제 */
          const unescapeTomlBasic = (s) => s.replace(/\\(["\\])/g, "$1");

          let found = false;
          for (const [re, unescape] of [
            [sectionReDouble, unescapeTomlBasic],
            [sectionReSingle, (s) => s],
          ]) {
            let match;
            re.lastIndex = 0;
            while ((match = re.exec(tomlText)) !== null) {
              const sectionPath = normPath(unescape(match[1]));
              if (sectionPath !== normalizedRoot) continue;
              // 이 섹션부터 다음 섹션([...]) 또는 파일 끝까지 검색
              const afterSection = tomlText.slice(
                match.index + match[0].length,
              );
              const nextSection = afterSection.search(/^\s*\[/m);
              const body =
                nextSection === -1
                  ? afterSection
                  : afterSection.slice(0, nextSection);
              if (/^\s*trust_level\s*=\s*["']trusted["']\s*$/im.test(body)) {
                found = true;
              }
              break;
            }
            if (found) break;
          }
          codexTrustRecordExists = found;
        } catch (error) {
          launchErrors.push(error);
        }
      }
    } catch (error) {
      launchErrors.push(error);
    }
  }

  return {
    platform,
    shell,
    orcaVersion,
    cliVersion,
    trustRecordExists,
    codexTrustRecordExists,
    skipDangerousModePermissionPrompt,
    launchErrors,
  };
}

const PROMPT_MARK = /[%$#>❯]\s*$/;

/**
 * Terminal width an Agy Gemini role is launched at.
 *
 * Orca decides that an `antigravity` terminal is idle from its screen: after
 * the `Antigravity CLI` banner it needs a line that starts with `gemini` and a
 * line holding only `>`. At the width Orca opens a terminal, Agy 1.2.4 draws
 * its logo to the left of the banner, so the model line starts with logo glyphs
 * and the terminal never reads as idle; worker-start then refuses it. Below
 * this width Agy draws the logo above the banner and the model line starts
 * with the model name. A model whose name does not start with `gemini` fails
 * Orca's check at any width, so only Gemini models are launched narrow.
 */
export const AGY_BANNER_COLUMNS = 44;

/**
 * Returns the shell command a role terminal types, narrowed for Agy Gemini on POSIX.
 *
 * Role commands run in a POSIX shell or in PowerShell. A POSIX shell narrows
 * the terminal with `stty` so Orca's tui-idle check sees the model line without
 * logo glyphs. On Windows, narrowing with `mode con:` in the same line as `agy`
 * keeps `powershell.exe` as the foreground process and Orca cannot detect the
 * agent, so the width adjustment is skipped there entirely; the matrix routes
 * Windows Agy Gemini through a separate path (see `predictLaunchPath`).
 *
 * @param {object} command - Result of `roleCommand`.
 * @param {string} [platform=process.platform] - Host platform.
 * @returns {{typed: string, columns: number | null}} Command to type, and the
 *   width it sets or null.
 */
export function launchLine(command, platform = process.platform) {
  // Kept pure for every platform so the typed line stays testable; the refusal
  // for a Windows Agy role happens in openRoleTerminal before any terminal is
  // created.
  const narrow =
    command.provider === "agy" &&
    normalizeModelFamily(command.modelRequested) === "gemini" &&
    platform !== "win32";
  if (!narrow) return { typed: command.command, columns: null };
  return {
    typed: `stty cols ${AGY_BANNER_COLUMNS}; ${command.command}`,
    columns: AGY_BANNER_COLUMNS,
  };
}

/** Tag each role's tab title starts with, so PM and PL tabs are told apart. */
export const ROLE_TITLE_TAGS = Object.freeze({
  pm: "[PM]",
  pl: "[PL]",
  senior: "[Senior]",
  junior: "[Junior]",
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
  // Orca can expose a just-submitted shell command without the prompt prefix.
  // That text is input acceptance, not a rendered agent interface or turn proof.
  if (!found && squeeze(rows.join("")) === squeeze(command)) return false;
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
  typed,
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
      typed,
    ],
    { execute },
  );
  const handle = created.result?.terminal?.handle;
  assert(handle, "Orca created no terminal handle");

  const until = async (budgetMs) => {
    const deadline = Date.now() + budgetMs;
    let seen = await observe(orca, handle, typed, execute);
    while (!seen.started && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      seen = await observe(orca, handle, typed, execute);
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
    seen = await observe(orca, handle, typed, execute);
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
      seen = await observe(orca, handle, typed, execute);
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
 * @param {string} [options.platform=process.platform] - Host platform.
 * @param {'powershell'|'posix'} [options.shell='posix'] - Shell kind on the platform.
 * @param {boolean} [options.trustRecordExists=true] - Whether the worktree has a trust record (Agy).
 * @param {boolean|string} [options.codexTrustRecordExists="unknown"] - Whether the worktree has a Codex trust record.
 * @param {string} [options.orcaVersion] - Orca version for matrix lookup.
 * @param {string} [options.cliVersion] - Antigravity CLI version for matrix lookup.
 * @param {boolean} [options.allowUnverified=false] - Legacy compatibility option; unverified evidence no longer blocks launch.
 * @param {string} [options.allowUnverifiedApproval] - Approval sentence recorded for accountability.
 * @param {Function} [options.execute=run] - Injectable command runner.
 * The matrix table is consulted before any terminal is created. A `blocked` or
 * unverified-without-approval result throws with the reason codes and next
 * action, without spending a workflow attempt.
 *
 * @returns {Promise<object>} Handle, submission, readiness and final screen.
 * @throws {Error} When the terminal cannot be created or read, or the matrix
 *   predicts a blocked launch path.
 */
export async function openRoleTerminal({
  worktree,
  command,
  title,
  executable,
  settleMs = 8000,
  readyMs = 90000,
  pollMs = 1500,
  platform = process.platform,
  shell = platform === "win32" ? "powershell" : "posix",
  trustRecordExists = true,
  codexTrustRecordExists = "unknown",
  orcaVersion = VERIFIED_ORCA_VERSION,
  cliVersion = VERIFIED_CLI_VERSION,
  allowUnverified = false,
  allowUnverifiedApproval,
  execute = run,
}) {
  assert(worktree, "role-terminal needs a worktree selector");
  assert(
    Array.isArray(command?.argv) && command.argv.length > 0,
    "role-terminal needs a role command",
  );
  const { typed, columns } = launchLine(command, platform);
  const isCompoundCommand = columns !== null;
  const matrixResult = predictLaunchPath({
    runner: command.provider,
    model: command.modelRequested,
    platform,
    shell,
    trustRecordExists,
    codexTrustRecordExists,
    skipDangerousModePermissionPrompt: Boolean(command.permissionBypass),
    orcaVersion,
    cliVersion,
    isCompoundCommand,
    allowUnverified,
    allowUnverifiedApproval,
  });
  if (matrixResult.path === "blocked" || matrixResult.path === "headless") {
    const err = new Error(
      `Role ${command.role} (profile=${command.profile}, runner=${command.provider}, platform=${platform}, shell=${shell}) ` +
        `launch refused by matrix [${matrixResult.reason.join(", ")}]: ${matrixResult.nextAction}`,
    );
    err.matrixRefusal = {
      role: command.role,
      profile: command.profile,
      provider: command.provider,
      platform,
      shell,
      path: matrixResult.path,
      reason: matrixResult.reason,
      nextAction: matrixResult.nextAction,
    };
    throw err;
  }
  const orca = selectOrcaExecutable(executable);
  const tabTitle = roleTitle(command.role, title ?? worktreeLabel(worktree));
  const launch = {
    orca,
    worktree,
    command,
    typed,
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
    matrix: { ...matrixResult, platform, shell, orcaVersion },
    warnings: matrixResult.reason,
    worktree,
    command: command.command,
    launched: typed,
    columns,
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

/** Purposes a `worker-start` hand-over may declare with `--purpose`. */
export const DISPATCH_PURPOSES = Object.freeze(["implement", "review"]);

// What identifies the work a terminal was handed: the workflow task when the
// caller named it, otherwise the Orca task it dispatched. A spec-only start
// creates a new Orca task each time and names nothing stable.
function taskIdentity(item) {
  if (item.workflowTaskId) {
    return `workflow:${item.workflowId ?? ""}#${item.workflowTaskId}`;
  }
  return item.orcaTaskId ? `orca:${item.orcaTaskId}` : null;
}

/**
 * Decides whether a reused role terminal must start from a fresh context.
 *
 * One reviewer terminal carried eight different reviews in a single Claude
 * session and re-sent up to 408k tokens per call. A terminal handed a
 * different task therefore gets `/clear` first. The latest earlier
 * `worker-start` launch on the same terminal is the previous task. A rework of
 * the same task keeps the session; a review, or a change between review and
 * implementation, always clears; a task that names no identity counts as
 * different. Only Claude terminals are cleared.
 *
 * @param {object[]} launches - Launch ledger lines, oldest first.
 * @param {object} request - The hand-over about to happen.
 * @param {string} request.terminal - Terminal handle receiving the task.
 * @param {string} request.provider - Provider of the role's profile.
 * @param {string | null} [request.workflowId] - Workflow the task belongs to.
 * @param {string | null} [request.workflowTaskId] - Workflow task id (`--workflow-task`).
 * @param {string | null} [request.orcaTaskId] - Orca task passed with `--task`.
 * @param {string | null} [request.purpose] - One of `DISPATCH_PURPOSES`; none means `implement`.
 * @returns {{clear: boolean, reason: string, previousLaunchAt?: string}} Decision.
 */
export function freshContextDecision(launches, request) {
  if (request.provider !== "claude")
    return { clear: false, reason: "not-claude" };
  const previous = launches.findLast(
    (line) => line.via === "worker-start" && line.terminal === request.terminal,
  );
  if (!previous) return { clear: false, reason: "first-task" };
  const at = { previousLaunchAt: previous.at };
  if (request.purpose === "review")
    return { clear: true, reason: "review", ...at };
  // A start that declared no purpose is an implementation, as before --purpose.
  if (previous.purpose === "review")
    return { clear: true, reason: "purpose-changed", ...at };
  const identity = taskIdentity(request);
  if (identity && identity === taskIdentity(previous)) {
    return { clear: false, reason: "same-task", ...at };
  }
  return {
    clear: true,
    reason: identity ? "different-task" : "task-unidentified",
    ...at,
  };
}

/**
 * Clears a Claude role terminal's conversation before it is handed new work.
 *
 * The terminal must be idle first, since `/clear` typed into a busy session
 * would wait behind its current turn. After `/clear` the same idle wait runs
 * again, so the task is dispatched only once the cleared session is ready.
 *
 * @param {object} options - Clear options.
 * @param {string} options.terminal - Terminal handle to clear.
 * @param {string} [options.executable] - Orca executable.
 * @param {string} [options.cwd] - Directory the Orca commands run from.
 * @param {Function} [options.execute=run] - Injectable command runner.
 * @returns {Promise<{cleared: true, terminal: string}>} The cleared terminal.
 * @throws {Error} Carrying the idle check's signal when the terminal is not idle.
 */
export async function clearRoleTerminal({
  terminal,
  executable,
  cwd,
  execute = run,
}) {
  const orca = selectOrcaExecutable(executable);
  await checkTerminalIdle(terminal, { executable: orca, cwd, execute });
  await runOrcaJson(
    orca,
    ["terminal", "send", "--terminal", terminal, "--text", "/clear", "--enter"],
    {
      cwd,
      execute,
    },
  );
  await checkTerminalIdle(terminal, { executable: orca, cwd, execute });
  return { cleared: true, terminal };
}
