/** Contract coverage for intern-first task metadata and workflow role omission. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validateTask } from "../plugins/oh-my-teams/scripts/contracts.mjs";
import { validateWorkflowRequest } from "../plugins/oh-my-teams/scripts/workflow.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const readJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));

const taskSchema = () =>
  readJson("plugins/oh-my-teams/schemas/task.schema.json");
const workflowSchema = () =>
  readJson("plugins/oh-my-teams/schemas/workflow.schema.json");
const organizationSchema = () =>
  readJson("plugins/oh-my-teams/schemas/organization.schema.json");

const delegation = {
  scope: "closed",
  verification: "deterministic",
  authority: "standard",
  design: "routine",
};

test("task schema exposes the runtime delegation contract without making it required", () => {
  const schema = taskSchema();
  assert.equal(schema.properties.delegation.$ref, "#/$defs/delegation");
  assert.ok(!schema.required.includes("delegation"));
  assert.deepEqual(schema.$defs.delegation.required, [
    "scope",
    "verification",
    "authority",
    "design",
  ]);
  assert.deepEqual(schema.$defs.delegation.properties.scope.enum, [
    "closed",
    "open",
  ]);
  assert.deepEqual(schema.$defs.delegation.properties.verification.enum, [
    "deterministic",
    "independent-review",
  ]);
  assert.deepEqual(schema.$defs.delegation.properties.authority.enum, [
    "standard",
    "elevated",
  ]);
  assert.deepEqual(schema.$defs.delegation.properties.design.enum, [
    "routine",
    "significant",
  ]);
});

test("runtime accepts task v1 and task v2 with complete metadata", () => {
  assert.doesNotThrow(() =>
    validateTask(readJson("plugins/oh-my-teams/examples/task.json")),
  );
  const task = readJson("plugins/oh-my-teams/examples/task.v2.json");
  task.delegation = delegation;
  assert.equal(validateTask(task), task);
});

test("runtime rejects incomplete or unknown delegation metadata", () => {
  const task = readJson("plugins/oh-my-teams/examples/task.v2.json");
  for (const field of Object.keys(delegation)) {
    const invalid = { ...delegation };
    delete invalid[field];
    assert.throws(
      () => validateTask({ ...task, delegation: invalid }),
      /Delegation (scope|verification|authority|design)/,
    );
  }
  assert.throws(
    () =>
      validateTask({ ...task, delegation: { ...delegation, scope: "wide" } }),
    /Delegation scope must be closed or open/,
  );
  assert.equal(taskSchema().$defs.delegation.additionalProperties, false);
});

test("workflow schema and runtime both allow omitted role and retain explicit roles", () => {
  const schema = workflowSchema();
  const taskDefinition = schema.properties.tasks.items;
  assert.deepEqual(taskDefinition.required, ["file"]);
  assert.deepEqual(taskDefinition.properties.role.enum, [
    "pm",
    "pl",
    "senior",
    "junior",
    "intern",
  ]);
  const request = {
    schemaVersion: 1,
    id: "intern-first-schema",
    goal: "Validate role compatibility.",
    repo: ".",
    tasks: [
      { file: "automatic.json" },
      { file: "explicit.json", role: "senior" },
    ],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 1, maxCalls: 1 },
  };
  assert.equal(validateWorkflowRequest(request), request);
  for (const role of ["pm", "pl", "senior", "junior", "intern"]) {
    assert.doesNotThrow(() =>
      validateWorkflowRequest({
        ...request,
        tasks: [{ file: "task.json", role }],
      }),
    );
  }
  assert.throws(
    () =>
      validateWorkflowRequest({
        ...request,
        tasks: [{ file: "task.json", role: "director" }],
      }),
    /Each workflow task needs a file and role when explicitly assigned/,
  );
});

test("organization policy delegation is optional and accepts only intern-first", () => {
  const schema = organizationSchema();
  const policy = schema.properties.policy;
  const delegation = policy.properties.delegation;
  assert.ok(!policy.required.includes("delegation"));
  assert.equal(delegation.type, "object");
  assert.equal(delegation.additionalProperties, false);
  assert.deepEqual(delegation.required, ["strategy"]);
  assert.deepEqual(delegation.properties.strategy.enum, ["intern-first"]);

  const existingOrganization = readJson(
    "plugins/oh-my-teams/examples/organization.json",
  );
  assert.equal(existingOrganization.policy.delegation, undefined);
  assert.ok(existingOrganization.policy);

  const valid = {
    ...existingOrganization,
    policy: {
      ...existingOrganization.policy,
      delegation: { strategy: "intern-first" },
    },
  };
  assert.equal(valid.policy.delegation.strategy, "intern-first");
  assert.deepEqual(delegation.properties.strategy.enum, [
    valid.policy.delegation.strategy,
  ]);
  assert.equal(delegation.additionalProperties, false);

  assert.ok(!delegation.properties.strategy.enum.includes("junior-first"));
  assert.ok(!delegation.properties.strategy.enum.includes(1));
  assert.ok(!delegation.required.includes(""));
  assert.equal(delegation.additionalProperties, false);
  assert.notEqual(typeof "intern-first", delegation.type);
});
