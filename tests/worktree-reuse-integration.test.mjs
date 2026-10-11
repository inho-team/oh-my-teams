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
  function claim(parent) {
    return registerKickoff(orgFile, {
      goal: "archived reuse",
      pm: {
        worktreeId: parent.id,
        path: parent.path,
        stateDir: `${parent.path}/.omt`,
      },
      organizationRevision: organization.revision,
      brief: path.join(repo, "brief.md"),
      delivery: { mode: "pull-request", branch: "main" },
      requirements: minimalRequirements(orgFile, parent.id),
      director: { terminalHandle: "director-fixture", checkoutPath: repo },
    });
  }
  let mutations = 0;
  let externalWorker = false;
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
        dispatchId: "source-dispatch",
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
                  dispatchId: "source-dispatch",
                  workerState: "succeeded",
                  dispatchStatus: "completed",
                  agentTerminalHandle: "source-terminal",
                  terminalState: "retained",
                  resource: {
                    ownershipState: "external",
                    retainedReason: "external_terminal",
                    worktreeId: child.id,
                    terminalHandle: "source-terminal",
                    ownerDispatchId: "source-dispatch",
                    originDispatchId: "source-dispatch",
                    endpointId: "fixture-runtime",
                    endpointIncarnation: `${sourceTerminal.ptyId}:${sourceTerminal.incarnationId}`,
                  },
                  projection: {
                    host: { id: "local" },
                    workspace: { id: child.id },
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
  async function acceptAndArchive(parent, workflowId) {
    const stateDir = `${parent.path}/.omt`;
    const accepted = await acceptTaskThroughRuntime({
      org: orgFile,
      stateDir,
      taskDir: parent.path,
      workflowId,
      resultRepo: child.path,
    });
    await acceptWorkflowIntegration(stateDir, workflowId, accepted.revision);
    recordLaunch(orgFile, {
      via: "worker-start",
      role: "senior",
      stateDir,
      workflowId,
      workflowTaskId: "a",
      terminal: "source-terminal",
      workerId: "source-dispatch",
      worktreePath: child.path,
      worktreeProtocolVersion: 1,
    });
    terminalAttached = true;
    const beforeReceipt = await orca("orca", [
      "terminal",
      "list",
      "--worktree",
      `id:${child.id}`,
    ]);
    const releaseReceipt = await orca("orca", [
      "orchestration",
      "worker-release",
      "--dispatch",
      "source-dispatch",
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
      `id:${child.id}`,
    ]);
    recordTerminalClosure(orgFile, {
      worktreeId: child.id,
      worktreePath: child.path,
      identity: child.identity,
      beforeReceipt,
      afterReceipt,
      terminals: [
        {
          terminal: "source-terminal",
          dispatch: { result: { status: "clear" } },
          releases: [
            { dispatchId: "source-dispatch", receipt: releaseReceipt },
          ],
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
      role: "senior",
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
