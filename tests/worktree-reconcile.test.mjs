/** Synthetic-only regressions for interrupted reclaim preservation and refusal boundaries. */
import test from "node:test";
import { reclaimIntegratedRoleWorktree } from "../plugins/oh-my-teams/scripts/teams-org.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import vm from "node:vm";
import { scanKickoffCleanup } from "../plugins/oh-my-teams/scripts/kickoff-cleanup.mjs";
import { hash, readJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  kickoffHashFor,
  kickoffEntryName,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";
import {
  reconcilePreparedRoleWorktree,
  adoptLegacyRoleWorktree,
  assertHostInventory,
} from "../plugins/oh-my-teams/scripts/worktree-reconcile.mjs";
import {
  reconcileWorktreeTransition,
  withWorktreeLock,
  readWorktreeTransitions,
  transactWorktree,
} from "../plugins/oh-my-teams/scripts/worktree-transactions.mjs";
import { durableSuccessSupported } from "./directory-durability-fixture.mjs";
import { readTerminalClosures } from "../plugins/oh-my-teams/scripts/usage-ledger.mjs";

const source = gunzipSync(
  Buffer.from(
    readJSON(new URL("./fixtures/reclaim-source-0dc.json", import.meta.url))
      .gzipBase64,
    "base64",
  ),
).toString("utf8");
const head = "a".repeat(40);
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}
function fixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "omt-reconcile-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const org = path.join(root, ".omt/organization.json");
  const pm = path.join(root, "pm");
  const childPath = path.join(root, "child");
  fs.mkdirSync(pm);
  fs.mkdirSync(childPath);
  const owner = {
    schemaVersion: 1,
    goal: "fixture",
    brief: "fixture.md",
    organizationRevision: 1,
    createdAt: "2026-01-01T00:00:00Z",
    registrationSeq: 1,
    runId: "run_fixture",
    pm: {
      worktreeId: `repo::${pm}`,
      path: pm,
      stateDir: path.join(pm, ".omt"),
    },
    director: { checkoutPath: root, terminalHandle: "director" },
  };
  const identity = {
    key: "wt2:local:instance",
    instanceId: "instance",
    executionHostId: "local",
  };
  const child = {
    id: `repo::${childPath}`,
    path: childPath,
    head,
    parentWorktreeId: owner.pm.worktreeId,
    identity,
    childWorktreeIds: [],
    repoId: "repo",
    createdAt: Date.parse("2026-01-01T00:30:00Z"),
    lineage: {
      worktreeId: `repo::${childPath}`,
      worktreeInstanceId: "instance",
      parentWorktreeId: owner.pm.worktreeId,
      parentWorktreeInstanceId: "parent-instance",
      origin: "cli",
      capture: { confidence: "explicit" },
      createdAt: Date.parse("2026-01-01T00:30:00Z"),
    },
  };
  const parent = {
    id: owner.pm.worktreeId,
    path: pm,
    repoId: "repo",
    identity: {
      key: "parent",
      instanceId: "parent-instance",
      executionHostId: "local",
    },
  };
  const entry = {
    id: "interrupted",
    type: "role-reclaim",
    worktreeId: child.id,
    sourceWorktreeId: owner.pm.worktreeId,
    identityKey: identity.key,
    status: "prepared",
    startedAt: "2026-01-01T04:00:00Z",
  };
  const task = {
    state: "accepted",
    revision: 1,
    taskHash: "task-hash",
    acceptedResult: "accepted",
    workerRunId: "ctx_worker",
    worktreeId: child.id,
    attemptId: "attempt",
    attempts: [
      {
        id: "attempt",
        attachedAt: "2026-01-01T01:00:00Z",
        receipt: {
          executionId: "ctx_worker",
          worktreeId: child.id,
          terminal: "terminal",
        },
      },
    ],
  };
  const workflow = { tasks: { task } };
  const log = path.join(owner.pm.stateDir, "evidence/log.txt");
  const fingerprint = { head, base: head };
  const evidence = {
    key: hash(fingerprint),
    fingerprint,
    status: "passed",
    unchanged: true,
    checks: [{ code: 0, log, logHash: hash("pass") }],
  };
  const acceptance = {
    status: "accepted",
    taskId: "task",
    taskRevision: 1,
    taskHash: task.taskHash,
    implementationExecutionId: "ctx_worker",
    evidenceKey: evidence.key,
    createdAt: "2026-01-01T02:00:00Z",
  };
  const launch = {
    via: "worker-start",
    at: "2026-01-01T01:00:00Z",
    terminal: "terminal",
    workerId: "ctx_worker",
    worktreePath: childPath,
    kickoffPmWorktreeId: owner.pm.worktreeId,
    workflowId: "flow",
    workflowTaskId: "task",
  };
  const receipt = (result) => ({
    id: "request",
    ok: true,
    result,
    _meta: { runtimeId: "runtime" },
  });
  const listed = (terminals = []) =>
    receipt({
      terminals,
      totalCount: terminals.length,
      truncated: false,
      hostScope: { hostIds: ["local"], omittedHostIds: ["unrelated"] },
    });
  const closure = {
    at: "2026-01-01T03:00:00Z",
    worktreeId: child.id,
    worktreePath: childPath,
    identity,
    terminals: [
      {
        terminal: "terminal",
        workerIds: ["ctx_worker"],
        dispatch: { result: { status: "clear" } },
        releases: [
          {
            dispatchId: "ctx_worker",
            receipt: receipt({
              dispatchId: "ctx_worker",
              state: "retained",
              reason: "external_terminal",
              processAction: "none",
            }),
          },
        ],
        close: {
          receipt: receipt({
            close: { handle: "terminal", tabId: "tab", ptyKilled: true },
          }),
        },
      },
    ],
    beforeReceipt: listed([
      {
        handle: "terminal",
        worktreeId: child.id,
        executionHostId: "local",
        tabId: "tab",
        incarnationId: "inc",
      },
    ]),
    afterReceipt: listed(),
  };
  const request = {
    schemaVersion: 1,
    org,
    entryId: entry.id,
    ownerWorktreeId: owner.pm.worktreeId,
    worktreeId: child.id,
    expectedHead: head,
    identityKey: identity.key,
    workflowId: "flow",
    taskId: "task",
    kickoffHash: kickoffHashFor(owner),
  };
  const argv = [
    "node",
    path.join(pm, "plugins/oh-my-teams/scripts/teams-org.mjs"),
    "role-worktree-reclaim",
    "--org",
    org,
    "--state",
    owner.pm.stateDir,
    "--workflow-id",
    "flow",
    "--workflow-task",
    "task",
    "--repo",
    pm,
    "--worktree",
    child.id,
    "--merge-commit",
    head,
  ];
  const execution = { argv, cwd: pm, exitCode: 1, at: "2026-01-01T04:00:01Z" };
  const preparation = {
    head,
    childHead: head,
    exactChild: {
      worktreeId: child.id,
      identity,
      parentWorktreeId: owner.pm.worktreeId,
    },
    observedAt: "2026-01-01T03:30:00Z",
    command: { argv },
  };
  const artifacts = {
    creation: receipt({ worktree: structuredClone(child) }),
    execution,
    preparation,
    stderr:
      "Orca did not prove the worktree terminal list; preserve the worktree\n",
  };
  preparation.childShow = {
    path: path.join(root, "creation.json"),
    sha256: hash(JSON.stringify(artifacts.creation)),
  };
  request.artifacts = {};
  for (const [key, value] of Object.entries(artifacts)) {
    const file = path.join(root, `${key}.json`);
    write(file, value);
    request.artifacts[key] = {
      path: file,
      sha256: hash(fs.readFileSync(file, "utf8")),
    };
  }
  const registryFile = path.join(
    root,
    ".omt/kickoffs",
    `${kickoffEntryName(owner.pm.worktreeId)}.json`,
  );
  const flowDir = path.join(owner.pm.stateDir, "workflows/flow");
  const journal = path.join(root, ".omt/worktree-transitions.json");
  const proofFile = path.join(root, "proof.json");
  write(
    org,
    readJSON(
      new URL(
        "../plugins/oh-my-teams/examples/organization.json",
        import.meta.url,
      ),
    ),
  );
  const persist = () => {
    write(registryFile, owner);
    write(path.join(flowDir, "state.json"), workflow);
    write(path.join(flowDir, "tasks/task/revisions/1.json"), {});
    write(path.join(flowDir, "organization.json"), readJSON(org));
    write(path.join(owner.pm.stateDir, "decisions/accepted.json"), acceptance);
    write(
      path.join(owner.pm.stateDir, "evidence", `${evidence.key}.json`),
      evidence,
    );
    write(log, "pass");
    write(
      path.join(root, ".omt/usage/launches.jsonl"),
      JSON.stringify(launch) + "\n",
    );
    write(
      path.join(root, ".omt/usage/terminal-closures.jsonl"),
      JSON.stringify(closure) + "\n",
    );
    write(journal, { schemaVersion: 1, entries: [entry] });
    request.journalSha256 = hash(fs.readFileSync(journal, "utf8"));
    request.snapshotHash = hash({
      owner,
      workflow,
      task,
      acceptance,
      evidence,
      launches: [launch],
      closures: [closure],
    });
    write(proofFile, request);
  };
  persist();
  const calls = [];
  const ports = {
    git: async (_repo, args) => {
      calls.push(args);
      return args[0] === "show" ? source : args[0] === "rev-parse" ? head : "";
    },
    orca: async (_exe, args) => {
      calls.push(args);
      if (args[0] === "worktree" && args[1] === "show")
        return receipt({
          worktree: structuredClone(
            args.at(-1) === `id:${owner.pm.worktreeId}` ? parent : child,
          ),
        });
      if (args[0] === "worktree")
        return receipt({
          totalCount: 1,
          worktrees: [
            {
              worktreeId: child.id,
              path: child.path,
              parentWorktreeId: owner.pm.worktreeId,
              worktreeInstanceId: child.identity.instanceId,
              hostId: "local",
              childWorktreeIds: [],
            },
          ],
          truncated: false,
          hostScope: { hostIds: ["local"], omittedHostIds: ["unrelated"] },
        });
      if (args[0] === "terminal") return listed();
      if (args[1] === "run-list")
        return receipt({ runs: [{ id: owner.runId }], nextCursor: null });
      if (args[1] === "worker-list")
        return receipt({
          workers: [
            {
              dispatchId: "ctx_worker",
              resource: { worktreeId: child.id },
              terminalState: "released",
              projection: { liveness: { verdict: "exited" } },
            },
          ],
          page: { limit: 100, total: 1, hasMore: false, nextCursor: null },
          scope: { run: owner.runId, source: "flag" },
        });
      throw new Error(`Unexpected Orca call ${args}`);
    },
    scan: async (request) =>
      scanKickoffCleanup(request, { orca: ports.orca, gitCommand: ports.git }),
  };
  const invoke = async () => {
    const cwd = process.cwd();
    process.chdir(root);
    try {
      return await adoptLegacyRoleWorktree(
        {
          org,
          proof: proofFile,
          reason:
            "Director adopts the preserved primary completion material with unknown historical effects.",
          acknowledgment:
            "adopted-exited-invocation-plus-reviewed-control-flow",
        },
        ports,
      );
    } finally {
      process.chdir(cwd);
    }
  };
  return {
    parent,
    artifacts,
    root,
    org,
    owner,
    child,
    entry,
    task,
    workflow,
    acceptance,
    evidence,
    launch,
    closure,
    request,
    journal,
    proofFile,
    registryFile,
    ports,
    calls,
    persist,
    invoke,
  };
}

test("legacy adoption preserves original bytes and unknown effects, reopening only normal gates", async (t) => {
  if (!durableSuccessSupported(t)) return;
  const f = fixture(t);
  const before = fs.readFileSync(f.journal);
  await assert.rejects(() => withWorktreeLock(f.org, () => {}), /Unresolved/);
  const result = await f.invoke();
  assert.equal(result.disposition, "legacy-preservation-adopted");
  assert.equal(result.effects, "unknown");
  assert.equal(result.originalOutcome, "unknown");
  assert.equal(result.availableNativeTrace, false);
  assert.equal(result.reclaimSucceeded, false);
  assert.deepEqual(fs.readFileSync(f.journal), before);
  assert.equal(readWorktreeTransitions(f.org).entries[0].status, "prepared");
  assert.equal(await withWorktreeLock(f.org, () => "allowed"), "allowed");
  assert.equal((await f.invoke()).replayed, true);
  assert(
    f.calls.every(
      (args) =>
        !["remove", "close", "release"].some((word) => args.includes(word)),
    ),
  );
  await transactWorktree(f.org, { type: "branch-cleanup" }, () => ({
    retained: true,
  }));
  assert.equal(readWorktreeTransitions(f.org).entries.length, 2);
});

test("target-host completeness retains unrelated omissions but rejects missing metadata or the target", () => {
  const receipt = {
    _meta: { runtimeId: "r" },
    result: {
      terminals: [],
      totalCount: 0,
      truncated: false,
      hostScope: { hostIds: ["local"], omittedHostIds: ["remote"] },
    },
  };
  assert.doesNotThrow(() => assertHostInventory(receipt, "local", "r"));
  for (const change of [
    (r) => r.result.hostScope.omittedHostIds.push("local"),
    (r) => (r.result.hostScope.hostIds = []),
    (r) => (r.result.truncated = true),
    (r) => (r._meta.runtimeId = "other"),
    (r) => delete r.result.hostScope,
  ]) {
    const altered = structuredClone(receipt);
    change(altered);
    assert.throws(
      () => assertHostInventory(altered, "local", "r"),
      /incomplete/,
    );
  }
});

test("legacy recovery refuses summaries and changed authoritative evidence without changing the journal", async (t) => {
  for (const kind of [
    "dirty",
    "head",
    "instance",
    "parent",
    "active",
    "terminal",
    "host",
    "truncated",
    "source",
    "closure-after",
    "release",
    "log",
    "owner",
    "artifact",
    "summary",
    "malformed-closure",
    "journal-cas",
    "concurrent-head",
    "concurrent-owner",
  ]) {
    await t.test(kind, async (t) => {
      const f = fixture(t);
      if (kind === "dirty") {
        const git = f.ports.git;
        f.ports.git = (repo, args) =>
          args[0] === "status" ? " M dirty" : git(repo, args);
      }
      if (kind === "head") f.child.head = "b".repeat(40);
      if (kind === "instance") f.child.identity.instanceId = "replacement";
      if (kind === "parent") f.child.parentWorktreeId = "other";
      if (kind === "active")
        f.ports.scan = async () => ({
          inventoryComplete: true,
          candidates: [
            {
              worktreeId: f.child.id,
              status: "preserve",
              reasons: ["active-dispatch"],
            },
          ],
        });
      if (["terminal", "host", "truncated"].includes(kind)) {
        const orca = f.ports.orca;
        f.ports.orca = async (exe, args) => {
          const r = await orca(exe, args);
          if (args[0] === "terminal") {
            if (kind === "terminal")
              r.result.terminals.push({
                executionHostId: "local",
                worktreeId: f.child.id,
              });
            if (kind === "host")
              r.result.hostScope.omittedHostIds.push("local");
            if (kind === "truncated") r.result.truncated = true;
          }
          return r;
        };
      }
      if (kind === "source") f.ports.git = async () => "unsupported source";
      if (kind === "closure-after") {
        f.closure.at = "2026-01-01T05:00:00Z";
        f.persist();
      }
      if (kind === "release") {
        f.closure.terminals[0].releases[0].receipt.result.state = "running";
        f.persist();
      }
      if (kind === "log") write(f.evidence.checks[0].log, "changed");
      if (kind === "owner") {
        f.owner.director.checkoutPath = f.owner.pm.path;
        f.persist();
      }
      if (kind === "artifact")
        write(f.request.artifacts.stderr.path, "other failure");
      if (kind === "summary") {
        f.request.snapshotHash = hash({ safeToRemove: true, effects: false });
        write(f.proofFile, f.request);
      }
      if (kind === "malformed-closure")
        fs.appendFileSync(
          path.join(f.root, ".omt/usage/terminal-closures.jsonl"),
          "{partial",
        );
      if (kind === "journal-cas") fs.appendFileSync(f.journal, "\n");
      if (kind === "concurrent-head") {
        const scan = f.ports.scan;
        f.ports.scan = async () => {
          const result = await scan();
          f.child.head = "b".repeat(40);
          return result;
        };
      }
      if (kind === "concurrent-owner") {
        const scan = f.ports.scan;
        f.ports.scan = async () => {
          const result = await scan();
          f.owner.runId = "run_other";
          write(f.registryFile, f.owner);
          return result;
        };
      }
      const before = fs.readFileSync(f.journal);
      await assert.rejects(() => f.invoke());
      assert.deepEqual(fs.readFileSync(f.journal), before);
      assert.equal(
        fs.existsSync(
          path.join(f.root, ".omt/worktree-transition-resolutions.json"),
        ),
        false,
      );
    });
  }
});

test("reconciliation fence, proof crash and conflicting replay never fabricate completion", async (t) => {
  const f = fixture(t);
  const request = {
    entryId: f.entry.id,
    journalSha256: f.request.journalSha256,
    requestHash: "proof",
  };
  await assert.rejects(
    () =>
      reconcileWorktreeTransition(f.org, request, async () => {
        await assert.rejects(
          () => reconcileWorktreeTransition(f.org, request, () => {}),
          /in progress/,
        );
        throw new Error("interrupted proof");
      }),
    /interrupted proof/,
  );
  await assert.rejects(() => withWorktreeLock(f.org, () => {}), /Unresolved/);
  assert.equal(readWorktreeTransitions(f.org).entries[0].status, "prepared");
});

test("a malformed closure line is refused only by strict safety readers", (t) => {
  const f = fixture(t);
  fs.appendFileSync(
    path.join(f.root, ".omt/usage/terminal-closures.jsonl"),
    "broken",
  );
  assert.equal(readTerminalClosures(f.org).length, 1);
  assert.throws(
    () => readTerminalClosures(f.org, { strict: true }),
    /unreadable/,
  );
});

test("recovery refuses another unresolved entry, stale CAS and a conflicting completed proof", async (t) => {
  if (!durableSuccessSupported(t)) return;
  const f = fixture(t);
  const old = fs.readFileSync(f.journal, "utf8");
  const value = JSON.parse(old);
  value.entries.push({ id: "other", type: "reuse", status: "prepared" });
  write(f.journal, value);
  await assert.rejects(
    () =>
      reconcileWorktreeTransition(
        f.org,
        {
          entryId: f.entry.id,
          journalSha256: hash(JSON.stringify(value)),
          requestHash: "x",
        },
        () => assert.fail("unexpected proof"),
      ),
    /sole prepared/,
  );
  write(f.journal, old);
  await f.invoke();
  const resultFile = path.join(
    f.root,
    ".omt/worktree-transition-resolutions.json",
  );
  const before = fs.readFileSync(resultFile);
  await assert.rejects(
    () =>
      reconcileWorktreeTransition(
        f.org,
        { entryId: f.entry.id, requestHash: "different" },
        () => assert.fail("unexpected proof"),
      ),
    /Conflicting/,
  );
  assert.deepEqual(fs.readFileSync(resultFile), before);
  const resolutions = JSON.parse(before);
  resolutions.records[0].reclaimSucceeded = true;
  write(resultFile, resolutions);
  await assert.rejects(
    () => withWorktreeLock(f.org, () => assert.fail("unsafe reopen")),
    /Invalid preservation/,
  );
});

test("a crash before resolution persistence and an unfenced journal change leave preservation unresolved", async (t) => {
  const f = fixture(t);
  const request = {
    entryId: f.entry.id,
    journalSha256: f.request.journalSha256,
    requestHash: "proof",
  };
  const proof = {
    disposition: "preserved-not-reclaimed",
    reclaimSucceeded: false,
  };
  await assert.rejects(
    () =>
      reconcileWorktreeTransition(f.org, request, async () => {
        fs.appendFileSync(f.journal, "\n");
        return proof;
      }),
    /inputs changed/,
  );
  await assert.rejects(() => withWorktreeLock(f.org, () => {}), /Unresolved/);
  assert.equal(
    fs.existsSync(
      path.join(f.root, ".omt/worktree-transition-resolutions.json"),
    ),
    false,
  );
});

test("independent review counterexamples remain refused with the real cleanup scanner", async (t) => {
  const legacyOwned = vm.runInNewContext(
    source.slice(
      source.indexOf("function receiptBody("),
      source.indexOf("async function proveAndCloseOwnedTerminals("),
    ) + "; ownedTerminals",
    {
      path,
      assert: (ok, message) => {
        if (!ok) throw new Error(message);
      },
    },
  );
  for (const kind of [
    "contradictory-close",
    "unverifiable-release",
    "lexical-launch-time",
    "head-conflict",
    "workflow-conflict",
    "task-conflict",
    "phase-conflict",
    "unknown-field",
    "truncated-runs",
    "truncated-workers",
    "missing-run-cursor",
    "missing-worker-page",
    "wrong-run",
    "wrong-runtime",
    "page-total",
    "coverage-warning",
    "omitted-host",
    "missing-lineage",
    "changed-parent-instance",
    "changed-original-lineage",
    "forged-artifacts",
    "future-time",
  ]) {
    await t.test(kind, async (t) => {
      const f = fixture(t);
      let expected;
      if (kind === "contradictory-close") {
        f.closure.terminals[0].close.receipt.result.extra = {
          ptyKilled: false,
        };
        expected = /contradictory PTY/;
      }
      if (kind === "unverifiable-release") {
        f.closure.terminals[0].releases[0].receipt.result.warning =
          "terminal_stop_unverifiable";
        expected = /unverifiable terminal/;
      }
      if (kind === "lexical-launch-time") {
        f.launch.at = "2026-01-01T03:30:00+02:00";
        expected = /prior release and closure proof/;
      }
      for (const [key, field, value] of [
        ["head-conflict", "expectedHead", "b".repeat(40)],
        ["workflow-conflict", "workflowId", "other"],
        ["task-conflict", "taskId", "other"],
        ["phase-conflict", "phase", "after-close"],
      ]) {
        if (kind === key) {
          f.entry[field] = value;
          expected = /conflicts/;
        }
      }
      if (kind === "unknown-field") {
        f.entry.effectsStarted = true;
        expected = /Unsupported prepared/;
      }
      if (kind === "missing-lineage") {
        delete f.child.lineage;
        expected = /lineage|instance/;
      }
      if (kind === "changed-parent-instance") {
        f.parent.identity.instanceId = "other";
        expected = /lineage|instance/;
      }
      if (kind === "changed-original-lineage") {
        f.child.lineage.capture.confidence = "inferred";
        expected = /lineage|instance/;
      }
      f.persist();
      if (["forged-artifacts", "future-time"].includes(kind)) {
        const original = readJSON(f.request.artifacts.execution.path);
        if (kind === "forged-artifacts") original.argv[0] = "not-node";
        else original.at = "2099-01-01T00:00:00Z";
        write(f.request.artifacts.execution.path, original);
        f.request.artifacts.execution.sha256 = hash(
          fs.readFileSync(f.request.artifacts.execution.path, "utf8"),
        );
        write(f.proofFile, f.request);
        expected = /Original failure provenance/;
      }
      if (
        [
          "contradictory-close",
          "unverifiable-release",
          "lexical-launch-time",
        ].includes(kind)
      ) {
        assert.equal(
          legacyOwned(
            [f.launch],
            [f.closure],
            f.child.id,
            f.child.path,
            f.child.identity,
          ).length,
          1,
        );
      }
      if (
        [
          "truncated-runs",
          "truncated-workers",
          "missing-run-cursor",
          "missing-worker-page",
          "wrong-run",
          "wrong-runtime",
          "page-total",
          "coverage-warning",
          "omitted-host",
        ].includes(kind)
      ) {
        const original = f.ports.orca;
        f.ports.orca = async (exe, args) => {
          const receipt = await original(exe, args);
          if (args[1] === "run-list") {
            if (kind === "truncated-runs") receipt.result.truncated = true;
            if (kind === "missing-run-cursor") delete receipt.result.nextCursor;
          }
          if (args[1] === "worker-list") {
            if (kind === "truncated-workers") receipt.result.truncated = true;
            if (kind === "missing-worker-page") delete receipt.result.page;
            if (kind === "wrong-run") receipt.result.scope.run = "other";
            if (kind === "wrong-runtime") receipt._meta.runtimeId = "other";
            if (kind === "page-total") receipt.result.page.total = 2;
            if (kind === "coverage-warning")
              receipt.result.warnings = ["Remote host unavailable"];
            if (kind === "omitted-host")
              receipt.result.hostScope = { omittedHostIds: ["remote"] };
          }
          return receipt;
        };
        expected = /Global ownership, Dispatch or process proof incomplete/;
      }
      const before = fs.readFileSync(f.journal);
      await assert.rejects(() => f.invoke(), expected);
      assert.deepEqual(fs.readFileSync(f.journal), before);
      assert.equal(
        fs.existsSync(
          path.join(f.root, ".omt/worktree-transition-resolutions.json"),
        ),
        false,
      );
    });
  }
});

test("strict scanner traverses and preserves all Run and Dispatch pages", async (t) => {
  if (!durableSuccessSupported(t)) return;
  const f = fixture(t);
  const original = f.ports.orca;
  f.ports.orca = async (exe, args) => {
    const receipt = await original(exe, args);
    if (args[1] === "run-list" && !args.includes("--cursor"))
      receipt.result.nextCursor = "run-page-2";
    else if (args[1] === "run-list")
      receipt.result = { runs: [{ id: "run_other" }], nextCursor: null };
    if (args[1] === "worker-list") {
      const run = args[args.indexOf("--run") + 1];
      receipt.result.scope.run = run;
      if (run === "run_other") {
        receipt.result.workers = [];
        receipt.result.page.total = 0;
      } else if (!args.includes("--cursor")) {
        receipt.result.page = {
          limit: 1,
          total: 2,
          hasMore: true,
          nextCursor: "worker-page-2",
        };
      } else {
        receipt.result.workers = [
          {
            dispatchId: "ctx_other",
            terminalState: "released",
            resource: { worktreeId: "other" },
            projection: { liveness: { verdict: "exited" } },
          },
        ];
        receipt.result.page = {
          limit: 1,
          total: 2,
          hasMore: false,
          nextCursor: null,
        };
      }
    }
    return receipt;
  };
  const result = await f.invoke();
  assert.equal(
    result.currentEvidence.inventory.workerInventory.receipts.length,
    5,
  );
  assert(
    result.currentEvidence.inventory.workerInventory.receipts.some((record) =>
      record.args.includes("worker-page-2"),
    ),
  );
});

test("automatic recovery diagnoses unsupported legacy provenance and never writes a resolution", async (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.journal);
  await assert.rejects(
    () => reconcilePreparedRoleWorktree({ org: f.org, proof: f.proofFile }),
    /unsupported-legacy-provenance/,
  );
  assert.deepEqual(fs.readFileSync(f.journal), before);
  assert.equal(
    fs.existsSync(
      path.join(f.root, ".omt/worktree-transition-resolutions.json"),
    ),
    false,
  );
});

test("legacy adoption rejects absent acknowledgment, unfinished invocation and unsettled resources", async (t) => {
  for (const kind of [
    "acknowledgment",
    "timeout",
    "interrupted",
    "signal",
    "unsettled-slot",
    "unknown-source",
    "other-error",
  ]) {
    await t.test(kind, async (t) => {
      const f = fixture(t);
      if (kind === "acknowledgment") {
        await assert.rejects(
          () =>
            adoptLegacyRoleWorktree({
              org: f.org,
              proof: f.proofFile,
              reason: "explicit reason with adequate length",
            }),
          /acknowledgment/,
        );
        return;
      }
      if (["timeout", "interrupted", "signal"].includes(kind)) {
        const execution = readJSON(f.request.artifacts.execution.path);
        execution[kind === "timeout" ? "timedOut" : kind] =
          kind === "signal" ? "SIGTERM" : true;
        write(f.request.artifacts.execution.path, execution);
        f.request.artifacts.execution.sha256 = hash(
          fs.readFileSync(f.request.artifacts.execution.path, "utf8"),
        );
        write(f.proofFile, f.request);
      }
      if (kind === "unsettled-slot")
        write(path.join(f.root, ".omt/resources/slot.json"), {
          id: "slot",
          worktreeId: f.owner.pm.worktreeId,
        });
      if (kind === "unknown-source") {
        const git = f.ports.git;
        f.ports.git = (repo, args) =>
          args[0] === "show" ? source + "changed" : git(repo, args);
      }
      if (kind === "other-error") {
        write(f.request.artifacts.stderr.path, "unknown timeout");
        f.request.artifacts.stderr.sha256 = hash("unknown timeout");
        write(f.proofFile, f.request);
      }
      const before = fs.readFileSync(f.journal);
      await assert.rejects(
        () => f.invoke(),
        /provenance|slots remain|Unsupported original/,
      );
      assert.deepEqual(fs.readFileSync(f.journal), before);
    });
  }
});

test("adoption and the real scanner refuse contradictory inventory counts and coverage", async (t) => {
  for (const query of ["scoped-terminal", "global-terminal", "worktree"]) {
    for (const corruption of ["total", "missing-total", "coverage"]) {
      await t.test(`${query}/${corruption}`, async (t) => {
        const f = fixture(t);
        const original = f.ports.orca;
        f.ports.orca = async (exe, args) => {
          const receipt = await original(exe, args);
          const match =
            query === "worktree"
              ? args[0] === "worktree" && args[1] === "ps"
              : args[0] === "terminal" &&
                args.includes("--worktree") === (query === "scoped-terminal");
          if (match) {
            if (corruption === "total") receipt.result.totalCount += 1;
            if (corruption === "missing-total")
              delete receipt.result.totalCount;
            if (corruption === "coverage")
              receipt.result.coverage = { complete: false };
          }
          return receipt;
        };
        const before = fs.readFileSync(f.journal);
        await assert.rejects(() => f.invoke(), /inventory|proof incomplete/);
        assert.deepEqual(fs.readFileSync(f.journal), before);
        assert.equal(
          fs.existsSync(
            path.join(f.root, ".omt/worktree-transition-resolutions.json"),
          ),
          false,
        );
      });
    }
  }
});

test("normal reclaim binds every inventory to the original runtime and complete counts", async (t) => {
  if (!durableSuccessSupported(t)) return;
  for (const omitted of [[], ["unrelated"]]) {
    for (const fault of [
      "none",
      "pre-runtime",
      "pre-total",
      "pre-coverage",
      "pre-missing-host",
      "post-runtime",
      "post-total",
      "final-runtime",
      "final-total",
      "final-coverage",
      "final-missing-host",
    ]) {
      await t.test(
        `${omitted.length ? "unrelated-omitted" : "all-hosts"}/${fault}`,
        async (t) => {
          const f = fixture(t);
          write(f.journal, { schemaVersion: 1, entries: [] });
          const effects = [];
          let lists = 0;
          const inventory = (key, rows) => ({
            ok: true,
            id: "read",
            _meta: { runtimeId: "runtime" },
            result: {
              [key]: rows,
              totalCount: rows.length,
              truncated: false,
              hostScope: { hostIds: ["local"], omittedHostIds: omitted },
            },
          });
          function corrupt(receipt, stage) {
            if (fault === `${stage}-runtime`)
              receipt._meta.runtimeId = "OTHER-RUNTIME";
            if (fault === `${stage}-total`) receipt.result.totalCount += 1;
            if (fault === `${stage}-coverage`)
              receipt.result.coverage = { complete: false };
            if (fault === `${stage}-missing-host`)
              delete receipt.result.hostScope;
            return receipt;
          }
          const invoke = () =>
            reclaimIntegratedRoleWorktree(
              {
                org: f.org,
                state: f.owner.pm.stateDir,
                "workflow-id": "flow",
                "workflow-task": "task",
                repo: f.owner.pm.path,
                worktree: f.child.id,
                "merge-commit": head,
              },
              {
                read: () => ({ state: f.workflow }),
                show: async (exe, args) =>
                  args[1] === "ps"
                    ? corrupt(inventory("worktrees", []), "final")
                    : f.ports.orca(exe, args),
                scan: f.ports.scan,
                launches: () => [f.launch],
                closures: () => [],
                recordClosure: () => {},
                git: f.ports.git,
                active: async () => ({ status: "clear" }),
                list: async () => {
                  const first = lists++ === 0;
                  return corrupt(
                    inventory(
                      "terminals",
                      first
                        ? [
                            {
                              handle: "terminal",
                              worktreeId: f.child.id,
                              executionHostId: "local",
                            },
                          ]
                        : [],
                    ),
                    first ? "pre" : "post",
                  );
                },
                release: async (id) => {
                  effects.push("release");
                  return {
                    result: {
                      dispatchId: id,
                      state: "retained",
                      reason: "external_terminal",
                      processAction: "none",
                    },
                  };
                },
                close: async () => {
                  effects.push("close");
                  return {
                    result: {
                      close: {
                        handle: "terminal",
                        tabId: "tab",
                        ptyKilled: true,
                      },
                    },
                  };
                },
                reclaim: async () => {
                  effects.push("remove");
                  fs.rmSync(f.child.path, { recursive: true });
                  return { removed: true };
                },
              },
            );
          if (fault === "none") {
            const result = await invoke();
            assert.equal(result.worktreeId, f.child.id);
          } else {
            await assert.rejects(invoke, /inventory|postcheck/);
            assert.equal(
              readWorktreeTransitions(f.org).entries.at(-1).status,
              "prepared",
            );
          }
          assert.deepEqual(
            effects,
            fault.startsWith("pre-")
              ? []
              : fault.startsWith("post-")
                ? ["release", "close"]
                : ["release", "close", "remove"],
          );
        },
      );
    }
  }
});
