/** The headless runtime: roles as non-interactive processes, without Orca. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  answerHeadless,
  codexRolloutModel,
  headlessCommand,
  headlessStatus,
  listHeadless,
  modelVerdict,
  readHeadlessStream,
  startHeadlessWorker,
  stopHeadless,
  turnLiveness,
  waitHeadless,
} from "../plugins/oh-my-teams/scripts/headless.mjs";
import { main, parseArgs } from "../plugins/oh-my-teams/scripts/teams-org.mjs";

const FAKE = path.resolve("tests/fake-agent.mjs");

function sandbox(t) {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "omt-headless-")),
  );
  t.after(async () => {
    // Give stopped runners a moment to release their files on Windows.
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  });
  const cwd = path.join(dir, "worktree");
  fs.mkdirSync(cwd);
  return {
    state: path.join(dir, "state"),
    cwd,
    codexHome: path.join(dir, "codex-home"),
  };
}

function start(box, provider, workerId, prompt, extra = {}) {
  return startHeadlessWorker({
    stateDir: box.state,
    workerId,
    role: "junior",
    profile: `${provider}-profile`,
    provider,
    binary: [process.execPath, FAKE, provider],
    model: extra.model === undefined ? null : extra.model,
    effort: null,
    cwd: box.cwd,
    prompt,
    ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}),
  });
}

test("each provider's headless command, first turn and resumed", () => {
  const prompt = "do it";
  assert.deepEqual(
    headlessCommand({
      provider: "claude",
      binary: ["claude"],
      model: "sonnet",
      effort: "high",
      prompt,
    }),
    {
      argv: [
        "claude",
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--model",
        "sonnet",
        "--effort",
        "high",
      ],
      stdin: prompt,
    },
  );
  assert.deepEqual(
    headlessCommand({
      provider: "claude",
      binary: ["claude"],
      prompt,
      session: "s1",
    }).argv.slice(-2),
    ["--resume", "s1"],
  );
  assert.deepEqual(
    headlessCommand({
      provider: "codex",
      binary: ["codex"],
      model: "gpt-5.6-sol",
      effort: "low",
      prompt,
      session: "t1",
    }),
    {
      argv: [
        "codex",
        "exec",
        "resume",
        "t1",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "-m",
        "gpt-5.6-sol",
        "-c",
        "model_reasoning_effort=low",
        prompt,
      ],
      stdin: null,
    },
  );
  assert.deepEqual(
    headlessCommand({
      provider: "agy",
      binary: ["agy"],
      model: "gemini-3.8-flash-high",
      prompt,
      session: "c1",
    }),
    {
      argv: [
        "agy",
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
        "--conversation",
        "c1",
        "--model",
        "gemini-3.8-flash-high",
        "-p",
        prompt,
      ],
      stdin: null,
    },
  );
  assert.throws(
    () => headlessCommand({ provider: "ollama", binary: ["ollama"], prompt }),
    /no headless runtime/,
  );
});

test("the last marker line decides the outcome, and the model is judged", () => {
  const stream = [
    {
      type: "system",
      subtype: "init",
      session_id: "s",
      model: "claude-sonnet-5",
    },
    {
      type: "result",
      is_error: false,
      result: "DONE: early\nmore\nQUESTION: which one?",
    },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  const read = readHeadlessStream("claude", `not json\n${stream}`);
  assert.deepEqual(read.marker, { kind: "question", detail: "which one?" });
  assert.equal(read.session, "s");
  assert.equal(read.eventCount, 2);
  assert.equal(modelVerdict("claude-sonnet-5", "claude-sonnet-5"), "matched");
  assert.equal(modelVerdict("sonnet", "claude-sonnet-5"), "alias");
  assert.equal(
    modelVerdict("gemini-3.8-flash-high", "gemini-3.1-pro"),
    "mismatched",
  );
  assert.equal(modelVerdict(null, "gpt-5.6-sol"), "unrequested");
  assert.equal(modelVerdict("gpt-5.6-sol", null), "unproven");
});

// Declared once per provider at top level: the documents count tests from
// top-level declarations, which a loop would hide.
async function questionThenAnswer(t, provider) {
  const box = sandbox(t);
  process.env.FAKE_CODEX_HOME = box.codexHome;
  t.after(() => delete process.env.FAKE_CODEX_HOME);
  const model = {
    claude: "claude-sonnet-5",
    codex: "gpt-fake",
    agy: "gemini-fake",
  }[provider];
  const started = start(
    box,
    provider,
    `${provider}-ask`,
    "ASK before writing",
    { model },
  );
  assert.equal(started.turn, 1);

  const asked = await waitHeadless(box.state, `${provider}-ask`, 15000, {
    pollMs: 100,
    codexHome: box.codexHome,
  });
  assert.equal(asked.liveness, "exited");
  assert.equal(asked.outcome, "question");
  assert.equal(asked.marker.detail, "which file name?");
  assert.equal(asked.exit.code, 0);
  assert.equal(asked.modelProof, "matched");
  assert.ok(asked.session);
  // Codex names its model only in the rollout, which the status reads.
  if (provider === "codex")
    assert.equal(codexRolloutModel(asked.session, box.codexHome), "gpt-fake");

  const answered = answerHeadless(
    box.state,
    `${provider}-ask`,
    "use notes.md",
    { codexHome: box.codexHome },
  );
  assert.equal(answered.turn, 2);
  const done = await waitHeadless(box.state, `${provider}-ask`, 15000, {
    pollMs: 100,
    codexHome: box.codexHome,
  });
  assert.equal(done.turn, 2);
  assert.equal(done.outcome, "done");
  assert.equal(done.session, asked.session);
  const turn = JSON.parse(
    fs.readFileSync(
      path.join(
        box.state,
        "headless",
        `${provider}-ask`,
        "turns",
        "2",
        "turn.json",
      ),
      "utf8",
    ),
  );
  assert.equal(turn.session, asked.session);
  assert.match(
    fs.readFileSync(
      path.join(
        box.state,
        "headless",
        `${provider}-ask`,
        "turns",
        "2",
        "prompt.txt",
      ),
      "utf8",
    ),
    /^use notes\.md\n\n## 비대화형 실행 규약/,
  );
}

test("claude: a question ends the turn and the answer resumes the same session", (t) =>
  questionThenAnswer(t, "claude"));
test("codex: a question ends the turn and the answer resumes the same session", (t) =>
  questionThenAnswer(t, "codex"));
test("agy: a question ends the turn and the answer resumes the same session", (t) =>
  questionThenAnswer(t, "agy"));

test("a turn past its time limit is stopped and reported as timed out", async (t) => {
  const box = sandbox(t);
  start(box, "agy", "slow", "SLEEP forever", { timeoutMs: 1500 });
  const live = headlessStatus(box.state, "slow");
  assert.equal(live.liveness, "live");
  assert.equal(live.outcome, null);
  // Answering a turn that has not ended is refused.
  assert.throws(
    () => answerHeadless(box.state, "slow", "hurry"),
    /is live; answer only a turn that ended/,
  );
  const ended = await waitHeadless(box.state, "slow", 20000, { pollMs: 200 });
  assert.equal(ended.liveness, "exited");
  assert.equal(ended.outcome, "timed-out");
  assert.equal(ended.exit.timedOut, true);
});

test("a stop request ends a running turn, and a crash is an exit error", async (t) => {
  const box = sandbox(t);
  start(box, "claude", "stoppable", "SLEEP until stopped");
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.deepEqual(stopHeadless(box.state, "stoppable"), {
    requested: true,
    turn: 1,
  });
  const stopped = await waitHeadless(box.state, "stoppable", 15000, {
    pollMs: 200,
  });
  assert.equal(stopped.outcome, "stopped");
  assert.equal(stopHeadless(box.state, "stoppable").requested, false);

  start(box, "codex", "crashing", "CRASH now");
  const crashed = await waitHeadless(box.state, "crashing", 15000, {
    pollMs: 100,
  });
  assert.equal(crashed.outcome, "exit-error");
  assert.equal(crashed.exit.code, 3);
  assert.deepEqual(
    listHeadless(box.state).map((worker) => worker.worker),
    ["crashing", "stoppable"],
  );
});

test("a runner that died without recording an exit is unverifiable, not ended", (t) => {
  const box = sandbox(t);
  const turn = path.join(box.state, "headless", "vanished", "turns", "1");
  fs.mkdirSync(turn, { recursive: true });
  writeJSON(path.join(box.state, "headless", "vanished", "worker.json"), {
    schemaVersion: 1,
    id: "vanished",
    role: "junior",
    profile: "p",
    provider: "claude",
    binary: ["claude"],
    modelRequested: null,
    effortRequested: null,
    cwd: box.cwd,
    timeoutMs: 1000,
  });
  // A process id far above any real one on the test hosts.
  writeJSON(path.join(turn, "runner.json"), { pid: 2147483000 });
  const status = headlessStatus(box.state, "vanished");
  assert.equal(status.liveness, "unverifiable");
  assert.equal(status.outcome, null);
  assert.throws(
    () => answerHeadless(box.state, "vanished", "go"),
    /is unverifiable/,
  );
  assert.throws(
    () => start(box, "claude", "Bad Id", "x"),
    /Invalid headless worker id/,
  );
});

test("a turn that ends right after its stream was read is not reported with that stale stream", (t) => {
  // Reading the exit record after the stream paired a finished turn with the
  // output from before its DONE line, and the status said exited, no-marker.
  const box = sandbox(t);
  const dir = path.join(box.state, "headless", "racing");
  const turn = path.join(dir, "turns", "1");
  fs.mkdirSync(turn, { recursive: true });
  writeJSON(path.join(dir, "worker.json"), {
    schemaVersion: 1,
    id: "racing",
    role: "junior",
    profile: "p",
    provider: "claude",
    binary: ["claude"],
    modelRequested: null,
    effortRequested: null,
    cwd: box.cwd,
    timeoutMs: 1000,
  });
  // This process stands in for a runner that is still running.
  writeJSON(path.join(turn, "runner.json"), { pid: process.pid });
  const stream = path.join(turn, "stream.jsonl");
  const event = (value) => `${JSON.stringify(value)}\n`;
  fs.writeFileSync(
    stream,
    event({ type: "system", subtype: "init", session_id: "s1", model: "m" }),
  );
  const finish = () => {
    fs.appendFileSync(
      stream,
      event({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "work complete\nDONE: wrote the file",
        session_id: "s1",
      }),
    );
    writeJSON(path.join(turn, "exit.json"), { code: 0 });
  };
  const readFileSync = fs.readFileSync;
  let finished = false;
  fs.readFileSync = function (file, ...rest) {
    const content = readFileSync.call(fs, file, ...rest);
    if (!finished && path.resolve(String(file)) === path.resolve(stream)) {
      finished = true;
      finish();
    }
    return content;
  };
  let first;
  try {
    first = headlessStatus(box.state, "racing");
  } finally {
    fs.readFileSync = readFileSync;
  }
  assert.ok(finished, "the turn finished during the status read");
  // Either the turn is still live, or its exit is paired with the full stream.
  assert.notEqual(first.outcome, "no-marker");
  if (first.liveness === "exited") assert.equal(first.outcome, "done");
  else assert.equal(first.liveness, "live");
  assert.equal(headlessStatus(box.state, "racing").outcome, "done");
});

test("a turn that records its exit and ends between two reads is exited, not unverifiable", () => {
  // Under the full test run an Agy turn was reported unverifiable: the status
  // looked for exit.json, the runner then wrote it and ended, and the process
  // check that followed found no runner. The runner writes exit.json before
  // it ends, so the process is observed first and exit.json read after it.
  const world = { exitWritten: false, runnerAlive: true };
  const finishTurn = () => {
    world.exitWritten = true;
    world.runnerAlive = false;
  };
  const exitRecord = { code: 0 };
  // The turn ends right after whichever read comes first.
  const racing = (read) => () => {
    const value = read();
    finishTurn();
    return value;
  };
  const verdict = turnLiveness({
    runnerAlive: racing(() => world.runnerAlive),
    readExit: racing(() => (world.exitWritten ? exitRecord : null)),
  });
  assert.deepEqual(verdict, { liveness: "exited", exit: exitRecord });

  // Before and after the turn the answer does not depend on the order.
  assert.deepEqual(
    turnLiveness({ runnerAlive: () => true, readExit: () => null }),
    { liveness: "live", exit: null },
  );
  assert.deepEqual(
    turnLiveness({ runnerAlive: () => false, readExit: () => exitRecord }),
    { liveness: "exited", exit: exitRecord },
  );
  // A runner that is gone with no exit record stays unverifiable.
  assert.deepEqual(
    turnLiveness({ runnerAlive: () => false, readExit: () => null }),
    { liveness: "unverifiable", exit: null },
  );
});

test("headless-start keeps the role checks of a terminal launch", async (t) => {
  const box = sandbox(t);
  // Every profile names an executable that does not exist, so a check that
  // stops refusing can never start a real, billed provider CLI.
  const org = JSON.parse(
    fs.readFileSync(
      path.resolve("plugins/oh-my-teams/examples/organization.json"),
      "utf8",
    ),
  );
  for (const profile of Object.values(org.profiles))
    profile.command = ["omt-no-such-cli"];
  const orgFile = path.join(path.dirname(box.state), "organization.json");
  writeJSON(orgFile, org);
  const run = (role, cwd, extra = []) =>
    main([
      "headless-start",
      "--org",
      orgFile,
      "--role",
      role,
      "--cwd",
      cwd,
      "--spec",
      "x",
      "--state",
      box.state,
      ...extra,
    ]);
  await assert.rejects(
    run("pm", box.cwd),
    /PM runs in its own terminal opened with role-command; it is not started as a headless worker/,
  );
  await assert.rejects(
    run("junior", path.join(box.cwd, "missing")),
    /Worktree does not exist/,
  );
  await assert.rejects(
    run("junior", box.cwd, ["--workflow-id", "wf-1"]),
    /Workflow|no such file|ENOENT/i,
  );
  assert.deepEqual(listHeadless(box.state), []);
});

test("headless-answer takes its text as a value, while role-spec --text is a flag", () => {
  // --text became a flag for every command with role-spec --text, so the
  // answer sentence was read as a stray argument.
  assert.deepEqual(
    parseArgs([
      "headless-answer",
      "--state",
      "s",
      "--worker",
      "w",
      "--text",
      "use notes.md",
    ]),
    {
      command: "headless-answer",
      state: "s",
      worker: "w",
      text: "use notes.md",
    },
  );
  assert.equal(parseArgs(["role-spec", "--text", "--role", "pl"]).text, true);
});

test("an Agy server error is reported in its own words, and a capacity 503 as a limit", () => {
  // The result carried the server's explanation in `error`, but the reader kept
  // only the status word ERROR, and a missing-capacity 503 that asks for a
  // retry later was reported as not rate limited.
  const stream = [
    {
      event: "init",
      conversation_id: "c1",
      init: { model: "gpt-oss-120b-medium" },
    },
    {
      event: "result",
      result: {
        conversation_id: "c1",
        status: "ERROR",
        response: "",
        error:
          "Our servers are experiencing high traffic right now, please try again in a minute. " +
          "(UNAVAILABLE (code 503): No capacity available for model gpt-oss-120b-medium on the server)",
        num_turns: 1,
        usage: { input_tokens: 11708, output_tokens: 139, total_tokens: 11847 },
      },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  const read = readHeadlessStream("agy", stream);
  assert.match(read.providerError, /No capacity available for model/);
  assert.equal(read.rateLimited, true);
  assert.equal(read.usage.inputTokens, 11708);
});
