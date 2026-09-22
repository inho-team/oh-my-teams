/** The headless runtime: roles as non-interactive processes, without Orca. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  _codexRolloutCache,
  answerHeadless,
  codexRolloutModel,
  headlessCommand,
  headlessStatus,
  listHeadless,
  modelVerdict,
  readHeadlessStream,
  runnerTurnProven,
  startHeadlessWorker,
  stopHeadless,
  turnLiveness,
  waitHeadless,
} from "../plugins/oh-my-teams/scripts/headless.mjs";
import { main, parseArgs } from "../plugins/oh-my-teams/scripts/teams-org.mjs";
import {
  killTree,
  runTurn,
} from "../plugins/oh-my-teams/scripts/headless-runner.mjs";

const FAKE = path.resolve("tests/fake-agent.mjs");

/**
 * Waits until every runner recorded under stateDir has written its exit.json.
 * This prevents rmSync from racing with a runner that still holds file handles,
 * which causes EPERM on Windows when the directory is removed before the runner
 * releases its open file descriptors (stream.jsonl, stderr.txt).
 *
 * @param {string} stateDir - Headless state directory (contains headless/).
 * @param {number} [timeoutMs=8000] - Give up after this many ms.
 * @returns {Promise<void>}
 */
async function waitAllRunnersExited(stateDir, timeoutMs = 8000) {
  const headlessRoot = path.join(stateDir, "headless");
  if (!fs.existsSync(headlessRoot)) return;
  const deadline = Date.now() + timeoutMs;
  const workerIds = fs
    .readdirSync(headlessRoot)
    .filter((name) => /^[a-z0-9][a-z0-9-]*$/.test(name));
  for (const workerId of workerIds) {
    const workerDir = path.join(headlessRoot, workerId);
    // Request stop so any still-running turn begins to wind down.
    const turnsDir = path.join(workerDir, "turns");
    if (fs.existsSync(turnsDir)) {
      const turnNumbers = fs
        .readdirSync(turnsDir)
        .filter((n) => /^\d+$/.test(n))
        .map(Number)
        .sort((a, b) => a - b);
      const lastTurn = turnNumbers.at(-1);
      if (lastTurn !== undefined) {
        const turnDir = path.join(turnsDir, String(lastTurn));

        const exitFile = path.join(turnDir, "exit.json");
        const stopFile = path.join(turnDir, "stop.request");
        const pidsFile = path.join(turnDir, "pids.json");
        if (!fs.existsSync(exitFile) && !fs.existsSync(stopFile)) {
          try {
            fs.writeFileSync(stopFile, new Date().toISOString());
          } catch {
            // Ignore if already written.
          }
        }
        // Poll until exit.json appears or the deadline passes.
        while (!fs.existsSync(exitFile) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }

        if (fs.existsSync(pidsFile)) {
          let runnerPid;
          runnerPid = JSON.parse(fs.readFileSync(pidsFile, "utf8")).runner;
          if (runnerPid) {
            while (Date.now() < deadline) {
              try {
                process.kill(runnerPid, 0);
                await new Promise((r) => setTimeout(r, 100));
              } catch {
                break;
              }
            }
          }
        }
      }
    }
  }
}

function sandbox(t) {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "omt-headless-")),
  );
  const state = path.join(dir, "state");
  t.after(async () => {
    // Wait for every runner to write exit.json before removing the directory.
    // On Windows, a runner that still has stream.jsonl or stderr.txt open will
    // cause rmSync to fail with EPERM. Waiting for exit.json ensures the runner
    // has called fs.closeSync on those handles before we remove the tree.
    await waitAllRunnersExited(state);
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
    state,
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
  // timeoutMs가 없으면 --print-timeout을 삽입하지 않는다.
  assert.ok(
    !headlessCommand({
      provider: "agy",
      binary: ["agy"],
      prompt,
    }).argv.includes("--print-timeout"),
    "agy without timeoutMs must not include --print-timeout",
  );
  // timeoutMs를 주면 printTimeout(timeoutMs) 값이 argv에 들어간다.
  const ptArgv = headlessCommand({
    provider: "agy",
    binary: ["agy"],
    prompt,
    timeoutMs: 60000,
  }).argv;
  const ptIdx = ptArgv.indexOf("--print-timeout");
  assert.ok(ptIdx !== -1, "agy with timeoutMs must include --print-timeout");
  assert.equal(ptArgv[ptIdx + 1], "55s"); // 60000 - 5000 = 55000ms = 55s
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
  assert.equal(
    modelVerdict("claude", "claude-sonnet-5", "claude-sonnet-5"),
    "matched",
  );
  assert.equal(modelVerdict("claude", "sonnet", "claude-sonnet-5"), "alias");
  assert.equal(modelVerdict("agy", "sonnet", "claude-sonnet-4-6"), "alias");
  assert.equal(modelVerdict("agy", "sonnet", "claude-sonnet-5"), "mismatched");
  assert.equal(
    modelVerdict("agy", "gemini-3.8-flash-high", "gemini-3.1-pro"),
    "mismatched",
  );
  assert.equal(modelVerdict("codex", null, "gpt-5.6-sol"), "unrequested");
  assert.equal(modelVerdict("codex", "gpt-5.6-sol", null), "unproven");
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
  org.profiles["ocx"] = {
    provider: "codex",
    command: ["codex"],
    account: "fixed-account",
    subscription: "Fixed subscription",
    model: "gpt-6-astra",
    effort: "medium",
    runner: {
      kind: "opencodex",
      mode: "fixed-account",
      accountHomeRef: "fixed-account",
      runtimeFingerprint: `sha256:${"a".repeat(64)}`,
    },
  };
  org.roles.junior.profile = "ocx";
  writeJSON(orgFile, org);
  await assert.rejects(
    main([
      "role-terminal",
      "--org",
      orgFile,
      "--role",
      "junior",
      "--worktree",
      "current",
    ]),
    /headless-start only/,
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
test("agy turn.json carries --print-timeout from worker default and per-turn timeoutMs", async (t) => {
  const box = sandbox(t);
  // Worker 기본값: timeoutMs=60000이면 turn.json argv에 --print-timeout 55s가 들어간다.
  startHeadlessWorker({
    stateDir: box.state,
    workerId: "pt-default",
    role: "junior",
    profile: "agy-profile",
    provider: "agy",
    binary: [process.execPath, FAKE, "agy"],
    model: "gemini-fake",
    effort: null,
    cwd: box.cwd,
    prompt: "ASK before writing",
    timeoutMs: 60000,
  });
  const turnJson1 = JSON.parse(
    fs.readFileSync(
      path.join(box.state, "headless", "pt-default", "turns", "1", "turn.json"),
      "utf8",
    ),
  );
  const ptIdx1 = turnJson1.argv.indexOf("--print-timeout");
  assert.ok(ptIdx1 !== -1, "agy turn.json must contain --print-timeout");
  assert.equal(
    turnJson1.argv[ptIdx1 + 1],
    "55s",
    "worker timeoutMs=60000 → --print-timeout 55s",
  );
  assert.equal(
    turnJson1.timeoutMs,
    60000,
    "turn.json timeoutMs matches worker",
  );

  // 턴별 timeoutMs: headless-answer에 timeoutMs를 넘기면 그 값이 turn.json argv에 반영된다.
  await waitHeadless(box.state, "pt-default", 15000, { pollMs: 100 });
  const answered = answerHeadless(box.state, "pt-default", "go ahead", {
    timeoutMs: 90000,
  });
  assert.equal(answered.turn, 2, "answer starts a second turn");
  const turnJson2 = JSON.parse(
    fs.readFileSync(
      path.join(box.state, "headless", "pt-default", "turns", "2", "turn.json"),
      "utf8",
    ),
  );
  const ptIdx2 = turnJson2.argv.indexOf("--print-timeout");
  assert.ok(ptIdx2 !== -1, "per-turn turn.json must contain --print-timeout");
  assert.equal(
    turnJson2.argv[ptIdx2 + 1],
    "85s",
    "per-turn timeoutMs=90000 → --print-timeout 85s",
  );
  assert.equal(
    turnJson2.timeoutMs,
    90000,
    "turn.json timeoutMs matches per-turn value",
  );
});

test("F-01: codexRolloutModel does not re-scan the sessions tree on repeated calls for the same threadId", () => {
  // 수정 전 구현에서는 호출마다 readdirSync를 실행하므로 이 테스트가 실패한다.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omt-f01-cache-"));
  try {
    const codexHome = tmp;
    const sessionDir = path.join(tmp, "sessions", "sub");
    fs.mkdirSync(sessionDir, { recursive: true });
    const threadId = "f01-test-thread";
    const rollout = path.join(sessionDir, `rollout_${threadId}.jsonl`);
    fs.writeFileSync(
      rollout,
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-test" } }) +
        "\n",
    );

    // 캐시를 비워 깨끗한 상태에서 시작한다.
    _codexRolloutCache.clear();

    let readdirCalls = 0;
    const origReaddir = fs.readdirSync;
    fs.readdirSync = (...args) => {
      readdirCalls++;
      return origReaddir.apply(fs, args);
    };
    try {
      const m1 = codexRolloutModel(threadId, codexHome);
      const callsAfterFirst = readdirCalls;
      const m2 = codexRolloutModel(threadId, codexHome);
      const callsAfterSecond = readdirCalls;
      assert.equal(m1, "gpt-test", "first call must find the model");
      assert.equal(m2, "gpt-test", "second call must return the same model");
      // 두 번째 호출에서 readdirSync가 추가로 실행되지 않아야 한다 (캐시 적중).
      assert.equal(
        callsAfterSecond,
        callsAfterFirst,
        "second call must not re-scan: readdirSync call count must not increase",
      );
    } finally {
      fs.readdirSync = origReaddir;
      _codexRolloutCache.clear();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("F-02: headlessStatus reads bytes proportional to STATUS_HEAD + STATUS_TAIL, not file size, for large streams", () => {
  // 수정 전 구현에서는 readFileSync로 전체를 읽으므로 readBytes가 파일 크기와
  // 같아지고 이 테스트가 실패한다.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omt-f02-tail-"));
  try {
    const stateDir = path.join(tmp, "state");
    const cwd = path.join(tmp, "cwd");
    fs.mkdirSync(cwd);
    const workerDir = path.join(stateDir, "headless", "large-stream");
    const turnDir = path.join(workerDir, "turns", "1");
    fs.mkdirSync(turnDir, { recursive: true });
    writeJSON(path.join(workerDir, "worker.json"), {
      schemaVersion: 1,
      id: "large-stream",
      role: "junior",
      profile: "p",
      provider: "claude",
      binary: ["claude"],
      modelRequested: null,
      effortRequested: null,
      cwd,
      timeoutMs: 60000,
    });
    writeJSON(path.join(turnDir, "runner.json"), { pid: null });
    writeJSON(path.join(turnDir, "exit.json"), { code: 0 });

    // stream.jsonl: 헤더 이벤트 + 중간 더미 줄 대량 + result 이벤트
    const header = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "s-large",
      model: "claude-sonnet-5",
    });
    const middle = JSON.stringify({
      type: "assistant",
      message: { content: [] },
    });
    const result = JSON.stringify({
      type: "result",
      is_error: false,
      result: "DONE: large stream done",
      session_id: "s-large",
    });
    const streamFile = path.join(turnDir, "stream.jsonl");
    // 헤더 + 2MB 중간 더미 + result
    const OVER_THRESHOLD = 2 * 1024 * 1024; // STATUS_HEAD_BYTES + STATUS_TAIL_BYTES = 68KB < 2MB
    const fd = fs.openSync(streamFile, "w");
    fs.writeSync(fd, header + "\n");
    let written = header.length + 1;
    while (written < OVER_THRESHOLD) {
      fs.writeSync(fd, middle + "\n");
      written += middle.length + 1;
    }
    fs.writeSync(fd, result + "\n");
    fs.closeSync(fd);
    const fileSize = fs.statSync(streamFile).size;
    assert.ok(
      fileSize > OVER_THRESHOLD,
      `stream.jsonl must be large (${fileSize} bytes)`,
    );

    // readSync 호출을 추적하여 읽은 총 바이트를 측정한다.
    const origReadSync = fs.readSync;
    let totalRead = 0;
    fs.readSync = (fd2, buf, ...rest) => {
      const n = origReadSync.call(fs, fd2, buf, ...rest);
      totalRead += n;
      return n;
    };
    const origReadFileSync = fs.readFileSync;
    let readFileCalls = 0;
    let readFileTotalBytes = 0;
    fs.readFileSync = (...args) => {
      const content = origReadFileSync.apply(fs, args);
      if (
        typeof args[0] === "string" &&
        path.resolve(args[0]) === path.resolve(streamFile)
      ) {
        readFileCalls++;
        readFileTotalBytes +=
          typeof content === "string"
            ? Buffer.byteLength(content, "utf8")
            : content.length;
      }
      return content;
    };
    try {
      const status = headlessStatus(stateDir, "large-stream");
      assert.equal(status.session, "s-large", "session must be extracted");
      assert.equal(status.outcome, "done", "marker must be found in tail");
      // 파일 전체를 readFileSync로 읽었다면 readFileTotalBytes >= fileSize のはず.
      // 수정 후에는 readFileSync로 stream을 읽지 않고 fd로 head+tail만 읽는다.
      assert.equal(
        readFileCalls,
        0,
        "headlessStatus must not call readFileSync for stream.jsonl (must use fd-based tail read)",
      );
      // fd 읽기: headlessStatus 직접 1회 + headlessUsageSummary→readTurn 1회
      // = 최대 2 × (HEAD_BYTES + TAIL_BYTES). 파일 크기에는 비례하지 않는다.
      const MAX_EXPECTED = 2 * (4 + 64) * 1024;
      assert.ok(
        totalRead <= MAX_EXPECTED,
        `tail read must not exceed ${MAX_EXPECTED} bytes, read ${totalRead} (file is ${fileSize})`,
      );
    } finally {
      fs.readSync = origReadSync;
      fs.readFileSync = origReadFileSync;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("F-01 cache-null-model-stale: a null model from a rollout file without turn_context is not cached, allowing a later poll to find the model", () => {
  // 수정 전 구현에서는 rollout 파일을 찾아 null을 캐시에 저장했으므로,
  // 이후 turn_context가 기록되어도 null이 계속 반환된다.
  // 수정 후에는 null을 캐시하지 않아 다음 호출에서 재탐색한다.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omt-f01-stale-"));
  try {
    const codexHome = tmp;
    const sessionDir = path.join(tmp, "sessions", "sub");
    fs.mkdirSync(sessionDir, { recursive: true });
    const threadId = "stale-null-thread";
    const rollout = path.join(sessionDir, `rollout_${threadId}.jsonl`);

    // 1단계: rollout 파일은 있지만 turn_context 줄이 아직 없다.
    fs.writeFileSync(
      rollout,
      JSON.stringify({ type: "thread.started" }) + "\n",
    );

    _codexRolloutCache.clear();
    const m1 = codexRolloutModel(threadId, codexHome);
    assert.equal(m1, null, "no turn_context yet → must return null");
    // null이 캐시에 남아 있어서는 안 된다.
    assert.ok(
      !_codexRolloutCache.has(`${codexHome}:${threadId}`),
      "null result must not be stored in the cache",
    );

    // 2단계: Codex가 turn_context를 기록한다.
    fs.appendFileSync(
      rollout,
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-late" } }) +
        "\n",
    );

    const m2 = codexRolloutModel(threadId, codexHome);
    assert.equal(
      m2,
      "gpt-late",
      "after turn_context is written, the next call must find the model",
    );
    // 이제 캐시에 저장되어야 한다.
    assert.equal(
      _codexRolloutCache.get(`${codexHome}:${threadId}`),
      "gpt-late",
      "a resolved model must be cached so subsequent polls skip the scan",
    );
  } finally {
    _codexRolloutCache.clear();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// F-05: killTree는 플랫폼별로 프로세스 트리를 종료하고 실패를 조용히 삼키지 않는다.
test("F-05: killTree — POSIX에서 실제 자식 프로세스를 종료하고 killError가 null이다", async () => {
  // Windows 실환경이 없으므로 POSIX 경로만 이 PC에서 확인한다.
  // Windows 동작(taskkill /T /F /PID)은 코드 경로로 확인하며, 실측하지 못했다.
  if (process.platform === "win32") {
    // Windows 실환경 없음 — 코드 경로(taskkill /T /F /PID)만 확인, 실측 생략.
    return;
  }
  const { spawn } = await import("node:child_process");
  // 자식 프로세스를 detached로 시작해 자체 프로세스 그룹을 갖게 한다.
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1e9)"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const pid = child.pid;
  assert.ok(pid, "child must have a pid");
  // 자식이 시작할 시간을 준다.
  await new Promise((r) => setTimeout(r, 200));
  // killTree가 프로세스 그룹을 종료하고 null(오류 없음)을 반환해야 한다.
  const killError = killTree(pid);
  assert.equal(
    killError,
    null,
    `killTree must return null on success, got: ${killError}`,
  );
  // 자식이 실제로 사라졌는지 확인한다.
  await new Promise((r) => setTimeout(r, 300));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "child process must be gone after killTree");
});

test("F-05: killTree — 존재하지 않는 pid는 오류 메시지를 반환하고 throw하지 않는다", () => {
  // 절대 존재하지 않을 pid (최댓값 부근)를 넘겨 실패 경로를 검증한다.
  const error = killTree(2147483000);
  // POSIX에서는 ESRCH(No such process)가 반환되어야 한다.
  // Windows 실환경 없음 — taskkill 실패 경로는 코드 경로로만 확인.
  if (process.platform !== "win32") {
    assert.ok(
      typeof error === "string" && error.length > 0,
      `killTree must return an error string for a non-existent pid, got: ${error}`,
    );
  }
});

test("F-05: killTree — pid가 null이면 즉시 null을 반환한다", () => {
  assert.equal(killTree(null), null);
  assert.equal(killTree(undefined), null);
  assert.equal(killTree(0), null);
});

// An explicit OpenCodex turn on a hand-built state directory. `deps` replace
// only what needs a real runtime and account: the owned proxy, the request
// history and the process-group listing. The provider process is real.
const CODEX_TURN = [
  "const emit = (e) => process.stdout.write(JSON.stringify(e) + '\\n');",
  "process.stdin.resume().on('end', () => {",
  "  emit({ type: 'turn.started' });",
  "  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'DONE: wrote it' } });",
  "  emit({ type: 'turn.completed', usage: {} });",
  "});",
].join("\n");

async function runnerTurn(
  t,
  deps = {},
  { command = [process.execPath, "-e", CODEX_TURN], stopAfterMs = 0 } = {},
) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "omt-runner-turn-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omt-runner-cwd-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const runner = {
    kind: "opencodex",
    logicalProvider: "codex",
    model: "gpt-fake",
  };
  const dir = path.join(state, "headless", "w1");
  const turnDir = path.join(dir, "turns", "1");
  fs.mkdirSync(turnDir, { recursive: true });
  writeJSON(path.join(dir, "worker.json"), {
    id: "w1",
    provider: "codex",
    modelRequested: "gpt-fake",
    runner,
  });
  fs.writeFileSync(path.join(turnDir, "stdin.txt"), "do the work");
  writeJSON(path.join(turnDir, "turn.json"), {
    number: 1,
    argv: [],
    stdinFile: "stdin.txt",
    cwd,
    timeoutMs: 20000,
    runner,
  });
  if (stopAfterMs)
    setTimeout(
      () => fs.writeFileSync(path.join(turnDir, "stop.request"), ""),
      stopAfterMs,
    );
  const proxy = {
    port: 1,
    stop: async () => ({ termination: "exited", descendantsExited: true }),
  };
  const record = await runTurn(turnDir, {
    prepare: async () => ({
      proxy,
      binding: {},
      historyBoundary: new Set(),
      command,
      environment: process.env,
    }),
    observe: async () => ({
      requestIds: ["req-1", "req-2"],
      model: "gpt-fake",
    }),
    groupMembers: () => [],
    ...deps,
  });
  const read = (name) => {
    const file = path.join(turnDir, name);
    return fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : null;
  };
  return { record, read, status: headlessStatus(state, "w1") };
}

const posix = {
  skip:
    process.platform === "win32" &&
    "descendant proof needs POSIX process groups",
};

test(
  "an OpenCodex turn with every stage proven is reported done with its request set",
  posix,
  async (t) => {
    const { record, read, status } = await runnerTurn(t);
    assert.equal(record.error, null);
    const lifecycle = read("lifecycle.json");
    assert.deepEqual(
      {
        inputAccepted: lifecycle.inputAccepted,
        turnStarted: lifecycle.turnStarted,
        upstreamRequestStarted: lifecycle.upstreamRequestStarted,
        completed: lifecycle.completed,
        exitObserved: lifecycle.exitObserved,
        cancelRequested: lifecycle.cancelRequested,
        descendantsExited: lifecycle.descendantsExited,
        proxyExited: lifecycle.proxyExited,
        termination: lifecycle.termination,
      },
      {
        inputAccepted: true,
        turnStarted: true,
        upstreamRequestStarted: true,
        completed: true,
        exitObserved: true,
        cancelRequested: false,
        descendantsExited: true,
        proxyExited: true,
        termination: "exited",
      },
    );
    // The record belongs to this turn and to exactly the requests observed.
    assert.equal(lifecycle.attemptId, "w1:1");
    assert.deepEqual(lifecycle.requestIds, ["req-1", "req-2"]);
    assert.equal(status.outcome, "done");
  },
);

test("a zero exit and a DONE line do not survive a failed request-history observation", async (t) => {
  const { record, read, status } = await runnerTurn(t, {
    observe: async () => {
      throw new Error("opencodex-binding-unverified");
    },
  });
  assert.equal(record.code, 0);
  assert.match(record.error, /opencodex-binding-unverified/);
  const lifecycle = read("lifecycle.json");
  // The provider really finished, so the stream and the exit are still recorded,
  // but no upstream request was proven and nothing is promoted from the output.
  assert.equal(lifecycle.turnStarted, true);
  assert.equal(lifecycle.completed, true);
  assert.equal(lifecycle.upstreamRequestStarted, false);
  assert.deepEqual(lifecycle.requestIds, []);
  assert.equal(read("opencodex.json"), null);
  assert.equal(status.marker.kind, "done");
  assert.notEqual(status.outcome, "done");
  assert.equal(status.outcome, "exit-error");
});

test("a proxy whose exit cannot be proven still writes the exit record and is not done", async (t) => {
  const { record, read, status } = await runnerTurn(t, {
    prepare: async () => ({
      proxy: {
        port: 1,
        stop: async () => {
          throw new Error("opencodex-proxy-exit-unverifiable");
        },
      },
      binding: {},
      historyBoundary: new Set(),
      command: [process.execPath, "-e", CODEX_TURN],
      environment: process.env,
    }),
  });
  assert.match(record.error, /opencodex-proxy-exit-unverifiable/);
  const lifecycle = read("lifecycle.json");
  assert.equal(lifecycle.proxyExited, false);
  assert.equal(lifecycle.termination, "unverifiable");
  assert.equal(status.outcome, "exit-error");
});

test(
  "a descendant that outlives the provider makes the turn unverifiable, not done",
  posix,
  async (t) => {
    const { record, read, status } = await runnerTurn(t, {
      groupMembers: () => [4242],
    });
    assert.equal(record.error, null);
    const lifecycle = read("lifecycle.json");
    assert.equal(lifecycle.exitObserved, true);
    assert.equal(lifecycle.descendantsExited, false);
    assert.equal(lifecycle.orphansTerminated, 1);
    assert.equal(lifecycle.termination, "unverifiable");
    assert.equal(status.marker.kind, "done");
    assert.equal(status.outcome, "unverifiable");
  },
);

test("a turn that never started the provider records an unproven lifecycle and no success", async (t) => {
  const { record, read, status } = await runnerTurn(t, {
    prepare: async () => {
      throw new Error("opencodex-action-required: run runtime-install first");
    },
  });
  assert.match(record.error, /opencodex-action-required/);
  const lifecycle = read("lifecycle.json");
  for (const stage of [
    "inputAccepted",
    "turnStarted",
    "upstreamRequestStarted",
    "completed",
    "exitObserved",
    "descendantsExited",
    "proxyExited",
  ]) {
    assert.equal(lifecycle[stage], false, stage);
  }
  assert.equal(lifecycle.termination, "unverifiable");
  assert.equal(status.outcome, "exit-error");
});

test(
  "a stop request is recorded as a cancel request and never as a completed turn",
  posix,
  async (t) => {
    const { record, read, status } = await runnerTurn(
      t,
      {},
      {
        command: [
          process.execPath,
          "-e",
          "process.stdin.resume();setInterval(()=>{},1000)",
        ],
        stopAfterMs: 300,
      },
    );
    assert.equal(record.stopped, true);
    const lifecycle = read("lifecycle.json");
    assert.equal(lifecycle.cancelRequested, true);
    assert.equal(lifecycle.completed, false);
    assert.equal(status.outcome, "stopped");
  },
);

test("runnerTurnProven demands every stage and the same request set in both records", () => {
  const observation = { requestIds: ["a", "b"] };
  const lifecycle = {
    inputAccepted: true,
    turnStarted: true,
    upstreamRequestStarted: true,
    completed: true,
    exitObserved: true,
    descendantsExited: true,
    proxyExited: true,
    termination: "exited",
    requestIds: ["b", "a"],
  };
  assert.equal(runnerTurnProven(observation, lifecycle), true);
  assert.equal(runnerTurnProven(null, lifecycle), false);
  assert.equal(runnerTurnProven(observation, null), false);
  assert.equal(
    runnerTurnProven({ requestIds: [] }, { ...lifecycle, requestIds: [] }),
    false,
  );
  assert.equal(
    runnerTurnProven(observation, { ...lifecycle, requestIds: ["a"] }),
    false,
  );
  assert.equal(
    runnerTurnProven(observation, { ...lifecycle, requestIds: ["a", "c"] }),
    false,
  );
  for (const stage of [
    "inputAccepted",
    "turnStarted",
    "upstreamRequestStarted",
    "completed",
    "exitObserved",
    "descendantsExited",
    "proxyExited",
  ]) {
    assert.equal(
      runnerTurnProven(observation, { ...lifecycle, [stage]: false }),
      false,
      stage,
    );
    assert.equal(
      runnerTurnProven(observation, { ...lifecycle, [stage]: null }),
      false,
      stage,
    );
  }
  assert.equal(
    runnerTurnProven(observation, {
      ...lifecycle,
      termination: "unverifiable",
    }),
    false,
  );
});

test("waitAllRunnersExited waits for runnerPid to exit to prevent EPERM", async (t) => {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "omt-eperm-")),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, "state");
  const turnDir = path.join(stateDir, "headless", "worker-1", "turns", "1");
  fs.mkdirSync(turnDir, { recursive: true });

  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 200)"], {
    detached: true,
  });
  fs.writeFileSync(
    path.join(turnDir, "pids.json"),
    JSON.stringify({ runner: child.pid }),
  );
  fs.writeFileSync(
    path.join(turnDir, "exit.json"),
    JSON.stringify({ code: 0 }),
  );

  await waitAllRunnersExited(stateDir);

  let isRunning = true;
  try {
    process.kill(child.pid, 0);
  } catch {
    isRunning = false;
  }
  assert.equal(isRunning, false, "The runner process should have exited");
});

test("U-01: headlessDetail reads large stream files without memory leak", async () => {
  const tmpDir = path.join(os.tmpdir(), "omt-u01-detail-" + Date.now());
  const workerDir = path.join(tmpDir, "headless", "testworker");
  const turnsDir = path.join(workerDir, "turns");
  const turnDir = path.join(turnsDir, "1");
  fs.mkdirSync(turnDir, { recursive: true });

  fs.writeFileSync(
    path.join(workerDir, "worker.json"),
    JSON.stringify({ provider: "claude" }),
  );
  fs.writeFileSync(
    path.join(workerDir, "status.json"),
    JSON.stringify({ provider: "claude" }),
  );
  fs.writeFileSync(
    path.join(turnDir, "turn.json"),
    JSON.stringify({ number: 1 }),
  );

  const streamFile = path.join(turnDir, "stream.jsonl");
  try {
    const chunk = Buffer.from(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"' +
        "A".repeat(1000) +
        '"}]}}\n'.repeat(1000),
    );
    const fd = fs.openSync(streamFile, "w");
    // 1MB per chunk * 30 = 30MB
    for (let i = 0; i < 30; i++) {
      fs.writeSync(fd, chunk);
    }
    fs.closeSync(fd);

    const testScript = path.join(tmpDir, "child.mjs");
    fs.writeFileSync(
      testScript,
      `
      import { headlessDetail } from "file://${new URL("../plugins/oh-my-teams/scripts/headless.mjs", import.meta.url).pathname}";
      const detail = headlessDetail(process.argv[2], "testworker", { limit: 10 });
      if (detail.turns[0].transcript.length === 0) throw new Error("Empty transcript");
    `,
    );

    const { execSync } = await import("child_process");
    execSync(`node --max-old-space-size=20 "${testScript}" "${tmpDir}"`, {
      stdio: "pipe",
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("U-01: buildLifecycle reads large stream files without memory leak", async () => {
  const tmpDir = path.join(os.tmpdir(), "omt-u01-lifecycle-" + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  const turnDir = path.join(tmpDir, "headless", "testworker", "turns", "1");
  fs.mkdirSync(turnDir, { recursive: true });

  try {
    const streamFile = path.join(turnDir, "stream.jsonl");
    const fd = fs.openSync(streamFile, "w");
    fs.writeSync(fd, '{"type":"turn.started"}\n');
    const chunk = Buffer.from(
      '{"type":"middle","data":"' + "A".repeat(1000) + '"}\n'.repeat(1000),
    );
    for (let i = 0; i < 30; i++) {
      fs.writeSync(fd, chunk);
    }
    fs.writeSync(fd, '{"type":"turn.completed"}\n');
    fs.closeSync(fd);

    const testScript = path.join(tmpDir, "child.mjs");
    fs.writeFileSync(
      testScript,
      `
      import { buildLifecycle } from "file://${new URL("../plugins/oh-my-teams/scripts/headless-runner.mjs", import.meta.url).pathname}";
      const lifecycle = buildLifecycle({
        turnDir: process.argv[2],
        observed: { requestIds: ["req1"] },
        inputAccepted: true,
        exitObserved: true,
        cancelRequested: false,
        descendantsExited: true,
        orphansTerminated: 0,
        proxyExited: true,
      });
      if (!lifecycle.turnStarted || !lifecycle.completed || lifecycle.termination !== "exited") {
        throw new Error("Invalid lifecycle");
      }
    `,
    );

    const { execSync } = await import("child_process");
    execSync(`node --max-old-space-size=20 "${testScript}" "${turnDir}"`, {
      stdio: "pipe",
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("U-01 (결과 동일성 테스트): chunk parsing correctly handles boundaries (long line, multi-byte, no trailing newline, empty lines)", async () => {
  const { headlessTranscriptFile } =
    await import("../plugins/oh-my-teams/scripts/headless.mjs");
  const { buildLifecycle } =
    await import("../plugins/oh-my-teams/scripts/headless-runner.mjs");

  const tmpDir = path.join(os.tmpdir(), "omt-u01-boundary-" + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  const turnDir = path.join(tmpDir, "headless", "testworker", "turns", "1");
  fs.mkdirSync(turnDir, { recursive: true });
  fs.writeFileSync(
    path.join(turnDir, "turn.json"),
    JSON.stringify({ number: 1 }),
  );
  const streamFile = path.join(turnDir, "stream.jsonl");

  let buf = Buffer.from('{"type":"turn.started"}\n\n\n');

  const longText = "A".repeat(70000);
  buf = Buffer.concat([
    buf,
    Buffer.from(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"' +
        longText +
        '"}]}}\n',
    ),
  ]);

  const paddingLen = 65535 - buf.length;
  const padding = "B".repeat(Math.max(0, paddingLen));
  buf = Buffer.concat([
    buf,
    Buffer.from(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"' +
        padding,
    ),
  ]);

  buf = Buffer.concat([buf, Buffer.from('가나다"}]}}\n')]);
  buf = Buffer.concat([buf, Buffer.from('{"type":"turn.completed"}')]);

  fs.writeFileSync(streamFile, buf);

  try {
    const transcript = headlessTranscriptFile("claude", streamFile, 100);
    assert.equal(transcript.length, 2);
    assert.equal(transcript[0].text, longText);
    assert.ok(transcript[1].text.endsWith("가나다"));

    const lifecycle = buildLifecycle({
      turnDir,
      observed: { requestIds: ["req1"] },
      inputAccepted: true,
      exitObserved: true,
      cancelRequested: false,
      descendantsExited: true,
      orphansTerminated: 0,
      proxyExited: true,
    });
    assert.equal(lifecycle.turnStarted, true);
    assert.equal(lifecycle.completed, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
