/** Regression coverage for structured automatic Intern delegation. */
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
  retryTask,
  setWorkflowDepth,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";
import { work } from "../plugins/oh-my-teams/scripts/worker.mjs";
import { main } from "../plugins/oh-my-teams/scripts/teams-org.mjs";
import { draftOrganization } from "../plugins/oh-my-teams/scripts/org-draft.mjs";

const organization = () =>
  readJSON(
    new URL(
      "../plugins/oh-my-teams/examples/organization.json",
      import.meta.url,
    ),
  );

function task(id, delegation, risk = "low") {
  return {
    schemaVersion: 2,
    revision: 1,
    kind: "edit",
    id,
    goal: "Verify automatic delegation",
    instruction: "Leave the bounded fixture unchanged.",
    nonGoals: [],
    constraints: [],
    files: [`${id}.txt`],
    checks: [[process.execPath, "-e", "process.exit(0)"]],
    acceptance: [
      {
        id: "check",
        description: "The deterministic check passes.",
        method: "check",
        checkIndexes: [0],
      },
    ],
    dependencies: [],
    contractRefs: [],
    contextRefs: [],
    openQuestions: [],
    reviewRequirements: [],
    environment: "test",
    baseRef: "HEAD",
    risk,
    ...(delegation ? { delegation } : {}),
  };
}

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intern-first-"));
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
  assert.equal((await run(["git", "add", "."], { cwd: dir })).code, 0);
  assert.equal(
    (await run(["git", "commit", "-m", "seed"], { cwd: dir })).code,
    0,
  );
  return dir;
}

async function create(t, tasks, { depth, org = organization() } = {}) {
  const dir = await fixture(t);
  for (const [id, contract] of Object.entries(tasks)) {
    fs.writeFileSync(path.join(dir, `${id}.txt`), "unchanged\n");
    writeJSON(path.join(dir, `${id}.json`), contract);
  }
  const request = {
    schemaVersion: 1,
    id: "intern-first",
    goal: "Select task roles from structured metadata.",
    repo: ".",
    ...(depth === undefined ? {} : { depth }),
    tasks: Object.keys(tasks).map((id) => ({ file: `${id}.json` })),
    policy: { maxRunning: 3, maxReviewPending: 3 },
    budget: { maxAttempts: 3, maxCalls: 3 },
  };
  const stateDir = path.join(dir, ".omt");
  const state = await createWorkflow(stateDir, request, org, dir);
  return { dir, request, state, stateDir };
}

function attach(stateDir, id, taskId, revision = 1) {
  return attachExecution(stateDir, id, revision, {
    schemaVersion: 1,
    eventId: `attach-${taskId}`,
    attemptId: `attempt-${taskId}`,
    taskId,
    callAllowance: 1,
    receipt: {
      executionId: `execution-${taskId}`,
      runId: `run-${taskId}`,
      taskId: `task-${taskId}`,
      dispatchId: `dispatch-${taskId}`,
      worktreeId: `worktree-${taskId}`,
    },
  });
}

const noEdits = async () => ({
  code: 0,
  stdout: "{}",
  stderr: "",
  text: '{"edits":[]}',
  elapsedMs: 1,
});

test("automatic selection sends only bounded low-risk work to Intern", async (t) => {
  const bounded = task("bounded", {
    scope: "closed",
    verification: "deterministic",
    authority: "standard",
    design: "routine",
  });
  const privileged = task("privileged", {
    scope: "closed",
    verification: "deterministic",
    authority: "elevated",
    design: "routine",
  });
  const { state } = await create(t, { bounded, privileged });
  assert.deepEqual(state.tasks.bounded.selection, {
    source: "automatic",
    reason: "low-risk-closed-deterministic",
    requestedRole: "intern",
    selectedRole: "intern",
  });
  assert.equal(state.tasks.privileged.role, "senior");
  assert.equal(state.tasks.privileged.selection.reason, "authority-elevated");
});

test("missing metadata remains with Junior and an explicit role wins", async (t) => {
  const unclassified = task("unclassified");
  const bounded = task("bounded", {
    scope: "closed",
    verification: "deterministic",
    authority: "standard",
    design: "routine",
  });
  const dir = await fixture(t);
  for (const [id, contract] of Object.entries({ unclassified, bounded })) {
    fs.writeFileSync(path.join(dir, `${id}.txt`), "unchanged\n");
    writeJSON(path.join(dir, `${id}.json`), contract);
  }
  const stateDir = path.join(dir, ".omt");
  await createWorkflow(
    stateDir,
    {
      schemaVersion: 1,
      id: "explicit-role",
      goal: "Keep explicit assignments.",
      repo: ".",
      tasks: [
        { file: "unclassified.json" },
        { file: "bounded.json", role: "junior" },
      ],
      policy: { maxRunning: 2, maxReviewPending: 2 },
      budget: { maxAttempts: 2, maxCalls: 2 },
    },
    organization(),
    dir,
  );
  const state = readWorkflow(stateDir, "explicit-role").state;
  assert.equal(state.tasks.unclassified.role, "junior");
  assert.equal(state.tasks.unclassified.selection.reason, "metadata-missing");
  assert.equal(state.tasks.bounded.role, "junior");
  assert.equal(state.tasks.bounded.selection.reason, "role-explicit");
});

test("workflow-backed receipt retains the selected role and reason", async (t) => {
  const bounded = task("bounded", {
    scope: "closed",
    verification: "deterministic",
    authority: "standard",
    design: "routine",
  });
  const { dir, request, stateDir } = await create(t, { bounded });
  attach(stateDir, request.id, "bounded");
  const frozen = readWorkflow(stateDir, request.id).tasks.bounded;
  const report = await work(dir, organization(), frozen, {
    role: "intern",
    stateDir,
    workflowId: request.id,
    attemptId: "attempt-bounded",
    call: noEdits,
  });
  assert.equal(report.role, "intern");
  assert.equal(report.selectionReason, "low-risk-closed-deterministic");
  assert.equal(
    report.calls[0].selectionReason,
    "low-risk-closed-deterministic",
  );
});

test("depth and a missing Intern fold automatic work while preserving its reason", async (t) => {
  const bounded = task("bounded", {
    scope: "closed",
    verification: "deterministic",
    authority: "standard",
    design: "routine",
  });
  const shallow = await create(t, { bounded }, { depth: 3 });
  assert.equal(shallow.state.tasks.bounded.role, "junior");
  assert.equal(
    shallow.state.tasks.bounded.selection.reason,
    "low-risk-closed-deterministic",
  );
  attach(shallow.stateDir, shallow.request.id, "bounded");
  const shallowReport = await work(
    shallow.dir,
    organization(),
    readWorkflow(shallow.stateDir, shallow.request.id).tasks.bounded,
    {
      role: "junior",
      stateDir: shallow.stateDir,
      workflowId: shallow.request.id,
      attemptId: "attempt-bounded",
      call: noEdits,
    },
  );
  assert.equal(shallowReport.role, "junior");
  assert.equal(shallowReport.selectionReason, "low-risk-closed-deterministic");

  const reduced = organization();
  delete reduced.roles.intern;
  delete reduced.assistants.intern;
  const unavailable = await create(t, { bounded }, { org: reduced });
  assert.equal(unavailable.state.tasks.bounded.role, "junior");
  attach(unavailable.stateDir, unavailable.request.id, "bounded");
  const unavailableReport = await work(
    unavailable.dir,
    reduced,
    readWorkflow(unavailable.stateDir, unavailable.request.id).tasks.bounded,
    {
      role: "junior",
      stateDir: unavailable.stateDir,
      workflowId: unavailable.request.id,
      attemptId: "attempt-bounded",
      call: noEdits,
    },
  );
  assert.equal(unavailableReport.role, "junior");
  assert.equal(
    unavailableReport.selectionReason,
    "low-risk-closed-deterministic",
  );
});

test("a legacy selection-free snapshot remains safe through a depth change", async (t) => {
  const bounded = task("bounded", {
    scope: "closed",
    verification: "deterministic",
    authority: "standard",
    design: "routine",
  });
  const { stateDir, request } = await create(t, { bounded });
  const legacy = readWorkflow(stateDir, request.id).state;
  delete legacy.tasks.bounded.selection;
  writeJSON(path.join(stateDir, "workflows", request.id, "state.json"), legacy);
  const changed = setWorkflowDepth(stateDir, request.id, legacy.revision, {
    schemaVersion: 1,
    eventId: "legacy-depth",
    depth: 3,
    reason: "Legacy run needs a smaller team.",
    evidence: "tests/intern-first.test.mjs",
  });
  assert.equal(changed.state.tasks.bounded.role, "junior");
  assert.equal(changed.state.tasks.bounded.selection.reason, "legacy-role");
});

test("a legacy selection-free snapshot retains its role through retry", async (t) => {
  const bounded = task("bounded", {
    scope: "closed",
    verification: "deterministic",
    authority: "standard",
    design: "routine",
  });
  const { stateDir, request } = await create(t, { bounded });
  const legacy = readWorkflow(stateDir, request.id).state;
  const item = legacy.tasks.bounded;
  delete item.selection;
  item.state = "failed";
  item.attemptId = "attempt-old";
  item.failure = {
    route: { category: "scope", nextOwner: "junior", retryable: true },
  };
  writeJSON(path.join(stateDir, "workflows", request.id, "state.json"), legacy);
  const retried = retryTask(stateDir, request.id, legacy.revision, {
    schemaVersion: 1,
    eventId: "legacy-retry",
    taskId: "bounded",
    resolvedBy: "junior",
    resolution: "The scope now has a bounded contract.",
    evidence: "tests/intern-first.test.mjs",
  });
  assert.equal(retried.tasks.bounded.state, "pending");
  assert.equal(retried.tasks.bounded.role, "intern");
  assert.equal(retried.tasks.bounded.selection.reason, "legacy-role");
});

test("work CLI enforces the workflow selection and records an escalation receipt", async (t) => {
  const elevated = task("elevated", {
    scope: "closed",
    verification: "deterministic",
    authority: "elevated",
    design: "routine",
  });
  const org = organization();
  const provider = path.join(await fixture(t), "provider.mjs");
  fs.writeFileSync(
    provider,
    "process.stdout.write(JSON.stringify({ result: '{\"edits\":[]}' }));\n",
  );
  org.roles.senior.profile = "claude-current";
  org.profiles["claude-current"].command = [process.execPath, provider];
  org.profiles["claude-current"].model = null;
  const { dir, request, stateDir } = await create(t, { elevated }, { org });
  const orgFile = path.join(dir, "organization.json");
  writeJSON(orgFile, org);
  attach(stateDir, request.id, "elevated");
  const taskFile = path.join(
    stateDir,
    "workflows",
    request.id,
    "tasks",
    "elevated",
    "revisions",
    "1.json",
  );
  await assert.rejects(
    () =>
      main([
        "work",
        "--org",
        orgFile,
        "--task",
        taskFile,
        "--repo",
        dir,
        "--state",
        stateDir,
        "--workflow-id",
        request.id,
        "--attempt-id",
        "attempt-elevated",
        "--role",
        "intern",
      ]),
    /conflicts with the workflow task's selected role/,
  );
  let output = "";
  const print = console.log;
  console.log = (value) => {
    output = value;
  };
  try {
    await main([
      "work",
      "--org",
      orgFile,
      "--task",
      taskFile,
      "--repo",
      dir,
      "--state",
      stateDir,
      "--workflow-id",
      request.id,
      "--attempt-id",
      "attempt-elevated",
    ]);
  } finally {
    console.log = print;
    process.exitCode = undefined;
  }
  const report = JSON.parse(output);
  assert.equal(report.role, "senior");
  assert.equal(report.selection.reason, "authority-elevated");
  assert.equal(report.calls[0].selectionReason, "authority-elevated");
});

test("an org-draft default selects Intern through the work CLI receipt", async (t) => {
  const bounded = task("bounded", {
    scope: "closed",
    verification: "deterministic",
    authority: "standard",
    design: "routine",
  });
  const org = draftOrganization({
    name: "intern-first-default",
    tiers: 5,
    models: Array.from({ length: 5 }, () => "claude:default"),
  });
  const provider = path.join(await fixture(t), "provider.mjs");
  fs.writeFileSync(
    provider,
    "process.stdout.write(JSON.stringify({ result: '{\"edits\":[]}' }));\n",
  );
  org.profiles["claude-default"].command = [process.execPath, provider];
  const { dir, request, state, stateDir } = await create(
    t,
    { bounded },
    {
      org,
    },
  );
  assert.equal(state.tasks.bounded.role, "intern");
  const orgFile = path.join(dir, "organization.json");
  writeJSON(orgFile, org);
  attach(stateDir, request.id, "bounded");
  const taskFile = path.join(
    stateDir,
    "workflows",
    request.id,
    "tasks",
    "bounded",
    "revisions",
    "1.json",
  );
  let output = "";
  const print = console.log;
  console.log = (value) => {
    output = value;
  };
  try {
    await main([
      "work",
      "--org",
      orgFile,
      "--task",
      taskFile,
      "--repo",
      dir,
      "--state",
      stateDir,
      "--workflow-id",
      request.id,
      "--attempt-id",
      "attempt-bounded",
    ]);
  } finally {
    console.log = print;
    process.exitCode = undefined;
  }
  const report = JSON.parse(output);
  assert.equal(report.role, "intern");
  assert.equal(report.selectionReason, "low-risk-closed-deterministic");
});
