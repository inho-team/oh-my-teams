/**
 * Classifies the interactive question screens of the role CLIs and judges
 * whether a command approval stays inside a role's scope. Every function is
 * pure: nothing here reads a user's settings, touches a terminal or the
 * filesystem, or sends a key. The caller reads the screen, calls in, and
 * decides how to send the key that comes back.
 *
 * Phrases and selection markers come only from the screens captured in
 * `tests/fixtures/prompt-screens/` (see `docs/plan/prompt-screen-captures.md`).
 * Keys are of three kinds, recorded in `key.basis`: `captured-input` was sent
 * during the capture (Claude's Down), `existing-behavior` is what the Agy
 * launch already did (Enter), and `footer-text` was read off the screen's own
 * footer but never sent (Enter on Codex's and Claude's trust questions). The
 * effect of a `footer-text` key is unverified: the caller must read the screen
 * again after sending it and treat a question that is still there as unanswered.
 * A screen is recognized only when its question text, the rows of its choices,
 * which row is selected and the lines below the choices all match a captured
 * screen. Anything else is `unknown` and is never answered. Update notices and
 * command approvals were not captured for any CLI, so no phrase for them is
 * recognized: they classify as `unknown`, and `decideApproval` takes the
 * choices of an approval from its caller instead of reading them off a screen.
 *
 * Result of `classifyPromptScreen`:
 * - `kind`: `trust`, `user-question` or `unknown`.
 * - `action`: `send-key` (send `key` once), `redirect` (do not answer; send
 *   `instruction` to the worker), or `none` (do not answer).
 * - `key`: `{ name, send: { text, enter }, basis }` or `null`. `send` holds the
 *   arguments for `orca terminal send`.
 * - `reason`: why nothing is sent, or `null` when a key is sent.
 * - `evidence`: the lines compared, the selected choice and what the screen
 *   should show after the key.
 */
import path from "node:path";

const ENTER = { name: "Enter", send: { text: "", enter: true } };
// The escape sequence the capture sent to move a selection down one row.
const DOWN = { name: "Down", send: { text: "\u001b[B", enter: false } };

const blank = (line) => !String(line ?? "").trim();
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A shell prompt after a question means the CLI exited and left its text.
const SHELL_PROMPT = /(^|\s)[%$#]\s*$/;
// Agy draws its model status ("Gemini 3.8 Flash · high") right-aligned; the
// capture has 97 leading spaces. The threshold of 10 is a chosen value, not an
// observed one. Roles run Agy at 44 columns, where a status text longer than
// about 34 characters would have fewer than 10 spaces: that question is then
// not answered, which stops the launch instead of trusting a wrong screen.
const RIGHT_ALIGNED = /^\s{10,}\S/;

const YES = "Yes, I trust this folder";
// The Enter of Codex's and Claude's trust questions was never sent during the
// capture. Its effect is unverified, so the screen must be read again after it.
const UNVERIFIED_ENTER =
  "질문이 사라지고 에이전트 화면이 나타나야 합니다. 이 Enter는 캡처에서 보낸 적이 없어 효과가 확인되지 않았으므로, 보낸 뒤 화면을 다시 읽어 질문이 사라졌는지 확인해야 하고 질문이 남아 있으면 다시 보내지 않습니다.";
const workspaceAfterHeading = (rows, end) => {
  const at = rows.findLastIndex(
    (line, i) => i < end && /^\s*Accessing workspace:\s*$/.test(line),
  );
  return at >= 0 ? (rows[at + 1]?.trim() ?? null) : null;
};

// One profile per captured folder trust question. `options` lists the choice
// rows in screen order; `answers` maps the selected label to the one key that
// was captured or shown by the screen for that state. A selected label with no
// entry is never answered.
const TRUST_PROFILES = [
  {
    cli: "agy",
    verifiedVersion: "1.2.7",
    question: /^\s*Do you trust the contents of this project\?\s*$/,
    marker: ">",
    numbered: false,
    // The existing Agy answer never required the "No" row, so it stays optional.
    options: [
      { label: YES, required: true },
      { label: "No, exit", required: false },
    ],
    footer: /^\s*↑\/↓ Navigate · enter Confirm\s*$/,
    footerRequired: false,
    status: RIGHT_ALIGNED,
    // The Agy answer never knew the worktree (`trustQuestion`), so it keeps
    // answering without one; the other profiles refuse to.
    worktreeRequired: false,
    workspace: workspaceAfterHeading,
    answers: {
      [YES]: {
        key: ENTER,
        basis: "existing-behavior",
        after: "질문이 사라지고 에이전트 화면이 나타납니다.",
      },
    },
  },
  {
    cli: "codex",
    verifiedVersion: "0.155.1",
    question:
      /^\s*Do you trust the contents of this directory\? Working with untrusted contents/,
    marker: "›",
    numbered: true,
    options: [
      { label: "Yes, continue", required: true },
      { label: "No, quit", required: true },
    ],
    footer: /^\s*Press enter to continue\s*$/,
    footerRequired: true,
    status: null,
    worktreeRequired: true,
    workspace: (rows, end) => {
      const line = rows.findLast(
        (text, i) => i < end && /^>\s*You are in \S/.test(text),
      );
      return line ? line.replace(/^>\s*You are in /, "").trim() : null;
    },
    answers: {
      "Yes, continue": {
        key: ENTER,
        basis: "footer-text",
        after: UNVERIFIED_ENTER,
      },
    },
  },
  {
    cli: "claude",
    verifiedVersion: "2.1.278",
    question:
      /^\s*Quick safety check: Is this a project you created or one you trust\?/,
    marker: "❯",
    numbered: false,
    // Claude selects "No, exit" first and quits on Esc, so only Down and Enter
    // are ever returned.
    options: [
      { label: "No, exit", required: true },
      { label: YES, required: true },
    ],
    footer: /^\s*Enter to confirm · Esc to cancel\s*$/,
    footerRequired: true,
    status: null,
    worktreeRequired: true,
    workspace: workspaceAfterHeading,
    answers: {
      "No, exit": {
        key: DOWN,
        basis: "captured-input",
        after: `선택이 "${YES}"로 옮겨집니다. 화면을 다시 읽어 확인한 뒤에만 Enter를 보냅니다.`,
      },
      [YES]: {
        key: ENTER,
        basis: "footer-text",
        after: UNVERIFIED_ENTER,
      },
    },
  },
];

const ASK_HEADER = /^\s*☐\s+\S/;
const ASK_ROW = /^\s*(❯)?\s*(\d+)\.\s+(\S.*?)\s*$/;
const ASK_FOOTER = /^\s*Enter to select · ↑\/↓ to navigate · Esc to cancel\s*$/;
const DIVIDER = /^\s*─{10,}\s*$/;

function outcome(kind, action, fields = {}) {
  return {
    kind,
    cli: fields.cli ?? null,
    action,
    key: fields.key ?? null,
    reason: fields.reason ?? null,
    evidence: fields.evidence ?? { matched: [], selected: null },
    ...(fields.extra ?? {}),
  };
}

function optionRow(profile, option, index, line) {
  const marker = escapeRegex(profile.marker);
  const number = profile.numbered ? `${index + 1}\\.\\s+` : "";
  const row = new RegExp(
    `^\\s*(${marker})?\\s*${number}${escapeRegex(option.label)}\\s*$`,
  ).exec(line);
  return row ? { marked: Boolean(row[1]) } : null;
}

// Reads the choice rows below the question and the lines under them. Returns
// `{ found, selected, lastAt }` or `{ mismatch }` naming what differs.
function readChoices(profile, rows, questionAt) {
  const found = [];
  let cursor = questionAt + 1;
  for (const [index, option] of profile.options.entries()) {
    let at = -1;
    for (let i = cursor; i < rows.length; i += 1) {
      const row = optionRow(profile, option, index, rows[i]);
      if (row) {
        at = i;
        found.push({
          index: index + 1,
          label: option.label,
          marked: row.marked,
          at,
        });
        break;
      }
      // The first row may follow explanatory lines; later rows must be adjacent.
      if (found.length > 0 && !blank(rows[i])) break;
    }
    if (at >= 0) cursor = at + 1;
    else if (option.required)
      return { mismatch: `선택지 "${option.label}" 줄이 없습니다.` };
  }
  const marked = found.filter((choice) => choice.marked);
  if (marked.length !== 1) {
    return {
      mismatch: `선택 표시가 ${marked.length}개여서 현재 선택을 하나로 정할 수 없습니다.`,
    };
  }
  return { found, selected: marked[0], lastAt: found.at(-1).at };
}

function readTrust(profile, rows, context) {
  const questionAt = rows.findLastIndex((line) => profile.question.test(line));
  if (questionAt < 0) return null;
  const evidence = {
    matched: [rows[questionAt].trim()],
    selected: null,
    verifiedVersion: profile.verifiedVersion,
  };
  const fail = (reason) =>
    outcome("unknown", "none", {
      cli: profile.cli,
      reason: `${profile.cli} 신뢰 질문 문구가 있으나 ${reason}`,
      evidence,
    });

  const choices = readChoices(profile, rows, questionAt);
  if (choices.mismatch)
    return fail(`${choices.mismatch} 캡처한 화면과 달라 답하지 않습니다.`);
  const tail = rows.slice(choices.lastAt + 1).filter((line) => !blank(line));
  const footers = tail.filter((line) => profile.footer.test(line));
  const stray = tail.filter((line) => {
    if (profile.footer.test(line)) return false;
    return !(profile.status?.test(line) && !SHELL_PROMPT.test(line));
  });
  if (stray.length > 0 || (profile.footerRequired && footers.length === 0)) {
    return fail(
      "선택지 아래의 줄이 캡처한 화면과 달라 이미 지나간 질문이거나 다른 화면일 수 있어 답하지 않습니다.",
    );
  }
  const { selected } = choices;
  evidence.matched.push(
    ...choices.found.map((choice) => rows[choice.at].trim()),
    ...footers.map((line) => line.trim()),
  );
  evidence.selected = { index: selected.index, label: selected.label };

  if (!context.worktree && profile.worktreeRequired) {
    return outcome("trust", "none", {
      cli: profile.cli,
      evidence,
      reason:
        "역할 워크트리가 주어지지 않아 화면의 작업 폴더가 역할 워크트리인지 확인할 수 없어 답하지 않습니다.",
    });
  }
  if (context.worktree) {
    const seen = profile.workspace(rows, questionAt);
    evidence.workspace = seen;
    if (!seen || path.resolve(seen) !== path.resolve(context.worktree)) {
      return outcome("trust", "none", {
        cli: profile.cli,
        evidence,
        reason: seen
          ? `화면의 작업 폴더 "${seen}"가 역할 워크트리 "${context.worktree}"와 달라 답하지 않습니다.`
          : "화면에서 작업 폴더를 읽지 못해 역할 워크트리인지 확인할 수 없어 답하지 않습니다.",
      });
    }
  }
  const answer = profile.answers[selected.label];
  if (!answer) {
    return outcome("trust", "none", {
      cli: profile.cli,
      evidence,
      reason: `현재 선택이 "${selected.label}"이고, 이 선택 상태에서 보낼 키는 캡처로 확인되지 않아 답하지 않습니다.`,
    });
  }
  return outcome("trust", "send-key", {
    cli: profile.cli,
    key: { ...answer.key, basis: answer.basis },
    evidence: { ...evidence, after: answer.after },
  });
}

function readUserQuestion(rows) {
  const last = rows.findLastIndex((line) => !blank(line));
  if (last < 0 || !ASK_FOOTER.test(rows[last])) return null;
  const headerAt = rows.findLastIndex(
    (line, i) => i < last && ASK_HEADER.test(line),
  );
  if (headerAt < 0) return null;
  const body = rows.slice(headerAt, last);
  const labels = body.map((line) => ASK_ROW.exec(line)?.[3]);
  if (
    !labels.includes("Type something.") ||
    !labels.includes("Chat about this")
  )
    return null;
  const marked = body.filter((line) => ASK_ROW.exec(line)?.[1]);
  const selectedRow = marked.length === 1 ? ASK_ROW.exec(marked[0]) : null;
  const excerpt = body
    .filter(
      (line, i) =>
        !DIVIDER.test(line) &&
        !blank(line) &&
        !["Type something.", "Chat about this"].includes(labels[i]),
    )
    .map((line) => line.trim().replace(/^❯\s*/, ""));
  return {
    excerpt,
    matched: [rows[headerAt].trim(), rows[last].trim()],
    selected: selectedRow
      ? { index: Number(selectedRow[2]), label: selectedRow[3] }
      : null,
  };
}

const TRUST_QUESTION_ANYWHERE =
  /Do you trust the contents of this (project|folder|directory)\?/;
const TRUST_SELECTED_ANYWHERE = /^\s*[>❯]\s*Yes, I trust this folder\s*$/;

/**
 * Reports whether a folder trust question is still on the screen.
 *
 * This is not the "may be answered" check of `classifyPromptScreen`, which
 * also requires the question to be the live screen with nothing below it. A
 * question that is still on the screen but no longer answerable, such as one
 * with other lines drawn below the choices, must keep blocking the caller, so
 * this reads the question text and the selected row anywhere on the screen,
 * exactly as the check did before the classifier existed.
 *
 * @param {string[]} lines - Screen lines, oldest first.
 * @returns {boolean} True when the question text and a selected "Yes, I trust this folder" row are both present.
 */
export function trustQuestionVisible(lines) {
  const rows = lines ?? [];
  return (
    rows.some((line) => TRUST_QUESTION_ANYWHERE.test(line)) &&
    rows.some((line) => TRUST_SELECTED_ANYWHERE.test(line))
  );
}

/**
 * Classifies a terminal screen as a captured question or as unknown.
 *
 * Folder trust questions of Agy, Codex and Claude answer with one key only when
 * the selected choice is the one the capture answers. Claude's question opens
 * on "No, exit", so its first answer is Down and Enter follows only after the
 * screen is read again; Esc is never returned because it quits Claude. A
 * Claude `AskUserQuestion` screen is a `user-question`: it is not answered, and
 * `extra.instruction` tells the worker to ask the supervisor through
 * `orca orchestration ask`.
 *
 * @param {string[]} lines - Screen lines, oldest first.
 * @param {object} [context] - What the caller knows about the terminal.
 * @param {string} [context.cli] - `agy`, `codex` or `claude`; a screen of another CLI is not answered.
 * @param {string} [context.worktree] - The role's worktree; a trust question is answered only when the screen names it.
 *   Codex and Claude questions are not answered without it; Agy's, which never knew it, still is.
 * @returns {{kind: string, cli: string|null, action: string, key: object|null, reason: string|null, evidence: object,
 *   excerpt?: string[], instruction?: string}} Classification with the key to send, if any.
 */
export function classifyPromptScreen(lines, context = {}) {
  const rows = (lines ?? []).map((line) => String(line ?? ""));
  const wanted = (cli) => !context.cli || context.cli === cli;
  for (const profile of TRUST_PROFILES.filter((item) => wanted(item.cli))) {
    const read = readTrust(profile, rows, context);
    if (read) return read;
  }
  const ask = wanted("claude") ? readUserQuestion(rows) : null;
  if (ask) {
    const instruction = [
      "이 화면은 사용자에게 직접 묻는 선택 화면입니다. 이 실행에서는 사용자에게 직접 묻지 않으므로 이 화면에 답하지 않습니다.",
      "아래 질문을 `orca orchestration ask`로 감독자에게 다시 물어 주세요.",
      "질문:",
      ...ask.excerpt,
    ].join("\n");
    return outcome("user-question", "redirect", {
      cli: "claude",
      evidence: {
        matched: ask.matched,
        selected: ask.selected,
        verifiedVersion: "2.1.278",
      },
      reason:
        "사용자에게 묻는 질문 화면이라 답하지 않고 감독자에게 다시 묻게 합니다.",
      extra: { excerpt: ask.excerpt, instruction },
    });
  }
  return outcome("unknown", "none", {
    reason:
      "캡처로 확인한 폴더 신뢰 질문이나 사용자 질문 화면과 일치하지 않아 답하지 않습니다.",
  });
}

// Commands that run another command are looked through, and quotes are dropped
// so that `bash -c "git push"` is read the same as `git push`.
const WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "command",
  "time",
  "nohup",
  "exec",
  "xargs",
  "nice",
]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "eval"]);
const SHELL_OPERATORS = /&&|\|\||[;&|\n()`]/;

function segments(command) {
  return String(command ?? "")
    .replace(/["'\\]/g, " ")
    .split(SHELL_OPERATORS)
    .map((part) => part.split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens.length > 0);
}

// The command word and its arguments once environment assignments, wrappers
// and their options are skipped.
function commandOf(tokens) {
  let at = 0;
  while (
    at < tokens.length &&
    (/^[A-Za-z_]\w*=/.test(tokens[at]) ||
      WRAPPERS.has(tokens[at]) ||
      (at > 0 && tokens[at].startsWith("-")))
  )
    at += 1;
  const name = path.basename(tokens[at] ?? "");
  const args = tokens.slice(at + 1);
  // `bash -c "git push"` runs what follows the flag; `eval` runs its arguments.
  const inner =
    name === "eval" ? 0 : args.findIndex((arg) => /^-\w*c$/.test(arg)) + 1;
  if (SHELLS.has(name) && (name === "eval" || inner > 0))
    return commandOf(args.slice(inner));
  return { name, args };
}

const firstOperand = (args, withValue) => {
  for (let i = 0; i < args.length; i += 1) {
    if (withValue.includes(args[i])) i += 1;
    else if (!args[i].startsWith("-"))
      return { verb: args[i], rest: args.slice(i + 1) };
  }
  return { verb: null, rest: [] };
};
const hasFlag = (args, ...flags) =>
  args.some((arg) =>
    flags.some(
      (flag) =>
        arg === flag ||
        (flag.length === 2 &&
          /^-[a-zA-Z]+$/.test(arg) &&
          arg.includes(flag[1])),
    ),
  );
const HTTP_WRITE = /^(-X|--request)$/;

// Returns the rule a command breaks, or null. The rules are the irreversible,
// remote or global actions the role must never take on approval.
function forbiddenRule({ name, args }) {
  const { verb, rest } = firstOperand(
    args,
    name === "git"
      ? ["-C", "-c", "--git-dir", "--work-tree"]
      : name === "gh"
        ? ["-R", "--repo"]
        : [],
  );
  const rules = {
    git: () => {
      if (["push", "merge", "pull"].includes(verb)) return `git-${verb}`;
      if (verb === "reset" && rest.includes("--hard")) return "git-reset-hard";
      if (verb === "clean" && (hasFlag(rest, "-f") || rest.includes("--force")))
        return "git-clean-force";
      if (verb === "branch" && rest.includes("-D"))
        return "git-branch-force-delete";
      if (
        verb === "config" &&
        (rest.includes("--global") || rest.includes("--system"))
      )
        return "git-config-global";
      if (verb === "credential") return "credential-access";
      return null;
    },
    gh: () => {
      const writes = {
        pr: [
          "create",
          "merge",
          "close",
          "edit",
          "ready",
          "review",
          "comment",
          "reopen",
        ],
        repo: ["create", "delete", "edit", "fork", "rename", "archive"],
        workflow: ["run", "enable", "disable"],
      };
      if (verb === "api")
        return rest.some((arg) =>
          /^(-X|--method|-f|-F|--field|--raw-field|--input)$/.test(arg),
        )
          ? "remote-write"
          : null;
      if (["auth", "secret"].includes(verb)) return "credential-access";
      if (verb === "release") return "remote-write";
      return writes[verb]?.includes(rest[0]) ? `gh-${verb}-${rest[0]}` : null;
    },
    glab: () =>
      verb === "mr" && ["create", "merge"].includes(rest[0])
        ? `glab-mr-${rest[0]}`
        : null,
    rm: () =>
      args.some(
        (arg) =>
          /^-[a-zA-Z]*[rRf]/.test(arg) ||
          arg === "--recursive" ||
          arg === "--force",
      )
        ? "force-delete"
        : null,
    find: () => (args.includes("-delete") ? "force-delete" : null),
    npm: () =>
      hasFlag(args, "-g") ||
      args.includes("--global") ||
      ["link", "publish", "login", "adduser", "token"].includes(verb)
        ? "global-install-or-remote-write"
        : null,
    pnpm: () =>
      hasFlag(args, "-g") || args.includes("--global")
        ? "global-install"
        : null,
    yarn: () => (verb === "global" ? "global-install" : null),
    bun: () =>
      hasFlag(args, "-g") || args.includes("--global")
        ? "global-install"
        : null,
    brew: () =>
      ["install", "upgrade", "uninstall", "tap", "link"].includes(verb)
        ? "global-install"
        : null,
    pipx: () => (verb === "install" ? "global-install" : null),
    cargo: () => (verb === "install" ? "global-install" : null),
    go: () => (verb === "install" ? "global-install" : null),
    security: () => "credential-access",
    "ssh-add": () => "credential-access",
    curl: () =>
      args.some(
        (arg, i) =>
          (HTTP_WRITE.test(arg) &&
            /^(POST|PUT|PATCH|DELETE)$/i.test(args[i + 1] ?? "")) ||
          /^(-d|-F|-T|--data.*|--form|--upload-file|--json)$/.test(arg),
      )
        ? "remote-write"
        : null,
    wget: () =>
      args.some((arg) => /^--(post-data|post-file|method)/.test(arg))
        ? "remote-write"
        : null,
    scp: () => "remote-write",
    sftp: () => "remote-write",
    ssh: () => "remote-write",
  };
  return rules[name]?.() ?? null;
}

const USER_CONFIG_REL =
  "(?:\\.claude(?:\\.json)?|\\.codex|\\.gemini|\\.ssh|\\.aws|\\.gnupg|\\.npmrc|\\.netrc|\\.git-credentials|\\.config/(?:gh|gcloud))(?:/|$)";
const USER_CONFIG_TEXT = new RegExp(
  `^(?:~|\\$HOME|\\$\\{HOME\\}|/(?:Users|home)/[^/]+)/${USER_CONFIG_REL}`,
);
const USER_CONFIG_UNDER_HOME = new RegExp(`^${USER_CONFIG_REL}`);
const CREDENTIAL_FILE =
  /(^|[\\/])(\.env(\.[\w.-]+)?|id_rsa|id_ed25519|\.netrc|\.git-credentials|credentials\.json)$/;

// Windows reports a role's paths with backslashes and ignores case, so scope
// comparisons pick `path.win32` and fold case there instead of assuming
// POSIX; `pathWithin` in usage-sources.mjs follows the same rule.
function pathLib(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}
// `~`, `$HOME` and `${HOME}` expand only when a separator or the end of the
// word follows. POSIX only accepts `/` there, since a backslash can be part
// of a POSIX filename; win32 additionally accepts `\`, the separator its own
// shells (including PowerShell's `$HOME`) write after a home marker.
const HOME_MARKER = /^(~|\$HOME|\$\{HOME\})(?=\/|$)/;
const HOME_MARKER_WIN32 = /^(~|\$HOME|\$\{HOME\})(?=[\\/]|$)/;
const foldCase = (value, platform) =>
  platform === "win32" ? value.toLowerCase() : value;
// A word "looks like a path" when it has a separator, a home marker or a
// leading `.`/`..`/`.env`. Windows also spells an absolute path with a drive
// letter and no `/` at all (`C:\Users\x`), so win32 additionally counts a
// backslash and a leading drive letter as path indicators.
const looksLikePath = (text, platform) =>
  platform === "win32"
    ? /[/~$\\]|^[A-Za-z]:|^\.\.?$|^\.env/.test(text)
    : /[/~$]|^\.\.?$|^\.env/.test(text);
// Rewrites a lib-relative path to the forward-slash spelling every task
// contract and the config-directory patterns are written in.
const toContractPath = (value, lib) => value.split(lib.sep).join("/");

function inside(dir, target, platform = process.platform) {
  const lib = pathLib(platform);
  const a = foldCase(dir, platform);
  const b = foldCase(target, platform);
  return b === a || b.startsWith(a + lib.sep);
}

// Turns a word into a path when it looks like one; `named` says the caller
// already knows it is a path. `unresolved` is set when the word cannot be
// pinned to one absolute path without the shell.
function pathOf(
  word,
  { cwd, home, platform = process.platform },
  named = false,
) {
  const lib = pathLib(platform);
  const text = String(word)
    .replace(/^[<>]+/, "")
    .replace(/^--?[\w-]+=/, "");
  if (!named && !looksLikePath(text, platform)) return null;
  const homeMarker = platform === "win32" ? HOME_MARKER_WIN32 : HOME_MARKER;
  const expanded = text.replace(homeMarker, home ?? "\u0000");
  const unresolved =
    /[$*?[\]{}\u0000]/.test(expanded) || (!lib.isAbsolute(expanded) && !cwd);
  return {
    text,
    unresolved,
    abs: unresolved ? null : lib.resolve(cwd ?? "/", expanded),
  };
}

function zoneOf(target, scope) {
  const platform = scope.platform ?? process.platform;
  const lib = pathLib(platform);
  if (
    target.abs &&
    scope.worktree &&
    inside(lib.resolve(scope.worktree), target.abs, platform)
  )
    return "worktree";
  if (
    target.abs &&
    scope.ownerCheckout &&
    inside(lib.resolve(scope.ownerCheckout), target.abs, platform)
  )
    return "owner-checkout";
  if (
    target.abs &&
    (scope.otherWorktrees ?? []).some((dir) =>
      inside(lib.resolve(dir), target.abs, platform),
    )
  )
    return "other-worktree";
  return "outside";
}

function forbiddenPath(target, scope) {
  const platform = scope.platform ?? process.platform;
  const lib = pathLib(platform);
  const rel =
    target.abs &&
    scope.home &&
    inside(lib.resolve(scope.home), target.abs, platform)
      ? toContractPath(lib.relative(scope.home, target.abs), lib)
      : "";
  if (
    USER_CONFIG_TEXT.test(target.text) ||
    USER_CONFIG_UNDER_HOME.test(foldCase(rel, platform))
  )
    return "user-config-path";
  if (
    CREDENTIAL_FILE.test(target.text) ||
    (target.abs && CREDENTIAL_FILE.test(target.abs))
  )
    return "credential-path";
  const zone = zoneOf(target, scope);
  return zone === "owner-checkout" || zone === "other-worktree"
    ? `${zone}-path`
    : null;
}

const normalizeEntry = (entry) => String(entry).replace(/^\.\//, "");
function allowedFile(rel, entries, platform = process.platform) {
  const target = foldCase(rel, platform);
  return entries
    .map(normalizeEntry)
    .map((entry) => foldCase(entry, platform))
    .some(
      (entry) =>
        target === entry || (entry.endsWith("/") && target.startsWith(entry)),
    );
}

/**
 * Judges whether a command or file target stays inside a role's approved scope.
 *
 * The result is `deny` when a forbidden rule applies (push, merge, reset --hard,
 * clean -f, forced delete, global install, remote write, credentials, the owner
 * checkout, another role's worktree, user configuration files), `allow` only
 * when every check passes, and `escalate` when anything cannot be decided. A
 * command is allowed only when it equals one of the contract's check commands
 * and runs in the role's worktree; a path is allowed only when it is inside the
 * worktree and matches an allowed file. Paths are compared after lexical
 * normalization, so symlinks are not followed.
 *
 * @param {{command?: string, cwd?: string, paths?: string[]}} request - What the approval asks to run or write.
 * @param {{worktree?: string, ownerCheckout?: string, otherWorktrees?: string[], home?: string,
 *   allowedFiles?: string[], checks?: Array<string[]|string>, platform?: string}} scope - The role's worktree,
 *   the task contract's files and checks, and the path rules to judge them by (`process.platform` when omitted).
 * @returns {{verdict: string, reasons: Array<{rule: string, detail: string}>, passed: string[]}} `allow`, `deny` or `escalate`, with the rules that decided it.
 */
export function judgeCommandScope(request, scope) {
  const ctx = scope ?? {};
  const platform = ctx.platform ?? process.platform;
  const lib = pathLib(platform);
  const command =
    typeof request?.command === "string" ? request.command.trim() : "";
  const cwd = request?.cwd ?? null;
  // A relative working folder cannot be resolved against itself.
  const cwdTarget = cwd
    ? (pathOf(cwd, { cwd: null, home: ctx.home, platform }) ?? {
        text: cwd,
        abs: null,
        unresolved: true,
      })
    : null;
  const explicit = (request?.paths ?? [])
    .map((item) => pathOf(item, { cwd, home: ctx.home, platform }, true))
    .filter(Boolean);
  const words = segments(command).flat();
  const targets = [
    ...words
      .map((word) => pathOf(word, { cwd, home: ctx.home, platform }))
      .filter(Boolean),
    ...explicit,
  ];
  if (cwdTarget) targets.push(cwdTarget);

  const deny = [];
  for (const tokens of segments(command)) {
    const rule = forbiddenRule(commandOf(tokens));
    if (rule)
      deny.push({ rule, detail: `금지된 명령입니다: ${tokens.join(" ")}` });
  }
  for (const target of targets) {
    const rule = forbiddenPath(target, ctx);
    if (rule) deny.push({ rule, detail: `금지된 경로입니다: ${target.text}` });
  }
  if (deny.length > 0) return { verdict: "deny", reasons: deny, passed: [] };

  const escalate = [];
  const passed = [];
  const note = (rule, detail) => escalate.push({ rule, detail });
  if (!ctx.worktree)
    note(
      "scope-context-missing",
      "역할 워크트리를 알 수 없어 범위를 판정할 수 없습니다.",
    );
  if (!Array.isArray(ctx.allowedFiles) && !Array.isArray(ctx.checks))
    note(
      "scope-context-missing",
      "task 계약의 허용 파일과 검사 명령을 알 수 없어 범위를 판정할 수 없습니다.",
    );
  if (!command && explicit.length === 0)
    note(
      "nothing-to-judge",
      "판정할 명령이나 경로가 화면에서 확인되지 않았습니다.",
    );
  if (
    (command || explicit.some((target) => !lib.isAbsolute(target.text))) &&
    !cwd
  )
    note(
      "cwd-unknown",
      "명령을 실행할 폴더를 알 수 없어 범위를 판정할 수 없습니다.",
    );
  if (cwd && ctx.worktree) {
    if (
      !cwdTarget.abs ||
      !inside(lib.resolve(ctx.worktree), cwdTarget.abs, platform)
    )
      note(
        "cwd-outside-worktree",
        `실행 폴더 "${cwd}"가 역할 워크트리 안인지 확인되지 않았습니다.`,
      );
    else passed.push(`cwd:${cwd}`);
  }
  if (command) {
    // A line break separates commands in a shell, so it is never folded into a
    // space: only spaces and tabs are normalized, and a break never matches.
    const words = (text) => text.split(/[ \t]+/).join(" ");
    const given = words(command.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ""));
    const known =
      !/[\r\n]/.test(command.trim()) &&
      (ctx.checks ?? []).some(
        (check) => words([].concat(check).join(" ")) === given,
      );
    if (known) passed.push(`check-command:${given}`);
    else
      note(
        "command-not-in-checks",
        `명령 "${command}"가 task 계약의 검사 명령이 아닙니다.`,
      );
  }
  for (const target of explicit) {
    if (target.unresolved)
      note(
        "path-unresolved",
        `경로 "${target.text}"를 하나의 절대 경로로 정할 수 없습니다.`,
      );
    else if (zoneOf(target, ctx) !== "worktree")
      note(
        "path-outside-worktree",
        `경로 "${target.text}"가 역할 워크트리 밖입니다.`,
      );
    else if (
      !allowedFile(
        toContractPath(
          lib.relative(lib.resolve(ctx.worktree), target.abs),
          lib,
        ),
        ctx.allowedFiles ?? [],
        platform,
      )
    )
      note(
        "path-not-in-allowed-files",
        `경로 "${target.text}"가 task 계약의 허용 파일이 아닙니다.`,
      );
    else passed.push(`allowed-file:${target.text}`);
  }
  return escalate.length > 0
    ? { verdict: "escalate", reasons: escalate, passed }
    : { verdict: "allow", reasons: [], passed };
}

// A choice that widens the grant beyond this one request.
const BROADENING =
  /always|don'?t ask again|for (this|the) session|every time|항상|세션 동안|다시 묻지/i;

/**
 * Decides whether to allow a command approval once, from its scope and choices.
 *
 * No approval screen was captured for any CLI, so this takes the choices from
 * the caller instead of reading them off a screen, and sends only a key the
 * caller attached to the choice. The choice with `grant: "once"` is the only
 * one ever picked; a choice that grants "always" or for the session is never
 * picked, and one labelled that way but marked `once` makes the decision
 * `escalate`. Without a `once` choice, a key or a known selection, nothing is
 * sent.
 *
 * @param {object} input - The approval as the caller parsed it.
 * @param {{command?: string, cwd?: string, paths?: string[]}} input.request - What the approval asks to run or write.
 * @param {Array<{label: string, grant: string, key?: object}>} input.choices - Choices in screen order; `grant` is `once`, `always` or `deny`.
 * @param {number} input.selected - Index in `choices` of the currently selected choice.
 * @param {object} input.scope - The scope passed to `judgeCommandScope`.
 * @returns {object} Same shape as `classifyPromptScreen`: `send-key` for the one allowed choice, `escalate` when undecidable, `none` when forbidden.
 */
export function decideApproval({ request, choices, selected, scope }) {
  const scopeResult = judgeCommandScope(request, scope);
  const evidence = {
    matched: (choices ?? []).map((choice) => choice.label),
    selected: null,
    scope: scopeResult,
  };
  const stop = (action, reason) =>
    outcome("approval", action, { reason, evidence });
  const detail = scopeResult.reasons.map((item) => item.detail).join(" ");
  if (scopeResult.verdict === "deny")
    return stop("none", `범위 판정이 금지입니다. ${detail}`);
  if (scopeResult.verdict === "escalate")
    return stop("escalate", `범위를 판정할 수 없어 PM에게 올립니다. ${detail}`);
  const list = choices ?? [];
  if (!Number.isInteger(selected) || !list[selected])
    return stop(
      "escalate",
      "현재 선택된 선택지를 확인할 수 없어 PM에게 올립니다.",
    );
  evidence.selected = { index: selected + 1, label: list[selected].label };
  // The key sent is the selected row's confirmation, so the selected row itself
  // must be the once-only grant; a key computed for another row would be wrong.
  if (list[selected].grant !== "once")
    return stop(
      "escalate",
      "현재 선택된 선택지가 한 번만 허용이 아니라서 Enter를 보내면 다른 권한이 승인되므로 PM에게 올립니다.",
    );
  if (
    list.some(
      (choice) => choice.grant === "once" && BROADENING.test(choice.label),
    )
  )
    return stop(
      "escalate",
      "한 번만 허용으로 표시된 선택지의 문구가 허용 범위를 넓혀 PM에게 올립니다.",
    );
  const once = list.filter((choice) => choice.grant === "once");
  if (once.length !== 1)
    return stop(
      "escalate",
      "한 번만 허용하는 선택지를 하나로 정할 수 없어 PM에게 올립니다.",
    );
  if (once[0] !== list[selected])
    return stop(
      "escalate",
      "선택된 선택지와 한 번만 허용하는 선택지가 달라 PM에게 올립니다.",
    );
  const key = once[0].key;
  if (!key)
    return stop(
      "escalate",
      "한 번만 허용하는 선택지에 보낼 키가 확인되지 않아 PM에게 올립니다.",
    );
  // Only a bare Enter confirms the selected row. Esc cancels, Down moves the
  // selection, and text or a no-newline send would not confirm anything.
  if (key.name !== "Enter" || key.send?.text !== "" || key.send?.enter !== true)
    return stop(
      "escalate",
      "보낼 키가 선택된 선택지를 확정하는 Enter가 아니라 PM에게 올립니다.",
    );
  return outcome("approval", "send-key", {
    key,
    evidence: { ...evidence, chosen: once[0].label },
  });
}
