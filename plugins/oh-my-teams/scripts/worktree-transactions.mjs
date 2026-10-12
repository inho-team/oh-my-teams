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
  hash,
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
    resolutions: path.join(directory, "worktree-transition-resolutions.json"),
  };
}

function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function validPreservation(record) {
  return (
    record?.reclaimSucceeded === false &&
    (record.disposition === "preserved-not-reclaimed" ||
      (record.schemaVersion === 2 &&
        record.disposition === "legacy-preservation-adopted" &&
        record.originalOutcome === "unknown" &&
        record.effects === "unknown" &&
        record.availableNativeTrace === false &&
        record.quiescenceBasis ===
          "adopted-exited-invocation-plus-reviewed-control-flow" &&
        record.adoption?.noEffectCertified === false))
  );
}

function resolutionsFor(orgFile, journal) {
  const file = locations(orgFile).resolutions;
  if (!fs.existsSync(file)) return [];
  const value = readJSON(file);
  assert(
    value.schemaVersion === 1 && Array.isArray(value.records),
    "Invalid worktree resolutions; preserve candidates",
  );
  let previous = null;
  const ids = new Set();
  for (const record of value.records) {
    const { digest: recordedDigest, ...body } = record;
    const original = journal.entries.find(
      (entry) => entry.id === record.entryId,
    );
    const bytes = Buffer.from(record.originalJournalBase64 ?? "", "base64");
    const snapshot = JSON.parse(bytes.toString("utf8"));
    assert(
      record.previous === previous &&
        recordedDigest === hash(body) &&
        !ids.has(record.entryId) &&
        original?.type === "role-reclaim" &&
        original.status === "prepared" &&
        validPreservation(record) &&
        record.reclaimSucceeded === false &&
        record.entryHash === hash(original) &&
        record.journalSha256 === digest(bytes) &&
        hash(snapshot.entries.find((entry) => entry.id === record.entryId)) ===
          record.entryHash,
      "Invalid preservation resolution; preserve candidates",
    );
    ids.add(record.entryId);
    previous = recordedDigest;
  }
  return value.records;
}

function unresolved(orgFile, journal) {
  const resolved = new Set(
    resolutionsFor(orgFile, journal).map((record) => record.entryId),
  );
  return journal.entries.filter(
    (entry) => entry.status !== "completed" && !resolved.has(entry.id),
  );
}

/**
 * Appends a preservation disposition under the canonical fence without rewriting the failed journal.
 * The inspector enforces its preservation contract; legacy adoption retains unknown historical effects.
 * Request data is only a CAS guard, never the authority for a preservation disposition.
 * @param {string} orgFile - Canonical organization anchor.
 * @param {object} request - Exact entry ID, journal byte hash and immutable request hash.
 * @param {Function} inspect - Read-only proof callback, called under the organization fence.
 * @returns {Promise<object>} Preserved disposition, never a successful reclaim.
 */
export async function reconcileWorktreeTransition(orgFile, request, inspect) {
  return withAsyncFileLock(
    locations(orgFile).lock,
    async () => {
      const files = locations(orgFile);
      const journalBytes = fs.readFileSync(files.journal);
      const organizationBytes = fs.readFileSync(fs.realpathSync(orgFile));
      const journal = readWorktreeTransitions(orgFile);
      const records = resolutionsFor(orgFile, journal);
      const existing = records.find(
        (record) => record.entryId === request.entryId,
      );
      if (existing) {
        assert(
          existing.requestHash === request.requestHash,
          "Conflicting reconciliation request",
        );
        return { ...existing, replayed: true };
      }
      assert(
        digest(journalBytes) === request.journalSha256,
        "Journal changed before reconciliation",
      );
      const pending = unresolved(orgFile, journal);
      assert(
        pending.length === 1 &&
          pending[0].id === request.entryId &&
          pending[0].type === "role-reclaim",
        "Exact sole prepared role-reclaim required",
      );
      const entry = pending[0];
      const proof = await inspect(structuredClone(entry));
      assert(validPreservation(proof), "Preservation proof required");
      assert(
        fs.readFileSync(files.journal).equals(journalBytes) &&
          fs.readFileSync(fs.realpathSync(orgFile)).equals(organizationBytes) &&
          hash(resolutionsFor(orgFile, readWorktreeTransitions(orgFile))) ===
            hash(records),
        "Reconciliation inputs changed during proof",
      );
      const record = {
        ...proof,
        entryId: entry.id,
        entryHash: hash(entry),
        requestHash: request.requestHash,
        journalSha256: request.journalSha256,
        originalJournalBase64: journalBytes.toString("base64"),
        previous: records.at(-1)?.digest ?? null,
        at: new Date().toISOString(),
      };
      record.digest = hash(record);
      writeDurableJSON(files.resolutions, {
        schemaVersion: 1,
        records: [...records, record],
      });
      return record;
    },
    "Organization worktree transition already in progress",
  );
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
    unresolved(orgFile, value).length === 0,
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
        unresolved(orgFile, journal).length === 0,
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
        unresolved(orgFile, journal).length === 0,
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
  return withWorktreeLockSync(anchor, (prepare) => {
    let active = true;
    try {
      return inspect((operation) => {
        assert(active, "Legacy transaction escaped its lock");
        let unsupported;
        try {
          assertDirectorySync(path.dirname(anchor.directory));
          assertDirectorySync(anchor.directory);
        } catch (error) {
          if (error.code !== "worktree-durability-unavailable") throw error;
          unsupported = error;
        }
        if (!unsupported) return prepare(operation);
        // A genuinely pre-organization repository has no participating owner or
        // transition resources. Do not extend this exception to registered work.
        assert(
          operation.type === "branch-cleanup" &&
            !["organization.json", "kickoffs", "history"].some((name) =>
              fs.existsSync(path.join(anchor.directory, name)),
            ) &&
            readWorktreeTransitions(anchor).entries.length === 0,
          "Legacy branch cleanup cannot touch protocol or journal resources; preserve branches",
        );
        let completed = false;
        return {
          legacyLifecycle: {
            mode: "no-organization-branch",
            durable: false,
            reason: unsupported.message,
          },
          complete(result) {
            assert(active, "Legacy transaction escaped its lock");
            assert(!completed, "Legacy branch cleanup already completed");
            completed = true;
            return result;
          },
        };
      }, anchor);
    } finally {
      active = false;
    }
  });
}
