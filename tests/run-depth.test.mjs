/** PM-only and PM/Worker workflow depth changes. */
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
  attachExecution,
  createWorkflow,
  readWorkflow,
  recordSettlement,
  setWorkflowDepth,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";

const cli = path.resolve("plugins/oh-my-teams/scripts/teams-org.mjs");
const organization = () =>
  readJSON(
    new URL(
      "../plugins/oh-my-teams/examples/organization.json",
      import.meta.url,
    ),
  );

const task = (id) => ({
  schemaVersion: 2,
  revision: 1,
  kind: "edit",
  id,
  goal: "Test run depth",
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

async function workflow(
  t,
  { depth, org = organization(), roles = ["worker"] } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-depth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const args of [
    ["init"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"],
  ]) {
    assert.equal((await run(["git", ...args], { cwd: dir })).code, 0);
  }
  fs.writeFileSync(path.join(dir, ".gitignore"), ".omt/\n");
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  await run(["git", "add", "."], { cwd: dir });
  assert.equal(
    (await run(["git", "commit", "-m", "seed"], { cwd: dir })).code,
    0,
  );
  const ids = roles.map((_, index) => String.fromCharCode(97 + index));
  ids.forEach((id) => {
    fs.writeFileSync(path.join(dir, `${id}.txt`), "unchanged");
    writeJSON(path.join(dir, `${id}.json`), task(id));
  });
  const request = {
    schemaVersion: 1,
    id: "depth-run",
    goal: "Run at a chosen depth",
    repo: ".",
    ...(depth === undefined ? {} : { depth }),
    tasks: ids.map((id, index) => ({ file: `${id}.json`, role: roles[index] })),
    policy: { maxRunning: 2, maxReviewPending: 2 },
    budget: { maxAttempts: 4, maxCalls: 4 },
  };
  const stateDir = path.join(dir, ".omt");
  const state = await createWorkflow(stateDir, request, org, dir);
  return { dir, stateDir, id: request.id, state };
}

const change = (eventId, depth, reason = "scope changed") => ({
  schemaVersion: 1,
  eventId,
  depth,
  reason,
  evidence: "plan.md#scope",
});

function attach(stateDir, id, taskId) {
  const { state } = readWorkflow(stateDir, id);
  return attachExecution(stateDir, id, state.revision, {
    schemaVersion: 1,
    eventId: `attach-${taskId}`,
    attemptId: `attempt-${taskId}`,
    taskId,
    callAllowance: 1,
    receipt: {
      executionId: `exec-${taskId}`,
      runId: `run-${taskId}`,
      taskId: `orca-${taskId}`,
      dispatchId: `dispatch-${taskId}`,
      worktreeId: `wt-${taskId}`,
    },
  });
}

test("depth one folds Worker work to PM; the default uses PM and Worker", async (t) => {
  const solo = await workflow(t, { depth: 1 });
  assert.deepEqual(solo.state.roles, ["pm"]);
  assert.equal(solo.state.tasks.a.role, "pm");
  assert.equal(solo.state.tasks.a.requestedRole, "worker");
  const full = await workflow(t);
  assert.equal(full.state.depth, 2);
  assert.deepEqual(full.state.roles, ["pm", "worker"]);
  assert.equal(full.state.tasks.a.role, "worker");
});

test("a depth cannot add Worker when the organization omits it", async (t) => {
  const org = organization();
  delete org.roles.worker;
  const { state } = await workflow(t, { depth: 2, org });
  assert.deepEqual(state.roles, ["pm"]);
  assert.equal(state.tasks.a.role, "pm");
});

test("raising depth restores pending Worker ownership and replays only once", async (t) => {
  const { stateDir, id, state } = await workflow(t, { depth: 1 });
  const { state: raised } = setWorkflowDepth(
    stateDir,
    id,
    state.revision,
    change("deeper", 2),
  );
  assert.equal(raised.tasks.a.role, "worker");
  assert.equal(raised.tasks.a.requestedRole, undefined);
  assert.deepEqual(
    raised.depthHistory.map(({ from, to }) => [from, to]),
    [[1, 2]],
  );
  const replay = setWorkflowDepth(
    stateDir,
    id,
    raised.revision,
    change("deeper", 2),
  );
  assert.equal(replay.duplicate, true);
  assert.equal(replay.state.depthHistory.length, 1);
});

test("lowering depth waits for a running Worker and moves only pending work", async (t) => {
  const org = organization();
  org.roles.worker.concurrency = 2;
  const { stateDir, id } = await workflow(t, {
    depth: 2,
    org,
    roles: ["worker", "worker"],
  });
  attach(stateDir, id, "a");
  let { state } = readWorkflow(stateDir, id);
  assert.throws(
    () =>
      setWorkflowDepth(stateDir, id, state.revision, change("shallower", 1)),
    /Cannot lower depth while a \(worker\) holds reserved or running work/,
  );
  state = recordSettlement(stateDir, id, state.revision, {
    schemaVersion: 1,
    eventId: "settle-a",
    attemptId: "attempt-a",
    taskId: "a",
    executionId: "exec-a",
    outcome: "settled",
    callsUsed: 1,
  }).state;
  const { state: lowered } = setWorkflowDepth(
    stateDir,
    id,
    state.revision,
    change("shallower", 1),
  );
  assert.equal(lowered.tasks.a.role, "worker");
  assert.equal(lowered.tasks.b.role, "pm");
  assert.equal(lowered.tasks.b.requestedRole, "worker");
});

test("a depth change validates the target, reason, and revision", async (t) => {
  const { stateDir, id, state } = await workflow(t, { depth: 1 });
  assert.throws(
    () => setWorkflowDepth(stateDir, id, state.revision, change("same", 1)),
    /already runs at depth 1/,
  );
  assert.throws(
    () =>
      setWorkflowDepth(stateDir, id, state.revision, {
        ...change("silent", 2),
        reason: "",
      }),
    /reason and evidence/,
  );
  assert.throws(
    () => setWorkflowDepth(stateDir, id, state.revision - 1, change("old", 2)),
    /Workflow changed/,
  );
  assert.throws(
    () => setWorkflowDepth(stateDir, id, state.revision, change("invalid", 3)),
    /Depth must be 1\.\.2/,
  );
});

test("the CLI changes depth from one to two", async (t) => {
  const { dir, stateDir, id, state } = await workflow(t, { depth: 1 });
  const file = path.join(dir, "change.json");
  writeJSON(file, change("cli-deeper", 2));
  const result = await run([
    process.execPath,
    cli,
    "workflow-depth",
    "--id",
    id,
    "--state",
    stateDir,
    "--revision",
    String(state.revision),
    "--change",
    file,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readWorkflow(stateDir, id).state.depth, 2);
});
