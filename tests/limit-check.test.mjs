/** Usage-limit detection from provider records, and how a limit is routed. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readJSON,
  run,
  writeJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  AGY_FINAL_ATTEMPT,
  classifyLimitRecord,
  findProviderSession,
  readScreenLimit,
  workerLimitCheck,
} from "../plugins/oh-my-teams/scripts/limit-check.mjs";
import { classifyFailure } from "../plugins/oh-my-teams/scripts/failures.mjs";
import { assertFailureSignal } from "../plugins/oh-my-teams/scripts/execution.mjs";
import { readHeadlessStream } from "../plugins/oh-my-teams/scripts/headless.mjs";
import {
  attachExecution,
  createWorkflow,
  readWorkflow,
  recordSettlement,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";

const cli = path.resolve("plugins/oh-my-teams/scripts/teams-org.mjs");
const fixture = readJSON(
  new URL("./fixtures/provider-limit-events.json", import.meta.url),
);
const jsonl = (records) =>
  `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

function box(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "limit-check-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const worktree = path.join(root, "wt.pl");
  fs.mkdirSync(worktree);
  const homes = {
    codexHome: path.join(root, "codex"),
    claudeHome: path.join(root, "claude"),
    agyHome: path.join(root, "agy"),
  };
  return { root, worktree, homes };
}

const codexMeta = (cwd) => ({
  type: "session_meta",
  payload: { id: "s", cwd },
});
const codexEvent = (type, extra = {}) => ({
  type: "event_msg",
  payload: { type, ...extra },
});
const fixtureEvent = (provider, kind) =>
  fixture.events.find(
    (entry) =>
      entry.provider === provider && entry.kind === kind && entry.event,
  ).event;

function writeCodex(homes, name, records, mtime) {
  const file = path.join(homes.codexHome, "sessions", "2026", "09", "22", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jsonl(records));
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

function writeAgy(homes, id, records) {
  const file = path.join(
    homes.agyHome,
    "brain",
    id,
    ".system_generated",
    "logs",
    "transcript_full.jsonl",
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jsonl(records));
  return file;
}

test("every recorded limit event is classified as the kind it was filed under", () => {
  for (const entry of fixture.events) {
    const found = entry.event
      ? classifyLimitRecord(entry.provider, entry.event)
      : readScreenLimit(entry.provider, entry.screen.split("\n")).limit;
    assert.equal(found?.kind, entry.kind, JSON.stringify(entry));
  }
  const agy = classifyLimitRecord("agy", fixtureEvent("agy", "usage-limit"));
  assert.equal(agy.resetsIn, "21m56s");
  assert.equal(agy.attempt, 1);
  const codex = classifyLimitRecord(
    "codex",
    fixtureEvent("codex", "usage-limit"),
  );
  assert.equal(codex.resetsAt, "4:54 AM");
});

test("records that are not limits are not classified as limits", () => {
  assert.equal(
    classifyLimitRecord("claude", {
      type: "assistant",
      isApiErrorMessage: true,
      error: "server_error",
    }),
    null,
  );
  assert.equal(
    classifyLimitRecord("codex", codexEvent("task_complete", { error: null })),
    null,
  );
  assert.equal(
    classifyLimitRecord("agy", {
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      content: "RESOURCE_EXHAUSTED (code 429) 문구를 설명합니다",
    }),
    null,
  );
});

test("the screen is read across wrapped lines, but only near the bottom", () => {
  const wrapped = readScreenLimit("codex", [
    "■ You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase",
    "more credits or try again at",
    "Sep 26th, 2026 6:11 AM.",
  ]);
  assert.equal(wrapped.verdict, "handoff");
  assert.equal(wrapped.limit.resetsAt, "Sep 26th, 2026 6:11 AM");
  const old = readScreenLimit("codex", [
    "You've hit your usage limit.",
    ...Array.from({ length: 60 }, (_, index) => `line ${index}`),
  ]);
  assert.equal(old.verdict, "none");
});

test("a Codex worker is found by its worktree and judged by its last turn", async (t) => {
  const { worktree, homes } = box(t);
  const limited = fixtureEvent("codex", "usage-limit");
  writeCodex(homes, "rollout-other.jsonl", [codexMeta("/elsewhere"), limited]);
  const own = writeCodex(
    homes,
    "rollout-own.jsonl",
    [codexMeta(worktree), codexEvent("task_started"), limited],
    new Date(Date.now() - 60_000),
  );
  assert.equal(findProviderSession("codex", { worktree }, homes), own);
  const stopped = await workerLimitCheck({
    provider: "codex",
    worktree,
    homes,
  });
  assert.equal(stopped.source, "session");
  assert.equal(stopped.verdict, "handoff");

  // A new turn after the limit means the worker is running again.
  fs.appendFileSync(own, jsonl([codexEvent("task_started")]));
  const resumed = await workerLimitCheck({
    provider: "codex",
    worktree,
    homes,
  });
  assert.equal(resumed.verdict, "none");

  const overloaded = writeCodex(homes, "rollout-busy.jsonl", [
    codexMeta(worktree),
    fixtureEvent("codex", "capacity"),
  ]);
  assert.equal(findProviderSession("codex", { worktree }, homes), overloaded);
  assert.equal(
    (await workerLimitCheck({ provider: "codex", worktree, homes })).verdict,
    "retry",
  );
});

test("a Claude worker's limit counts only while it is the last message", async (t) => {
  const { worktree, homes } = box(t);
  const dir = path.join(
    homes.claudeHome,
    "projects",
    worktree.replace(/[^A-Za-z0-9]/g, "-"),
  );
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "session.jsonl");
  const limited = fixtureEvent("claude", "usage-limit");
  fs.writeFileSync(file, jsonl([{ type: "user" }, limited]));
  assert.equal(
    (await workerLimitCheck({ provider: "claude", worktree, homes })).verdict,
    "handoff",
  );
  fs.appendFileSync(file, jsonl([{ type: "user" }]));
  assert.equal(
    (await workerLimitCheck({ provider: "claude", worktree, homes })).verdict,
    "none",
  );
});

test("an Agy worker is found by its brief and handed off only after its last retry", async (t) => {
  const { worktree, homes } = box(t);
  const brief = {
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    content:
      "<USER_REQUEST>... handoff-checkpoint --state /s --workflow-id run-1 --workflow-task a --file x",
  };
  const quota = (attempt) => ({
    source: "SYSTEM",
    type: "ERROR_MESSAGE",
    error: fixtureEvent("agy", "usage-limit").error.replace(
      "attempt 1",
      `attempt ${attempt}`,
    ),
  });
  writeAgy(homes, "other", [{ ...brief, content: "different task" }]);
  const file = writeAgy(homes, "mine", [brief, quota(1), quota(3)]);
  const target = {
    provider: "agy",
    worktree,
    workflowId: "run-1",
    workflowTask: "a",
    homes,
  };
  assert.equal(findProviderSession("agy", target, homes), file);
  assert.equal((await workerLimitCheck(target)).verdict, "wait");
  fs.appendFileSync(file, jsonl([quota(AGY_FINAL_ATTEMPT)]));
  const final = await workerLimitCheck(target);
  assert.equal(final.verdict, "handoff");
  assert.equal(final.limit.resetsIn, "21m56s");

  // Without the workflow task the session cannot be tied to the worker, so
  // the screen is the only evidence left.
  const screen = await workerLimitCheck({
    provider: "agy",
    worktree,
    homes,
    readScreen: async () => [
      "API error (attempt 8): RESOURCE_EXHAUSTED (code 429): Individual quota reached.",
    ],
  });
  assert.equal(screen.source, "screen");
  assert.equal(screen.verdict, "handoff");
  const nothing = await workerLimitCheck({ provider: "agy", worktree, homes });
  assert.equal(nothing.verdict, "unknown");
});

test("worker-limit-check runs from the CLI and rejects unknown providers", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "limit-cli-"));
  try {
    const env = { ...process.env, CODEX_HOME: empty };
    const ok = await run(
      [
        process.execPath,
        cli,
        "worker-limit-check",
        "--worktree",
        empty,
        "--provider",
        "codex",
      ],
      { env },
    );
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).verdict, "unknown");
    const bad = await run(
      [
        process.execPath,
        cli,
        "worker-limit-check",
        "--worktree",
        empty,
        "--provider",
        "gpt",
      ],
      { env },
    );
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /Unknown provider: gpt/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("an Agy answer that only mentions a limit is not a limit", () => {
  const stream = (status, response, error) =>
    jsonl([
      { event: "init", conversation_id: "c1", init: { model: "m" } },
      {
        event: "result",
        result: { conversation_id: "c1", status, response, error },
      },
    ]);
  const talk = readHeadlessStream(
    "agy",
    stream(
      "SUCCESS",
      "RESOURCE_EXHAUSTED와 rate limit 처리를 고쳤습니다.\nDONE: abc",
    ),
  );
  assert.equal(talk.rateLimited, false);
  assert.equal(talk.limitKind, null);
  const quota = readHeadlessStream(
    "agy",
    stream("ERROR", "", fixtureEvent("agy", "usage-limit").error),
  );
  assert.equal(quota.rateLimited, true);
  assert.equal(quota.limitKind, "usage-limit");
  const codex = readHeadlessStream(
    "codex",
    jsonl([
      {
        type: "turn.failed",
        error: {
          message:
            "Selected model is at capacity. Please try a different model.",
        },
      },
    ]),
    { lookupModel: false },
  );
  assert.equal(codex.limitKind, "capacity");
});

test("a limit is handed off only under the fallback policy with a fallback left", () => {
  const limit = {
    kind: "rate-limited",
    limitKind: "usage-limit",
    message: "x",
  };
  assert.equal(
    classifyFailure({
      ...limit,
      onExhaustion: "fallback",
      fallbackAvailable: true,
    }).category,
    "capacity-handoff",
  );
  assert.deepEqual(
    classifyFailure({
      ...limit,
      onExhaustion: "fallback",
      fallbackAvailable: true,
    }),
    {
      category: "capacity-handoff",
      nextOwner: "pm",
      action: "handoff-to-fallback",
      retryable: true,
    },
  );
  assert.equal(
    classifyFailure({ ...limit, onExhaustion: "stop", fallbackAvailable: true })
      .category,
    "quota-exhausted",
  );
  assert.equal(
    classifyFailure({
      ...limit,
      onExhaustion: "fallback",
      fallbackAvailable: false,
    }).category,
    "quota-exhausted",
  );
  assert.equal(
    classifyFailure({
      ...limit,
      limitKind: "capacity",
      onExhaustion: "fallback",
      fallbackAvailable: true,
    }).category,
    "provider-capacity",
  );
  // A signal that says nothing about the organization keeps the old route.
  assert.equal(
    classifyFailure({ failureClass: "quota-unknown" }).category,
    "quota-exhausted",
  );
});

test("a failure signal may name a limit kind only as rate-limited", () => {
  const base = { message: "limit", code: "usage_limit_exceeded" };
  assert.ok(
    assertFailureSignal({
      ...base,
      kind: "rate-limited",
      limitKind: "usage-limit",
    }),
  );
  assert.throws(
    () =>
      assertFailureSignal({
        ...base,
        kind: "environment",
        limitKind: "capacity",
      }),
    /invalid limitKind/,
  );
  assert.throws(
    () =>
      assertFailureSignal({
        ...base,
        kind: "rate-limited",
        limitKind: "weekly",
      }),
    /invalid limitKind/,
  );
});

const task = (id) => ({
  schemaVersion: 2,
  revision: 1,
  kind: "edit",
  id,
  goal: "Test limit routing",
  instruction: "Make the change",
  nonGoals: [],
  constraints: [],
  files: [`${id}.txt`],
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

async function settleLimited(t, org) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "limit-route-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const args of [
    ["init"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"],
  ]) {
    assert.equal((await run(["git", ...args], { cwd: dir })).code, 0);
  }
  fs.writeFileSync(path.join(dir, ".gitignore"), ".omt/\n");
  fs.writeFileSync(path.join(dir, "a.txt"), "unchanged");
  writeJSON(path.join(dir, "a.json"), task("a"));
  await run(["git", "add", "."], { cwd: dir });
  await run(["git", "commit", "-m", "seed"], { cwd: dir });
  const stateDir = path.join(dir, ".omt");
  const request = {
    schemaVersion: 1,
    id: "limit-run",
    goal: "Route a limit",
    repo: ".",
    tasks: [{ file: "a.json", role: "pl" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 2, maxCalls: 2 },
  };
  await createWorkflow(stateDir, request, org, dir);
  const { state: created } = readWorkflow(stateDir, request.id);
  attachExecution(stateDir, request.id, created.revision, {
    schemaVersion: 1,
    eventId: "attach-a",
    attemptId: "attempt-a",
    taskId: "a",
    callAllowance: 1,
    receipt: {
      executionId: "exec-a",
      runId: "run-a",
      taskId: "orca-a",
      dispatchId: "dispatch-a",
      worktreeId: "wt-a",
    },
  });
  const { state } = readWorkflow(stateDir, request.id);
  return recordSettlement(stateDir, request.id, state.revision, {
    schemaVersion: 1,
    eventId: "settle-a",
    attemptId: "attempt-a",
    taskId: "a",
    executionId: "exec-a",
    outcome: "failed",
    callsUsed: 1,
    failure: {
      message: "You've hit your usage limit.",
      evidence: "worker-limit-check",
      kind: "rate-limited",
      limitKind: "usage-limit",
    },
  }).state.tasks.a.failure.route;
}

test("a settled limit reads the frozen organization's policy and fallbacks", async (t) => {
  const org = () =>
    readJSON(
      new URL(
        "../plugins/oh-my-teams/examples/organization.json",
        import.meta.url,
      ),
    );
  const withFallback = org();
  withFallback.roles.pl.fallbacks = ["agy-pro"];
  assert.equal(
    (await settleLimited(t, withFallback)).category,
    "capacity-handoff",
  );
  assert.equal((await settleLimited(t, org())).category, "quota-exhausted");
  const stopping = org();
  stopping.roles.pl.fallbacks = ["agy-pro"];
  stopping.policy.onExhaustion = "stop";
  assert.equal((await settleLimited(t, stopping)).category, "quota-exhausted");
});
