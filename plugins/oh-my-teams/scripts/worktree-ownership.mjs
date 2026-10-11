/** Registration-incarnation ownership proofs shared by cleanup and branch deletion. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assert, hash, readJSON } from "./core.mjs";
import { kickoffHashFor } from "./kickoff-registry.mjs";
import { readLaunches } from "./usage-ledger.mjs";
import { readWorkflow } from "./workflow.mjs";
import { readWorktreeTransitions } from "./worktree-transactions.mjs";

function registrations(orgFile, selectedId, excluded) {
  const root = path.dirname(fs.realpathSync(orgFile));
  const selectedHash = crypto
    .createHash("sha256")
    .update(selectedId)
    .digest("hex");
  const entries = [];
  for (const kind of ["kickoffs", "history"]) {
    const directory = path.join(root, kind);
    if (!fs.existsSync(directory)) continue;
    for (const name of fs
      .readdirSync(directory)
      .filter(
        (name) =>
          name.endsWith(".json") &&
          !name.startsWith(".") &&
          (kind !== "history" || name.startsWith("kickoff-")),
      )) {
      let record;
      try {
        record = readJSON(path.join(directory, name));
        assert(
          typeof record.pm?.worktreeId === "string" &&
            record.pm.worktreeId &&
            typeof record.pm.path === "string" &&
            path.isAbsolute(record.pm.path) &&
            typeof record.pm.stateDir === "string" &&
            path.isAbsolute(record.pm.stateDir) &&
            Number.isFinite(Date.parse(record.createdAt)),
          "archive-registration-identity-unproven",
        );
        assert(
          record.registrationSeq === undefined ||
            (Number.isInteger(record.registrationSeq) &&
              record.registrationSeq > 0),
          "archive-registration-sequence-unproven",
        );
        const namedHash = name.match(
          /^(?:kickoff-)?([a-f0-9]{64})(?:-|\.json$)/,
        )?.[1];
        assert(
          !namedHash ||
            namedHash ===
              crypto
                .createHash("sha256")
                .update(record.pm.worktreeId)
                .digest("hex"),
          "archive-registration-filename-mismatch",
        );
        assert(
          (kind !== "history" && record.releasedAt === undefined) ||
            (Number.isFinite(Date.parse(record.releasedAt)) &&
              Date.parse(record.releasedAt) >= Date.parse(record.createdAt)),
          "archive-release-time-unproven",
        );
        entries.push(record);
      } catch (error) {
        excluded.push({
          file: path.join(directory, name),
          reason: error.message,
        });
        // An unrelated historical summary must not suppress a proven candidate.
        // A damaged record for this exact owner can conceal a later registration.
        assert(
          !name.includes(selectedHash) && record?.pm?.worktreeId !== selectedId,
          "kickoff-incarnation-history-unverifiable",
        );
      }
    }
  }
  return entries;
}

function tasksFor(entry) {
  if (entry.releasedAt) {
    const evidence = entry.reuseEvidence;
    assert(
      evidence?.status === "proven" &&
        evidence.digest === hash(evidence.proof) &&
        evidence.proof.kickoffHash === kickoffHashFor(entry),
      "archive-ownership-proof-unavailable",
    );
    return evidence.proof.workflows.flatMap((workflow) =>
      workflow.tasks.map((item) => ({ ...item, workflow })),
    );
  }
  const directory = path.join(entry.pm.stateDir, "workflows");
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((v) => v.isDirectory())
    .flatMap((v) => {
      const { state } = readWorkflow(entry.pm.stateDir, v.name);
      return Object.entries(state.tasks).map(([taskId, task]) => ({
        taskId,
        task,
        workflow: { workflowId: v.name, state },
      }));
    });
}

/**
 * Proves a resource belongs to this registration, not merely the same PM path.
 * @param {string} orgFile - Canonical organization anchor.
 * @param {object} entry - Selected active or archived registration.
 * @param {string} worktreeId - Exact candidate resource identity.
 * @param {object} [current] - Exact current scanner identity, when listed.
 * @returns {object} Proven task/registration binding or a conservative refusal.
 */
export function proveKickoffWorktreeOwnership(
  orgFile,
  entry,
  worktreeId,
  current,
) {
  const excludedRegistrations = [];
  try {
    assert(
      typeof entry?.pm?.worktreeId === "string" && entry.pm.worktreeId,
      "kickoff-registration-identity-unproven",
    );
    const all = registrations(
      orgFile,
      entry.pm.worktreeId,
      excludedRegistrations,
    );
    const start = Date.parse(entry.createdAt);
    assert(Number.isFinite(start), "kickoff-incarnation-unproven");
    const sameParent = all.filter(
      (v) => v.pm.worktreeId === entry.pm.worktreeId,
    );
    const registered = sameParent.filter(
      (v) =>
        v.createdAt === entry.createdAt &&
        v.registrationSeq === entry.registrationSeq,
    );
    assert(
      registered.length === 1 &&
        hash(registered[0].delivered ?? null) === hash(entry.delivered ?? null),
      "kickoff-registration-record-mismatch",
    );
    assert(
      registered[0].releasedAt === entry.releasedAt &&
        (!entry.releasedAt ||
          hash(registered[0].reuseEvidence ?? null) ===
            hash(entry.reuseEvidence ?? null)),
      "kickoff-registration-evidence-mismatch",
    );
    assert(
      sameParent.every(
        (other) =>
          !entry.registrationSeq ||
          !other.registrationSeq ||
          other.registrationSeq === entry.registrationSeq ||
          (other.registrationSeq - entry.registrationSeq) *
            (Date.parse(other.createdAt) - start) >
            0,
      ),
      "kickoff-incarnation-sequence-conflict",
    );
    const later = sameParent.filter((v) => Date.parse(v.createdAt) > start);
    const next = Math.min(...later.map((v) => Date.parse(v.createdAt)));
    const end = Math.min(
      next,
      entry.releasedAt ? Date.parse(entry.releasedAt) : Infinity,
    );
    const kickoffHash = entry.registrationSeq ? kickoffHashFor(entry) : null;
    assert(
      !sameParent.some(
        (v) =>
          v.createdAt === entry.createdAt &&
          v.registrationSeq !== entry.registrationSeq,
      ),
      "kickoff-incarnation-ambiguous",
    );
    if (worktreeId === entry.pm.worktreeId) {
      assert(later.length === 0, "pm-owned-by-later-registration");
      return {
        status: "proven",
        excludedRegistrations,
        kind: "pm",
        kickoffHash,
        registrationSeq: entry.registrationSeq,
        createdAt: entry.createdAt,
      };
    }
    const location = worktreeId.slice(worktreeId.indexOf("::") + 2);
    assert(worktreeId.includes("::"), "candidate-identity-unproven");
    const history = readLaunches(orgFile, { strict: true }).filter(
      (v) =>
        typeof v.worktreePath === "string" &&
        path.resolve(v.worktreePath) === path.resolve(location),
    );
    assert(
      history.every((launch) => Number.isFinite(Date.parse(launch.at))),
      "candidate-launch-time-unproven",
    );
    const launches = history.filter(
      (v) =>
        Date.parse(v.at) >= start &&
        Date.parse(v.at) <= end &&
        Date.parse(v.at) < next,
    );
    assert(
      launches.length &&
        launches.every(
          (v) =>
            v.kickoffPmWorktreeId === entry.pm.worktreeId &&
            (!v.kickoffHash || v.kickoffHash === kickoffHash) &&
            (v.kickoffRegistrationSeq === undefined ||
              v.kickoffRegistrationSeq === entry.registrationSeq) &&
            (v.kickoffCreatedAt === undefined ||
              v.kickoffCreatedAt === entry.createdAt),
        ),
      "candidate-kickoff-incarnation-unproven",
    );
    const transitions = readWorktreeTransitions(orgFile).entries.filter(
      (v) => v.type === "reuse" && v.worktreeId === worktreeId,
    );
    const transfer = transitions.at(-1);
    if (transfer) {
      assert(
        transfer.status === "completed" &&
          transfer.targetWorktreeId === entry.pm.worktreeId &&
          (transfer.targetKickoffHash
            ? transfer.targetKickoffHash === kickoffHash
            : Date.parse(transfer.finishedAt) >= start &&
              Date.parse(transfer.finishedAt) <= end),
        "candidate-ownership-transferred",
      );
    }
    if (transfer) {
      const sourceRegistrations = all.filter(
        (source) =>
          source.pm.worktreeId === transfer.sourceWorktreeId &&
          (transfer.sourceKickoffHash
            ? source.registrationSeq &&
              kickoffHashFor(source) === transfer.sourceKickoffHash
            : tasksFor(source).some(
                ({ taskId, task, workflow }) =>
                  workflow.workflowId === transfer.sourceWorkflowId &&
                  taskId === transfer.sourceTaskId &&
                  (task.worktreeId ?? task.execution?.worktreeId) ===
                    worktreeId,
              )),
      );
      assert(
        sourceRegistrations.length === 1,
        "candidate-transfer-source-registration-unproven",
      );
      const before = transfer.before;
      const after = transfer.result?.after;
      assert(
        before?.id === worktreeId &&
          before.parentWorktreeId === transfer.sourceWorktreeId &&
          after?.id === worktreeId &&
          hash(before.identity) === hash(after.identity) &&
          after.parentWorktreeId === entry.pm.worktreeId &&
          after.lineage?.worktreeInstanceId === after.identity?.instanceId &&
          after.lineage?.parentWorktreeId === entry.pm.worktreeId,
        "candidate-transfer-journal-unproven",
      );
      if (current)
        assert(
          current.worktreeInstanceId === after.identity.instanceId &&
            current.hostId === after.identity.executionHostId &&
            current.parentWorktreeId === after.parentWorktreeId,
          "candidate-transfer-current-owner-mismatch",
        );
    }
    assert(
      !history.some((v) => Date.parse(v.at) < start) || transfer,
      "candidate-owned-before-registration",
    );
    assert(
      !history.some((v) => Date.parse(v.at) > end || Date.parse(v.at) >= next),
      "candidate-owned-by-later-registration",
    );
    if (
      launches.every(
        (v) =>
          v.via === "role-terminal" &&
          !v.workflowId &&
          !v.workflowTaskId &&
          !v.workerId,
      ) &&
      !transfer
    )
      return {
        status: "proven",
        excludedRegistrations,
        kind: "taskless",
        kickoffHash,
        registrationSeq: entry.registrationSeq,
        createdAt: entry.createdAt,
      };
    const bindings = tasksFor(entry).filter(
      ({ task }) =>
        (task.worktreeId ?? task.execution?.worktreeId) === worktreeId,
    );
    assert(bindings.length > 0, "candidate-task-ownership-unproven");
    const matched = bindings.filter(
      ({ taskId, task, acceptance, workflow }) => {
        const executionId = task.workerRunId ?? task.execution?.executionId;
        const attempt = task.attempts?.find((row) => row.id === task.attemptId);
        if (
          !attempt ||
          attempt.receipt?.executionId !== executionId ||
          attempt.receipt?.worktreeId !== worktreeId ||
          !Number.isFinite(Date.parse(attempt.attachedAt)) ||
          Date.parse(attempt.attachedAt) < start ||
          Date.parse(attempt.attachedAt) > end
        )
          return false;
        if (!Number.isInteger(task.revision) || !task.attemptId || !executionId)
          return false;
        if (entry.releasedAt) {
          const component =
            workflow.state.integration?.decision?.componentResults?.[taskId];
          if (
            workflow.state.status !== "accepted" ||
            task.state !== "accepted" ||
            !workflow.integrationAcceptance ||
            Date.parse(acceptance?.createdAt) < start ||
            Date.parse(acceptance?.createdAt) > end ||
            !Number.isFinite(Date.parse(acceptance?.createdAt)) ||
            acceptance?.status !== "accepted" ||
            acceptance?.taskRevision !== task.revision ||
            acceptance?.id !== task.acceptedResult ||
            acceptance.taskId !== taskId ||
            acceptance.taskHash !== task.taskHash ||
            acceptance.implementationExecutionId !== executionId ||
            component?.acceptedResult !== task.acceptedResult ||
            component.revision !== task.revision ||
            component.attemptId !== task.attemptId
          )
            return false;
        }
        return (
          launches.some(
            (v) =>
              v.via === "worker-start" &&
              v.workerId === executionId &&
              (!attempt.receipt.terminal ||
                v.terminal === attempt.receipt.terminal) &&
              v.workflowId === workflow.workflowId &&
              v.workflowTaskId === taskId,
          ) &&
          (!transfer ||
            (transfer.workflowId === workflow.workflowId &&
              transfer.taskId === taskId))
        );
      },
    );
    assert(matched.length === 1, "candidate-task-attempt-ownership-unproven");
    const { taskId, task, workflow } = matched[0];
    assert(
      launches.every(
        (v) =>
          v.workflowId === workflow.workflowId &&
          (v.workflowTaskId === taskId ||
            (v.via === "role-terminal" &&
              v.workflowTaskId == null &&
              launches.some(
                (worker) =>
                  worker.via === "worker-start" &&
                  worker.terminal === v.terminal &&
                  worker.workflowTaskId === taskId &&
                  Date.parse(worker.at) >= Date.parse(v.at),
              ))),
      ),
      "candidate-launch-assignment-mismatch",
    );
    return {
      status: "proven",
      excludedRegistrations,
      kind: "task",
      kickoffHash,
      registrationSeq: entry.registrationSeq,
      createdAt: entry.createdAt,
      workflowId: workflow.workflowId,
      taskId,
      attemptId: task.attemptId,
      revision: task.revision,
      acceptedResult: task.acceptedResult ?? null,
      executionId: task.workerRunId ?? task.execution?.executionId,
    };
  } catch (error) {
    return { status: "unproven", excludedRegistrations, reason: error.message };
  }
}
