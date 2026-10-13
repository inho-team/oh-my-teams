/** Real Git and runtime archival integration with a bounded Orca transport emulator. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  readJSON,
  writeJSON,
  assertDirectorySync,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  registerKickoff,
  kickoffHashFor,
  listKickoffs,
  releaseKickoff,
  recordDelivery,
  cleanupKickoffBranches,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";
import {
  scanKickoffCleanup,
  reclaimKickoffCleanup,
} from "../plugins/oh-my-teams/scripts/kickoff-cleanup.mjs";
import {
  acceptWorkflowIntegration,
  readWorkflow,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";
import {
  requirementsFidelity,
  requirementsFidelityConfirm,
} from "../plugins/oh-my-teams/scripts/requirements.mjs";
import {
  recordLaunch,
  recordTerminalClosure,
} from "../plugins/oh-my-teams/scripts/usage-ledger.mjs";
import {
  discoverReusableWorktrees,
  withAutomaticWorktreeReuse,
} from "../plugins/oh-my-teams/scripts/worktree-reuse.mjs";
import {
  runOrcaJson,
  reparentWorktree,
} from "../plugins/oh-my-teams/scripts/orca-adapter.mjs";
import {
  saveDocument,
  deliveryRefDocId,
} from "../plugins/oh-my-teams/scripts/documents.mjs";
import { proveKickoffWorktreeOwnership } from "../plugins/oh-my-teams/scripts/worktree-ownership.mjs";
import { denyDirectorySync } from "./directory-durability-fixture.mjs";
import { minimalRequirements } from "./requirements-draft-fixture.mjs";
import { acceptTaskThroughRuntime } from "./accepted-workflow-fixture.mjs";

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omt-archive-reuse-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "owner");
  fs.mkdirSync(repo);
  const git = (args, cwd = repo) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git(["init", "--initial-branch=main"]);
  git(["config", "user.name", "OMT Test"]);
  git(["config", "user.email", "omt@example.test"]);
  fs.writeFileSync(
    path.join(repo, "brief.md"),
    "Two kickoff reuse integration fixture\n",
  );
  fs.writeFileSync(path.join(repo, ".gitignore"), ".omt/\n");
  git(["add", "."]);
  git(["commit", "-m", "fixture"]);
  const head = git(["rev-parse", "HEAD"]);
  const orgFile = path.join(repo, ".omt", "organization.json");
  const organization = readJSON(
    path.resolve("plugins/oh-my-teams/examples/organization.json"),
  );
  writeJSON(orgFile, organization);
  const trees = new Map();
  function tree(name, parent) {
    const location = path.join(root, name);
    git(["worktree", "add", "-b", `fix/${name}`, location, head]);
    const id = `wt-a::${location}`;
    const item = {
      id,
      path: location,
      repoId: "wt-a",
      head,
      branch: `refs/heads/fix/${name}`,
      identity: {
        key: `identity-${name}`,
        instanceId: name,
        executionHostId: "local",
      },
      parentWorktreeId: parent?.id ?? null,
    };
    if (parent)
      item.lineage = {
        worktreeId: id,
        worktreeInstanceId: name,
        parentWorktreeId: parent.id,
        parentWorktreeInstanceId: parent.identity.instanceId,
        origin: "cli",
        capture: { confidence: "explicit" },
      };
    trees.set(id, item);
    return item;
  }
  const source = tree("source-pm");
  const child = tree("child", source);
  const target = tree("target-pm");
  function claim(parent, mode = "pull-request") {
    return registerKickoff(orgFile, {
      goal: "archived reuse",
      pm: {
        worktreeId: parent.id,
        path: parent.path,
        stateDir: `${parent.path}/.omt`,
      },
      organizationRevision: organization.revision,
      brief: path.join(repo, "brief.md"),
      delivery: { mode, ...(mode === "none" ? {} : { branch: "main" }) },
      requirements: minimalRequirements(orgFile, parent.id),
      director: { terminalHandle: "director-fixture", checkoutPath: repo },
    });
  }
  let mutations = 0;
  let externalWorker = false;
  let dispatchId = "source-dispatch";
  let selectedChild = child;
  let inventoryChange = () => {};
  const sourceTerminal = {
    handle: "source-terminal",
    worktreeId: child.id,
    executionHostId: "local",
    ptyId: `${child.id}@@pty`,
    incarnationId: "source-incarnation",
    tabId: "source-tab",
  };
  let terminalAttached = false;
  const execute = async (argv) => {
    const command = argv.slice(1);
    let result;
    if (command[0] === "terminal" && command[1] === "list")
      result = {
        terminals: terminalAttached ? [sourceTerminal] : [],
      };
    else if (command[0] === "terminal" && command[1] === "close") {
      terminalAttached = false;
      result = {
        close: {
          handle: "source-terminal",
          tabId: "source-tab",
          ptyKilled: true,
        },
      };
    } else if (
      command[0] === "orchestration" &&
      command[1] === "worker-release"
    ) {
      result = {
        dispatchId,
        state: "retained",
        reason: "external_terminal",
        processAction: "none",
      };
    } else if (command[1] === "ps")
      result = {
        worktrees: [...trees.values()].map((item) => ({
          worktreeId: item.id,
          path: item.path,
          worktreeInstanceId: item.identity.instanceId,
          hostId: "local",
          parentWorktreeId: item.parentWorktreeId,
          childWorktreeIds: [...trees.values()]
            .filter((other) => other.parentWorktreeId === item.id)
            .map((other) => other.id),
          liveTerminalCount: 0,
          hasAttachedPty: false,
        })),
      };
    else if (command[1] === "show") {
      const item = trees.get(
        command[command.indexOf("--worktree") + 1].slice(3),
      );
      result = {
        worktree: {
          ...item,
          childWorktreeIds: [...trees.values()]
            .filter((other) => other.parentWorktreeId === item.id)
            .map((other) => other.id),
        },
      };
    } else if (command[1] === "set") {
      const key = command[command.indexOf("--worktree") + 1].slice(
        "identity:".length,
      );
      const parentKey = command[command.indexOf("--parent-worktree") + 1].slice(
        "identity:".length,
      );
      const item = [...trees.values()].find((row) => row.identity.key === key);
      const parent = [...trees.values()].find(
        (row) => row.identity.key === parentKey,
      );
      assert.ok(item && parent);
      mutations += 1;
      item.parentWorktreeId = parent.id;
      item.lineage = {
        ...item.lineage,
        parentWorktreeId: parent.id,
        parentWorktreeInstanceId: parent.identity.instanceId,
        origin: "manual",
      };
      result = { worktree: structuredClone(item) };
    } else throw new Error(`Unexpected Orca transport: ${command.join(" ")}`);
    const receipt = {
      ok: true,
      result,
      _meta: { runtimeId: "fixture-runtime" },
    };
    if (
      command[1] === "ps" ||
      (command[0] === "terminal" && command[1] === "list")
    ) {
      result.hostScope = {
        hostIds: ["local"],
        omittedHostIds: ["unrelated-remote"],
      };
      result.truncated = false;
      inventoryChange(command[0], receipt, command);
    }
    return {
      code: 0,
      stdout: JSON.stringify(receipt),
      stderr: "",
      timedOut: false,
    };
  };
  const orca = (executable, args, options = {}) =>
    runOrcaJson(executable, args, { ...options, execute });
  const scan = (request) =>
    scanKickoffCleanup(request, {
      orca,
      workerInventory: async () => ({
        result: {
          workers: externalWorker
            ? [
                {
                  dispatchId,
                  workerState: "succeeded",
                  dispatchStatus: "completed",
                  agentTerminalHandle: "source-terminal",
                  terminalState: "retained",
                  resource: {
                    ownershipState: "external",
                    retainedReason: "external_terminal",
                    worktreeId: selectedChild.id,
                    terminalHandle: "source-terminal",
                    ownerDispatchId: dispatchId,
                    originDispatchId: dispatchId,
                    endpointId: "fixture-runtime",
                    endpointIncarnation: `${sourceTerminal.ptyId}:${sourceTerminal.incarnationId}`,
                  },
                  projection: {
                    host: { id: "local" },
                    workspace: { id: selectedChild.id },
                    liveness: {
                      verdict: "unverifiable",
                      reason: "missing_status",
                    },
                  },
                },
              ]
            : [],
        },
      }),
    });
  async function acceptAndArchive(
    parent,
    workflowId,
    resource = child,
    delivered = true,
  ) {
    selectedChild = resource;
    sourceTerminal.worktreeId = resource.id;
    sourceTerminal.ptyId = `${resource.id}@@pty`;
    const stateDir = `${parent.path}/.omt`;
    const accepted = await acceptTaskThroughRuntime({
      org: orgFile,
      stateDir,
      taskDir: parent.path,
      workflowId,
      resultRepo: resource.path,
    });
    await acceptWorkflowIntegration(stateDir, workflowId, accepted.revision);
    dispatchId = readWorkflow(stateDir, workflowId).state.tasks.a.execution
      .executionId;
    recordLaunch(orgFile, {
      via: "worker-start",
      role: "worker",
      stateDir,
      workflowId,
      workflowTaskId: "a",
      terminal: "source-terminal",
      workerId: dispatchId,
      worktreePath: resource.path,
      worktreeProtocolVersion: 1,
    });
    terminalAttached = true;
    const beforeReceipt = await orca("orca", [
      "terminal",
      "list",
      "--worktree",
      `id:${resource.id}`,
    ]);
    const releaseReceipt = await orca("orca", [
      "orchestration",
      "worker-release",
      "--dispatch",
      dispatchId,
    ]);
    const closeReceipt = await orca("orca", [
      "terminal",
      "close",
      "--terminal",
      "source-terminal",
    ]);
    const afterReceipt = await orca("orca", [
      "terminal",
      "list",
      "--worktree",
      `id:${resource.id}`,
    ]);
    recordTerminalClosure(orgFile, {
      worktreeId: resource.id,
      worktreePath: resource.path,
      identity: resource.identity,
      beforeReceipt,
      afterReceipt,
      terminals: [
        {
          terminal: "source-terminal",
          dispatch: { result: { status: "clear" } },
          releases: [{ dispatchId, receipt: releaseReceipt }],
          close: { receipt: closeReceipt },
        },
      ],
    });
    await requirementsFidelity(orgFile, parent.id, {
      head,
      repo,
      recordedBy: "pm",
      items: [
        { type: "statement", id: "s1", status: "met", evidence: "brief.md" },
        { type: "criterion", id: "c1", status: "met", evidence: "brief.md" },
      ],
    });
    await requirementsFidelityConfirm(orgFile, parent.id, repo);
    if (delivered)
      recordDelivery(orgFile, {
        worktreeId: parent.id,
        head,
        mergeCommit: head,
        remoteName: "",
      });
    const cleanup = await scan({ orgFile, worktreeId: parent.id });
    return releaseKickoff(orgFile, {
      worktreeId: parent.id,
      reason: "completed",
      head,
      repo,
      callerCwd: repo,
      cleanup,
    });
  }
  return {
    root,
    repo,
    orgFile,
    source,
    target,
    child,
    claim,
    acceptAndArchive,
    scan,
    orca,
    execute,
    head,
    trees,
    tree,
    git,
    mutations: () => mutations,
    useExternalWorker: () => {
      externalWorker = true;
    },
    changeInventory: (change) => {
      inventoryChange = change;
    },
    request: {
      orgFile,
      stateDir: `${target.path}/.omt`,
      workflowId: "target-flow",
      taskId: "a",
      role: "worker",
      repo: target.path,
      base: head,
    },
    ports: {
      scan,
      show: orca,
      reparent: (repo, options) =>
        reparentWorktree(repo, { ...options, execute }),
    },
  };
}

test("runtime-generated archives feed automatic transfer and permanently fence the old cleanup and branch owner", async (t) => {
  const f = await fixture(t);
  try {
    assertDirectorySync(path.dirname(f.orgFile));
  } catch (error) {
    assert.equal(error.code, "worktree-durability-unavailable");
    return t.skip("This filesystem cannot persist directory metadata");
  }
  f.claim(f.source);
  const sourceArchive = await f.acceptAndArchive(f.source, "source-flow");
  assert.equal(readJSON(sourceArchive.archived).reuseEvidence.status, "proven");
  assert.equal(listKickoffs(f.orgFile).kickoffs.length, 0);
  f.claim(f.target);
  assert.equal(
    discoverReusableWorktrees(f.orgFile, f.request).candidates.length,
    1,
  );
  const reused = await withAutomaticWorktreeReuse(
    f.request,
    async (candidate) => ({ worktreeId: candidate?.worktreeId }),
    f.ports,
  );
  assert.equal(
    reused.worktreeId,
    f.child.id,
    JSON.stringify(reused.reuseRejections),
  );
  assert.equal(f.mutations(), 1);
  const oldRequest = {
    orgFile: f.orgFile,
    worktreeId: f.source.id,
    archiveFile: sourceArchive.archived,
    callerCwd: f.repo,
  };
  const old = await f.scan(oldRequest);
  assert.equal(
    old.candidates.find((item) => item.worktreeId === f.child.id).status,
    "transferred",
  );
  let removed = 0;
  await reclaimKickoffCleanup(oldRequest, {
    scan: f.scan,
    show: f.orca,
    reclaim: async () => {
      removed += 1;
    },
  });
  assert.equal(removed, 0);
  const branches = cleanupKickoffBranches({
    orgFile: f.orgFile,
    projectDir: f.repo,
    callerCwd: f.repo,
    entry: readJSON(sourceArchive.archived),
    branches: ["fix/child"],
    remoteName: "",
  });
  assert.deepEqual(branches.skipped, ["fix/child"]);
  assert.equal(fs.existsSync(f.child.path), true);
  const targetArchive = await f.acceptAndArchive(f.target, "target-flow");
  assert.equal(readJSON(targetArchive.archived).releaseReason, "completed");
  assert.equal(
    readWorkflow(`${f.target.path}/.omt`, "target-flow").state.status,
    "accepted",
  );
});

test("a new release cannot retroactively enroll a legacy source kickoff", async (t) => {
  const f = await fixture(t);
  const original = f.claim(f.source);
  const legacy = readJSON(original.file);
  delete legacy.reuseProtocol;
  writeJSON(original.file, legacy);
  const archived = await f.acceptAndArchive(f.source, "legacy-source");
  assert.equal(readJSON(archived.archived).reuseEvidence.status, "unavailable");
  f.claim(f.target);
  const result = await withAutomaticWorktreeReuse(
    f.request,
    async (candidate) => ({ fresh: candidate === null }),
    f.ports,
  );
  assert.equal(result.fresh, true);
  assert.equal(f.mutations(), 0);
  assert.ok(
    result.reuseRejections.some(
      (item) =>
        item.reason === "source-protocol-not-participating-at-registration",
    ),
  );
  assert.equal(fs.existsSync(f.child.path), true);
});

test("missing closure evidence preserves an archived source despite an empty live inventory", async (t) => {
  const f = await fixture(t);
  try {
    assertDirectorySync(path.dirname(f.orgFile));
  } catch (error) {
    assert.equal(error.code, "worktree-durability-unavailable");
    return t.skip("This filesystem cannot persist directory metadata");
  }
  f.claim(f.source);
  await f.acceptAndArchive(f.source, "source-without-closure");
  const { terminalClosureLedgerFile } =
    await import("../plugins/oh-my-teams/scripts/usage-ledger.mjs");
  fs.unlinkSync(terminalClosureLedgerFile(f.orgFile));
  f.claim(f.target);
  const result = await withAutomaticWorktreeReuse(
    f.request,
    async (candidate) => ({ fresh: candidate === null }),
    f.ports,
  );
  assert.equal(result.fresh, true);
  assert.equal(f.mutations(), 0);
  assert.ok(
    result.reuseRejections.some((item) =>
      item.reason.includes("process-exit-unproven"),
    ),
  );
  assert.equal(fs.existsSync(f.child.path), true);
});

test("current inventory provenance fences real scanner, transfer and reclaim despite exact historical closure", async (t) => {
  const f = await fixture(t);
  try {
    assertDirectorySync(path.dirname(f.orgFile));
  } catch (error) {
    assert.equal(error.code, "worktree-durability-unavailable");
    return t.skip("This filesystem cannot persist directory metadata");
  }
  f.claim(f.source);
  const archive = await f.acceptAndArchive(f.source, "host-scope-source");
  f.claim(f.target);
  f.useExternalWorker();
  const request = {
    orgFile: f.orgFile,
    worktreeId: f.source.id,
    archiveFile: archive.archived,
    callerCwd: f.repo,
  };
  const safe = await f.scan(request);
  assert.equal(
    safe.candidates.find((item) => item.worktreeId === f.child.id).status,
    "safe-to-remove",
  );
  assert.deepEqual(safe.currentInventory.terminal.hostScope.omittedHostIds, [
    "unrelated-remote",
  ]);
  const cases = {
    "target-host-absent": (r) => {
      r.result.hostScope.hostIds = ["another-host"];
    },
    "target-host-omitted": (r) => {
      r.result.hostScope.omittedHostIds.push("local");
    },
    "scope-unknown": (r) => {
      delete r.result.hostScope;
    },
    "empty-hosts": (r) => {
      r.result.hostScope.hostIds = [];
    },
    "omissions-unknown": (r) => {
      delete r.result.hostScope.omittedHostIds;
    },
    truncated: (r) => {
      r.result.truncated = true;
    },
    "completeness-unknown": (r) => {
      delete r.result.truncated;
    },
    "runtime-unknown": (r) => {
      delete r._meta;
    },
    "runtime-changed": (r) => {
      r._meta.runtimeId = "other-runtime";
    },
  };
  for (const kind of ["terminal", "worktree", "both"]) {
    for (const [name, change] of Object.entries(cases)) {
      await t.test(`${kind}: ${name}`, async () => {
        f.changeInventory((command, receipt) => {
          if (kind === "both" || command === kind) change(receipt);
        });
        const scan = await f.scan(request);
        const candidate = scan.candidates.find(
          (item) => item.worktreeId === f.child.id,
        );
        assert.equal(candidate.status, "preserve");
        assert.ok(
          candidate.reasons.some((reason) =>
            [
              "current-inventory-provenance-unverified",
              "worker-unsettled-or-unverifiable",
            ].includes(reason),
          ),
        );
        let selected = false;
        const result = await withAutomaticWorktreeReuse(
          f.request,
          async (candidate) => {
            selected = Boolean(candidate);
            return { selected };
          },
          f.ports,
        );
        assert.equal(result.selected, false);
        assert.ok(result.reuseRejections.length > 0);
        assert.equal(f.mutations(), 0);
        let removals = 0;
        await reclaimKickoffCleanup(request, {
          scan: f.scan,
          show: f.orca,
          reclaim: async () => {
            removals += 1;
          },
        });
        assert.equal(removals, 0);
        assert.equal(fs.existsSync(f.child.path), true);
        assert.equal(f.child.parentWorktreeId, f.source.id);
      });
    }
  }
  f.changeInventory(() => {});
  const reused = await withAutomaticWorktreeReuse(
    f.request,
    async (candidate) => ({ worktreeId: candidate?.worktreeId }),
    f.ports,
  );
  assert.equal(
    reused.worktreeId,
    f.child.id,
    JSON.stringify(reused.reuseRejections),
  );
  assert.equal(f.mutations(), 1);
});

test("a missing global host is replaced only by exact current scoped terminal observations", async (t) => {
  const f = await fixture(t);
  try {
    assertDirectorySync(path.dirname(f.orgFile));
  } catch (error) {
    assert.equal(error.code, "worktree-durability-unavailable");
    return t.skip("Durable transfer success requires directory sync");
  }
  f.claim(f.source);
  const archive = await f.acceptAndArchive(f.source, "scoped-source");
  f.claim(f.target);
  f.useExternalWorker();
  const request = {
    orgFile: f.orgFile,
    worktreeId: f.source.id,
    archiveFile: archive.archived,
    callerCwd: f.repo,
  };
  const cases = {
    missing: (r) => {
      delete r.result.hostScope;
    },
    omitted: (r) => {
      r.result.hostScope.omittedHostIds.push("local");
    },
    absent: (r) => {
      r.result.hostScope.hostIds = [];
    },
    runtime: (r) => {
      r._meta.runtimeId = "different";
    },
    truncated: (r) => {
      r.result.truncated = true;
    },
    unavailable: () => {
      throw new Error("scoped lookup unavailable");
    },
    alive: (r) => {
      r.result.terminals = [
        {
          handle: "new-terminal",
          worktreeId: f.child.id,
          executionHostId: "local",
        },
      ];
    },
    foreign: (r) => {
      r.result.terminals = [
        {
          handle: "foreign-terminal",
          worktreeId: f.source.id,
          executionHostId: "local",
        },
      ];
    },
    unknownHost: (r) => {
      r.result.terminals = [{ handle: "new-terminal", worktreeId: f.child.id }];
    },
    success: () => {},
  };
  for (const [name, change] of Object.entries(cases)) {
    await t.test(name, async () => {
      f.changeInventory((kind, receipt, args) => {
        if (kind !== "terminal") return;
        assert.equal(args.includes("--host"), false);
        if (!args.includes("--worktree")) {
          receipt.result.hostScope.hostIds = [];
          receipt.result.hostScope.omittedHostIds.unshift("local");
        } else if (args[args.indexOf("--worktree") + 1] === `id:${f.child.id}`)
          change(receipt);
      });
      const scan = await f.scan(request);
      const candidate = scan.candidates.find(
        (v) => v.worktreeId === f.child.id,
      );
      assert.deepEqual(scan.currentInventory.terminal.hostScope.hostIds, []);
      if (name === "success") {
        assert.equal(candidate.status, "safe-to-remove");
        const reused = await withAutomaticWorktreeReuse(
          f.request,
          async (v) => ({ id: v?.worktreeId }),
          f.ports,
        );
        assert.equal(reused.id, f.child.id);
        assert.equal(f.mutations(), 1);
      } else {
        assert.equal(candidate.status, "preserve");
        const reused = await withAutomaticWorktreeReuse(
          f.request,
          async (v) => ({ selected: Boolean(v) }),
          f.ports,
        );
        assert.equal(reused.selected, false);
        assert.equal(f.mutations(), 0);
        let removed = 0;
        await reclaimKickoffCleanup(request, {
          scan: f.scan,
          show: f.orca,
          reclaim: async () => {
            removed++;
          },
        });
        assert.equal(removed, 0);
      }
    });
  }
});

test("cross-archive-candidate-ownership: same PM incarnation cannot lend delivery to an older undelivered child", async (t) => {
  const f = await fixture(t);
  try {
    assertDirectorySync(path.dirname(f.orgFile));
  } catch (error) {
    assert.equal(error.code, "worktree-durability-unavailable");
    return t.skip("Directory metadata durability is unsupported");
  }
  f.claim(f.source, "none");
  const original = await f.acceptAndArchive(
    f.source,
    "original-flow",
    f.child,
    false,
  );
  f.claim(f.source);
  const deliveredChild = f.tree("delivered-child", f.source);
  const delivered = await f.acceptAndArchive(
    f.source,
    "delivered-flow",
    deliveredChild,
  );
  const originalEntry = readJSON(original.archived);
  const deliveredEntry = readJSON(delivered.archived);
  assert.equal(originalEntry.pm.worktreeId, deliveredEntry.pm.worktreeId);
  assert.notEqual(
    originalEntry.registrationSeq,
    deliveredEntry.registrationSeq,
  );
  assert.notEqual(originalEntry.createdAt, deliveredEntry.createdAt);
  assert.notEqual(
    originalEntry.reuseEvidence.proof.kickoffHash,
    deliveredEntry.reuseEvidence.proof.kickoffHash,
  );
  assert.deepEqual(
    deliveredEntry.reuseEvidence.proof.workflows.map((row) => row.workflowId),
    ["delivered-flow"],
  );
  const request = {
    orgFile: f.orgFile,
    worktreeId: f.source.id,
    archiveFile: delivered.archived,
    callerCwd: f.repo,
  };
  const history = path.dirname(delivered.archived);
  writeJSON(path.join(history, "kickoff-145-delivery-20261006.json"), {
    schemaVersion: 1,
    kickoff: "older-summary",
    sourceHead: f.head,
    mergeCommit: f.head,
    ci: { status: "passed" },
    cleanup: {},
  });
  fs.writeFileSync(
    path.join(history, "kickoff-unrelated-broken.json"),
    "{broken",
  );
  const oldScan = await f.scan({ ...request, archiveFile: original.archived });
  assert.ok(
    oldScan.candidates
      .find((row) => row.worktreeId === f.child.id)
      .reasons.includes("head-not-delivered"),
  );
  const current = await f.scan(request);
  const old = current.candidates.find((row) => row.worktreeId === f.child.id);
  assert.equal(old.status, "preserve");
  assert.ok(old.reasons.includes("candidate-kickoff-incarnation-unproven"));
  const fresh = current.candidates.find(
    (row) => row.worktreeId === deliveredChild.id,
  );
  assert.equal(fresh.status, "safe-to-remove", JSON.stringify(fresh.reasons));
  assert.equal(fresh.ownership.workflowId, "delivered-flow");
  assert.equal(fresh.ownership.excludedRegistrations.length, 2);
  assert.ok(
    fresh.ownership.excludedRegistrations.some(
      (row) => row.reason === "archive-registration-identity-unproven",
    ),
  );
  const damagedFile = delivered.archived.replace(/\.json$/, "-damaged.json");
  fs.writeFileSync(damagedFile, "{broken");
  const damaged = await f.scan(request);
  assert.equal(
    damaged.candidates.find((row) => row.worktreeId === deliveredChild.id)
      .ownership.reason,
    "kickoff-incarnation-history-unverifiable",
  );
  writeJSON(damagedFile, { ...deliveredEntry, releasedAt: undefined });
  assert.equal(
    proveKickoffWorktreeOwnership(f.orgFile, deliveredEntry, deliveredChild.id)
      .reason,
    "kickoff-incarnation-history-unverifiable",
  );
  fs.rmSync(damagedFile);
  const conflicting = {
    ...deliveredEntry,
    registrationSeq: deliveredEntry.registrationSeq + 100,
  };
  writeJSON(
    path.join(history, "kickoff-conflicting-registration.json"),
    conflicting,
  );
  assert.equal(
    proveKickoffWorktreeOwnership(f.orgFile, deliveredEntry, deliveredChild.id)
      .reason,
    "kickoff-incarnation-sequence-conflict",
  );
  fs.rmSync(path.join(history, "kickoff-conflicting-registration.json"));
  assert.equal(fresh.ownership.executionId, "delivered-flow-a");
  // Observe a genuinely live new child while attempting cleanup: neither that
  // child nor the unrelated older child can be removed through the public API.
  f.changeInventory((kind, receipt, command) => {
    if (kind === "terminal" && command.includes(`id:${deliveredChild.id}`))
      receipt.result.terminals = [
        {
          handle: "live-new",
          worktreeId: deliveredChild.id,
          executionHostId: "local",
        },
      ];
  });
  const removals = [];
  await reclaimKickoffCleanup(request, {
    scan: f.scan,
    show: f.orca,
    reclaim: async (_repo, options) => {
      removals.push(options.id);
    },
  });
  assert.deepEqual(removals, []);
  f.changeInventory(() => {});
  const stale = await reclaimKickoffCleanup(request, {
    scan: async (input) => {
      const snapshot = await f.scan(input);
      for (const row of snapshot.candidates)
        row.status =
          row.worktreeId === f.child.id ? "safe-to-remove" : "preserve";
      return snapshot;
    },
    show: f.orca,
    reclaim: async (_repo, options) => {
      removals.push(options.id);
    },
  });
  assert.equal(stale.attempts.at(-1).outcome, "refused");
  assert.equal(
    stale.attempts.at(-1).error,
    "candidate-kickoff-incarnation-unproven",
  );
  assert.deepEqual(removals, []);
  // Even an unchecked-out old branch must not borrow the newer delivery.
  f.git(["checkout", "--detach", f.head], f.child.path);
  const remote = path.join(f.root, "remote.git");
  f.git(["init", "--bare", remote]);
  f.git(["remote", "add", "origin", remote]);
  f.git(["push", "origin", "fix/child"]);
  const localBefore = f.git(["rev-parse", "refs/heads/fix/child"]);
  const remoteBefore = f.git(["ls-remote", "--heads", "origin", "fix/child"]);
  for (const entry of [originalEntry, deliveredEntry]) {
    const result = cleanupKickoffBranches({
      projectDir: f.repo,
      orgFile: f.orgFile,
      entry,
      branches: ["fix/child"],
      remoteName: "origin",
      callerCwd: f.repo,
      force: true,
    });
    assert.deepEqual(result, {
      deleted: [],
      skipped: ["fix/child"],
      errors: [],
    });
    assert.equal(f.git(["rev-parse", "refs/heads/fix/child"]), localBefore);
    assert.equal(
      f.git(["ls-remote", "--heads", "origin", "fix/child"]),
      remoteBefore,
    );
  }
  f.claim(f.target);
  const reused = await withAutomaticWorktreeReuse(
    f.request,
    async (candidate) => ({ worktreeId: candidate?.worktreeId }),
    f.ports,
  );
  assert.equal(
    reused.worktreeId,
    deliveredChild.id,
    JSON.stringify(reused.reuseRejections),
  );
  assert.equal(
    f.trees.get(deliveredChild.id).identity.instanceId,
    "delivered-child",
  );
  assert.equal(f.trees.get(f.child.id).parentWorktreeId, f.source.id);
  assert.equal(f.mutations(), 1);
});

test("a proven reclaimed task retains its exact branch ownership for local and remote cleanup", async (t) => {
  const f = await fixture(t);
  try {
    assertDirectorySync(path.dirname(f.orgFile));
  } catch (error) {
    assert.equal(error.code, "worktree-durability-unavailable");
    return t.skip("Directory metadata durability is unsupported");
  }
  f.claim(f.source);
  const archive = await f.acceptAndArchive(f.source, "branch-flow");
  const remote = path.join(f.root, "remote.git");
  f.git(["init", "--bare", remote]);
  f.git(["remote", "add", "origin", remote]);
  f.git(["push", "origin", "fix/child"]);
  const removals = [];
  const result = await reclaimKickoffCleanup(
    {
      orgFile: f.orgFile,
      worktreeId: f.source.id,
      archiveFile: archive.archived,
      callerCwd: f.repo,
    },
    {
      scan: f.scan,
      show: f.orca,
      reclaim: async (_repo, options) => {
        removals.push(options.id);
        const item = f.trees.get(options.id);
        f.git(["worktree", "remove", item.path]);
        f.trees.delete(options.id);
        return { result: { removed: options.id } };
      },
    },
  );
  assert.deepEqual(removals, [f.child.id]);
  assert.equal(result.attempts[0].outcome, "removed");
  const entry = readJSON(archive.archived);
  const request = {
    projectDir: f.repo,
    orgFile: f.orgFile,
    entry,
    branches: ["fix/child"],
    remoteName: "origin",
    callerCwd: f.repo,
  };
  assert.deepEqual(cleanupKickoffBranches(request), {
    deleted: [],
    skipped: ["fix/child"],
    errors: [],
  });
  const kickoffHash = kickoffHashFor(entry);
  saveDocument(entry.pm.stateDir, {
    schemaVersion: 1,
    docId: deliveryRefDocId(kickoffHash, f.head),
    stage: "delivery",
    kickoffId: kickoffHash,
    workflowId: null,
    revision: 1,
    state: "resolved",
    author: { role: "pm", executionId: "branch-pm" },
    createdAt: new Date().toISOString(),
    basedOnRevision: null,
    reason: "exact task delivered",
    deliveredCommit: f.head,
  });
  await t.test(
    "proven branch still requires directory durability before either deletion",
    (sub) => {
      denyDirectorySync(sub);
      assert.throws(() => cleanupKickoffBranches(request), {
        code: "worktree-durability-unavailable",
      });
      assert.equal(f.git(["rev-parse", "refs/heads/fix/child"]), f.head);
      assert.notEqual(
        f.git(["ls-remote", "--heads", "origin", "fix/child"]),
        "",
      );
    },
  );
  const cleanup = cleanupKickoffBranches(request);
  assert.deepEqual(cleanup, {
    deleted: ["fix/child"],
    skipped: [],
    errors: [],
  });
  assert.equal(f.git(["ls-remote", "--heads", "origin", "fix/child"]), "");
});
