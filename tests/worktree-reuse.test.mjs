/** Repeated reuse, source rejection and uncertain transfer regressions. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertDirectorySync } from "../plugins/oh-my-teams/scripts/core.mjs";
import { withAutomaticWorktreeReuse } from "../plugins/oh-my-teams/scripts/worktree-reuse.mjs";
import { readWorktreeTransitions } from "../plugins/oh-my-teams/scripts/worktree-transactions.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omt-reuse-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const orgFile = path.join(root, "organization.json");
  fs.writeFileSync(orgFile, "{}");
  const parents = ["a", "b", "c"].map((name) => {
    const location = path.join(root, name);
    fs.mkdirSync(location);
    return {
      id: `repo::${location}`,
      path: location,
      repoId: "repo",
      identity: { key: name, instanceId: name, executionHostId: "local" },
    };
  });
  const child = {
    id: `repo::${root}/child`,
    path: `${root}/child`,
    repoId: "repo",
    head: "head",
    branch: "refs/heads/fix/child",
    identity: {
      key: "child-key",
      instanceId: "child-instance",
      executionHostId: "local",
    },
    childWorktreeIds: [],
  };
  function parentTo(parent, origin = "cli") {
    child.parentWorktreeId = parent.id;
    child.lineage = {
      worktreeId: child.id,
      worktreeInstanceId: child.identity.instanceId,
      parentWorktreeId: parent.id,
      parentWorktreeInstanceId: parent.identity.instanceId,
      origin,
      capture: { confidence: "explicit" },
    };
  }
  parentTo(parents[0]);
  let target = parents[1];
  const entry = (parent) => ({
    pm: {
      worktreeId: parent.id,
      path: parent.path,
      stateDir: `${parent.path}/.omt`,
    },
  });
  const source = (parent, workflowId, taskId) => ({
    entry: entry(parent),
    workflowId,
    taskId,
    worktreeId: child.id,
    task: { state: "accepted" },
  });
  let sources = [source(parents[0], "old", "first")];
  let mutations = 0;
  let scannedStatus = "safe-to-remove";
  const ports = {
    discover: () => ({
      current: entry(target),
      candidates: sources,
      rejected: [],
    }),
    show: async (_executable, args) => {
      const id = args.at(-1).slice(3);
      return {
        result: {
          worktree: structuredClone(
            id === child.id ? child : parents.find((item) => item.id === id),
          ),
        },
      };
    },
    scan: async () => ({
      inventoryComplete: true,
      candidates: [
        {
          worktreeId: child.id,
          path: child.path,
          status: scannedStatus,
          reasons: ["source-preserved"],
          instanceId: child.identity.instanceId,
          hostId: "local",
          git: { head: "head" },
        },
      ],
    }),
    gitCommand: async (_repo, args) => (args[0] === "rev-parse" ? "head" : ""),
    reparent: async () => {
      mutations += 1;
      parentTo(target, "manual");
      return { ok: true };
    },
  };
  const request = () => ({
    orgFile,
    repo: target.path,
    workflowId: target.identity.key,
    taskId: "next",
    base: "head",
    role: "worker",
  });
  return {
    orgFile,
    ports,
    parents,
    child,
    source,
    request,
    mutations: () => mutations,
    setTarget: (parent) => {
      target = parent;
    },
    setSources: (value) => {
      sources = value;
    },
    preserve: () => {
      scannedStatus = "preserve";
    },
  };
}

test("an old accepted source cannot hide a later eligible owner during repeated transfers", async (t) => {
  const f = fixture(t);
  try {
    assertDirectorySync(path.dirname(f.orgFile));
  } catch (error) {
    assert.equal(error.code, "worktree-durability-unavailable");
    await assert.rejects(
      () =>
        withAutomaticWorktreeReuse(
          f.request(),
          () => assert.fail("unsafe launch"),
          f.ports,
        ),
      { code: error.code },
    );
    assert.equal(f.mutations(), 0);
    return;
  }
  await withAutomaticWorktreeReuse(
    f.request(),
    async (selected) => ({ selected: selected.taskId }),
    f.ports,
  );
  f.setTarget(f.parents[2]);
  const old = f.source(f.parents[0], "old", "first");
  const latest = f.source(f.parents[1], "b", "next");
  f.setSources([old, latest]);
  const result = await withAutomaticWorktreeReuse(
    f.request(),
    async (selected) => ({ selected: selected.taskId }),
    f.ports,
  );
  assert.equal(result.selected, "next");
  assert.equal(f.mutations(), 2);
  assert.ok(
    result.reuseRejections.some(
      (item) => item.reason === "source-ownership-retired",
    ),
  );
  assert.equal(readWorktreeTransitions(f.orgFile).entries.length, 2);
});

test("current parent mismatch refuses reuse even with a completed previous receipt", async (t) => {
  const f = fixture(t);
  try {
    assertDirectorySync(path.dirname(f.orgFile));
  } catch (error) {
    assert.equal(error.code, "worktree-durability-unavailable");
    await assert.rejects(
      () =>
        withAutomaticWorktreeReuse(
          f.request(),
          () => assert.fail("unsafe launch"),
          f.ports,
        ),
      { code: error.code },
    );
    assert.equal(f.mutations(), 0);
    return;
  }
  await withAutomaticWorktreeReuse(f.request(), async () => ({}), f.ports);
  f.setTarget(f.parents[2]);
  f.setSources([f.source(f.parents[1], "b", "next")]);
  f.child.parentWorktreeId = f.parents[0].id;
  const result = await withAutomaticWorktreeReuse(
    f.request(),
    async (selected) => ({ fresh: selected === null }),
    f.ports,
  );
  assert.equal(result.fresh, true);
  assert.equal(f.mutations(), 1);
  assert.ok(
    result.reuseRejections.some(
      (item) => item.reason === "source-lineage-unproven",
    ),
  );
});

test("a preserved source falls back without preparing a transfer", async (t) => {
  const f = fixture(t);
  f.preserve();
  const result = await withAutomaticWorktreeReuse(
    f.request(),
    async (selected) => ({ fresh: selected === null }),
    f.ports,
  );
  assert.equal(result.fresh, true);
  assert.equal(f.mutations(), 0);
  assert.deepEqual(readWorktreeTransitions(f.orgFile).entries, []);
});

test("a changed instance after mutation leaves a prepared journal and blocks retries", async (t) => {
  const f = fixture(t);
  try {
    assertDirectorySync(path.dirname(f.orgFile));
  } catch (error) {
    assert.equal(error.code, "worktree-durability-unavailable");
    await assert.rejects(
      () =>
        withAutomaticWorktreeReuse(
          f.request(),
          () => assert.fail("unsafe launch"),
          f.ports,
        ),
      { code: error.code },
    );
    assert.equal(f.mutations(), 0);
    return;
  }
  const reparent = f.ports.reparent;
  f.ports.reparent = async (...args) => {
    await reparent(...args);
    f.child.identity.key = "replacement";
  };
  await assert.rejects(
    () =>
      withAutomaticWorktreeReuse(
        f.request(),
        async () => assert.fail("unverified launch"),
        f.ports,
      ),
    /Post-transfer/,
  );
  assert.equal(
    readWorktreeTransitions(f.orgFile).entries[0].status,
    "prepared",
  );
  await assert.rejects(
    () =>
      withAutomaticWorktreeReuse(
        f.request(),
        async () => assert.fail("retry"),
        f.ports,
      ),
    /Unresolved/,
  );
  assert.equal(f.mutations(), 1);
});

async function discoveryFixture(t) {
  const { writeJSON, readJSON } =
    await import("../plugins/oh-my-teams/scripts/core.mjs");
  const { registerKickoff } =
    await import("../plugins/oh-my-teams/scripts/kickoff-registry.mjs");
  const { minimalRequirements } =
    await import("./requirements-draft-fixture.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omt-source-proof-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const orgFile = path.join(root, ".omt", "organization.json");
  const organization = readJSON(
    path.resolve("plugins/oh-my-teams/examples/organization.json"),
  );
  writeJSON(orgFile, organization);
  const pm = path.join(root, "pm");
  const stateDir = path.join(pm, ".omt");
  const pmId = `repo::${pm}`;
  const brief = path.join(root, "brief.md");
  fs.writeFileSync(brief, "source-proof fixture");
  const registered = registerKickoff(orgFile, {
    goal: "source-proof",
    pm: { worktreeId: pmId, path: pm, stateDir },
    brief,
    delivery: { mode: "none" },
    organizationRevision: organization.revision,
    requirements: minimalRequirements(orgFile, pmId),
    director: { terminalHandle: "director", checkoutPath: root },
  });
  const task = {
    state: "accepted",
    role: "worker",
    worktreeId: `repo::${root}/child`,
    revision: 1,
    attemptId: "attempt-1",
    taskHash: "task-hash",
    workerRunId: "execution-1",
    acceptedResult: "decision-1",
  };
  const workflow = {
    status: "accepted",
    tasks: { source: task },
    integration: {
      taskHash: "integration-hash",
      decision: {
        decisionId: "integration-1",
        runId: "integration-run",
        evidenceKey: "integration-evidence",
        componentResults: {
          source: {
            revision: 1,
            attemptId: "attempt-1",
            acceptedResult: "decision-1",
          },
        },
      },
    },
  };
  const directory = path.join(stateDir, "workflows", "source-flow");
  writeJSON(path.join(directory, "organization.json"), organization);
  writeJSON(path.join(directory, "tasks", "source", "revisions", "1.json"), {
    id: "source",
  });
  writeJSON(path.join(stateDir, "decisions", "decision-1.json"), {
    id: "decision-1",
    status: "accepted",
    taskId: "source",
    taskHash: "task-hash",
    implementationExecutionId: "execution-1",
  });
  writeJSON(path.join(stateDir, "decisions", "integration-1.json"), {
    status: "accepted",
    taskHash: "integration-hash",
    implementationExecutionId: "integration-run",
    evidenceKey: "integration-evidence",
  });
  const { recordLaunch } =
    await import("../plugins/oh-my-teams/scripts/usage-ledger.mjs");
  recordLaunch(orgFile, {
    via: "worker-start",
    role: "worker",
    worktreePath: `${root}/child`,
    stateDir,
    workflowId: "source-flow",
    workflowTaskId: "source",
    worktreeProtocolVersion: 1,
    terminal: "source-terminal",
    workerId: "source-dispatch",
  });
  const save = () => writeJSON(path.join(directory, "state.json"), workflow);
  save();
  return {
    orgFile,
    registryFile: registered.file,
    workflow,
    save,
    target: {
      stateDir,
      workflowId: "target-flow",
      taskId: "target",
      role: "worker",
    },
  };
}

test("active cross-workflow discovery requires matching integration task, attempt and revision", async (t) => {
  const { discoverReusableWorktrees } =
    await import("../plugins/oh-my-teams/scripts/worktree-reuse.mjs");
  const f = await discoveryFixture(t);
  assert.equal(
    discoverReusableWorktrees(f.orgFile, f.target).candidates.length,
    1,
  );
  const original = structuredClone(f.workflow.integration);
  for (const mutate of [
    () => {
      f.workflow.integration = {};
    },
    () => {
      f.workflow.integration.decision.componentResults.source.attemptId =
        "another";
    },
    () => {
      f.workflow.integration.decision.componentResults.source.revision = 2;
    },
    () => {
      f.workflow.integration.decision.componentResults.source.acceptedResult =
        "another";
    },
    () => {
      f.workflow.status = "running";
    },
  ]) {
    f.workflow.integration = structuredClone(original);
    f.workflow.status = "accepted";
    mutate();
    f.save();
    const result = discoverReusableWorktrees(f.orgFile, f.target);
    assert.equal(result.candidates.length, 0);
    assert.ok(
      result.rejected.some(
        (item) => item.reason === "source-integration-decision-mismatch",
      ),
    );
  }
});

test("a legacy active source remains ineligible even with accepted integration", async (t) => {
  const { readJSON, writeJSON } =
    await import("../plugins/oh-my-teams/scripts/core.mjs");
  const f = await discoveryFixture(t);
  const entry = readJSON(f.registryFile);
  delete entry.reuseProtocol;
  writeJSON(f.registryFile, entry);
  const result = await withAutomaticWorktreeReuse(
    { orgFile: f.orgFile, ...f.target, repo: path.dirname(f.target.stateDir) },
    async (candidate) => ({ fresh: candidate === null }),
    {
      show: async () =>
        assert.fail(
          "legacy source must never reach Orca mutation or identity lookup",
        ),
      reparent: async () => assert.fail("legacy source must not transfer"),
    },
  );
  assert.equal(result.fresh, true);
  assert.ok(
    result.reuseRejections.some(
      (item) =>
        item.reason === "source-protocol-not-participating-at-registration",
    ),
  );
  assert.ok(fs.existsSync(f.registryFile));
});

test("directory fsync failure never becomes a transfer or a fresh-worktree fallback", async (t) => {
  const f = fixture(t);
  t.mock.method(fs, "fsyncSync", () => {
    throw Object.assign(new Error("unsupported directory synchronization"), {
      code: "EINVAL",
    });
  });
  await assert.rejects(
    () =>
      withAutomaticWorktreeReuse(
        f.request(),
        async () => assert.fail("must not launch or create"),
        f.ports,
      ),
    (error) => error.code === "worktree-durability-unavailable",
  );
  assert.equal(f.mutations(), 0);
  assert.equal(f.child.parentWorktreeId, f.parents[0].id);
  assert.deepEqual(readWorktreeTransitions(f.orgFile).entries, []);
});
