/** Deterministic concurrency and crash-boundary checks for the shared worktree fence. */
import { denyDirectorySync } from "./directory-durability-fixture.mjs";
import test from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertDirectorySync } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  readWorktreeTransitions,
  transactWorktree,
  transactWorktreeSync,
  withWorktreeLock,
  withProjectWorktreeLockSync,
} from "../plugins/oh-my-teams/scripts/worktree-transactions.mjs";

import {
  releaseKickoff,
  cleanupKickoffBranches,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";
import { reclaimKickoffCleanup } from "../plugins/oh-my-teams/scripts/kickoff-cleanup.mjs";
import { reclaimIntegratedRoleWorktree } from "../plugins/oh-my-teams/scripts/teams-org.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omt-transition-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const org = path.join(directory, "organization.json");
  fs.writeFileSync(org, "{}");
  return { directory, org };
}

test("a symlink alias and synchronous cleanup cannot enter an asynchronous transfer fence", async (t) => {
  const { directory, org } = fixture(t);
  const alias = path.join(directory, "alias.json");
  try {
    fs.symlinkSync(org, alias);
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM")
      return t.skip("Symlink creation is not permitted on this host");
    throw error;
  }
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  let leave;
  const release = new Promise((resolve) => {
    leave = resolve;
  });
  const transfer = withWorktreeLock(org, async () => {
    entered();
    await release;
  });
  await ready;
  let mutations = 0;
  assert.throws(
    () =>
      transactWorktreeSync(alias, { type: "branch-cleanup" }, () => {
        mutations += 1;
      }),
    /in progress/,
  );
  await assert.rejects(
    () =>
      transactWorktree(alias, { type: "reclaim" }, () => {
        mutations += 1;
      }),
    /in progress/,
  );
  assert.equal(mutations, 0);
  leave();
  await transfer;
});

test("failure after durable prepare prevents subsequent reuse and every cleanup type", async (t) => {
  const { org } = fixture(t);
  try {
    assertDirectorySync(path.dirname(org));
  } catch (error) {
    assert.equal(error.code, "worktree-durability-unavailable");
    await assert.rejects(
      () =>
        transactWorktree(org, { type: "reuse" }, () =>
          assert.fail("unsafe effect"),
        ),
      { code: error.code },
    );
    assert.deepEqual(readWorktreeTransitions(org).entries, []);
    return;
  }
  let effected = false;
  await assert.rejects(() =>
    transactWorktree(org, { type: "reuse", worktreeId: "child" }, () => {
      effected = true;
      throw new Error("lost mutation response");
    }),
  );
  const entries = readWorktreeTransitions(org).entries;
  assert.equal(entries[0].status, "prepared");
  assert.equal(effected, true);
  for (const type of [
    "reuse",
    "role-reclaim",
    "kickoff-release",
    "kickoff-reclaim",
    "branch-cleanup",
  ]) {
    await assert.rejects(
      () => transactWorktree(org, { type }, () => assert.fail("unsafe effect")),
      /Unresolved/,
    );
  }
});

test("validation before prepare leaves no unresolved transition", async (t) => {
  const { org } = fixture(t);
  await assert.rejects(
    () =>
      withWorktreeLock(org, () => {
        throw new Error("candidate dirty");
      }),
    /dirty/,
  );
  assert.deepEqual(readWorktreeTransitions(org).entries, []);
  assert.equal(await withWorktreeLock(org, () => "readable"), "readable");
});

test("a successful durable transition records its independently observed result", async (t) => {
  const { org } = fixture(t);
  let called = false;
  try {
    const result = await transactWorktree(
      org,
      { type: "reuse", worktreeId: "child" },
      () => {
        called = true;
        return { observedIdentity: "instance-1", observedParent: "target" };
      },
    );
    assert.equal(result.observedParent, "target");
    assert.equal(readWorktreeTransitions(org).entries[0].status, "completed");
  } catch (error) {
    if (error.code !== "worktree-durability-unavailable") throw error;
    assert.equal(
      called,
      false,
      "unsupported durable preparation must fail before mutation",
    );
  }
});

test("the real release and cleanup entry points share the held transfer fence", async (t) => {
  const { org } = fixture(t);
  await withWorktreeLock(org, async () => {
    await assert.rejects(() => releaseKickoff(org, {}), /in progress/);
    await assert.rejects(
      () => reclaimKickoffCleanup({ orgFile: org }),
      /in progress/,
    );
    await assert.rejects(
      () => reclaimIntegratedRoleWorktree({ org }),
      /in progress/,
    );
    assert.throws(
      () => cleanupKickoffBranches({ orgFile: org }),
      /in progress/,
    );
    assert.deepEqual(readWorktreeTransitions(org).entries, []);
  });
});

test("a transaction cannot complete after releasing the organization fence", async (t) => {
  const { org } = fixture(t);
  let held;
  try {
    await withWorktreeLock(org, (prepare) => {
      held = prepare({ type: "reuse" });
    });
  } catch (error) {
    assert.equal(error.code, "worktree-durability-unavailable");
    return;
  }
  assert.throws(() => held.complete({}), /escaped its lock/);
  assert.equal(readWorktreeTransitions(org).entries[0].status, "prepared");
});

test("legacy project cleanup and a subsequently registered organization use the same fence", (t) => {
  const { directory } = fixture(t);
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  const org = path.join(directory, ".omt", "organization.json");
  assert.equal(fs.existsSync(org), false);
  withProjectWorktreeLockSync(directory, () => {
    fs.writeFileSync(org, "{}");
    assert.throws(
      () => cleanupKickoffBranches({ orgFile: org }),
      /in progress/,
    );
    assert.throws(
      () =>
        withProjectWorktreeLockSync(directory, () =>
          assert.fail("split fence"),
        ),
      /in progress/,
    );
  });
  assert.deepEqual(readWorktreeTransitions(org).entries, []);
});

test("unsupported no-organization branch cleanup stays fenced away from protocol and journal resources", async (t) => {
  for (const mode of [
    "legacy",
    "organization",
    "registration",
    "history",
    "journal",
    "protocol-entry",
  ]) {
    await t.test(mode, (t) => {
      const { directory } = fixture(t);
      const git = (...args) =>
        execFileSync("git", args, {
          cwd: directory,
          encoding: "utf8",
          stdio: "pipe",
        }).trim();
      git("init", "-q");
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "--allow-empty",
        "-qm",
        "base",
      );
      const head = git("rev-parse", "HEAD");
      git("branch", "legacy-merged");
      const state = path.join(directory, ".omt");
      fs.mkdirSync(state);
      if (mode === "organization")
        fs.writeFileSync(path.join(state, "organization.json"), "{}");
      if (mode === "registration") fs.mkdirSync(path.join(state, "kickoffs"));
      if (mode === "history") fs.mkdirSync(path.join(state, "history"));
      if (mode === "journal")
        fs.writeFileSync(
          path.join(state, "worktree-transitions.json"),
          JSON.stringify({
            schemaVersion: 1,
            entries: [
              { status: "completed", type: "reuse", branch: "legacy-merged" },
            ],
          }),
        );
      const entry = {
        delivery: { mode: "local-merge" },
        delivered: { mergeCommit: head },
        ...(mode === "protocol-entry"
          ? {
              reuseProtocol: {
                organizationFile: path.join(state, "organization.json"),
              },
            }
          : {}),
      };
      denyDirectorySync(t);
      const invoke = () =>
        cleanupKickoffBranches({
          projectDir: directory,
          entry,
          branches: ["legacy-merged"],
          remoteName: "",
        });
      if (mode === "legacy") {
        assert.deepEqual(invoke().deleted, ["legacy-merged"]);
        assert.throws(() =>
          git("rev-parse", "--verify", "refs/heads/legacy-merged"),
        );
        assert.equal(
          fs.existsSync(path.join(state, "worktree-transitions.json")),
          false,
        );
      } else {
        assert.throws(invoke, /preserve|unavailable|ENOENT/);
        assert.equal(git("rev-parse", "refs/heads/legacy-merged"), head);
      }
    });
  }
});
