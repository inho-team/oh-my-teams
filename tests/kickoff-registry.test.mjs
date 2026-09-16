/** The kickoff registry: many kickoffs per project, one per coordinator. */
import test from "node:test";
import assert from "node:assert/strict";
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
  listKickoffs,
  registerKickoff,
  registryDirectory,
  releaseKickoff,
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

const ids = (fixture) =>
  listKickoffs(fixture.org).kickoffs.map(
    (entry) => entry.coordinator.worktreeId,
  );

test("the registry lives with the organization it serves", (t) => {
  const fixture = project(t);
  // An entry inside a coordinator worktree cannot be seen by the session that
  // closes it: .omt is a separate directory in every worktree.
  assert.equal(
    registryDirectory(fixture.org),
    path.join(fixture.dir, ".omt", "kickoffs"),
  );
  assert.deepEqual(listKickoffs(fixture.org), { active: false, kickoffs: [] });
});

test("a project runs several kickoffs, each from its own coordinator", (t) => {
  const fixture = project(t);
  registerKickoff(fixture.org, claimFor(fixture, "wt-a"));
  registerKickoff(fixture.org, claimFor(fixture, "wt-b"));
  assert.deepEqual(ids(fixture), ["wt-a", "wt-b"]);
  assert.deepEqual(
    listKickoffs(fixture.org, "wt-b").kickoffs.map((entry) => entry.goal),
    ["deliver wt-b"],
  );

  // A coordinator session owns one Goal and binds one Run, so a second kickoff
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
  // The brief is what the coordinator reads instead of the parent
  // conversation, so an entry naming one never written hands it nothing.
  assert.throws(() => registerKickoff(fixture.org, missingBrief), /Brief file/);

  const stale = { ...claimFor(fixture, "wt-a"), organizationRevision: 99 };
  assert.throws(() => registerKickoff(fixture.org, stale), /revision/);
  assert.equal(listKickoffs(fixture.org).active, false);
});

test("each coordinator binds its own Run, and only once", (t) => {
  const fixture = project(t);
  registerKickoff(fixture.org, claimFor(fixture, "wt-a"));
  registerKickoff(fixture.org, claimFor(fixture, "wt-b"));

  bindKickoffRun(fixture.org, { worktreeId: "wt-a", runId: "run-a" });
  bindKickoffRun(fixture.org, { worktreeId: "wt-b", runId: "run-b" });
  // Re-running the same bind after a lost receipt must not look like a
  // conflict, while a different Run means the coordinator split its work.
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
  assert.equal(archived.coordinator.worktreeId, "wt-a");
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
  claim.coordinator = { ...claim.coordinator, worktreeId };

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
  assert.equal(readJSON(released.archived).coordinator.worktreeId, worktreeId);
  assert.deepEqual(ids(fixture), []);
});

test("no worktree id writes outside the registry", (t) => {
  const fixture = project(t);
  const worktreeId = "../../escaped";
  const claim = claimFor(fixture, "wt-escape");
  claim.coordinator = { ...claim.coordinator, worktreeId };

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
    refused.coordinator = { ...refused.coordinator, worktreeId: bad };
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

test("ending a kickoff whose coordinator cannot be reached is a forced decision", (t) => {
  const fixture = project(t);
  registerKickoff(fixture.org, claimFor(fixture, "wt-a"));
  // An unverifiable coordinator may still be running, so a takeover is never
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

test("two coordinators each create a workflow in their own state", async (t) => {
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
      claim.coordinator.stateDir,
    ]);
    // The single-kickoff release refused the second coordinator here. Whatever
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
