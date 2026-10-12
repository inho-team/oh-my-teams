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
import { git } from "./evidence.mjs";
import { runOrcaJson, selectOrcaExecutable } from "./orca-adapter.mjs";

const projectAnchors = new WeakSet();

function unresolvedMessage(orgFile, journal) {
  const pending = journal.entries.find((entry) => entry.status !== "completed");
  const identity = pending ? `${pending.id} (${pending.type})` : "unknown";
  const recovery =
    pending?.type === "role-reclaim" &&
    pending.identityKey?.startsWith("wt2:local:")
      ? `; if the child is gone, verify it with worktree-transition-reconcile --org ${orgFile} --transition ${pending.id}`
      : "; reconcile the journal before changing worktrees";
  return `Unresolved worktree transition ${identity}; preserve candidates${recovery}`;
}

function assertNoPending(orgFile, journal) {
  assert(
    journal.entries.every((entry) => entry.status === "completed"),
    unresolvedMessage(orgFile, journal),
  );
}

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

function pathPresent(location) {
  try {
    fs.lstatSync(location);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Closes one interrupted local role reclaim only after independent Orca, Git,
 * terminal, and filesystem inventories all prove its child is absent.
 * The outcome records external absence rather than inventing a successful reclaim.
 * @param {string} orgFile - Canonical organization file.
 * @param {string} transitionId - Exact prepared transition identifier.
 * @param {object} [ports] - Injectable read-only adapters for focused tests.
 * @returns {Promise<object>} Durable reconciliation result and observed evidence.
 */
export async function reconcileAbsentRoleWorktree(
  orgFile,
  transitionId,
  {
    orca = runOrcaJson,
    gitCommand = git,
    executable,
    present = pathPresent,
  } = {},
) {
  return withAsyncFileLock(
    locations(orgFile).lock,
    async () => {
      const journal = readWorktreeTransitions(orgFile);
      const pending = journal.entries.filter(
        (entry) => entry.status !== "completed",
      );
      assert(
        pending.length === 1 && pending[0].id === transitionId,
        "Reconciliation requires the exact sole prepared transition",
      );
      const entry = pending[0];
      assert(
        entry.status === "prepared" && entry.type === "role-reclaim",
        "Only an interrupted role-reclaim can use absent-worktree reconciliation",
      );
      assert(
        entry.identityKey?.startsWith("wt2:local:") &&
          typeof entry.worktreeId === "string" &&
          entry.worktreeId.includes("::"),
        "Only a local worktree with recorded Orca identity can be reconciled",
      );
      const separator = entry.worktreeId.indexOf("::");
      const repoId = entry.worktreeId.slice(0, separator);
      const worktreePath = entry.worktreeId.slice(separator + 2);
      assert(
        repoId && path.isAbsolute(worktreePath),
        "Prepared worktree identity is invalid",
      );
      const repo = path.dirname(path.dirname(fs.realpathSync(orgFile)));
      const selected = selectOrcaExecutable(executable);
      const [listed, terminals, gitWorktrees] = await Promise.all([
        orca(selected, ["worktree", "list", "--repo", `id:${repoId}`], {
          cwd: repo,
        }),
        orca(selected, ["terminal", "list"], { cwd: repo }),
        gitCommand(repo, ["worktree", "list", "--porcelain", "-z"]),
      ]);
      const treeInventory = listed.result;
      const terminalInventory = terminals.result;
      assert(
        Array.isArray(treeInventory?.worktrees) &&
          !treeInventory.truncated &&
          treeInventory.hostScope?.omittedHostIds?.length === 0 &&
          treeInventory.hostScope?.hostIds?.includes("local") &&
          treeInventory.worktrees.some(
            (item) => item.id === `${repoId}::${repo}` && item.path === repo,
          ) &&
          !treeInventory.worktrees.some((item) => item.id === entry.worktreeId),
        "Orca has not proven the local worktree absent",
      );
      assert(
        Array.isArray(terminalInventory?.terminals) &&
          !terminalInventory.truncated &&
          terminalInventory.hostScope?.hostIds?.includes("local") &&
          !terminalInventory.terminals.some(
            (item) => item.worktreeId === entry.worktreeId,
          ) &&
          listed._meta?.runtimeId &&
          listed._meta.runtimeId === terminals._meta?.runtimeId,
        "Orca has not proven the local role terminals absent",
      );
      const gitPaths = gitWorktrees
        .split("\0")
        .filter((item) => item.startsWith("worktree "))
        .map((item) => item.slice("worktree ".length));
      assert(
        !gitPaths.some(
          (item) => path.resolve(item) === path.resolve(worktreePath),
        ) && !present(worktreePath),
        "Git or the filesystem still contains the worktree",
      );
      const [latestTrees, latestTerminals] = await Promise.all([
        orca(selected, ["worktree", "list", "--repo", `id:${repoId}`], {
          cwd: repo,
        }),
        orca(selected, ["terminal", "list"], { cwd: repo }),
      ]);
      assert(
        latestTrees._meta?.runtimeId === listed._meta.runtimeId &&
          latestTerminals._meta?.runtimeId === listed._meta.runtimeId &&
          Array.isArray(latestTrees.result?.worktrees) &&
          !latestTrees.result.truncated &&
          latestTrees.result.hostScope?.omittedHostIds?.length === 0 &&
          !latestTrees.result.worktrees.some(
            (item) => item.id === entry.worktreeId,
          ) &&
          Array.isArray(latestTerminals.result?.terminals) &&
          !latestTerminals.result.truncated &&
          !latestTerminals.result.terminals.some(
            (item) => item.worktreeId === entry.worktreeId,
          ) &&
          !present(worktreePath),
        "Worktree or terminal inventory changed before reconciliation",
      );
      const result = {
        status: "absent-after-interruption",
        observedAt: new Date().toISOString(),
        worktreeId: entry.worktreeId,
        identityKey: entry.identityKey,
        evidence: {
          orcaRepoInventory: listed._meta?.runtimeId ?? null,
          orcaTerminalInventory: terminals._meta?.runtimeId ?? null,
          gitWorktrees: gitPaths,
          pathAbsent: true,
        },
      };
      entry.status = "completed";
      entry.finishedAt = result.observedAt;
      entry.result = result;
      writeDurableJSON(locations(orgFile).journal, journal);
      return result;
    },
    "Organization worktree transition already in progress",
  );
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
  assertNoPending(orgFile, value);
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
      assertNoPending(orgFile, journal);
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
      assertNoPending(orgFile, journal);
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
