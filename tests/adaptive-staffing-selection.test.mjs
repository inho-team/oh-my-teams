/** Regression tests for frozen adaptive staffing decisions. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, writeJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import { draftResourceOrganization } from "../plugins/oh-my-teams/scripts/org-draft.mjs";
import {
  attachExecution,
  changeTaskStaffing,
  createWorkflow,
  recordSettlement,
  readWorkflow,
  retryTask,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";
import { roleCommand } from "../plugins/oh-my-teams/scripts/role-launch.mjs";

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adaptive-staffing-"));
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
  writeJSON(path.join(dir, "task.json"), {
    schemaVersion: 2,
    revision: 1,
    kind: "edit",
    id: "implementation",
    goal: "Implement one bounded change",
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
  const organization = draftResourceOrganization({
    name: "resource team",
    resources: ["codex", "agy"],
  });
  const staffing = {
    schemaVersion: 1,
    catalog: {
      revision: "catalog-proof",
      verifiedAt: "2026-10-06T00:00:00.000Z",
    },
    director: {
      allowedResources: ["codex-current", "agy-current"],
      complexity: "bounded workflow",
      risk: "normal change",
      context: "one task",
      reason: "PM needs the recorded Codex choice",
      pm: { resourceId: "codex-current", model: "gpt-test", effort: "high" },
      changeApprovals: [
        {
          id: "director-approval-1",
          taskId: "implementation",
          reason: "higher rework risk",
          from: {
            resourceId: "agy-current",
            model: "gemini-test",
            effort: "high",
          },
          to: {
            resourceId: "codex-current",
            model: "gpt-test",
            effort: "high",
          },
        },
        {
          id: "director-approval-2",
          taskId: "implementation",
          reason: "verified same-pool retry",
          from: {
            resourceId: "agy-current",
            model: "gemini-test",
            effort: "high",
          },
          to: {
            resourceId: "agy-current",
            model: "gemini-retry",
            effort: "high",
          },
        },
      ],
    },
    tasks: {
      implementation: {
        role: "worker",
        designComplexity: "bounded edit",
        changeScope: "one file",
        reviewIndependence: "separate review remains required",
        reworkCost: "repeat work would cost one extra call",
        reason: "initial task choice",
        choice: {
          resourceId: "agy-current",
          model: "gemini-test",
          effort: "high",
        },
      },
    },
  };
  const request = {
    schemaVersion: 1,
    id: "adaptive-staffing",
    goal: "Freeze staffing decisions",
    repo: ".",
    depth: 2,
    tasks: [{ file: "task.json", role: "worker" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 2, maxCalls: 3 },
    staffing,
  };
  return { dir, organization, request, stateDir: path.join(dir, ".omt") };
}

test("resource workflows require and preserve director and task staffing evidence", async (t) => {
  const { dir, organization, request, stateDir } = await fixture(t);
  await assert.rejects(
    createWorkflow(
      stateDir,
      { ...request, id: "missing-staffing", staffing: undefined },
      organization,
      dir,
    ),
    /Staffing needs schemaVersion=1/,
  );
  await createWorkflow(stateDir, request, organization, dir);
  const snapshot = readWorkflow(stateDir, request.id);
  assert.equal(snapshot.state.staffing.catalog.revision, "catalog-proof");
  assert.equal(
    snapshot.state.tasks.implementation.staffing.choice.model,
    "gemini-test",
  );
  const command = roleCommand(snapshot.organization, "worker", {
    roles: snapshot.state.roles,
    staffing: snapshot.state.staffing,
    workflowTask: "implementation",
    workflowState: snapshot.state,
  });
  assert.equal(command.modelRequested, "gemini-test");
});

test("PM cannot bypass a frozen director approval with an arbitrary upgrade or lateral label", async (t) => {
  const { dir, organization, request, stateDir } = await fixture(t);
  await createWorkflow(stateDir, request, organization, dir);
  const revision = () => readWorkflow(stateDir, request.id).state.revision;
  assert.throws(
    () =>
      changeTaskStaffing(stateDir, request.id, revision(), {
        schemaVersion: 1,
        eventId: "pm-self-change",
        taskId: "implementation",
        actor: "pm",
        change: "upgrade",
        reason: "try another profile",
        choice: {
          resourceId: "codex-current",
          model: "gpt-test",
          effort: "high",
        },
      }),
    /director decision/,
  );
  assert.throws(
    () =>
      changeTaskStaffing(stateDir, request.id, revision(), {
        schemaVersion: 1,
        eventId: "outside-approved-resource",
        taskId: "implementation",
        actor: "pm",
        change: "lateral",
        reason: "try a different model without approval",
        choice: {
          resourceId: "agy-current",
          model: "gemini-retry",
          effort: "high",
        },
        directorDecision: {
          id: "invented-director-decision",
          reason: "invented approval",
        },
      }),
    /not recorded in the frozen workflow/,
  );
  assert.throws(
    () =>
      changeTaskStaffing(stateDir, request.id, revision(), {
        schemaVersion: 1,
        eventId: "mismatched-director-decision",
        taskId: "implementation",
        actor: "pm",
        change: "upgrade",
        reason: "try an arbitrary director string",
        choice: {
          resourceId: "codex-current",
          model: "gpt-test",
          effort: "high",
        },
        directorDecision: {
          id: "director-approval-1",
          reason: "a different arbitrary reason",
        },
      }),
    /does not match the recorded director decision/,
  );
  const result = changeTaskStaffing(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "director-approved-upgrade",
    taskId: "implementation",
    actor: "pm",
    change: "upgrade",
    reason: "risk evidence requires a different verified resource",
    choice: { resourceId: "codex-current", model: "gpt-test", effort: "high" },
    directorDecision: {
      id: "director-approval-1",
      reason: "higher rework risk",
    },
  });
  assert.equal(
    result.state.tasks.implementation.staffing.choice.resourceId,
    "codex-current",
  );
  assert.equal(
    result.state.tasks.implementation.staffing.directorDecision.id,
    "director-approval-1",
  );
});

test("exhausted and unknown pools reject another model selection and launch", async (t) => {
  await t.test(
    "a settled call blocks another task's selection and launch in the same Codex pool",
    async (t) => {
      const { dir, organization, request, stateDir } = await fixture(t);
      const verification = structuredClone(
        JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8")),
      );
      verification.id = "verification";
      writeJSON(path.join(dir, "verification.json"), verification);
      organization.resources["codex-current"].maxCalls = 1;
      request.tasks.push({ file: "verification.json", role: "worker" });
      request.budget = { maxAttempts: 2, maxCalls: 2 };
      request.staffing.tasks.implementation.choice = {
        resourceId: "codex-current",
        model: "gpt-test",
        effort: "high",
      };
      request.staffing.tasks.verification = {
        ...structuredClone(request.staffing.tasks.implementation),
        reason: "second task uses the same Codex pool",
        choice: {
          resourceId: "codex-current",
          model: "gpt-test",
          effort: "high",
        },
      };
      request.staffing.director.changeApprovals = [
        {
          id: "director-approval-shared-codex",
          taskId: "verification",
          reason: "verified alternate model still uses the shared Codex pool",
          from: {
            resourceId: "codex-current",
            model: "gpt-test",
            effort: "high",
          },
          to: {
            resourceId: "codex-current",
            model: "gpt-retry",
            effort: "high",
          },
        },
      ];
      await createWorkflow(stateDir, request, organization, dir);
      const revision = () => readWorkflow(stateDir, request.id).state.revision;
      const receipt = {
        executionId: "shared-codex-execution",
        runId: "shared-codex-run",
        taskId: "shared-codex-task",
        dispatchId: "shared-codex-dispatch",
        worktreeId: `repo::${dir}`,
      };
      attachExecution(stateDir, request.id, revision(), {
        schemaVersion: 1,
        eventId: "attach-shared-codex-call",
        attemptId: "shared-codex-attempt",
        taskId: "implementation",
        callAllowance: 1,
        receipt,
      });
      recordSettlement(stateDir, request.id, revision(), {
        schemaVersion: 1,
        eventId: "settle-shared-codex-call",
        attemptId: "shared-codex-attempt",
        taskId: "implementation",
        executionId: receipt.executionId,
        outcome: "settled",
        callsUsed: 1,
      });
      const frozen = readWorkflow(stateDir, request.id);
      const frozenState = structuredClone(frozen.state);
      const frozenOrganization = structuredClone(frozen.organization);
      assert.equal(
        frozen.state.staffing.poolStates["codex-current"].status,
        "available",
      );

      assert.throws(
        () =>
          changeTaskStaffing(stateDir, request.id, revision(), {
            schemaVersion: 1,
            eventId: "select-shared-codex-retry",
            taskId: "verification",
            actor: "pm",
            change: "lateral",
            reason: "try another model in the same capped Codex pool",
            choice: {
              resourceId: "codex-current",
              model: "gpt-retry",
              effort: "high",
            },
            directorDecision: {
              id: "director-approval-shared-codex",
              reason:
                "verified alternate model still uses the shared Codex pool",
            },
          }),
        /Staffing pool codex-current exhausted its 1 call allowance/,
      );
      assert.throws(
        () =>
          roleCommand(frozen.organization, "worker", {
            roles: frozen.state.roles,
            staffing: frozen.state.staffing,
            workflowTask: "verification",
            workflowState: frozen.state,
          }),
        /Staffing pool codex-current exhausted its 1 call allowance/,
      );

      const afterRejections = readWorkflow(stateDir, request.id);
      assert.deepEqual(afterRejections.organization, frozenOrganization);
      assert.deepEqual(afterRejections.state, frozenState);
    },
  );

  const { dir, organization, request, stateDir } = await fixture(t);
  await createWorkflow(stateDir, request, organization, dir);
  const revision = () => readWorkflow(stateDir, request.id).state.revision;
  const receipt = {
    executionId: "execution-a",
    runId: "run-a",
    taskId: "orca-a",
    dispatchId: "dispatch-a",
    worktreeId: `repo::${dir}`,
  };
  attachExecution(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "attach-a",
    attemptId: "attempt-a",
    taskId: "implementation",
    callAllowance: 1,
    receipt,
  });
  recordSettlement(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "pool-exhausted-a",
    attemptId: "attempt-a",
    taskId: "implementation",
    executionId: receipt.executionId,
    outcome: "failed",
    callsUsed: 1,
    failure: {
      message: "subscription pool exhausted",
      evidence: "worker-limit-check",
      failureClass: "pool-exhausted",
    },
  });
  let snapshot = readWorkflow(stateDir, request.id);
  assert.equal(
    snapshot.state.staffing.poolStates["agy-current"].status,
    "exhausted",
  );
  assert.throws(
    () =>
      roleCommand(snapshot.organization, "worker", {
        roles: snapshot.state.roles,
        staffing: snapshot.state.staffing,
        workflowTask: "implementation",
        workflowState: snapshot.state,
      }),
    /Staffing pool agy-current is exhausted/,
  );
  retryTask(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "retry-after-pool-failure",
    taskId: "implementation",
    resolvedBy: "pm",
    resolution: "director will choose a verified alternative",
    evidence: "worker-limit-check",
  });
  assert.throws(
    () =>
      changeTaskStaffing(stateDir, request.id, revision(), {
        schemaVersion: 1,
        eventId: "same-pool-model-change",
        taskId: "implementation",
        actor: "pm",
        change: "lateral",
        reason: "try another model in the exhausted pool",
        choice: {
          resourceId: "agy-current",
          model: "gemini-retry",
          effort: "high",
        },
        directorDecision: {
          id: "director-approval-2",
          reason: "verified same-pool retry",
        },
      }),
    /Staffing pool agy-current is exhausted/,
  );
  snapshot = readWorkflow(stateDir, request.id);
  snapshot.state.staffing.poolStates["agy-current"] = { status: "unknown" };
  writeJSON(
    path.join(stateDir, "workflows", request.id, "state.json"),
    snapshot.state,
  );
  snapshot = readWorkflow(stateDir, request.id);
  assert.throws(
    () =>
      roleCommand(snapshot.organization, "worker", {
        roles: snapshot.state.roles,
        staffing: snapshot.state.staffing,
        workflowTask: "implementation",
        workflowState: snapshot.state,
      }),
    /Staffing pool agy-current is unknown/,
  );
  assert.throws(
    () =>
      changeTaskStaffing(stateDir, request.id, revision(), {
        schemaVersion: 1,
        eventId: "unknown-pool-model-change",
        taskId: "implementation",
        actor: "pm",
        change: "lateral",
        reason: "try another model in an unknown pool",
        choice: {
          resourceId: "agy-current",
          model: "gemini-retry",
          effort: "high",
        },
        directorDecision: {
          id: "director-approval-2",
          reason: "verified same-pool retry",
        },
      }),
    /Staffing pool agy-current is unknown/,
  );
});
