/** Durable workflow paths, snapshots, locks, and append-only event persistence. */
import path from "node:path";
import fs from "node:fs";
import { assert, readJSON, withFileLock, writeJSON } from "./core.mjs";

/** Identifier pattern shared by workflow, event, and attempt records. */
export const WORKFLOW_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const pendingEvents = new WeakMap();

function recoverTransaction(directory) {
  const file = path.join(directory, "transaction.json");
  if (!fs.existsSync(file)) return;
  const transaction = readJSON(file);
  for (const { name, event } of transaction.events) {
    const target = path.join(directory, "events", name);
    if (fs.existsSync(target)) {
      assert(
        JSON.stringify(readJSON(target)) === JSON.stringify(event),
        "Conflicting workflow event during recovery",
      );
    } else writeJSON(target, event);
  }
  writeJSON(path.join(directory, "state.json"), transaction.state);
  fs.unlinkSync(file);
}

/**
 * Resolves a workflow's durable state directory.
 *
 * @param {string} stateDir - Coordinator `.orca` state directory.
 * @param {string} id - Valid workflow ID.
 * @returns {string} Workflow directory path.
 */
export function workflowDirectory(stateDir, id) {
  assert(
    typeof id === "string" && WORKFLOW_ID_PATTERN.test(id),
    "Workflow id required",
  );
  return path.join(stateDir, "workflows", id);
}

/**
 * Resolves a workflow's materialized state file.
 *
 * @param {string} stateDir - Coordinator `.orca` state directory.
 * @param {string} id - Valid workflow ID.
 * @returns {string} Workflow state JSON path.
 */
export function workflowStateFile(stateDir, id) {
  return path.join(workflowDirectory(stateDir, id), "state.json");
}

/**
 * Executes a synchronous workflow update under its exclusive lock.
 *
 * @template T
 * @param {string} stateDir - Coordinator `.orca` state directory.
 * @param {string} id - Workflow ID.
 * @param {() => T} callback - Critical state transition.
 * @returns {T} Callback result.
 * @throws {Error} When another coordinator owns the lock or callback fails.
 */
export function withWorkflowUpdate(stateDir, id, callback) {
  const directory = workflowDirectory(stateDir, id);
  return withFileLock(
    path.join(directory, ".lock"),
    () => {
      recoverTransaction(directory);
      return callback();
    },
    "Workflow update in progress; read state again",
  );
}

/**
 * Appends an idempotent workflow event and updates the in-memory event index.
 *
 * @param {string} directory - Exact workflow directory.
 * @param {object} state - Mutable materialized workflow state.
 * @param {object} event - Event with a stable ID.
 * @returns {boolean} `true` when newly persisted; `false` for a duplicate ID.
 * @throws {Error} When the event ID is malformed or persistence fails.
 */
export function appendWorkflowEvent(directory, state, event) {
  assert(
    typeof event.id === "string" && WORKFLOW_ID_PATTERN.test(event.id),
    "Event id required",
  );
  if (state.eventIds.includes(event.id)) return false;

  const sequence = String(state.eventIds.length + 1).padStart(6, "0");
  const queued = pendingEvents.get(state) ?? [];
  queued.push({
    name: `${sequence}-${event.id}.json`,
    event: {
      ...event,
      recordedAt: new Date().toISOString(),
    },
  });
  pendingEvents.set(state, queued);
  state.eventIds.push(event.id);
  return true;
}

/**
 * Atomically persists the materialized state with a fresh update timestamp.
 *
 * @param {string} stateDir - Coordinator `.orca` state directory.
 * @param {string} id - Workflow ID.
 * @param {object} state - Mutable workflow state.
 * @returns {void}
 */
export function saveWorkflowState(stateDir, id, state) {
  state.updatedAt = new Date().toISOString();
  const directory = workflowDirectory(stateDir, id);
  // One atomically renamed journal contains both the next state and its events.
  // A crash during materialization is replayed under the workflow lock.
  writeJSON(path.join(directory, "transaction.json"), {
    state,
    events: pendingEvents.get(state) ?? [],
  });
  recoverTransaction(directory);
  pendingEvents.delete(state);
}

/**
 * Reads materialized workflow state, frozen task revisions, and organization.
 *
 * @param {string} stateDir - Coordinator `.orca` state directory.
 * @param {string} id - Workflow ID.
 * @returns {{dir: string, state: object, tasks: object, organization: object}}
 * Complete workflow snapshot.
 * @throws {Error} When the ID or any persisted record is invalid/missing.
 */
export function readWorkflowSnapshot(stateDir, id) {
  assert(WORKFLOW_ID_PATTERN.test(id), "Workflow id required");
  const directory = workflowDirectory(stateDir, id);
  const transactionFile = path.join(directory, "transaction.json");
  const state = fs.existsSync(transactionFile)
    ? readJSON(transactionFile).state
    : readJSON(workflowStateFile(stateDir, id));
  const tasks = Object.fromEntries(
    Object.entries(state.tasks).map(([taskId, item]) => [
      taskId,
      readJSON(
        path.join(
          directory,
          "tasks",
          taskId,
          "revisions",
          `${item.revision}.json`,
        ),
      ),
    ]),
  );
  return {
    dir: directory,
    state,
    tasks,
    organization: readJSON(path.join(directory, "organization.json")),
  };
}
