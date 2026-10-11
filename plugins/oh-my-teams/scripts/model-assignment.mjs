/** Persistent model-assignment policy for resource-based organizations. */

const POLICY_ROLES = Object.freeze(["director", "pm", "worker"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertChoice(choice, name) {
  assert(
    choice &&
      typeof choice === "object" &&
      !Array.isArray(choice) &&
      Object.keys(choice).every((key) =>
        ["resourceId", "model"].includes(key),
      ) &&
      typeof choice.resourceId === "string" &&
      choice.resourceId.trim() &&
      typeof choice.model === "string" &&
      choice.model.trim(),
    `Model assignment ${name} needs only resourceId and model`,
  );
}

function assertResource(resources, choice, name) {
  const resource = resources?.[choice.resourceId];
  assert(
    resource?.provider === "codex",
    `Model assignment ${name} must use a registered Codex resource`,
  );
}

/**
 * Validates an optional, durable policy that limits future resource staffing.
 *
 * A missing policy keeps organizations saved before this feature readable. A
 * present policy deliberately records no reasoning effort. Staffing may still
 * carry a separately chosen, provider-valid effort when a user specifies one.
 *
 * @param {object} assignment - Organization model-assignment policy.
 * @param {object} resources - Registered organization resources.
 * @returns {object} The validated policy.
 * @throws {Error} When the policy is malformed or references another resource.
 */
export function validateModelAssignment(assignment, resources) {
  assert(
    assignment &&
      typeof assignment === "object" &&
      !Array.isArray(assignment) &&
      Object.keys(assignment).every((key) =>
        ["schemaVersion", ...POLICY_ROLES].includes(key),
      ) &&
      assignment.schemaVersion === 1,
    "Model assignment needs schemaVersion=1",
  );
  assertChoice(assignment.director, "director");
  assertChoice(assignment.pm, "pm");
  assertResource(resources, assignment.director, "director");
  assertResource(resources, assignment.pm, "pm");
  const worker = assignment.worker;
  assert(
    worker &&
      typeof worker === "object" &&
      !Array.isArray(worker) &&
      Object.keys(worker).every((key) =>
        ["resourceId", "models"].includes(key),
      ) &&
      typeof worker.resourceId === "string" &&
      worker.resourceId.trim() &&
      Array.isArray(worker.models) &&
      worker.models.length > 0 &&
      worker.models.every(
        (model) => typeof model === "string" && model.trim(),
      ) &&
      new Set(worker.models).size === worker.models.length,
    "Model assignment worker needs resourceId and unique models",
  );
  assertResource(resources, worker, "worker");
  return assignment;
}

/**
 * Verifies a frozen PM or Worker staffing choice against the saved policy.
 *
 * @param {object} organization - Resource organization snapshot or live document.
 * @param {"pm"|"worker"} role - Role making the selection.
 * @param {object} choice - Frozen resource/model/effort selection.
 * @returns {void}
 * @throws {Error} When the choice is outside the persistent policy.
 */
export function assertModelAssignmentChoice(organization, role, choice) {
  const assignment = organization?.modelAssignment;
  if (assignment === undefined) return;
  validateModelAssignment(assignment, organization.resources);
  assert(
    role === "pm" || role === "worker",
    `Model assignment has no selectable policy for role ${role}`,
  );
  const allowed = assignment[role];
  assert(
    choice?.resourceId === allowed.resourceId,
    `Model assignment ${role} must use resource ${allowed.resourceId}`,
  );
  const models = role === "worker" ? allowed.models : [allowed.model];
  assert(
    models.includes(choice?.model),
    `Model assignment ${role} does not allow model ${choice?.model ?? "(missing)"}`,
  );
}

/**
 * Lists concrete choices that must be catalog-checked before an organization
 * revision containing this policy is saved.
 *
 * @param {object} organization - Candidate organization revision.
 * @returns {Array<{key: string, provider: string, model: string}>} Catalog selections.
 */
export function modelAssignmentCatalogSelections(organization) {
  const assignment = organization?.modelAssignment;
  if (assignment === undefined) return [];
  validateModelAssignment(assignment, organization.resources);
  return [
    {
      key: "model-assignment-director",
      provider: "codex",
      model: assignment.director.model,
    },
    {
      key: "model-assignment-pm",
      provider: "codex",
      model: assignment.pm.model,
    },
    ...assignment.worker.models.map((model) => ({
      key: `model-assignment-worker-${model}`,
      provider: "codex",
      model,
    })),
  ];
}

/**
 * Returns the saved director default for a resource organization.
 *
 * @param {object} organization - Organization document.
 * @returns {{resourceId: string, model: string}|null} Director default or null.
 */
export function directorModelAssignment(organization) {
  const assignment = organization?.modelAssignment;
  if (assignment === undefined) return null;
  validateModelAssignment(assignment, organization.resources);
  return { ...assignment.director };
}
