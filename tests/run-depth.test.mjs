/** A run's depth: which roles it uses, and how the PM changes that mid-run. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEPTH_ROLES,
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
import { work } from "../plugins/oh-my-teams/scripts/worker.mjs";

const cli = path.resolve("plugins/oh-my-teams/scripts/teams-org.mjs");
const full = () =>
  readJSON(
    new URL(
      "../plugins/oh-my-teams/examples/organization.json",
      import.meta.url,
    ),
  );
const reduced = () =>
  readJSON(
    new URL(
      "../plugins/oh-my-teams/examples/organization.single-subscription.json",
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

async function workflow(t, { depth, org = full(), roles = ["intern"] } = {}) {
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

test("a run uses the roles its depth selects, and every role when none is given", async (t) => {
  const three = await workflow(t, { depth: 3 });
  assert.deepEqual(three.state.roles, [...DEPTH_ROLES[3]]);
  assert.equal(three.state.tasks.a.role, "junior");
  assert.equal(three.state.tasks.a.requestedRole, "intern");

  // A workflow request written before depth existed keeps the whole ladder, so
  // nothing that already runs changes meaning.
  const unset = await workflow(t);
  assert.equal(unset.state.depth, 5);
  assert.deepEqual(unset.state.roles, [...DEPTH_ROLES[5]]);
  assert.equal(unset.state.tasks.a.role, "intern");
});

test("a depth never adds a role the organization does not declare", async (t) => {
  // adjust can remove a role for good, for example a subscription the user
  // does not have. A depth selects within that ladder and cannot restore it.
  const { state } = await workflow(t, { depth: 5, org: reduced() });
  assert.deepEqual(state.roles, ["pm", "junior"]);
});

test("raising the depth folds pending work back onto the role it was written for", async (t) => {
  const { stateDir, id, state } = await workflow(t, { depth: 3 });
  const { state: raised } = setWorkflowDepth(
    stateDir,
    id,
    state.revision,
    change("deeper", 4, "many narrow edits"),
  );
  assert.equal(raised.depth, 4);
  assert.equal(raised.tasks.a.role, "intern");
  assert.equal(raised.tasks.a.requestedRole, undefined);
  assert.deepEqual(
    raised.depthHistory.map(({ from, to, reason }) => [from, to, reason]),
    [[3, 4, "many narrow edits"]],
  );

  // Replaying the same event is a no-op rather than a second change.
  const replay = setWorkflowDepth(
    stateDir,
    id,
    raised.revision,
    change("deeper", 4),
  );
  assert.equal(replay.duplicate, true);
  assert.equal(replay.state.depthHistory.length, 1);
});

test("lowering the depth waits until the removed roles hold no live work", async (t) => {
  const { stateDir, id } = await workflow(t, {
    depth: 4,
    roles: ["intern", "intern"],
  });
  attach(stateDir, id, "a");

  // The intern attempt may still be running, including a worker whose exit
  // was never confirmed; removing its role would strand that work.
  let { state } = readWorkflow(stateDir, id);
  assert.throws(
    () =>
      setWorkflowDepth(stateDir, id, state.revision, change("shallower", 3)),
    /Cannot lower depth while a \(intern\) holds reserved or running work/,
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
    change("shallower", 3, "remaining edit is local"),
  );
  // Only pending work moves. The settled task keeps the role that ran it.
  assert.equal(lowered.tasks.a.role, "intern");
  assert.equal(lowered.tasks.b.role, "junior");
  assert.equal(lowered.tasks.b.requestedRole, "intern");
});

test("a depth change needs a new depth, a reason, and the current revision", async (t) => {
  const { stateDir, id, state } = await workflow(t, { depth: 3 });
  assert.throws(
    () => setWorkflowDepth(stateDir, id, state.revision, change("same", 3)),
    /already runs at depth 3/,
  );
  assert.throws(
    () =>
      setWorkflowDepth(stateDir, id, state.revision, {
        ...change("silent", 4),
        reason: "",
      }),
    /reason and evidence/,
  );
  assert.throws(
    () => setWorkflowDepth(stateDir, id, state.revision - 1, change("old", 4)),
    /Workflow changed/,
  );
  assert.throws(
    () => setWorkflowDepth(stateDir, id, state.revision, change("deep", 6)),
    /Depth must be 1\.\.5/,
  );
});

test("failure routing folds onto the run's roles, not the organization's", async (t) => {
  const { stateDir, id } = await workflow(t, { depth: 2 });
  attach(stateDir, id, "a");
  const { state } = readWorkflow(stateDir, id);
  const settled = recordSettlement(stateDir, id, state.revision, {
    schemaVersion: 1,
    eventId: "settle-a",
    attemptId: "attempt-a",
    taskId: "a",
    executionId: "exec-a",
    outcome: "failed",
    callsUsed: 1,
    failure: {
      // A scope failure belongs to PL, whom the organization declares but a
      // depth-2 run does not use; routing it there would reach nobody.
      kind: "scope",
      message: "scope too large for one task",
      evidence: "runs/run-a/report.json",
    },
  });
  const { route } = settled.state.tasks.a.failure;
  assert.equal(route.nextOwner, "pm");
  assert.equal(route.routedOwner, "pl");
});

test("work bound to a workflow runs as the role the run's depth gives it", async (t) => {
  const org = full();
  const { dir, stateDir, id } = await workflow(t, { depth: 3, org });
  attach(stateDir, id, "a");
  const frozen = readWorkflow(stateDir, id).tasks.a;

  // The organization declares Intern, so folding onto the organization would
  // run the Intern profile the PM took out of this run.
  const report = await work(dir, structuredClone(org), frozen, {
    role: "intern",
    stateDir,
    workflowId: id,
    attemptId: "attempt-a",
    call: async () => ({
      code: 0,
      stdout: "{}",
      stderr: "",
      text: '{"edits":[]}',
      elapsedMs: 1,
    }),
  });
  assert.equal(report.role, "junior");
});

test("the CLI changes depth from a change file", async (t) => {
  const { dir, stateDir, id, state } = await workflow(t, { depth: 2 });
  const file = path.join(dir, "change.json");
  writeJSON(file, change("cli-deeper", 3, "needs independent review"));
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
  assert.equal(readWorkflow(stateDir, id).state.depth, 3);
});
