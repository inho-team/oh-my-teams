/** Workflow graph scheduling, execution receipts, settlement, and retry policy. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  FULL_DEPTH,
  ROLES,
  assert,
  definedRoles,
  depthRoles,
  foldRole,
  hash,
  readJSON,
  validateOrg,
  writeJSON,
} from "./core.mjs";
import { taskHash, validateTask } from "./contracts.mjs";
import { git } from "./evidence.mjs";
import { classifyFailure, validateFailureEvidence } from "./failures.mjs";
import { assertFailureSignal } from "./execution.mjs";
import { gateCheck } from "./gates.mjs";
import {
  WORKFLOW_ID_PATTERN,
  appendWorkflowEvent,
  readWorkflowSnapshot,
  saveWorkflowState,
  withWorkflowUpdate,
  workflowDirectory,
  workflowStateFile,
} from "./workflow-store.mjs";

const TERMINAL_OBSERVATIONS = ["settled", "failed"];
const occupiesSlot = (item) => ["reserved", "running"].includes(item.state);
// A gate can only advance a task that has already reported an outcome.
const GATEABLE_STATES = ["submitted", "review-pending", "reviewed", "accepted"];

/**
 * Validates a workflow request before task files or external state are read.
 *
 * @param {object} request - Workflow goal, repository, tasks, policy, and budget.
 * @returns {object} The same validated request.
 * @throws {Error} When identity, task assignment, limits, or budgets are invalid.
 */
export function validateWorkflowRequest(request) {
  assert(
    request?.schemaVersion === 1 && WORKFLOW_ID_PATTERN.test(request.id),
    "Workflow schemaVersion=1 and id required",
  );
  assert(
    typeof request.goal === "string" && request.goal.trim(),
    "Workflow goal required",
  );
  assert(
    typeof request.repo === "string" && request.repo.trim(),
    "Workflow repository required",
  );
  assert(
    Array.isArray(request.tasks) && request.tasks.length > 0,
    "Workflow tasks required",
  );
  assert(
    request.tasks.every(
      (item) =>
        item &&
        typeof item.file === "string" &&
        item.file.trim() &&
        ROLES.includes(item.role),
    ),
    "Each workflow task needs a file and role",
  );
  assert(
    request.depth === undefined ||
      (Number.isInteger(request.depth) &&
        request.depth >= 1 &&
        request.depth <= FULL_DEPTH),
    "Workflow depth must be 1..5 when given",
  );
  assert(
    Number.isInteger(request.policy?.maxRunning) &&
      request.policy.maxRunning >= 1,
    "Workflow maxRunning required",
  );
  assert(
    Number.isInteger(request.policy?.maxReviewPending) &&
      request.policy.maxReviewPending >= 1,
    "Workflow maxReviewPending required",
  );
  assert(
    Number.isInteger(request.budget?.maxAttempts) &&
      request.budget.maxAttempts >= 1,
    "Workflow maxAttempts required",
  );
  assert(
    Number.isInteger(request.budget?.maxCalls) && request.budget.maxCalls >= 1,
    "Workflow maxCalls required",
  );
  return request;
}

function validateGraph(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  assert(byId.size === tasks.length, "Duplicate workflow task id");
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      const upstream = byId.get(dependency.taskId);
      assert(
        upstream,
        `Missing dependency: ${task.id} -> ${dependency.taskId}`,
      );
      assert(
        upstream.revision === dependency.revision,
        `Dependency revision mismatch: ${task.id} -> ${dependency.taskId}`,
      );
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    assert(!visiting.has(id), "Workflow dependency cycle");
    visiting.add(id);
    for (const dependency of byId.get(id).dependencies) {
      visit(dependency.taskId);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
}

async function freezeTasks(request, baseDir, repo) {
  const sourceTasks = request.tasks.map((item) =>
    validateTask(readJSON(path.resolve(baseDir, item.file))),
  );
  const tasks = await Promise.all(
    sourceTasks.map(async (task) => ({
      ...task,
      baseRef: await git(repo, [
        "rev-parse",
        "--verify",
        `${task.baseRef}^{commit}`,
      ]),
    })),
  );
  assert(
    tasks.every((task) => task.schemaVersion === 2),
    "Workflow tasks require task v2",
  );
  validateGraph(tasks);
  return tasks;
}

// Kept only when the run does not use the requested role, so a report can say
// which role the work was written for and which one ran it. The invariant that
// an absent requestedRole means the role itself was requested is what lets a
// depth change fold the work again from the original request.
function assignRole(item, roles, requestedRole) {
  item.role = foldRole(roles, requestedRole);
  item.requestedRole = requestedRole === item.role ? undefined : requestedRole;
}

function createTaskState(task, requestedRole, roles) {
  const item = {
    revision: task.revision,
    taskHash: taskHash(task),
    state: "pending",
    attemptId: null,
    acceptedResult: null,
    calls: 0,
    attempts: [],
    rework: [],
  };
  assignRole(item, roles, requestedRole);
  return item;
}

function createInitialState(request, org, tasks) {
  const createdAt = new Date().toISOString();
  const roleByTask = Object.fromEntries(
    request.tasks.map((item, index) => [tasks[index].id, item.role]),
  );
  const depth = request.depth ?? FULL_DEPTH;
  const roles = depthRoles(definedRoles(org), depth);
  return {
    schemaVersion: 1,
    id: request.id,
    revision: 1,
    status: "ready",
    goal: request.goal,
    organizationRevision: org.revision,
    organizationHash: hash(org),
    // The roles this run uses, selected by its depth from the organization's
    // ladder. Routing, dispatch and bound work fold onto these rather than onto
    // the organization file, so neither a depth change nor a later edit of the
    // organization can hand work to a role this run is not using.
    depth,
    roles,
    depthHistory: [],
    budget: {
      ...request.budget,
      attemptsUsed: 0,
      callsUsed: 0,
    },
    policy: request.policy,
    tasks: Object.fromEntries(
      tasks.map((task) => [
        task.id,
        createTaskState(task, roleByTask[task.id], roles),
      ]),
    ),
    eventIds: [],
    createdAt,
    updatedAt: createdAt,
  };
}

/**
 * Creates an immutable workflow snapshot and append-only creation event.
 *
 * @param {string} stateDir - PM worktree `.omt` state directory.
 * @param {object} request - Valid workflow request.
 * @param {object} org - Organization snapshot.
 * @param {string} [baseDir=process.cwd()] - Base for repo/task relative paths.
 * @returns {Promise<object>} Initial materialized workflow state.
 * @throws {Error} For invalid graphs, task revisions, bases, or duplicate workflow.
 */
export async function createWorkflow(
  stateDir,
  request,
  org,
  baseDir = process.cwd(),
) {
  validateWorkflowRequest(request);
  validateOrg(org);
  const repo = fs.realpathSync(path.resolve(baseDir, request.repo));
  const tasks = await freezeTasks(request, baseDir, repo);
  let integrationTask = null;
  if (request.integrationTask) {
    integrationTask = validateTask(
      readJSON(path.resolve(baseDir, request.integrationTask)),
    );
    assert(
      integrationTask.schemaVersion === 2 &&
        !tasks.some((task) => task.id === integrationTask.id),
      "Integration task must be a distinct v2 contract",
    );
    integrationTask = {
      ...integrationTask,
      baseRef: await git(repo, [
        "rev-parse",
        "--verify",
        `${integrationTask.baseRef}^{commit}`,
      ]),
    };
  }
  const directory = workflowDirectory(stateDir, request.id);

  return withWorkflowUpdate(stateDir, request.id, () => {
    assert(
      !fs.existsSync(workflowStateFile(stateDir, request.id)),
      `Workflow already exists: ${request.id}`,
    );
    writeJSON(path.join(directory, "request.json"), { ...request, repo });
    writeJSON(path.join(directory, "organization.json"), org);
    for (const task of tasks) {
      writeJSON(
        path.join(
          directory,
          "tasks",
          task.id,
          "revisions",
          `${task.revision}.json`,
        ),
        task,
      );
    }

    const state = createInitialState(request, org, tasks);
    state.integration = {
      required: tasks.length > 1 || Boolean(integrationTask),
      taskHash: integrationTask ? taskHash(integrationTask) : null,
      decision: null,
    };
    if (integrationTask)
      writeJSON(path.join(directory, "integration-task.json"), integrationTask);
    appendWorkflowEvent(directory, state, {
      id: `created-${crypto.randomUUID()}`,
      type: "workflow-created",
      workflowId: request.id,
    });
    saveWorkflowState(stateDir, request.id, state);
    return state;
  });
}

/**
 * Reads workflow state, frozen tasks, and organization without mutation.
 *
 * @param {string} stateDir - PM worktree `.omt` state directory.
 * @param {string} id - Workflow ID.
 * @returns {object} Complete durable workflow snapshot.
 * @throws {Error} When the workflow or a referenced revision is unavailable.
 */
export function readWorkflow(stateDir, id) {
  return readWorkflowSnapshot(stateDir, id);
}

function dependenciesReady(task, state) {
  return task.dependencies.every((dependency) => {
    const upstream = state.tasks[dependency.taskId];
    return (
      upstream?.state === "accepted" &&
      upstream.revision === dependency.revision &&
      upstream.acceptedResult === dependency.acceptedResult
    );
  });
}

function tasksConflict(left, right) {
  const leftOwnership = new Set([
    ...left.files,
    ...left.contractRefs.map((reference) => reference.path),
  ]);
  return [
    ...right.files,
    ...right.contractRefs.map((reference) => reference.path),
  ].some((ownedPath) => leftOwnership.has(ownedPath));
}

function recordFailure(state, item, failureInput) {
  const evidence = validateFailureEvidence(failureInput);
  const route = classifyFailure(evidence);
  // classifyFailure names the role that owns this failure in a full ladder. A
  // reduced organization may not declare it, and an owner nobody holds would
  // leave the failure unresolvable, so the decision is folded onto a declared
  // role while the original name stays readable in the record.
  const owner = foldRole(state.roles ?? ROLES, route.nextOwner);
  const failure = {
    ...evidence,
    route:
      owner === route.nextOwner
        ? route
        : { ...route, nextOwner: owner, routedOwner: route.nextOwner },
    attemptId: item.attemptId,
  };
  item.failure = failure;
  return failure;
}

function consumeCalls(state, item, callsUsed, errorMessage) {
  const attempt = item.attempts.find(
    (candidate) => candidate.id === item.attemptId,
  );
  assert(
    attempt && Number.isInteger(attempt.callAllowance),
    "Attempt has no recorded call allowance; reconcile legacy execution explicitly",
  );
  // A reworked attempt already settled calls for its earlier executions; this
  // settlement reports only the latest one, and the allowance covers them all.
  const total = (attempt.priorCallsUsed ?? 0) + callsUsed;
  assert(
    Number.isInteger(callsUsed) &&
      callsUsed >= 0 &&
      total >= (attempt.callsStarted ?? 0) &&
      total <= attempt.callAllowance &&
      state.budget.callsUsed + callsUsed <= state.budget.maxCalls,
    errorMessage,
  );
  state.budget.callsUsed += callsUsed;
  item.calls += callsUsed;
}

function availableCalls(state) {
  const reserved = Object.values(state.tasks).reduce((total, item) => {
    if (!occupiesSlot(item)) return total;
    const attempt = item.attempts.find(
      (candidate) => candidate.id === item.attemptId,
    );
    // Unknown legacy reservations consume the remaining pool until reconciled.
    // Calls a reworked attempt already settled are counted in callsUsed.
    if (!attempt?.callAllowance) return total + state.budget.maxCalls;
    return total + attempt.callAllowance - (attempt.priorCallsUsed ?? 0);
  }, 0);
  return Math.max(0, state.budget.maxCalls - state.budget.callsUsed - reserved);
}

function reconcileRunningTask(state, item, taskId, observed) {
  assert(
    observed.executionId === item.execution.executionId,
    `Observation execution mismatch: ${taskId}`,
  );
  if (observed.status === "running") return null;
  assert(
    TERMINAL_OBSERVATIONS.includes(observed.status),
    `Unknown observed status: ${observed.status}`,
  );
  assert(
    typeof observed.eventId === "string" &&
      WORKFLOW_ID_PATTERN.test(observed.eventId),
    `Observation event id required: ${taskId}`,
  );
  consumeCalls(
    state,
    item,
    observed.callsUsed,
    "Workflow call budget exceeded during reconciliation",
  );

  const attempt = item.attempts.find(
    (candidate) => candidate.id === item.attemptId,
  );
  assert(attempt, `Missing attempt record: ${item.attemptId}`);
  attempt.status = observed.status;
  attempt.callsUsed = observed.callsUsed;
  attempt.settledAt = new Date().toISOString();
  if (observed.status === "failed") {
    item.state = "failed";
    attempt.failure = recordFailure(state, item, observed.failure);
  } else {
    item.state = "submitted";
  }
  return {
    id: observed.eventId,
    type: "execution-observed",
    taskId,
    attemptId: item.attemptId,
    status: observed.status,
  };
}

function applyGateState(stateDir, taskId, item) {
  const file = path.join(stateDir, "gates", `${taskId}.json`);
  if (!fs.existsSync(file)) return;
  const gate = readJSON(file);
  if (gate.gates?.["contract-ready"]?.taskHash !== item.taskHash) return;
  // A gate is tied to the concrete execution that produced its evidence. Do
  // not let a pending task (or a gate from another workflow/attempt) advance.
  if (gate.runId !== (item.workerRunId ?? item.execution?.executionId)) return;
  // Only a task that has already reported can be advanced by a gate. The two
  // branches below repeated this same guard, so neither could ever be false.
  if (!GATEABLE_STATES.includes(item.state)) return;

  if (gate.state === "accepted") {
    const decisionId = gate.gates?.["outcome-accepted"]?.decisionId;
    if (typeof decisionId !== "string" || !decisionId.trim()) return;
    item.state = "accepted";
    item.acceptedResult = decisionId;
  } else if (gate.gates?.["review-complete"]?.status === "pending") {
    item.state = "review-pending";
    item.acceptedResult = null;
  } else if (gate.state === "reviewed") {
    item.state = "reviewed";
    item.acceptedResult = null;
  }
}

function dispatchCapacity(state) {
  const taskStates = Object.values(state.tasks);
  const running = taskStates.filter(occupiesSlot).length;
  const reviewPending = taskStates.filter((item) =>
    ["review-pending", "reviewed"].includes(item.state),
  ).length;
  return Math.max(
    0,
    Math.min(
      state.policy.maxRunning - running,
      state.policy.maxReviewPending - reviewPending,
    ),
  );
}

function roleRunningCount(state, role) {
  return Object.values(state.tasks).filter(
    (item) => occupiesSlot(item) && item.role === role,
  ).length;
}

function dispatchActions(state, tasks, organization) {
  if (
    availableCalls(state) === 0 ||
    state.budget.attemptsUsed >= state.budget.maxAttempts
  )
    return [];
  const capacity = dispatchCapacity(state);
  const selected = [];
  const actions = [];
  for (const [taskId, item] of Object.entries(state.tasks)) {
    if (
      selected.length >= capacity ||
      item.state !== "pending" ||
      !dependenciesReady(tasks[taskId], state)
    ) {
      continue;
    }
    const selectedForRole = selected.filter(
      (id) => state.tasks[id].role === item.role,
    ).length;
    if (
      roleRunningCount(state, item.role) + selectedForRole >=
      organization.roles[item.role].concurrency
    ) {
      continue;
    }
    if (activeTaskConflicts(state, tasks, taskId)) continue;
    if (selected.some((id) => tasksConflict(tasks[taskId], tasks[id])))
      continue;

    selected.push(taskId);
    actions.push({
      type: "dispatch-ready",
      taskId,
      taskRevision: item.revision,
      taskHash: item.taskHash,
    });
  }
  return actions;
}

function activeTaskConflicts(state, tasks, taskId) {
  return Object.entries(state.tasks).some(
    ([otherId, other]) =>
      otherId !== taskId &&
      occupiesSlot(other) &&
      tasksConflict(tasks[taskId], tasks[otherId]),
  );
}

function deriveWorkflowStatus(state) {
  const items = Object.values(state.tasks);
  if (items.every((item) => item.state === "accepted")) {
    return state.integration?.required || items.length > 1
      ? "integration-pending"
      : "accepted";
  }
  if (items.some((item) => item.state === "failed")) return "blocked";
  // A reserved attempt holds a slot and its budget, so work is in flight even
  // before a worker attaches.
  if (items.some(occupiesSlot)) return "running";
  return "ready";
}

// A workflow created without integration (one task and no integrationTask)
// is closed by its task's own review and PM acceptance. workflow-accept used to
// demand the integration file regardless, so such a workflow could not close.
function acceptWithoutIntegration(stateDir, id, expectedRevision) {
  return withWorkflowUpdate(stateDir, id, () => {
    const { state, dir } = readWorkflow(stateDir, id);
    assert(
      state.revision === expectedRevision,
      "Workflow changed; read state again",
    );
    const pending = Object.entries(state.tasks)
      .filter(([, item]) => item.state !== "accepted")
      .map(([taskId, item]) => `${taskId} (${item.state})`);
    assert(
      pending.length === 0,
      `All component tasks must be accepted first: ${pending.join(", ")}. ` +
        "This workflow has no integration task, so each task's review and PM acceptance close it",
    );
    if (state.integration.decision) return state;
    state.integration.decision = {
      runId: null,
      evidenceKey: null,
      decisionId: null,
      componentResults: Object.fromEntries(
        Object.entries(state.tasks).map(([taskId, item]) => [
          taskId,
          {
            revision: item.revision,
            attemptId: item.attemptId,
            acceptedResult: item.acceptedResult,
          },
        ]),
      ),
    };
    state.status = "accepted";
    appendWorkflowEvent(dir, state, {
      id: `accepted-${crypto.randomUUID()}`,
      type: "workflow-accepted-without-integration",
      decision: state.integration.decision,
    });
    state.revision += 1;
    saveWorkflowState(stateDir, id, state);
    return state;
  });
}

/**
 * Accepts a workflow, against its frozen integration contract when it has one.
 *
 * A workflow whose integration is not required closes once every task is
 * accepted, and needs no checkout or integration report.
 *
 * @param {string} stateDir - PM worktree store.
 * @param {string} id - Workflow identifier.
 * @param {number} expectedRevision - Revision observed before verification.
 * @param {string} [repo] - Final integration checkout, when integration is required.
 * @param {object} [report] - Report for the frozen integration task, when required.
 * @returns {Promise<object>} Accepted workflow bound to integration and task results.
 * @throws {Error} On missing contract, stale evidence, incomplete review or changed state.
 */
export async function acceptWorkflowIntegration(
  stateDir,
  id,
  expectedRevision,
  repo,
  report,
) {
  const snapshot = readWorkflow(stateDir, id);
  assert(
    snapshot.state.revision === expectedRevision,
    "Workflow changed; read state again",
  );
  if (!snapshot.state.integration?.required) {
    return acceptWithoutIntegration(stateDir, id, expectedRevision);
  }
  assert(
    repo && report,
    "This workflow requires integration; pass the integration checkout and report",
  );
  const file = path.join(snapshot.dir, "integration-task.json");
  assert(
    fs.existsSync(file),
    "Frozen integration task required; create workflow with integrationTask",
  );
  const task = validateTask(readJSON(file));
  assert(
    snapshot.state.integration?.taskHash === taskHash(task),
    "Integration contract changed",
  );
  assert(
    Object.values(snapshot.state.tasks).every(
      (item) => item.state === "accepted",
    ),
    "All component tasks must be accepted first",
  );
  const gates = await gateCheck(repo, task, report, stateDir);
  assert(
    gates.state === "accepted",
    "Integration checks, review and PM acceptance required",
  );
  return withWorkflowUpdate(stateDir, id, () => {
    const { state, dir } = readWorkflow(stateDir, id);
    assert(
      state.revision === expectedRevision,
      "Workflow changed during integration verification",
    );
    state.integration.decision = {
      runId: report.runId,
      evidenceKey: report.evidence.key,
      decisionId: gates.gates["outcome-accepted"].decisionId,
      componentResults: Object.fromEntries(
        Object.entries(state.tasks).map(([taskId, item]) => [
          taskId,
          {
            revision: item.revision,
            attemptId: item.attemptId,
            acceptedResult: item.acceptedResult,
          },
        ]),
      ),
    };
    state.status = "accepted";
    appendWorkflowEvent(dir, state, {
      id: `integration-${crypto.randomUUID()}`,
      type: "integration-accepted",
      decision: state.integration.decision,
    });
    state.revision += 1;
    saveWorkflowState(stateDir, id, state);
    return state;
  });
}

/**
 * Reconciles running attempts, applies gate state, and returns safe dispatch work.
 *
 * A running attempt without an authoritative observation yields
 * `reconcile-required`; it is never silently restarted.
 *
 * @param {string} stateDir - PM worktree `.omt` state directory.
 * @param {string} id - Workflow ID.
 * @param {number} expectedRevision - Optimistic state revision.
 * @param {object} [observations={}] - External states keyed by attempt ID.
 * @returns {{state: object, actions: object[]}} New state and PM actions.
 * @throws {Error} For stale revisions, mismatched receipts, or exceeded budgets.
 */
export function resumeWorkflow(
  stateDir,
  id,
  expectedRevision,
  observations = {},
) {
  return withWorkflowUpdate(stateDir, id, () => {
    const { state, tasks, organization, dir } = readWorkflow(stateDir, id);
    assert(
      state.revision === expectedRevision,
      "Workflow changed; read state again",
    );
    const actions = [];
    const observedEvents = [];

    for (const [taskId, item] of Object.entries(state.tasks)) {
      if (item.state === "reserved") {
        actions.push({
          type: "launch-reconcile-required",
          taskId,
          attemptId: item.attemptId,
        });
        continue;
      }
      if (item.state === "running") {
        const observed = observations[item.attemptId];
        if (!observed) {
          actions.push({
            type: "reconcile-required",
            taskId,
            attemptId: item.attemptId,
            execution: item.execution,
          });
          continue;
        }
        const event = reconcileRunningTask(state, item, taskId, observed);
        if (event) observedEvents.push(event);
        if (observed.status === "running") continue;
      }
      applyGateState(stateDir, taskId, item);
    }

    for (const event of observedEvents) appendWorkflowEvent(dir, state, event);
    actions.push(...dispatchActions(state, tasks, organization));
    state.status = deriveWorkflowStatus(state);
    state.revision += 1;
    saveWorkflowState(stateDir, id, state);
    return { state, actions };
  });
}

function validateExecutionInput(input, reserveOnly = false) {
  assert(
    input?.schemaVersion === 1 &&
      WORKFLOW_ID_PATTERN.test(input.eventId) &&
      WORKFLOW_ID_PATTERN.test(input.attemptId),
    "Execution event/attempt id required",
  );
  if (reserveOnly) return;
  assert(
    input.receipt?.executionId &&
      input.receipt?.runId &&
      input.receipt?.taskId &&
      input.receipt?.dispatchId &&
      input.receipt?.worktreeId,
    "Actual run/task/dispatch/execution/worktree receipt ids required",
  );
}

/**
 * Attaches an actual Orca execution receipt to one ready workflow task.
 *
 * @param {string} stateDir - PM worktree `.omt` state directory.
 * @param {string} id - Workflow ID.
 * @param {number} expectedRevision - Optimistic state revision.
 * @param {object} input - Event, attempt, task, and Orca receipt.
 * @returns {object} Updated state, or an idempotent duplicate response.
 * @throws {Error} For stale state, unmet dependencies, duplicates, or no capacity.
 */
export function attachExecution(stateDir, id, expectedRevision, input) {
  return beginExecution(stateDir, id, expectedRevision, input, false);
}

/**
 * Reserves capacity and calls before launching an external worker.
 * @param {string} stateDir - Shared PM worktree store.
 * @param {string} id - Workflow identifier.
 * @param {number} expectedRevision - Expected state revision.
 * @param {object} input - Stable event/attempt/task identity and callAllowance.
 * @returns {object} Persisted reservation with no fabricated external IDs.
 * @throws {Error} When capacity, dependencies, or budget prevent launch.
 */
export function reserveExecution(stateDir, id, expectedRevision, input) {
  return beginExecution(stateDir, id, expectedRevision, input, true);
}

function beginExecution(stateDir, id, expectedRevision, input, reserveOnly) {
  return withWorkflowUpdate(stateDir, id, () => {
    const { state, tasks, organization, dir } = readWorkflow(stateDir, id);
    validateExecutionInput(input, reserveOnly);
    if (state.eventIds.includes(input.eventId))
      return { state, duplicate: true };
    assert(
      state.revision === expectedRevision,
      "Workflow changed; read state again",
    );

    const item = state.tasks[input.taskId];
    if (!reserveOnly && item?.state === "reserved") {
      assert(
        item.attemptId === input.attemptId,
        "Receipt does not match reserved attempt",
      );
      const attempt = item.attempts.find(
        (entry) => entry.id === input.attemptId,
      );
      assert(
        input.callAllowance === undefined ||
          input.callAllowance === attempt.callAllowance,
        "Cannot change reserved allowance",
      );
      assert(
        !Object.entries(state.tasks).some(
          ([taskId, other]) =>
            taskId !== input.taskId &&
            other.execution?.executionId === input.receipt.executionId,
        ),
        "Duplicate execution receipt",
      );
      item.execution = input.receipt;
      item.state = "running";
      attempt.receipt = input.receipt;
      attempt.status = "running";
      appendWorkflowEvent(dir, state, {
        id: input.eventId,
        type: "reserved-execution-attached",
        taskId: input.taskId,
        attemptId: input.attemptId,
        receipt: input.receipt,
      });
      state.revision += 1;
      state.status = deriveWorkflowStatus(state);
      saveWorkflowState(stateDir, id, state);
      return state;
    }
    assert(
      item &&
        item.state === "pending" &&
        dependenciesReady(tasks[input.taskId], state),
      "Task is not ready for execution",
    );
    // Comparing only the current attemptId let a retired id come back: retry
    // clears `attemptId` but keeps the attempt in `attempts`, so a second
    // record with the same id was appended and every later lookup found the
    // older one by `Array.find`, spending the settled attempt's allowance and
    // overwriting its outcome. The whole history has to be consulted.
    assert(
      !Object.values(state.tasks).some(
        (other) =>
          other.attempts.some((entry) => entry.id === input.attemptId) ||
          (input.receipt &&
            other.execution?.executionId === input.receipt.executionId),
      ),
      "Duplicate attempt or execution receipt",
    );
    assert(
      state.budget.attemptsUsed < state.budget.maxAttempts,
      "Workflow attempt budget exhausted",
    );
    assert(
      Object.values(state.tasks).filter(occupiesSlot).length <
        state.policy.maxRunning,
      "Workflow running capacity exhausted",
    );
    assert(
      state.policy.maxReviewPending -
        Object.values(state.tasks).filter((other) =>
          ["review-pending", "reviewed"].includes(other.state),
        ).length >
        0,
      "Workflow review backlog capacity exhausted",
    );
    assert(
      !activeTaskConflicts(state, tasks, input.taskId),
      "Task conflicts with an active workflow task",
    );
    assert(
      roleRunningCount(state, item.role) <
        organization.roles[item.role].concurrency,
      `No ${item.role} concurrency slot available`,
    );
    const callAllowance =
      input.callAllowance ??
      Math.min(organization.policy.maxCalls, availableCalls(state));
    assert(
      Number.isInteger(callAllowance) &&
        callAllowance > 0 &&
        callAllowance <= availableCalls(state),
      "Workflow unreserved call budget exhausted",
    );

    item.state = reserveOnly ? "reserved" : "running";
    item.workerRunId = null;
    item.attemptId = input.attemptId;
    item.execution = reserveOnly ? null : input.receipt;
    item.attempts.push({
      id: input.attemptId,
      status: item.state,
      callAllowance,
      receipt: item.execution,
      attachedAt: new Date().toISOString(),
    });
    state.budget.attemptsUsed += 1;
    appendWorkflowEvent(dir, state, {
      id: input.eventId,
      type: reserveOnly ? "execution-reserved" : "execution-attached",
      callAllowance,
      taskId: input.taskId,
      attemptId: input.attemptId,
      receipt: input.receipt,
    });
    state.revision += 1;
    state.status = deriveWorkflowStatus(state);
    saveWorkflowState(stateDir, id, state);
    return state;
  });
}

/**
 * Durably consumes one attempt call before entering the provider process.
 * A crash after this write still consumes the call: uncertain work is never free.
 * @param {string} stateDir - Shared workflow store.
 * @param {string} id - Workflow identifier.
 * @param {object} input - Task/attempt hashes, role, organization and worker identity.
 * @returns {object} Persisted consumed count and remaining allowance.
 * @throws {Error} On stale bindings, duplicate workers, or exhausted allowance.
 */
export function claimWorkflowCall(stateDir, id, input) {
  return withWorkflowUpdate(stateDir, id, () => {
    const { state, dir } = readWorkflow(stateDir, id);
    const item = state.tasks[input.taskId];
    assert(
      item?.state === "running" && item.attemptId === input.attemptId,
      "Workflow attempt is not running",
    );
    assert(
      item.taskHash === input.taskHash &&
        item.role === input.role &&
        state.organizationHash === input.organizationHash,
      "Worker does not match frozen workflow inputs",
    );
    assert(
      typeof input.workerRunId === "string" && input.workerRunId,
      "Worker run identity required",
    );
    assert(
      !item.workerRunId || item.workerRunId === input.workerRunId,
      "Workflow attempt already has a worker; reconcile before restarting",
    );
    const attempt = item.attempts.find((entry) => entry.id === input.attemptId);
    assert(
      Number.isInteger(attempt?.callAllowance) &&
        (attempt.callsStarted ?? 0) < attempt.callAllowance,
      "Workflow call allowance exhausted",
    );
    item.workerRunId = input.workerRunId;
    attempt.callsStarted = (attempt.callsStarted ?? 0) + 1;
    appendWorkflowEvent(dir, state, {
      id: `call-${crypto.randomUUID()}`,
      type: "provider-call-claimed",
      taskId: input.taskId,
      attemptId: input.attemptId,
      workerRunId: input.workerRunId,
      ordinal: attempt.callsStarted,
    });
    state.revision += 1;
    saveWorkflowState(stateDir, id, state);
    return {
      callsStarted: attempt.callsStarted,
      remaining: attempt.callAllowance - attempt.callsStarted,
    };
  });
}

function validateSettlementInput(input) {
  assert(
    input?.schemaVersion === 1 && WORKFLOW_ID_PATTERN.test(input.eventId),
    "Settlement event id required",
  );
  assert(
    ["settled", "failed"].includes(input.outcome),
    "Settlement outcome must be settled or failed",
  );
}

/**
 * Records an idempotent settlement without equating it to product acceptance.
 *
 * @param {string} stateDir - PM worktree `.omt` state directory.
 * @param {string} id - Workflow ID.
 * @param {number} expectedRevision - Optimistic state revision.
 * @param {object} input - Attempt outcome, usage, identity, and failure evidence.
 * @returns {object} Updated state with duplicate/stale flags when applicable.
 * @throws {Error} For mismatched execution, invalid usage, or stale state.
 */
export function recordSettlement(stateDir, id, expectedRevision, input) {
  return withWorkflowUpdate(stateDir, id, () => {
    const { state, dir } = readWorkflow(stateDir, id);
    validateSettlementInput(input);
    if (state.eventIds.includes(input.eventId))
      return { state, duplicate: true };
    assert(
      state.revision === expectedRevision,
      "Workflow changed; read state again",
    );

    const item = state.tasks[input.taskId];
    assert(item, "Unknown settlement task");
    if (item.attemptId !== input.attemptId) {
      appendWorkflowEvent(dir, state, {
        id: input.eventId,
        type: "stale-settlement-ignored",
        taskId: input.taskId,
        attemptId: input.attemptId,
      });
      state.revision += 1;
      saveWorkflowState(stateDir, id, state);
      return { state, stale: true };
    }

    assert(item.state === "running", "Current attempt is not running");
    assert(
      input.executionId === item.execution.executionId,
      "Settlement execution mismatch",
    );
    consumeCalls(state, item, input.callsUsed, "Workflow call budget exceeded");
    const attempt = item.attempts.find(
      (candidate) => candidate.id === input.attemptId,
    );
    assert(attempt, "Attempt history missing");
    attempt.status = input.outcome;
    attempt.callsUsed = input.callsUsed;
    attempt.settledAt = new Date().toISOString();

    item.state = input.outcome === "failed" ? "failed" : "submitted";
    if (input.outcome === "failed") {
      attempt.failure = recordFailure(state, item, input.failure);
    }
    appendWorkflowEvent(dir, state, {
      ...input,
      id: input.eventId,
      type: "execution-settled",
    });
    state.revision += 1;
    // A settled task never decides the whole workflow: another task may still
    // be failed or in flight, and a local "ready" would hide it.
    state.status = deriveWorkflowStatus(state);
    saveWorkflowState(stateDir, id, state);
    return { state, duplicate: false, stale: false };
  });
}

function validateRetryInput(input) {
  assert(
    input?.schemaVersion === 1 &&
      typeof input.eventId === "string" &&
      WORKFLOW_ID_PATTERN.test(input.eventId),
    "Retry event id required",
  );
}

/**
 * Releases a reservation whose external launch never produced a worker.
 *
 * A reservation holds a concurrency slot, one attempt of the budget, and its
 * reserved calls. When the launcher fails there was no way to give any of that
 * back: the task stayed `reserved`, every resume returned the same
 * `launch-reconcile-required` action, and one failed launch cost a slot and an
 * attempt for the life of the workflow. Releasing requires the same evidence a
 * retry does, and returns the reserved calls but not the spent attempt, so a
 * launch loop cannot become free.
 *
 * The one exception is a launch the runtime refused before handing any work
 * over. Nothing started, so there was no work to pay for, and with a small
 * attempt budget keeping it spent forced the workflow to be recreated. The
 * attempt is returned only when the release carries that `not-started` signal.
 *
 * @param {string} stateDir - PM worktree `.omt` state directory.
 * @param {string} id - Workflow identifier.
 * @param {number} expectedRevision - Revision the caller last read.
 * @param {object} input - Event id, task, attempt, resolution, and evidence,
 *   plus an optional `refusal` signal for a launch refused before it started.
 * @returns {object} Updated workflow state, or the unchanged state on replay.
 * @throws {Error} When the revision is stale, the task is not reserved, the
 * attempt does not match, the resolution evidence is missing, or a refusal is
 * not a `not-started` signal.
 */
export function releaseReservation(stateDir, id, expectedRevision, input) {
  return withWorkflowUpdate(stateDir, id, () => {
    const { state, dir } = readWorkflow(stateDir, id);
    assert(
      input?.schemaVersion === 1 &&
        WORKFLOW_ID_PATTERN.test(input.eventId ?? "") &&
        typeof input.taskId === "string" &&
        typeof input.attemptId === "string",
      "Release requires schemaVersion=1, eventId, taskId and attemptId",
    );
    if (state.eventIds.includes(input.eventId))
      return { state, duplicate: true };
    assert(
      state.revision === expectedRevision,
      "Workflow changed; read state again",
    );
    assert(
      typeof input.resolution === "string" &&
        input.resolution.trim() &&
        typeof input.evidence === "string" &&
        input.evidence.trim(),
      "Release requires a resolution and evidence",
    );

    const item = state.tasks[input.taskId];
    assert(item?.state === "reserved", "Task holds no reservation to release");
    assert(
      item.attemptId === input.attemptId,
      "Release does not match the reserved attempt",
    );

    const attempt = item.attempts.find((entry) => entry.id === input.attemptId);
    assert(attempt, "Reserved attempt is not recorded");
    const refused = input.refusal !== undefined;
    if (refused) {
      assertFailureSignal(input.refusal);
      assert(
        input.refusal.kind === "not-started",
        "Only a launch refused before any work started returns its attempt",
      );
      state.budget.attemptsUsed -= 1;
      attempt.refusal = input.refusal;
    }
    // Otherwise the attempt stays spent: an unobserved launch is not free work.
    attempt.status = refused ? "refused" : "released";
    attempt.releasedAt = new Date().toISOString();
    attempt.resolution = input.resolution;
    attempt.evidence = input.evidence;
    item.state = "pending";
    item.attemptId = null;
    item.execution = null;

    appendWorkflowEvent(dir, state, {
      id: input.eventId,
      type: "reservation-released",
      taskId: input.taskId,
      attemptId: input.attemptId,
      resolution: input.resolution,
      evidence: input.evidence,
      ...(refused ? { refusal: input.refusal, attemptReturned: true } : {}),
    });
    state.revision += 1;
    state.status = deriveWorkflowStatus(state);
    saveWorkflowState(stateDir, id, state);
    return { state, duplicate: false };
  });
}

function validateReworkInput(input) {
  validateExecutionInput(input);
  assert(
    typeof input.reviewId === "string" && input.reviewId.trim(),
    "Rework needs the review that asked for changes",
  );
}

/**
 * Hands a task back to its implementer after a required review asked for changes.
 *
 * A review that concluded `changes-requested` or `inconclusive`, or left a
 * finding open, is not a failure, so `workflow-retry` refused it; and the gate
 * a corrected execution produced was ignored, because the task stayed bound to
 * the execution first attached. This attaches the corrected execution to the
 * same attempt, within that attempt's remaining call allowance, and records the
 * review in `rework`. It spends no new attempt: the review, not a fault, sent
 * the work back. The corrected execution then settles, is reviewed and accepted
 * like the first, and its gate advances the task.
 *
 * @param {string} stateDir - PM worktree `.omt` state directory.
 * @param {string} id - Workflow ID.
 * @param {number} expectedRevision - Optimistic state revision.
 * @param {object} input - Event, task, current attempt, review ID, and the
 *   corrected execution's Orca receipt.
 * @returns {object} Updated workflow state, or an idempotent duplicate response.
 * @throws {Error} When the review did not ask for changes to this execution, the
 *   task is not waiting on review, or no call or capacity remains.
 */
export function reworkTask(stateDir, id, expectedRevision, input) {
  return withWorkflowUpdate(stateDir, id, () => {
    const { state, organization, dir } = readWorkflow(stateDir, id);
    validateReworkInput(input);
    if (state.eventIds.includes(input.eventId))
      return { state, duplicate: true };
    assert(
      state.revision === expectedRevision,
      "Workflow changed; read state again",
    );
    const item = state.tasks[input.taskId];
    assert(item, "Unknown rework task");
    assert(
      ["submitted", "review-pending", "reviewed"].includes(item.state),
      `Task ${input.taskId} is ${item.state}; only a reported task waiting on review is reworked`,
    );
    assert(
      item.attemptId === input.attemptId,
      "Rework must continue the task's current attempt",
    );
    const attempt = item.attempts.find(
      (candidate) => candidate.id === input.attemptId,
    );
    assert(attempt, "Attempt history missing");

    const reviewPath = path.join(stateDir, "reviews", `${input.reviewId}.json`);
    assert(fs.existsSync(reviewPath), `Review not recorded: ${input.reviewId}`);
    const review = readJSON(reviewPath);
    const executionId = item.workerRunId ?? item.execution?.executionId;
    assert(
      review.taskId === input.taskId &&
        review.taskHash === item.taskHash &&
        review.implementationExecutionId === executionId,
      `Review ${input.reviewId} did not review this task's current execution`,
    );
    const openFindings = (review.findings ?? [])
      .filter((finding) => finding.status === "open")
      .map((finding) => finding.id);
    assert(
      review.conclusion !== "approved" || openFindings.length > 0,
      `Review ${input.reviewId} approved the execution; there is nothing to rework`,
    );

    const executions = Object.values(state.tasks).flatMap((other) => [
      other.execution?.executionId,
      ...other.attempts.flatMap((entry) => [
        entry.receipt?.executionId,
        ...(entry.previousReceipts ?? []).map((prior) => prior.executionId),
      ]),
    ]);
    assert(
      !executions.includes(input.receipt.executionId),
      "Rework needs a new execution, not one already recorded",
    );
    const spent = (attempt.priorCallsUsed ?? 0) + (attempt.callsUsed ?? 0);
    assert(
      spent < attempt.callAllowance &&
        state.budget.callsUsed < state.budget.maxCalls,
      `Attempt ${input.attemptId} has used ${spent} of ${attempt.callAllowance} calls; ` +
        "no call remains for rework",
    );
    assert(
      Object.values(state.tasks).filter(occupiesSlot).length <
        state.policy.maxRunning,
      "Workflow running capacity exhausted",
    );
    assert(
      roleRunningCount(state, item.role) <
        organization.roles[item.role].concurrency,
      `No ${item.role} concurrency slot available`,
    );

    item.rework.push({
      fromAttempt: item.attemptId,
      category: "review-changes-requested",
      reviewId: input.reviewId,
      conclusion: review.conclusion,
      openFindings,
      fromExecution: executionId,
      toExecution: input.receipt.executionId,
      recordedAt: new Date().toISOString(),
    });
    attempt.previousReceipts = [
      ...(attempt.previousReceipts ?? []),
      attempt.receipt,
    ];
    attempt.priorCallsUsed = spent;
    attempt.callsUsed = undefined;
    attempt.receipt = input.receipt;
    attempt.status = "running";
    item.execution = input.receipt;
    item.workerRunId = null;
    item.acceptedResult = null;
    item.state = "running";
    appendWorkflowEvent(dir, state, {
      id: input.eventId,
      type: "review-rework-attached",
      taskId: input.taskId,
      attemptId: input.attemptId,
      reviewId: input.reviewId,
      receipt: input.receipt,
    });
    state.revision += 1;
    state.status = deriveWorkflowStatus(state);
    saveWorkflowState(stateDir, id, state);
    return state;
  });
}

/**
 * Requeues a routed, resolved failure without erasing attempt or budget history.
 *
 * @param {string} stateDir - PM worktree `.omt` state directory.
 * @param {string} id - Workflow ID.
 * @param {number} expectedRevision - Optimistic state revision.
 * @param {object} input - Resolution owner, evidence, and retry event.
 * @returns {object} Updated workflow state or idempotent duplicate response.
 * @throws {Error} When retry is unsafe, unresolved, stale, or over budget.
 */
export function retryTask(stateDir, id, expectedRevision, input) {
  return withWorkflowUpdate(stateDir, id, () => {
    const { state, dir } = readWorkflow(stateDir, id);
    validateRetryInput(input);
    if (state.eventIds.includes(input.eventId))
      return { state, duplicate: true };
    assert(
      state.revision === expectedRevision,
      "Workflow changed; read state again",
    );

    const item = state.tasks[input.taskId];
    assert(
      item?.state === "failed" && item.failure?.route,
      "Task has no routed failure to retry",
    );
    const route = item.failure.route;
    const processReconciled =
      route.category === "process-unknown" &&
      input.processExitConfirmed === true;
    assert(
      route.retryable || processReconciled,
      `Failure requires ${route.action} before a new attempt`,
    );
    assert(
      input.resolvedBy === route.nextOwner &&
        typeof input.resolution === "string" &&
        input.resolution.trim() &&
        typeof input.evidence === "string" &&
        input.evidence.trim(),
      "Retry requires the routed owner, resolution and evidence",
    );
    assert(
      state.budget.attemptsUsed < state.budget.maxAttempts &&
        state.budget.callsUsed < state.budget.maxCalls,
      "Workflow budget exhausted",
    );

    item.rework.push({
      fromAttempt: item.attemptId,
      category: route.category,
      resolvedBy: input.resolvedBy,
      resolution: input.resolution,
      evidence: input.evidence,
      recordedAt: new Date().toISOString(),
    });
    item.state = "pending";
    item.attemptId = null;
    item.execution = null;
    item.failure = null;
    // The depth may have changed since this task was dispatched; the retry runs
    // on whichever role the current depth gives its original request.
    assignRole(item, state.roles ?? ROLES, item.requestedRole ?? item.role);
    appendWorkflowEvent(dir, state, {
      id: input.eventId,
      type: "task-retry-ready",
      taskId: input.taskId,
      route,
      resolution: input.resolution,
      evidence: input.evidence,
    });
    state.revision += 1;
    state.status = deriveWorkflowStatus(state);
    saveWorkflowState(stateDir, id, state);
    return state;
  });
}

function validateDepthInput(input) {
  assert(
    input?.schemaVersion === 1 && WORKFLOW_ID_PATTERN.test(input.eventId ?? ""),
    "Depth change requires schemaVersion=1 and eventId",
  );
  assert(
    Number.isInteger(input.depth) &&
      input.depth >= 1 &&
      input.depth <= FULL_DEPTH,
    "Depth must be 1..5",
  );
  assert(
    typeof input.reason === "string" &&
      input.reason.trim() &&
      typeof input.evidence === "string" &&
      input.evidence.trim(),
    "Depth change requires a reason and evidence",
  );
}

/**
 * Changes how many roles a running workflow uses, and records why.
 *
 * Raising the depth is always safe: it only adds roles that pending work may
 * now fold onto. Lowering it removes roles, so it is refused while any of them
 * holds a reserved or running attempt; a worker whose exit is unconfirmed stays
 * `running` until settled, so an unobserved worker is never assumed gone.
 * Pending tasks fold again from the role they were written for; tasks that
 * already ran keep the role that ran them.
 *
 * @param {string} stateDir - PM worktree `.omt` state directory.
 * @param {string} id - Workflow identifier.
 * @param {number} expectedRevision - Revision the caller last read.
 * @param {object} input - Event id, target depth, reason and evidence.
 * @returns {object} Updated workflow state, or the unchanged state on replay.
 * @throws {Error} When the revision is stale, the depth is unchanged, or a
 *   removed role still holds reserved or running work.
 */
export function setWorkflowDepth(stateDir, id, expectedRevision, input) {
  return withWorkflowUpdate(stateDir, id, () => {
    const { state, dir } = readWorkflow(stateDir, id);
    validateDepthInput(input);
    if (state.eventIds.includes(input.eventId))
      return { state, duplicate: true };
    assert(
      state.revision === expectedRevision,
      "Workflow changed; read state again",
    );

    const org = readJSON(path.join(dir, "organization.json"));
    const from = state.depth ?? FULL_DEPTH;
    const previous = state.roles ?? definedRoles(org);
    const roles = depthRoles(definedRoles(org), input.depth);
    assert(
      input.depth !== from || roles.join() !== previous.join(),
      `Workflow already runs at depth ${from}`,
    );

    const removed = previous.filter((role) => !roles.includes(role));
    const busy = Object.entries(state.tasks).filter(
      ([, item]) => occupiesSlot(item) && removed.includes(item.role),
    );
    assert(
      busy.length === 0,
      `Cannot lower depth while ${busy
        .map(([taskId, item]) => `${taskId} (${item.role})`)
        .join(
          ", ",
        )} holds reserved or running work; settle or release it first`,
    );

    for (const item of Object.values(state.tasks)) {
      if (item.state === "pending")
        assignRole(item, roles, item.requestedRole ?? item.role);
    }
    const change = {
      from,
      to: input.depth,
      roles,
      reason: input.reason,
      evidence: input.evidence,
      recordedAt: new Date().toISOString(),
    };
    state.depth = input.depth;
    state.roles = roles;
    state.depthHistory = [...(state.depthHistory ?? []), change];
    appendWorkflowEvent(dir, state, {
      id: input.eventId,
      type: "depth-changed",
      ...change,
    });
    state.revision += 1;
    state.status = deriveWorkflowStatus(state);
    saveWorkflowState(stateDir, id, state);
    return { state, duplicate: false };
  });
}
