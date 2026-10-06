/** Regression tests for frozen adaptive staffing decisions. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, writeJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import { draftResourceOrganization } from "../plugins/oh-my-teams/scripts/org-draft.mjs";
import {
  changeTaskStaffing,
  createWorkflow,
  readWorkflow,
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
  });
  assert.equal(command.modelRequested, "gemini-test");
});

test("PM cannot alter its own choice and a named upgrade requires director evidence", async (t) => {
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
        reason: "try an unknown resource",
        choice: { resourceId: "not-a-resource", model: "unknown" },
      }),
    /Unknown staffing resource/,
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
