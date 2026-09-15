/** Task v1/v2 validation, canonical hashing, and prompt-context loading. */
import fs from "node:fs";
import path from "node:path";
import { assert, hash, inside } from "./core.mjs";

// File ownership decides which tasks may run in parallel, and that decision is
// made by comparing these strings. "src/a.js", "./src/a.js" and "src\\a.js" all
// name one file but compare as three, so two tasks editing it were dispatched
// together. The contract stores one canonical spelling instead.
function assertCanonicalPath(value, name) {
  assert(
    typeof value === "string" && value.trim() && !path.isAbsolute(value),
    `${name} must be a relative path`,
  );
  // normalize() keeps a leading "../", so escaping paths must be rejected on
  // their own rather than assumed away by the equality below.
  assert(
    !value.includes("\\") &&
      !value.startsWith("../") &&
      value !== ".." &&
      value === path.posix.normalize(value),
    `${name} must be a normalized POSIX relative path: ${value}`,
  );
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function validateStringList(value, name) {
  assert(
    Array.isArray(value) &&
      value.every((item) => typeof item === "string" && item.trim()),
    `${name} must be a string array`,
  );
}

function validateCommonTask(task) {
  assert(ID_PATTERN.test(task.id), "Valid task id required");
  assert(
    typeof task.instruction === "string" && task.instruction.trim(),
    "Task instruction required",
  );
  assert(
    Array.isArray(task.files) &&
      task.files.length > 0 &&
      new Set(task.files).size === task.files.length,
    "Explicit unique task files required",
  );
  task.files.forEach((file) => assertCanonicalPath(file, "Task file"));
  assert(
    Array.isArray(task.checks) &&
      task.checks.length > 0 &&
      task.checks.every(
        (command) =>
          Array.isArray(command) &&
          command.length > 0 &&
          command.every((argument) => typeof argument === "string" && argument),
      ),
    "Task requires non-empty check argv arrays",
  );
  assert(
    typeof task.environment === "string" && task.environment.trim(),
    "Task environment fingerprint required",
  );
  assert(
    typeof task.baseRef === "string" && task.baseRef.trim(),
    "Task baseRef required",
  );
  assert(
    ["low", "normal", "high"].includes(task.risk),
    "Task risk must be low, normal or high",
  );
}

function validateAcceptance(task) {
  assert(
    Array.isArray(task.acceptance) && task.acceptance.length > 0,
    "Task v2 acceptance criteria required",
  );
  const ids = new Set();
  for (const criterion of task.acceptance) {
    assert(
      criterion && ID_PATTERN.test(criterion.id) && !ids.has(criterion.id),
      `Invalid or duplicate acceptance id: ${criterion?.id}`,
    );
    ids.add(criterion.id);
    assert(
      typeof criterion.description === "string" && criterion.description.trim(),
      `Acceptance description required: ${criterion.id}`,
    );
    assert(
      ["check", "review"].includes(criterion.method),
      `Invalid acceptance method: ${criterion.id}`,
    );

    if (criterion.method === "check") {
      assert(
        Array.isArray(criterion.checkIndexes) &&
          criterion.checkIndexes.length > 0,
        `Check indexes required: ${criterion.id}`,
      );
      assert(
        new Set(criterion.checkIndexes).size ===
          criterion.checkIndexes.length &&
          criterion.checkIndexes.every(
            (index) =>
              Number.isInteger(index) &&
              index >= 0 &&
              index < task.checks.length,
          ),
        `Invalid check index: ${criterion.id}`,
      );
    } else {
      assert(
        !criterion.checkIndexes || criterion.checkIndexes.length === 0,
        `Review criterion cannot claim check indexes: ${criterion.id}`,
      );
    }
  }
  return ids;
}

function validateDependencies(dependencies) {
  assert(Array.isArray(dependencies), "Task v2 dependencies required");
  for (const dependency of dependencies) {
    assert(
      dependency &&
        ID_PATTERN.test(dependency.taskId) &&
        Number.isInteger(dependency.revision) &&
        dependency.revision >= 1 &&
        typeof dependency.acceptedResult === "string" &&
        dependency.acceptedResult.trim(),
      "Invalid task dependency",
    );
  }
}

function validateReferences(references, name) {
  assert(Array.isArray(references), `Task v2 ${name} required`);
  for (const reference of references) {
    assert(
      reference &&
        typeof reference.path === "string" &&
        reference.path &&
        typeof reference.sha256 === "string" &&
        SHA256_PATTERN.test(reference.sha256),
      `${name} require path and sha256`,
    );
    assertCanonicalPath(reference.path, `${name} path`);
  }
}

function validateOpenQuestions(questions) {
  assert(Array.isArray(questions), "Task v2 openQuestions required");
  assert(
    questions.every(
      (question) =>
        question &&
        typeof question.id === "string" &&
        typeof question.question === "string" &&
        typeof question.blocking === "boolean" &&
        (!question.blocking ||
          (typeof question.resolution === "string" &&
            question.resolution.trim())),
    ),
    "Blocking questions must be resolved before execution",
  );
}

function validateReviewRequirements(task, acceptanceIds) {
  assert(
    Array.isArray(task.reviewRequirements),
    "Task v2 reviewRequirements required",
  );
  const reviewIds = new Set();
  for (const review of task.reviewRequirements) {
    assert(
      review && ID_PATTERN.test(review.id) && !reviewIds.has(review.id),
      `Invalid or duplicate review requirement: ${review?.id}`,
    );
    reviewIds.add(review.id);
    assert(
      review.kind === "agent-review" && review.role === "senior",
      `Unsupported review requirement: ${review.id}`,
    );
    assert(
      Array.isArray(review.criteria) &&
        review.criteria.length > 0 &&
        review.criteria.every((id) => acceptanceIds.has(id)),
      `Unknown review criteria: ${review.id}`,
    );
  }

  const reviewedCriteria = new Set(
    task.reviewRequirements.flatMap((review) => review.criteria),
  );
  assert(
    task.acceptance
      .filter((criterion) => criterion.method === "review")
      .every((criterion) => reviewedCriteria.has(criterion.id)),
    "Every review acceptance criterion needs a review requirement",
  );
}

/**
 * Validates either the legacy limited-edit task or the richer task v2 contract.
 *
 * @param {object} task - Task input with `schemaVersion` 1 or 2.
 * @returns {object} The same validated task object.
 * @throws {Error} When any executable or business-contract invariant fails.
 */
export function validateTask(task) {
  assert(
    task && [1, 2].includes(task.schemaVersion),
    "Task schemaVersion must be 1 or 2",
  );
  validateCommonTask(task);
  if (task.schemaVersion === 1) return task;

  assert(
    Number.isInteger(task.revision) && task.revision >= 1,
    "Task v2 requires a positive revision",
  );
  assert(
    task.kind === "edit",
    "Task v2 limited-edit runtime supports kind=edit only",
  );
  assert(
    typeof task.goal === "string" && task.goal.trim(),
    "Task v2 goal required",
  );
  validateStringList(task.nonGoals, "nonGoals");
  validateStringList(task.constraints, "constraints");
  const acceptanceIds = validateAcceptance(task);
  validateDependencies(task.dependencies);
  validateReferences(task.contractRefs, "contractRefs");
  validateReferences(task.contextRefs ?? [], "contextRefs");
  validateOpenQuestions(task.openQuestions);
  validateReviewRequirements(task, acceptanceIds);
  return task;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

/**
 * Hashes a validated task with recursively sorted object keys.
 *
 * @param {object} task - Task v1 or v2 contract.
 * @returns {string} Stable SHA-256 contract digest.
 * @throws {Error} When the task is invalid.
 */
export function taskHash(task) {
  validateTask(task);
  return hash(canonicalize(task));
}

function readReference(repo, reference, includeContent) {
  const file = inside(repo, reference.path);
  const content = fs.readFileSync(file, "utf8");
  const actualHash = hash(content);
  assert(
    actualHash === reference.sha256,
    `Stale contract/context ref: ${reference.path}`,
  );
  return {
    path: reference.path,
    sha256: actualHash,
    ...(includeContent ? { content } : {}),
  };
}

/**
 * Builds the read-only contract context supplied to a limited-edit model.
 *
 * Contract references are hash-checked but omit content; context references
 * include their verified content. Task v1 returns `null` for compatibility.
 *
 * @param {string} repo - Workspace root used for contained reference reads.
 * @param {object} task - Valid task contract.
 * @returns {object | null} Prompt-safe contract context or `null` for v1.
 * @throws {Error} When a reference escapes, is missing, or has a stale hash.
 */
export function taskContext(repo, task) {
  validateTask(task);
  if (task.schemaVersion === 1) return null;

  return {
    goal: task.goal,
    nonGoals: task.nonGoals,
    constraints: task.constraints,
    acceptance: task.acceptance,
    contractRefs: task.contractRefs.map((reference) =>
      readReference(repo, reference, false),
    ),
    contextRefs: (task.contextRefs ?? []).map((reference) =>
      readReference(repo, reference, true),
    ),
  };
}
