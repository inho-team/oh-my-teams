/** Structured semantic review and final outcome-acceptance gates. */
import fs from "node:fs";
import path from "node:path";
import {
  ROLES,
  assert,
  canonicalRole,
  readJsonDirectory,
  writeJSON,
  withAsyncFileLock,
} from "./core.mjs";
import { taskHash, validateTask } from "./contracts.mjs";
import { validateEvidence } from "./evidence.mjs";
import { hasUnresolvedObjections } from "./audit.mjs";
import { buildDocId, documentState } from "./documents.mjs";
import { resolveRegisteredKickoffFromState } from "./kickoff-registry.mjs";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
// RegExp#test turns a missing value into the string "undefined", which the
// pattern accepts, so a finding with no id at all passed the id check.
const isId = (value) => typeof value === "string" && ID_PATTERN.test(value);
const REVIEW_CONCLUSIONS = ["approved", "changes-requested", "inconclusive"];
const FINDING_STATUSES = ["open", "resolved", "accepted-risk"];

/**
 * Roles that may decide an accepted-risk finding. `schemas/review.schema.json`
 * lists the same values, and a test keeps the two from drifting apart.
 */
export const ACCEPTED_RISK_AUTHORITIES = Object.freeze([
  "pm",
  "user",
  "director",
]);
// Printed with every finding refusal, so the reviewer can fix its own record
// instead of another role rewriting the review into this shape.
const FINDING_FORMAT =
  "Each finding is {id: lowercase letters, digits and hyphens; status: open|resolved|accepted-risk; " +
  "description}; a resolved finding adds resolution, an accepted-risk finding adds authority (" +
  ACCEPTED_RISK_AUTHORITIES.join("|") +
  ") and reason. See examples/review.json and examples/review.changes-requested.json.";

const reviewFile = (stateDir, id) =>
  path.join(stateDir, "reviews", `${id}.json`);
const decisionFile = (stateDir, id) =>
  path.join(stateDir, "decisions", `${id}.json`);
const gateFile = (stateDir, taskId) =>
  path.join(stateDir, "gates", `${taskId}.json`);

// A task contract names the role that reviews it in a full ladder. An
// organization that omits that role folds the duty onto a more senior one, so a
// reviewer at or above the required rank satisfies the requirement while a more
// junior one still cannot. Reviewer independence is a separate check on
// execution identity, so this never weakens it.
function seniorEnoughToReview(reviewerRole, requiredRole) {
  if (requiredRole === "worker")
    return reviewerRole === "worker" || reviewerRole === "pm";
  const required = ROLES.indexOf(canonicalRole(requiredRole));
  const reviewer = ROLES.indexOf(canonicalRole(reviewerRole));
  return required >= 0 && reviewer >= 0 && reviewer <= required;
}

function validateFinding(finding, index) {
  const check = (condition, message) =>
    assert(condition, `${message}. ${FINDING_FORMAT}`);
  check(
    finding && isId(finding.id),
    `Finding id required (finding ${index + 1})`,
  );
  check(
    FINDING_STATUSES.includes(finding.status),
    `Invalid finding status: ${finding.id}`,
  );
  check(
    typeof finding.description === "string" && finding.description.trim(),
    `Finding description required: ${finding.id}`,
  );
  if (finding.status === "resolved") {
    check(
      typeof finding.resolution === "string" && finding.resolution.trim(),
      `Resolved finding needs evidence: ${finding.id}`,
    );
  }
  if (finding.status === "accepted-risk") {
    check(
      ACCEPTED_RISK_AUTHORITIES.includes(finding.authority) &&
        typeof finding.reason === "string" &&
        finding.reason.trim(),
      `Accepted risk needs PM/user/director authority and reason: ${finding.id}`,
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
    input?.schemaVersion === 1 && isId(input.id),
    "Review schemaVersion=1 and id required",
  );
  const requirement = reviewRequirement(task, input.requirementId);
  assert(
    input.reviewer?.kind === requirement.kind &&
      seniorEnoughToReview(input.reviewer.role, requirement.role) &&
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
  assert(
    Array.isArray(input.findings),
    `Review findings array required. ${FINDING_FORMAT}`,
  );
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

// requirePassed is false only for a review that concluded changes-requested or
// inconclusive: that verdict is itself evidence the checks did not pass, and
// demanding passing evidence for it would make a real rejection unrecordable.
function assertReportBinding(task, report, { requirePassed = true } = {}) {
  assert(
    report?.taskId === task.id &&
      report.taskHash === taskHash(task) &&
      report.taskRevision === (task.revision ?? 1),
    "Report does not match task revision/hash",
  );
  assert(
    typeof report.evidence?.key === "string" &&
      (requirePassed
        ? report.evidence.status === "passed"
        : ["passed", "failed"].includes(report.evidence.status)),
    requirePassed
      ? "Passing implementation evidence required"
      : "Implementation evidence required",
  );
}

/**
 * Loads every review recorded for a task, preserving deterministic file order.
 *
 * @param {string} stateDir - PM worktree `.omt` state directory.
 * @param {object} task - Task whose review history is requested.
 * @returns {object[]} Matching review records.
 */
export function loadReviews(stateDir, task) {
  return readJsonDirectory(path.join(stateDir, "reviews")).filter(
    (review) => review.taskId === task.id,
  );
}

// A review-ref/acceptance-ref document is owned by this kickoff/workflow only
// when documentState confirms it exists and both identity fields match the
// caller's own (design 3.7 item 5, contract B). A caller that omits
// kickoffHash gets none of this: matchingApprovedReview/matchingDecision then
// keep exactly their pre-document behavior, so a caller without documents is
// unaffected.
function ownedDocumentExists(
  stateDir,
  kickoffHash,
  workflowId,
  stageSlug,
  docType,
  localId,
) {
  const docId = buildDocId({
    kickoffHash,
    workflowId,
    stageSlug,
    docType,
    localId,
  });
  const state = documentState(stateDir, docId);
  return (
    state.exists &&
    state.kickoffId === kickoffHash &&
    state.workflowId === workflowId
  );
}

function matchingApprovedReview(
  requirement,
  task,
  report,
  reviews,
  stateDir,
  { kickoffHash, workflowId = null } = {},
) {
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
      const approved =
        review.requirementId === requirement.id &&
        review.taskHash === taskHash(task) &&
        review.evidenceKey === report.evidence.key &&
        review.conclusion === "approved";
      if (!approved || !kickoffHash) return approved;
      // The review-ref document is always created resolved from an already
      // approved review (design 3.7 item 5), so only existence and ownership
      // are checked here, never its state.
      return ownedDocumentExists(
        stateDir,
        kickoffHash,
        workflowId,
        "review",
        "review-ref",
        review.id,
      );
    } catch {
      // Invalid or stale historical reviews remain evidence but cannot pass a gate.
      return false;
    }
  });
}

function reviewGate(task, report, reviews, stateDir, options = {}) {
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
      const review = matchingApprovedReview(
        requirement,
        task,
        report,
        reviews,
        stateDir,
        options,
      );
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

function matchingDecision(
  stateDir,
  task,
  report,
  reviewIds,
  { kickoffHash, workflowId = null } = {},
) {
  const expectedReviews = JSON.stringify([...reviewIds].sort());
  const decision = readJsonDirectory(path.join(stateDir, "decisions")).find(
    (candidate) =>
      candidate.taskId === task.id &&
      candidate.implementationExecutionId === report.runId &&
      candidate.taskHash === taskHash(task) &&
      candidate.evidenceKey === report.evidence.key &&
      candidate.status === "accepted" &&
      JSON.stringify([...candidate.reviewIds].sort()) === expectedReviews,
  );
  if (!decision || !kickoffHash) return decision;
  // The acceptance-ref document is always created resolved from an already
  // accepted decision (design 3.7 item 5), so only existence and ownership
  // are checked here, never its state.
  return ownedDocumentExists(
    stateDir,
    kickoffHash,
    workflowId,
    "acceptance",
    "acceptance-ref",
    decision.id,
  )
    ? decision
    : undefined;
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
 * @param {string} stateDir - PM worktree `.omt` state directory.
 * @param {object} [options] - Gate strictness and document ownership.
 * @param {boolean} [options.requirePassed=true] - When `false`, a report whose
 *   evidence failed is still bound and inspected; `accept` never sets this.
 * @param {string} [options.kickoffHash] - Kickoff hash the caller already
 *   knows. When given, `review-complete`/`outcome-accepted` additionally
 *   require the matching `04. 검토`/`05. 수용` structured document to be
 *   committed and owned by this `kickoffHash`/`options.workflowId` (design
 *   3.7 item 5); a caller that omits it keeps the review/decision-only
 *   behavior it already had.
 * @param {?string} [options.workflowId] - Workflow id owning `task`, or
 *   `null`, read together with `options.kickoffHash`.
 * @returns {Promise<object>} Current business state and gate details.
 * @throws {Error} When task/report/evidence bindings are stale or invalid.
 */
export async function gateCheck(
  repo,
  task,
  report,
  stateDir,
  { requirePassed = true, kickoffHash, workflowId = null } = {},
) {
  validateTask(task);
  assertReportBinding(task, report, { requirePassed });
  await validateEvidence(repo, report.evidence, task.baseRef, task, {
    requirePassed,
  });
  if (task.schemaVersion === 1) return legacyGateStatus(task, report);

  const reviews = loadReviews(stateDir, task);
  const review = reviewGate(task, report, reviews, stateDir, {
    kickoffHash,
    workflowId,
  });
  const reviewComplete = ["passed", "not-required"].includes(review.status);
  const decision = reviewComplete
    ? matchingDecision(stateDir, task, report, review.reviewIds, {
        kickoffHash,
        workflowId,
      })
    : undefined;
  const gates = {
    "contract-ready": { status: "passed", taskHash: taskHash(task) },
    "checks-passed": {
      status: report.evidence.status === "passed" ? "passed" : "failed",
      evidenceKey: report.evidence.key,
    },
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
 * @param {string} stateDir - PM worktree `.omt` state directory.
 * @param {object} [options] - Document ownership forwarded to the recomputed gate.
 * @param {string} [options.kickoffHash] - See `gateCheck`'s `options.kickoffHash`.
 * @param {?string} [options.workflowId] - See `gateCheck`'s `options.workflowId`.
 * @returns {Promise<object>} Recorded review and resulting gate status.
 * @throws {Error} For duplicate IDs, self-review, or stale evidence.
 */
export async function recordReview(
  repo,
  task,
  report,
  input,
  stateDir,
  options = {},
) {
  return withAsyncFileLock(
    path.join(stateDir, "gates-write.lock"),
    () => recordReviewLocked(repo, task, report, input, stateDir, options),
    "Review/acceptance update in progress",
  );
}

async function recordReviewLocked(
  repo,
  task,
  report,
  input,
  stateDir,
  { kickoffHash, workflowId = null } = {},
) {
  validateReviewInput(input, task);
  // Only an approval needs passing evidence: a review that asks for changes,
  // or cannot reach a verdict, is honestly recorded against the failing run it
  // actually reviewed, not against a passing run that never happened.
  const requirePassed = input.conclusion === "approved";
  assertReportBinding(task, report, { requirePassed });
  assert(
    input.implementationExecutionId === report.runId,
    "Review targets a different implementation execution",
  );
  await validateEvidence(repo, report.evidence, task.baseRef, task, {
    requirePassed,
  });

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
  const gateStatus = await gateCheck(repo, task, report, stateDir, {
    requirePassed,
    kickoffHash,
    workflowId,
  });
  writeJSON(gateFile(stateDir, task.id), gateStatus);
  return { review: record, gateStatus };
}

/**
 * Records PM acceptance after every required review gate is complete.
 *
 * `stateDir` is resolved against the kickoff registry through
 * {@link module:kickoff-registry.resolveRegisteredKickoffFromState}, which
 * this never skips: an `orgFile`/`worktreeId` naming a different kickoff than
 * the one `stateDir` is actually registered under is refused, and omitting
 * them no longer bypasses the registered kickoff's own values. This closes a
 * caller that imports this public export directly and never passes them at
 * all, not only the CLI's own `--org`/`--worktree` flags. When the resolved
 * kickoff's organization also has an audit ledger, acceptance then refuses
 * while the kickoff's outcome audit checkpoint has an unresolved objection
 * (B.5: this check applies to every task's accept, not only the last one, and
 * does not require an audit acceptance to already exist — a kickoff with
 * tasks left can still accept its first one before outcome audit even
 * starts). A `stateDir` that resolves to no registered kickoff (a solo task,
 * or one this registry never saw) falls back to whatever `orgFile`/
 * `worktreeId` the caller passed, unchanged.
 *
 * @param {string} repo - Current implementation workspace.
 * @param {object} task - Trusted task v2 contract.
 * @param {object} report - Passing implementation report.
 * @param {object} input - PM identity, full criteria set, and decision basis.
 * @param {string} stateDir - PM worktree `.omt` state directory.
 * @param {object} [options] - Document ownership and ledger/audit context.
 * @param {string} [options.orgFile] - Organization JSON of the kickoff this task belongs to.
 * @param {string} [options.worktreeId] - PM worktree of that kickoff.
 * @param {string} [options.kickoffHash] - See `gateCheck`'s `options.kickoffHash`.
 * @param {?string} [options.workflowId] - See `gateCheck`'s `options.workflowId`.
 * @returns {Promise<object>} Acceptance decision and accepted gate status.
 * @throws {Error} For incomplete reviews, criteria, duplicate IDs, stale source,
 *   an orgFile/worktreeId that mismatches the resolved registration, or an
 *   unresolved outcome audit objection.
 */
export async function acceptOutcome(
  repo,
  task,
  report,
  input,
  stateDir,
  options = {},
) {
  return withAsyncFileLock(
    path.join(stateDir, "gates-write.lock"),
    () => acceptOutcomeLocked(repo, task, report, input, stateDir, options),
    "Review/acceptance update in progress",
  );
}

async function acceptOutcomeLocked(
  repo,
  task,
  report,
  input,
  stateDir,
  { orgFile, worktreeId, kickoffHash, workflowId = null } = {},
) {
  validateTask(task);
  assert(task.schemaVersion === 2, "Structured acceptance requires task v2");
  assert(
    input?.schemaVersion === 1 && isId(input.id),
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

  // A caller's own orgFile/worktreeId (or the absence of them) is never taken
  // on trust: stateDir itself is resolved against the kickoff registry, since
  // a caller cannot swap stateDir the way it could swap a `--repo` or omit a
  // `--org` to skip the objection check below (docs/plan B.5, the public
  // `acceptOutcome` export included, since nothing here reads from argv).
  const registered = await resolveRegisteredKickoffFromState(stateDir);
  let effectiveOrgFile = orgFile;
  let effectiveWorktreeId = worktreeId;
  let effectiveKickoffHash = kickoffHash;
  if (registered) {
    assert(
      orgFile === undefined ||
        path.resolve(orgFile) === path.resolve(registered.orgFile),
      "acceptOutcome orgFile does not match this state directory's registered kickoff",
    );
    assert(
      worktreeId === undefined || worktreeId === registered.worktreeId,
      "acceptOutcome worktreeId does not match this state directory's registered kickoff",
    );
    effectiveOrgFile = registered.orgFile;
    effectiveWorktreeId = registered.worktreeId;
    // A resolved kickoffHash is authoritative, not merely a default: a caller
    // may not substitute one of its own choosing once stateDir names a real
    // registered kickoff. A legacy entry that resolves no hash at all leaves
    // nothing to check the caller's value against, so it passes through
    // unchanged (the existing behaviour for a caller that never resolves one).
    if (registered.kickoffHash !== undefined) {
      assert(
        kickoffHash === undefined || kickoffHash === registered.kickoffHash,
        "acceptOutcome kickoffHash does not match this state directory's registered kickoff",
      );
      effectiveKickoffHash = registered.kickoffHash;
    }
  }

  const current = await gateCheck(repo, task, report, stateDir, {
    kickoffHash: effectiveKickoffHash,
    workflowId,
  });
  assert(
    ["passed", "not-required"].includes(
      current.gates["review-complete"].status,
    ),
    "Required reviews are incomplete",
  );
  if (effectiveOrgFile && effectiveWorktreeId) {
    assert(
      !hasUnresolvedObjections(
        effectiveOrgFile,
        effectiveWorktreeId,
        "outcome",
      ),
      "The outcome audit checkpoint has an unresolved objection; it must be " +
        "ruled persuaded (audit-ruling) before this task can be accepted",
    );
  }
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
  const gateStatus = await gateCheck(repo, task, report, stateDir, {
    kickoffHash: effectiveKickoffHash,
    workflowId,
  });
  writeJSON(gateFile(stateDir, task.id), gateStatus);
  return { decision: record, gateStatus };
}
