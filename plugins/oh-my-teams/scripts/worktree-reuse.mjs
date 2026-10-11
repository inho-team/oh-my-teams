/** Evidence-backed discovery of reusable worktrees across active workflows and completed archives. */
import fs from "node:fs";
import path from "node:path";
import { assert, hash, readJSON, writeJSON } from "./core.mjs";
import { listKickoffs, kickoffHashFor } from "./kickoff-registry.mjs";
import { readWorkflow } from "./workflow.mjs";
import { readLaunches } from "./usage-ledger.mjs";
import { scanKickoffCleanup } from "./kickoff-cleanup.mjs";
import { git } from "./evidence.mjs";
import {
  runOrcaJson,
  selectOrcaExecutable,
  reparentWorktree,
} from "./orca-adapter.mjs";
import {
  readWorktreeTransitions,
  withWorktreeLock,
} from "./worktree-transactions.mjs";

function decision(stateDir, id) {
  assert(
    typeof id === "string" && /^[a-zA-Z0-9_-]+$/.test(id),
    "Invalid acceptance decision identifier",
  );
  return readJSON(path.join(stateDir, "decisions", `${id}.json`));
}

function workflowProofs(entry, orgFile) {
  const launches = readLaunches(orgFile, { strict: true });
  const directory = path.join(entry.pm.stateDir, "workflows");
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => {
      const snapshot = readWorkflow(entry.pm.stateDir, item.name);
      const tasks = Object.entries(snapshot.state.tasks).map(
        ([taskId, task]) => {
          if (task.state !== "accepted")
            return { taskId, task, acceptance: null };
          const acceptance = decision(entry.pm.stateDir, task.acceptedResult);
          assert(
            acceptance.status === "accepted" &&
              acceptance.taskId === taskId &&
              acceptance.taskHash === task.taskHash,
            `Acceptance does not match ${item.name}/${taskId}`,
          );
          assert(
            acceptance.implementationExecutionId ===
              (task.workerRunId ?? task.execution?.executionId),
            `Acceptance execution changed for ${item.name}/${taskId}`,
          );
          const worktreeId = task.worktreeId ?? task.execution?.worktreeId;
          if (!worktreeId)
            return { taskId, task, acceptance, launchProofs: [] };
          assert(
            worktreeId.includes("::"),
            "Source worktree has no repository identity",
          );
          const location = worktreeId.slice(worktreeId.indexOf("::") + 2);
          const launchProofs = launches.filter(
            (launch) =>
              typeof launch.worktreePath === "string" &&
              path.resolve(launch.worktreePath) === path.resolve(location) &&
              launch.at >= entry.createdAt,
          );
          assert(
            launchProofs.length > 0 &&
              launchProofs.every(
                (launch) =>
                  launch.worktreeProtocolVersion === 1 &&
                  launch.kickoffPmWorktreeId === entry.pm.worktreeId,
              ),
            `Source launch protocol participation unproven for ${taskId}`,
          );
          return { taskId, task, acceptance, launchProofs };
        },
      );
      const integrated = snapshot.state.integration?.decision;
      let integrationAcceptance =
        snapshot.state.integration?.required === false &&
        integrated &&
        integrated.runId === null &&
        integrated.evidenceKey === null &&
        integrated.decisionId === null
          ? { required: false }
          : null;
      if (integrated?.decisionId) {
        integrationAcceptance = decision(
          entry.pm.stateDir,
          integrated.decisionId,
        );
        assert(
          integrationAcceptance.status === "accepted" &&
            integrationAcceptance.implementationExecutionId ===
              integrated.runId &&
            integrationAcceptance.taskHash ===
              snapshot.state.integration.taskHash &&
            integrationAcceptance.evidenceKey === integrated.evidenceKey,
          `Integration acceptance does not match ${item.name}`,
        );
      }
      return {
        workflowId: item.name,
        state: snapshot.state,
        tasks,
        integrationAcceptance,
      };
    });
}

/**
 * Captures real accepted component decisions before the PM state can be reclaimed.
 * Missing or unreadable evidence excludes reuse without preventing normal archival.
 * @param {object} entry - Registered source kickoff.
 * @param {string} orgFile - Canonical organization containing the launch ledger.
 * @returns {object} Versioned immutable archive evidence or an explicit refusal.
 */
export function captureWorktreeReuseEvidence(entry, orgFile) {
  try {
    assert(
      entry.reuseProtocol?.version === 1 &&
        entry.reuseProtocol.registeredBy === "kickoff-claim",
      "source-protocol-not-participating-at-registration",
    );
    const workflows = workflowProofs(entry, orgFile);
    for (const workflow of workflows) {
      const integration = workflow.state.integration?.decision;
      assert(
        workflow.state.status === "accepted" &&
          integration?.componentResults &&
          workflow.integrationAcceptance,
        `Workflow ${workflow.workflowId} has no accepted integration`,
      );
      for (const { taskId, task, acceptance } of workflow.tasks) {
        const component = integration.componentResults[taskId];
        assert(
          acceptance &&
            component?.acceptedResult === task.acceptedResult &&
            component.revision === task.revision,
          `Integrated component ${workflow.workflowId}/${taskId} does not match acceptance`,
        );
        assert(
          component.attemptId === task.attemptId,
          `Integrated attempt changed for ${taskId}`,
        );
      }
    }
    const proof = { kickoffHash: kickoffHashFor(entry), workflows };
    return { schemaVersion: 1, status: "proven", proof, digest: hash(proof) };
  } catch (error) {
    return { schemaVersion: 1, status: "unavailable", reason: error.message };
  }
}

/**
 * Discovers source records without inventing acceptance fields in legacy archives.
 * A source read error remains visible and never becomes an empty successful scan.
 * @param {string} orgFile - Organization registry anchor.
 * @param {object} target - Target PM state and requested execution role.
 * @returns {object} Candidates plus explicit source rejection records.
 */
export function discoverReusableWorktrees(orgFile, target) {
  const candidates = [];
  const rejected = [];
  const active = listKickoffs(orgFile).kickoffs;
  const current = active.find(
    (entry) =>
      path.resolve(entry.pm.stateDir) === path.resolve(target.stateDir),
  );
  assert(
    current,
    "Reusable worktree target must be a registered active kickoff",
  );
  const sources = active.map((entry) => ({ entry }));
  const history = path.join(path.dirname(fs.realpathSync(orgFile)), "history");
  if (fs.existsSync(history)) {
    for (const name of fs
      .readdirSync(history)
      .filter((name) => /^kickoff-.*\.json$/.test(name))
      .sort()) {
      const archiveFile = path.join(history, name);
      try {
        sources.push({ entry: readJSON(archiveFile), archiveFile });
      } catch (error) {
        rejected.push({
          archiveFile,
          reason: `archive-unreadable: ${error.message}`,
        });
      }
    }
  }
  for (const source of sources) {
    try {
      const { entry, archiveFile } = source;
      assert(archiveFile || entry === current, "other-kickoff-active");
      assert(
        entry.reuseProtocol?.version === 1 &&
          entry.reuseProtocol.registeredBy === "kickoff-claim" &&
          entry.reuseProtocol.organizationFile === fs.realpathSync(orgFile),
        "source-protocol-not-participating-at-registration",
      );
      let workflows;
      if (archiveFile) {
        assert(
          !active.some((item) => item.pm.worktreeId === entry.pm.worktreeId),
          "archived-parent-has-active-owner",
        );
        assert(
          entry.reuseProtocol?.version === 1 &&
            entry.reuseProtocol.registeredBy === "kickoff-claim" &&
            entry.reuseProtocol.organizationFile === fs.realpathSync(orgFile),
          "source-protocol-not-participating-at-registration",
        );
        const evidence = entry.reuseEvidence;
        assert(
          entry.releaseReason === "completed" && entry.releasedAt,
          "source-not-completed",
        );
        assert(
          evidence?.schemaVersion === 1 && evidence.status === "proven",
          "archive-reuse-proof-absent",
        );
        assert(
          evidence.digest === hash(evidence.proof) &&
            evidence.proof.kickoffHash === kickoffHashFor(entry),
          "archive-proof-mismatch",
        );
        workflows = evidence.proof.workflows;
      } else workflows = workflowProofs(entry, orgFile);
      for (const workflow of workflows) {
        for (const { taskId, task, acceptance } of workflow.tasks) {
          const worktreeId = task.worktreeId ?? task.execution?.worktreeId;
          if (
            !worktreeId ||
            (workflow.workflowId === target.workflowId &&
              taskId === target.taskId &&
              entry === current)
          )
            continue;
          if (
            task.state !== "accepted" ||
            !acceptance ||
            (task.executionRole ?? task.role) !== target.role
          ) {
            rejected.push({
              worktreeId,
              reason: "source-task-not-accepted-or-role-mismatch",
            });
            continue;
          }
          const component =
            workflow.state.integration?.decision?.componentResults?.[taskId];
          if (
            workflow.state.status !== "accepted" ||
            !workflow.integrationAcceptance ||
            !component ||
            component.acceptedResult !== task.acceptedResult ||
            component.attemptId !== task.attemptId ||
            component.revision !== task.revision
          ) {
            rejected.push({
              worktreeId,
              reason: "source-integration-decision-mismatch",
            });
            continue;
          }
          assert(
            !workflows.some((other) =>
              other.tasks.some(
                ({ task: competing }) =>
                  competing.state !== "accepted" &&
                  (competing.worktreeId ?? competing.execution?.worktreeId) ===
                    worktreeId,
              ),
            ),
            "worktree-has-unaccepted-source-task",
          );
          candidates.push({
            ...source,
            workflowId: workflow.workflowId,
            taskId,
            task,
            worktreeId,
          });
        }
      }
    } catch (error) {
      rejected.push({
        worktreeId: source.entry?.pm?.worktreeId,
        archiveFile: source.archiveFile,
        reason: error.message,
      });
    }
  }
  return { current, candidates, rejected };
}

function recordSelection(request, rejected, selected) {
  const file = path.join(
    path.dirname(fs.realpathSync(request.orgFile)),
    "worktree-reuse-decisions.json",
  );
  const record = fs.existsSync(file)
    ? readJSON(file)
    : { schemaVersion: 1, decisions: [] };
  assert(
    record.schemaVersion === 1 && Array.isArray(record.decisions),
    "Reuse decision log is unreadable",
  );
  record.decisions.push({
    at: new Date().toISOString(),
    workflowId: request.workflowId,
    taskId: request.taskId,
    stateDir: request.stateDir,
    selected: selected ?? null,
    rejected,
  });
  writeJSON(file, record);
}

function shownBody(receipt) {
  const worktree = receipt?.result?.worktree;
  assert(
    worktree?.identity?.key &&
      worktree.identity.instanceId &&
      worktree.identity.executionHostId,
    "worktree-identity-unproven",
  );
  return worktree;
}

function validLineage(worktree, parent) {
  return (
    worktree.parentWorktreeId === parent.id &&
    worktree.lineage?.worktreeId === worktree.id &&
    worktree.lineage.worktreeInstanceId === worktree.identity.instanceId &&
    worktree.lineage.parentWorktreeId === parent.id &&
    worktree.lineage.parentWorktreeInstanceId === parent.identity.instanceId &&
    worktree.lineage.origin === "cli" &&
    worktree.lineage.capture?.confidence === "explicit"
  );
}

/**
 * Proves an exact observed lineage against a previously completed transfer receipt.
 * It never treats arbitrary manual lineage as trusted.
 * @param {string} orgFile - Organization owning the transition ledger.
 * @param {object} worktree - Fresh Orca worktree show observation.
 * @returns {boolean} Whether the entire identity and lineage match the last transfer.
 */
export function transferredLineageProven(orgFile, worktree) {
  const entries = readWorktreeTransitions(orgFile).entries.filter(
    (entry) => entry.worktreeId === worktree.id && entry.type === "reuse",
  );
  const last = entries.at(-1);
  return (
    last?.status === "completed" &&
    last.result?.after?.identity?.key === worktree.identity?.key &&
    hash(last.result.after.lineage) === hash(worktree.lineage) &&
    last.targetWorktreeId === worktree.parentWorktreeId
  );
}

/**
 * Selects and reserves one proven candidate under the common mutation fence.
 * The launch callback runs inside the fence; errors after prepare preserve the candidate.
 * @param {object} request - Target organization, workflow, task, role, base and PM checkout.
 * @param {Function} launch - Opens the chosen workspace or creates after explicit rejections.
 * @param {object} ports - Injectable inventory, Git, and Orca adapters.
 * @returns {Promise<object>} Launch result and reusable candidate rejection evidence.
 */
export async function withAutomaticWorktreeReuse(
  request,
  launch,
  {
    discover = discoverReusableWorktrees,
    scan = scanKickoffCleanup,
    show = runOrcaJson,
    gitCommand = git,
    reparent = reparentWorktree,
  } = {},
) {
  return withWorktreeLock(request.orgFile, async (prepare) => {
    const found = discover(request.orgFile, request);
    assert(
      fs.realpathSync(found.current.pm.path) === fs.realpathSync(request.repo),
      "Target PM checkout mismatch",
    );
    if (request.selectedWorktreeId)
      found.candidates = found.candidates.filter(
        (item) => item.worktreeId === request.selectedWorktreeId,
      );
    if (found.candidates.length === 0) {
      assert(
        !request.selectedWorktreeId,
        "Explicit worktree has no proven reusable source",
      );
      recordSelection(request, found.rejected, null);
      return {
        ...(await launch(null, prepare)),
        reuseRejections: found.rejected,
      };
    }
    const executable = selectOrcaExecutable(request.executable);
    const readShown = async (id) =>
      shownBody(
        await show(executable, ["worktree", "show", "--worktree", `id:${id}`], {
          cwd: request.repo,
        }),
      );
    const target = await readShown(found.current.pm.worktreeId);
    assert(
      target.id === found.current.pm.worktreeId &&
        target.path === found.current.pm.path,
      "Target identity mismatch",
    );
    const base = await gitCommand(request.repo, [
      "rev-parse",
      `${request.base}^{commit}`,
    ]);
    assert(
      base === (await gitCommand(request.repo, ["rev-parse", "HEAD"])),
      "Reuse base must match current integration HEAD",
    );
    for (const source of found.candidates) {
      let before;
      let candidate;
      try {
        const last = readWorktreeTransitions(request.orgFile)
          .entries.filter(
            (entry) =>
              entry.worktreeId === source.worktreeId && entry.type === "reuse",
          )
          .at(-1);
        assert(
          !last ||
            (last.targetWorktreeId === source.entry.pm.worktreeId &&
              last.workflowId === source.workflowId &&
              last.taskId === source.taskId),
          "source-ownership-retired",
        );
        const observed = await scan({
          orgFile: request.orgFile,
          worktreeId: source.entry.pm.worktreeId,
          archiveFile: source.archiveFile,
          executable,
          integrationCommit: source.archiveFile ? undefined : base,
        });
        candidate = observed.candidates.find(
          (item) => item.worktreeId === source.worktreeId,
        );
        assert(
          observed.inventoryComplete && candidate?.status === "safe-to-remove",
          candidate?.reasons?.join(",") || "source-inventory-unproven",
        );
        before = await readShown(source.worktreeId);
        const parent = await readShown(source.entry.pm.worktreeId);
        assert(
          before.id === source.worktreeId &&
            before.path === candidate.path &&
            before.repoId === target.repoId &&
            before.identity.instanceId === candidate.instanceId &&
            before.identity.executionHostId === candidate.hostId,
          "source-identity-changed",
        );
        assert(
          before.parentWorktreeId === parent.id &&
            (validLineage(before, parent) ||
              transferredLineageProven(request.orgFile, before)),
          "source-lineage-unproven",
        );
        assert(before.childWorktreeIds?.length === 0, "source-has-children");
        assert(before.head === candidate.git.head, "source-head-changed");
        await gitCommand(before.path, [
          "merge-base",
          "--is-ancestor",
          before.head,
          base,
        ]);
        assert(
          !(await gitCommand(before.path, [
            "status",
            "--porcelain=v1",
            "-uall",
          ])),
          "source-git-dirty",
        );
      } catch (error) {
        found.rejected.push({
          worktreeId: source.worktreeId,
          reason: error.message,
        });
        continue;
      }
      const refreshed = await readShown(source.worktreeId);
      const refreshedTarget = await readShown(target.id);
      assert(
        hash(refreshed) === hash(before) &&
          hash(refreshedTarget.identity) === hash(target.identity),
        "Worktree identity or lineage changed before transfer; preserve candidate",
      );
      assert(
        base === (await gitCommand(request.repo, ["rev-parse", "HEAD"])),
        "Target integration HEAD changed before transfer",
      );
      recordSelection(request, found.rejected, source.worktreeId);
      const transaction = prepare({
        type: "reuse",
        worktreeId: source.worktreeId,
        before,
        sourceWorktreeId: source.entry.pm.worktreeId,
        sourceWorkflowId: source.workflowId,
        sourceTaskId: source.taskId,
        targetWorktreeId: target.id,
        workflowId: request.workflowId,
        taskId: request.taskId,
        base,
      });
      let receipt;
      if (before.parentWorktreeId !== target.id) {
        receipt = await reparent(request.repo, {
          identityKey: before.identity.key,
          parentIdentityKey: target.identity.key,
          executable,
        });
      }
      const after = await readShown(source.worktreeId);
      assert(
        after.id === before.id &&
          after.path === before.path &&
          after.repoId === before.repoId &&
          hash(after.identity) === hash(before.identity) &&
          after.lineage?.worktreeId === after.id &&
          after.lineage.worktreeInstanceId === after.identity.instanceId &&
          after.lineage.parentWorktreeId === target.id &&
          after.lineage.capture?.confidence === "explicit" &&
          after.parentWorktreeId === target.id &&
          after.lineage?.parentWorktreeInstanceId ===
            target.identity.instanceId &&
          after.head === before.head,
        "Post-transfer identity, parent or HEAD unproven; preserve candidate",
      );
      transaction.complete({ after, receipt });
      const result = await launch({ ...source, before, after, base }, prepare);
      return { ...result, reuseRejections: found.rejected };
    }
    assert(
      !request.selectedWorktreeId,
      "Explicit worktree failed reuse proofs",
    );
    recordSelection(request, found.rejected, null);
    const result = await launch(null, prepare);
    return { ...result, reuseRejections: found.rejected };
  });
}
