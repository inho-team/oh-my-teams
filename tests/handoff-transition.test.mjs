/** Workflow handoff: a usage-limited task moves to a fallback in the same worktree. */
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
import { taskHash } from "../plugins/oh-my-teams/scripts/contracts.mjs";
import { verify } from "../plugins/oh-my-teams/scripts/evidence.mjs";
import {
  attachExecution,
  createWorkflow,
  handoffTask,
  readWorkflow,
  recordSettlement,
  releaseReservation,
  reserveExecution,
  resumeWorkflow,
  retryTask,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";
import { recordCheckpoint } from "../plugins/oh-my-teams/scripts/handoff.mjs";
import { profilesShareLimit } from "../plugins/oh-my-teams/scripts/handoff-snapshot.mjs";
import {
  resolveRoleLaunch,
  roleCommand,
  roleSpec,
} from "../plugins/oh-my-teams/scripts/role-launch.mjs";
import { recordLaunch } from "../plugins/oh-my-teams/scripts/usage-ledger.mjs";

const cli = path.resolve("plugins/oh-my-teams/scripts/teams-org.mjs");

function org(fallbacks = ["agy-pro"], onExhaustion = "fallback") {
  const value = readJSON(
    new URL(
      "../plugins/oh-my-teams/examples/organization.json",
      import.meta.url,
    ),
  );
  value.roles.pl.fallbacks = fallbacks;
  value.policy.onExhaustion = onExhaustion;
  return value;
}

// The check passes only when both halves exist, so the task is finished only
// when the fallback completes what the stopped profile started.
const task = (id) => ({
  schemaVersion: 2,
  revision: 1,
  kind: "edit",
  id,
  goal: "Write both halves",
  instruction: "Create first.txt and second.txt",
  nonGoals: [],
  constraints: [],
  files: ["first.txt", "second.txt"],
  checks: [
    [
      process.execPath,
      "-e",
      "const f=require('fs');if(!f.existsSync('first.txt')||!f.existsSync('second.txt'))process.exit(1)",
    ],
  ],
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

async function git(dir, ...args) {
  const result = await run(["git", ...args], { cwd: dir });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function workflow(t, organization = org(), maxAttempts = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-flow-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await git(dir, "init");
  await git(dir, "config", "user.name", "Test");
  await git(dir, "config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".omt/\n");
  writeJSON(path.join(dir, "a.json"), task("a"));
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "seed");
  const request = {
    schemaVersion: 1,
    id: "handoff-flow",
    goal: "Finish across a limit",
    repo: ".",
    tasks: [{ file: "a.json", role: "pl" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts, maxCalls: 4 },
  };
  const stateDir = path.join(dir, ".omt");
  await createWorkflow(stateDir, request, organization, dir);
  return { dir, stateDir, id: request.id };
}

const current = ({ stateDir, id }) => readWorkflow(stateDir, id).state;

function attach(ctx, n) {
  return attachExecution(ctx.stateDir, ctx.id, current(ctx).revision, {
    schemaVersion: 1,
    eventId: `attach-${n}`,
    attemptId: `attempt-${n}`,
    taskId: "a",
    callAllowance: 1,
    receipt: {
      executionId: `exec-${n}`,
      runId: `run-${n}`,
      taskId: `orca-${n}`,
      dispatchId: `dispatch-${n}`,
      worktreeId: `repo::${ctx.dir}`,
    },
  });
}

function settle(ctx, n, failure) {
  return recordSettlement(ctx.stateDir, ctx.id, current(ctx).revision, {
    schemaVersion: 1,
    eventId: `settle-${n}`,
    attemptId: `attempt-${n}`,
    taskId: "a",
    executionId: `exec-${n}`,
    outcome: failure ? "failed" : "settled",
    callsUsed: 1,
    ...(failure ? { failure } : {}),
  });
}

const limit = {
  message: "You've hit your usage limit.",
  evidence: "worker-limit-check verdict handoff",
  kind: "rate-limited",
  limitKind: "usage-limit",
};

const reason = {
  provider: "codex",
  source: "session",
  verdict: "handoff",
  limit: { kind: "usage-limit", resetsAt: "Sep 26th, 2026 6:11 AM" },
};

function handoff(ctx, profile, eventId = `handoff-${profile}`) {
  return handoffTask(ctx.stateDir, ctx.id, current(ctx).revision, {
    schemaVersion: 1,
    eventId,
    taskId: "a",
    profile,
    worktree: ctx.dir,
    reason,
    evidence: "codex rollout ended with usage_limit_exceeded",
  });
}

const checkpointText = [
  "목표",
  "끝낸 일",
  "남은 일",
  "결정과 이유",
  "검증 상태",
  "다음 단계",
  "주의 사항",
]
  .map((name) => `## ${name}\n${name} 내용\n`)
  .join("\n");

test("a fallback finishes a usage-limited task in the same worktree and passes the gate", async (t) => {
  const ctx = await workflow(t);
  attach(ctx, 1);
  fs.writeFileSync(path.join(ctx.dir, "first.txt"), "codex");
  await git(ctx.dir, "add", "first.txt");
  await git(ctx.dir, "commit", "-m", "first half");
  recordCheckpoint(ctx.stateDir, ctx.id, "a", {
    text: checkpointText,
    repo: ctx.dir,
  });
  fs.writeFileSync(path.join(ctx.dir, "draft.txt"), "uncommitted");
  settle(ctx, 1, limit);
  assert.equal(current(ctx).tasks.a.failure.route.category, "capacity-handoff");
  assert.equal(current(ctx).budget.attemptsUsed, 1);

  const { state } = handoff(ctx, "agy-pro");
  const item = state.tasks.a;
  assert.equal(item.state, "pending");
  assert.equal(item.handoffPending, true);
  assert.equal(item.failure, null);
  assert.equal(item.handoffs.length, 1);
  const record = item.handoffs[0];
  assert.equal(record.from, "codex-current");
  assert.equal(record.to, "agy-pro");
  assert.equal(record.fromAttempt, "attempt-1");
  const snapshot = readJSON(record.snapshot);
  assert.equal(
    record.snapshot,
    path.join(
      ctx.stateDir,
      "workflows",
      ctx.id,
      "tasks",
      "a",
      "handoff",
      "snapshot-1.json",
    ),
  );
  assert.equal(snapshot.head, await git(ctx.dir, "rev-parse", "HEAD"));
  assert.equal(snapshot.commits.length, 1);
  assert.match(snapshot.commits[0], / first half$/);
  assert.deepEqual(snapshot.uncommitted, ["?? draft.txt"]);
  assert.equal(snapshot.checkpoint.commitsSince, 0);
  assert.equal(snapshot.reason.verdict, "handoff");

  // The attempt budget is spent, yet the handoff still dispatches.
  const resumed = resumeWorkflow(ctx.stateDir, ctx.id, state.revision);
  const dispatch = resumed.actions.find((a) => a.type === "dispatch-ready");
  assert.equal(dispatch.profile, "agy-pro");
  assert.equal(dispatch.handoffIndex, 1);

  attach(ctx, 2);
  let after = current(ctx);
  assert.equal(after.budget.attemptsUsed, 1);
  assert.equal(after.tasks.a.handoffPending, false);
  const second = after.tasks.a.attempts.at(-1);
  assert.equal(second.profile, "agy-pro");
  assert.equal(second.handoffIndex, 1);

  fs.rmSync(path.join(ctx.dir, "draft.txt"));
  fs.writeFileSync(path.join(ctx.dir, "second.txt"), "agy");
  await git(ctx.dir, "add", "second.txt");
  await git(ctx.dir, "commit", "-m", "second half");
  settle(ctx, 2);
  const { tasks } = readWorkflow(ctx.stateDir, ctx.id);
  const evidence = await verify(ctx.dir, {
    baseRef: tasks.a.baseRef,
    commands: tasks.a.checks,
    environment: tasks.a.environment,
    store: path.join(ctx.stateDir, "evidence"),
  });
  assert.equal(evidence.status, "passed");
  writeJSON(path.join(ctx.stateDir, "gates", "a.json"), {
    runId: "exec-2",
    state: "accepted",
    gates: {
      "contract-ready": { taskHash: taskHash(tasks.a) },
      "outcome-accepted": { decisionId: "accept-a" },
    },
  });
  resumeWorkflow(ctx.stateDir, ctx.id, current(ctx).revision);
  after = current(ctx);
  assert.equal(after.tasks.a.state, "accepted");
  assert.equal(after.status, "accepted");
  assert.ok(after.eventIds.includes("handoff-agy-pro"));
});

test("a handoff refuses profiles that are not unused fallbacks on another limit", async (t) => {
  const ctx = await workflow(t, org(["codex-luna", "agy-pro", "agy-flash"]), 3);
  attach(ctx, 1);
  settle(ctx, 1, limit);
  assert.throws(() => handoff(ctx, "claude-current"), /not a fallback of pl/);
  assert.throws(
    () => handoff(ctx, "codex-luna"),
    /shares the exhausted limit of codex-current/,
  );
  assert.throws(
    () =>
      handoffTask(ctx.stateDir, ctx.id, current(ctx).revision, {
        schemaVersion: 1,
        eventId: "handoff-wait",
        taskId: "a",
        profile: "agy-pro",
        worktree: ctx.dir,
        reason: { ...reason, verdict: "wait" },
        evidence: "still retrying",
      }),
    /does not call for a handoff/,
  );
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-other-"));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  assert.throws(
    () =>
      handoffTask(ctx.stateDir, ctx.id, current(ctx).revision, {
        schemaVersion: 1,
        eventId: "handoff-elsewhere",
        taskId: "a",
        profile: "agy-pro",
        worktree: other,
        reason,
        evidence: "wrong checkout",
      }),
    /differs from the stopped attempt's worktree/,
  );
  handoff(ctx, "agy-pro");
  assert.equal(handoff(ctx, "agy-pro").duplicate, true);
  attach(ctx, 2);
  settle(ctx, 2, { ...limit, message: "RESOURCE_EXHAUSTED (code 429)" });
  // agy-flash is declared, but it draws on the pool agy-pro just exhausted.
  assert.throws(
    () => handoff(ctx, "agy-flash"),
    /shares the exhausted limit of agy-pro/,
  );
  assert.throws(() => handoff(ctx, "agy-pro", "again"), /already ran/);
});

test("a later handoff cannot return to a limit an earlier profile exhausted", async (t) => {
  const ctx = await workflow(
    t,
    org(["agy-pro", "codex-luna", "claude-current"]),
    3,
  );
  attach(ctx, 1);
  settle(ctx, 1, limit);
  handoff(ctx, "agy-pro");
  attach(ctx, 2);
  settle(ctx, 2, limit);
  assert.throws(
    () => handoff(ctx, "codex-luna"),
    /shares the exhausted limit of codex-current/,
  );
  const { state } = handoff(ctx, "claude-current");
  assert.deepEqual(
    state.tasks.a.handoffs.map((h) => [h.from, h.to]),
    [
      ["codex-current", "agy-pro"],
      ["agy-pro", "claude-current"],
    ],
  );
});

test("the handoff count is capped by the declared fallbacks", async (t) => {
  const ctx = await workflow(t, org(["agy-pro"]), 3);
  attach(ctx, 1);
  settle(ctx, 1, limit);
  handoff(ctx, "agy-pro");
  attach(ctx, 2);
  settle(ctx, 2, limit);
  const item = current(ctx).tasks.a;
  // No fallback is left, so the limit routes to the ordinary quota stop.
  assert.equal(item.failure.route.category, "quota-exhausted");
  assert.throws(
    () => handoff(ctx, "agy-pro", "none-left"),
    /no usage-limit failure to hand off/,
  );
});

test("a stop policy leaves no handoff to take", async (t) => {
  const ctx = await workflow(t, org(["agy-pro"], "stop"));
  attach(ctx, 1);
  settle(ctx, 1, limit);
  assert.notEqual(
    current(ctx).tasks.a.failure.route.category,
    "capacity-handoff",
  );
  assert.throws(() => handoff(ctx, "agy-pro"), /no usage-limit failure/);
});

test("a released handoff launch waits for the same fallback without spending an attempt", async (t) => {
  const ctx = await workflow(t, org(["agy-pro"]), 2);
  attach(ctx, 1);
  settle(ctx, 1, limit);
  handoff(ctx, "agy-pro");
  reserveExecution(ctx.stateDir, ctx.id, current(ctx).revision, {
    schemaVersion: 1,
    eventId: "reserve-2",
    attemptId: "attempt-2",
    taskId: "a",
    callAllowance: 1,
  });
  assert.equal(current(ctx).tasks.a.handoffPending, false);
  releaseReservation(ctx.stateDir, ctx.id, current(ctx).revision, {
    schemaVersion: 1,
    eventId: "release-2",
    taskId: "a",
    attemptId: "attempt-2",
    resolution: "terminal never opened",
    evidence: "role-terminal failed",
    refusal: {
      kind: "not-started",
      code: "terminal-open-failed",
      message: "refused before start",
    },
  });
  const after = current(ctx);
  assert.equal(after.budget.attemptsUsed, 1);
  assert.equal(after.tasks.a.handoffPending, true);
});

test("a retry after a handoff keeps the fallback profile", async (t) => {
  const ctx = await workflow(t, org(["agy-pro"]), 3);
  attach(ctx, 1);
  settle(ctx, 1, limit);
  handoff(ctx, "agy-pro");
  attach(ctx, 2);
  settle(ctx, 2, {
    message: "check failed",
    evidence: "verify exit 1",
    kind: "check-failed",
  });
  const failed = current(ctx).tasks.a;
  retryTask(ctx.stateDir, ctx.id, current(ctx).revision, {
    schemaVersion: 1,
    eventId: "retry-3",
    taskId: "a",
    resolvedBy: failed.failure.route.nextOwner,
    resolution: "fix",
    evidence: "fixed",
  });
  const dispatch = resumeWorkflow(
    ctx.stateDir,
    ctx.id,
    current(ctx).revision,
  ).actions.find((a) => a.type === "dispatch-ready");
  assert.equal(dispatch.profile, "agy-pro");
  assert.equal(dispatch.handoffIndex, undefined);
  attach(ctx, 3);
  assert.equal(current(ctx).budget.attemptsUsed, 2);
  assert.equal(current(ctx).tasks.a.attempts.at(-1).profile, "agy-pro");
});

test("profilesShareLimit compares accounts per provider and declared pools", () => {
  const { profiles } = org();
  assert.equal(
    profilesShareLimit(profiles["codex-current"], profiles["codex-luna"]),
    true,
  );
  assert.equal(
    profilesShareLimit(profiles["agy-pro"], profiles["agy-flash"]),
    true,
  );
  assert.equal(
    profilesShareLimit(profiles["codex-current"], profiles["agy-pro"]),
    false,
  );
  assert.equal(
    profilesShareLimit(profiles["claude-current"], profiles["agy-pro"]),
    false,
  );
});

test("launches take a handoff profile only when it is a fallback of the role", () => {
  const organization = org(["agy-pro"]);
  const command = roleCommand(organization, "pl", { profile: "agy-pro" });
  assert.equal(command.profile, "agy-pro");
  assert.equal(command.provider, "agy");
  assert.throws(
    () => roleCommand(organization, "pl", { profile: "agy-flash" }),
    /not a fallback of pl/,
  );
  const launch = resolveRoleLaunch(
    organization,
    "pl",
    {},
    { terminal: "term-1", profile: "agy-pro" },
  );
  assert.equal(launch.profile, "agy-pro");
  assert.equal(roleCommand(organization, "pl").profile, "codex-current");
});

test("briefs carry the handoff history and, while pending, what to read first", async (t) => {
  const ctx = await workflow(t);
  attach(ctx, 1);
  settle(ctx, 1, limit);
  const { state } = handoff(ctx, "agy-pro");
  const run = {
    workflowId: ctx.id,
    stateDir: ctx.stateDir,
    workflowTask: "a",
    workflowState: state,
  };
  const pending = roleSpec(org(), "pl", "이어서 한다", run);
  assert.match(pending, /handoff 이력: 1\. codex-current → agy-pro/);
  assert.match(pending, /codex-current 프로필이 사용 한도로 멈춘 뒤/);
  assert.match(
    pending,
    /checkpoint 파일\(.*checkpoint\.md\)과 snapshot 파일\(.*snapshot-1\.json\)을 읽고/,
  );
  assert.match(pending, /먼저 worktree/);
  attach(ctx, 2);
  const running = roleSpec(org(), "pl", "이어서 한다", {
    ...run,
    workflowState: current(ctx),
  });
  assert.match(running, /먼저 worktree/);
  settle(ctx, 2);
  const review = roleSpec(org(), "pl", "검토한다", {
    ...run,
    workflowState: current(ctx),
  });
  assert.match(review, /handoff 이력/);
  assert.doesNotMatch(review, /먼저 worktree/);
  const plain = roleSpec(org(), "pl", "일한다", { ...run, workflowTask: "b" });
  assert.doesNotMatch(plain, /handoff 이력/);
});

test("the ledger names the profile a handoff launch replaced", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-ledger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const orgFile = path.join(dir, ".omt", "organization.json");
  writeJSON(orgFile, org());
  const { line } = recordLaunch(orgFile, {
    via: "role-terminal",
    role: "pl",
    profile: "agy-pro",
    provider: "agy",
    handoffFrom: "codex-current",
    handoffIndex: 1,
  });
  assert.equal(line.handoffFrom, "codex-current");
  assert.equal(line.handoffIndex, 1);
  const plain = recordLaunch(orgFile, { via: "role-terminal", role: "pl" });
  assert.equal("handoffFrom" in plain.line, false);
});

test("workflow-handoff and role-command --profile go through the CLI", async (t) => {
  const ctx = await workflow(t);
  attach(ctx, 1);
  settle(ctx, 1, limit);
  const file = path.join(ctx.stateDir, "handoff.json");
  writeJSON(file, {
    schemaVersion: 1,
    eventId: "handoff-cli",
    taskId: "a",
    profile: "agy-pro",
    worktree: ctx.dir,
    reason,
    evidence: "cli",
  });
  const result = await run([
    process.execPath,
    cli,
    "workflow-handoff",
    "--id",
    ctx.id,
    "--state",
    ctx.stateDir,
    "--revision",
    String(current(ctx).revision),
    "--handoff",
    file,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    JSON.parse(result.stdout).state.tasks.a.handoffs[0].to,
    "agy-pro",
  );
  const orgFile = path.join(ctx.stateDir, "organization.json");
  writeJSON(orgFile, org());
  const spec = await run([
    process.execPath,
    cli,
    "role-terminal",
    "--org",
    orgFile,
    "--role",
    "pl",
    "--worktree",
    "current",
    "--profile",
    "agy-pro",
  ]);
  assert.notEqual(spec.code, 0);
  assert.match(spec.stderr, /--profile requires --workflow-id/);
  const unrecorded = await run([
    process.execPath,
    cli,
    "worker-start",
    "--org",
    orgFile,
    "--role",
    "pl",
    "--repo",
    ctx.dir,
    "--spec",
    "이어서 한다",
    "--terminal",
    "term-1",
    "--workflow-id",
    ctx.id,
    "--state",
    ctx.stateDir,
    "--workflow-task",
    "a",
    "--profile",
    "codex-luna",
  ]);
  assert.notEqual(unrecorded.code, 0);
  assert.match(unrecorded.stderr, /has no handoff to codex-luna/);
});

test("headless-start --profile runs only the recorded fallback and names the profile it replaced", async (t) => {
  const ctx = await workflow(t);
  attach(ctx, 1);
  settle(ctx, 1, limit);
  handoff(ctx, "agy-pro");
  // Every profile names an executable that does not exist, so the start can
  // never run a real, billed provider CLI.
  const organization = org();
  for (const profile of Object.values(organization.profiles))
    profile.command = ["omt-no-such-cli"];
  const orgFile = path.join(ctx.stateDir, "organization.json");
  writeJSON(orgFile, organization);
  const start = (extra) =>
    run([
      process.execPath,
      cli,
      "headless-start",
      "--org",
      orgFile,
      "--role",
      "pl",
      "--cwd",
      ctx.dir,
      "--spec",
      "남은 일을 끝낸다",
      "--state",
      ctx.stateDir,
      "--worker",
      "pl-handoff",
      ...extra,
    ]);
  const bare = await start(["--profile", "agy-pro"]);
  assert.notEqual(bare.code, 0);
  assert.match(bare.stderr, /--profile requires --workflow-id/);
  const workflowArgs = ["--workflow-id", ctx.id, "--workflow-task", "a"];
  const unrecorded = await start([...workflowArgs, "--profile", "codex-luna"]);
  assert.notEqual(unrecorded.code, 0);
  assert.match(unrecorded.stderr, /has no handoff to codex-luna/);
  const started = await start([...workflowArgs, "--profile", "agy-pro"]);
  assert.equal(started.code, 0, started.stderr);
  t.after(() =>
    run([
      process.execPath,
      cli,
      "headless-stop",
      "--state",
      ctx.stateDir,
      "--worker",
      "pl-handoff",
    ]),
  );
  const { ledger } = JSON.parse(started.stdout);
  const line = JSON.parse(
    fs.readFileSync(ledger, "utf8").trim().split("\n").at(-1),
  );
  assert.equal(line.via, "headless-start");
  assert.equal(line.profile, "agy-pro");
  assert.equal(line.handoffFrom, "codex-current");
  assert.equal(line.handoffIndex, 1);
});

test("the skills and runtime reference carry the usage-limit handoff procedure", () => {
  const read = (file) =>
    fs.readFileSync(path.resolve("plugins/oh-my-teams", file), "utf8");
  const runtime = read("references/orca-runtime.md");
  assert.match(runtime, /^## 사용 한도 handoff$/m);
  assert.match(runtime, /node <runtime> worker-limit-check --worktree/);
  assert.match(runtime, /node <runtime> workflow-handoff --id/);
  assert.match(runtime, /--workflow-task <task id> --profile <fallback>/);
  assert.match(
    runtime,
    /node <runtime> headless-start .* --profile <fallback>/,
  );
  assert.doesNotMatch(runtime, /아직 `--profile`이 없/);
  for (const verdict of ["handoff", "retry", "wait", "none", "unknown"])
    assert.match(runtime, new RegExp(`\\| \`${verdict}\` +\\|`));
  const pm = read("skills/pm/SKILL.md");
  assert.match(pm, /`workflow-handoff`/);
  assert.match(pm, /`사용 한도 handoff` 절/);
  assert.match(read("skills/pl/SKILL.md"), /`workflow-handoff`는 PM이 수행/);
  assert.match(read("skills/adjust/SKILL.md"), /^## 대체 프로필$/m);
  assert.match(read("skills/form/SKILL.md"), /`adjust`에서 사용자가 고르게/);
});
