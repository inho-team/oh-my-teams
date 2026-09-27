/** Director sessions: the command they open with, the visible terminal they get, and the registry handover. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  directorBriefPrompt,
  directorCommand,
  roleCommand,
} from "../plugins/oh-my-teams/scripts/role-launch.mjs";
import {
  directorTitle,
  openDirectorTerminal,
} from "../plugins/oh-my-teams/scripts/director-terminal.mjs";
import {
  listKickoffs,
  reassignDirector,
  registerKickoff,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";
import {
  ALLOWED_OPTIONS,
  REQUIRED_OPTIONS,
  parseArgs,
} from "../plugins/oh-my-teams/scripts/teams-org.mjs";

const example = () =>
  readJSON(path.resolve("plugins/oh-my-teams/examples/organization.json"));
const CHECKOUT = "/Users/someone/orca/project";
const PROMPT = "me@host project %";

// Plays Orca's terminal verbs for a director launch. `terminals` is what show
// reports per handle; the screens are consumed in order, the last repeating.
function fakeOrca(screens, { terminals = {}, sourceWorktree = CHECKOUT } = {}) {
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
    const handleOf = () => argv[argv.indexOf("--terminal") + 1];
    if (verb === "split") {
      created += 1;
      return reply({
        split: { handle: `term_split_${created}`, tabId: "tab_1" },
      });
    }
    if (verb === "create") {
      created += 1;
      return reply({ terminal: { handle: `term_new_${created}` } });
    }
    if (verb === "show") {
      const handle = handleOf();
      const known = terminals[handle];
      if (known) return reply({ terminal: { handle, ...known } });
      if (handle === "term_source")
        return reply({
          terminal: { handle, worktreePath: sourceWorktree, orphaned: false },
        });
      return reply({
        terminal: {
          handle,
          worktreePath: CHECKOUT,
          orphaned: false,
          tabId: "tab_1",
        },
      });
    }
    if (verb === "wait") return reply({ wait: { satisfied: true } });
    if (verb === "read") {
      const tail = screens.length > 1 ? screens.shift() : screens[0];
      return reply({ terminal: { source: "screen", tail } });
    }
    if (verb === "send") return reply({ send: { accepted: true } });
    if (verb === "rename") return reply({ rename: { title: argv.at(-2) } });
    if (verb === "close") return reply({ close: { closed: true } });
    throw new Error(`unexpected orca verb ${verb}`);
  };
  return { execute, calls };
}

const verbs = (calls) => calls.map((call) => call[1]);
const fast = { settleMs: 20, readyMs: 60, pollMs: 5 };

test("a director command comes from a profile or an explicit provider, like a role command", () => {
  const org = example();
  const fromProfile = directorCommand(org, { profile: "claude-current" });
  assert.equal(fromProfile.role, "director");
  assert.equal(fromProfile.profile, "claude-current");
  assert.equal(fromProfile.argv[0], "claude");
  assert.ok(fromProfile.argv.includes("--dangerously-skip-permissions"));
  // The same profile opens the same line for a role and for the director.
  const pm = roleCommand(org, "pm");
  assert.equal(fromProfile.command, pm.command);

  const explicit = directorCommand(org, {
    provider: "codex",
    model: "gpt-6-astra",
    effort: "high",
    firstPrompt: directorBriefPrompt("/tmp/brief.md"),
  });
  assert.equal(explicit.profile, "explicit:codex");
  assert.deepEqual(explicit.argv.slice(0, 8), [
    "codex",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    "gpt-6-astra",
    "--config",
    "model_reasoning_effort=high",
    "--config",
    "check_for_update_on_startup=false",
  ]);
  assert.match(
    explicit.argv.at(-1),
    /^당신은 이 저장소의 이사입니다\. 인수 브리프 \/tmp\/brief\.md를 전체 읽고/,
  );
  assert.match(explicit.command, /'당신은 이 저장소의 이사입니다\./);
  assert.equal(explicit.modelRequested, "gpt-6-astra");
  assert.equal(explicit.effortRequested, "high");
});

test("a director command refuses what it cannot open", () => {
  const org = example();
  assert.throws(
    () => directorCommand(org, { profile: "no-such-profile" }),
    /no profile no-such-profile/,
  );
  assert.throws(
    () =>
      directorCommand(org, { profile: "claude-current", provider: "codex" }),
    /either a profile or a provider/,
  );
  assert.throws(
    () => directorCommand(org, { provider: "ollama" }),
    /must be one of claude, codex, agy/,
  );
  assert.throws(
    () => directorCommand(org, { provider: "agy", effort: "ultra" }),
    /effort for agy must be one of low, medium, high/,
  );
  assert.throws(() => directorBriefPrompt(" "), /non-empty brief path/);
  // The director is still not a role: role-command keeps refusing it and
  // now names the director commands instead.
  assert.throws(() => roleCommand(org, "director"), /director-terminal/);
});

test("a director opens as a visible split of the calling terminal and the tab is titled", async () => {
  const command = directorCommand(example(), { profile: "claude-current" });
  const orca = fakeOrca([
    [PROMPT],
    [PROMPT, `${PROMPT} ${command.command}`],
    [`${PROMPT} ${command.command}`, "╭ Claude Code ╮", "│ opus │", "> "],
  ]);
  const opened = await openDirectorTerminal({
    checkout: CHECKOUT,
    command,
    fromTerminal: "term_source",
    execute: orca.execute,
    ...fast,
  });
  assert.equal(opened.terminal, "term_split_1");
  assert.equal(opened.opened, "split");
  assert.equal(opened.visible, true);
  assert.equal(opened.tabId, "tab_1");
  assert.equal(opened.ready, true);
  assert.equal(opened.status, undefined);
  assert.equal(opened.title, "[Director] project");
  assert.equal(opened.titlePinned, true);
  assert.equal(opened.role, "director");
  const split = orca.calls.find((call) => call[1] === "split");
  assert.deepEqual(split, [
    "terminal",
    "split",
    "--terminal",
    "term_source",
    "--direction",
    "vertical",
  ]);
  const sent = orca.calls.filter((call) => call[1] === "send");
  assert.equal(
    sent.length,
    1,
    "the command is typed once and not followed by a stray Enter",
  );
  assert.equal(sent[0][sent[0].indexOf("--text") + 1], command.command);
  assert.ok(verbs(orca.calls).includes("rename"));
});

test("a command left at the prompt gets one Enter, and a terminal the UI did not adopt is closed and refused", async () => {
  const command = directorCommand(example(), { profile: "claude-current" });
  const whole = `${PROMPT} ${command.command}`;
  // The shell holds the whole command at the prompt until Enter arrives.
  const typed = fakeOrca([[PROMPT, whole]]);
  let entered = false;
  const execute = async (argv) => {
    const verb = argv[2];
    if (verb === "send" && argv[argv.indexOf("--text") + 1] === "")
      entered = true;
    if (verb === "read" && entered) {
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          result: { terminal: { tail: [whole, "╭ Claude Code ╮", "> "] } },
        }),
      };
    }
    return typed.execute(argv);
  };
  const opened = await openDirectorTerminal({
    checkout: CHECKOUT,
    command,
    execute,
    ...fast,
  });
  assert.equal(opened.opened, "create");
  assert.equal(opened.submission, "enter-sent");
  assert.equal(opened.ready, true);
  const enters = typed.calls.filter(
    (call) => call[1] === "send" && call[call.indexOf("--text") + 1] === "",
  );
  assert.equal(enters.length, 1);

  const orphan = fakeOrca([[PROMPT]], {
    terminals: { term_new_1: { worktreePath: CHECKOUT, orphaned: true } },
  });
  await assert.rejects(
    openDirectorTerminal({
      checkout: CHECKOUT,
      command,
      execute: orphan.execute,
      ...fast,
    }),
    /term_new_1 \(create\) is orphaned.*--from-terminal/,
  );
  assert.deepEqual(verbs(orphan.calls), ["create", "show", "close"]);
  assert.ok(
    !orphan.calls.some((call) => call[1] === "send"),
    "nothing is typed into a terminal the user cannot see",
  );
});

test("a source terminal outside the checkout is refused before anything opens", async () => {
  const command = directorCommand(example(), { profile: "claude-current" });
  const orca = fakeOrca([[PROMPT]], {
    sourceWorktree: "/Users/someone/elsewhere",
  });
  await assert.rejects(
    openDirectorTerminal({
      checkout: CHECKOUT,
      command,
      fromTerminal: "term_source",
      execute: orca.execute,
      ...fast,
    }),
    /sits in \/Users\/someone\/elsewhere, not in the checkout/,
  );
  assert.deepEqual(verbs(orca.calls), ["show"]);
});

test("an agent that never draws its interface is reported blocked with the screen", async () => {
  const command = directorCommand(example(), { profile: "claude-current" });
  const orca = fakeOrca([[PROMPT, `${PROMPT} ${command.command}`]]);
  const opened = await openDirectorTerminal({
    checkout: CHECKOUT,
    command,
    fromTerminal: "term_source",
    execute: orca.execute,
    ...fast,
  });
  assert.equal(opened.ready, false);
  assert.equal(opened.status, "blocked");
  assert.equal(opened.titlePinned, false);
  assert.ok(Array.isArray(opened.screen) && opened.screen.length > 0);
});

test("director titles lead with the director tag", () => {
  assert.equal(directorTitle("/x/y/oh-my-teams"), "[Director] oh-my-teams");
  assert.equal(
    directorTitle("/x/y/oh-my-teams", "Codex 인수"),
    "[Director] Codex 인수",
  );
  assert.equal(directorTitle("/x/y/z", "[Director] kept"), "[Director] kept");
});

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-director-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const org = path.join(dir, ".omt", "organization.json");
  fs.mkdirSync(path.dirname(org), { recursive: true });
  fs.copyFileSync(
    path.resolve("plugins/oh-my-teams/examples/organization.json"),
    org,
  );
  const brief = path.join(dir, "brief.md");
  fs.writeFileSync(brief, "goal, acceptance criteria, non-goals\n");
  return { dir, org, brief };
}

function claim(fixture, worktreeId, terminalHandle) {
  const pm = path.join(fixture.dir, worktreeId);
  return {
    goal: `deliver ${worktreeId}`,
    pm: { worktreeId, path: pm, stateDir: path.join(pm, ".omt") },
    organizationRevision: readJSON(fixture.org).revision,
    brief: fixture.brief,
    delivery: { mode: "none" },
    director: { terminalHandle, checkoutPath: fixture.dir },
  };
}

test("reassignDirector moves only the kickoffs the old director terminal supervised", (t) => {
  const fixture = project(t);
  registerKickoff(fixture.org, claim(fixture, "repo::pm-a", "term_old"));
  registerKickoff(fixture.org, claim(fixture, "repo::pm-b", "term_old"));
  registerKickoff(fixture.org, claim(fixture, "repo::pm-c", "term_other"));

  const moved = reassignDirector(fixture.org, {
    from: "term_old",
    to: "term_new",
  });
  assert.deepEqual(moved.reassigned, ["repo::pm-a", "repo::pm-b"]);
  assert.deepEqual(moved.unchanged, ["repo::pm-c"]);
  const byId = Object.fromEntries(
    listKickoffs(fixture.org).kickoffs.map((entry) => [
      entry.pm.worktreeId,
      entry.director,
    ]),
  );
  assert.equal(byId["repo::pm-a"].terminalHandle, "term_new");
  assert.equal(byId["repo::pm-a"].checkoutPath, fixture.dir);
  assert.equal(byId["repo::pm-b"].terminalHandle, "term_new");
  assert.equal(byId["repo::pm-c"].terminalHandle, "term_other");

  assert.throws(
    () => reassignDirector(fixture.org, { from: "term_new", to: "term_new" }),
    /same as the current one/,
  );
  assert.throws(
    () => reassignDirector(fixture.org, { from: "", to: "term_x" }),
    /current director terminal handle/,
  );
});

test("the director-terminal CLI takes the launch, placement and handover options", () => {
  for (const option of [
    "org",
    "profile",
    "provider",
    "model",
    "effort",
    "brief",
    "checkout",
    "from-terminal",
    "title",
    "replace",
    "orca",
  ]) {
    assert.ok(
      ALLOWED_OPTIONS["director-terminal"].includes(option),
      `director-terminal accepts --${option}`,
    );
  }
  assert.deepEqual(REQUIRED_OPTIONS["director-terminal"], ["org"]);
  assert.deepEqual(REQUIRED_OPTIONS["director-command"], ["org"]);
  const args = parseArgs([
    "director-terminal",
    "--org",
    "o.json",
    "--provider",
    "codex",
    "--model",
    "gpt-6-astra",
    "--effort",
    "high",
    "--from-terminal",
    "term_src",
    "--replace",
    "term_old",
  ]);
  assert.equal(args.command, "director-terminal");
  assert.equal(args["from-terminal"], "term_src");
  assert.equal(args.replace, "term_old");
});
