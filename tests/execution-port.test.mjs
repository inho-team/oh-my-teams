/** Covers the execution port contract shared by the Orca and local adapters. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  NEUTRAL_FAILURE_KINDS,
  assertFailureSignal,
  assertWorkerReceipt,
  assertWorkspaceReceipt,
} from "../plugins/oh-my-teams/scripts/execution.mjs";
import {
  startWorker as startOrcaWorker,
  translateOrcaFailure,
} from "../plugins/oh-my-teams/scripts/orca-adapter.mjs";
import {
  startWorker as startLocalWorker,
  translateLocalCode,
  translateLocalFailure,
} from "../plugins/oh-my-teams/scripts/local-adapter.mjs";
import { classifyFailure } from "../plugins/oh-my-teams/scripts/failures.mjs";
import {
  EXECUTION_RUNTIMES,
  withRuntimeSignal,
} from "../plugins/oh-my-teams/scripts/adapters.mjs";

const discovery = { executable: "orca", versionsMatch: true };

const reply = (stdout, extra = {}) => {
  const calls = [];
  const execute = async (argv) => {
    calls.push(argv);
    return { code: 0, stdout, stderr: "", timedOut: false, ...extra };
  };
  return { calls, execute };
};

function orcaReceipt(state, extra = {}) {
  return JSON.stringify({
    ok: true,
    result: {
      runId: "run_1",
      taskId: "task_1",
      dispatchId: "ctx_1",
      state,
      effects: [],
      residualResources: [],
      ...extra,
    },
  });
}

test("runtime codes route without naming the runtime in failure routing", () => {
  const reconcile = {
    category: "process-unknown",
    nextOwner: "pl",
    action: "reconcile-execution",
    retryable: false,
  };
  const cases = [
    [
      "agent_unconfigured",
      {
        category: "execution-unconfigured",
        nextOwner: "pm",
        action: "rebind-profile-agent",
        retryable: false,
      },
    ],
    ["inject_rejected", reconcile],
    ["runtime_error", reconcile],
    ["failed", reconcile],
    ["outcome_unknown", reconcile],
    ["start_unknown", reconcile],
    ["turn_start_unobserved", reconcile],
    ["unverifiable", reconcile],
  ];

  for (const [code, expected] of cases) {
    const signal = translateOrcaFailure(code, "example detail");
    assert.equal(signal.code, code, `${code} keeps its own code as evidence`);
    assert.deepEqual(classifyFailure(signal), expected, code);
  }

  // Both of these say the call itself was wrong: built with bad argv, or made
  // from a terminal that does not hold the Run. `consumer_fenced` is what a
  // live runtime actually answered when the wrapper ran outside a coordinator
  // terminal, so it is known and unmapped rather than merely unseen.
  for (const code of ["invalid_argument", "consumer_fenced"]) {
    assert.equal(
      classifyFailure(translateOrcaFailure(code, "the call was wrong"))
        .category,
      "unknown",
      code,
    );
  }
  assert.equal(
    classifyFailure(translateOrcaFailure("incompatible_runtime", "old host"))
      .action,
    "repair-environment",
  );
});

test("an unrecognized runtime code stays unclassified but keeps its evidence", () => {
  const signal = translateOrcaFailure("brand_new_code");
  assert.equal(signal.message, "Orca reported brand_new_code");
  assert.equal(signal.kind, undefined);
  assert.equal(classifyFailure(signal).category, "unknown");
});

test("a failure the runtime did not name is recorded as unnamed, not invented", () => {
  const signal = translateOrcaFailure(undefined);
  assert.equal(signal.code, "code_absent");
  assert.notEqual(signal.code, "runtime_error");
  assert.equal(classifyFailure(signal).action, "reconcile-execution");
});

test("every neutral kind the port advertises has a route", () => {
  for (const kind of NEUTRAL_FAILURE_KINDS) {
    const route = classifyFailure({ kind, message: `signal for ${kind}` });
    assert.notEqual(
      route.category,
      "unknown",
      `${kind} is advertised by the port but routes nowhere`,
    );
  }
});

test("a signal cannot claim a routing kind the classifier would discard", () => {
  assert.throws(
    () =>
      assertFailureSignal({
        kind: "environment",
        processState: "unknown",
        code: "both",
        message: "two competing routes",
      }),
    /both a routing kind and an unknown process/,
  );
});

test("failure routing stays free of execution-runtime vocabulary", () => {
  const source = fs
    .readFileSync(
      new URL("../plugins/oh-my-teams/scripts/failures.mjs", import.meta.url),
      "utf8",
    )
    .toLowerCase();
  const forbidden = [
    "agent_unconfigured",
    "inject_rejected",
    "start_unknown",
    "turn_start_unobserved",
    "orca",
  ];
  for (const word of forbidden) {
    assert.ok(!source.includes(word), `failures.mjs must not name ${word}`);
  }
});

test("a ready Orca start yields a port receipt built from an argv array", async () => {
  const { calls, execute } = reply(orcaReceipt("ready"));
  const receipt = await startOrcaWorker("/repo", {
    task: "task_1",
    agent: "codex",
    model: "gpt-5.6-luna",
    discovery,
    execute,
  });

  const argv = calls[0];
  assert.ok(argv.every((argument) => typeof argument === "string"));
  assert.deepEqual(argv.slice(0, 3), ["orca", "orchestration", "worker-start"]);
  assert.ok(argv.includes("--json") && argv.includes("--model"));
  assert.equal(receipt.workerId, "ctx_1");
  assert.equal(receipt.liveness, "live");
  assert.equal(receipt.failure, null);
  assert.deepEqual(assertWorkerReceipt(receipt), receipt);
});

test("a non-zero start is read as a receipt, not as a crash", async () => {
  const stdout = orcaReceipt("failed", {
    failedStage: "agent-ready",
    lastError: "zsh: parse error near ')'",
    residualResources: [{ terminal: "t1" }],
  });
  const { execute } = reply(stdout, { code: 1 });
  const receipt = await startOrcaWorker("/repo", {
    task: "task_1",
    agent: "codex",
    discovery,
    execute,
  });

  assert.equal(receipt.liveness, "unverifiable");
  assert.equal(receipt.failure.code, "failed");
  assert.equal(receipt.failure.processState, "unknown");
  assert.equal(receipt.residualResources.length, 1);
  assert.equal(classifyFailure(receipt.failure).action, "reconcile-execution");
});

test("a state the hint table never saw still reaches a reconciling route", async () => {
  const { execute } = reply(orcaReceipt("cancelled"), { code: 1 });
  const receipt = await startOrcaWorker("/repo", {
    task: "task_1",
    agent: "codex",
    discovery,
    execute,
  });

  assert.equal(receipt.liveness, "unverifiable");
  assert.equal(receipt.failure.code, "cancelled");
  assert.deepEqual(classifyFailure(receipt.failure), {
    category: "process-unknown",
    nextOwner: "pl",
    action: "reconcile-execution",
    retryable: false,
  });
});

test("a receipt without a task id keeps the dispatch someone must reclaim", async () => {
  const stdout = JSON.stringify({
    ok: true,
    result: {
      dispatchId: "ctx_1",
      state: "failed",
      residualResources: [{ terminal: "t1" }],
    },
  });
  const { execute } = reply(stdout, { code: 1 });
  const receipt = await startOrcaWorker("/repo", {
    task: "task_1",
    agent: "codex",
    discovery,
    execute,
  });

  assert.equal(receipt.workerId, "ctx_1");
  assert.equal(receipt.taskId, null);
  assert.equal(receipt.residualResources.length, 1);
});

test("a refused start throws a translated signal instead of a bare string", async () => {
  const stdout = JSON.stringify({
    ok: false,
    error: {
      code: "agent_unconfigured",
      message: "A configured --agent is required.",
    },
  });
  const { execute } = reply(stdout, { code: 1 });
  await assert.rejects(
    () =>
      startOrcaWorker("/repo", {
        task: "task_1",
        agent: "agy",
        discovery,
        execute,
      }),
    (error) => {
      assert.equal(error.signal.kind, "execution-unconfigured");
      assert.equal(classifyFailure(error.signal).nextOwner, "pm");
      return true;
    },
  );
});

test("a start with no receipt is unknown and never a silent success", async () => {
  const { execute } = reply("", { code: 1, timedOut: true });
  await assert.rejects(
    () =>
      startOrcaWorker("/repo", {
        task: "task_1",
        agent: "codex",
        discovery,
        execute,
      }),
    (error) => {
      assert.equal(error.signal.code, "start_unknown");
      assert.equal(classifyFailure(error.signal).category, "process-unknown");
      return true;
    },
  );
});

test("launch arguments the runtime rejects are refused before the call", async () => {
  const { calls, execute } = reply(orcaReceipt("ready"));
  const start = (options) =>
    startOrcaWorker("/repo", { discovery, execute, ...options });

  await assert.rejects(
    start({ agent: "codex" }),
    /exactly one of task or spec/,
  );
  await assert.rejects(
    start({ task: "t", spec: "s", agent: "codex" }),
    /exactly one of task or spec/,
  );
  await assert.rejects(
    start({ task: "t" }),
    /exactly one of agent or terminal/,
  );
  await assert.rejects(
    start({ task: "t", agent: "codex", effort: "high" }),
    /model before an effort/,
  );
  await assert.rejects(
    start({ task: "t", terminal: "h1", model: "m" }),
    /reusing an existing terminal/,
  );
  assert.equal(calls.length, 0, "no refused start reaches the runtime");
});

// Answers `terminal wait` with `wait` and everything else with `start`.
const orcaVerbs = ({ wait, start = orcaReceipt("ready") }) => {
  const calls = [];
  const execute = async (argv) => {
    calls.push(argv);
    const answer = argv[1] === "terminal" ? wait : { stdout: start };
    return { code: 0, stderr: "", timedOut: false, ...answer };
  };
  return { calls, execute };
};

test("a reused terminal is checked for tui-idle before worker-start", async () => {
  const { calls, execute } = orcaVerbs({
    wait: { stdout: JSON.stringify({ ok: true, result: {} }) },
  });
  const receipt = await startOrcaWorker("/repo", {
    task: "task_1",
    terminal: "term_1",
    discovery,
    execute,
  });
  assert.equal(receipt.liveness, "live");
  assert.deepEqual(calls[0].slice(0, 8), [
    "orca",
    "terminal",
    "wait",
    "--terminal",
    "term_1",
    "--for",
    "tui-idle",
    "--timeout-ms",
  ]);
  assert.deepEqual(calls[1].slice(0, 3), [
    "orca",
    "orchestration",
    "worker-start",
  ]);

  // A launch by agent opens its own terminal, so nothing is probed.
  const byAgent = orcaVerbs({ wait: { stdout: "unused" } });
  await startOrcaWorker("/repo", {
    task: "task_1",
    agent: "codex",
    discovery,
    execute: byAgent.execute,
  });
  assert.equal(byAgent.calls.length, 1);
  assert.equal(byAgent.calls[0][1], "orchestration");
});

test("a terminal that never reports idle is refused before any Dispatch", async () => {
  // Orca 1.4.204 answered an Agy terminal this way; the exit code is not
  // relied on, so both are covered.
  const timedOut = JSON.stringify({ ok: false, error: { code: "timeout" } });
  for (const code of [0, 1]) {
    const { calls, execute } = orcaVerbs({ wait: { stdout: timedOut, code } });
    await assert.rejects(
      () =>
        startOrcaWorker("/repo", {
          task: "task_1",
          terminal: "term_1",
          discovery,
          execute,
        }),
      (error) => {
        assert.equal(error.signal.code, "timeout");
        assert.equal(error.signal.kind, "execution-unconfigured");
        assert.match(error.message, /no Dispatch was created/);
        const routed = classifyFailure(error.signal);
        assert.equal(routed.nextOwner, "pm");
        assert.equal(routed.retryable, false);
        return true;
      },
    );
    assert.equal(calls.length, 1, "worker-start is never called");
  }

  // Any other wait failure keeps Orca's own code instead of this route.
  const missing = orcaVerbs({
    wait: {
      code: 1,
      stdout: JSON.stringify({
        ok: false,
        error: { code: "terminal_not_found", message: "no such terminal" },
      }),
    },
  });
  await assert.rejects(
    () =>
      startOrcaWorker("/repo", {
        task: "task_1",
        terminal: "term_x",
        discovery,
        execute: missing.execute,
      }),
    (error) => {
      assert.equal(error.signal.code, "terminal_not_found");
      assert.equal(error.signal.kind, undefined);
      return true;
    },
  );
  assert.equal(missing.calls.length, 1);
});

test("a terminal held at a prompt is refused before any Dispatch", async () => {
  // Orca answers tui-idle at once with satisfied: false and a blockedReason
  // when the screen shows a trust, update or approval prompt. The envelope is
  // still ok, so reading only `ok` handed a Claude or Codex terminal stuck at
  // a folder trust question to worker-start, which then failed its Dispatch.
  const blocked = orcaVerbs({
    wait: {
      stdout: JSON.stringify({
        ok: true,
        result: {
          wait: {
            handle: "term_1",
            condition: "tui-idle",
            satisfied: false,
            status: "running",
            blockedReason: "agent-trust-workspace",
          },
        },
      }),
    },
  });
  await assert.rejects(
    () =>
      startOrcaWorker("/repo", {
        task: "task_1",
        terminal: "term_1",
        discovery,
        execute: blocked.execute,
      }),
    (error) => {
      assert.equal(error.signal.code, "agent-trust-workspace");
      // Only someone at the terminal can answer the prompt, so no route is
      // invented for it.
      assert.equal(error.signal.kind, undefined);
      assert.match(error.message, /agent-trust-workspace/);
      assert.match(error.message, /no Dispatch was created/);
      return true;
    },
  );
  assert.equal(blocked.calls.length, 1, "worker-start is never called");

  // A reason that happens to match a hinted code gains no route, and a wait
  // that names no reason is not described as a prompt.
  for (const [blockedReason, code, prompt] of [
    ["failed", "failed", true],
    [undefined, "not_idle", false],
  ]) {
    const { execute } = orcaVerbs({
      wait: {
        stdout: JSON.stringify({
          ok: true,
          result: { wait: { satisfied: false, blockedReason } },
        }),
      },
    });
    await assert.rejects(
      () =>
        startOrcaWorker("/repo", {
          task: "task_1",
          terminal: "term_1",
          discovery,
          execute,
        }),
      (error) => {
        assert.equal(error.signal.code, code);
        assert.equal(error.signal.kind, undefined);
        assert.equal(error.signal.processState, undefined);
        assert.equal(/held at a prompt/.test(error.message), prompt);
        return true;
      },
    );
  }
});

test("the local adapter reports an exited worker and never claims liveness", async () => {
  const stdout = JSON.stringify({
    result: "done",
    model: "claude-sonnet-4-6",
  });
  const { execute } = reply(stdout);
  const receipt = await startLocalWorker("attempt_1", {
    profile: {
      provider: "claude",
      command: ["claude"],
      model: "claude-sonnet-4-6",
    },
    cwd: process.cwd(),
    prompt: "summarize",
    execute,
  });

  assert.equal(receipt.liveness, "exited");
  assert.notEqual(receipt.liveness, "live");
  assert.equal(receipt.failure, null);
  assert.deepEqual(assertWorkerReceipt(receipt), receipt);
});

test("a killed local call is unverifiable and routes for reconciliation", async () => {
  const { execute } = reply("", { code: -1, timedOut: true });
  const receipt = await startLocalWorker("attempt_1", {
    profile: { provider: "claude", command: ["claude"] },
    cwd: process.cwd(),
    prompt: "summarize",
    execute,
  });

  assert.equal(receipt.liveness, "unverifiable");
  assert.notEqual(receipt.liveness, "exited");
  assert.equal(receipt.failure.code, "call_unobserved");
  assert.deepEqual(classifyFailure(receipt.failure), {
    category: "process-unknown",
    nextOwner: "pl",
    action: "reconcile-execution",
    retryable: false,
  });
});

test("an overflowing local call is treated the same as a timed-out one", () => {
  const signal = translateLocalFailure({ overflow: true, code: 0 });
  assert.equal(signal.processState, "unknown");
  assert.equal(classifyFailure(signal).action, "reconcile-execution");
});

test("both adapters answer the same workspace contract", () => {
  const orca = assertWorkspaceReceipt({ id: "wtr_1", path: "/child" });
  const local = assertWorkspaceReceipt({ id: "feature", path: "/child" });
  assert.deepEqual(Object.keys(orca), Object.keys(local));
  assert.throws(
    () => assertWorkspaceReceipt({ path: "/child" }),
    /requires an identifier/,
  );
});

test("a receipt that omits liveness or residual resources is refused", () => {
  const base = { workerId: "w1", residualResources: [], failure: null };
  assert.throws(
    () => assertWorkerReceipt({ ...base, liveness: "running" }),
    /unknown liveness/,
  );
  assert.throws(
    () =>
      assertWorkerReceipt({ ...base, liveness: "exited", failure: undefined }),
    /failure signal or an explicit null/,
  );
  assert.throws(
    () =>
      assertWorkerReceipt({
        workerId: "w1",
        liveness: "exited",
        failure: null,
      }),
    /resources left behind/,
  );
});

test("a failure record naming a runtime is routed by that runtime's code", () => {
  const record = {
    message: "Orca refused the start",
    evidence: "run_ae5452be5779",
    runtime: "orca",
    code: "agent_unconfigured",
  };
  const routed = withRuntimeSignal(record);

  assert.equal(routed.message, record.message, "the written evidence survives");
  assert.deepEqual(classifyFailure(routed), {
    category: "execution-unconfigured",
    nextOwner: "pm",
    action: "rebind-profile-agent",
    retryable: false,
  });
  assert.equal(
    classifyFailure(record).category,
    "unknown",
    "the same record without translation is what used to block the retry",
  );
});

test("each registered runtime translates its own vocabulary", () => {
  assert.deepEqual([...EXECUTION_RUNTIMES], ["orca", "local"]);
  assert.equal(
    classifyFailure(
      withRuntimeSignal({
        message: "the call was killed",
        evidence: "call.log",
        runtime: "local",
        code: "call_unobserved",
      }),
    ).action,
    "reconcile-execution",
  );
  assert.throws(
    () => withRuntimeSignal({ runtime: "paseo", code: "nope" }),
    /Unknown execution runtime: paseo/,
  );
  assert.throws(
    () => withRuntimeSignal({ runtime: "orca" }),
    /must also name the code/,
  );
});

test("a record that names no runtime routes exactly as it did before", () => {
  const record = {
    message: "tests failed",
    evidence: "check.log",
    checkFailed: true,
  };
  assert.equal(withRuntimeSignal(record), record);
  assert.equal(classifyFailure(record).category, "implementation-error");
});

test("every provider failure class is translated or deliberately left alone", () => {
  // The provider registry does not export its failure classes, so the classes
  // are read from the adapters that return them. A provider added later brings
  // its own class with it, and this is what notices that the local translation
  // table did not grow with it.
  const directory = new URL(
    "../plugins/oh-my-teams/scripts/providers/",
    import.meta.url,
  );
  const classes = new Set();
  for (const file of fs.readdirSync(directory)) {
    const source = fs.readFileSync(new URL(file, directory), "utf8");
    for (const [, value] of source.matchAll(/return "([a-z][a-z-]+)";/g)) {
      classes.add(value);
    }
  }
  assert.ok(classes.size >= 6, "no provider failure classes were found");

  // A provider that rejected the request said why in its own words; only the
  // recorded evidence can place that, so it stays unrouted on purpose.
  const deliberatelyUnmapped = new Set(["model-error"]);
  for (const failureClass of classes) {
    const routed = classifyFailure(translateLocalCode(failureClass, "detail"));
    const unmapped = routed.category === "unknown";
    assert.equal(
      unmapped,
      deliberatelyUnmapped.has(failureClass),
      `${failureClass} routes to ${routed.category}; add it to the local ` +
        `translation table or to this test's deliberate exceptions`,
    );
  }
});

test("a local model mismatch routes to the profile owner, not the workspace", () => {
  const signal = translateLocalFailure({
    modelBinding: {
      status: "mismatched",
      requested: "claude-opus-4-6",
      effective: "claude-sonnet-4-6",
    },
  });
  assert.equal(signal.kind, "model-binding");
  assert.deepEqual(classifyFailure(signal), {
    category: "model-binding-mismatch",
    nextOwner: "pm",
    action: "rebind-profile-model",
    retryable: false,
  });
});

test("local quota classes keep the route failure handling already owns", () => {
  const signal = translateLocalFailure({
    failureClass: "pool-exhausted",
    stderr: "pool exhausted",
  });
  assert.equal(signal.kind, undefined);
  assert.deepEqual(classifyFailure(signal), {
    category: "quota-exhausted",
    nextOwner: "pm",
    action: "apply-saved-quota-policy",
    retryable: true,
  });
});

test("matrix-mismatch는 matrix-prediction-failure로 분류된다", () => {
  const result = classifyFailure({ kind: "matrix-mismatch" });
  assert.deepEqual(result, {
    category: "matrix-prediction-failure",
    nextOwner: "pm",
    action: "revise-matrix",
    retryable: false,
  });
});

test("matrix-mismatch 신호는 포트 계약의 유효한 kind이다", () => {
  assert.ok(
    NEUTRAL_FAILURE_KINDS.includes("matrix-mismatch"),
    "matrix-mismatch must be in NEUTRAL_FAILURE_KINDS",
  );
  // assertFailureSignal은 알려진 kind만 통과시킨다
  const signal = assertFailureSignal({
    kind: "matrix-mismatch",
    code: "approval_required",
    message: "Terminal held at approval prompt despite supervised-terminal prediction",
  });
  assert.equal(signal.kind, "matrix-mismatch");
});

test("사후 거부와 표 불일치: matrixPrediction supervised-terminal → matrix-mismatch kind 반환", async () => {
  // checkTerminalIdle이 satisfied===false를 받고 matrixPrediction이 supervised-terminal이면
  // 던지는 오류에 signal.kind === 'matrix-mismatch'가 붙어야 한다
  const fakeWait = async () => ({
    code: 0,
    timedOut: false,
    stdout: JSON.stringify({
      ok: true,
      result: { wait: { satisfied: false, blockedReason: "approval_required" } },
    }),
    stderr: "",
  });
  const { checkTerminalIdle } = await import(
    "../plugins/oh-my-teams/scripts/orca-adapter.mjs"
  );
  const matrixPrediction = { path: "supervised-terminal", evidence: "unverified" };
  const err = await checkTerminalIdle("term_x", {
    matrixPrediction,
    execute: fakeWait,
  }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "checkTerminalIdle should throw");
  assert.equal(
    err.signal?.kind,
    "matrix-mismatch",
    `Expected matrix-mismatch, got ${err.signal?.kind}`,
  );
  assert.match(err.message, /matrix-prediction-failure/);
});

test("matrixPrediction이 없으면 blocked prompt는 matrix-mismatch가 붙지 않는다", async () => {
  const fakeWait = async () => ({
    code: 0,
    timedOut: false,
    stdout: JSON.stringify({
      ok: true,
      result: { wait: { satisfied: false, blockedReason: "approval_required" } },
    }),
    stderr: "",
  });
  const { checkTerminalIdle } = await import(
    "../plugins/oh-my-teams/scripts/orca-adapter.mjs"
  );
  const err = await checkTerminalIdle("term_y", {
    execute: fakeWait,
  }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "checkTerminalIdle should throw");
  assert.equal(
    err.signal?.kind,
    undefined,
    `Expected no kind, got ${err.signal?.kind}`,
  );
  assert.doesNotMatch(err.message, /matrix-prediction-failure/);
});

