/** Read-only proof and append-only preservation of an interrupted role reclamation. */
import fs from "node:fs";
import path from "node:path";
import { assert, hash, readJSON } from "./core.mjs";
import { listKickoffs, kickoffHashFor } from "./kickoff-registry.mjs";
import { assertDirectorAuthority } from "./delivery.mjs";
import { readWorkflow } from "./workflow.mjs";
import { git } from "./evidence.mjs";
import { readLaunches, readTerminalClosures } from "./usage-ledger.mjs";
import { scanKickoffCleanup } from "./kickoff-cleanup.mjs";
import {
  completeInventoryRows,
  runOrcaJson,
  selectOrcaExecutable,
} from "./orca-adapter.mjs";
import {
  reconcileWorktreeTransition,
  readWorktreeTransitions,
} from "./worktree-transactions.mjs";

// Reviewed legacy control flow: both occurrences of the scoped-list refusal are
// before reclaimWorktree; every release/close loop iterates the pending owned set.
// A different source needs its own review, never a caller-supplied source digest.
const LEGACY_SOURCE =
  "d12d7d27a9f01ffd13eede3556d56c58bc47004fc09710288e1b80b6c1ac8a4d";
const SOURCE_PATH = "plugins/oh-my-teams/scripts/teams-org.mjs";
const LIST_REFUSAL =
  "Orca did not prove the worktree terminal list; preserve the worktree";

function bytes(file) {
  const value = fs.readFileSync(file, "utf8");
  assert(
    Buffer.byteLength(value) <= 16 * 1024 * 1024,
    "Recovery artifact too large",
  );
  return value;
}

function artifact(ref) {
  assert(
    ref && typeof ref.path === "string" && /^[a-f0-9]{64}$/.test(ref.sha256),
    "Frozen artifact path and SHA required",
  );
  const text = bytes(ref.path);
  assert(hash(text) === ref.sha256, "Frozen recovery artifact changed");
  return { path: fs.realpathSync(ref.path), sha256: ref.sha256, text };
}

function snapshot(org, request, owner) {
  const workflow = readWorkflow(owner.pm.stateDir, request.workflowId).state;
  const task = workflow.tasks[request.taskId];
  assert(
    task?.state === "accepted" && /^[a-zA-Z0-9_-]+$/.test(task.acceptedResult),
    "Exact accepted task required",
  );
  const acceptance = readJSON(
    path.join(owner.pm.stateDir, "decisions", `${task.acceptedResult}.json`),
  );
  assert(
    /^[a-f0-9]{64}$/.test(acceptance.evidenceKey),
    "Accepted evidence key required",
  );
  const evidence = readJSON(
    path.join(owner.pm.stateDir, "evidence", `${acceptance.evidenceKey}.json`),
  );
  assert(
    acceptance.status === "accepted" &&
      acceptance.taskId === request.taskId &&
      acceptance.taskHash === task.taskHash &&
      acceptance.taskRevision === task.revision &&
      acceptance.implementationExecutionId ===
        (task.workerRunId ?? task.execution?.executionId) &&
      (task.worktreeId ?? task.execution?.worktreeId) === request.worktreeId &&
      evidence.key === acceptance.evidenceKey &&
      hash(evidence.fingerprint) === evidence.key &&
      evidence.fingerprint.head === request.expectedHead &&
      evidence.status === "passed" &&
      evidence.unchanged === true,
    "Accepted result, execution or source HEAD changed",
  );
  for (const check of evidence.checks ?? []) {
    assert(
      check.code === 0 &&
        !check.timedOut &&
        !check.overflow &&
        hash(bytes(check.log)) === check.logHash,
      "Accepted evidence log changed",
    );
  }
  assert(evidence.checks?.length > 0, "Accepted result has no checks");
  const location = request.worktreeId.slice(
    request.worktreeId.indexOf("::") + 2,
  );
  const launches = readLaunches(org, { strict: true }).filter(
    (row) =>
      row.worktreePath &&
      path.resolve(row.worktreePath) === path.resolve(location),
  );
  const closures = readTerminalClosures(org, { strict: true }).filter(
    (row) => row.worktreeId === request.worktreeId,
  );
  return { owner, workflow, task, acceptance, evidence, launches, closures };
}

function assertPriorClosure(launch, closures, entry, child, runtimeId) {
  const matching = closures.filter((row) =>
    row.terminals?.some((terminal) => terminal.terminal === launch.terminal),
  );
  assert(matching.length === 1, "Missing or ambiguous exact terminal closure");
  const closure = matching[0];
  const terminal = closure.terminals.find(
    (row) => row.terminal === launch.terminal,
  );
  const release = terminal.releases?.find(
    (row) => row.dispatchId === launch.workerId,
  )?.receipt;
  const close = terminal.close?.receipt;
  for (const receipt of [release, close]) {
    const encoded = JSON.stringify(receipt?.result ?? receipt ?? {});
    assert(
      !encoded.includes("terminal_stop_unverifiable") &&
        !encoded.includes("terminalStopUnverifiable"),
      "Original source would retain an unverifiable terminal",
    );
  }
  assert(
    !/"ptyKilled"\s*:\s*false/.test(
      JSON.stringify(close?.result ?? close ?? {}),
    ),
    "Original source would retain a contradictory PTY close",
  );
  const before = closure.beforeReceipt;
  const after = closure.afterReceipt;
  const oldTerminal = before?.result?.terminals?.find(
    (row) => row.handle === launch.terminal,
  );
  assert(
    closure.at >= launch.at &&
      closure.at < entry.startedAt &&
      Date.parse(closure.at) >= Date.parse(launch.at) &&
      Date.parse(closure.at) < Date.parse(entry.startedAt) &&
      closure.identity?.key === child.identity.key &&
      closure.identity.instanceId === child.identity.instanceId &&
      closure.identity.executionHostId === child.identity.executionHostId &&
      closure.worktreePath === child.path &&
      terminal.dispatch?.result?.status === "clear" &&
      release?.ok === true &&
      release.result?.dispatchId === launch.workerId &&
      release.result.state === "retained" &&
      release.result.reason === "external_terminal" &&
      release.result.processAction === "none" &&
      close?.ok === true &&
      close.result?.close?.handle === launch.terminal &&
      close.result.close.ptyKilled === true &&
      ((typeof close.result.close.tabId === "string" &&
        close.result.close.tabId.length > 0) ||
        Number.isInteger(close.result.close.tabId)) &&
      oldTerminal?.tabId === close.result.close.tabId &&
      typeof oldTerminal?.incarnationId === "string" &&
      oldTerminal.worktreeId === child.id &&
      oldTerminal.executionHostId === child.identity.executionHostId &&
      terminal.workerIds?.includes(launch.workerId),
    "Prepared entry lacks an exact prior release and closure proof",
  );
  for (const receipt of [release, close, before, after]) {
    assert(
      receipt?._meta?.runtimeId === runtimeId && typeof receipt.id === "string",
      "Closure runtime or request identity changed",
    );
  }
  assertHostInventory(before, child.identity.executionHostId, runtimeId);
  assertHostInventory(after, child.identity.executionHostId, runtimeId);
  assert(after.result.terminals.length === 0, "Prior closure left terminals");
}

/**
 * Verifies target-host coverage without discarding unrelated omitted-host metadata.
 * @param {object} receipt - Original scoped terminal-list receipt.
 * @param {string} hostId - Exact execution host.
 * @param {string} runtimeId - Matching runtime identity from worktree show.
 * @returns {void} Returns only for a complete target-host inventory.
 */
export function assertHostInventory(receipt, hostId, runtimeId) {
  const body = receipt?.result;
  assert(
    typeof runtimeId === "string" &&
      runtimeId.length > 0 &&
      receipt?._meta?.runtimeId === runtimeId &&
      completeInventoryRows(body, "terminals") &&
      Array.isArray(body.hostScope?.hostIds) &&
      Array.isArray(body.hostScope?.omittedHostIds) &&
      body.hostScope.hostIds.includes(hostId) &&
      !body.hostScope.omittedHostIds.includes(hostId) &&
      body.terminals.every((row) => row.executionHostId === hostId),
    "Target execution host terminal inventory is incomplete",
  );
}

function assertPreparedFields(entry, request) {
  for (const [field, expected] of Object.entries({
    expectedHead: request.expectedHead,
    workflowId: request.workflowId,
    taskId: request.taskId,
    phase: "before-terminal-proof",
  })) {
    assert(
      !Object.hasOwn(entry, field) || entry[field] === expected,
      `Prepared ${field} conflicts with recovery`,
    );
  }
  const allowed = new Set([
    "id",
    "type",
    "worktreeId",
    "identityKey",
    "sourceWorktreeId",
    "status",
    "startedAt",
    "expectedHead",
    "workflowId",
    "taskId",
    "phase",
  ]);
  assert(
    Object.keys(entry).every((key) => allowed.has(key)),
    "Unsupported prepared entry fields",
  );
}

function assertCreation(child, parent, original, owner, entry) {
  assert(
    child?.lineage && parent?.identity && original?.lineage,
    "Original creation lineage or parent instance is unproven",
  );
  const lineage = child.lineage;
  assert(
    original?.id === child.id &&
      original.repoId === child.repoId &&
      child.repoId === parent.repoId &&
      original.createdAt === child.createdAt &&
      hash(original.lineage) === hash(lineage) &&
      original.identity?.instanceId === child.identity.instanceId &&
      original.identity.key === child.identity.key &&
      parent.id === owner.pm.worktreeId &&
      parent.path === owner.pm.path &&
      parent.identity?.instanceId === lineage?.parentWorktreeInstanceId &&
      parent.identity.executionHostId === child.identity.executionHostId &&
      lineage?.worktreeId === child.id &&
      lineage.worktreeInstanceId === child.identity.instanceId &&
      lineage.parentWorktreeId === parent.id &&
      child.parentWorktreeId === parent.id &&
      lineage.origin === "cli" &&
      lineage.capture?.confidence === "explicit" &&
      Number.isFinite(child.createdAt) &&
      Number.isFinite(lineage.createdAt) &&
      child.createdAt >= Date.parse(owner.createdAt) &&
      lineage.createdAt >= child.createdAt &&
      lineage.createdAt < Date.parse(entry.startedAt),
    "Original creation lineage or parent instance is unproven",
  );
}

function resourceEvidence(org, owner, childId) {
  const directory = path.join(path.dirname(org), "resources");
  const records = fs.existsSync(directory)
    ? fs
        .readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .map((name) => readJSON(path.join(directory, name)))
    : [];
  const relevant = records.filter(
    (record) =>
      record.worktreeId === childId ||
      record.worktreeId === owner.pm.worktreeId,
  );
  assert(
    relevant.length === 0,
    "Child or owning PM resource slots remain; preserve until formally settled",
  );
  return { scope: [owner.pm.worktreeId, childId], relevantSlots: relevant };
}

function originalInvocation(request, owner, entry, artifacts) {
  const execution = JSON.parse(artifacts.execution.text);
  const preparation = JSON.parse(artifacts.preparation.text);
  const argv = execution.argv;
  assert(
    Array.isArray(argv) &&
      argv[2] === "role-worktree-reclaim" &&
      argv.length % 2 === 1,
    "Original reclaim argv required",
  );
  const options = {};
  for (let index = 3; index < argv.length; index += 2) {
    assert(
      typeof argv[index] === "string" &&
        argv[index].startsWith("--") &&
        !Object.hasOwn(options, argv[index]),
      "Ambiguous original option",
    );
    options[argv[index]] = argv[index + 1];
  }
  assert(
    execution.exitCode === 1 &&
      !execution.timedOut &&
      !execution.signal &&
      !execution.interrupted &&
      Date.parse(execution.at) - Date.parse(entry.startedAt) <= 600000 &&
      /^(node|node.exe)$/.test(path.basename(argv[0])) &&
      Date.parse(execution.at) <= Date.now() &&
      execution.cwd === owner.pm.path &&
      Date.parse(execution.at) >= Date.parse(entry.startedAt) &&
      options["--org"] === request.org &&
      options["--state"] === owner.pm.stateDir &&
      options["--repo"] === owner.pm.path &&
      options["--worktree"] === entry.worktreeId &&
      options["--workflow-id"] === request.workflowId &&
      options["--workflow-task"] === request.taskId &&
      options["--merge-commit"] === request.expectedHead &&
      argv[1] === path.join(owner.pm.path, SOURCE_PATH) &&
      artifacts.stderr.text.trim() === LIST_REFUSAL &&
      preparation.childShow?.sha256 === artifacts.creation.sha256 &&
      preparation.childHead === request.expectedHead &&
      preparation.head === request.expectedHead &&
      preparation.exactChild?.worktreeId === entry.worktreeId &&
      preparation.exactChild.identity?.key === entry.identityKey &&
      preparation.exactChild.parentWorktreeId === owner.pm.worktreeId &&
      Date.parse(preparation.observedAt) < Date.parse(entry.startedAt) &&
      hash(preparation.command?.argv) === hash(argv),
    "Original failure provenance or pre-invocation HEAD is unproven",
  );
  return preparation;
}

/**
 * Diagnoses unsupported automatic recovery without writing any state.
 * This uses the repository's registered Director checkout authority, not OS identity authentication.
 * No release, terminal close, removal, workflow acceptance or Goal change is performed.
 * @param {object} args - Canonical organization path and frozen proof-file path.
 * @param {object} ports - Read-only Orca, Git and cleanup ports for synthetic tests.
 * @returns {Promise<never>} Always refuses automatic recovery; use the explicit legacy adoption contract.
 */
export async function reconcilePreparedRoleWorktree(args, ports = {}) {
  const request = readJSON(args.proof);
  const entry = readWorktreeTransitions(args.org).entries.find(
    (row) => row.id === request.entryId,
  );
  assert(
    entry?.status === "prepared",
    "Exact prepared entry required for diagnosis",
  );
  throw new Error(
    "unsupported-legacy-provenance: automatic no-effect recovery is not implemented; no state was changed",
  );
}

/**
 * Adopts an exited legacy invocation and preserves its still-unknown historical outcome.
 * Source control flow supports quiescence inference; no Native trace or no-effect claim is made.
 * @param {object} args - Organization, proof, explicit reason and acknowledgment.
 * @param {object} ports - Read-only adapters for synthetic tests.
 * @returns {Promise<object>} Separate legacy-preservation-adopted disposition.
 */
export async function adoptLegacyRoleWorktree(args, ports = {}) {
  assert(
    typeof args.reason === "string" &&
      args.reason.trim().length >= 20 &&
      args.acknowledgment ===
        "adopted-exited-invocation-plus-reviewed-control-flow",
    "Legacy preservation requires an explicit evidence-adoption reason and uncertainty acknowledgment",
  );
  return reconcileRoleWorktree(args, ports);
}

async function reconcileRoleWorktree(args, ports) {
  const org = fs.realpathSync(args.org);
  const requestText = bytes(args.proof);
  const request = JSON.parse(requestText);
  assert(
    request.schemaVersion === 1 &&
      request.org === org &&
      /^[a-f0-9]{40}$/.test(request.expectedHead),
    "Invalid recovery request",
  );
  const owner = listKickoffs(org, request.ownerWorktreeId).kickoffs[0];
  assert(
    owner?.director?.checkoutPath &&
      owner.director.terminalHandle &&
      owner.runId,
    "Registered owning Director and PM Run required",
  );
  assert(
    fs.realpathSync(process.cwd()) ===
      fs.realpathSync(owner.director.checkoutPath),
    "Recovery requires the owning Director checkout",
  );
  assertDirectorAuthority(owner, process.cwd(), "role-worktree-reconcile");
  const orca = ports.orca ?? runOrcaJson;
  const gitCommand = ports.git ?? git;
  const scan = ports.scan ?? scanKickoffCleanup;
  const artifacts = Object.fromEntries(
    ["execution", "stderr", "preparation", "creation"].map((key) => [
      key,
      artifact(request.artifacts?.[key]),
    ]),
  );
  return reconcileWorktreeTransition(
    org,
    {
      entryId: request.entryId,
      journalSha256: request.journalSha256,
      requestHash: hash({
        requestText,
        mode: "legacy-preservation-adopted",
        reason: args.reason ?? null,
        acknowledgment: args.acknowledgment ?? null,
      }),
    },
    async (entry) => {
      assertPreparedFields(entry, request);
      assert(
        entry.status === "prepared" &&
          entry.worktreeId === request.worktreeId &&
          entry.identityKey === request.identityKey &&
          entry.sourceWorktreeId === owner.pm.worktreeId,
        "Prepared entry ownership changed",
      );
      assert(
        kickoffHashFor(owner) === request.kickoffHash,
        "Registered kickoff changed",
      );
      const initial = snapshot(org, request, owner);
      assert(
        hash(initial) === request.snapshotHash,
        "Frozen task and lifecycle evidence changed",
      );
      assert(
        Date.parse(initial.acceptance.createdAt) < Date.parse(entry.startedAt),
        "Acceptance does not predate failure",
      );
      const preparation = originalInvocation(request, owner, entry, artifacts);
      const originalCreation = JSON.parse(artifacts.creation.text);
      const source = await gitCommand(owner.pm.path, [
        "show",
        `${request.expectedHead}:${SOURCE_PATH}`,
      ]);
      // git() trims textual output; normalize exactly one source trailing newline.
      assert(
        hash(source.trimEnd() + "\n") === LEGACY_SOURCE,
        "Unsupported original reclaim source; independent control-flow review required",
      );
      const observed = async () => {
        const receipt = await orca(
          selectOrcaExecutable(args.orca),
          ["worktree", "show", "--worktree", `identity:${entry.identityKey}`],
          { cwd: owner.pm.path },
        );
        const child = receipt?.result?.worktree;
        const runtimeId = receipt?._meta?.runtimeId;
        const parentReceipt = await orca(
          selectOrcaExecutable(args.orca),
          ["worktree", "show", "--worktree", `id:${owner.pm.worktreeId}`],
          { cwd: owner.pm.path },
        );
        assert(
          parentReceipt?._meta?.runtimeId === runtimeId &&
            originalCreation?._meta?.runtimeId === runtimeId,
          "Creation and parent runtime changed",
        );
        assertCreation(
          child,
          parentReceipt.result?.worktree,
          originalCreation.result?.worktree,
          owner,
          entry,
        );
        assert(
          child?.id === entry.worktreeId &&
            child.identity?.key === entry.identityKey &&
            child.identity.instanceId ===
              preparation.exactChild.identity.instanceId &&
            child.identity.executionHostId ===
              preparation.exactChild.identity.executionHostId &&
            child.parentWorktreeId === owner.pm.worktreeId &&
            child.path ===
              entry.worktreeId.slice(entry.worktreeId.indexOf("::") + 2) &&
            child.head === request.expectedHead &&
            Array.isArray(child.childWorktreeIds) &&
            child.childWorktreeIds.length === 0,
          "Current instance, parent or HEAD changed",
        );
        const terminals = await orca(
          selectOrcaExecutable(args.orca),
          ["terminal", "list", "--worktree", `identity:${entry.identityKey}`],
          { cwd: owner.pm.path },
        );
        assertHostInventory(
          terminals,
          child.identity.executionHostId,
          runtimeId,
        );
        assert(
          terminals.result.terminals.length === 0,
          "Terminal remains connected",
        );
        assert(
          !(await gitCommand(child.path, [
            "status",
            "--porcelain=v1",
            "-uall",
          ])),
          "Child checkout is dirty",
        );
        assert(
          (await gitCommand(child.path, ["rev-parse", "HEAD"])) ===
            request.expectedHead,
          "Current Git HEAD changed",
        );
        await gitCommand(owner.pm.path, [
          "merge-base",
          "--is-ancestor",
          request.expectedHead,
          "HEAD",
        ]);
        const inventory = await scan({
          orgFile: org,
          worktreeId: owner.pm.worktreeId,
          executable: args.orca,
          integrationCommit: request.expectedHead,
          requireCompleteWorkerInventory: true,
        });
        const candidate = inventory.candidates?.find(
          (row) => row.worktreeId === child.id,
        );
        assert(
          inventory.inventoryComplete === true &&
            inventory.workerInventory?.runtimeId === runtimeId &&
            inventory.workerInventory.receipts?.length > 0 &&
            candidate?.status === "safe-to-remove" &&
            candidate.instanceId === child.identity.instanceId &&
            candidate.hostId === child.identity.executionHostId,
          "Global ownership, Dispatch or process proof incomplete",
        );
        assert(
          candidate.ownership?.workflowId === request.workflowId &&
            candidate.ownership.taskId === request.taskId &&
            candidate.ownership.acceptedResult === initial.task.acceptedResult,
          "Current accepted ownership changed",
        );
        return {
          child,
          runtimeId,
          terminals,
          inventory,
          resources: resourceEvidence(org, owner, child.id),
        };
      };
      const first = await observed();
      const workers = initial.launches.filter(
        (row) => row.via === "worker-start",
      );
      assert(
        workers.length > 0 &&
          initial.launches.every(
            (row) =>
              Date.parse(row.at) < Date.parse(entry.startedAt) &&
              row.kickoffPmWorktreeId === owner.pm.worktreeId,
          ),
        "New or ambiguous launch after preparation",
      );
      assert(
        initial.closures.every(
          (row) => Date.parse(row.at) < Date.parse(entry.startedAt),
        ),
        "Closure after preparation requires partial-effect recovery",
      );
      for (const launch of workers)
        assertPriorClosure(
          launch,
          initial.closures,
          entry,
          first.child,
          first.runtimeId,
        );
      assert(
        initial.launches.every((row) =>
          workers.some((worker) => worker.terminal === row.terminal),
        ),
        "Unaccounted role terminal",
      );
      const final = await observed();
      assert(
        hash(first.child) === hash(final.child) &&
          first.runtimeId === final.runtimeId,
        "Instance changed during recovery proof",
      );
      const currentOwner = listKickoffs(org, request.ownerWorktreeId)
        .kickoffs[0];
      assert(
        hash(snapshot(org, request, currentOwner)) === hash(initial),
        "Owner or accepted lifecycle evidence changed during recovery",
      );
      assert(
        bytes(args.proof) === requestText,
        "Recovery request changed during proof",
      );
      for (const [key, ref] of Object.entries(request.artifacts))
        assert(
          hash(artifact(ref)) === hash(artifacts[key]),
          "Recovery artifact changed during proof",
        );
      return {
        schemaVersion: 2,
        disposition: "legacy-preservation-adopted",
        reclaimSucceeded: false,
        ...{
          originalOutcome: "unknown",
          effects: "unknown",
          availableNativeTrace: false,
          quiescenceBasis:
            "adopted-exited-invocation-plus-reviewed-control-flow",
          adoption: {
            reason: args.reason,
            acknowledgment: args.acknowledgment,
            historicalSourceExecution: "director-adopted-not-authenticated",
            noEffectCertified: false,
          },
        },
        authority: {
          kind: "registered-director-checkout",
          checkoutPath: owner.director.checkoutPath,
          terminalHandle: owner.director.terminalHandle,
          kickoffHash: request.kickoffHash,
        },
        cause: {
          profile: "legacy-closed-before-prepare-list-refusal-v1",
          sourceSha256: LEGACY_SOURCE,
          inference:
            "exited list-refusal profile; all preceding Native calls awaited and removal not reached",
        },
        request: requestText,
        artifacts,
        originalEvidence: initial,
        currentEvidence: final,
      };
    },
  );
}
