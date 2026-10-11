/** Organization-wide fencing and write-ahead records for cooperating worktree mutations. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  assert,
  assertDirectorySync,
  readJSON,
  withFileLock,
  withAsyncFileLock,
  writeDurableJSON,
} from "./core.mjs";

import { projectStateDirectory } from "./local-adapter.mjs";

const projectAnchors = new WeakSet();

function locations(orgFile) {
  const directory = projectAnchors.has(orgFile)
    ? orgFile.directory
    : path.dirname(fs.realpathSync(orgFile));
  return {
    lock: path.join(directory, "worktree-transitions.lock"),
    journal: path.join(directory, "worktree-transitions.json"),
  };
}

/**
 * Reads the organization journal through its canonical organization file identity.
 * @param {string} orgFile - Existing organization JSON file.
 * @returns {object} Validated journal, or an empty journal before participation.
 */
export function readWorktreeTransitions(orgFile) {
  const { journal } = locations(orgFile);
  const value = fs.existsSync(journal)
    ? readJSON(journal)
    : { schemaVersion: 1, entries: [] };
  assert(
    value.schemaVersion === 1 && Array.isArray(value.entries),
    "Invalid worktree transition journal; preserve all candidates",
  );
  return value;
}

/**
 * Finds resources permanently retired from one source kickoff after a transfer.
 * @param {string} orgFile - Organization journal anchor.
 * @param {string} worktreeId - Former PM owner.
 * @returns {object[]} Completed cross-kickoff transfers belonging to this source.
 */
export function retiredWorktrees(orgFile, worktreeId) {
  return readWorktreeTransitions(orgFile).entries.filter(
    (entry) =>
      entry.type === "reuse" &&
      entry.status === "completed" &&
      entry.sourceWorktreeId === worktreeId &&
      entry.targetWorktreeId !== worktreeId,
  );
}

function prepare(orgFile, operation, isActive = () => true) {
  const value = readWorktreeTransitions(orgFile);
  assert(
    !value.entries.some((entry) => entry.status !== "completed"),
    "Unresolved worktree transition; preserve candidates and reconcile the journal",
  );
  const entry = {
    id: crypto.randomUUID(),
    ...operation,
    status: "prepared",
    startedAt: new Date().toISOString(),
  };
  value.entries.push(entry);
  const file = locations(orgFile).journal;
  writeDurableJSON(file, value);
  return {
    entry,
    complete(result) {
      assert(isActive(), "Worktree transaction escaped its lock");
      assert(
        entry.status === "prepared",
        "Worktree transaction already completed",
      );
      entry.status = "completed";
      entry.finishedAt = new Date().toISOString();
      entry.result = result;
      writeDurableJSON(file, value);
      return result;
    },
  };
}

/**
 * Holds the common fence while inspecting candidates, then journals only actual effects.
 * @param {string} orgFile - Existing organization file.
 * @param {Function} inspect - Receives a transaction factory, valid only inside this lock.
 * @returns {Promise<unknown>} Inspection or verified mutation result.
 */
export async function withWorktreeLock(orgFile, inspect) {
  return withAsyncFileLock(
    locations(orgFile).lock,
    async () => {
      const journal = readWorktreeTransitions(orgFile);
      assert(
        !journal.entries.some((entry) => entry.status !== "completed"),
        "Unresolved worktree transition; preserve candidates",
      );
      let active = true;
      try {
        return await inspect((operation) => {
          assert(active, "Worktree transaction escaped its lock");
          return prepare(orgFile, operation, () => active);
        });
      } finally {
        active = false;
      }
    },
    "Organization worktree transition already in progress",
  );
}

/**
 * Holds the same fence for synchronous branch mutations.
 * @param {string} orgFile - Existing organization file.
 * @param {Function} inspect - Receives a factory for durable prepared records.
 * @returns {unknown} Verified result.
 */
export function withWorktreeLockSync(orgFile, inspect) {
  return withFileLock(
    locations(orgFile).lock,
    () => {
      const journal = readWorktreeTransitions(orgFile);
      assert(
        !journal.entries.some((entry) => entry.status !== "completed"),
        "Unresolved worktree transition; preserve candidates",
      );
      let active = true;
      try {
        return inspect((operation) => {
          assert(active, "Worktree transaction escaped its lock");
          return prepare(orgFile, operation, () => active);
        });
      } finally {
        active = false;
      }
    },
    "Organization worktree transition already in progress",
  );
}

/**
 * Serializes a synchronous mutation and preserves its prepared record on any failure.
 * @param {string} orgFile - Canonical organization anchor.
 * @param {object} operation - Operation type and exact resource identifiers.
 * @param {Function} mutate - Callback that performs and independently verifies the effect.
 * @returns {unknown} Verified callback result.
 */
export function transactWorktreeSync(orgFile, operation, mutate) {
  return withFileLock(
    locations(orgFile).lock,
    () => {
      const transaction = prepare(orgFile, operation);
      return transaction.complete(mutate(transaction.entry));
    },
    "Organization worktree transition already in progress",
  );
}

/**
 * Serializes an asynchronous mutation against every cooperating reclamation path.
 * A thrown callback deliberately leaves a prepared record, including after process death.
 * @param {string} orgFile - Canonical organization anchor.
 * @param {object} operation - Operation type and exact resource identifiers.
 * @param {Function} mutate - Callback that performs and independently verifies the effect.
 * @returns {Promise<unknown>} Verified callback result.
 */
export async function transactWorktree(orgFile, operation, mutate) {
  return withAsyncFileLock(
    locations(orgFile).lock,
    async () => {
      const transaction = prepare(orgFile, operation);
      return transaction.complete(await mutate(transaction.entry));
    },
    "Organization worktree transition already in progress",
  );
}

/**
 * Uses the future organization directory for legacy repositories with no organization file.
 * @param {string} projectDir - Verified main Git checkout.
 * @param {Function} inspect - Receives the prepared-record factory and the canonical anchor.
 * @returns {unknown} Verified legacy cleanup result under the shared organization fence.
 */
export function withProjectWorktreeLockSync(projectDir, inspect) {
  const anchor = { directory: projectStateDirectory(projectDir) };
  projectAnchors.add(anchor);
  return withWorktreeLockSync(anchor, (prepare) =>
    inspect((operation) => {
      assertDirectorySync(path.dirname(anchor.directory));
      return prepare(operation);
    }, anchor),
  );
}
