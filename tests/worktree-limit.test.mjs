/** Orca inventory bounds new children without treating an incomplete page as capacity. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertChildWorktreeCapacity,
  MAX_KICKOFF_CHILD_WORKTREES,
  MAX_REPO_WORKTREES,
} from "../plugins/oh-my-teams/scripts/worktree-limit.mjs";

const parentWorktreeId = "repo::/tmp/pm";
const repo = "/tmp/pm";
const inventory = (count, extra = {}) => ({
  result: {
    worktrees: Array.from({ length: count }, (_, index) => ({
      id: `repo::/tmp/worker-${index}`,
      parentWorktreeId,
      isArchived: false,
    })),
    truncated: false,
    hostScope: { omittedHostIds: [] },
    ...extra,
  },
});

test("a kickoff must reuse or reclaim a child after reaching its worktree cap", async () => {
  const request = {
    parentWorktreeId,
    repo,
    list: async () => inventory(MAX_KICKOFF_CHILD_WORKTREES),
  };
  await assert.rejects(
    () => assertChildWorktreeCapacity(request),
    /reuse or reclaim one/,
  );
  assert.equal(
    await assertChildWorktreeCapacity({
      ...request,
      list: async () => inventory(MAX_KICKOFF_CHILD_WORKTREES - 1),
    }),
    MAX_KICKOFF_CHILD_WORKTREES - 1,
  );
});

test("an incomplete Orca inventory cannot authorize another child", async () => {
  await assert.rejects(
    () =>
      assertChildWorktreeCapacity({
        parentWorktreeId,
        repo,
        list: async () => inventory(0, { truncated: true }),
      }),
    /incomplete/,
  );
});

test("many kickoffs cannot fill one repository with more worktrees", async () => {
  await assert.rejects(
    () =>
      assertChildWorktreeCapacity({
        parentWorktreeId,
        repo,
        list: async () =>
          inventory(0, {
            worktrees: Array.from(
              { length: MAX_REPO_WORKTREES },
              (_, index) => ({
                id: `repo::/tmp/other-${index}`,
                parentWorktreeId: `repo::/tmp/other-pm-${index}`,
                isArchived: false,
              }),
            ),
          }),
      }),
    /Repository already has 12 worktrees/,
  );
});
