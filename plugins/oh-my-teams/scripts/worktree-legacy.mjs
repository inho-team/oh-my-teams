/** Strictly bounded compatibility for pre-protocol, same-task role lifecycles. */
import fs from "node:fs";
import path from "node:path";
import { assert, assertDirectorySync, hash } from "./core.mjs";
import { listKickoffs } from "./kickoff-registry.mjs";
import { readWorkflow } from "./workflow.mjs";
import { readWorktreeTransitions } from "./worktree-transactions.mjs";
import { runOrcaJson, selectOrcaExecutable } from "./orca-adapter.mjs";

function identityProof(child, parent, owner) {
  const lineage = child.lineage;
  return (
    child.identity?.key &&
    child.identity.instanceId &&
    child.identity.executionHostId &&
    child.repoId &&
    child.repoId === parent.repoId &&
    child.identity.executionHostId === parent.identity?.executionHostId &&
    parent.id === owner.pm.worktreeId &&
    parent.path === owner.pm.path &&
    parent.identity?.key &&
    parent.identity.instanceId &&
    child.parentWorktreeId === parent.id &&
    lineage?.worktreeId === child.id &&
    lineage.worktreeInstanceId === child.identity.instanceId &&
    lineage.parentWorktreeId === parent.id &&
    lineage.parentWorktreeInstanceId === parent.identity.instanceId &&
    lineage.origin === "cli" &&
    lineage.capture?.confidence === "explicit" &&
    Number.isFinite(child.createdAt) &&
    Number.isFinite(lineage.createdAt) &&
    lineage.createdAt >= child.createdAt
  );
}

function assertOnlyAssignment(
  orgFile,
  owner,
  workflowId,
  taskId,
  childId,
  workflowState,
) {
  const inspect = (candidateOwner, id, state) => {
    if (
      candidateOwner.pm.worktreeId === owner.pm.worktreeId &&
      id === workflowId
    ) {
      const current = state.tasks?.[taskId];
      assert(
        (current?.worktreeId ?? current?.execution?.worktreeId) === childId,
        "Legacy task no longer owns this instance",
      );
    }
    for (const [key, candidate] of Object.entries(state.tasks ?? {})) {
      const owns =
        (candidate.worktreeId ?? candidate.execution?.worktreeId) === childId;
      assert(
        !owns ||
          (candidateOwner.pm.worktreeId === owner.pm.worktreeId &&
            id === workflowId &&
            key === taskId),
        "Legacy instance is claimed by another workflow task",
      );
    }
  };
  inspect(owner, workflowId, workflowState);
  for (const entry of listKickoffs(orgFile).kickoffs) {
    const directory = path.join(entry.pm.stateDir, "workflows");
    if (!fs.existsSync(directory)) continue;
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (item.isDirectory())
        inspect(
          entry,
          item.name,
          readWorkflow(entry.pm.stateDir, item.name).state,
        );
    }
  }
}

/**
 * Prepares a normal durable transition, or proves a narrowly scoped legacy lifecycle.
 * Only the capability probe is caught; an interrupted durable write never falls back.
 * The caller holds the organization fence and retains every Git and termination gate.
 * @param {object} request - Organization, registered owner, exact task and observed child.
 * @param {object} ports - Locked prepare factory, fresh Orca reader and complete launch ledger.
 * @returns {Promise<object>} Transaction with an optional explicit non-durable legacy marker.
 */
export async function prepareRoleLifecycle(
  request,
  { prepare, show = runOrcaJson, launches },
) {
  const {
    orgFile,
    owner,
    task,
    workflowId,
    taskId,
    workflowState,
    child,
    operation,
    expectedHead,
    executable,
    repo,
  } = request;
  let unavailable;
  try {
    assertDirectorySync(path.dirname(fs.realpathSync(orgFile)));
  } catch (error) {
    if (error.code !== "worktree-durability-unavailable") throw error;
    unavailable = error;
  }
  if (!unavailable) return prepare(operation);
  if (!owner || Object.hasOwn(owner, "reuseProtocol")) throw unavailable;
  assert(
    operation.type === "role-promotion" || operation.type === "role-reclaim",
    "Legacy lifecycle cannot transfer ownership",
  );
  assert(
    (task.worktreeId ?? task.execution?.worktreeId) === child.id,
    "Legacy lifecycle requires the same task's current worktree",
  );
  const observed = async (id) =>
    (
      await show(
        selectOrcaExecutable(executable),
        ["worktree", "show", "--worktree", `id:${id}`],
        { cwd: repo },
      )
    ).result?.worktree;
  assert(
    typeof expectedHead === "string" &&
      expectedHead &&
      child.head === expectedHead,
    "Legacy Orca and Git HEAD disagree",
  );
  const parent = await observed(owner.pm.worktreeId);
  assert(
    parent && identityProof(child, parent, owner),
    "Legacy instance, parent or explicit lineage is unproven",
  );
  assert(
    child.id === `${child.repoId}::${child.path}` &&
      child.createdAt >= Date.parse(owner.createdAt),
    "Legacy instance predates its owner or has a mismatched path",
  );
  const entries = readWorktreeTransitions(orgFile).entries;
  assert(
    !entries.some(
      (entry) =>
        entry.worktreeId === child.id ||
        entry.before?.id === child.id ||
        entry.result?.after?.id === child.id,
    ),
    "Legacy lifecycle cannot touch a journal-owned worktree",
  );
  assertOnlyAssignment(
    orgFile,
    owner,
    workflowId,
    taskId,
    child.id,
    workflowState,
  );
  const history = launches.filter(
    (entry) =>
      entry.worktreePath &&
      path.resolve(entry.worktreePath) === path.resolve(child.path),
  );
  assert(
    history.length &&
      history.every(
        (entry) =>
          (entry.worktreeProtocolVersion == null ||
            entry.worktreeProtocolVersion === 1) &&
          entry.kickoffPmWorktreeId === owner.pm.worktreeId &&
          entry.workflowId === workflowId &&
          Date.parse(entry.at) >= child.lineage.createdAt &&
          ((entry.via === "worker-start" &&
            entry.workflowTaskId === taskId &&
            typeof entry.workerId === "string" &&
            entry.workerId) ||
            (entry.via === "role-terminal" &&
              (entry.workflowTaskId == null ||
                entry.workflowTaskId === taskId) &&
              typeof entry.terminal === "string" &&
              entry.terminal &&
              history.some(
                (worker) =>
                  worker.via === "worker-start" &&
                  worker.terminal === entry.terminal &&
                  worker.workflowTaskId === taskId &&
                  worker.workflowId === workflowId &&
                  worker.kickoffPmWorktreeId === owner.pm.worktreeId &&
                  Date.parse(worker.at) >= Date.parse(entry.at),
              ))),
      ),
    "Legacy launch ownership, assignment or instance age is unproven",
  );
  assert(
    history.some(
      (entry) =>
        entry.via === "worker-start" &&
        entry.worktreeProtocolVersion == null &&
        typeof entry.terminal === "string" &&
        entry.terminal &&
        typeof entry.workerId === "string" &&
        entry.workerId,
    ),
    "No actual pre-protocol Dispatch owns this legacy instance",
  );
  const legacyLifecycle = {
    mode: "legacy-same-task",
    durable: false,
    reason: unavailable.message,
  };
  let completed = false;
  return {
    legacyLifecycle,
    async revalidate() {
      assertOnlyAssignment(
        orgFile,
        owner,
        workflowId,
        taskId,
        child.id,
        workflowState,
      );
      const current = await observed(child.id);
      const currentParent = await observed(parent.id);
      assert(
        current &&
          currentParent &&
          identityProof(current, currentParent, owner) &&
          hash(current.identity) === hash(child.identity) &&
          hash(current.lineage) === hash(child.lineage) &&
          current.path === child.path &&
          current.head === expectedHead &&
          current.createdAt === child.createdAt &&
          hash(currentParent.identity) === hash(parent.identity),
        "Legacy identity changed during lifecycle; preserve it",
      );
    },
    complete(result) {
      assert(!completed, "Legacy lifecycle already completed");
      completed = true;
      return { ...result, legacyLifecycle };
    },
  };
}
