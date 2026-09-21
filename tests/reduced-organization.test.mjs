/** Tests for organizations that run a reduced ladder on a single subscription. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chart,
  definedRoles,
  foldRole,
  readJSON,
  resolveRole,
  run,
  validateOrg,
  writeJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import { previewPreset } from "../plugins/oh-my-teams/scripts/presets.mjs";
import { validateReviewInput } from "../plugins/oh-my-teams/scripts/gates.mjs";
import {
  createWorkflow,
  readWorkflow,
  attachExecution,
  recordSettlement,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";

const reduced = () =>
  readJSON(
    new URL(
      "../plugins/oh-my-teams/examples/organization.single-subscription.json",
      import.meta.url,
    ),
  );

const full = () =>
  readJSON(
    new URL(
      "../plugins/oh-my-teams/examples/organization.json",
      import.meta.url,
    ),
  );

test("an organization may omit every role except PM", () => {
  const org = reduced();
  assert.deepEqual(definedRoles(org), ["pm", "junior"]);
  assert.equal(validateOrg(org), org);

  const solo = structuredClone(org);
  delete solo.roles.junior;
  delete solo.assistants.junior;
  assert.equal(definedRoles(validateOrg(solo)).length, 1);

  const headless = structuredClone(org);
  delete headless.roles.pm;
  assert.throws(() => validateOrg(headless), /PM is required/);
});

test("a role may not hang off a parent the organization never declared", () => {
  const org = reduced();
  org.roles.junior.parent = "pl";
  assert.throws(() => validateOrg(org), /Invalid parent: junior/);
});

test("role names stay fixed so routing and skills keep addressing them", () => {
  const org = reduced();
  org.roles.reviewer = { ...org.roles.junior };
  assert.throws(() => validateOrg(org), /Roles must be named from/);
});

test("work addressed to an absent role folds onto the closest declared one", () => {
  const org = reduced();
  assert.deepEqual(
    ["pm", "pl", "senior", "junior"].map((role) => resolveRole(org, role)),
    ["pm", "pm", "pm", "junior"],
  );
  // A full ladder resolves every role to itself, so folding is inert there.
  assert.deepEqual(
    ["pm", "pl", "senior", "junior"].map((role) => resolveRole(full(), role)),
    ["pm", "pl", "senior", "junior"],
  );
  assert.throws(() => resolveRole(org, "cto"), /Unknown role: cto/);
  assert.throws(() => foldRole(["junior"], "pm"), /No declared role/);
});

test("the chart renders only the roles a reduced organization declares", () => {
  const rendered = chart(reduced());
  assert.match(rendered, /^PM: agy-opus/m);
  assert.match(rendered, /^ {2}JUNIOR: agy-sonnet/m);
  for (const absent of ["PL:", "SENIOR:", "INTERN:"]) {
    assert.equal(rendered.includes(absent), false);
  }
});

test("a reviewer at or above the required rank satisfies the requirement", () => {
  const task = reviewedTask();
  const review = (role) => ({
    schemaVersion: 1,
    id: "review-1",
    requirementId: "review-senior",
    taskHash: "unused",
    evidenceKey: "unused",
    reviewer: { kind: "agent-review", role, executionId: "reviewer-exec" },
    implementationExecutionId: "implementation-exec",
    conclusion: "approved",
    criteria: [{ id: "semantic", conclusion: "approved", evidence: "read" }],
    findings: [],
  });
  // PM takes the review over when the organization declares no senior.
  for (const role of ["pm", "pl", "senior"]) {
    assert.equal(validateReviewInput(review(role), task).id, "review-1");
  }
  assert.throws(() => validateReviewInput(review("junior"), task), /Reviewer/);
});

test("the single-subscription preset serializes roles and drops shared-quota fallbacks", () => {
  const org = full();
  org.roles.junior.concurrency = 4;
  org.roles.junior.fallbacks = ["agy-sonnet", "claude-current"];
  const { changes, organization } = previewPreset(org, "single-subscription");
  const junior = changes.find((change) => change.role === "junior");
  assert.deepEqual(junior.after, {
    profile: "agy-opus",
    // agy-sonnet shares the agy-shared pool with agy-opus and is already gone
    // when the primary reports exhaustion; claude-current has its own account.
    fallbacks: ["claude-current"],
    concurrency: 1,
  });
  assert.equal(organization.modelPolicy.preset, "single-subscription");
  assert.equal(validateOrg(organization), organization);
});

test("a models preset only re-routes the implementation roles that exist", () => {
  const org = reduced();
  org.profiles["agy-opus"].model = "claude-opus-4-6-thinking";
  const { changes } = previewPreset(org, "opus-first");
  assert.deepEqual(
    changes.map((change) => change.role),
    ["junior"],
  );
});

test("a workflow folds task assignment and failure routing onto declared roles", async (t) => {
  const dir = await repo(t);
  const stateDir = path.join(dir, ".omt");
  writeJSON(path.join(dir, "a.json"), task("a"));
  const request = {
    schemaVersion: 1,
    id: "reduced-fold",
    goal: "Run a four-role plan on a two-role team",
    repo: ".",
    tasks: [{ file: "a.json", role: "senior" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 2, maxCalls: 2 },
  };
  const state = await createWorkflow(stateDir, request, reduced(), dir);
  assert.deepEqual(state.roles, ["pm", "junior"]);
  assert.equal(state.tasks.a.role, "pm");
  assert.equal(state.tasks.a.requestedRole, "senior");

  attachExecution(stateDir, request.id, state.revision, {
    schemaVersion: 1,
    eventId: "attach-a",
    attemptId: "attempt-a",
    taskId: "a",
    callAllowance: 1,
    receipt: {
      executionId: "exec-a",
      runId: "run-a",
      taskId: "a",
      dispatchId: "dispatch-a",
      worktreeId: "tree-a",
    },
  });
  const attached = readWorkflow(stateDir, request.id);
  const settled = recordSettlement(
    stateDir,
    request.id,
    attached.state.revision,
    {
      schemaVersion: 1,
      eventId: "settle-a",
      attemptId: "attempt-a",
      taskId: "a",
      executionId: "exec-a",
      outcome: "failed",
      callsUsed: 1,
      failure: {
        // classifyFailure routes a review rejection to junior, which this
        // organization declares, and a scope failure to PL, which it does not.
        kind: "scope",
        message: "scope too large for one task",
        evidence: "runs/run-a/report.json",
      },
    },
  );
  const { route } = settled.state.tasks.a.failure;
  assert.equal(route.nextOwner, "pm");
  assert.equal(route.routedOwner, "pl");
});

const reviewedTask = () => ({
  ...task("reviewed"),
  acceptance: [
    { id: "check", description: "check", method: "check", checkIndexes: [0] },
    { id: "semantic", description: "reads correctly", method: "review" },
  ],
  reviewRequirements: [
    {
      id: "review-senior",
      kind: "agent-review",
      role: "senior",
      criteria: ["semantic"],
    },
  ],
});

const task = (id, files = [`${id}.txt`]) => ({
  schemaVersion: 2,
  revision: 1,
  kind: "edit",
  id,
  goal: "Test a reduced organization",
  instruction: "Make the change",
  nonGoals: [],
  constraints: [],
  files,
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

async function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reduced-org-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const args of [
    ["init"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"],
  ]) {
    assert.equal((await run(["git", ...args], { cwd: dir })).code, 0);
  }
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  assert.equal((await run(["git", "add", "seed.txt"], { cwd: dir })).code, 0);
  assert.equal(
    (await run(["git", "commit", "-m", "seed"], { cwd: dir })).code,
    0,
  );
  return dir;
}
