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
  translateLocalFailure,
} from "../plugins/oh-my-teams/scripts/local-adapter.mjs";
import { classifyFailure } from "../plugins/oh-my-teams/scripts/failures.mjs";

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

  // The adapter built the argv, so no profile change repairs this. Routing it
  // to the role that owns profiles would hand the work to someone with no way
  // to fix it, which is worse than escalating with the evidence.
  assert.equal(
    classifyFailure(translateOrcaFailure("invalid_argument", "bad flag"))
      .category,
    "unknown",
  );
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
