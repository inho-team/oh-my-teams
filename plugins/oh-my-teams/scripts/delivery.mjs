/**
 * Merges a kickoff's verified result into the project that owns the kickoff.
 *
 * Merges between a kickoff's own worktrees are the team's work and need no
 * separate permission. The merge into the owning project's branch is the one
 * the user controls: the brief states how the result is delivered, the claim
 * records that as the authorization, and only `deliver`, run by the declaring
 * session during close, performs it. Every other gate that could merge refuses
 * the owning checkout, so a worker cannot land its commit on the owner branch.
 */
import fs from "node:fs";
import path from "node:path";
import { assert, run } from "./core.mjs";
import {
  listKickoffs,
  ownerProject,
  recordDelivery,
} from "./kickoff-registry.mjs";

async function git(repo, args, execute) {
  const result = await execute(["git", "-C", repo, ...args]);
  return {
    ok: result.code === 0 && !result.timedOut,
    out: String(result.stdout ?? "").trim(),
    err: String(result.stderr ?? "").trim(),
  };
}

async function gitValue(repo, args, message, execute) {
  const result = await git(repo, args, execute);
  assert(result.ok, `${message}: ${result.err || result.out}`);
  return result.out;
}

/**
 * Names the owning project when a directory is one that owns kickoffs.
 *
 * A checkout owns kickoffs when its `.omt/kickoffs` registry lists at least one
 * running kickoff. A kickoff worktree has no registry of its own, since `.omt/`
 * is separate in every worktree, so it is never mistaken for an owner.
 *
 * @param {string} directory - Checkout a gate or role is about to use.
 * @returns {string | null} The owning project directory, or null.
 */
export function kickoffOwner(directory) {
  const project = path.resolve(directory);
  const orgFile = path.join(project, ".omt", "organization.json");
  if (!fs.existsSync(orgFile)) return null;
  return listKickoffs(orgFile).active ? ownerProject(orgFile) : null;
}

/**
 * Refuses a merge gate or a role in the checkout that owns kickoffs.
 *
 * @param {string} directory - Checkout about to be used.
 * @param {string} use - What was about to happen there, for the message.
 * @returns {void}
 * @throws {Error} When the checkout owns running kickoffs.
 */
export function assertNotKickoffOwner(directory, use) {
  const owner = kickoffOwner(directory);
  assert(
    !owner,
    `${owner} owns running kickoffs, so ${use} does not happen there. ` +
      "Work and merge in the kickoff's worktrees; the result reaches this checkout " +
      "only through deliver, run by the declaring session in close.",
  );
}

// Checks that the caller is running from the director's registered checkout
// path. Entries without a director field predate this feature and are allowed
// through with a console warning so existing kickoffs remain closable.
// When force is true the check is bypassed (mirrors the takeover pattern in
// releaseKickoff).
function assertDirectorAuthority(entry, callerCwd, use, force) {
  if (!entry.director) {
    // Legacy entry: no director recorded; warn and allow.
    console.warn(
      `[omt] Warning: kickoff has no director record; ${use} proceeds without director verification.`,
    );
    return;
  }
  const expected = path.resolve(entry.director.checkoutPath);
  const actual = path.resolve(callerCwd);
  if (force) return;
  assert(
    actual === expected,
    `${use} must be run from the director's checkout at ${expected}; ` +
      `current directory is ${actual}. ` +
      "Run from the owner project checkout, or pass --force with the director's explicit authorization.",
  );
}

/**
 * Merges a kickoff's verified head into the branch its brief named.
 *
 * The head is pinned: the source worktree must still be at it, the gates are
 * run by the caller against it beforehand, and the owner checkout must be on
 * the named branch with no uncommitted changes. A merge that conflicts is
 * aborted and reported, so the owner branch is never left half merged. The
 * merge is recorded in the registry, and a second run for the same head
 * returns that record instead of merging again.
 *
 * @param {object} options - Delivery options.
 * @param {string} options.orgFile - Organization JSON in the owning project.
 * @param {string} options.worktreeId - PM worktree of the kickoff.
 * @param {string} options.source - Worktree holding the verified result.
 * @param {string} options.head - Verified commit to deliver.
 * @param {Function} [options.gate] - Runs the merge gates against the source.
 * @param {Function} [options.execute=run] - Injectable command runner.
 * @returns {Promise<object>} Branch, head, merge commit and whether it merged now.
 * @throws {Error} When delivery is not authorized, the head moved, the owner
 *   checkout is not ready, or the merge conflicts.
 */
export async function deliverKickoff({
  orgFile,
  worktreeId,
  source,
  head,
  gate = async () => undefined,
  execute = run,
  callerCwd = process.cwd(),
  force = false,
}) {
  const [entry] = listKickoffs(orgFile, worktreeId).kickoffs;
  assert(entry, `Worktree ${worktreeId} supervises no registered kickoff`);
  // Authority check: only the director (from the registered checkout path) may
  // deliver. Entries without a director record predate this feature; they are
  // allowed through with a warning so existing kickoffs stay closable.
  assertDirectorAuthority(entry, callerCwd, "deliver", force);
  const delivery = entry.delivery;
  assert(
    delivery,
    "This kickoff was registered before its delivery was recorded; " +
      "confirm the delivery with the user and merge by the PR or manual procedure",
  );
  assert(
    delivery.mode === "local-merge",
    delivery.mode === "pull-request"
      ? `The brief delivers through a pull request against ${delivery.branch}; follow close's PR procedure`
      : "The brief asked for no delivery into the project, so nothing is merged",
  );
  if (entry.delivered) {
    assert(
      entry.delivered.head === head,
      `Kickoff already delivered ${entry.delivered.head}`,
    );
    return {
      delivered: true,
      merged: false,
      branch: delivery.branch,
      ...entry.delivered,
    };
  }

  const owner = ownerProject(orgFile);
  const sourceDir = path.resolve(source);
  assert(
    sourceDir !== owner,
    "The source is the owner checkout itself; deliver from the kickoff's integration worktree",
  );
  const sourceHead = await gitValue(
    sourceDir,
    ["rev-parse", "HEAD"],
    "Cannot read the source head",
    execute,
  );
  const pinned = await gitValue(
    sourceDir,
    ["rev-parse", "--verify", `${head}^{commit}`],
    `Cannot resolve ${head}`,
    execute,
  );
  assert(
    sourceHead === pinned,
    `Source ${sourceDir} is at ${sourceHead}, not the verified ${pinned}; verify again`,
  );
  await gate({ source: sourceDir, base: delivery.branch });

  const branch = await git(owner, ["symbolic-ref", "--short", "HEAD"], execute);
  assert(
    branch.ok && branch.out === delivery.branch,
    `Owner checkout ${owner} is on ${branch.out || "a detached head"}, not ${delivery.branch}`,
  );
  const dirty = await gitValue(
    owner,
    ["status", "--porcelain", "--untracked-files=no"],
    "Cannot read the owner checkout status",
    execute,
  );
  assert(
    !dirty,
    `Owner checkout ${owner} has uncommitted changes; commit or stash them first`,
  );

  const merged = await git(
    owner,
    ["merge", "--no-ff", "-m", `Merge kickoff: ${entry.goal}`, pinned],
    execute,
  );
  if (!merged.ok) {
    await git(owner, ["merge", "--abort"], execute);
    throw new Error(
      `Merging ${pinned} into ${delivery.branch} failed and was aborted: ${merged.err || merged.out}`,
    );
  }
  const mergeCommit = await gitValue(
    owner,
    ["rev-parse", "HEAD"],
    "Cannot read the merge commit",
    execute,
  );
  const recorded = recordDelivery(orgFile, {
    worktreeId,
    head: pinned,
    mergeCommit,
  });
  return {
    delivered: true,
    merged: true,
    branch: delivery.branch,
    ...recorded.entry.delivered,
  };
}
