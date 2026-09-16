/** The one-active-kickoff claim, and what it refuses. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJSON, run } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  bindKickoffRun,
  claimKickoff,
  leaseFile,
  readLease,
  releaseKickoff,
} from "../plugins/oh-my-teams/scripts/kickoff-lease.mjs";

const cli = path.resolve("plugins/oh-my-teams/scripts/teams-org.mjs");
const exampleOrg = path.resolve(
  "plugins/oh-my-teams/examples/organization.json",
);

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-lease-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const org = path.join(dir, ".omt", "organization.json");
  fs.mkdirSync(path.dirname(org), { recursive: true });
  fs.copyFileSync(exampleOrg, org);
  const brief = path.join(dir, "brief.md");
  fs.writeFileSync(brief, "goal, acceptance criteria, non-goals\n");
  return { dir, org, brief };
}

function claimFor(fixture, worktreeId) {
  const coordinator = path.join(fixture.dir, worktreeId);
  return {
    goal: `deliver ${worktreeId}`,
    coordinator: {
      worktreeId,
      path: coordinator,
      stateDir: path.join(coordinator, ".omt"),
    },
    organizationRevision: readJSON(fixture.org).revision,
    brief: fixture.brief,
  };
}

test("the lease lives with the organization it protects", (t) => {
  const fixture = project(t);
  // A lease inside the coordinator worktree cannot be seen by the session that
  // has to check it: .omt is a separate directory in every worktree.
  assert.equal(
    leaseFile(fixture.org),
    path.join(fixture.dir, ".omt", "active-kickoff.json"),
  );
});

test("a second kickoff is refused while one is held", (t) => {
  const fixture = project(t);
  claimKickoff(fixture.org, claimFor(fixture, "wt-a"));

  assert.throws(
    () => claimKickoff(fixture.org, claimFor(fixture, "wt-b")),
    /Active kickoff already held by wt-a/,
  );
  assert.equal(readLease(fixture.org).lease.coordinator.worktreeId, "wt-a");
});

test("two sessions racing for an unclaimed project produce one holder", async (t) => {
  const fixture = project(t);
  const files = ["wt-a", "wt-b"].map((worktreeId) => {
    const file = path.join(fixture.dir, `${worktreeId}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(claimFor(fixture, worktreeId), null, 2),
    );
    return file;
  });

  // Both processes find the project unclaimed at the same moment. Reading
  // before writing is not enough on its own; the exclusive lock is what makes
  // the loser see the winner's lease instead of overwriting it.
  const results = await Promise.all(
    files.map((file) =>
      run([
        process.execPath,
        cli,
        "kickoff-claim",
        "--org",
        fixture.org,
        "--from",
        file,
      ]),
    ),
  );

  const winners = results.filter((result) => result.code === 0);
  assert.equal(winners.length, 1, results.map((r) => r.stderr).join(" | "));
  const held = readLease(fixture.org).lease.coordinator.worktreeId;
  assert.match(winners[0].stdout, new RegExp(held));
});

test("a claim needs a written brief and the current organization revision", (t) => {
  const fixture = project(t);
  const missingBrief = {
    ...claimFor(fixture, "wt-a"),
    brief: path.join(fixture.dir, "never-written.md"),
  };
  // The brief is what the coordinator reads instead of the parent
  // conversation, so a claim that names one it never wrote hands the
  // coordinator nothing to start from.
  assert.throws(() => claimKickoff(fixture.org, missingBrief), /Brief file/);

  const stale = { ...claimFor(fixture, "wt-a"), organizationRevision: 99 };
  assert.throws(() => claimKickoff(fixture.org, stale), /revision/);
  assert.equal(readLease(fixture.org).active, false);
});

test("only the holder binds its Run, and only once", (t) => {
  const fixture = project(t);
  claimKickoff(fixture.org, claimFor(fixture, "wt-a"));

  assert.throws(
    () => bindKickoffRun(fixture.org, { worktreeId: "wt-b", runId: "run-2" }),
    /held by wt-a/,
  );
  const bound = bindKickoffRun(fixture.org, {
    worktreeId: "wt-a",
    runId: "run-1",
  });
  assert.equal(bound.lease.runId, "run-1");

  // Re-running the same bind after a lost receipt must not look like a
  // conflict, while a genuinely different Run means two competing Runs.
  assert.equal(
    bindKickoffRun(fixture.org, { worktreeId: "wt-a", runId: "run-1" }).lease
      .runId,
    "run-1",
  );
  assert.throws(
    () => bindKickoffRun(fixture.org, { worktreeId: "wt-a", runId: "run-9" }),
    /already bound to run run-1/,
  );
});

test("a release names the coordinator it ends, and keeps the record", (t) => {
  const fixture = project(t);
  claimKickoff(fixture.org, claimFor(fixture, "wt-a"));

  assert.throws(
    () =>
      releaseKickoff(fixture.org, {
        worktreeId: "wt-b",
        reason: "completed",
      }),
    /held by wt-a/,
  );

  const released = releaseKickoff(fixture.org, {
    worktreeId: "wt-a",
    reason: "disbanded",
  });
  const archived = readJSON(released.archived);
  assert.equal(archived.releaseReason, "disbanded");
  assert.equal(archived.coordinator.worktreeId, "wt-a");
  assert.equal(readLease(fixture.org).active, false);

  // A failed kickoff that keeps the lease blocks every later one, so the
  // project must be claimable again immediately after a disband.
  assert.equal(
    claimKickoff(fixture.org, claimFor(fixture, "wt-b")).claimed,
    true,
  );
});

test("taking a lease from an unreachable coordinator is a forced decision", (t) => {
  const fixture = project(t);
  claimKickoff(fixture.org, claimFor(fixture, "wt-a"));

  // An unverifiable coordinator may still be running, so a takeover is never
  // the automatic consequence of a failed query.
  assert.throws(
    () =>
      releaseKickoff(fixture.org, {
        worktreeId: "wt-b",
        reason: "taken-over",
      }),
    /explicit authorization/,
  );
  const taken = releaseKickoff(fixture.org, {
    worktreeId: "wt-b",
    reason: "taken-over",
    force: true,
  });
  assert.equal(readJSON(taken.archived).releasedBy, "wt-b");
});

test("workflow-create refuses a coordinator the project did not claim", async (t) => {
  const fixture = project(t);
  const claim = claimFor(fixture, "wt-a");
  claimKickoff(fixture.org, claim);
  const workflow = path.resolve("plugins/oh-my-teams/examples/workflow.json");

  // Concurrency slots and the call budget are counted inside one workflow
  // state, so a second coordinator spends the same subscription while seeing
  // none of the first one's reservations.
  const intruder = await run([
    process.execPath,
    cli,
    "workflow-create",
    "--workflow",
    workflow,
    "--org",
    fixture.org,
    "--state",
    path.join(fixture.dir, "wt-b", ".omt"),
  ]);
  assert.equal(intruder.code, 1);
  assert.match(intruder.stderr, /Active kickoff is held by wt-a/);

  const holder = await run([
    process.execPath,
    cli,
    "workflow-create",
    "--workflow",
    workflow,
    "--org",
    fixture.org,
    "--state",
    claim.coordinator.stateDir,
  ]);
  assert.doesNotMatch(holder.stderr, /Active kickoff is held by/);
});
