/** Role terminals: bypass flags, unsubmitted commands, trust reopening, and role tab titles. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  PERMISSION_BYPASS,
  roleCommand,
} from "../plugins/oh-my-teams/scripts/role-launch.mjs";
import {
  agentStarted,
  clearRoleTerminal,
  commandPending,
  commandTyping,
  freshContextDecision,
  AGY_BANNER_COLUMNS,
  launchLine,
  openRoleTerminal,
  roleTitle,
  trustQuestion,
  untouchedShell,
  workerTerminal,
  worktreeLabel,
} from "../plugins/oh-my-teams/scripts/role-terminal.mjs";
import {
  ALLOWED_OPTIONS,
  parseArgs,
} from "../plugins/oh-my-teams/scripts/teams-org.mjs";
import {
  readLaunches,
  recordLaunch,
} from "../plugins/oh-my-teams/scripts/usage-ledger.mjs";

const example = () =>
  readJSON(path.resolve("plugins/oh-my-teams/examples/organization.json"));
const PROMPT = "me@host project %";

// Plays Orca's terminal verbs; the last screen repeats once the script ends.
// Each create issues the next handle, `closeFails` makes close refuse, and
// `terminals` is what list reports for the worktree, and `screens` by handle
// gives other terminals' screens.
function fakeOrca(
  screens,
  { closeFails = false, terminals = [], screens: others = {} } = {},
) {
  const calls = [];
  let created = 0;
  const execute = async (argv) => {
    const [, noun, verb] = argv;
    calls.push(argv.slice(1, -1));
    assert.equal(noun, "terminal");
    const reply = (result) => ({
      code: 0,
      stdout: JSON.stringify({ ok: true, result }),
    });
    if (verb === "create") {
      created += 1;
      return reply({ terminal: { handle: `term_${created}` } });
    }
    // An idle shell satisfies tui-idle too, so the wait decides nothing.
    if (verb === "wait") return reply({ wait: { satisfied: true } });
    if (verb === "read") {
      const other = others[argv[argv.indexOf("--terminal") + 1]];
      if (other) return reply({ terminal: { tail: other } });
      const tail = screens.length > 1 ? screens.shift() : screens[0];
      return reply({ terminal: { tail } });
    }
    if (verb === "send") return reply({ send: { accepted: true } });
    if (verb === "list") return reply({ terminals });
    if (verb === "rename") return reply({ rename: { title: argv.at(-2) } });
    if (verb === "close") {
      if (closeFails) return { code: 1, stderr: "terminal is busy" };
      return reply({ close: { closed: true } });
    }
    throw new Error(`unexpected verb ${verb}`);
  };
  const of = (name) => () => calls.filter((call) => call[1] === name);
  return {
    calls,
    execute,
    sends: of("send"),
    creates: of("create"),
    closes: of("close"),
    renames: of("rename"),
  };
}

// The screens below are a POSIX host's. On Windows the example's Gemini Senior
// is refused before a terminal opens, so these tests name their platform
// rather than inheriting the host's.
const fast = {
  settleMs: 5,
  readyMs: 20,
  pollMs: 1,
  platform: "darwin",
  allowUnverified: true,
  allowUnverifiedApproval: "test-approved",
};
const typedFor = (command) => launchLine(command, "darwin").typed;

test("every role command runs tools without an approval prompt", () => {
  // Nobody answers an approval prompt in a role terminal, and Orca adds its
  // bypass flag only to a bare agent name, never to `agy` or a pinned model.
  const org = example();
  for (const [role, provider] of [
    ["pm", "claude"],
    ["senior", "agy"],
  ]) {
    const command = roleCommand(org, role);
    assert.equal(command.provider, provider);
    assert.equal(command.argv[1], PERMISSION_BYPASS[provider]);
    assert.equal(command.permissionBypass, PERMISSION_BYPASS[provider]);
  }
  org.roles.pm.profile = "codex-terra";
  assert.equal(
    roleCommand(org, "pm").argv[1],
    "--dangerously-bypass-approvals-and-sandbox",
  );

  // A profile adding arguments of its own is refused before any flag is
  // added, so Codex never receives its bypass flag twice.
  org.profiles["codex-terra"].command = [
    "codex",
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  assert.throws(() => roleCommand(org, "pm"), /plain command/);
});

test("an Agy Gemini role is launched narrow enough for Orca to see it idle", async () => {
  // #41: at Orca's width Agy 1.2.4 draws its logo left of the banner, the
  // model line starts with logo glyphs, and Orca never reports tui-idle, so
  // worker-start refused every Agy role.
  const org = example();
  const gemini = roleCommand(org, "senior");
  assert.equal(gemini.modelRequested, "gemini-3.8-flash-high");
  assert.deepEqual(launchLine(gemini, "darwin"), {
    typed: `stty cols ${AGY_BANNER_COLUMNS}; ${gemini.command}`,
    columns: AGY_BANNER_COLUMNS,
  });
  // Windows skips the width adjustment: combining mode con: with agy in one
  // line keeps powershell.exe as the foreground process and Orca cannot detect
  // the agent. The matrix blocks that path; on Windows Agy Gemini either runs
  // through allowUnverified or headless.
  assert.deepEqual(launchLine(gemini, "win32"), {
    typed: gemini.command,
    columns: null,
  });
  assert.equal(
    launchLine(gemini, "linux").typed,
    launchLine(gemini, "darwin").typed,
  );
  // A non-Gemini model fails Orca's check at any width.
  const claudeOnAgy = roleCommand(org, "junior");
  assert.equal(launchLine(claudeOnAgy, "linux").columns, null);
  assert.equal(launchLine(roleCommand(org, "pl"), "linux").columns, null);

  const { typed } = launchLine(gemini, "darwin");
  const orca = fakeOrca([
    [
      `${PROMPT} ${typed}`,
      "  Antigravity CLI 1.2.4",
      "  Gemini 3.8 Flash (High)",
      ">",
    ],
  ]);
  const opened = await openRoleTerminal({
    worktree: "id:repo::/tmp/wt",
    command: gemini,
    execute: orca.execute,
    ...fast,
    platform: "darwin",
  });
  assert.equal(orca.creates()[0][7], typed);
  assert.equal(opened.ready, true);
  assert.equal(opened.submission, "orca");
  assert.equal(opened.launched, typed);
  assert.equal(opened.columns, AGY_BANNER_COLUMNS);
});

test("a command left at the prompt is told apart from a started agent", () => {
  const command =
    "agy --dangerously-skip-permissions --model gemini-3.8-flash-high";
  // The reported screen: a partial echo, then the whole command waiting.
  const waiting = [
    `${PROMPT} agy --model gemini-3.8-f`,
    `${PROMPT} ${command}`,
    "",
  ];
  assert.equal(commandPending(waiting, command), true);
  assert.equal(agentStarted(waiting, command), false);
  assert.equal(agentStarted([command], command), false);
  // A long command wraps, and the break may swallow the space.
  const wrapped = [
    `${PROMPT} agy --dangerously-skip-permissions --model gemini-3.8-flash`,
    "-high",
  ];
  assert.equal(commandPending(wrapped, command), true);
  assert.equal(agentStarted(wrapped, command), false);
  // A started agent draws below the command, or redraws the whole screen.
  const drawn = [...wrapped, "Antigravity CLI 1.2.4", ">", "? for shortcuts"];
  assert.equal(commandPending(drawn, command), false);
  assert.equal(agentStarted(drawn, command), true);
  assert.equal(
    agentStarted(["Claude Code", "❯", "  ⏵⏵ bypass"], command),
    true,
  );
  // The same prompt returned: the command ran and exited.
  const exited = [`${PROMPT} ${command}`, "unknown flag", PROMPT];
  assert.equal(commandPending(exited, command), false);
  assert.equal(agentStarted(exited, command), false);
  assert.equal(agentStarted([], command), false);
});

test("a command still being echoed is neither pending nor a started agent", async () => {
  // Confirmed against the previous code by feeding it every prefix of the
  // command: each cut-off line read as `started`. Not confirmed: that a real
  // shell echoes this way, or that it was the path of the incident where
  // ready: true came back with the command still in the input line.
  const command =
    "claude --dangerously-skip-permissions --model opus[1m] --autocompact 250k";
  const cutOffs = [
    [`${PROMPT} cla`],
    [`${PROMPT} claude --dangerously-skip-permis`],
    [
      `${PROMPT} claude --dangerously-skip-permissions --model opus[1m] --a`,
      "ut",
    ],
  ];
  for (const screen of cutOffs) {
    assert.equal(commandTyping(screen, command), true, screen.join("|"));
    assert.equal(commandPending(screen, command), false);
    assert.equal(agentStarted(screen, command), false);
  }
  // The whole command is pending, not typing; a bare prompt is neither.
  const whole = [`${PROMPT} ${command}`];
  assert.equal(commandTyping(whole, command), false);
  assert.equal(commandPending(whole, command), true);
  assert.equal(commandTyping([PROMPT], command), false);
  assert.equal(commandTyping(["Claude Code", "❯"], command), false);
});

test("Enter waits for the echo to finish and is then sent exactly once", async () => {
  const command = roleCommand(example(), "senior");
  const line = typedFor(command);
  const cut = `${PROMPT} ${line.slice(0, 20)}`;
  const whole = `${PROMPT} ${line}`;
  // The first reads see a partial echo, then the whole line, then, once Enter
  // has been sent, the agent.
  let reads = 0;
  let entered = false;
  const calls = [];
  const execute = async (argv) => {
    const verb = argv[2];
    calls.push(argv.slice(1, -1));
    const reply = (result) => ({
      code: 0,
      stdout: JSON.stringify({ ok: true, result }),
    });
    if (verb === "create") return reply({ terminal: { handle: "term_1" } });
    if (verb === "wait") return reply({ wait: { satisfied: true } });
    if (verb === "read") {
      reads += 1;
      if (entered)
        return reply({ terminal: { tail: [whole, "Antigravity", ">"] } });
      return reply({ terminal: { tail: [reads <= 3 ? cut : whole] } });
    }
    if (verb === "send") {
      // Never Enter over a cut-off line.
      assert.ok(
        reads > 3,
        "Enter was sent while the command was still echoing",
      );
      entered = true;
      return reply({ send: { accepted: true } });
    }
    if (verb === "list") return reply({ terminals: [] });
    if (verb === "rename") return reply({ rename: { title: "x" } });
    throw new Error(`unexpected verb ${verb}`);
  };
  const opened = await openRoleTerminal({
    worktree: "active",
    command,
    execute,
    settleMs: 5,
    readyMs: 200,
    pollMs: 1,
    platform: "darwin",
    allowUnverified: true,
    allowUnverifiedApproval: "test-approved",
  });
  assert.equal(opened.ready, true);
  assert.equal(opened.submission, "enter-sent");
  assert.equal(calls.filter((call) => call[1] === "send").length, 1);

  // An echo that never finishes is reported blocked, without any Enter.
  const stuck = fakeOrca([[cut]]);
  const blocked = await openRoleTerminal({
    worktree: "active",
    command,
    execute: stuck.execute,
    ...fast,
  });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(stuck.sends(), []);
});

test("a role terminal Orca started itself gets no extra Enter", async () => {
  const command = roleCommand(example(), "senior");
  const orca = fakeOrca([
    [`${PROMPT} ${typedFor(command)}`, "Antigravity", ">"],
  ]);
  const opened = await openRoleTerminal({
    worktree: "id:repo::/tmp/wt",
    command,
    executable: "orca",
    execute: orca.execute,
    ...fast,
  });
  assert.equal(opened.submission, "orca");
  assert.equal(opened.trust, "not-asked");
  assert.equal(opened.reopened, null);
  assert.equal(opened.ready, true);
  assert.equal(opened.status, undefined);
  assert.equal(opened.screenCheck, "required");
  assert.deepEqual(orca.calls[0], [
    "terminal",
    "create",
    "--worktree",
    "id:repo::/tmp/wt",
    "--title",
    "[Senior] wt",
    "--command",
    typedFor(command),
  ]);
  assert.deepEqual(orca.sends(), []);
  assert.deepEqual(orca.closes(), []);
  assert.equal(opened.title, "[Senior] wt");
  assert.equal(opened.titlePinned, true);
});

test("a typed but unsubmitted command is sent Enter exactly once", async () => {
  const command = roleCommand(example(), "senior");
  const typed = [`${PROMPT} ${typedFor(command)}`];
  const started = fakeOrca([typed, typed, [...typed, "Antigravity", ">"]]);
  const opened = await openRoleTerminal({
    worktree: "active",
    command,
    execute: started.execute,
    settleMs: 0,
    readyMs: 50,
    pollMs: 1,
    platform: "darwin",
    allowUnverified: true,
    allowUnverifiedApproval: "test-approved",
  });
  assert.equal(opened.submission, "enter-sent");
  assert.equal(opened.ready, true);
  assert.equal(started.sends().length, 1);

  // Still at the prompt after the Enter: reported, never pressed again.
  const stuck = fakeOrca([typed]);
  const blocked = await openRoleTerminal({
    worktree: "active",
    command,
    execute: stuck.execute,
    ...fast,
  });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(stuck.sends(), [
    ["terminal", "send", "--terminal", "term_1", "--text", "", "--enter"],
  ]);
  // A terminal that never became ready is not named as a working role.
  assert.deepEqual(stuck.renames(), []);
  assert.equal(blocked.titlePinned, false);
});

test("a ready role tab is renamed with its role tag after the agent starts", async () => {
  // A PM opened with --title later showed the agent's session title, because
  // Orca can rebuild a tab without the title given at creation.
  const command = roleCommand(example(), "pm");
  const orca = fakeOrca([
    [`${PROMPT} ${typedFor(command)}`, "Claude Code", "❯"],
  ]);
  const opened = await openRoleTerminal({
    worktree: "id:repo::/work/literacy-site-research-2",
    command,
    title: "PM: 문해력 사이트 조사",
    execute: orca.execute,
    ...fast,
  });
  const title = "[PM] PM: 문해력 사이트 조사";
  assert.equal(orca.calls[0][5], title);
  assert.deepEqual(orca.renames(), [
    ["terminal", "rename", "--terminal", "term_1", "--title", title],
  ]);
  assert.ok(
    orca.calls.findIndex((call) => call[1] === "rename") >
      orca.calls.findLastIndex((call) => call[1] === "read"),
  );
  assert.equal(opened.titlePinned, true);

  // A failed rename leaves an unnamed tab, not a failed launch.
  const refusing = async (argv, options) =>
    argv[2] === "rename"
      ? { code: 1, stdout: "", stderr: "no tab" }
      : orca.execute(argv, options);
  const unnamed = await openRoleTerminal({
    worktree: "active",
    command,
    execute: refusing,
    ...fast,
  });
  assert.equal(unnamed.ready, true);
  assert.equal(unnamed.title, "[PM]");
  assert.equal(unnamed.titlePinned, false);
});

test("the worktree's unused plain shell is closed, other tabs are not", async () => {
  // The literacy-test PM worktree held the PM tab and an untitled
  // shell that `worktree create` opened. Renaming that shell did not last:
  // Orca kept `Terminal 1` for a tab it had not shown.
  const command = roleCommand(example(), "pm");
  const agent = [`${PROMPT} ${typedFor(command)}`, "Claude Code", "❯"];
  const screens = {
    term_shell: [PROMPT, ""],
    term_default: [PROMPT],
    term_used: [`${PROMPT} npm run dev`, "ready on :5173"],
  };
  const orca = fakeOrca([agent], {
    terminals: [
      { handle: "term_1", title: "✳ Claude Code", agentIdentity: "claude" },
      { handle: "term_shell", title: null },
      { handle: "term_default", title: "Terminal 3" },
      { handle: "term_used", title: "Terminal 4" },
      { handle: "term_named", title: "dev server" },
      { handle: "term_agent", title: "Terminal 5", agentIdentity: "codex" },
    ],
    screens,
  });
  const opened = await openRoleTerminal({
    worktree: "id:repo::/work/literacy-site-research-2",
    command,
    execute: orca.execute,
    ...fast,
  });
  assert.equal(opened.title, "[PM] literacy-site-research-2");
  assert.deepEqual(opened.shellsClosed, ["term_shell", "term_default"]);
  assert.deepEqual(
    orca.closes().map((call) => call[3]),
    ["term_shell", "term_default"],
  );
  // Only the role terminal is renamed; no shell is.
  assert.deepEqual(
    orca.renames().map((call) => call[3]),
    ["term_1"],
  );
  assert.equal(untouchedShell([PROMPT]), true);
  assert.equal(untouchedShell([`${PROMPT} ls`, "README.md", PROMPT]), false);
  assert.equal(untouchedShell([]), false);
});

test("role titles lead with the role tag and name the worktree", () => {
  assert.equal(roleTitle("pl", "literacy-pl"), "[PL] literacy-pl");
  assert.equal(
    roleTitle("junior", "[Junior] already tagged"),
    "[Junior] already tagged",
  );
  assert.equal(roleTitle("senior", null), "[Senior]");
  assert.throws(() => roleTitle("owner", "x"), /No title tag/);
  // Intern was removed in 2.6.0; no terminal is opened for it.
  assert.throws(() => roleTitle("intern", "x"), /No title tag/);
  assert.equal(
    worktreeLabel("id:repo-1::/Users/me/orca/workspaces/app/feat-a"),
    "feat-a",
  );
  assert.equal(worktreeLabel("path:C:\\work\\app\\feat-b"), "feat-b");
  assert.equal(worktreeLabel("name:feat-c"), "feat-c");
  assert.equal(worktreeLabel("active"), null);
  assert.equal(worktreeLabel(undefined), null);

  // The shape Orca returned for a worker it started in a new terminal.
  const receipt = {
    ok: true,
    result: {
      effects: [
        {
          kind: "worktree",
          action: "created",
          id: "repo-1::/w/app/literacy-junior",
        },
        { kind: "setup", action: "not_applicable" },
        { kind: "terminal", role: "agent", action: "created", id: "term_9" },
      ],
    },
  };
  assert.deepEqual(workerTerminal(receipt), {
    handle: "term_9",
    place: "literacy-junior",
  });
  assert.deepEqual(workerTerminal({ result: {} }, "term_2"), {
    handle: "term_2",
    place: null,
  });
  assert.deepEqual(workerTerminal(undefined), { handle: null, place: null });
});

test("Agy's folder trust question is answered once, only when trust is selected", async () => {
  const command = roleCommand(example(), "senior");
  const asked = [
    `${PROMPT} ${typedFor(command)}`,
    "Do you trust the contents of this project?",
    "> Yes, I trust this folder",
    "  No, exit",
  ];
  assert.equal(trustQuestion(asked), true);
  // With "No" selected, Enter would exit, so it is not the question answered.
  assert.equal(
    trustQuestion([
      "Do you trust the contents of this project?",
      "  Yes, I trust this folder",
      "> No, exit",
    ]),
    false,
  );

  const agent = [`${PROMPT} ${typedFor(command)}`, "Antigravity", ">"];
  const trusted = fakeOrca([asked, asked, agent]);
  const opened = await openRoleTerminal({
    worktree: "active",
    command,
    execute: trusted.execute,
    ...fast,
  });
  // The answered terminal keeps the question in its buffer, which Orca's
  // startup check blocks on, so a clean terminal is returned instead.
  assert.equal(opened.trust, "accepted");
  assert.equal(opened.terminal, "term_2");
  assert.deepEqual(opened.reopened, {
    closedTerminal: "term_1",
    reason: "trust-question-in-buffer",
  });
  assert.equal(opened.ready, true);
  assert.deepEqual(opened.screen, agent);
  assert.deepEqual(
    trusted.sends().map((call) => call[3]),
    ["term_1"],
  );
  assert.deepEqual(trusted.closes(), [
    ["terminal", "close", "--terminal", "term_1"],
  ]);
  assert.equal(trusted.creates().length, 2);
  // The title goes to the terminal that is kept, not the one closed.
  assert.deepEqual(
    trusted.renames().map((call) => [call[3], call[5]]),
    [["term_2", "[Senior]"]],
  );

  // A question that stays after one Enter blocks rather than repeating it,
  // and the terminal is kept as evidence.
  const repeated = fakeOrca([asked]);
  const blocked = await openRoleTerminal({
    worktree: "active",
    command,
    execute: repeated.execute,
    ...fast,
  });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reopened, null);
  assert.equal(repeated.sends().length, 1);
  assert.deepEqual(repeated.closes(), []);
});

test("a reopened terminal asking for trust again is blocked, not reopened", async () => {
  const command = roleCommand(example(), "senior");
  const asked = [
    `${PROMPT} ${typedFor(command)}`,
    "Do you trust the contents of this project?",
    "> Yes, I trust this folder",
  ];
  const answered = [`${PROMPT} ${typedFor(command)}`, ">"];
  // The question comes back in the second terminal: the trust was not kept.
  const forgot = fakeOrca([asked, asked, answered, answered, asked]);
  const opened = await openRoleTerminal({
    worktree: "active",
    command,
    execute: forgot.execute,
    ...fast,
  });
  assert.equal(opened.terminal, "term_2");
  assert.equal(opened.trust, "accepted");
  assert.equal(opened.reopened.closedTerminal, "term_1");
  assert.equal(opened.ready, false);
  assert.equal(opened.status, "blocked");
  assert.equal(forgot.sends().length, 1);
  assert.equal(forgot.closes().length, 1);
  assert.equal(forgot.creates().length, 2);
});

test("a trusted terminal that will not close is reported, not doubled", async () => {
  const command = roleCommand(example(), "senior");
  const asked = [
    `${PROMPT} ${typedFor(command)}`,
    "Do you trust the contents of this project?",
    "> Yes, I trust this folder",
  ];
  const stuck = fakeOrca(
    [asked, asked, [`${PROMPT} ${typedFor(command)}`, ">"]],
    {
      closeFails: true,
    },
  );
  const opened = await openRoleTerminal({
    worktree: "active",
    command,
    execute: stuck.execute,
    ...fast,
  });
  assert.equal(opened.terminal, "term_1");
  assert.equal(opened.trust, "accepted");
  assert.equal(opened.reopened, null);
  assert.match(opened.closeError, /terminal is busy/);
  assert.equal(opened.ready, false);
  assert.equal(opened.status, "blocked");
  assert.equal(stuck.creates().length, 1);
});

test("the launch documents open role terminals through role-terminal", () => {
  const runtime = fs.readFileSync(
    path.resolve("plugins/oh-my-teams/references/orca-runtime.md"),
    "utf8",
  );
  // Hand-typed `terminal create --command` left commands unsubmitted.
  assert.doesNotMatch(
    runtime,
    /terminal create --worktree id:<worktreeId> --command/,
  );
  assert.match(runtime, /node <runtime> role-terminal --org/);
  assert.match(runtime, /Enter를 한 번/);
  assert.match(runtime, /폴더 신뢰/);
  // An answered trust question stayed in the buffer and blocked worker-start.
  assert.match(runtime, /`reopened`/);
  assert.match(runtime, /agent-trust-workspace/);
  assert.match(runtime, /--dangerously-skip-permissions/);
  // A title given only at creation was lost, so the documents keep the tag
  // and the rename after start together.
  assert.match(runtime, /### 역할 탭 제목/);
  assert.match(runtime, /`\[PM\]`, `\[PL\]`/);
  assert.match(runtime, /agent가 뜬 뒤 `terminal rename`으로 다시 지정한다/);
});

test("on Windows an Agy Gemini role without approval is refused before any terminal opens", async () => {
  // 실측(Orca 1.4.204): Windows gemini+powershell → 8행(headless/verified).
  // headless 경로는 openRoleTerminal에서 blocked와 동일하게 throw되며
  // 이유 코드는 orca-idle-requires-narrow-screen.
  const org = example();
  const gemini = roleCommand(org, "senior");
  const calls = [];
  const execute = async (argv) => {
    calls.push(argv);
    return { code: 0, stdout: "{}" };
  };
  // Windows powershell + gemini → 8행 headless → orca-idle-requires-narrow-screen
  await assert.rejects(
    openRoleTerminal({
      worktree: "id:repo::C:/wt",
      command: gemini,
      executable: "orca",
      execute,
      settleMs: 5,
      readyMs: 20,
      pollMs: 1,
      platform: "win32",
      shell: "powershell",
      trustRecordExists: true,
      allowUnverified: false,
    }),
    /orca-idle-requires-narrow-screen/,
  );
  assert.equal(calls.length, 0);

  // A Claude role on Windows with skipPrompt is allowed (verified).
  const claude = roleCommand(org, "pm");
  assert.doesNotThrow(() => launchLine(claude, "win32"));
});

test("win32/POSIX별 실행 명령: POSIX에서만 폭 조정 명령이 붙는다", () => {
  const org = example();
  const gemini = roleCommand(org, "senior");
  assert.equal(gemini.provider, "agy");
  assert.match(gemini.modelRequested, /^gemini/i);

  // POSIX: stty cols 44 붙음
  const posix = launchLine(gemini, "darwin");
  assert.match(posix.typed, /stty cols 44/);
  assert.equal(posix.columns, AGY_BANNER_COLUMNS);

  // Linux도 POSIX
  const linux = launchLine(gemini, "linux");
  assert.match(linux.typed, /stty cols 44/);

  // Windows: 폭 조정 없음 (단일 명령만)
  const win = launchLine(gemini, "win32");
  assert.doesNotMatch(win.typed, /mode con/);
  assert.doesNotMatch(win.typed, /stty/);
  assert.equal(win.columns, null);
  assert.equal(win.typed, gemini.command);

  // Claude는 플랫폼 무관하게 폭 조정 없음
  const claude = roleCommand(org, "pm");
  assert.equal(launchLine(claude, "win32").columns, null);
  assert.equal(launchLine(claude, "darwin").columns, null);
});

test("실행 전 거부는 터미널 생성 호출을 일으키지 않는다", async () => {
  const org = example();
  const gemini = roleCommand(org, "senior");
  const calls = [];
  const execute = async (argv) => {
    calls.push(argv);
    return { code: 0, stdout: "{}" };
  };

  // Agy gemini win32 powershell → 8행 headless → orca-idle-requires-narrow-screen → 터미널 생성 없음
  // (단일 명령 → isCompoundCommand=false → 2행 건너뜀 → 8행 headless/verified)
  await assert.rejects(
    openRoleTerminal({
      worktree: "id:repo::C:/wt",
      command: gemini,
      executable: "orca",
      execute,
      platform: "win32",
      shell: "powershell",
      trustRecordExists: true,
      allowUnverified: false,
      ...{ settleMs: 5, readyMs: 20, pollMs: 1 },
    }),
    /orca-idle-requires-narrow-screen/,
  );
  // matrix 거부는 orca 호출 전에 일어남
  assert.equal(
    calls.length,
    0,
    "matrix refusal must not call orca terminal create",
  );

  // 신뢰 기록 없는 경우도 마찬가지
  const callsTrust = [];
  const executeTrust = async (argv) => {
    callsTrust.push(argv);
    return { code: 0, stdout: "{}" };
  };
  await assert.rejects(
    openRoleTerminal({
      worktree: "active",
      command: gemini,
      executable: "orca",
      execute: executeTrust,
      platform: "darwin",
      shell: "posix",
      trustRecordExists: false,
      allowUnverified: true,
      allowUnverifiedApproval: "test",
      ...{ settleMs: 5, readyMs: 20, pollMs: 1 },
    }),
    /agent-trust-workspace/,
  );
  assert.equal(
    callsTrust.length,
    0,
    "trust refusal must not call orca terminal create",
  );
});
test("headless 예측 시 터미널 생성 호출이 일어나지 않는다", async () => {
  // finding: missing-headless-refusal-test
  // Agy + win32 + posix shell + 신뢰 있음 + gpt-oss 모델 → 표 규칙 9 headless
  // headless는 터미널 경로가 아니므로, 터미널 생성 전에 거부해야 한다.
  const headlessCommand = {
    role: "senior",
    profile: "agy-gpt-oss",
    provider: "agy",
    argv: ["agy", "--dangerously-skip-permissions", "--model", "gpt-oss-120b"],
    command: "agy --dangerously-skip-permissions --model gpt-oss-120b",
    permissionBypass: "--dangerously-skip-permissions",
    modelRequested: "gpt-oss-120b",
    effortRequested: null,
  };
  const orcaCalls = [];
  const execute = async (argv) => {
    orcaCalls.push(argv);
    return { code: 0, stdout: "{}" };
  };

  // win32 + posix shell + 신뢰 있음 → rule 2 건너뜀(powershell 아님), rule 9 headless
  await assert.rejects(
    openRoleTerminal({
      worktree: "id:repo::C:/wt",
      command: headlessCommand,
      executable: "orca",
      execute,
      platform: "win32",
      shell: "posix",
      trustRecordExists: true,
      orcaVersion: "1.4.204",
      cliVersion: "1.2.5",
      allowUnverified: false,
      settleMs: 5,
      readyMs: 20,
      pollMs: 1,
    }),
    (err) => {
      assert.match(err.message, /headless/, "headless 거부 메시지 포함");
      return true;
    },
  );
  assert.equal(
    orcaCalls.length,
    0,
    "headless 예측 거부는 Orca terminal create를 호출하지 않는다",
  );
});

test("role-terminal CLI allow-unverified 옵션 처리", () => {
  // finding: missing-cli-verification-option
  // ALLOWED_OPTIONS에 allow-unverified가 등록되어 있어야 한다
  assert.ok(
    ALLOWED_OPTIONS["role-terminal"].includes("allow-unverified"),
    "role-terminal ALLOWED_OPTIONS에 allow-unverified가 있어야 한다",
  );

  // parseArgs: allow-unverified 는 값 옵션 (flag 아님)
  const parsed = parseArgs([
    "role-terminal",
    "--org",
    "org.json",
    "--role",
    "senior",
    "--worktree",
    "active",
    "--allow-unverified",
    "PM이 2026-09-17 승인",
  ]);
  assert.equal(
    parsed["allow-unverified"],
    "PM이 2026-09-17 승인",
    "allow-unverified 값이 파싱되어야 한다",
  );

  // 값 없이 사용하면 parseArgs가 에러를 던진다
  assert.throws(
    () =>
      parseArgs([
        "role-terminal",
        "--org",
        "org.json",
        "--role",
        "senior",
        "--worktree",
        "active",
        "--allow-unverified",
      ]),
    /Missing value/,
    "allow-unverified에 값이 없으면 parseArgs가 에러를 던져야 한다",
  );
});

test("readLaunchEnvironment 환경 읽기 주입 가능", async () => {
  // finding: optimistic-matrix-defaults
  // 환경 읽기 함수는 주입 가능한 실행기와 홈 디렉터리를 받아 결정적으로 동작해야 한다.
  const { readLaunchEnvironment } =
    await import("../plugins/oh-my-teams/scripts/role-terminal.mjs");
  const tmpDir = await import("node:os").then((m) => m.tmpdir());
  const fs = await import("node:fs");
  const path = await import("node:path");
  const tmpHome = path.join(tmpDir, "omt-test-env-" + Date.now());
  fs.mkdirSync(path.join(tmpHome, ".gemini", "antigravity-cli"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpHome, ".claude"), { recursive: true });
  const worktreePath = "C:/test/worktree";
  // Agy 설정: worktreePath 신뢰 있음
  fs.writeFileSync(
    path.join(tmpHome, ".gemini", "antigravity-cli", "settings.json"),
    JSON.stringify({ trustedWorkspaces: [worktreePath] }),
  );
  // Claude 설정: skipDangerousModePermissionPrompt=true
  fs.writeFileSync(
    path.join(tmpHome, ".claude", "settings.json"),
    JSON.stringify({ skipDangerousModePermissionPrompt: true }),
  );

  const orcaCalls = [];
  const fakeExecute = async (argv) => {
    orcaCalls.push(argv);
    const cmd = String(argv[0] ?? "");
    if (cmd.includes("orca") && argv[1] === "--version") {
      return { code: 0, stdout: "orca 1.4.204" };
    }
    if (cmd === "agy" && argv[1] === "--version") {
      return { code: 0, stdout: "agy 1.2.5" };
    }
    return { code: 1, stdout: "", stderr: "unknown" };
  };

  const env = await readLaunchEnvironment({
    worktreePath,
    homedir: tmpHome,
    execute: fakeExecute,
  });

  assert.equal(env.orcaVersion, "1.4.204", "orca 버전 읽기");
  assert.equal(env.cliVersion, "1.2.5", "agy 버전 읽기");
  assert.equal(env.trustRecordExists, true, "신뢰 기록 있음");
  assert.equal(env.skipDangerousModePermissionPrompt, true, "skipPrompt 읽기");
  assert.ok(["powershell", "posix"].includes(env.shell), "shell 값");

  // 신뢰 없는 경우
  fs.writeFileSync(
    path.join(tmpHome, ".gemini", "antigravity-cli", "settings.json"),
    JSON.stringify({ trustedWorkspaces: [] }),
  );
  const env2 = await readLaunchEnvironment({
    worktreePath,
    homedir: tmpHome,
    execute: fakeExecute,
  });
  assert.equal(env2.trustRecordExists, false, "신뢰 기록 없음");

  // 설정 파일 읽기 실패 시 unknown
  const env3 = await readLaunchEnvironment({
    worktreePath: "/nonexistent",
    homedir: "/nonexistent-home",
    execute: async () => {
      throw new Error("no orca");
    },
  });
  assert.equal(env3.orcaVersion, "unknown", "버전 읽기 실패 시 unknown");
  assert.equal(env3.trustRecordExists, "unknown", "설정 읽기 실패 시 unknown");
});

test("readLaunchEnvironment Codex 신뢰 기록 읽기: true·false·unknown", async () => {
  // finding: codex-trust-unknown — role-terminal.mjs가 Codex 신뢰 기록을 unknown으로 넘기던 버그 수정 검증.
  // 설정 내용을 주입해 true·false·unknown 세 경우를 결정적으로 확인한다.
  const { readLaunchEnvironment: readEnv } =
    await import("../plugins/oh-my-teams/scripts/role-terminal.mjs");
  const tmpDir = await import("node:os").then((m) => m.tmpdir());
  const fsM = await import("node:fs");
  const pathM = await import("node:path");

  const tmpBase = pathM.join(tmpDir, "omt-codex-trust-" + Date.now());
  // 임시 Codex 설정 디렉터리
  const codexDir = pathM.join(tmpBase, "codex-home");
  fsM.mkdirSync(codexDir, { recursive: true });
  const codexConfig = pathM.join(codexDir, "config.toml");

  // 주 저장소 루트 경로: git rev-parse 시뮬레이션을 위해 주입
  const fakeRepoRoot = "C:/Users/kjsun/orca/oh-my-teams";
  const fakeGitCommonDir = fakeRepoRoot + "/.git";

  // fakeExecute: git rev-parse는 fakeGitCommonDir 반환, 나머지는 실패
  const makeExecute = () => async (argv) => {
    if (argv[0] === "git" && argv.includes("--git-common-dir")) {
      return { code: 0, stdout: fakeGitCommonDir + "\n" };
    }
    // orca --version, agy --version → code:1 (unknown 유지)
    return { code: 1, stdout: "", stderr: "skip" };
  };

  // 케이스 1: trust_level = "trusted" → codexTrustRecordExists = true
  fsM.writeFileSync(
    codexConfig,
    `[projects."${fakeRepoRoot}"]\ntrust_level = "trusted"\n`,
  );
  const envTrue = await readEnv({
    worktreePath: fakeRepoRoot + "/some-worktree",
    homedir: tmpBase,
    codexHome: codexDir,
    execute: makeExecute(),
  });
  assert.equal(
    envTrue.codexTrustRecordExists,
    true,
    "trust_level=trusted → true",
  );

  // 케이스 2: 다른 경로 or trust_level 없음 → false
  fsM.writeFileSync(
    codexConfig,
    `[projects."C:/other/repo"]\ntrust_level = "trusted"\n`,
  );
  const envFalse = await readEnv({
    worktreePath: fakeRepoRoot + "/some-worktree",
    homedir: tmpBase,
    codexHome: codexDir,
    execute: makeExecute(),
  });
  assert.equal(envFalse.codexTrustRecordExists, false, "경로 불일치 → false");

  // 케이스 3: 설정 파일 없음 → unknown
  fsM.unlinkSync(codexConfig);
  const envUnknown = await readEnv({
    worktreePath: fakeRepoRoot + "/some-worktree",
    homedir: tmpBase,
    codexHome: codexDir,
    execute: makeExecute(),
  });
  assert.equal(
    envUnknown.codexTrustRecordExists,
    "unknown",
    "설정 파일 없음 → unknown",
  );

  // 케이스 추가: 큰따옴표 키에 TOML 이스케이프(\\ → \) — 실제 config.toml 형식
  fsM.mkdirSync(codexDir, { recursive: true });
  // 실제 config.toml: [projects."C:\Users\me\repo"] — \\ 두 글자가 실제 백슬래시 하나
  const escapedKey = "C:\\\\Users\\\\me\\\\repo"; // JS 문자열로 \\ 두 글자씩
  const repoRootForEscape = "C:/Users/me/repo";
  // git rev-parse 응답도 이 루트에 맞춰 재정의
  const makeExecuteForRepo = (root) => async (argv) => {
    if (argv[0] === "git" && argv.includes("--git-common-dir")) {
      return { code: 0, stdout: root + "/.git\n" };
    }
    return { code: 1, stdout: "", stderr: "skip" };
  };
  fsM.writeFileSync(
    codexConfig,
    // 파일 내용: [projects."C:\\Users\\me\\repo"]\ntrust_level = "trusted"\n
    // TOML 기본 문자열에서 \\ 두 글자 = 백슬래시 하나
    `[projects."${escapedKey}"]\ntrust_level = "trusted"\n`,
  );
  const envDoubleQuoteEscape = await readEnv({
    worktreePath: repoRootForEscape + "/wt",
    homedir: tmpBase,
    codexHome: codexDir,
    execute: makeExecuteForRepo(repoRootForEscape),
  });
  assert.equal(
    envDoubleQuoteEscape.codexTrustRecordExists,
    true,
    `큰따옴표 TOML 이스케이프(\\\\ → \\) 해제 후 true`,
  );

  // 케이스 추가: 작은따옴표(리터럴) 키 — 이스케이프 없음
  // [projects.'c:\users\me\repo'] — 백슬래시 그대로
  const singleQuoteRepoRoot = "c:/users/me/repo2";
  const singleQuoteLiteralKey = "c:\\users\\me\\repo2"; // \ 한 글자
  fsM.writeFileSync(
    codexConfig,
    `[projects.'${singleQuoteLiteralKey}']\ntrust_level = "trusted"\n`,
  );
  const envSingleQuote = await readEnv({
    worktreePath: singleQuoteRepoRoot + "/wt",
    homedir: tmpBase,
    codexHome: codexDir,
    execute: makeExecuteForRepo(singleQuoteRepoRoot),
  });
  assert.equal(
    envSingleQuote.codexTrustRecordExists,
    true,
    "작은따옴표 리터럴 키(이스케이프 없음) → true",
  );

  // 정리
  fsM.rmSync(tmpBase, { recursive: true, force: true });
});

test("Claude POSIX PM launches without approval and preserves evidence warnings and readiness", async () => {
  const command = roleCommand(example(), "pm");
  for (const orcaVersion of ["1.4.204", "1.4.205"]) {
    for (const started of [true, false]) {
      const orca = fakeOrca([
        started ? ["Claude Code v2.1.277", "Opus 4.6"] : [PROMPT],
      ]);
      const result = await openRoleTerminal({
        ...fast,
        allowUnverified: false,
        allowUnverifiedApproval: undefined,
        worktree: "id:repo::/pm",
        command,
        orcaVersion,
        executable: "orca",
        execute: orca.execute,
      });
      assert.equal(orca.creates().length, 1);
      assert.equal(result.provider, "claude");
      assert.equal(result.profile, command.profile);
      assert.equal(result.matrix.evidence, "unverified");
      assert.equal(result.matrix.platform, "darwin");
      assert.ok(result.warnings.includes("unverified-terminal-evidence"));
      assert.equal(
        result.warnings.includes("untested_patch_version"),
        orcaVersion === "1.4.205",
      );
      assert.equal(result.ready, started);
      assert.equal(result.screenCheck, "required");
      if (!started) assert.equal(result.status, "blocked");
    }
  }
});

test("a reused Claude terminal is cleared for a different task or any review, not for a rework", () => {
  const line = (extra) => ({
    via: "worker-start",
    at: "2026-09-21T00:00:00.000Z",
    terminal: "term_1",
    workflowId: "wf",
    workflowTaskId: "task-a",
    orcaTaskId: "orca_1",
    purpose: null,
    ...extra,
  });
  const ask = (extra) => ({
    terminal: "term_1",
    provider: "claude",
    workflowId: "wf",
    workflowTaskId: "task-a",
    orcaTaskId: null,
    purpose: null,
    ...extra,
  });
  // role-terminal lines and other terminals do not count as a previous task.
  const opened = [
    { via: "role-terminal", terminal: "term_1" },
    line({ terminal: "term_2", workflowTaskId: "task-z" }),
  ];
  assert.deepEqual(freshContextDecision(opened, ask()), {
    clear: false,
    reason: "first-task",
  });

  const history = [...opened, line()];
  assert.equal(freshContextDecision(history, ask()).reason, "same-task");
  assert.equal(freshContextDecision(history, ask()).clear, false);
  const other = freshContextDecision(
    history,
    ask({ workflowTaskId: "task-b" }),
  );
  assert.deepEqual(other, {
    clear: true,
    reason: "different-task",
    previousLaunchAt: "2026-09-21T00:00:00.000Z",
  });
  // The same task id in another workflow is another task.
  assert.equal(
    freshContextDecision(history, ask({ workflowId: "wf-2" })).clear,
    true,
  );
  // A spec-only start names no task, so it is treated as a different one.
  assert.equal(
    freshContextDecision(
      history,
      ask({ workflowId: null, workflowTaskId: null }),
    ).reason,
    "task-unidentified",
  );
  // An Orca task handed again with --task is the same task.
  assert.equal(
    freshContextDecision(
      [line({ workflowTaskId: null })],
      ask({ workflowTaskId: null, orcaTaskId: "orca_1" }),
    ).reason,
    "same-task",
  );
  // Reviews always start fresh, and so does the task after a review.
  assert.equal(
    freshContextDecision(history, ask({ purpose: "review" })).reason,
    "review",
  );
  assert.equal(
    freshContextDecision([line({ purpose: "review" })], ask()).reason,
    "purpose-changed",
  );
  // Only Claude terminals are cleared.
  for (const provider of ["codex", "agy"]) {
    assert.deepEqual(
      freshContextDecision(
        history,
        ask({ provider, workflowTaskId: "task-b" }),
      ),
      { clear: false, reason: "not-claude" },
    );
  }
});

test("clearRoleTerminal waits for idle, sends /clear, and waits for idle again", async () => {
  const calls = [];
  const idle = JSON.stringify({
    ok: true,
    result: { wait: { satisfied: true } },
  });
  const execute = async (argv) => {
    calls.push(argv);
    return {
      code: 0,
      stderr: "",
      timedOut: false,
      stdout: argv[2] === "wait" ? idle : '{"ok":true}',
    };
  };
  const result = await clearRoleTerminal({
    terminal: "term_1",
    executable: "orca",
    execute,
  });
  assert.deepEqual(result, { cleared: true, terminal: "term_1" });
  assert.deepEqual(
    calls.map((argv) => argv.slice(1, 3).join(" ")),
    ["terminal wait", "terminal send", "terminal wait"],
  );
  assert.deepEqual(calls[1], [
    "orca",
    "terminal",
    "send",
    "--terminal",
    "term_1",
    "--text",
    "/clear",
    "--enter",
    "--json",
  ]);

  // A busy terminal is refused before /clear is typed into it.
  const busy = [];
  await assert.rejects(
    () =>
      clearRoleTerminal({
        terminal: "term_1",
        executable: "orca",
        execute: async (argv) => {
          busy.push(argv);
          return {
            code: 0,
            stderr: "",
            timedOut: false,
            stdout: JSON.stringify({ ok: false, error: { code: "timeout" } }),
          };
        },
      }),
    (error) => error.signal?.code === "timeout",
  );
  assert.equal(busy.length, 1);
});

test("worker-start accepts the task identity and purpose that decide a clear", () => {
  for (const option of ["workflow-task", "purpose"]) {
    assert.ok(ALLOWED_OPTIONS["worker-start"].includes(option), option);
  }
});

test("the launch ledger records the task a worker-start handed over", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-ledger-task-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const orgFile = path.join(dir, ".omt", "organization.json");
  recordLaunch(orgFile, {
    via: "role-terminal",
    role: "senior",
    terminal: "term_1",
  });
  recordLaunch(orgFile, {
    via: "worker-start",
    role: "senior",
    terminal: "term_1",
    workflowId: "wf",
    workflowTaskId: "task-a",
    orcaTaskId: "orca_1",
    purpose: "review",
  });
  const [opened, started] = readLaunches(orgFile);
  assert.equal("workflowTaskId" in opened, false);
  assert.equal(started.workflowTaskId, "task-a");
  assert.equal(started.orcaTaskId, "orca_1");
  assert.equal(started.purpose, "review");
});
