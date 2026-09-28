/** Tests the new Director–PM–Worker organization without changing saved legacy runs. */
import test from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  definedRoles,
  depthRoles,
  foldRole,
  run,
  validateOrg,
  writeJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import { draftThreeTierOrganization } from "../plugins/oh-my-teams/scripts/org-draft.mjs";
import {
  DISPATCH_AUTHORITY,
  readRoleCharter,
  roleSpec,
} from "../plugins/oh-my-teams/scripts/role-launch.mjs";
import { roleTitle } from "../plugins/oh-my-teams/scripts/role-terminal.mjs";
import { validateTask } from "../plugins/oh-my-teams/scripts/contracts.mjs";
import { classifyFailure } from "../plugins/oh-my-teams/scripts/failures.mjs";
import { validateReviewInput } from "../plugins/oh-my-teams/scripts/gates.mjs";
import {
  createWorkflow,
  setWorkflowDepth,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";

const organization = () =>
  draftThreeTierOrganization({
    name: "small team",
    models: ["codex:default", "agy:default"],
  });

test("formation binds only PM and Worker; PM owns planning and integration", () => {
  const org = organization();
  assert.deepEqual(definedRoles(validateOrg(org)), ["pm", "worker"]);
  assert.equal(org.roles.worker.parent, "pm");
  assert.deepEqual(depthRoles(definedRoles(org), 1), ["pm"]);
  assert.deepEqual(depthRoles(definedRoles(org), 2), ["pm", "worker"]);
  assert.throws(() => depthRoles(definedRoles(org), 3), /Depth must be 1\.\.2/);
  assert.equal(foldRole(definedRoles(org), "pl"), "pm");
  assert.equal(foldRole(definedRoles(org), "senior"), "worker");
  assert.equal(foldRole(definedRoles(org), "junior"), "worker");
  assert.equal(
    foldRole(definedRoles(org), classifyFailure({ kind: "scope" }).nextOwner),
    "pm",
  );
  assert.equal(
    foldRole(
      definedRoles(org),
      classifyFailure({ kind: "implementation" }).nextOwner,
    ),
    "worker",
  );
  assert.ok(DISPATCH_AUTHORITY.pm.includes("worker"));
  assert.deepEqual(DISPATCH_AUTHORITY.worker, []);
  assert.match(roleSpec(org, "worker", "Implement the task"), /보고 대상: PM/);
  assert.match(readRoleCharter("worker"), /독립 검토/);
  assert.equal(roleTitle("worker", "task"), "[Worker] task");
});

test("a new workflow defaults to PM and Worker and folds legacy ownership", async (context) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omt-three-tier-"));
  context.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  for (const arguments_ of [
    ["init"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"],
  ]) {
    assert.equal((await run(["git", ...arguments_], { cwd: repo })).code, 0);
  }
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  assert.equal((await run(["git", "add", "seed.txt"], { cwd: repo })).code, 0);
  assert.equal(
    (await run(["git", "commit", "-m", "seed"], { cwd: repo })).code,
    0,
  );
  fs.writeFileSync(path.join(repo, "value.txt"), "value\n");
  writeJSON(path.join(repo, "task.json"), {
    schemaVersion: 2,
    revision: 1,
    kind: "edit",
    id: "worker-task",
    goal: "Check the worker route",
    instruction: "Keep the value unchanged",
    nonGoals: [],
    constraints: [],
    files: ["value.txt"],
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
  const request = {
    schemaVersion: 1,
    id: "three-tier-run",
    goal: "Check the worker route",
    repo: ".",
    tasks: [{ file: "task.json", role: "worker" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 2, maxCalls: 2 },
  };
  const org = organization();
  const stateDir = path.join(repo, ".omt");
  const state = await createWorkflow(stateDir, request, org, repo);
  assert.deepEqual(state.roles, ["pm", "worker"]);
  assert.equal(state.depth, 2);
  assert.equal(state.tasks["worker-task"].role, "worker");
  await assert.rejects(
    createWorkflow(
      path.join(repo, "invalid"),
      { ...request, id: "invalid-run", depth: 3 },
      org,
      repo,
    ),
    /depth must be 1\.\.2/,
  );
  await assert.rejects(
    createWorkflow(
      path.join(repo, "legacy-role"),
      {
        ...request,
        id: "legacy-role-run",
        tasks: [{ file: "task.json", role: "pl" }],
      },
      org,
      repo,
    ),
    /must use pm or worker roles/,
  );
  assert.throws(
    () =>
      setWorkflowDepth(stateDir, request.id, state.revision, {
        schemaVersion: 1,
        eventId: "raise-depth",
        depth: 3,
        reason: "not needed",
        evidence: "worker handles review",
      }),
    /Depth must be 1\.\.2/,
  );
});

test("a new organization cannot mix Worker with the retired ranks", () => {
  const org = organization();
  org.roles.pl = { ...org.roles.worker };
  assert.throws(() => validateOrg(org), /cannot declare legacy/);
});

test("published schemas accept Worker organizations, tasks, reviews, and document authors", () => {
  const schema = (name) =>
    JSON.parse(
      readFileSync(
        new URL(`../plugins/oh-my-teams/schemas/${name}`, import.meta.url),
      ),
    );
  assert.ok(
    schema("organization.schema.json").properties.roles.properties.worker,
  );
  assert.ok(
    schema(
      "workflow.schema.json",
    ).properties.tasks.items.properties.role.enum.includes("worker"),
  );
  assert.ok(
    schema("task.schema.json").$defs.review.properties.role.enum.includes(
      "worker",
    ),
  );
  assert.ok(
    schema(
      "review.schema.json",
    ).properties.reviewer.properties.role.enum.includes("worker"),
  );
  for (const name of fs
    .readdirSync(new URL("../plugins/oh-my-teams/schemas/", import.meta.url))
    .filter(
      (name) => name.startsWith("document-") && name.endsWith(".schema.json"),
    )) {
    assert.ok(
      schema(name).$defs.author.properties.role.enum.includes("worker"),
    );
  }
});

test("Worker reviews require a separate execution identity", () => {
  const task = JSON.parse(
    readFileSync(
      new URL("../plugins/oh-my-teams/examples/task.v2.json", import.meta.url),
    ),
  );
  task.reviewRequirements[0].role = "worker";
  validateTask(task);
  const review = JSON.parse(
    readFileSync(
      new URL("../plugins/oh-my-teams/examples/review.json", import.meta.url),
    ),
  );
  review.reviewer.role = "worker";
  assert.equal(validateReviewInput(review, task), review);
  review.reviewer.executionId = review.implementationExecutionId;
  assert.throws(
    () => validateReviewInput(review, task),
    /different execution identity/,
  );
});
