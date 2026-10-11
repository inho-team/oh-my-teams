/** Regression tests for persistent resource-organization model assignment. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, writeJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import { draftResourceOrganization } from "../plugins/oh-my-teams/scripts/org-draft.mjs";
import {
  assertModelAssignmentChoice,
  modelAssignmentCatalogSelections,
} from "../plugins/oh-my-teams/scripts/model-assignment.mjs";
import {
  directorCommand,
  roleCommand,
} from "../plugins/oh-my-teams/scripts/role-launch.mjs";
import {
  createWorkflow,
  readWorkflow,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";

function organization() {
  const org = draftResourceOrganization({
    name: "assigned resource team",
    resources: ["codex"],
  });
  org.modelAssignment = {
    schemaVersion: 1,
    director: { resourceId: "codex-current", model: "gpt-6-astra" },
    pm: { resourceId: "codex-current", model: "gpt-6.1-sol" },
    worker: {
      resourceId: "codex-current",
      models: ["gpt-5.6-terra", "gpt-6-luna"],
    },
  };
  return org;
}

function staffing(choice = "gpt-5.6-terra", effort) {
  return {
    schemaVersion: 1,
    catalog: { revision: "catalog", verifiedAt: "2026-10-11T00:00:00.000Z" },
    director: {
      allowedResources: ["codex-current"],
      complexity: "bounded edit",
      risk: "normal",
      context: "one task",
      reason: "the saved assignment limits all future choices",
      pm: { resourceId: "codex-current", model: "gpt-6.1-sol" },
    },
    tasks: {
      implementation: {
        role: "worker",
        designComplexity: "bounded edit",
        changeScope: "one file",
        reviewIndependence: "separate review",
        reworkCost: "one extra call",
        reason: "PM made a task-specific choice",
        choice: {
          resourceId: "codex-current",
          model: choice,
          ...(effort === undefined ? {} : { effort }),
        },
      },
    },
  };
}

test("the policy accepts only assigned Codex models and leaves effort to provider validation", () => {
  const org = organization();
  assert.doesNotThrow(() =>
    assertModelAssignmentChoice(org, "worker", {
      resourceId: "codex-current",
      model: "gpt-6-luna",
    }),
  );
  assert.throws(
    () =>
      assertModelAssignmentChoice(org, "worker", {
        resourceId: "codex-current",
        model: "gpt-6.1-sol",
      }),
    /does not allow model/,
  );
  assert.throws(
    () =>
      assertModelAssignmentChoice(org, "pm", {
        resourceId: "agy-current",
        model: "gpt-6.1-sol",
      }),
    /must use resource codex-current/,
  );
  assert.doesNotThrow(() =>
    assertModelAssignmentChoice(org, "pm", {
      resourceId: "codex-current",
      model: "gpt-6.1-sol",
      effort: "high",
    }),
  );
  assert.deepEqual(
    modelAssignmentCatalogSelections(org).map((entry) => entry.model),
    ["gpt-6-astra", "gpt-6.1-sol", "gpt-5.6-terra", "gpt-6-luna"],
  );
});

test("the director default and worker launch use the policy outside roles", () => {
  const org = organization();
  const director = directorCommand(org);
  assert.equal(director.role, "director");
  assert.equal(director.profile, "assignment:director");
  assert.equal(director.modelRequested, "gpt-6-astra");
  const pm = roleCommand(org, "pm", {
    pmSelection: {
      choice: { resourceId: "codex-current", model: "gpt-6.1-sol" },
      allowedResources: ["codex-current"],
    },
    workflowState: {},
  });
  assert.equal(pm.modelRequested, "gpt-6.1-sol");
  const worker = roleCommand(org, "worker", {
    staffing: staffing("gpt-6-luna"),
    workflowTask: "implementation",
    workflowState: {},
  });
  assert.equal(worker.modelRequested, "gpt-6-luna");
  const explicitEffort = roleCommand(org, "worker", {
    staffing: staffing("gpt-5.6-terra", "high"),
    workflowTask: "implementation",
    workflowState: {},
  });
  assert.equal(explicitEffort.effortRequested, "high");
});

test("workflow creation rejects a PM or worker staffing choice outside the assignment", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-assignment-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const args of [
    ["init"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"],
  ])
    assert.equal((await run(["git", ...args], { cwd: dir })).code, 0);
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  assert.equal((await run(["git", "add", "seed.txt"], { cwd: dir })).code, 0);
  assert.equal(
    (await run(["git", "commit", "-m", "seed"], { cwd: dir })).code,
    0,
  );
  writeJSON(path.join(dir, "task.json"), {
    schemaVersion: 2,
    revision: 1,
    kind: "edit",
    id: "implementation",
    goal: "Test assigned model validation",
    instruction: "Keep the fixture valid",
    nonGoals: [],
    constraints: [],
    files: ["seed.txt"],
    checks: [[process.execPath, "-e", "process.exit(0)"]],
    acceptance: [
      {
        id: "check",
        description: "passes",
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
    risk: "normal",
  });
  const request = {
    schemaVersion: 1,
    id: "model-assignment",
    goal: "Test policy",
    repo: ".",
    depth: 2,
    tasks: [{ file: "task.json", role: "worker" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 1, maxCalls: 1 },
    staffing: staffing("gpt-5.6-terra"),
  };
  await assert.doesNotReject(() =>
    createWorkflow(path.join(dir, ".omt"), request, organization(), dir),
  );
  const frozen = readWorkflow(path.join(dir, ".omt"), request.id);
  const revised = organization();
  revised.modelAssignment.worker.models = ["gpt-6-luna"];
  assert.equal(
    roleCommand(frozen.organization, "worker", {
      staffing: frozen.state.staffing,
      workflowTask: "implementation",
      workflowState: frozen.state,
    }).modelRequested,
    "gpt-5.6-terra",
  );
  assert.throws(
    () =>
      roleCommand(revised, "worker", {
        staffing: frozen.state.staffing,
        workflowTask: "implementation",
        workflowState: frozen.state,
      }),
    /does not allow model/,
  );
  const rejected = structuredClone(request);
  rejected.id = "wrong-worker";
  rejected.staffing.tasks.implementation.choice.model = "gpt-6.1-sol";
  await assert.rejects(
    createWorkflow(path.join(dir, ".omt"), rejected, organization(), dir),
    /does not allow model/,
  );
  const wrongPm = structuredClone(request);
  wrongPm.id = "wrong-pm";
  wrongPm.staffing.director.pm.model = "gpt-6-astra";
  await assert.rejects(
    createWorkflow(path.join(dir, ".omt"), wrongPm, organization(), dir),
    /does not allow model/,
  );
});
