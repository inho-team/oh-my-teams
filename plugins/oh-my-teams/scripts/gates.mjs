/** Structured semantic review and final outcome-acceptance gates. */
import fs from "node:fs";
import path from "node:path";
import {
  assert,
  readJsonDirectory,
  writeJSON,
  withAsyncFileLock,
} from "./core.mjs";
import { taskHash, validateTask } from "./contracts.mjs";
import { validateEvidence } from "./evidence.mjs";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const REVIEW_CONCLUSIONS = ["approved", "changes-requested", "inconclusive"];
const FINDING_STATUSES = ["open", "resolved", "accepted-risk"];

const reviewFile = (stateDir, id) =>
  path.join(stateDir, "reviews", `${id}.json`);
const decisionFile = (stateDir, id) =>
  path.join(stateDir, "decisions", `${id}.json`);
const gateFile = (stateDir, taskId) =>
  path.join(stateDir, "gates", `${taskId}.json`);

function validateFinding(finding) {
  assert(finding && ID_PATTERN.test(finding.id), "Finding id required");
  assert(
    FINDING_STATUSES.includes(finding.status),
    `Invalid finding status: ${finding.id}`,
  );
  assert(
    typeof finding.description === "string" && finding.description.trim(),
    `Finding description required: ${finding.id}`,
  );
  if (finding.status === "resolved") {
    assert(
      typeof finding.resolution === "string" && finding.resolution.trim(),
      `Resolved finding needs evidence: ${finding.id}`,
    );
  }
  if (finding.status === "accepted-risk") {
    assert(
      ["pm", "user"].includes(finding.authority) &&
        typeof finding.reason === "string" &&
        finding.reason.trim(),
      `Accepted risk needs PM/user authority and reason: ${finding.id}`,
    );
  }
}

function reviewRequirement(task, requirementId) {
  const requirement = task.reviewRequirements.find(
    (item) => item.id === requirementId,
  );
  assert(requirement, `Unknown review requirement: ${requirementId}`);
  return requirement;
}

/**
 * Validates an independent semantic-review input against its task requirement.
 *
 * @param {object} input - Review identity, criteria conclusions, and findings.
 * @param {object} task - Task v2 contract containing the review requirement.
 * @returns {object} The same validated review input.
 * @throws {Error} For self-review, missing criteria, invalid findings, or bad approval.
 */
export function validateReviewInput(input, task) {
  validateTask(task);
  assert(task.schemaVersion === 2, "Structured reviews require task v2");
  assert(
    input?.schemaVersion === 1 && ID_PATTERN.test(input.id),
    "Review schemaVersion=1 and id required",
  );
  const requirement = reviewRequirement(task, input.requirementId);
  assert(
    input.reviewer?.kind === requirement.kind &&
      input.reviewer.role === requirement.role &&
      typeof input.reviewer.executionId === "string" &&
      input.reviewer.executionId.trim(),
    "Reviewer does not satisfy the required kind/role/execution identity",
  );
  assert(
    typeof input.implementationExecutionId === "string" &&
      input.implementationExecutionId.trim() &&
      input.implementationExecutionId !== input.reviewer.executionId,
    "Independent review must use a different execution identity",
  );
  assert(
    REVIEW_CONCLUSIONS.includes(input.conclusion),
    "Invalid review conclusion",
  );
  assert(
    Array.isArray(input.criteria) &&
      input.criteria.length === requirement.criteria.length,
    "Review must address every required criterion exactly once",
  );

  const criterionIds = input.criteria.map((item) => item.id);
  assert(
    new Set(criterionIds).size === criterionIds.length &&
      requirement.criteria.every((id) => criterionIds.includes(id)),
    "Review criteria do not match the requirement",
  );
  assert(
    input.criteria.every(
      (item) =>
        REVIEW_CONCLUSIONS.includes(item.conclusion) &&
        typeof item.evidence === "string" &&
        item.evidence.trim(),
    ),
    "Each review criterion needs a conclusion and evidence",
  );
  assert(Array.isArray(input.findings), "Review findings array required");
  input.findings.forEach(validateFinding);

  if (input.conclusion === "approved") {
    assert(
      input.criteria.every((item) => item.conclusion === "approved"),
      "Approved review requires every criterion approved",
    );
    assert(
      input.findings.every(
        (item) => item.status === "resolved" || item.status === "accepted-risk",
      ),
      "Approved review cannot contain open findings",
    );
  }
  return input;
}

function assertReportBinding(task, report) {
  assert(
    report?.taskId === task.id &&
      report.taskHash === taskHash(task) &&
      report.taskRevision === (task.revision ?? 1),
    "Report does not match task revision/hash",
  );
  assert(
    report.evidence?.status === "passed" &&
      typeof report.evidence.key === "string",
    "Passing implementation evidence required",
  );
}

/**
 * Loads every review recorded for a task, preserving deterministic file order.
 *
 * @param {string} stateDir - Coordinator `.orca` state directory.
 * @param {object} task - Task whose review history is requested.
 * @returns {object[]} Matching review records.
 */
export function loadReviews(stateDir, task) {
  return readJsonDirectory(path.join(stateDir, "reviews")).filter(
    (review) => review.taskId === task.id,
  );
}

function matchingApprovedReview(requirement, task, report, reviews) {
  // The newest verdict supersedes earlier approval, including an inconclusive
  // verdict without findings. Never search backwards for any passing verdict.
  const candidates = reviews
    .filter(
      (review) =>
        review.requirementId === requirement.id &&
        review.taskHash === taskHash(task) &&
        review.evidenceKey === report.evidence.key &&
        review.implementationExecutionId === report.runId,
    )
    .sort(
      (left, right) =>
        (right.sequence ?? 0) - (left.sequence ?? 0) ||
        String(right.createdAt).localeCompare(String(left.createdAt)),
    );
  const latest = candidates[0];
  if (!latest) return undefined;
  return [latest].find((review) => {
    try {
      validateReviewInput(review, task);
      return (
        review.requirementId === requirement.id &&
        review.taskHash === taskHash(task) &&
        review.evidenceKey === report.evidence.key &&
        review.conclusion === "approved"
      );
    } catch {
      // Invalid or stale historical reviews remain evidence but cannot pass a gate.
      return false;
    }
  });
}

function reviewGate(task, report, reviews) {
  const findingsById = new Map();
  const ordered = [...reviews].sort(
    (left, right) =>
      (left.sequence ?? 0) - (right.sequence ?? 0) ||
      String(left.createdAt).localeCompare(String(right.createdAt)),
  );
  for (const review of ordered) {
    for (const finding of review.findings ?? []) {
      findingsById.set(finding.id, finding);
    }
  }
  const openFindings = [...findingsById.values()]
    .filter((finding) => finding.status === "open")
    .map((finding) => finding.id);

  const reviewIds = [];
  const missing = task.reviewRequirements
    .filter((requirement) => {
      const review = matchingApprovedReview(requirement, task, report, reviews);
      if (review) reviewIds.push(review.id);
      return !review;
    })
    .map((requirement) => requirement.id);
  const status =
    task.reviewRequirements.length === 0
      ? "not-required"
      : missing.length > 0 || openFindings.length > 0
        ? "pending"
        : "passed";
  return { status, missing, openFindings, reviewIds };
}

function matchingDecision(stateDir, task, report, reviewIds) {
  const expectedReviews = JSON.stringify([...reviewIds].sort());
  return readJsonDirectory(path.join(stateDir, "decisions")).find(
    (decision) =>
      decision.taskId === task.id &&
      decision.implementationExecutionId === report.runId &&
      decision.taskHash === taskHash(task) &&
      decision.evidenceKey === report.evidence.key &&
      decision.status === "accepted" &&
      JSON.stringify([...decision.reviewIds].sort()) === expectedReviews,
  );
}

function legacyGateStatus(task, report) {
  return {
    taskId: task.id,
    state: "passed",
    gates: {
      "checks-passed": {
        status: "passed",
        evidenceKey: report.evidence.key,
      },
      "review-complete": {
        status: report.issues?.length ? "pending" : "not-required",
        reason:
          report.issues?.join("; ") ||
          "task v1 has no structured review contract",
      },
      "outcome-accepted": {
        status: "not-required",
        reason: "task v1 compatibility path",
      },
    },
  };
}

/**
 * Recomputes task gates from current source, reviews, and acceptance decisions.
 *
 * @param {string} repo - Current task workspace.
 * @param {object} task - Trusted task contract.
 * @param {object} report - Implementation report bound to the task.
 * @param {string} stateDir - Coordinator `.orca` state directory.
 * @returns {Promise<object>} Current business state and gate details.
 * @throws {Error} When task/report/evidence bindings are stale or invalid.
 */
export async function gateCheck(repo, task, report, stateDir) {
  validateTask(task);
  assertReportBinding(task, report);
  await validateEvidence(repo, report.evidence, task.baseRef, task);
  if (task.schemaVersion === 1) return legacyGateStatus(task, report);

  const reviews = loadReviews(stateDir, task);
  const review = reviewGate(task, report, reviews);
  const reviewComplete = ["passed", "not-required"].includes(review.status);
  const decision = reviewComplete
    ? matchingDecision(stateDir, task, report, review.reviewIds)
    : undefined;
  const gates = {
    "contract-ready": { status: "passed", taskHash: taskHash(task) },
    "checks-passed": { status: "passed", evidenceKey: report.evidence.key },
    "review-complete": review,
    "outcome-accepted": {
      status: decision ? "passed" : "pending",
      decisionId: decision?.id ?? null,
    },
  };
  const state = decision
    ? "accepted"
    : review.status === "pending"
      ? "submitted"
      : "reviewed";
  return {
    taskId: task.id,
    runId: report.runId,
    evidenceKey: report.evidence.key,
    state,
    gates,
  };
}

/**
 * Records an immutable semantic review and persists the recomputed gate status.
 *
 * @param {string} repo - Reviewed implementation workspace.
 * @param {object} task - Trusted task v2 contract.
 * @param {object} report - Implementation report under review.
 * @param {object} input - Review input from a distinct execution identity.
 * @param {string} stateDir - Coordinator `.orca` state directory.
 * @returns {Promise<object>} Recorded review and resulting gate status.
 * @throws {Error} For duplicate IDs, self-review, or stale evidence.
 */
export async function recordReview(repo, task, report, input, stateDir) {
  return withAsyncFileLock(
    path.join(stateDir, "gates-write.lock"),
    () => recordReviewLocked(repo, task, report, input, stateDir),
    "Review/acceptance update in progress",
  );
}

async function recordReviewLocked(repo, task, report, input, stateDir) {
  validateReviewInput(input, task);
  assertReportBinding(task, report);
  assert(
    input.implementationExecutionId === report.runId,
    "Review targets a different implementation execution",
  );
  await validateEvidence(repo, report.evidence, task.baseRef, task);

  const target = reviewFile(stateDir, input.id);
  assert(!fs.existsSync(target), `Review already exists: ${input.id}`);
  const record = {
    ...input,
    sequence:
      loadReviews(stateDir, task).reduce(
        (max, review) => Math.max(max, review.sequence ?? 0),
        0,
      ) + 1,
    taskId: task.id,
    taskRevision: task.revision,
    taskHash: taskHash(task),
    evidenceKey: report.evidence.key,
    sourceFingerprint: report.evidence.fingerprint,
    createdAt: new Date().toISOString(),
  };
  writeJSON(target, record);
  const gateStatus = await gateCheck(repo, task, report, stateDir);
  writeJSON(gateFile(stateDir, task.id), gateStatus);
  return { review: record, gateStatus };
}

/**
 * Records PM acceptance after every required review gate is complete.
 *
 * @param {string} repo - Current implementation workspace.
 * @param {object} task - Trusted task v2 contract.
 * @param {object} report - Passing implementation report.
 * @param {object} input - PM identity, full criteria set, and decision basis.
 * @param {string} stateDir - Coordinator `.orca` state directory.
 * @returns {Promise<object>} Acceptance decision and accepted gate status.
 * @throws {Error} For incomplete reviews, criteria, duplicate IDs, or stale source.
 */
export async function acceptOutcome(repo, task, report, input, stateDir) {
  return withAsyncFileLock(
    path.join(stateDir, "gates-write.lock"),
    () => acceptOutcomeLocked(repo, task, report, input, stateDir),
    "Review/acceptance update in progress",
  );
}

async function acceptOutcomeLocked(repo, task, report, input, stateDir) {
  validateTask(task);
  assert(task.schemaVersion === 2, "Structured acceptance requires task v2");
  assert(
    input?.schemaVersion === 1 && ID_PATTERN.test(input.id),
    "Acceptance schemaVersion=1 and id required",
  );
  assert(
    input.decider?.kind === "pm" &&
      typeof input.decider.executionId === "string" &&
      input.decider.executionId.trim(),
    "PM decision identity required",
  );
  assert(
    Array.isArray(input.criteria) &&
      input.criteria.length === task.acceptance.length &&
      new Set(input.criteria).size === input.criteria.length &&
      task.acceptance.every((item) => input.criteria.includes(item.id)),
    "Acceptance must cover every task criterion",
  );
  assert(
    typeof input.basis === "string" && input.basis.trim(),
    "Acceptance basis required",
  );

  const current = await gateCheck(repo, task, report, stateDir);
  assert(
    ["passed", "not-required"].includes(
      current.gates["review-complete"].status,
    ),
    "Required reviews are incomplete",
  );
  const target = decisionFile(stateDir, input.id);
  assert(!fs.existsSync(target), `Decision already exists: ${input.id}`);
  const record = {
    ...input,
    implementationExecutionId: report.runId,
    status: "accepted",
    taskId: task.id,
    taskRevision: task.revision,
    taskHash: taskHash(task),
    evidenceKey: report.evidence.key,
    reviewIds: current.gates["review-complete"].reviewIds ?? [],
    createdAt: new Date().toISOString(),
  };
  writeJSON(target, record);
  const gateStatus = await gateCheck(repo, task, report, stateDir);
  writeJSON(gateFile(stateDir, task.id), gateStatus);
  return { decision: record, gateStatus };
}
