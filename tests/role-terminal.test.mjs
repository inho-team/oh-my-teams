/** Role terminals: bypass flags, and a typed command that Orca left unsubmitted. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  PERMISSION_BYPASS,
  roleCommand,
} from "../plugins/oh-my-teams/scripts/role-launch.mjs";
import {
  agentStarted,
  commandPending,
  openRoleTerminal,
  trustQuestion,
} from "../plugins/oh-my-teams/scripts/role-terminal.mjs";

const example = () =>
  readJSON(path.resolve("plugins/oh-my-teams/examples/organization.json"));
const PROMPT = "me@host project %";

// Plays Orca's terminal verbs; the last screen repeats once the script ends.
// Each create issues the next handle, and `closeFails` makes close refuse.
function fakeOrca(screens, { closeFails = false } = {}) {
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
      const tail = screens.length > 1 ? screens.shift() : screens[0];
      return reply({ terminal: { tail } });
    }
    if (verb === "send") return reply({ send: { accepted: true } });
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
  };
}

const fast = { settleMs: 5, readyMs: 20, pollMs: 1 };

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

test("a role terminal Orca started itself gets no extra Enter", async () => {
  const command = roleCommand(example(), "senior");
  const orca = fakeOrca([[`${PROMPT} ${command.command}`, "Antigravity", ">"]]);
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
    "omt-senior",
    "--command",
    command.command,
  ]);
  assert.deepEqual(orca.sends(), []);
  assert.deepEqual(orca.closes(), []);
});

test("a typed but unsubmitted command is sent Enter exactly once", async () => {
  const command = roleCommand(example(), "senior");
  const typed = [`${PROMPT} ${command.command}`];
  const started = fakeOrca([typed, typed, [...typed, "Antigravity", ">"]]);
  const opened = await openRoleTerminal({
    worktree: "active",
    command,
    execute: started.execute,
    settleMs: 0,
    readyMs: 50,
    pollMs: 1,
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
});

test("Agy's folder trust question is answered once, only when trust is selected", async () => {
  const command = roleCommand(example(), "senior");
  const asked = [
    `${PROMPT} ${command.command}`,
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

  const agent = [`${PROMPT} ${command.command}`, "Antigravity", ">"];
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
    `${PROMPT} ${command.command}`,
    "Do you trust the contents of this project?",
    "> Yes, I trust this folder",
  ];
  const answered = [`${PROMPT} ${command.command}`, ">"];
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
    `${PROMPT} ${command.command}`,
    "Do you trust the contents of this project?",
    "> Yes, I trust this folder",
  ];
  const stuck = fakeOrca(
    [asked, asked, [`${PROMPT} ${command.command}`, ">"]],
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
});
