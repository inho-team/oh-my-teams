/**
 * Runtime facts about a task's worktree, recorded when a limit hands it over.
 *
 * The worker that hit its limit cannot write anything more, so the snapshot is
 * taken by the runtime from git alone, without calling a model.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readJSON, writeJSON } from "./core.mjs";

function git(repo, args) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trimEnd();
}

function lines(text) {
  return text ? text.split("\n").filter(Boolean) : [];
}

/**
 * Tells whether two profiles draw on the same subscription or quota pool.
 *
 * Profiles of one provider on the same account share its usage limit, and
 * profiles in one declared pool share that pool, so neither can take over
 * when the other is exhausted.
 *
 * @param {object} left - Profile that stopped.
 * @param {object} right - Profile proposed to take over.
 * @returns {boolean} True when both would hit the same limit.
 */
export function profilesShareLimit(left, right) {
  if (left.pool !== undefined && left.pool === right.pool) return true;
  return left.provider === right.provider && left.account === right.account;
}

/**
 * Writes `snapshot-<index>.json` beside a task's checkpoint.
 *
 * @param {string} directory - Task handoff directory.
 * @param {object} input - What the snapshot describes.
 * @param {number} input.index - Handoff number of this task, from 1.
 * @param {string} input.worktree - Worktree the stopped worker used.
 * @param {string} input.baseRef - Frozen base commit of the task.
 * @param {string} input.taskHash - Frozen task contract hash.
 * @param {string} input.from - Profile that stopped.
 * @param {string} input.to - Profile that takes over.
 * @param {object} input.reason - Limit evidence, e.g. `worker-limit-check` output.
 * @returns {{file: string, snapshot: object}} Written path and contents.
 * @throws {Error} When the worktree is not a git checkout containing the base commit.
 */
export function writeHandoffSnapshot(directory, input) {
  const { index, worktree, baseRef, taskHash, from, to, reason } = input;
  const head = git(worktree, ["rev-parse", "HEAD"]);
  const commits = lines(
    git(worktree, ["log", "--format=%H %s", `${baseRef}..HEAD`]),
  );
  const checkpointFile = path.join(directory, "checkpoint.json");
  const checkpoint = fs.existsSync(checkpointFile)
    ? readJSON(checkpointFile)
    : null;
  let commitsSinceCheckpoint = null;
  if (checkpoint?.head) {
    try {
      commitsSinceCheckpoint = Number(
        git(worktree, ["rev-list", "--count", `${checkpoint.head}..HEAD`]),
      );
    } catch {
      // The checkpoint names a commit this worktree no longer has.
    }
  }
  const snapshot = {
    schemaVersion: 1,
    index,
    createdAt: new Date().toISOString(),
    from,
    to,
    taskHash,
    baseRef,
    worktree: path.resolve(worktree),
    head,
    commits,
    uncommitted: lines(git(worktree, ["status", "--porcelain=v1", "-uall"])),
    diffStat: git(worktree, ["diff", "--shortstat", baseRef]).trim() || null,
    checkpoint: checkpoint
      ? {
          updatedAt: checkpoint.updatedAt,
          head: checkpoint.head,
          sequence: checkpoint.sequence,
          commitsSince: commitsSinceCheckpoint,
        }
      : null,
    reason,
  };
  const file = path.join(directory, `snapshot-${index}.json`);
  writeJSON(file, snapshot);
  return { file, snapshot };
}
