/**
 * The supervisor path for questions that stop a role's terminal. Orca is
 * played by a fake that replays the captured screens of
 * `tests/fixtures/prompt-screens/`: no real terminal is touched, no key is
 * sent anywhere, and nothing here opens a CLI to make it ask.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readJSON,
  run,
  writeJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  kickoffEntryName,
  registryDirectory,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";
import {
  PROMPT_ANSWER_REFUSALS,
  answerPrompt,
  promptAnswerFile,
  promptAnswerSummary,
  readPromptAnswers,
} from "../plugins/oh-my-teams/scripts/prompt-supervision.mjs";
import { openRoleTerminal } from "../plugins/oh-my-teams/scripts/role-terminal.mjs";
import { roleCommand } from "../plugins/oh-my-teams/scripts/role-launch.mjs";
import { organizationStatus } from "../plugins/oh-my-teams/scripts/status.mjs";
import { main } from "../plugins/oh-my-teams/scripts/teams-org.mjs";
import { recordLaunch } from "../plugins/oh-my-teams/scripts/usage-ledger.mjs";
import {
  attachExecution,
  createWorkflow,
  readWorkflow,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, "fixtures", "prompt-screens");
const screens = Object.fromEntries(
  fs
    .readdirSync(fixtureDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => [
      name.replace(/\.json$/, ""),
      JSON.parse(fs.readFileSync(path.join(fixtureDir, name), "utf8")).lines,
    ]),
);
// The folder the trust captures were taken in; Codex and Claude are answered
// only when the screen names the worktree the role was launched in.
const ROLE_WORKTREE =
  "/private/var/folders/hp/nqxfzfgs7xz_fw2k8lh4gn7c0000gn/T/tmp.6Kiqw25mrE";
const example = path.resolve("plugins/oh-my-teams/examples/organization.json");
const RUN = "run_pm";
const PM = "term_pm";
const PL = "term_pl";
const SENIOR = "term_senior";
const DOWN = "\u001b[B";

const CODEX_ASKS = screens["codex-0.155.1-folder-trust-default"];
const CODEX_DONE = screens["codex-0.155.1-unsubmitted-input"];
const CLAUDE_DEFAULT = screens["claude-2.1.278-folder-trust-default"];
const CLAUDE_CHANGED = screens["claude-2.1.278-folder-trust-changed"];
const CLAUDE_DONE = screens["claude-2.1.278-unsubmitted-input"];
const CLAUDE_ASKUSER = screens["claude-2.1.278-askuser-default"];

async function git(dir, ...args) {
  assert.equal((await run(["git", ...args], { cwd: dir })).code, 0);
}

// One running kickoff: a PM bound to a Run, a workflow, a PL and a Senior
// launched in the captured worktree, all in the launch ledger.
async function kickoff(
  t,
  { seniorProvider = "codex", seniorFrom = "pm" } = {},
) {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "omt-pa-")),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const orgFile = path.join(dir, "project", ".omt", "organization.json");
  const org = readJSON(example);
  writeJSON(orgFile, org);
  const pmPath = path.join(dir, "pm");
  fs.mkdirSync(pmPath, { recursive: true });
  await git(pmPath, "init");
  await git(pmPath, "config", "user.name", "Test");
  await git(pmPath, "config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(pmPath, ".gitignore"), ".omt/\n");
  fs.writeFileSync(path.join(pmPath, "seed.txt"), "seed\n");
  await git(pmPath, "add", ".");
  await git(pmPath, "commit", "-m", "seed");
  const stateDir = path.join(pmPath, ".omt");
  const worktreeId = `repo::${pmPath}`;
  writeJSON(
    path.join(
      registryDirectory(orgFile),
      `${kickoffEntryName(worktreeId)}.json`,
    ),
    {
      schemaVersion: 1,
      goal: "answer prompts",
      pm: { worktreeId, path: pmPath, stateDir },
      runId: RUN,
      organizationRevision: org.revision,
      brief: path.join(dir, "brief.md"),
      delivery: { mode: "none" },
      createdAt: new Date().toISOString(),
    },
  );
  writeJSON(path.join(pmPath, "junior.json"), {
    schemaVersion: 2,
    revision: 1,
    kind: "edit",
    id: "junior",
    goal: "Prompt answers",
    instruction: "Make the change",
    nonGoals: [],
    constraints: [],
    files: ["junior.txt"],
    checks: [[process.execPath, "-e", "process.exit(0)"]],
    acceptance: [
      { id: "check", description: "check", method: "check", checkIndexes: [0] },
    ],
    dependencies: [],
    contractRefs: [],
    contextRefs: [],
    openQuestions: [],
    reviewRequirements: [],
    environment: "test",
    baseRef: "HEAD",
    risk: "low",
  });
  const request = {
    schemaVersion: 1,
    id: "wf",
    goal: "Prompt answers",
    repo: ".",
    tasks: [{ file: "junior.json", role: "junior" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 2, maxCalls: 2 },
  };
  await createWorkflow(stateDir, request, structuredClone(org), pmPath);
  const plPath = path.join(dir, "pl-worktree");
  const launch = (fields) =>
    recordLaunch(orgFile, {
      via: "role-terminal",
      workflowId: "wf",
      ...fields,
    });
  launch({
    role: "pl",
    provider: "claude",
    terminal: PL,
    worktreePath: plPath,
    stateDir,
  });
  launch({
    role: "senior",
    provider: seniorProvider,
    terminal: SENIOR,
    worktreePath: ROLE_WORKTREE,
    stateDir: seniorFrom === "pm" ? stateDir : null,
    callerCwd: seniorFrom === "pm" ? pmPath : plPath,
  });
  return { dir, orgFile, org, pmPath, plPath, stateDir, worktreeId, request };
}

// Orca as the supervisor path meets it. `terminals[handle]` holds the
// worktree Orca reports and the screen now shown; `advance[handle]` lists the
// screens shown after each key sent to it, the last one repeating.
function fakeOrca({
  runs = { [PM]: RUN },
  terminals = {},
  advance = {},
  creates = [],
}) {
  const calls = [];
  const opened = [...creates];
  const queue = Object.fromEntries(
    Object.entries(advance).map(([handle, list]) => [handle, [...list]]),
  );
  const execute = async (argv) => {
    const args = argv.slice(1, -1);
    calls.push(args);
    const reply = (result) => ({
      code: 0,
      stdout: JSON.stringify({ ok: true, result }),
    });
    const [noun, verb] = args;
    const flag = (name) => args[args.indexOf(name) + 1];
    if (noun === "orchestration" && verb === "run-current") {
      const handle = flag("--from");
      return reply({
        run: runs[handle]
          ? { id: runs[handle], coordinator_handle: handle }
          : null,
      });
    }
    if (noun === "orchestration" && verb === "send")
      return reply({ message: {} });
    if (verb === "create") {
      const next = opened.shift();
      assert.ok(next, "no terminal left to create");
      terminals[next.handle] = {
        worktreePath: next.worktreePath ?? ROLE_WORKTREE,
        screen: next.screen,
      };
      queue[next.handle] = [...(next.advance ?? [])];
      return reply({ terminal: { handle: next.handle } });
    }
    if (verb === "wait") return reply({ wait: { satisfied: true } });
    if (verb === "list") return reply({ terminals: [] });
    if (verb === "rename") return reply({ rename: {} });
    if (verb === "close") return reply({ close: { closed: true } });
    const terminal = terminals[flag("--terminal")];
    assert.ok(terminal, `unexpected terminal in ${args.join(" ")}`);
    if (verb === "show")
      return reply({ terminal: { worktreePath: terminal.worktreePath } });
    if (verb === "read")
      return reply({
        terminal: {
          source: terminal.source ?? "screen",
          tail: terminal.screen,
        },
      });
    if (verb === "send") {
      const next = queue[flag("--terminal")]?.shift();
      if (next) terminal.screen = next;
      return reply({ send: { accepted: true } });
    }
    throw new Error(`unexpected verb ${args.join(" ")}`);
  };
  const of = (noun, verb) => () =>
    calls.filter((call) => call[0] === noun && call[1] === verb);
  return {
    calls,
    execute,
    keys: () =>
      of("terminal", "send")().map((call) => ({
        text: call[call.indexOf("--text") + 1],
        enter: call.includes("--enter"),
      })),
    messages: of("orchestration", "send"),
    closes: of("terminal", "close"),
    sentTo: (handle) =>
      of("terminal", "send")()
        .filter((call) => call[call.indexOf("--terminal") + 1] === handle)
        .map((call) => ({
          text: call[call.indexOf("--text") + 1],
          enter: call.includes("--enter"),
        })),
  };
}

const fast = { settleMs: 0, rechecks: 2 };
const answer = (fixture, orca, overrides = {}) =>
  answerPrompt({
    orgFile: fixture.orgFile,
    terminal: SENIOR,
    workflowId: "wf",
    stateDir: fixture.stateDir,
    env: { ORCA_TERMINAL_HANDLE: PM },
    execute: orca.execute,
    ...fast,
    ...overrides,
  });
const at = (worktreePath, screen, extra = {}) => ({
  worktreePath,
  screen,
  ...extra,
});

test("a caller that supervises no run is refused before any screen is read", async (t) => {
  const fixture = await kickoff(t);
  const orca = fakeOrca({
    terminals: { [SENIOR]: at(ROLE_WORKTREE, CODEX_ASKS) },
  });
  // The Orca handle names a terminal bound to a Run other than the kickoff's,
  // one bound to none, and none at all.
  const callers = [
    { handle: "term_other", runs: { term_other: "run_other" } },
    { handle: "term_free", runs: {} },
    { handle: undefined, runs: {} },
  ];
  for (const { handle, runs } of callers) {
    const source = fakeOrca({
      runs,
      terminals: { [SENIOR]: at(ROLE_WORKTREE, CODEX_ASKS) },
    });
    const record = await answer(fixture, source, {
      env: handle ? { ORCA_TERMINAL_HANDLE: handle } : {},
    });
    assert.equal(record.status, "refused");
    assert.equal(record.refusal, handle ? "not-supervisor" : "caller-unknown");
    assert.equal(record.sent, false);
    assert.equal(source.keys().length, 0);
    assert.equal(
      source.calls.some((call) => call[1] === "read"),
      false,
    );
  }
  assert.equal(orca.keys().length, 0);
  assert.equal(readPromptAnswers(fixture.stateDir).length, 3);
});

test("a role's terminal cannot answer, nor a PL for a role it did not start", async (t) => {
  const fixture = await kickoff(t);
  const orca = fakeOrca({
    runs: { [SENIOR]: "run_senior", [PL]: "run_pl" },
    terminals: { [SENIOR]: at(ROLE_WORKTREE, CODEX_ASKS) },
  });
  const self = await answer(fixture, orca, {
    env: { ORCA_TERMINAL_HANDLE: SENIOR },
  });
  assert.equal(self.refusal, "self-target");
  // Senior was opened by the PM from its own worktree, not by the PL.
  const plCaller = await answer(fixture, orca, {
    env: { ORCA_TERMINAL_HANDLE: PL },
  });
  assert.equal(plCaller.refusal, "not-supervisor");
  assert.equal(orca.keys().length, 0);
});

test("the PL that started the role may answer for it", async (t) => {
  const fixture = await kickoff(t, { seniorFrom: "pl" });
  const orca = fakeOrca({
    runs: { [PL]: "run_pl" },
    terminals: { [SENIOR]: at(ROLE_WORKTREE, CODEX_ASKS) },
    advance: { [SENIOR]: [CODEX_DONE] },
  });
  const record = await answer(fixture, orca, {
    env: { ORCA_TERMINAL_HANDLE: PL },
  });
  assert.equal(record.status, "resolved");
  assert.equal(record.supervisor.role, "pl");
  assert.equal(record.supervisor.runId, "run_pl");
  assert.equal(orca.keys().length, 1);
});

test("a terminal outside the worktree this kickoff launched the role in is refused before a key", async (t) => {
  const fixture = await kickoff(t);
  const elsewhere = path.join(fixture.dir, "junior-worktree");
  const cases = [
    // Orca places the terminal in another role's worktree.
    ["worktree-mismatch", { [SENIOR]: at(elsewhere, CODEX_ASKS) }, {}],
    // The terminal sits in the PM's own worktree.
    [
      "worktree-not-role-owned",
      { [SENIOR]: at(fixture.pmPath, CODEX_ASKS) },
      { pmLaunch: true },
    ],
  ];
  for (const [refusal, terminals, { pmLaunch } = {}] of cases) {
    if (pmLaunch)
      recordLaunch(fixture.orgFile, {
        via: "role-terminal",
        role: "senior",
        provider: "codex",
        terminal: SENIOR,
        worktreePath: fixture.pmPath,
        workflowId: "wf",
        stateDir: fixture.stateDir,
      });
    const orca = fakeOrca({ terminals });
    const record = await answer(fixture, orca);
    assert.equal(record.refusal, refusal);
    assert.equal(orca.keys().length, 0);
    assert.equal(
      orca.calls.some((call) => call[1] === "read"),
      false,
    );
  }
});

test("a worktree that belongs to another role's task is refused", async (t) => {
  const fixture = await kickoff(t);
  attachExecution(
    fixture.stateDir,
    "wf",
    readWorkflow(fixture.stateDir, "wf").state.revision,
    {
      schemaVersion: 1,
      eventId: "attach-junior",
      attemptId: "attempt-junior",
      taskId: "junior",
      callAllowance: 1,
      receipt: {
        executionId: "junior",
        runId: "junior",
        taskId: "junior",
        dispatchId: "junior",
        worktreeId: `repo::${ROLE_WORKTREE}`,
        role: "junior",
      },
    },
  );
  const orca = fakeOrca({
    terminals: { [SENIOR]: at(ROLE_WORKTREE, CODEX_ASKS) },
  });
  const record = await answer(fixture, orca);
  assert.equal(record.refusal, "worktree-shared");
  assert.equal(orca.keys().length, 0);
});

test("a terminal nobody launched, a wrong role and a wrong workflow are refused", async (t) => {
  const fixture = await kickoff(t);
  const orca = fakeOrca({
    terminals: {
      [SENIOR]: at(ROLE_WORKTREE, CODEX_ASKS),
      term_stray: at(ROLE_WORKTREE, CODEX_ASKS),
    },
  });
  assert.equal(
    (await answer(fixture, orca, { terminal: "term_stray" })).refusal,
    "terminal-not-launched",
  );
  assert.equal(
    (await answer(fixture, orca, { role: "junior" })).refusal,
    "role-mismatch",
  );
  assert.equal(
    (await answer(fixture, orca, { workflowId: "other" })).refusal,
    "workflow-unreadable",
  );
  assert.equal(
    (
      await answer(fixture, orca, {
        stateDir: path.join(fixture.dir, "elsewhere"),
      })
    ).refusal,
    "workflow-unreadable",
  );
  assert.equal(orca.keys().length, 0);
  for (const code of readPromptAnswers(fixture.stateDir)
    .map((r) => r.refusal)
    .filter(Boolean))
    assert.ok(PROMPT_ANSWER_REFUSALS.includes(code), code);
});

test("a Codex trust question is answered with one Enter and confirmed gone", async (t) => {
  const fixture = await kickoff(t);
  const orca = fakeOrca({
    terminals: { [SENIOR]: at(ROLE_WORKTREE, CODEX_ASKS) },
    advance: { [SENIOR]: [CODEX_DONE] },
  });
  const record = await answer(fixture, orca);
  assert.equal(record.status, "resolved");
  assert.equal(record.next, "resume-precheck");
  assert.deepEqual(orca.keys(), [{ text: "", enter: true }]);
  assert.equal(record.key.name, "Enter");
  // The Enter of this screen was never sent during the capture, so the record
  // says so, and it holds the screen read afterwards as its evidence.
  assert.equal(record.key.basis, "footer-text");
  assert.equal(record.verification.result, "resolved");
});

test("the same question is answered once, however often it is asked again", async (t) => {
  const fixture = await kickoff(t);
  const orca = fakeOrca({
    terminals: { [SENIOR]: at(ROLE_WORKTREE, CODEX_ASKS) },
    advance: { [SENIOR]: [CODEX_ASKS] },
  });
  const first = await answer(fixture, orca);
  assert.equal(first.status, "unresolved");
  assert.equal(first.verification.result, "unchanged");
  assert.equal(first.next, "report-upstream");
  // The question is still there: a second call reports it and sends nothing.
  const second = await answer(fixture, orca);
  assert.equal(second.status, "refused");
  assert.equal(second.refusal, "already-answered");
  assert.equal(orca.keys().length, 1);
  assert.equal(readPromptAnswers(fixture.stateDir).length, 2);
});

test("Claude's Down and Enter are two answers to two screen states, and Esc is never sent", async (t) => {
  const fixture = await kickoff(t, { seniorProvider: "claude" });
  const orca = fakeOrca({
    terminals: { [SENIOR]: at(ROLE_WORKTREE, CLAUDE_DEFAULT) },
    advance: { [SENIOR]: [CLAUDE_CHANGED, CLAUDE_DONE] },
  });
  const first = await answer(fixture, orca);
  assert.equal(first.status, "advanced");
  assert.equal(first.next, "answer-again");
  assert.equal(first.key.name, "Down");
  assert.equal(first.key.basis, "captured-input");
  const second = await answer(fixture, orca);
  assert.equal(second.status, "resolved");
  assert.equal(second.key.name, "Enter");
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.deepEqual(orca.keys(), [
    { text: DOWN, enter: false },
    { text: "", enter: true },
  ]);
  assert.equal(
    orca
      .keys()
      .some((key) => key.text.startsWith("\u001b") && key.text !== DOWN),
    false,
  );
});

test("a screen that does not change after the key is reported, never sent again", async (t) => {
  const fixture = await kickoff(t, { seniorProvider: "claude" });
  const orca = fakeOrca({
    terminals: { [SENIOR]: at(ROLE_WORKTREE, CLAUDE_CHANGED) },
    advance: { [SENIOR]: [CLAUDE_CHANGED] },
  });
  const first = await answer(fixture, orca);
  assert.equal(first.status, "unresolved");
  assert.equal(first.verification.result, "unchanged");
  const again = await answer(fixture, orca);
  assert.equal(again.refusal, "already-answered");
  assert.equal(orca.keys().length, 1);
  // An unreadable screen after the key is unresolved too.
  const other = await kickoff(t, { seniorProvider: "claude" });
  const blind = fakeOrca({
    terminals: { [SENIOR]: at(ROLE_WORKTREE, CLAUDE_CHANGED) },
  });
  blind.calls.length = 0;
  const original = blind.execute;
  let reads = 0;
  blind.execute = async (argv) => {
    if (argv[2] === "read" && (reads += 1) > 1)
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          result: { terminal: { source: "stream", tail: [] } },
        }),
      };
    return original(argv);
  };
  const record = await answer(other, blind);
  assert.equal(record.status, "unresolved");
  assert.equal(record.verification.result, "unreadable");
});

test("a question the CLI asks its user is redirected without a key", async (t) => {
  const fixture = await kickoff(t, { seniorProvider: "claude" });
  const orca = fakeOrca({
    terminals: { [SENIOR]: at(ROLE_WORKTREE, CLAUDE_ASKUSER) },
  });
  const record = await answer(fixture, orca);
  assert.equal(record.status, "redirected");
  assert.equal(record.sent, false);
  assert.equal(record.key, null);
  assert.equal(orca.keys().length, 0);
  const [message] = orca.messages();
  assert.equal(message[message.indexOf("--to") + 1], SENIOR);
  assert.match(
    message[message.indexOf("--body") + 1],
    /orca orchestration ask/,
  );
});

test("a screen that is not a captured question goes upward, and a clear screen sends nothing", async (t) => {
  const fixture = await kickoff(t);
  const unknown = ["Do you want to proceed?", "❯ 1. Yes", "  2. No"];
  const orca = fakeOrca({
    terminals: { [SENIOR]: at(ROLE_WORKTREE, unknown) },
  });
  const asked = await answer(fixture, orca);
  assert.equal(asked.status, "no-question");
  assert.equal(orca.keys().length, 0);
  // A codex screen that resembles the captured question but was changed.
  const changed = fakeOrca({
    terminals: {
      [SENIOR]: at(
        ROLE_WORKTREE,
        screens["codex-0.155.1-folder-trust-changed"],
      ),
    },
  });
  const held = await answer(fixture, changed);
  assert.equal(held.status, "escalate");
  assert.equal(held.next, "report-upstream");
  assert.equal(changed.keys().length, 0);
  // Orca without a rendered screen decides nothing.
  const blind = fakeOrca({
    terminals: {
      [SENIOR]: at(ROLE_WORKTREE, CODEX_ASKS, { source: "stream" }),
    },
  });
  assert.equal((await answer(fixture, blind)).refusal, "screen-unavailable");
  assert.equal(blind.keys().length, 0);
});

test("every attempt is one line in the state's record and shows in status", async (t) => {
  const fixture = await kickoff(t);
  const orca = fakeOrca({
    terminals: { [SENIOR]: at(ROLE_WORKTREE, CODEX_ASKS) },
    advance: { [SENIOR]: [CODEX_DONE] },
  });
  await answer(fixture, orca, { env: {} });
  await answer(fixture, orca);
  const lines = fs
    .readFileSync(promptAnswerFile(fixture.stateDir), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  // The sending reservation precedes the final line of the answered attempt.
  assert.deepEqual(
    lines.map((line) => line.status),
    ["refused", "sending", "resolved"],
  );
  const [refused, reserved, final] = lines;
  assert.equal(reserved.id, final.id);
  assert.equal(refused.sent, false);
  for (const field of [
    "schemaVersion",
    "event",
    "id",
    "at",
    "role",
    "provider",
    "terminal",
    "worktree",
    "workflowId",
    "kind",
    "cli",
    "action",
    "evidence",
    "excerpt",
    "fingerprint",
    "key",
    "supervisor",
    "delivery",
    "verification",
    "next",
  ])
    assert.ok(field in final, field);
  assert.equal(final.event, "prompt-answer");
  assert.equal(final.role, "senior");
  assert.equal(final.terminal, SENIOR);
  assert.equal(final.worktree, ROLE_WORKTREE);
  assert.equal(final.kind, "trust");
  assert.deepEqual(final.supervisor, { handle: PM, role: "pm", runId: RUN });
  assert.ok(final.excerpt.some((row) => row.includes("Do you trust")));

  const summary = promptAnswerSummary(fixture.stateDir);
  assert.equal(summary.total, 2);
  assert.equal(summary.sent, 1);
  assert.deepEqual(summary.byStatus, { refused: 1, resolved: 1 });
  assert.equal(summary.unresolved[0].refusal, "caller-unknown");
  const status = organizationStatus(fixture.org, fixture.stateDir);
  assert.deepEqual(status.promptAnswers, summary);
  assert.deepEqual(organizationStatus(fixture.org).promptAnswers.total, 0);
});

test("the command needs its options and is listed in the help", async () => {
  await assert.rejects(
    main([
      "prompt-answer",
      "--org",
      example,
      "--workflow-id",
      "wf",
      "--state",
      "x",
    ]),
    /--terminal required/,
  );
  await assert.rejects(
    main([
      "prompt-answer",
      "--org",
      example,
      "--terminal",
      "t",
      "--workflow-id",
      "wf",
      "--state",
      "x",
      "--text",
      "y",
    ]),
    /Unknown option: --text/,
  );
});

const READY = ["OpenAI Codex (fake)", "gpt-5.6-terra · ready"];

// role-terminal opens the terminal and answers its trust question through the
// same supervisor path: the caller and the worktree are proven before a key.
async function openSenior(t, fixture, profile, orca, overrides = {}) {
  const org = structuredClone(fixture.org);
  org.roles.senior.profile = profile;
  const command = roleCommand(org, "senior");
  const opened = await openRoleTerminal({
    worktree: `path:${ROLE_WORKTREE}`,
    command,
    execute: orca.execute,
    settleMs: 5,
    readyMs: 20,
    pollMs: 1,
    platform: "darwin",
    allowUnverified: true,
    allowUnverifiedApproval: "test-approved",
    expectedWorktree: ROLE_WORKTREE,
    supervision: {
      orgFile: fixture.orgFile,
      stateDir: fixture.stateDir,
      workflowId: "wf",
      launchCwd: fixture.pmPath,
      env: { ORCA_TERMINAL_HANDLE: PM },
      ...fast,
    },
    ...overrides,
  });
  return { opened, command };
}

test("role-terminal answers a Codex trust question through the supervisor path and reopens", async (t) => {
  const fixture = await kickoff(t);
  const orca = fakeOrca({
    creates: [
      { handle: "term_a", screen: CODEX_ASKS, advance: [READY] },
      { handle: "term_b", screen: READY },
    ],
  });
  const { opened } = await openSenior(t, fixture, "codex-terra", orca);
  assert.equal(opened.trust, "accepted");
  assert.equal(opened.terminal, "term_b");
  assert.equal(opened.ready, true);
  assert.equal(opened.reopened.closedTerminal, "term_a");
  assert.deepEqual(orca.sentTo("term_a"), [{ text: "", enter: true }]);
  assert.equal(orca.sentTo("term_b").length, 0);
  assert.equal(opened.promptAnswers[0].keyBasis, "footer-text");
  const [line] = readPromptAnswers(fixture.stateDir);
  assert.equal(line.terminal, "term_a");
  assert.deepEqual(line.supervisor, { handle: PM, role: "pm", runId: RUN });
  assert.equal(line.worktree, ROLE_WORKTREE);
});

test("role-terminal answers Claude's trust question with Down, then Enter, and reopens", async (t) => {
  const fixture = await kickoff(t);
  const orca = fakeOrca({
    creates: [
      {
        handle: "term_a",
        screen: CLAUDE_DEFAULT,
        advance: [CLAUDE_CHANGED, READY],
      },
      { handle: "term_b", screen: READY },
    ],
  });
  const { opened } = await openSenior(t, fixture, "claude-current", orca);
  assert.equal(opened.trust, "accepted");
  assert.equal(opened.terminal, "term_b");
  assert.equal(opened.reopened.closedTerminal, "term_a");
  assert.deepEqual(orca.sentTo("term_a"), [
    { text: DOWN, enter: false },
    { text: "", enter: true },
  ]);
  assert.deepEqual(
    opened.promptAnswers.map((answer) => [answer.key, answer.status]),
    [
      ["Down", "advanced"],
      ["Enter", "resolved"],
    ],
  );
});

test("role-terminal sends no key without a supervisor context, for a caller that supervises nothing, or in another worktree", async (t) => {
  const fixture = await kickoff(t);
  const asks = (worktreePath) =>
    fakeOrca({
      runs: { [PM]: RUN, term_other: "run_other" },
      creates: [{ handle: "term_a", screen: CODEX_ASKS, worktreePath }],
    });
  const cases = [
    ["unsupervised", asks(), { supervision: null }, null],
    [
      "refused",
      asks(),
      {
        supervision: {
          orgFile: fixture.orgFile,
          stateDir: fixture.stateDir,
          workflowId: "wf",
          launchCwd: fixture.pmPath,
          env: { ORCA_TERMINAL_HANDLE: "term_other" },
          ...fast,
        },
      },
      "not-supervisor",
    ],
    [
      "refused",
      asks(path.join(fixture.dir, "junior-worktree")),
      {},
      "worktree-mismatch",
    ],
  ];
  for (const [trust, orca, overrides, refusal] of cases) {
    const { opened } = await openSenior(
      t,
      fixture,
      "codex-terra",
      orca,
      overrides,
    );
    assert.equal(opened.trust, trust);
    assert.equal(opened.ready, false);
    assert.equal(opened.status, "blocked");
    assert.equal(opened.reopened, null);
    assert.equal(orca.sentTo("term_a").length, 0);
    assert.equal(orca.closes().length, 0);
    if (refusal)
      assert.equal(readPromptAnswers(fixture.stateDir).at(-1).refusal, refusal);
  }
});
