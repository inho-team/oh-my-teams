/** Limit child worktrees per kickoff using Orca's current inventory. */
import { assert } from "./core.mjs";
import { runOrcaJson, selectOrcaExecutable } from "./orca-adapter.mjs";

/** Maximum retained child worktrees a kickoff may own before it must reuse or reclaim one. */
export const MAX_KICKOFF_CHILD_WORKTREES = 8;

/** Maximum retained worktrees, including the main checkout, across one repository. */
export const MAX_REPO_WORKTREES = 12;

/**
 * Refuses another child when a kickoff already owns too many worktrees.
 * @param {object} request - Kickoff owner and Orca invocation.
 * @param {string} [request.parentWorktreeId] - Registered PM worktree ID, if this is a child of a kickoff.
 * @param {string} request.repo - Registered PM checkout path.
 * @param {string} [request.executable] - Selected Orca executable.
 * @param {Function} [request.list] - Injectable Orca JSON adapter.
 * @returns {Promise<number>} Number of existing children.
 */
export async function assertChildWorktreeCapacity({
  parentWorktreeId,
  repo,
  executable,
  list = runOrcaJson,
}) {
  assert(repo, "Repository checkout required");
  const response = await list(
    selectOrcaExecutable(executable),
    ["worktree", "list", "--repo", `path:${repo}`, "--limit", "10000"],
    { cwd: repo },
  );
  const inventory = response.result;
  assert(
    Array.isArray(inventory?.worktrees) &&
      inventory.truncated === false &&
      Array.isArray(inventory.hostScope?.omittedHostIds) &&
      inventory.hostScope.omittedHostIds.length === 0,
    "Orca worktree inventory is incomplete; preserve existing worktrees",
  );
  const retained = inventory.worktrees.filter(
    (worktree) => worktree.isArchived !== true,
  );
  assert(
    retained.length < MAX_REPO_WORKTREES,
    `Repository already has ${retained.length} worktrees; reuse or reclaim one before creating another`,
  );
  const count = retained.filter(
    (worktree) =>
      parentWorktreeId && worktree.parentWorktreeId === parentWorktreeId,
  ).length;
  assert(
    count < MAX_KICKOFF_CHILD_WORKTREES,
    `Kickoff already owns ${count} child worktrees; reuse or reclaim one before creating another`,
  );
  return count;
}
