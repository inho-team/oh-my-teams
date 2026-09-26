/** The kickoff registry: many kickoffs per project, one per PM worktree. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readJSON,
  run,
  writeJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  bindKickoffRun,
  cleanupKickoffBranches,
  listKickoffs,
  registerKickoff,
  registryDirectory,
  releaseKickoff,
  verifyHandoffClaim,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";

const cli = path.resolve("plugins/oh-my-teams/scripts/teams-org.mjs");
const exampleOrg = path.resolve(
  "plugins/oh-my-teams/examples/organization.json",
);

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-registry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const org = path.join(dir, ".omt", "organization.json");
  fs.mkdirSync(path.dirname(org), { recursive: true });
  fs.copyFileSync(exampleOrg, org);
  const brief = path.join(dir, "brief.md");
  fs.writeFileSync(brief, "goal, acceptance criteria, non-goals\n");
  return { dir, org, brief };
}

function claimFor(fixture, worktreeId) {
  const pm = path.join(fixture.dir, worktreeId);
  return {
    goal: `deliver ${worktreeId}`,
    pm: {
      worktreeId,
      path: pm,
      stateDir: path.join(pm, ".omt"),
    },
    organizationRevision: readJSON(fixture.org).revision,
    brief: fixture.brief,
    // These tests are about the registry itself; delivery has its own tests.
    delivery: { mode: "none" },
  };
}

const ids = (fixture) =>
  listKickoffs(fixture.org).kickoffs.map((entry) => entry.pm.worktreeId);

test("the registry lives with the organization it serves", (t) => {
  const fixture = project(t);
  // An entry inside a PM worktree cannot be seen by the session that
  // closes it: .omt is a separate directory in every worktree.
  assert.equal(
    registryDirectory(fixture.org),
    path.join(fixture.dir, ".omt", "kickoffs"),
  );
  assert.deepEqual(listKickoffs(fixture.org), { active: false, kickoffs: [] });
});

test("a project runs several kickoffs, each from its own PM worktree", (t) => {
  const fixture = project(t);
  registerKickoff(fixture.org, claimFor(fixture, "wt-a"));
  registerKickoff(fixture.org, claimFor(fixture, "wt-b"));
  assert.deepEqual(ids(fixture), ["wt-a", "wt-b"]);
  assert.deepEqual(
    listKickoffs(fixture.org, "wt-b").kickoffs.map((entry) => entry.goal),
    ["deliver wt-b"],
  );

  // A PM session owns one Goal and binds one Run, so a second kickoff
  // registered to the same worktree would have nobody supervising it.
  assert.throws(
    () => registerKickoff(fixture.org, claimFor(fixture, "wt-a")),
    /Worktree wt-a already supervises a kickoff/,
  );
});

test("sessions registering at the same moment all land in the registry", async (t) => {
  const fixture = project(t);
  const files = ["wt-a", "wt-b", "wt-c"].map((worktreeId) => {
    const file = path.join(fixture.dir, `${worktreeId}.json`);
    writeJSON(file, claimFor(fixture, worktreeId));
    return file;
  });
  const register = (file) =>
    run([
      process.execPath,
      cli,
      "kickoff-claim",
      "--org",
      fixture.org,
      "--from",
      file,
    ]);

  // Registrations serialize on one lock; a caller that meets it held is told
  // to read again, and retrying it must still leave every kickoff recorded.
  let pending = files;
  for (let round = 0; pending.length && round < 10; round += 1) {
    const results = await Promise.all(pending.map(register));
    pending = pending.filter((_, index) => results[index].code !== 0);
  }
  assert.deepEqual(pending, []);
  assert.deepEqual(ids(fixture), ["wt-a", "wt-b", "wt-c"]);
});

test("a registration needs a written brief and the current organization revision", (t) => {
  const fixture = project(t);
  const missingBrief = {
    ...claimFor(fixture, "wt-a"),
    brief: path.join(fixture.dir, "never-written.md"),
  };
  // The brief is what the PM reads instead of the parent
  // conversation, so an entry naming one never written hands it nothing.
  assert.throws(() => registerKickoff(fixture.org, missingBrief), /Brief file/);

  const stale = { ...claimFor(fixture, "wt-a"), organizationRevision: 99 };
  assert.throws(() => registerKickoff(fixture.org, stale), /revision/);
  assert.equal(listKickoffs(fixture.org).active, false);
});

test("each PM binds its own Run, and only once", (t) => {
  const fixture = project(t);
  registerKickoff(fixture.org, claimFor(fixture, "wt-a"));
  registerKickoff(fixture.org, claimFor(fixture, "wt-b"));

  bindKickoffRun(fixture.org, { worktreeId: "wt-a", runId: "run-a" });
  bindKickoffRun(fixture.org, { worktreeId: "wt-b", runId: "run-b" });
  // Re-running the same bind after a lost receipt must not look like a
  // conflict, while a different Run means the PM split its work.
  assert.equal(
    bindKickoffRun(fixture.org, { worktreeId: "wt-a", runId: "run-a" }).entry
      .runId,
    "run-a",
  );
  assert.throws(
    () => bindKickoffRun(fixture.org, { worktreeId: "wt-a", runId: "run-z" }),
    /already bound to run run-a/,
  );
  assert.throws(
    () => bindKickoffRun(fixture.org, { worktreeId: "wt-x", runId: "run-x" }),
    /supervises no registered kickoff/,
  );
});

test("a pasted handoff claim is trusted only when it matches the registered director (#86)", (t) => {
  const fixture = project(t);
  // Nothing registered yet: the director just opened role-terminal --brief,
  // and kickoff-claim (step 5) has not run. A claim cannot be verified, and
  // must not be treated as a match just because nothing contradicts it.
  assert.deepEqual(
    verifyHandoffClaim(fixture.org, {
      worktreeId: "wt-a",
      directorTerminal: "term_director",
      brief: fixture.brief,
    }),
    {
      match: false,
      reason: "not-registered",
      claimed: {
        directorTerminal: "term_director",
        brief: path.resolve(fixture.brief),
      },
    },
  );

  // Registered, but by an entry written before director support existed
  // (or without one recorded): still nothing to compare the claim against.
  registerKickoff(fixture.org, claimFor(fixture, "wt-a"));
  assert.equal(
    verifyHandoffClaim(fixture.org, {
      worktreeId: "wt-a",
      directorTerminal: "term_director",
      brief: fixture.brief,
    }).reason,
    "no-director-recorded",
  );

  registerKickoff(fixture.org, {
    ...claimFor(fixture, "wt-b"),
    director: { terminalHandle: "term_director", checkoutPath: fixture.dir },
  });

  // Someone else's terminal, or a different brief: not the director's claim.
  assert.equal(
    verifyHandoffClaim(fixture.org, {
      worktreeId: "wt-b",
      directorTerminal: "term_outsider",
      brief: fixture.brief,
    }).reason,
    "mismatch",
  );
  const otherBrief = path.join(fixture.dir, "other-brief.md");
  fs.writeFileSync(otherBrief, "a different goal\n");
  assert.equal(
    verifyHandoffClaim(fixture.org, {
      worktreeId: "wt-b",
      directorTerminal: "term_director",
      brief: otherBrief,
    }).reason,
    "mismatch",
  );

  // Both the terminal handle and the brief path (resolved, not compared as
  // literal strings) match the registry entry the director itself wrote.
  const matched = verifyHandoffClaim(fixture.org, {
    worktreeId: "wt-b",
    directorTerminal: "term_director",
    brief: path.join(fixture.dir, ".", "brief.md"),
  });
  assert.equal(matched.match, true);
  assert.equal(matched.reason, "matched");
});

test("ending one kickoff archives it and leaves the others running", (t) => {
  const fixture = project(t);
  registerKickoff(fixture.org, claimFor(fixture, "wt-a"));
  registerKickoff(fixture.org, claimFor(fixture, "wt-b"));

  const released = releaseKickoff(fixture.org, {
    worktreeId: "wt-a",
    reason: "disbanded",
  });
  const archived = readJSON(released.archived);
  assert.equal(archived.releaseReason, "disbanded");
  assert.equal(archived.pm.worktreeId, "wt-a");
  assert.deepEqual(ids(fixture), ["wt-b"]);

  // The worktree is free again for a later kickoff.
  assert.equal(
    registerKickoff(fixture.org, claimFor(fixture, "wt-a")).claimed,
    true,
  );
});

test("the id Orca returns registers, binds and releases as given", (t) => {
  const fixture = project(t);
  // Orca addresses a worktree as `<repoId>::<worktreePath>`, so the id holds
  // `:` and `/`, and the path may be in any script.
  const worktreeId =
    "5a8b6a7e-f8f0-4db8-aa52-8f887725741f::/Users/me/orca/workspaces/문해력/site-research";
  const claim = {
    ...claimFor(fixture, "wt-orca"),
    goal: "deliver the Orca-addressed kickoff",
  };
  claim.pm = { ...claim.pm, worktreeId };

  const claimed = registerKickoff(fixture.org, claim);
  assert.equal(path.dirname(claimed.file), registryDirectory(fixture.org));
  assert.deepEqual(ids(fixture), [worktreeId]);
  assert.throws(
    () => registerKickoff(fixture.org, claim),
    /already supervises a kickoff/,
  );

  assert.equal(
    bindKickoffRun(fixture.org, { worktreeId, runId: "run-orca" }).entry.runId,
    "run-orca",
  );
  const released = releaseKickoff(fixture.org, {
    worktreeId,
    reason: "completed",
  });
  assert.equal(
    path.dirname(released.archived),
    path.join(fixture.dir, ".omt", "history"),
  );
  assert.equal(readJSON(released.archived).pm.worktreeId, worktreeId);
  assert.deepEqual(ids(fixture), []);
});

test("no worktree id writes outside the registry", (t) => {
  const fixture = project(t);
  const worktreeId = "../../escaped";
  const claim = claimFor(fixture, "wt-escape");
  claim.pm = { ...claim.pm, worktreeId };

  const claimed = registerKickoff(fixture.org, claim);
  assert.equal(path.dirname(claimed.file), registryDirectory(fixture.org));
  assert.equal(fs.existsSync(path.join(fixture.dir, "escaped.json")), false);
  const released = releaseKickoff(fixture.org, {
    worktreeId,
    reason: "disbanded",
  });
  assert.equal(
    path.dirname(released.archived),
    path.join(fixture.dir, ".omt", "history"),
  );

  // A blank id or one carrying a control character names no worktree.
  for (const bad of ["", "wt\nnext"]) {
    const refused = claimFor(fixture, "wt-bad");
    refused.pm = { ...refused.pm, worktreeId: bad };
    assert.throws(
      () => registerKickoff(fixture.org, refused),
      /worktree id required/,
    );
  }
});

test("an entry named after its id by an earlier release stays closable", (t) => {
  const fixture = project(t);
  const entry = {
    schemaVersion: 1,
    ...claimFor(fixture, "wt-named"),
    runId: null,
    createdAt: "2026-09-16T00:00:00.000Z",
  };
  const legacy = path.join(registryDirectory(fixture.org), "wt-named.json");
  writeJSON(legacy, entry);

  assert.deepEqual(ids(fixture), ["wt-named"]);
  assert.throws(
    () => registerKickoff(fixture.org, claimFor(fixture, "wt-named")),
    /already supervises a kickoff/,
  );
  assert.equal(
    bindKickoffRun(fixture.org, { worktreeId: "wt-named", runId: "run-n" })
      .entry.runId,
    "run-n",
  );
  releaseKickoff(fixture.org, { worktreeId: "wt-named", reason: "completed" });
  assert.equal(fs.existsSync(legacy), false);
  assert.deepEqual(ids(fixture), []);
});

test("the declaring session is the PM only when it records why", (t) => {
  const fixture = project(t);
  // A session that failed to start the PM went on as PM itself. The
  // registry refuses that unless the claim states why no handoff exists.
  const own = claimFor(fixture, "wt-self");
  own.pm = {
    ...own.pm,
    path: fixture.dir,
    stateDir: path.join(fixture.dir, ".omt"),
  };
  assert.throws(
    () => registerKickoff(fixture.org, own),
    /declaring session cannot be the PM/,
  );
  assert.deepEqual(ids(fixture), []);

  const reason =
    "orca is not installed (command not found); the user approved supervising here";
  const claimed = registerKickoff(fixture.org, {
    ...own,
    selfPm: reason,
  });
  assert.equal(claimed.entry.selfPm, reason);
  // A child worktree needs no such statement.
  assert.equal(
    registerKickoff(fixture.org, claimFor(fixture, "wt-child")).entry.selfPm,
    undefined,
  );
});

test("ending a kickoff whose PM cannot be reached is a forced decision", (t) => {
  const fixture = project(t);
  registerKickoff(fixture.org, claimFor(fixture, "wt-a"));
  // An unverifiable PM may still be running, so a takeover is never
  // the automatic consequence of a failed query.
  assert.throws(
    () =>
      releaseKickoff(fixture.org, {
        worktreeId: "wt-a",
        reason: "taken-over",
      }),
    /explicit authorization/,
  );
  const taken = releaseKickoff(fixture.org, {
    worktreeId: "wt-a",
    reason: "taken-over",
    force: true,
  });
  assert.equal(readJSON(taken.archived).releaseReason, "taken-over");
});

test("two PMs each create a workflow in their own state", async (t) => {
  const fixture = project(t);
  const workflow = path.resolve("plugins/oh-my-teams/examples/workflow.json");
  for (const worktreeId of ["wt-a", "wt-b"]) {
    const claim = claimFor(fixture, worktreeId);
    registerKickoff(fixture.org, claim);
    const created = await run([
      process.execPath,
      cli,
      "workflow-create",
      "--workflow",
      workflow,
      "--org",
      fixture.org,
      "--state",
      claim.pm.stateDir,
    ]);
    // The single-kickoff release refused the second PM here. Whatever
    // else fails in this fixture, it must not be that refusal.
    assert.doesNotMatch(created.stderr, /Active kickoff is held by/);
  }
});

test("a lease left by the single-kickoff release becomes a registry entry", (t) => {
  const fixture = project(t);
  const legacy = {
    schemaVersion: 1,
    ...claimFor(fixture, "wt-old"),
    runId: "run-old",
    createdAt: "2026-09-16T00:00:00.000Z",
  };
  writeJSON(path.join(fixture.dir, ".omt", "active-kickoff.json"), legacy);

  // The kickoff it recorded may still be running, and close needs to find it.
  assert.deepEqual(ids(fixture), ["wt-old"]);
  assert.equal(
    fs.existsSync(path.join(fixture.dir, ".omt", "active-kickoff.json")),
    false,
  );
  assert.equal(
    releaseKickoff(fixture.org, { worktreeId: "wt-old", reason: "completed" })
      .entry.runId,
    "run-old",
  );
});

// Writes a claim or entry the way a release before the PM rename spelled it.
function beforeRename({ pm, selfPm, ...rest }) {
  return {
    ...rest,
    coordinator: pm,
    ...(selfPm === undefined ? {} : { selfCoordinator: selfPm }),
  };
}

test("an entry stored under the old coordinator key lists, binds and releases as pm", (t) => {
  const fixture = project(t);
  const stored = beforeRename({
    schemaVersion: 1,
    ...claimFor(fixture, "wt-renamed"),
    runId: null,
    createdAt: "2026-09-16T00:00:00.000Z",
  });
  const legacyLease = path.join(fixture.dir, ".omt", "active-kickoff.json");
  writeJSON(legacyLease, stored);

  // A kickoff registered before the rename may still be running; close must
  // find it, and the next write stores it under the current key.
  const [listed] = listKickoffs(fixture.org).kickoffs;
  assert.equal(listed.pm.worktreeId, "wt-renamed");
  assert.equal(Object.hasOwn(listed, "coordinator"), false);

  const bound = bindKickoffRun(fixture.org, {
    worktreeId: "wt-renamed",
    runId: "run-r",
  });
  const rewritten = readJSON(bound.file);
  assert.equal(rewritten.pm.worktreeId, "wt-renamed");
  assert.equal(Object.hasOwn(rewritten, "coordinator"), false);

  const released = releaseKickoff(fixture.org, {
    worktreeId: "wt-renamed",
    reason: "completed",
  });
  assert.equal(readJSON(released.archived).pm.worktreeId, "wt-renamed");
  assert.deepEqual(ids(fixture), []);
});

test("registry files stored with the old keys read as pm before any write", (t) => {
  const fixture = project(t);
  const directory = registryDirectory(fixture.org);
  fs.mkdirSync(directory, { recursive: true });
  const reason = "orca is not installed; the user approved supervising here";
  const old = (worktreeId, extra = {}) =>
    beforeRename({
      schemaVersion: 1,
      ...claimFor(fixture, worktreeId),
      runId: null,
      createdAt: "2026-09-16T00:00:00.000Z",
      ...extra,
    });
  // A hashed entry, and one an earlier release named after the id itself.
  const hashed = path.join(
    directory,
    `${crypto.createHash("sha256").update("wt-hashed").digest("hex")}.json`,
  );
  writeJSON(hashed, old("wt-hashed", { selfPm: reason }));
  const idNamed = path.join(directory, "wt-named.json");
  writeJSON(idNamed, old("wt-named"));
  const before = [hashed, idNamed].map((file) => fs.readFileSync(file, "utf8"));

  const listed = listKickoffs(fixture.org).kickoffs;
  assert.deepEqual(
    listed.map((entry) => entry.pm.worktreeId),
    ["wt-hashed", "wt-named"],
  );
  assert.equal(listed[0].selfPm, reason);
  assert.ok(listed.every((entry) => !Object.hasOwn(entry, "coordinator")));
  // Listing is a read: the files keep their old spelling until a write.
  assert.deepEqual(
    [hashed, idNamed].map((file) => fs.readFileSync(file, "utf8")),
    before,
  );

  const bound = bindKickoffRun(fixture.org, {
    worktreeId: "wt-named",
    runId: "run-n",
  });
  const rewritten = readJSON(bound.file);
  assert.equal(rewritten.pm.worktreeId, "wt-named");
  assert.equal(Object.hasOwn(rewritten, "coordinator"), false);
});

test("a claim written with the old keys still registers under the new ones", (t) => {
  const fixture = project(t);
  const reason =
    "orca is not installed (command not found); the user approved supervising here";
  const own = claimFor(fixture, "wt-self");
  own.pm = {
    ...own.pm,
    path: fixture.dir,
    stateDir: path.join(fixture.dir, ".omt"),
  };

  const claimed = registerKickoff(
    fixture.org,
    beforeRename({ ...own, selfPm: reason }),
  );
  assert.equal(claimed.entry.pm.path, fixture.dir);
  assert.equal(claimed.entry.selfPm, reason);
  const stored = readJSON(claimed.file);
  assert.equal(Object.hasOwn(stored, "coordinator"), false);
  assert.equal(Object.hasOwn(stored, "selfCoordinator"), false);
});

test("a claim naming a different worktree under each spelling is refused", (t) => {
  const fixture = project(t);
  const claim = claimFor(fixture, "wt-a");
  const conflicting = { ...claim, coordinator: claimFor(fixture, "wt-b").pm };
  assert.throws(
    () => registerKickoff(fixture.org, conflicting),
    /both coordinator and pm with different values/,
  );
  // The same value under both spellings is one statement, not a conflict.
  assert.equal(
    registerKickoff(fixture.org, { ...claim, coordinator: claim.pm }).entry.pm
      .worktreeId,
    "wt-a",
  );
  assert.deepEqual(ids(fixture), ["wt-a"]);
});

test("branch cleanup skips branches when delivery is not confirmed", (t) => {
  const fixture = project(t);
  // An entry with delivery.mode === "none" has no merge commit to verify against.
  const result = cleanupKickoffBranches({
    projectDir: fixture.dir,
    entry: {
      delivery: { mode: "none" },
    },
    branches: ["feat/my-kickoff"],
  });
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.skipped, ["feat/my-kickoff"]);
});

test("branch cleanup skips when delivered record is absent", (t) => {
  const fixture = project(t);
  // local-merge entry without a delivered record: merge not yet recorded.
  const result = cleanupKickoffBranches({
    projectDir: fixture.dir,
    entry: {
      delivery: { mode: "local-merge", branch: "main" },
      // delivered is intentionally absent
    },
    branches: ["feat/my-kickoff"],
  });
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.skipped, ["feat/my-kickoff"]);
});

test("branch cleanup deletes branches whose content has reached the merge commit", (t) => {
  // Build a temporary Git repository so no live branches are touched.
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-branch-cleanup-"));
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  const remoteDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "omt-branch-cleanup-remote-"),
  );
  t.after(() => fs.rmSync(remoteDir, { recursive: true, force: true }));

  // Initialise the bare remote and the local clone.
  const git = (args, cwd = repoDir) =>
    execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
  execFileSync("git", ["init", "--bare", remoteDir], { stdio: "pipe" });
  git(["init", "--initial-branch=main", repoDir], os.tmpdir());
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["remote", "add", "local-remote", remoteDir]);

  // Create an initial commit on main.
  fs.writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  git(["add", "README.md"]);
  git(["commit", "--message", "initial"]);
  git(["push", "local-remote", "main"]);

  // Create the kickoff branch off main.
  git(["checkout", "-b", "feat/kickoff-work"]);
  fs.writeFileSync(path.join(repoDir, "work.txt"), "work\n");
  git(["add", "work.txt"]);
  git(["commit", "--message", "kickoff work"]);
  const kickoffHead = git(["rev-parse", "HEAD"]);
  git(["push", "local-remote", "feat/kickoff-work"]);

  // Merge the kickoff branch into main (simulating deliver).
  git(["checkout", "main"]);
  git(["merge", "--no-ff", "feat/kickoff-work", "--message", "merge kickoff"]);
  const mergeCommit = git(["rev-parse", "HEAD"]);
  git(["push", "local-remote", "main"]);

  // The entry records the merge commit as delivery proof.
  const entry = {
    delivery: { mode: "local-merge", branch: "main" },
    delivered: { head: kickoffHead, mergeCommit },
  };

  const result = cleanupKickoffBranches({
    projectDir: repoDir,
    entry,
    branches: ["feat/kickoff-work"],
    remoteName: "local-remote",
  });

  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.deleted, ["feat/kickoff-work"]);
  // The local branch no longer exists.
  assert.throws(() =>
    execFileSync("git", ["rev-parse", "refs/heads/feat/kickoff-work"], {
      cwd: repoDir,
      stdio: "pipe",
    }),
  );
});
