/** #41: starting Agy roles, the injection exception, and the records it needs. */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  checkTerminalIdle,
  injectTask,
} from "../plugins/oh-my-teams/scripts/orca-adapter.mjs";
import { withRuntimeSignal } from "../plugins/oh-my-teams/scripts/adapters.mjs";
import { classifyFailure } from "../plugins/oh-my-teams/scripts/failures.mjs";
import {
  ALLOWED_OPTIONS,
  main,
  parseArgs,
} from "../plugins/oh-my-teams/scripts/teams-org.mjs";

const reply = (result) => ({
  code: 0,
  stdout: JSON.stringify({ ok: true, result }),
});

test("an idle check refuses a terminal before any attempt is reserved", async () => {
  const calls = [];
  const idle = async (argv) => {
    calls.push(argv);
    return reply({ wait: { satisfied: true } });
  };
  assert.deepEqual(
    await checkTerminalIdle("term_1", { executable: "orca", execute: idle }),
    { terminal: "term_1", idle: true },
  );
  assert.deepEqual(calls[0].slice(1, 6), [
    "terminal",
    "wait",
    "--terminal",
    "term_1",
    "--for",
  ]);

  const busy = async () => ({
    code: 1,
    stdout: JSON.stringify({
      ok: false,
      error: { code: "timeout", message: "not idle" },
    }),
  });
  await assert.rejects(
    checkTerminalIdle("term_1", { executable: "orca", execute: busy }),
    (error) =>
      error.signal?.kind === "execution-unconfigured" &&
      error.signal.code === "timeout" &&
      /no Dispatch was created/.test(error.message),
  );
});

test("the injection exception creates the task, injects it, and reports both", async () => {
  const calls = [];
  const execute = async (argv) => {
    calls.push(argv.slice(1, -1));
    if (argv[2] === "task-create") return reply({ task: { id: "task_9" } });
    return reply({
      dispatch: { id: "ctx_9", run_id: "run_1" },
      injected: true,
    });
  };
  const injected = await injectTask("/repo", {
    spec: "# oh my teams 역할 지시\n작업",
    terminal: "term_1",
    runId: "run_1",
    executable: "orca",
    execute,
  });
  assert.deepEqual(injected, {
    taskId: "task_9",
    dispatchId: "ctx_9",
    runId: "run_1",
    terminal: "term_1",
    injected: true,
  });
  assert.deepEqual(calls[0], [
    "orchestration",
    "task-create",
    "--spec",
    "# oh my teams 역할 지시\n작업",
    "--run",
    "run_1",
  ]);
  assert.deepEqual(calls[1], [
    "orchestration",
    "dispatch",
    "--task",
    "task_9",
    "--to",
    "term_1",
    "--inject",
    "--run",
    "run_1",
  ]);
  // An existing task is dispatched as it is.
  calls.length = 0;
  await injectTask("/repo", {
    task: "task_5",
    terminal: "term_1",
    executable: "orca",
    execute,
  });
  assert.equal(calls.length, 1);
  await assert.rejects(
    injectTask("/repo", { terminal: "term_1", execute }),
    /exactly one of task or spec/,
  );
});

test("worker-start takes the user's approval for the injection exception", () => {
  assert.ok(ALLOWED_OPTIONS["worker-start"].includes("inject-fallback"));
  assert.ok(ALLOWED_OPTIONS["terminal-idle-check"].includes("terminal"));
});

test("a failure record carrying the wrapper's signal is routed by it", () => {
  // #41: the documented {runtime, code: "timeout"} record fell to unknown,
  // because the probe timeout is left out of the translation table on purpose.
  const signal = {
    kind: "execution-unconfigured",
    code: "timeout",
    message: "Terminal term_1 did not report tui-idle",
  };
  const record = {
    message: "Agy Junior was refused",
    evidence: "receipt 43e1",
    signal,
  };
  assert.deepEqual(
    classifyFailure(withRuntimeSignal(record)),
    classifyFailure({ kind: "execution-unconfigured" }),
  );
  assert.equal(withRuntimeSignal(record).message, "Agy Junior was refused");
  assert.equal(
    classifyFailure(
      withRuntimeSignal({
        message: "x",
        evidence: "y",
        runtime: "orca",
        code: "timeout",
      }),
    ).category,
    "unknown",
  );
  assert.throws(
    () =>
      withRuntimeSignal({
        ...record,
        signal: { kind: "made-up", code: "x", message: "y" },
      }),
    /unknown kind/,
  );
});

test("role-spec --text prints the instruction itself, not JSON", async () => {
  // #41: the JSON output went into task-create --spec escaped.
  assert.equal(parseArgs(["role-spec", "--text"]).text, true);
  const org = path.resolve("plugins/oh-my-teams/examples/organization.json");
  readJSON(org);
  const printed = [];
  const log = console.log;
  console.log = (line) => printed.push(line);
  try {
    await main([
      "role-spec",
      "--org",
      org,
      "--role",
      "senior",
      "--spec",
      "출처를 대조한다.",
      "--text",
    ]);
  } finally {
    console.log = log;
  }
  assert.equal(printed.length, 1);
  assert.match(printed[0], /^# oh my teams 역할 지시\n역할: Senior/);
  assert.match(printed[0], /# 작업\n출처를 대조한다\./);
  assert.doesNotMatch(printed[0], /^\{/);
});

test("the runtime reference explains the narrow launch and the exception path", async () => {
  const fs = await import("node:fs");
  const runtime = fs.readFileSync(
    path.resolve("plugins/oh-my-teams/references/orca-runtime.md"),
    "utf8",
  );
  assert.match(
    runtime,
    /node <runtime> terminal-idle-check --terminal <handle>\nnode <runtime> workflow-reserve/,
  );
  assert.match(
    runtime,
    /`stty cols 44;`를, Windows의 PowerShell에서는 `mode con: cols=44;`를 앞에 붙여 띄운다/,
  );
  assert.match(runtime, /\*\*주입 예외 경로\.\*\*/);
  assert.match(runtime, /`--inject-fallback "<누가 무엇을 승인했는지>"`/);
  assert.match(runtime, /그 객체를 `signal` 필드에 그대로 옮긴다/);
  assert.match(
    fs.readFileSync(
      path.resolve("plugins/oh-my-teams/skills/pm/SKILL.md"),
      "utf8",
    ),
    /`role-spec --text`의 출력/,
  );
});

const refuse = (code, message) => ({
  code: 0,
  stdout: JSON.stringify({ ok: false, error: { code, message } }),
});

test("a refused injection is returned, and the task it created is closed", async () => {
  // #46: on Windows Orca did not recognize the Agy terminal, refused the
  // injection with inject_rejected, and the wrapper threw Orca's raw error. The
  // documented blocked result never appeared, and a task it had created was
  // left ready in the Run with no Dispatch to carry it.
  const calls = [];
  const execute = async (argv) => {
    calls.push(argv.slice(1, -1));
    if (argv[2] === "task-create") return reply({ task: { id: "task_7" } });
    if (argv[2] === "dispatch")
      return refuse(
        "inject_rejected",
        "Cannot dispatch --inject to terminal term_1: no recognized agent detected.",
      );
    return reply({ task: { id: "task_7", status: "failed" } });
  };
  const injected = await injectTask("/repo", {
    spec: "work",
    terminal: "term_1",
    runId: "run_1",
    executable: "orca",
    execute,
  });
  assert.equal(injected.injected, false);
  assert.equal(injected.dispatchId, null);
  assert.equal(injected.taskId, "task_7");
  assert.equal(injected.taskClosed, true);
  assert.equal(injected.injectRefusal.kind, "not-started");
  assert.equal(injected.injectRefusal.code, "inject_rejected");
  assert.deepEqual(calls[2].slice(0, 6), [
    "orchestration",
    "task-update",
    "--id",
    "task_7",
    "--status",
    "failed",
  ]);

  // A task the caller brought is the caller's to settle.
  calls.length = 0;
  const existing = await injectTask("/repo", {
    task: "task_5",
    terminal: "term_1",
    executable: "orca",
    execute: async (argv) =>
      argv[2] === "dispatch"
        ? refuse("no_agent_detected", "no agent")
        : reply({}),
  });
  assert.equal(existing.taskCreated, false);
  assert.equal(existing.taskClosed, false);

  // Any other dispatch failure still throws: it does not prove nothing started.
  await assert.rejects(
    injectTask("/repo", {
      task: "task_5",
      terminal: "term_1",
      executable: "orca",
      execute: async () => refuse("runtime_error", "broke mid-dispatch"),
    }),
    /runtime_error/,
  );
});

test("a refusal that started nothing routes to PM, not to process reconciliation", () => {
  // Translated through the general table, inject_rejected read as an unsettled
  // process and went to PL to reconcile, although no Dispatch or process
  // existed and a depth-3 run holds no PL.
  const route = classifyFailure({
    kind: "not-started",
    code: "inject_rejected",
    message: "no recognized agent detected",
  });
  assert.deepEqual(route, {
    category: "start-refused",
    nextOwner: "pm",
    action: "change-launch-path",
    retryable: false,
  });
});
