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
function fakeOrca(screens) {
  const calls = [];
  const execute = async (argv) => {
    const [, noun, verb] = argv;
    calls.push(argv.slice(1, -1));
    assert.equal(noun, "terminal");
    const reply = (result) => ({
      code: 0,
      stdout: JSON.stringify({ ok: true, result }),
    });
    if (verb === "create") return reply({ terminal: { handle: "term_1" } });
    // An idle shell satisfies tui-idle too, so the wait decides nothing.
    if (verb === "wait") return reply({ wait: { satisfied: true } });
    if (verb === "read") {
      const tail = screens.length > 1 ? screens.shift() : screens[0];
      return reply({ terminal: { tail } });
    }
    if (verb === "send") return reply({ send: { accepted: true } });
    throw new Error(`unexpected verb ${verb}`);
  };
  const sends = () => calls.filter((call) => call[1] === "send");
  return { calls, execute, sends };
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

  const trusted = fakeOrca([
    asked,
    asked,
    [`${PROMPT} ${command.command}`, ">"],
  ]);
  const opened = await openRoleTerminal({
    worktree: "active",
    command,
    execute: trusted.execute,
    ...fast,
  });
  assert.equal(opened.trust, "accepted");
  assert.equal(opened.ready, true);
  assert.equal(trusted.sends().length, 1);

  // A question that stays after one Enter blocks rather than repeating it.
  const repeated = fakeOrca([asked]);
  const blocked = await openRoleTerminal({
    worktree: "active",
    command,
    execute: repeated.execute,
    ...fast,
  });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.status, "blocked");
  assert.equal(repeated.sends().length, 1);
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
  assert.match(runtime, /--dangerously-skip-permissions/);
});
