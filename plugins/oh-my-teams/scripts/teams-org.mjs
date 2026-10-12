#!/usr/bin/env node
/** Thin CLI adapter for the oh my teams domain modules. */
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  AUDITOR_ROLE,
  chart,
  displayModel,
  migrateLegacyOrg,
  readJSON,
  ROOT_ROLE,
  run as runOrcaCommand,
  saveOrg,
  validateOrg,
  writeJSON,
} from "./core.mjs";
import { saveWorkItem, listWorkItems } from "./work-items.mjs";
import {
  assertWorktreeUnshared,
  directorBriefPrompt,
  directorCommand,
  kickoffBriefPrompt,
  launchBinding,
  PERMISSION_BYPASS,
  selectedWorktreePath,
  resolveRoleLaunch,
  roleCommand,
  roleSpec,
} from "./role-launch.mjs";
import { openDirectorTerminal } from "./director-terminal.mjs";
import {
  resolveHostDefaults,
  HOST_DEFAULT_ADAPTER_PROVIDERS,
} from "./host-defaults.mjs";
import { fetchModelCatalog, revalidateModelChoices } from "./model-catalog.mjs";
import {
  assertModelAssignmentChoice,
  modelAssignmentCatalogSelections,
} from "./model-assignment.mjs";
import {
  assertNotKickoffOwner,
  deliverKickoff,
  assertDirectorAuthority,
  checkCloseReady,
} from "./delivery.mjs";
import {
  clearRoleTerminal,
  DISPATCH_PURPOSES,
  freshContextDecision,
  openRoleTerminal,
  pinTerminalTitle,
  readLaunchEnvironment,
  roleTitle,
  workerTerminal,
  worktreeLabel,
} from "./role-terminal.mjs";
import { predictLaunchPath } from "./launch-matrix.mjs";
import { answerPrompt } from "./prompt-supervision.mjs";
import { advise, draft, validateTask, work } from "./worker.mjs";
import {
  aggregate,
  git as gitEvidence,
  validateEvidence,
  verify,
} from "./evidence.mjs";
import { previewPreset } from "./presets.mjs";
import {
  acceptOutcome,
  gateCheck,
  recordReview,
  refreshGateCache,
} from "./gates.mjs";
import {
  auditAccept,
  auditChecked,
  pickDeclaredIdentity,
  auditObjection,
  auditResponse,
  auditRuling,
  hasValidAcceptance,
} from "./audit.mjs";
import {
  readDraft,
  bindKickoffResultRepo,
  requirementsAmend,
  requirementsConfirm,
  requirementsConfirmDraft,
  requirementsDraft,
  requirementsException,
  requirementsFidelity,
  requirementsFidelityConfirm,
  requirementsPresent,
  requirementsRetrofit,
} from "./requirements.mjs";
import {
  checkTerminalIdle,
  createWorktreeWithRoleSession,
  discoverOrcaRuntime,
  findActiveDispatch,
  injectTask,
  isTrustedOrcaExecute,
  readTrustedOrcaVersion,
  reclaimWorktree,
  releaseWorker,
  resolveTrustedOrcaScriptPath,
  runOrcaJson,
  selectOrcaExecutable,
  trustedOrcaExecute,
  TRUSTED_ORCA_EXECUTABLE_PLACEHOLDER,
  startWorker,
  sendOrcaMessage,
} from "./orca-adapter.mjs";
import { withRuntimeSignal } from "./adapters.mjs";
import { prepareRoleLifecycle } from "./worktree-legacy.mjs";
import { withAutomaticWorktreeReuse } from "./worktree-reuse.mjs";
import {
  withWorktreeLock,
  readWorktreeTransitions,
  reconcileAbsentRoleWorktree,
} from "./worktree-transactions.mjs";
import {
  attachWorkspace,
  prepareInput,
  readPreparedInput,
} from "./workspace.mjs";
import {
  attachExecution,
  reserveExecution,
  acceptWorkflowIntegration,
  createWorkflow,
  readWorkflow,
  recordSettlement,
  releaseReservation,
  resumeWorkflow,
  retryTask,
  handoffTask,
  reworkTask,
  setWorkflowDepth,
  increaseCallAllowance,
  increaseWorkflowBudget,
  reopenTask,
  extendIntegrationChecks,
  changeTaskStaffing,
  correctApprovalProvenance,
} from "./workflow.mjs";
import { classifyFailure, validateFailureEvidence } from "./failures.mjs";
import { recordLessonCandidate } from "./lessons.mjs";
import { recordCheckpoint } from "./handoff.mjs";
import { workerLimitCheck } from "./limit-check.mjs";
import {
  incidentStatus,
  ingestIncident,
  observeIncident,
} from "./incidents.mjs";
import { compareQuotaSnapshots, recordQuotaSnapshot } from "./quota.mjs";
import { organizationStatus } from "./status.mjs";
import { shadowFailureFallback, shadowModelCheck } from "./jev.mjs";
import {
  draftOrganization,
  draftResourceOrganization,
  draftThreeTierOrganization,
} from "./org-draft.mjs";
import {
  bindKickoffRun,
  classifyKickoffEntry,
  cleanupKickoffBranches,
  isSameOrWithinByIdentity,
  kickoffAuditPolicyRetrofit,
  kickoffResultRepoDecide,
  kickoffHashFor,
  listKickoffs,
  ownerProject,
  reassignDirector,
  recordAuditorLaunch,
  recordDelivery,
  registerKickoff,
  releaseKickoff,
  resolveRegisteredKickoffFromState,
  sharesWorktreeWithAny,
  verifyHandoffClaim,
} from "./kickoff-registry.mjs";
import {
  reclaimKickoffCleanup,
  scanKickoffCleanup,
} from "./kickoff-cleanup.mjs";
import { consumeDocumentEvent } from "./document-events.mjs";
import { deliverUndeliveredEvents } from "./document-event-delivery.mjs";
import { assertDocumentAuthority } from "./document-authority.mjs";
import {
  buildDocId,
  buildDocRef,
  documentDirectory,
  documentState,
  resolveKickoffHash,
  saveDocument,
} from "./documents.mjs";
import {
  readLaunches,
  readTerminalClosures,
  recordLaunch,
  recordTerminalClosure,
  lazyLaunchesBackward,
} from "./usage-ledger.mjs";
import { formatUsageTable, usageReport } from "./usage-report.mjs";
import {
  defaultRuntimeRoot,
  doctor as runtimeDoctor,
  installRuntime,
  pruneRuntimes,
} from "./dependencies.mjs";
import {
  acknowledgeDelivery,
  acknowledgeSignal,
  findPmTerminal,
  listDeliveries,
  listInbox,
  readDeliveryReceipt,
  readSignal,
  recordDeliveryReceipt,
  replySignal,
  sendSignal,
  SIGNAL_KINDS,
} from "./director.mjs";
import {
  acquireResource,
  releaseResource,
  RESOURCE_KINDS,
} from "./resources.mjs";

import {
  assertDirectRoleTerminalBinding,
  assertTrustedAuditorLaunch,
  auditorIndependenceForbiddenPaths,
  auditorLaunchEnvironmentInputs,
  createRoleWorktree as createRoleWorktreeInternal,
  identicalOrWithin,
  reclaimIntegratedRoleWorktree,
  realpathOrNull,
  resolveAuditorLaunchExecution,
} from "./worktree-commands.mjs";
export {
  auditorLaunchEnvironmentInputs,
  reclaimIntegratedRoleWorktree,
  resolveAuditorLaunchExecution,
};

/**
 * Creates or reuses a role worktree and opens its bound role terminal.
 * @param {object} args - Role worktree command options.
 * @param {object} [ports] - Injectable lifecycle adapters for tests.
 * @returns {Promise<object>} Proven worktree and role session.
 */
export function createRoleWorktree(args, ports = {}) {
  return createRoleWorktreeInternal(args, { executeCommand, ...ports });
}
import {
  HELP,
  ALLOWED_OPTIONS,
  REQUIRED_OPTIONS,
  parseArgs,
  validateArgs,
} from "./cli-spec.mjs";
export { ALLOWED_OPTIONS, REQUIRED_OPTIONS, parseArgs };

function parseHostDefaultIds(value) {
  return value
    ? value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    : [];
}

/**
 * Revalidates every profile a save is about to persist against a freshly
 * fetched model catalog, and refuses the save when any selection comes back
 * not `savable`.
 *
 * `touched` is computed here, from a diff against `previousOrg`, never
 * accepted from caller input: a profile absent from `previousOrg`, or whose
 * `provider`/`model` differs from it, is touched; every other profile is not.
 * This is what lets an unrelated policy, headcount, or name adjustment keep
 * its untouched profiles eligible for {@link revalidateModelChoices}'s
 * preservation path even when a different provider's fresh lookup fails,
 * without a new or changed profile ever claiming that same preservation by
 * asserting `touched: false` about itself. `explicitHostDefaultIds` is this
 * save path's own record of which host-default profiles the caller's CLI
 * input actually named; a touched host-default profile absent from that list
 * is refused before the catalog is even fetched, so a new `provider:default`
 * profile can never reach delegation by going through untouched instead.
 * `adapterContractConfirmed` is decided here too, from the structural fact of
 * {@link HOST_DEFAULT_ADAPTER_PROVIDERS}, never from caller input.
 *
 * @param {object} candidate - Organization revision about to be persisted.
 * @param {object} [options={}] - Revalidation inputs.
 * @param {object|null} [options.previousOrg=null] - Organization on disk
 * before this save, or null for a fresh `init` or draft with no predecessor.
 * @param {string[]} [options.explicitHostDefaultIds=[]] - Profile ids the
 * caller's own CLI input named for host-default delegation.
 * @param {string} [options.codexHome] - Codex home to fetch the catalog with.
 * @param {Function} [options.execute] - Injectable command runner, threaded
 *   through to `fetchModelCatalog` so tests can supply a fake catalog instead
 *   of spawning the real claude/codex/agy executables.
 * @returns {Promise<object>} The {@link revalidateModelChoices} receipt.
 * @throws {Error} When a touched host-default profile was not named
 * explicitly, or when any selection's `savable` comes back false.
 */
async function revalidateOrgForSave(
  candidate,
  { previousOrg = null, explicitHostDefaultIds = [], codexHome, execute } = {},
) {
  if (candidate.resources !== undefined) {
    const catalog = await fetchModelCatalog({ codexHome, execute });
    const selections = Object.entries(candidate.resources).map(
      ([key, resource]) => {
        const entry = catalog[resource.provider];
        const installed =
          entry?.status === "ok" ||
          entry?.reasonCode === "no-catalog-interface";
        return {
          key,
          provider: resource.provider,
          pool: resource.pool,
          status: installed ? "verified" : "unavailable",
          savable: installed,
          reason: installed
            ? undefined
            : (entry?.reason ?? "provider catalog is unavailable"),
          catalogRevision: entry?.catalogRevision ?? null,
        };
      },
    );
    const modelReceipt = revalidateModelChoices(
      catalog,
      modelAssignmentCatalogSelections(candidate),
    );
    const allSelections = [...selections, ...modelReceipt.selections];
    const rejected = allSelections.filter((entry) => !entry.savable);
    assert(
      rejected.length === 0,
      "Save refused; the following subscription resources failed catalog verification:\n" +
        rejected.map((entry) => `${entry.key}: ${entry.reason}`).join("\n"),
    );
    return {
      verifiedAt: catalog.fetchedAt,
      catalogRevision: catalog.catalogRevision,
      selections: allSelections,
      savable: modelReceipt.savable,
    };
  }
  const unconfirmedHostDefaults = [];
  const selections = Object.entries(candidate.profiles).map(([id, profile]) => {
    const before = previousOrg?.profiles?.[id];
    const touched =
      !before ||
      before.provider !== profile.provider ||
      before.model !== profile.model;
    const hostDefault = profile.model === null;
    if (hostDefault && touched && !explicitHostDefaultIds.includes(id)) {
      unconfirmedHostDefaults.push(id);
    }
    return hostDefault
      ? {
          key: id,
          provider: profile.provider,
          touched,
          hostDefault: true,
          adapterContractConfirmed: HOST_DEFAULT_ADAPTER_PROVIDERS.includes(
            profile.provider,
          ),
        }
      : {
          key: id,
          provider: profile.provider,
          model: profile.model,
          touched,
          ...(profile.effort ? { effort: profile.effort } : {}),
        };
  });
  assert(
    unconfirmedHostDefaults.length === 0,
    "New host-default profile(s) need an explicit --host-default: " +
      `${unconfirmedHostDefaults.join(", ")}`,
  );

  const catalog = await fetchModelCatalog({ codexHome, execute });
  const receipt = revalidateModelChoices(catalog, selections);
  const rejected = receipt.selections.filter((entry) => !entry.savable);
  assert(
    rejected.length === 0,
    "Save refused; the following profiles failed revalidation:\n" +
      rejected
        .map((entry) => `${entry.key}: ${entry.reason ?? entry.reasonCode}`)
        .join("\n"),
  );
  return receipt;
}

async function applyPreset(args, execute) {
  const current = validateOrg(readJSON(args.org));
  assert(
    current.resources === undefined,
    "Model presets are a legacy profile compatibility path and cannot change a resource organization",
  );
  assert(
    Number(args.revision) === current.revision,
    "Organization changed; read it again before applying a preset",
  );
  const preview = previewPreset(current, args.name);
  if (!args.apply) {
    return { ...preview, organization: undefined, applied: false };
  }
  const catalogReceipt = await revalidateOrgForSave(preview.organization, {
    previousOrg: current,
    codexHome: args["codex-home"] && path.resolve(args["codex-home"]),
    execute,
  });
  const saved = saveOrg(args.org, preview.organization, {
    update: true,
    expectedRevision: current.revision,
  });
  return {
    ...preview,
    organization: saved.organization,
    applied: true,
    catalogReceipt,
  };
}

function showOrganization(args) {
  const org = validateOrg(readJSON(args.org));
  const status = organizationStatus(org, args.state);

  if (args.json) {
    const orgOutput = structuredClone(org);
    for (const profile of Object.values(orgOutput.profiles ?? {})) {
      profile.displayModel = displayModel(profile.provider, profile.model);
    }
    return { organization: orgOutput, ...status };
  }
  console.log(chart(org));
  if (args.state) console.log(JSON.stringify(status, null, 2));
  return undefined;
}

async function compatibilityPrepare(args) {
  const org = validateOrg(readJSON(args.org));
  const task = validateTask(readJSON(args.task));
  const repo = path.resolve(args.repo);
  assert(
    /^[a-z][a-z0-9-]*$/.test(args.name),
    "Worktree name must be lower-case words/numbers/hyphens",
  );
  const stateDir = path.join(repo, ".omt");
  const prepared = await prepareInput(
    org,
    task,
    repo,
    path.join(stateDir, "prepared", args.name),
  );
  return {
    ...prepared,
    stateDir,
    note:
      "Compatibility prepare only writes the frozen input. Run role-worktree-create " +
      "to create or safely reuse the child with a proven Orca role session, then attach-workspace.",
  };
}

async function resolveAndCheckDrift(orgFile, org, launch) {
  const requested =
    launch.modelRequested !== undefined ? launch.modelRequested : launch.model;
  if (requested !== null) {
    return {
      modelResolved: requested,
      warnings: [],
    };
  }

  const projectDir = ownerProject(orgFile);
  const defaults = await resolveHostDefaults({
    project: projectDir ? path.resolve(projectDir) : undefined,
  });
  const currentResolved = defaults[launch.provider]?.model ?? null;
  if (!currentResolved) return { modelResolved: null, warnings: [] };

  const prev = lazyLaunchesBackward(orgFile).findLast(
    (l) => l.profile === launch.profile && typeof l.modelResolved === "string",
  );
  // modelResolvedAtFormation is read only here, as the drift baseline before
  // any launch has recorded its own modelResolved. It is an observation taken
  // at formation time, never a selected model, and no other code path treats
  // it as one; see docs/plan/model-catalog.md for the reasoning.
  const baseline = prev
    ? prev.modelResolved
    : org.profiles[launch.profile]?.modelResolvedAtFormation;

  const warnings = [];
  if (baseline && baseline !== currentResolved) {
    warnings.push(
      `해석된 모델이 ${baseline}에서 ${currentResolved}(으)로 바뀌었습니다. 설정 변경의 영향일 수 있습니다.`,
    );
  }

  return { modelResolved: currentResolved, warnings };
}

// Extends the existing "message, then a JSON signal+receipt block" CLI error
// convention with the idle-check diagnostics (screen, terminal-list state, or
// a record that reading either failed) an Orca refusal may carry, so
// terminal-idle-check and worker-start's idle rejection print them instead of
// only the translated message reaching main()'s catch.
function withOrcaFailureDetail(error) {
  if (!error.signal && !error.diagnostics) return error;
  error.message = `${error.message}\n${JSON.stringify(
    {
      signal: error.signal ?? null,
      receipt: error.receipt ?? null,
      diagnostics: error.diagnostics ?? null,
    },
    null,
    2,
  )}`;
  return error;
}

// The receipt is returned whether or not the start reached `ready`, because a
// start that failed still names the Dispatch and the resources someone has to
// reclaim. A refusal that produced no Dispatch throws, and its neutral signal
// travels with the error so the caller can route it rather than reread prose.
//
// Every role is handed its task in the terminal role-terminal opened with the
// profile's model, effort and permission bypass flag. worker-start --agent
// could pass the model but not the flag, so a start without --terminal, or
// with a hand-typed agent, model or effort, is refused before Orca is called.
// The terminal keeps the model it was opened with, so the proof stays
// unproven until the screen is read.
async function startSupervisedWorker(args) {
  assert(
    args.profile === undefined || args["workflow-id"],
    "--profile requires --workflow-id, --state and --workflow-task",
  );
  const { org, run } = launchContext(args);
  const launch = resolveRoleLaunch(
    org,
    args.role,
    { agent: args.agent, model: args.model, effort: args.effort },
    { ...run, terminal: args.terminal },
  );
  // The exception path exists because Orca never reports an Agy terminal
  // idle. A Claude or Codex terminal that is not idle is busy or waiting on a
  // prompt, and injecting a task there would bypass that state.
  assert(
    !args["inject-fallback"] || launch.provider === "agy",
    `--inject-fallback applies only to agy roles; ${launch.role} uses ${launch.provider}`,
  );
  // Orca does not create a worktree around a terminal it is handed.
  assert(
    args.worktree !== "new-child",
    "--terminal cannot start in new-child; create the worktree first, open the terminal there with role-terminal, " +
      "and pass the same id: selector",
  );
  // Only a named or current worktree can belong to another role's task or to
  // the owner.
  assertNotKickoffOwner(
    selectedWorktreePath(args.worktree ?? "current", args.repo) ?? args.repo,
    `starting ${launch.role}`,
  );
  assertWorktreeUnshared(
    run.workflowState,
    launch.role,
    args.worktree ?? "current",
    args.repo,
  );
  // B.5: an audited org must not let implementation start before the brief
  // audit checkpoint has a valid acceptance. This is the only place that
  // enforcement is checked (requirements-fidelity does not gate on it), and
  // it only applies once this launch can be tied to a registered kickoff.
  //
  // D2 (director decision, msg_c9d1afb03fd4): a caller-supplied --state alone
  // never establishes that binding, because nothing before this call proves
  // --state names the kickoff that actually owns the target worktree -- a
  // worker could otherwise name any other active kickoff's --state and
  // inherit its audit policy (or lack of one). Binding instead follows the
  // target worktree's own identity:
  //   1. it sits at or inside a registered kickoff's own PM worktree
  //      (pm.path), or
  //   2. an earlier ledger line -- written only by role-worktree-create's own
  //      role-terminal call, which validates --state/--workflow-id/--task
  //      before recording anything -- named this exact --terminal handle and
  //      a worktreePath at or inside the target. The caller does supply
  //      --terminal here, to say which of its own sessions is starting, but
  //      what this check trusts is not that bare claim: it is the recorded
  //      line.terminal value in an actual via="role-terminal" ledger line,
  //      one that was only ever written with the handle Orca itself assigned
  //      when that session's own role-terminal call opened it (confirmed
  //      against role-terminal.mjs's openRoleTerminal and orca-adapter.mjs's
  //      startWorker/assertTerminalIdle). A caller cannot make a stale line
  //      left by an unrelated kickoff match just by repeating its --terminal
  //      value, because that value must also equal the one Orca assigned to
  //      that specific ledger line's own session.
  // A path-only match from a *different* terminal is never trusted for (2).
  // If neither resolves this launch to a kickoff while any kickoff is
  // active, the launch is refused regardless of --state (rule 3). If it does
  // resolve, a --state that names a different kickoff is refused too (rule
  // 4). Every identity comparison here treats a realpath failure as a
  // mismatch, not a pass-through (rule 5) -- unlike sharesWorktreeWithAny
  // (kickoff-registry.mjs), whose plain-path.resolve fallback is the correct
  // direction for D4's over-detection goal but the wrong direction here,
  // where the safe failure is refusing a launch this cannot verify, not
  // waving it through on a lucky string match.
  const target =
    selectedWorktreePath(args.worktree ?? "current", args.repo) ??
    path.resolve(args.repo);
  const realpathOrNull = (candidate) => {
    try {
      return fs.realpathSync.native(candidate);
    } catch {
      return null;
    }
  };
  const identicalOrWithin = (parent, child) => {
    const parentReal = realpathOrNull(parent);
    const childReal = realpathOrNull(child);
    if (parentReal === null || childReal === null) return false;
    return isSameOrWithinByIdentity(parentReal, childReal);
  };
  const kickoffs = listKickoffs(run.orgFile).kickoffs;
  let entry = kickoffs.find((candidate) =>
    identicalOrWithin(candidate.pm.path, target),
  );
  if (!entry && args.terminal) {
    const activeWorktreeIds = new Set(
      kickoffs.map((candidate) => candidate.pm.worktreeId),
    );
    const bindingLaunch = readLaunches(run.orgFile).findLast(
      (line) =>
        // Only a role-terminal-via line is trusted as binding evidence: that
        // command validates --state/--workflow-id/--task before recording
        // anything, while a worker-start-via line's own kickoffPmWorktreeId
        // was computed by recordLaunch's plain --state/callerCwd lookup
        // (usage-ledger.mjs's resolveLaunchKickoff), independent of this
        // gate -- trusting it here would let that weaker, unrelated
        // computation feed straight back into this one.
        line.via === "role-terminal" &&
        line.terminal === args.terminal &&
        line.kickoffPmWorktreeId &&
        activeWorktreeIds.has(line.kickoffPmWorktreeId) &&
        line.worktreePath &&
        // parent=line.worktreePath, child=target: the CALLER's target must be
        // the recorded worktree itself or nested inside it, not the other
        // way around -- else a caller naming some broad ancestor directory as
        // --worktree could match any old, unrelated launch whose recorded
        // worktreePath merely happens to sit somewhere underneath it.
        identicalOrWithin(line.worktreePath, target),
    );
    entry = bindingLaunch
      ? kickoffs.find(
          (candidate) =>
            candidate.pm.worktreeId === bindingLaunch.kickoffPmWorktreeId,
        )
      : undefined;
  }
  assert(
    entry !== undefined || kickoffs.length === 0,
    `This launch (worktree ${target}) cannot be tied to any registered kickoff, either by sitting inside ` +
      "its PM worktree or by an earlier role-worktree-create launch recorded under this same --terminal; " +
      "a caller-supplied --state does not establish ownership on its own. Open this worktree under the " +
      "intended kickoff with role-worktree-create, or reuse the --terminal it recorded there.",
  );
  if (entry !== undefined && args.state) {
    const declaredStateDir = realpathOrNull(args.state);
    const boundStateDir = realpathOrNull(entry.pm.stateDir);
    assert(
      declaredStateDir !== null &&
        boundStateDir !== null &&
        declaredStateDir === boundStateDir,
      `--state ${args.state} does not name the kickoff (${entry.pm.worktreeId}) this worktree is actually ` +
        "bound to; refusing rather than silently preferring either value",
    );
  }
  const worktreeId = entry?.pm.worktreeId ?? null;
  if (worktreeId) {
    // D1: this kickoff's pinned auditPolicy decides, not a fresh
    // organization.json read, so removing org.auditor after claim cannot
    // skip this precheck for a kickoff that already required an auditor.
    // There is no live-read fallback (director decision msg_0b114271f1f5): a
    // legacy entry with no pinned auditPolicy refuses outright, naming the
    // retrofit command, rather than guessing from organization.json's
    // current setting.
    assert(
      entry.auditPolicy !== undefined,
      `Kickoff ${worktreeId} has no pinned audit policy; the director must run ` +
        "kickoff-audit-policy-retrofit for this worktree before a worker can be assigned",
    );
    const auditorConfigured = entry.auditPolicy.auditorConfigured;
    if (auditorConfigured) {
      assert(
        await hasValidAcceptance(run.orgFile, worktreeId, "brief"),
        `Kickoff ${worktreeId} has an auditor configured but no valid brief-audit ` +
          "acceptance yet; the director must resolve the brief audit " +
          "(audit-response/audit-ruling/audit-accept) before a worker can be assigned",
      );
    }
  }
  assert(
    args.purpose === undefined || DISPATCH_PURPOSES.includes(args.purpose),
    `--purpose must be one of: ${DISPATCH_PURPOSES.join(", ")}`,
  );
  const identity = {
    workflowId: args["workflow-id"] ?? null,
    workflowTaskId: args["workflow-task"] ?? null,
    orcaTaskId: args.task ?? null,
    purpose: args.purpose ?? null,
  };
  const freshContext = await freshenTerminal(args, launch, identity);
  const launchedAt = new Date().toISOString();
  // terminal이 있을 때만 matrixPrediction을 계산합니다.
  // startWorker → assertTerminalIdle 에서 사후 거부가 matrix-mismatch로 분류됩니다.
  let matrixPrediction;
  if (args.terminal) {
    try {
      const env = await readLaunchEnvironment({ orcaExecutable: args.orca });
      matrixPrediction = predictLaunchPath({
        runner: launch.provider,
        model: launch.model,
        platform: env.platform,
        shell: env.shell,
        trustRecordExists: env.trustRecordExists,
        codexTrustRecordExists: env.codexTrustRecordExists,
        skipDangerousModePermissionPrompt: Boolean(
          PERMISSION_BYPASS[launch.provider],
        ),
        orcaVersion: env.orcaVersion,
        cliVersion: env.cliVersion,
      });
    } catch (error) {
      process.stderr.write(
        `Warning: Failed to predict launch path: ${error.message}\n`,
      );
    }
  }
  try {
    const started = await startWorker(path.resolve(args.repo), {
      task: args.task,
      spec: args.spec && roleSpec(org, launch.role, args.spec, run),
      worktree: args.worktree ?? "current",
      terminal: args.terminal,
      runId: args.run,
      retryOf: args["retry-of"],
      executable: args.orca,
      matrixPrediction,
    });
    const binding = launchBinding(launch);
    // role-terminal already titled the tab. It is set again because Orca may
    // rebuild the tab without it, but only when there is detail to set: a bare
    // role tag would overwrite the title role-terminal was given.
    const worker = workerTerminal(started.receipt, args.terminal);
    const detail = args.title ?? worker.place ?? worktreeLabel(args.worktree);
    const title =
      worker.handle && detail ? roleTitle(launch.role, detail) : null;
    const titlePinned = Boolean(
      title &&
      (await pinTerminalTitle({
        orca: started.executable,
        handle: worker.handle,
        title,
      })),
    );
    const drift = await resolveAndCheckDrift(args.org, org, launch);
    const ledger = recordLaunchSafely(args.org, launchedAt, {
      via: "worker-start",
      role: launch.role,
      profile: launch.profile,
      provider: launch.provider,
      modelRequested: launch.model,
      modelResolved: drift.modelResolved,
      effortRequested: launch.effort,
      worktreePath:
        selectedWorktreePath(args.worktree ?? "current", args.repo) ??
        receiptWorktreePath(started.receipt),
      worktreeSelector: args.worktree ?? "current",
      terminal: worker.handle,
      workerId: started.workerId ?? null,
      ...identity,
      orcaTaskId: started.taskId ?? identity.orcaTaskId,
      stateDir: args.state ?? null,
      ...run.handoff,
    });
    return {
      ...started,
      ...ledger,
      freshContext,
      title,
      titlePinned,
      binding: { ...binding, roleHeader: Boolean(args.spec) },
      warnings: drift.warnings.length > 0 ? drift.warnings : undefined,
    };
  } catch (error) {
    if (!error.signal) throw error;
    if (
      args["inject-fallback"] &&
      error.signal.kind === "execution-unconfigured" &&
      error.signal.code === "timeout"
    ) {
      return injectFallback(args, org, run, launch, error.signal);
    }
    throw withOrcaFailureDetail(error);
  }
}

/**
 * Decides whether a reused terminal's conversation is cleared before a new
 * task is handed to it, and carries out that clear.
 *
 * A Claude terminal that last worked on something else starts the new task
 * from an empty conversation, so it does not resend the previous task's
 * history on every call. The decision reads the launch ledger; a ledger that
 * cannot be read clears nothing, as before this rule existed. `clearRoleTerminal`
 * itself may decline to clear (an active Dispatch it cannot settle either
 * way), so its own `cleared`/`reason` overrides the decision's when they
 * disagree, rather than assuming the clear happened; the merged result is
 * what `worker-start` returns verbatim as its own `freshContext` field.
 *
 * @param {object} args - Parsed CLI arguments for `worker-start`.
 * @param {object} launch - Resolved role launch, read for `launch.provider`.
 * @param {object} identity - Workflow/task/purpose identity being started.
 * @param {Function} [execute=run] - Injectable command runner, threaded
 *   through to `clearRoleTerminal`.
 * @returns {Promise<{clear: boolean, reason: string, cleared: boolean,
 *   previousLaunchAt?: string}>} The freshness decision merged with what
 *   clearing actually did.
 */
export async function freshenTerminal(
  args,
  launch,
  identity,
  execute = runOrcaCommand,
) {
  let launches = [];
  try {
    launches = readLaunches(args.org);
  } catch {
    // No ledger to compare against.
  }
  const decision = freshContextDecision(launches, {
    terminal: args.terminal,
    provider: launch.provider,
    ...identity,
  });
  if (!decision.clear) return { cleared: false, ...decision };
  const outcome = await clearRoleTerminal({
    terminal: args.terminal,
    executable: args.orca,
    cwd: path.resolve(args.repo),
    execute,
  });
  return {
    ...decision,
    cleared: outcome.cleared,
    ...(outcome.cleared ? {} : { reason: outcome.reason }),
  };
}

/**
 * Records an already-opened interactive role session without turning a ledger
 * filesystem fault into a second launch or a failed session.
 *
 * @param {string} orgFile - Organization file whose launch ledger is updated.
 * @param {string} launchedAt - Timestamp captured before the terminal opens.
 * @param {object} launch - Interactive launch fields for the ledger.
 * @returns {{ledger?: string, ledgerError?: string}} Stored ledger path or preserved write error.
 */
export function recordLaunchSafely(orgFile, launchedAt, launch) {
  try {
    const { file } = recordLaunch(
      orgFile,
      { ...launch, worktreeProtocolVersion: 1, callerCwd: process.cwd() },
      launchedAt,
    );
    return { ledger: file };
  } catch (error) {
    return { ledgerError: error.message };
  }
}

// Orca names a worktree it created as `<repoId>::<path>`.
function receiptWorktreePath(receipt) {
  const effect = (receipt?.result?.effects ?? []).find(
    (item) => item?.kind === "worktree",
  );
  const id = typeof effect?.id === "string" ? effect.id : "";
  const at = id.lastIndexOf("::");
  return at === -1 ? null : path.resolve(id.slice(at + 2));
}

// The exception path #41 asked for. An Agy terminal Orca cannot see idle is
// refused by worker-start; with the user's approval the same task is injected
// instead, and the result says plainly what supervision it lacks, so the
// coordinator records it rather than improvising a format each time.
async function injectFallback(args, org, run, launch, refusal) {
  const approval = String(args["inject-fallback"]).trim();
  assert(
    approval.length >= 10,
    "--inject-fallback takes the director's approval in words, e.g. who approved it and why",
  );
  const injected = await injectTask(path.resolve(args.repo), {
    task: args.task,
    spec: args.spec && roleSpec(org, launch.role, args.spec, run),
    terminal: args.terminal,
    runId: args.run,
    executable: args.orca,
  });
  return {
    via: "dispatch-inject",
    supervised: false,
    approval,
    refusal,
    ...injected,
    workerId: injected.dispatchId,
    liveness: "unverifiable",
    binding: {
      ...launchBinding(launch),
      via: "dispatch-inject",
      modelProof: "unproven",
      roleHeader: Boolean(args.spec),
    },
    limitations: [
      "worker-list does not report this Dispatch's liveness; read the terminal to follow it",
      "worker-release does not reclaim the terminal; close it after the task settles",
      "the model is not proven; report the model shown on the terminal screen",
    ],
    ...(injected.injected ? {} : { status: "blocked" }),
    ...(injected.injectRefusal
      ? { route: classifyFailure(injected.injectRefusal) }
      : {}),
  };
}

// A workflow freezes the organization it was created with and may run fewer
// roles than that organization declares. Launching from the live file instead
// would pick up a later adjust mid-run, or fail on a role adjust removed. A
// launch without a workflow reads the organization file as given.
function launchContext(args) {
  const located = {
    orgFile: path.resolve(args.org),
  };
  if (!args["workflow-id"] && !args.state) {
    return { org: readJSON(args.org), run: located };
  }
  assert(
    args["workflow-id"] && args.state,
    "--workflow-id and --state must be given together",
  );
  const stateDir = path.resolve(args.state);
  const snapshot = readWorkflow(stateDir, args["workflow-id"]);
  // Read the kickoff registry to find the director identifier for this run.
  // The PM worktree's stateDir matches pm.stateDir in the registry entry.
  // A missing registry, an absent entry, or any read error is non-fatal:
  // existing kickoffs without a director record must continue to work.
  let director;
  try {
    const { kickoffs } = listKickoffs(path.resolve(args.org));
    const entry = kickoffs.find(
      (k) => path.resolve(k.pm.stateDir) === stateDir,
    );
    if (entry?.director) director = entry.director;
  } catch {
    // Registry unreadable: proceed without director (non-fatal).
  }
  return {
    org: snapshot.organization,
    run: {
      ...located,
      ...(snapshot.state.roles ? { roles: snapshot.state.roles } : {}),
      workflowId: args["workflow-id"],
      stateDir,
      workflowState: snapshot.state,
      ...(snapshot.state.staffing ? { staffing: snapshot.state.staffing } : {}),
      ...(args["workflow-task"] ? { workflowTask: args["workflow-task"] } : {}),
      ...(director ? { director } : {}),
      ...handoffLaunch(args, snapshot.state),
    },
  };
}

// `--profile` launches a fallback only for the task a workflow-handoff gave
// it, so a hand-typed profile cannot move a role onto another account.
function handoffLaunch(args, state) {
  if (args.profile === undefined) return {};
  const taskId = args["workflow-task"];
  assert(taskId, "--profile requires --workflow-task");
  const item = Object.hasOwn(state.tasks, taskId) ? state.tasks[taskId] : null;
  assert(item, `Unknown workflow task: ${taskId}`);
  const handoff = item.handoffs?.at(-1);
  assert(
    handoff?.to === args.profile,
    `Task ${taskId} has no handoff to ${args.profile}; run workflow-handoff first`,
  );
  assert(
    ["pending", "reserved", "running"].includes(item.state),
    `Task ${taskId} is ${item.state}; a handoff launch needs it pending, reserved or running`,
  );
  return {
    profile: args.profile,
    handoff: { handoffFrom: handoff.from, handoffIndex: handoff.index },
  };
}

async function attachExistingWorkspace(args) {
  const runtime = readJSON(args.runtime);
  return attachWorkspace({
    parentRepo: path.resolve(args.repo),
    workspace: path.resolve(args.workspace),
    stateDir: path.resolve(args.state),
    name: args.name,
    org: validateOrg(readJSON(args.org)),
    task: validateTask(readJSON(args.task)),
    receipt: readJSON(args.receipt),
    executable: args.orca ?? runtime.executable,
    runtime,
  });
}

/**
 * Resolves the `kickoffHash` a gate-evaluating CLI case must forward, following
 * the caller-obligation procedure for `--org` (structured-omt-documents.md 3.7
 * item 5, 293-300행): find the kickoff entry that owns `stateDir`, classify it,
 * and refuse the command outright on integrity-failure, an unreadable
 * organization file, or a `stateDir` with no matching entry.
 *
 * @param {string|undefined} orgFile - `--org` value, or undefined when the caller omitted it.
 * @param {string} stateDir - Resolved `--state` directory the command targets.
 * @returns {string|undefined} `kickoffHash` to forward, or undefined to omit it (no `--org`, or a legacy entry).
 * @throws {Error} When the entry is integrity-failure, the organization file cannot be read, or no entry owns `stateDir`.
 */
function resolveGateKickoffHash(orgFile, stateDir) {
  if (orgFile === undefined) return undefined;
  let org;
  try {
    org = readJSON(path.resolve(orgFile));
  } catch (error) {
    throw new Error(
      `Cannot read organization file ${orgFile} to classify its kickoff entry: ${error.message}`,
    );
  }
  const resolvedState = path.resolve(stateDir);
  const entry = listKickoffs(orgFile).kickoffs.find(
    (candidate) => path.resolve(candidate.pm.stateDir) === resolvedState,
  );
  assert(
    entry !== undefined,
    `No registered kickoff owns state directory ${stateDir}; refusing without a current/legacy judgement`,
  );
  const classification = classifyKickoffEntry(entry, org);
  assert(
    classification !== "integrity-failure",
    `Kickoff entry for worktree ${entry.pm.worktreeId} has no registrationSeq though it postdates document system activation; refusing`,
  );
  return classification === "current" ? kickoffHashFor(entry) : undefined;
}

// Builds the { kickoffHash, workflowId } options object review-record,
// gate-check, accept and merge-check forward to gates.mjs, per the
// caller-obligation procedure resolveGateKickoffHash implements. workflowId
// is forwarded only when the caller passed --workflow-id; it is not itself
// part of the current/legacy/integrity-failure judgement (293-297행).
function gateHookOptions(args, stateDir) {
  const kickoffHash = resolveGateKickoffHash(args.org, stateDir);
  return {
    ...(kickoffHash === undefined ? {} : { kickoffHash }),
    ...(args["workflow-id"] === undefined
      ? {}
      : { workflowId: args["workflow-id"] }),
  };
}

async function mergeCheck(args) {
  const repo = path.resolve(args.repo);
  // The owner branch is merged only by deliver; a gate passing there would
  // read as permission to merge a worker's result into it directly.
  assertNotKickoffOwner(repo, "merge-check");
  const task = validateTask(readJSON(args.task));
  await validateEvidence(repo, readJSON(args.evidence), args.base, task);
  if (task.schemaVersion === 2) {
    assert(
      args.report && args.state,
      "task v2 merge-check requires --report and --state",
    );
    const stateDir = path.resolve(args.state);
    const gates = await gateCheck(
      repo,
      task,
      readJSON(args.report),
      stateDir,
      gateHookOptions(args, stateDir),
    );
    assert(gates.state === "accepted", "Task outcome has not been accepted");
  }
  return {
    valid: true,
    note:
      "Evidence and required gates match this checkout. " +
      "Apply merge authorization and mandatory CI separately.",
  };
}

// The table is for a person reading the terminal; --json and --write keep the
// full records, which carry paths and session ids but no message text.
async function reportUsage(args) {
  const report = await usageReport({
    orgFile: args.org,
    worktreeId: args.worktree,
    all: Boolean(args.all),
    stateDir: args.state,
    places: args.place,
    homes: {
      claudeHome: args["claude-home"],
      codexHome: args["codex-home"],
      agyHome: args["agy-home"],
    },
    write: Boolean(args.write),
  });
  if (args.json) return report;
  console.log(formatUsageTable(report));
  return undefined;
}

function directorCallerTerminal(args) {
  const terminal =
    args["director-terminal"] ?? process.env.ORCA_TERMINAL_HANDLE;
  assert(
    typeof terminal === "string" && terminal.trim(),
    "Director commands require --director-terminal or ORCA_TERMINAL_HANDLE provenance",
  );
  return terminal.trim();
}

async function writeDraft(args, execute) {
  const output = path.resolve(args.output);
  // A draft path that already holds a file may be the live organization, and
  // writing over it would skip the no-overwrite rule init keeps.
  assert(!fs.existsSync(output), "Draft output exists; choose a new path");
  const resourceDraft = args.resources !== undefined;
  const organization = resourceDraft
    ? draftResourceOrganization({
        name: args.name,
        resources: args.resources.split(","),
        concurrency:
          args.concurrency === undefined ? undefined : Number(args.concurrency),
        maxCalls:
          args["max-calls"] === undefined
            ? undefined
            : Number(args["max-calls"]),
      })
    : args.tiers === undefined && args.models.split(",").length === 2
      ? draftThreeTierOrganization({
          name: args.name,
          models: args.models.split(","),
        })
      : draftOrganization({
          name: args.name,
          tiers: args.tiers === undefined ? undefined : Number(args.tiers),
          models: args.models.split(","),
        });
  if (resourceDraft) {
    const catalogReceipt = await revalidateOrgForSave(organization, {
      codexHome: args["codex-home"] && path.resolve(args["codex-home"]),
      execute,
    });
    writeJSON(output, organization);
    return { output, organization, catalogReceipt };
  }
  const projectDir = path.dirname(output);
  const defaults = await resolveHostDefaults({ project: projectDir });
  if (defaults.codex?.error) {
    process.stderr.write(
      `Warning: Failed to resolve Codex defaults: ${defaults.codex.error}\n`,
    );
  }
  if (defaults.claude?.error) {
    process.stderr.write(
      `Warning: Failed to resolve Claude defaults: ${defaults.claude.error}\n`,
    );
  }
  // Observational only: resolveAndCheckDrift reads this back as its drift
  // baseline, never as the profile's selected model (model stays null here).
  const hostDefaultIds = [];
  for (const [id, profile] of Object.entries(organization.profiles)) {
    if (profile.model === null) {
      profile.modelResolvedAtFormation =
        defaults[profile.provider]?.model ?? null;
      hostDefaultIds.push(id);
    }
  }
  const catalogReceipt = await revalidateOrgForSave(organization, {
    explicitHostDefaultIds: hostDefaultIds,
    codexHome: args["codex-home"] && path.resolve(args["codex-home"]),
    execute,
  });
  writeJSON(output, organization);
  return { output, organization, catalogReceipt };
}

/**
 * Checks director authority for a director-only `requirements-*` CLI command,
 * strictly and without the `--force` bypass `assertDirectorAuthority`
 * (delivery.mjs) offers other commands: a requirements command never accepts
 * `--force` as a substitute for running from the right checkout (director
 * decision on requirements-retrofit's authority gap, msg_2f57aa6e083e).
 *
 * When the kickoff has a registered director, the caller must be running
 * from exactly that checkout. When it does not (a kickoff registered before
 * director support existed), the caller must supply `--checkout`, must be
 * running from exactly that path, and that path must be the organization's
 * own owner checkout (`ownerProject(orgFile)`) — there is no warn-and-allow
 * fallback for a missing director here, unlike `assertDirectorAuthority`.
 *
 * @param {object} entry - Kickoff registry entry the command targets.
 * @param {string} orgFile - Organization JSON path, to resolve the owner checkout.
 * @param {string|undefined} checkoutArg - The command's `--checkout` value, if given.
 * @param {string} use - Command name, named in any thrown error.
 * @returns {{checkoutPath: string}} The verified checkout, to record as the ledger's director.
 * @throws {Error} When the caller is not running from the required checkout.
 */
function assertRequirementsDirectorAuthority(entry, orgFile, checkoutArg, use) {
  const callerPath = path.resolve(process.cwd());
  if (entry.director) {
    const expected = path.resolve(entry.director.checkoutPath);
    assert(
      callerPath === expected,
      `${use} must be run from the director's checkout at ${expected}; ` +
        `current directory is ${callerPath}. There is no --force override for a requirements command.`,
    );
    return { checkoutPath: expected };
  }
  assert(
    typeof checkoutArg === "string" && checkoutArg.trim(),
    `${use} needs --checkout: this kickoff has no registered director, so the caller ` +
      "must declare and prove the organization's owner checkout",
  );
  const declared = path.resolve(checkoutArg);
  assert(
    callerPath === declared,
    `${use} must be run from the given --checkout path (${declared}); ` +
      `current directory is ${callerPath}`,
  );
  const owner = path.resolve(ownerProject(orgFile));
  assert(
    declared === owner,
    `${use} --checkout must be the organization's owner checkout (${owner}) for a ` +
      `kickoff with no registered director; got ${declared}`,
  );
  return { checkoutPath: declared };
}

/**
 * Dispatches a parsed CLI command to its handler.
 *
 * @param {object} args - Parsed CLI arguments.
 * @param {Function} [execute] - Injectable command runner, threaded through
 *   to every save path's `revalidateOrgForSave` call so tests can supply a
 *   fake model catalog instead of spawning the real executables. Real CLI
 *   invocations never pass this; `fetchModelCatalog` falls back to spawning
 *   the actual claude/codex/agy binaries.
 * @param {object} [ports] - Injectable role-terminal opener and environment reader for focused ledger tests.
 * @returns {Promise<object|undefined>} The command's JSON-serializable result.
 */
export async function executeCommand(args, execute, ports = {}) {
  if (
    args.command === "role-terminal" &&
    !args.viaRoleWorktreeCreate &&
    !args.viaWorktreeFence
  ) {
    return withWorktreeLock(args.org, () =>
      executeCommand({ ...args, viaWorktreeFence: true }, execute, ports),
    );
  }
  switch (args.command) {
    case "work-item-save": {
      const doc = readJSON(args.file);
      const options =
        args["expected-revision"] !== undefined
          ? { expectedRevision: Number(args["expected-revision"]) }
          : {};
      return saveWorkItem(args.state, doc, options);
    }
    case "work-item-list": {
      assert(
        args.state && typeof args.state === "string",
        "state must be a non-empty string",
      );
      assert(
        args["kickoff-id"] && typeof args["kickoff-id"] === "string",
        "kickoff-id must be a non-empty string",
      );
      assert(
        /^[a-f0-9]{64}$/.test(args["kickoff-id"]),
        "kickoffHash must be a 64-character hex string",
      );
      const registration = await resolveRegisteredKickoffFromState(args.state);
      assert(
        registration?.kickoffHash === args["kickoff-id"],
        "kickoff-id does not match the kickoff registered for state",
      );
      let docs = listWorkItems(
        args.state,
        args["kickoff-id"],
        args["workflow-id"] || null,
      );
      if (args.title) {
        const titleRegex = new RegExp(args.title, "i");
        docs = docs.filter((d) => titleRegex.test(d.title));
      }
      if (args["doc-state"]) {
        docs = docs.filter((d) => d.state === args["doc-state"]);
      }
      if (args.assignee) {
        docs = docs.filter(
          (d) =>
            Array.isArray(d.assignees) && d.assignees.includes(args.assignee),
        );
      }
      return docs;
    }
    case "org-draft":
      return await writeDraft(args, execute);
    case "init": {
      if (fs.existsSync(args.org)) {
        return {
          created: false,
          organization: validateOrg(readJSON(args.org)),
        };
      }
      const candidate = validateOrg(readJSON(args.from));
      const catalogReceipt = await revalidateOrgForSave(candidate, {
        explicitHostDefaultIds: parseHostDefaultIds(args["host-default"]),
        codexHome: args["codex-home"] && path.resolve(args["codex-home"]),
        execute,
      });
      return { ...saveOrg(args.org, candidate), catalogReceipt };
    }
    case "edit": {
      if (!fs.existsSync(args.org)) {
        // No predecessor to diff or catalog to fetch for; saveOrg's own
        // update-without-a-file assert is the right error here.
        return saveOrg(args.org, readJSON(args.from), {
          update: true,
          expectedRevision: Number(args.revision),
        });
      }
      const previousOrg = validateOrg(migrateLegacyOrg(readJSON(args.org)));
      assert(
        Number(args.revision) === previousOrg.revision,
        "Organization changed; read it again before editing",
      );
      const candidate = validateOrg(readJSON(args.from));
      const catalogReceipt = await revalidateOrgForSave(candidate, {
        previousOrg,
        explicitHostDefaultIds: parseHostDefaultIds(args["host-default"]),
        codexHome: args["codex-home"] && path.resolve(args["codex-home"]),
        execute,
      });
      return {
        ...saveOrg(args.org, candidate, {
          update: true,
          expectedRevision: Number(args.revision),
        }),
        catalogReceipt,
      };
    }
    case "preset":
      return await applyPreset(args, execute);
    case "show":
      return showOrganization(args);
    case "validate":
      return { valid: Boolean(validateOrg(readJSON(args.org))) };
    case "kickoff-claim": {
      const claim = readJSON(args.from);
      if (!claim.selfPm) {
        assert(
          typeof claim.pm?.path === "string" && claim.pm.path,
          "Kickoff PM path required",
        );
        assert(
          typeof claim.pm.worktreeId === "string" && claim.pm.worktreeId,
          "Kickoff PM worktree ID required",
        );
        assert(
          await findPmTerminal(args.org, claim.pm.path, {
            worktreeId: claim.pm.worktreeId,
          }),
          "Kickoff PM has no verified agent session in its registered worktree",
        );
      }
      return registerKickoff(args.org, claim);
    }
    case "kickoff-show": {
      const result = listKickoffs(args.org, args.worktree);
      for (const k of result.kickoffs) {
        k.pm.modelDisplay = displayModel(k.pm.provider, k.pm.model);
      }
      return result;
    }
    case "kickoff-handoff-verify":
      return verifyHandoffClaim(args.org, {
        worktreeId: args.worktree,
        directorTerminal: args["director-terminal"],
        brief: args.brief,
      });
    case "kickoff-bind":
      return bindKickoffRun(args.org, {
        worktreeId: args.worktree,
        runId: args.run,
      });
    case "kickoff-result-repo-decide":
      return kickoffResultRepoDecide(args.org, args.worktree, {
        repo: args.repo,
        reason: args.reason,
      });
    case "kickoff-audit-policy-retrofit": {
      const auditorConfigured = { true: true, false: false }[
        args["auditor-configured"]
      ];
      assert(
        auditorConfigured !== undefined,
        "--auditor-configured must be exactly true or false",
      );
      return kickoffAuditPolicyRetrofit(args.org, args.worktree, {
        auditorConfigured,
        profile: args.profile,
        fallbacks:
          args.fallbacks === undefined
            ? undefined
            : args.fallbacks
                .split(",")
                .map((id) => id.trim())
                .filter(Boolean),
        reason: args.reason,
      });
    }
    case "deliver":
      return deliverKickoff({
        orgFile: args.org,
        worktreeId: args.worktree,
        source: args.source,
        head: args.head,
        gate: ({ source, base }) => mergeCheck({ ...args, repo: source, base }),
      });
    case "kickoff-cleanup-candidates":
      return scanKickoffCleanup({
        orgFile: args.org,
        worktreeId: args.worktree,
        archiveFile: args["history-file"],
        executable: args.orca,
      });
    case "kickoff-cleanup-reclaim":
      return reclaimKickoffCleanup({
        orgFile: args.org,
        worktreeId: args.worktree,
        archiveFile: args["history-file"],
        executable: args.orca,
      });
    case "kickoff-release": {
      const cleanup =
        args.reason === "completed"
          ? await scanKickoffCleanup({
              orgFile: args.org,
              worktreeId: args.worktree,
            })
          : undefined;
      return releaseKickoff(args.org, {
        worktreeId: args.worktree,
        reason: args.reason,
        force: Boolean(args.force),
        cleanup,
        repo: args.repo,
        head: args.head,
      });
    }
    case "kickoff-branch-cleanup": {
      const { kickoffs } = listKickoffs(args.org, args.worktree);
      assert(
        kickoffs.length === 1,
        `Worktree ${args.worktree} supervises no registered kickoff`,
      );
      const [entry] = kickoffs;
      return cleanupKickoffBranches({
        projectDir: ownerProject(args.org),
        entry,
        branches: args.branches
          .split(",")
          .map((b) => b.trim())
          .filter(Boolean),
        remoteName: args.remote ?? "origin",
        callerCwd: process.cwd(),
        force: args.force ?? false,
        orgFile: args.org,
      });
    }
    case "kickoff-check-close-ready":
      return checkCloseReady({
        orgFile: args.org,
        worktreeId: args.worktree,
        head: args.head,
        repo: args.repo,
      });
    case "kickoff-merge-record": {
      const [entry] = listKickoffs(args.org, args.worktree).kickoffs;
      assert(
        entry,
        `Worktree ${args.worktree} supervises no registered kickoff`,
      );
      assertDirectorAuthority(
        entry,
        process.cwd(),
        "kickoff-merge-record",
        Boolean(args.force),
      );
      return recordDelivery(args.org, {
        worktreeId: args.worktree,
        head: args.head,
        mergeCommit: args["merge-commit"],
        remoteName: args.remote ?? "origin",
      });
    }
    case "requirements-draft": {
      // Only statements/criteria come from --from: worktreeId is fixed to
      // args.worktree last so a forged worktreeId field in the JSON file
      // cannot redirect the draft write to a different worktree's file.
      const { statements, criteria } = readJSON(args.from);
      return requirementsDraft(args.org, {
        statements,
        criteria,
        worktreeId: args.worktree,
      });
    }
    case "requirements-confirm": {
      if (args.draft) {
        return requirementsConfirmDraft(args.org, {
          worktreeId: args.worktree,
          criterionId: args.criterion,
          userQuote: args.quote,
          checkout: args.checkout,
        });
      }
      return requirementsConfirm(args.org, args.worktree, {
        criterionId: args.criterion,
        userQuote: args.quote,
      });
    }
    case "requirements-retrofit": {
      const [entry] = listKickoffs(args.org, args.worktree).kickoffs;
      assert(
        entry,
        `Worktree ${args.worktree} supervises no registered kickoff`,
      );
      const director = assertRequirementsDirectorAuthority(
        entry,
        args.org,
        args.checkout,
        "requirements-retrofit",
      );
      const draft = readDraft(args.org, args.worktree);
      assert(
        draft,
        `No draft ledger recorded for worktree ${args.worktree}; run requirements-draft ` +
          "(and, for a narrower criterion, requirements-confirm --draft) before retrofit",
      );
      return requirementsRetrofit(args.org, args.worktree, draft, director);
    }
    case "requirements-exception": {
      // Only these fields are taken from --from: callerCwd is the caller's
      // actual working directory, proven by the process itself, and must
      // never be settable by the JSON file the caller supplies (that would
      // let a forged callerCwd field defeat assertLedgerDirectorAuthority
      // the same way a --force flag would).
      const { scope, head, repo, reason, userQuote, unmetFacts } = readJSON(
        args.from,
      );
      return requirementsException(args.org, args.worktree, {
        scope,
        head,
        repo,
        reason,
        userQuote,
        unmetFacts,
      });
    }
    case "requirements-amend": {
      // callerCwd is never taken from --from, for the same forgery reason
      // documented on requirements-exception above; it always defaults to
      // the real process.cwd() inside requirementsAmend itself.
      const { statements, criteria } = readJSON(args.from);
      return requirementsAmend(args.org, args.worktree, {
        statements,
        criteria,
      });
    }
    case "requirements-present": {
      const {
        criterionId,
        head,
        repo,
        source,
        channel,
        location,
        userQuote,
        outcome,
      } = readJSON(args.from);
      return requirementsPresent(args.org, args.worktree, {
        criterionId,
        head,
        repo,
        source,
        channel,
        location,
        userQuote,
        outcome,
      });
    }
    case "requirements-fidelity": {
      const { head, repo, recordedBy, items } = readJSON(args.from);
      return requirementsFidelity(args.org, args.worktree, {
        head,
        repo,
        recordedBy,
        items,
      });
    }
    case "requirements-fidelity-confirm":
      return requirementsFidelityConfirm(args.org, args.worktree);
    case "audit-objection": {
      const payload = readJSON(args.from);
      const {
        checkpoint,
        target,
        kind,
        description,
        rebuttalRequested,
        resultHead,
        repo,
      } = payload;
      return auditObjection(args.org, args.worktree, {
        checkpoint,
        target,
        kind,
        description,
        rebuttalRequested,
        resultHead,
        repo,
        declared: pickDeclaredIdentity(payload),
      });
    }
    case "audit-response": {
      // Neither the caller's terminal handle, its working directory, nor the
      // Orca executable used to confirm identity is taken from a CLI
      // argument: verifiedDirector (brief) and verifiedPm (outcome) accept no
      // callerCwd, environment, executable, execute, or factory override at
      // all (not even for tests) — they always read process.cwd() and
      // process.env directly, and verifiedPm's `orchestration run-current`
      // check always runs through runTrustedOrcaJson, which validates the
      // fixed trusted script (ignoring --orca, ORCA_CLI_COMMAND, and
      // ORCA_DEV_REPO_ROOT) and then executes it directly with a pinned
      // interpreter and an allowlisted child environment, so the script's own
      // PATH search for `bash` and for the `dirname`/`readlink` it calls
      // internally, BASH_ENV, and variables such as ORCA_USER_DATA_PATH or
      // HOME cannot redirect what actually runs (B.6, decision B). A
      // --terminal, --cwd, or --orca argument here could otherwise forge the
      // director or PM identity a response is bound to; since auditResponse
      // takes no such argument, this CLI command never has one to pass
      // through in the first place, and neither does any other Node code
      // that imports auditResponse, verifiedDirector, or verifiedPm
      // directly. What this closes is the caller's ability to redirect,
      // through an argument, PATH, or an inherited environment variable,
      // which executable answers this check or what that executable reads
      // while doing so; it is not identity forgery: a caller sharing this OS
      // user account can still set ORCA_TERMINAL_HANDLE itself, or run this
      // process from the director's own checkout, and pass these checks,
      // until B.6's process-lineage binding lands, and the trusted script's
      // own integrity (its app bundle, owned by that same OS user) is not
      // verified either.
      const payload = readJSON(args.from);
      const { checkpoint, objectionId, argument, evidenceRefs } = payload;
      return auditResponse(args.org, args.worktree, {
        checkpoint,
        objectionId,
        argument,
        evidenceRefs,
        declared: pickDeclaredIdentity(payload),
      });
    }
    case "audit-ruling": {
      const payload = readJSON(args.from);
      const { checkpoint, objectionId, respondedAgainst, verdict, reason } =
        payload;
      return auditRuling(args.org, args.worktree, {
        checkpoint,
        objectionId,
        respondedAgainst,
        verdict,
        reason,
        declared: pickDeclaredIdentity(payload),
      });
    }
    case "audit-checked": {
      const payload = readJSON(args.from);
      return auditChecked(
        args.org,
        args.worktree,
        args.checkpoint,
        payload.checked,
        pickDeclaredIdentity(payload),
        args.head,
        args.repo,
      );
    }
    case "audit-accept":
      return auditAccept(
        args.org,
        args.worktree,
        args.checkpoint,
        args.head,
        args.repo,
      );
    case "prepare":
      return compatibilityPrepare(args);
    case "role-worktree-create":
      return createRoleWorktree(args);
    case "role-worktree-reclaim":
      return reclaimIntegratedRoleWorktree(args);
    case "worktree-transition-reconcile":
      return reconcileAbsentRoleWorktree(args.org, args.transition, {
        executable: args.orca,
      });
    case "prepare-input":
      return prepareInput(
        validateOrg(readJSON(args.org)),
        validateTask(readJSON(args.task)),
        path.resolve(args.repo),
        path.resolve(args.output),
      );
    case "prepare-verify": {
      // Nothing validated a prepared directory before attaching it, so a
      // snapshot that had drifted from its organization or task was carried
      // into the workspace unchecked.
      const prepared = readPreparedInput(path.resolve(args.input));
      return {
        input: path.resolve(args.input),
        taskId: prepared.task.id,
        taskRevision: prepared.task.revision ?? 1,
        organizationRevision: prepared.org.revision,
        valid: true,
      };
    }
    case "attach-workspace":
      return attachExistingWorkspace(args);
    case "runtime-discover":
      return discoverOrcaRuntime(args.orca);
    case "runtime-doctor":
      validateOrg(readJSON(args.org));
      return runtimeDoctor(defaultRuntimeRoot());
    case "runtime-install":
      validateOrg(readJSON(args.org));
      return installRuntime(defaultRuntimeRoot(), {
        dryRun: Boolean(args["dry-run"]),
      });
    case "runtime-repair":
      validateOrg(readJSON(args.org));
      return installRuntime(defaultRuntimeRoot(), {
        dryRun: Boolean(args["dry-run"]),
        repair: true,
      });
    case "runtime-prune":
      validateOrg(readJSON(args.org));
      return pruneRuntimes(defaultRuntimeRoot(), {
        dryRun: Boolean(args["dry-run"]),
      });
    case "worker-start":
      return startSupervisedWorker(args);
    case "worker-limit-check":
      return workerLimitCheck({
        provider: args.provider,
        worktree: path.resolve(args.worktree),
        workflowId: args["workflow-id"],
        workflowTask: args["workflow-task"],
        ...(args.terminal
          ? {
              readScreen: async () =>
                (
                  await runOrcaJson(selectOrcaExecutable(args.orca), [
                    "terminal",
                    "read",
                    "--terminal",
                    args.terminal,
                    "--screen",
                  ])
                ).result?.terminal?.tail ?? [],
            }
          : {}),
      });
    case "terminal-idle-check": {
      // --org와 --role이 주어질 때만 matrixPrediction을 계산합니다.
      // 예측이 없으면 기존 동작을 유지합니다(matrixPrediction 전달 안 함).
      let matrixPrediction;
      if (args.org && args.role) {
        try {
          const org = validateOrg(readJSON(args.org));
          const command = roleCommand(org, args.role);
          const env = await readLaunchEnvironment({
            orcaExecutable: args.orca,
          });
          matrixPrediction = predictLaunchPath({
            runner: command.provider,
            model: command.modelRequested,
            platform: env.platform,
            shell: env.shell,
            trustRecordExists: env.trustRecordExists,
            codexTrustRecordExists: env.codexTrustRecordExists,
            skipDangerousModePermissionPrompt: Boolean(
              command.permissionBypass,
            ),
            orcaVersion: env.orcaVersion,
            cliVersion: env.cliVersion,
          });
        } catch (error) {
          process.stderr.write(
            `Warning: Failed to predict launch path: ${error.message}\n`,
          );
        }
      }
      try {
        return await checkTerminalIdle(args.terminal, {
          executable: args.orca,
          cwd: process.cwd(),
          matrixPrediction,
        });
      } catch (error) {
        throw withOrcaFailureDetail(error);
      }
    }
    case "prompt-answer":
      return answerPrompt({
        orgFile: path.resolve(args.org),
        terminal: args.terminal,
        workflowId: args["workflow-id"],
        stateDir: args.state,
        role: args.role,
        executable: args.orca,
      });
    case "role-spec":
      return (({ org, run }) => ({
        role: args.role,
        spec: roleSpec(org, args.role, args.spec, run),
      }))(launchContext(args));
    case "role-command": {
      const { org, run } = launchContext(args);
      const command = roleCommand(org, args.role, run);
      // The printed command is native Codex; a person opening a terminal with
      // it would bypass the runner and its fixed account without a record.
      assert(
        !command.runner,
        "An explicit OpenCodex runner has no interactive Orca terminal path; role-command would print a native Codex command that bypasses it",
      );
      return command;
    }
    case "role-terminal": {
      assert(
        args.profile === undefined || args["workflow-id"],
        "--profile requires --workflow-id, --state and --workflow-task",
      );
      // B.2: the auditor is opened here too, but it is out-of-ladder (never
      // folds, never runs a workflow), so it takes a resolution path of its
      // own instead of launchContext's workflow-snapshot flow: --state names
      // the audited kickoff directly, and the caller must be that kickoff's
      // director.
      let auditorEntry;
      let org;
      let runCtx;
      if (args.role === AUDITOR_ROLE) {
        assert(
          !args["workflow-id"],
          "role-terminal --role auditor does not run a workflow; omit --workflow-id",
        );
        assert(
          args.state,
          "role-terminal --role auditor requires --state naming the audited kickoff's PM state directory",
        );
        // The auditor launch is the executable a forged handle would need to
        // impersonate, so it never accepts a caller-supplied binary: --orca
        // is rejected outright rather than silently ignored, and the launch
        // below always runs through trustedOrcaExecute, which both validates
        // and directly executes the fixed trusted script (B.6, decision B).
        assert(
          args.orca === undefined,
          "role-terminal --role auditor does not accept --orca; the auditor launch always uses the trusted Orca executable",
        );
        const stateDir = path.resolve(args.state);
        const { kickoffs } = listKickoffs(path.resolve(args.org));
        auditorEntry = kickoffs.find(
          (entry) => path.resolve(entry.pm.stateDir) === stateDir,
        );
        assert(
          auditorEntry,
          `No kickoff is registered with pm state directory ${stateDir}`,
        );
        assertDirectorAuthority(
          auditorEntry,
          process.cwd(),
          "role-terminal --role auditor",
        );
        // D1/checklist 5: this kickoff's pinned auditPolicy decides the
        // profile and fallbacks, not a live organization.json read, so the
        // launch still opens with the profile this kickoff committed to even
        // when org.auditor was since changed or cleared entirely, and never
        // silently substitutes another profile when the pinned one no
        // longer exists (director decision msg_0b114271f1f5, PM supplement
        // msg_901f9291b1d3). There is no live fallback: an entry whose
        // auditPolicy was never pinned, or whose policy says no auditor is
        // configured, cannot open an auditor terminal at all.
        assert(
          auditorEntry.auditPolicy?.auditorConfigured === true,
          `Kickoff ${auditorEntry.pm.worktreeId} has no pinned auditor profile; ` +
            "the director must run kickoff-audit-policy-retrofit with --auditor-configured true " +
            "before an auditor terminal can be opened for it",
        );
        const pinnedOrg = readJSON(args.org);
        assert(
          Object.hasOwn(pinnedOrg.profiles, auditorEntry.auditPolicy.profile),
          `Kickoff ${auditorEntry.pm.worktreeId}'s pinned auditor profile ` +
            `"${auditorEntry.auditPolicy.profile}" no longer exists in organization.json; ` +
            "it is not substituted with another profile, so the auditor cannot be launched",
        );
        org = {
          ...pinnedOrg,
          auditor: {
            profile: auditorEntry.auditPolicy.profile,
            fallbacks: auditorEntry.auditPolicy.fallbacks ?? [],
          },
        };
        runCtx = { orgFile: path.resolve(args.org) };
      } else {
        ({ org, run: runCtx } = launchContext(args));
      }
      const firstPrompt =
        args.brief === undefined
          ? undefined
          : kickoffBriefPrompt(path.resolve(args.brief));
      const target = selectedWorktreePath(args.worktree, process.cwd());
      const command = roleCommand(org, args.role, {
        ...runCtx,
        firstPrompt,
        ...(args.pmSelection ? { pmSelection: args.pmSelection } : {}),
      });
      assert(
        !command.runner,
        "An explicit OpenCodex runner has no interactive Orca terminal path; role-terminal cannot run it as native Codex",
      );
      assert(
        firstPrompt === undefined || command.role === "pm",
        "--brief hands over an incoming-brief prompt, which only makes sense for the pm role this terminal launches",
      );
      if (target) assertNotKickoffOwner(target, `starting ${command.role}`);
      if (auditorEntry) {
        assert(
          target,
          "role-terminal --role auditor needs a resolvable --worktree",
        );
        const forbidden = auditorIndependenceForbiddenPaths(
          path.resolve(args.org),
          auditorEntry,
        );
        // D4: compares by filesystem identity, in both directions, instead
        // of exact string-set membership, so a symlink, a case variant, or a
        // nested path cannot pass as independent of the PM's or a worker's
        // worktree (design B.2's pathWithin). This refusal happens before any
        // terminal is opened, so it carries preCreateRefusal (부록 F): when
        // role-worktree-create's own openRoleSession wrapper catches it, it
        // reclaims the freshly created worktree instead of preserving a
        // worktree that never got a working session.
        if (sharesWorktreeWithAny(target, forbidden)) {
          const refusal = new Error(
            `The auditor cannot run from ${target}, which this kickoff's PM or a worker already uses; ` +
              "open it in a separate worktree so the audit stays independent of the work it reviews",
          );
          refusal.preCreateRefusal = { reason: "auditor-independence" };
          throw refusal;
        }
        // command.provider is already known here, before
        // resolveAuditorLaunchExecution/readLaunchEnvironment/openRoleTerminal
        // run: an agy-configured auditor profile is refused at this point
        // and no trusted-Orca probe or terminal spawn happens for it.
        // PROVIDER_IDS does not restrict org.auditor to "claude"
        // (providers/index.mjs), so this check, not the schema, is what
        // closes that gap. Also preCreateRefusal, for the same reason above.
        if (command.provider === "agy") {
          const refusal = new Error(
            "role-terminal --role auditor refuses to open: this organization's auditor profile is configured " +
              "with the agy provider. Agy 감사 지원은 별도의 신뢰 실행 경로 설계가 필요하다(아직 구현되지 않았습니다); " +
              "configure org.auditor with a non-agy profile before launching the auditor",
          );
          refusal.preCreateRefusal = { reason: "auditor-agy-provider" };
          throw refusal;
        }
      } else {
        assertDirectRoleTerminalBinding({ org: args.org, target, args });
      }
      const launchedAt = new Date().toISOString();
      assertWorktreeUnshared(
        runCtx.workflowState,
        command.role,
        args.worktree,
        process.cwd(),
      );
      const allowUnverifiedApproval = args["allow-unverified"];
      assert(
        allowUnverifiedApproval === undefined ||
          (typeof allowUnverifiedApproval === "string" &&
            allowUnverifiedApproval.trim().length > 0),
        "--allow-unverified requires a non-empty approval sentence",
      );
      // The auditor launch resolves its executable and command runner
      // through resolveAuditorLaunchExecution/trustedOrcaExecute, never from
      // args.orca (asserted absent above): this is the terminal-opening call
      // whose handle downstream identity checks (verifiedAuditor) trust, so
      // neither the executable name nor what running it reads may be
      // caller-controlled (B.6, decision B). `auditorExecute` is passed only
      // to openRoleTerminal, which runs nothing but Orca commands.
      // readLaunchEnvironment's own Orca `--version` probe is a separate
      // spawn openRoleTerminal never sees, so the auditor branch below passes
      // it `readOrcaVersion: readTrustedOrcaVersion`, which reruns the same
      // trusted, allowlisted invocation `runTrustedOrcaJson` uses rather than
      // running `versionExecutable`'s resolved path through a plain,
      // uninjected `execute`: only the trusted invocation closes the
      // script's own shebang PATH search, BASH_ENV, and an inherited HOME.
      // `skipAgyVersion: true` also drops the auditor branch's `agy
      // --version` probe entirely, rather than letting it run unconditionally
      // against PATH before the launch even opens: cliVersion only affects
      // launch-matrix's judgment when the launched runner is "agy"
      // (launch-matrix.mjs). The auditor is normally configured on a Claude
      // profile, but org.auditor's provider is not schema-restricted to
      // "claude" (providers/index.mjs's PROVIDER_IDS admits agy too); the
      // agy case never reaches this probe at all, because the
      // command.provider assertion above refuses it earlier, inside the
      // auditorEntry block, before resolveAuditorLaunchExecution runs.
      // `homedir` is likewise read from `os.userInfo()` rather than left at
      // readLaunchEnvironment's own `os.homedir()` default, so the auditor
      // branch's trust-record lookups cannot be redirected through an
      // inherited HOME either. `throwOnUnverifiedOrca: true`
      // (msg_f2bc63e31bc2/msg_f12840182482) fails the launch closed the
      // moment the trusted version probe above does not resolve to a
      // verified semver, whatever the reason (throw, non-zero exit, null,
      // empty, non-semver): readLaunchEnvironment collapses every one of
      // those into orcaVersion === "unknown" before this check runs.
      // allowUnverifiedApproval, read just above, is never passed into
      // readLaunchEnvironment, so it has no way to relax this refusal. None
      // of this applies outside the auditor branch: a non-auditor launch
      // keeps its existing PATH-based Orca/agy version probes, homedir
      // default, and unverified-version tolerance unchanged.
      const {
        executable: auditorExecutable,
        execute: auditorExecute,
        versionExecutable,
      } = auditorEntry && args.trustedLaunch
        ? assertTrustedAuditorLaunch(args.trustedLaunch)
        : resolveAuditorLaunchExecution({ auditorEntry, orcaArg: args.orca });
      // 실제 환경에서 매트릭스 입력값을 읽습니다.
      // 알 수 없는 값은 'unknown'으로 전달하여 표가 unverified로 처리합니다.
      let env;
      try {
        env = await (ports.readLaunchEnvironment ?? readLaunchEnvironment)({
          worktreePath: target ?? undefined,
          orcaExecutable: versionExecutable,
          ...(auditorEntry
            ? auditorLaunchEnvironmentInputs(auditorExecute)
            : {}),
        });
      } catch (error) {
        // The auditor's environment read runs only Orca's --version, before
        // openRoleTerminal creates any terminal, so a refusal here (an
        // unverified version, an unresolvable trusted script) proves no
        // session exists and the caller may reclaim a fresh worktree.
        if (auditorEntry) {
          error.preCreateRefusal = { reason: "auditor-launch-environment" };
        }
        throw error;
      }
      const opened = await (ports.openRoleTerminal ?? openRoleTerminal)({
        worktree: args.worktree,
        command,
        title: args.title,
        executable: auditorExecutable,
        ...(auditorExecute ? { execute: auditorExecute } : {}),
        platform: env.platform,
        shell: env.shell,
        trustRecordExists: env.trustRecordExists,
        codexTrustRecordExists: env.codexTrustRecordExists,
        orcaVersion: env.orcaVersion,
        cliVersion: env.cliVersion,
        allowUnverified: allowUnverifiedApproval !== undefined,
        allowUnverifiedApproval,
        // A folder trust question is answered only by this launch's
        // supervisor, in the worktree the selector names; without a
        // workflow and state there is nobody to prove that against.
        supervision: args["workflow-id"]
          ? {
              orgFile: path.resolve(args.org),
              stateDir: path.resolve(args.state),
              workflowId: args["workflow-id"],
              launchCwd: process.cwd(),
            }
          : null,
        expectedWorktree: target,
      });
      if (!opened.ready) return opened;
      if (args.state)
        await shadowModelCheck({
          org,
          stateDir: path.resolve(args.state),
          opened,
        });
      const drift = await resolveAndCheckDrift(args.org, org, command);
      const warnings = [...(opened.warnings || []), ...drift.warnings];
      if (auditorEntry) {
        recordAuditorLaunch(path.resolve(args.org), {
          worktreeId: auditorEntry.pm.worktreeId,
          terminalHandle: opened.terminal,
          path: target,
        });
      }
      return {
        ...opened,
        ...(allowUnverifiedApproval ? { allowUnverifiedApproval } : {}),
        ...(warnings.length > 0 ? { warnings } : { warnings: undefined }),
        ...recordLaunchSafely(args.org, launchedAt, {
          via: "role-terminal",
          role: command.role,
          profile: command.profile,
          provider: command.provider,
          modelRequested: command.modelRequested,
          modelResolved: drift.modelResolved,
          effortRequested: command.effortRequested,
          worktreePath: target,
          worktreeSelector: args.worktree,
          terminal: opened.terminal,
          workflowId: args["workflow-id"] ?? null,
          stateDir: args.state ?? null,
          ...(args.worktreeSelection
            ? { worktreeSelection: args.worktreeSelection }
            : {}),
          ...runCtx.handoff,
        }),
      };
    }
    case "host-defaults":
      return resolveHostDefaults({
        project: args.project && path.resolve(args.project),
        codexHome: args["codex-home"] && path.resolve(args["codex-home"]),
      });
    case "model-catalog":
      return fetchModelCatalog({
        codexHome: args["codex-home"] && path.resolve(args["codex-home"]),
      });
    case "model-catalog-revalidate": {
      const selections = readJSON(args.selections);
      const catalog = await fetchModelCatalog({
        codexHome: args["codex-home"] && path.resolve(args["codex-home"]),
      });
      return revalidateModelChoices(catalog, selections);
    }
    case "usage-report":
      return reportUsage(args);
    case "work":
      return work(
        path.resolve(args.repo),
        readJSON(args.org),
        readJSON(args.task),
        {
          role: args.role,
          stateDir: path.resolve(args.state),
          workflowId: args["workflow-id"],
          attemptId: args["attempt-id"],
        },
      );
    case "draft":
      return draft(
        path.resolve(args.repo),
        readJSON(args.org),
        readJSON(args.task),
        { kind: args.kind || "citations" },
      );
    case "advise":
      return advise(
        path.resolve(args.repo),
        readJSON(args.org),
        readJSON(args.brief),
        {
          role: args.role,
          kind: args.kind,
          stateDir: path.resolve(args.state),
          profileId: args.profile,
        },
      );
    case "verify": {
      const task = validateTask(readJSON(args.task));
      const timeoutMs =
        args["timeout-ms"] === undefined
          ? undefined
          : Number(args["timeout-ms"]);
      return verify(path.resolve(args.repo), {
        commands: task.checks,
        baseRef: task.baseRef,
        environment: task.environment,
        store: path.join(path.resolve(args.state), "evidence"),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    }
    case "review-record": {
      const stateDir = path.resolve(args.state);
      return recordReview(
        path.resolve(args.repo),
        validateTask(readJSON(args.task)),
        readJSON(args.report),
        readJSON(args.review),
        stateDir,
        gateHookOptions(args, stateDir),
      );
    }
    case "gate-cache-refresh": {
      const stateDir = path.resolve(args.state);
      return refreshGateCache(
        path.resolve(args.repo),
        readJSON(args.task),
        readJSON(args.report),
        stateDir,
        gateHookOptions(args, stateDir),
      );
    }
    case "gate-check": {
      const stateDir = path.resolve(args.state);
      return gateCheck(
        path.resolve(args.repo),
        validateTask(readJSON(args.task)),
        readJSON(args.report),
        stateDir,
        gateHookOptions(args, stateDir),
      );
    }
    case "accept": {
      const stateDir = path.resolve(args.state);
      return acceptOutcome(
        path.resolve(args.repo),
        validateTask(readJSON(args.task)),
        readJSON(args.report),
        readJSON(args.decision),
        stateDir,
        {
          ...gateHookOptions(args, stateDir),
          orgFile: args.org && path.resolve(args.org),
          worktreeId: args.worktree,
        },
      );
    }
    case "doc-resolve-kickoff":
      return { kickoffHash: resolveKickoffHash(args.org, args.worktree) };
    case "doc-id": {
      const docId = buildDocId({
        kickoffHash: args["kickoff-hash"],
        workflowId: args["workflow-id"] ?? null,
        stageSlug: args.stage,
        docType: args["doc-type"],
        localId: args["local-id"],
      });
      return args.revision === undefined
        ? { docId }
        : { docId, docRef: buildDocRef(docId, Number(args.revision)) };
    }
    case "doc-show": {
      const stateDir = path.resolve(args.state);
      return {
        docId: args["doc-id"],
        path: documentDirectory(stateDir, args["doc-id"]),
        ...documentState(stateDir, args["doc-id"]),
      };
    }
    case "doc-save": {
      const stateDir = path.resolve(args.state);
      const doc = readJSON(args.doc);
      assertDocumentAuthority(stateDir, doc, args.org);
      const options = {};
      if (args["expected-revision"] !== undefined) {
        options.expectedRevision = Number(args["expected-revision"]);
      }
      if (args["request-id"] !== undefined) {
        options.requestId = args["request-id"];
      }
      if (args.refs !== undefined) {
        options.refs = args.refs
          .split(",")
          .map((ref) => ref.trim())
          .filter(Boolean);
      }
      return saveDocument(stateDir, doc, options);
    }
    case "doc-event-consume":
      return consumeDocumentEvent(
        path.resolve(args.state),
        readJSON(args.event),
      );
    case "doc-event-deliver": {
      const stateDir = path.resolve(args.state);
      const scope = await resolveRegisteredKickoffFromState(stateDir);
      assert(
        scope?.kickoffHash === args["kickoff-hash"],
        "Document event kickoff does not match registered state",
      );
      return deliverUndeliveredEvents(
        stateDir,
        args["kickoff-hash"],
        args["workflow-id"],
        undefined,
        { actor: args.actor, to: args.to },
      );
    }
    case "workflow-create":
      return createWorkflow(
        path.resolve(args.state),
        readJSON(args.workflow),
        validateOrg(readJSON(args.org)),
        path.dirname(path.resolve(args.workflow)),
      );
    case "workflow-status":
      return readWorkflow(path.resolve(args.state), args.id).state;
    case "workflow-accept": {
      const stateDir = path.resolve(args.state);
      const kickoffHash = resolveGateKickoffHash(args.org, stateDir);
      return acceptWorkflowIntegration(
        stateDir,
        args.id,
        Number(args.revision),
        args.repo && path.resolve(args.repo),
        args.report && readJSON(args.report),
        kickoffHash === undefined ? {} : { kickoffHash },
      );
    }
    case "workflow-resume":
      return resumeWorkflow(
        path.resolve(args.state),
        args.id,
        Number(args.revision),
        args.observations ? readJSON(args.observations) : {},
      );
    case "workflow-attach":
      return attachExecution(
        path.resolve(args.state),
        args.id,
        Number(args.revision),
        readJSON(args.execution),
      );
    case "workflow-reserve":
      return reserveExecution(
        path.resolve(args.state),
        args.id,
        Number(args.revision),
        readJSON(args.execution),
      );
    case "workflow-settle":
      return recordSettlement(
        path.resolve(args.state),
        args.id,
        Number(args.revision),
        readJSON(args.settlement),
      );
    case "workflow-release":
      return releaseReservation(
        path.resolve(args.state),
        args.id,
        Number(args.revision),
        readJSON(args.release),
      );
    case "workflow-rework":
      return reworkTask(
        path.resolve(args.state),
        args.id,
        Number(args.revision),
        readJSON(args.rework),
      );
    case "workflow-retry":
      return retryTask(
        path.resolve(args.state),
        args.id,
        Number(args.revision),
        readJSON(args.retry),
      );
    case "workflow-handoff":
      return handoffTask(
        path.resolve(args.state),
        args.id,
        Number(args.revision),
        readJSON(args.handoff),
      );
    case "handoff-checkpoint":
      return recordCheckpoint(
        path.resolve(args.state),
        args["workflow-id"],
        args["workflow-task"],
        {
          text: fs.readFileSync(path.resolve(args.file), "utf8"),
          repo: path.resolve(args.repo ?? "."),
        },
      );
    case "workflow-depth":
      return setWorkflowDepth(
        path.resolve(args.state),
        args.id,
        Number(args.revision),
        readJSON(args.change),
      );
    case "workflow-allowance":
      return increaseCallAllowance(
        path.resolve(args.state),
        args.id,
        Number(args.revision),
        readJSON(args.allowance),
      );
    case "workflow-budget":
      return increaseWorkflowBudget(
        path.resolve(args.state),
        args.id,
        Number(args.revision),
        readJSON(args.change),
      );
    case "workflow-reopen":
      return reopenTask(
        path.resolve(args.state),
        args.id,
        Number(args.revision),
        readJSON(args.reopen),
      );
    case "workflow-integration-checks":
      return extendIntegrationChecks(
        path.resolve(args.state),
        args.id,
        Number(args.revision),
        readJSON(args.checks),
      );
    case "workflow-approval-correction":
      return correctApprovalProvenance(
        path.resolve(args.state),
        args.id,
        Number(args.revision),
        readJSON(args.correction),
      );
    case "workflow-staffing":
      return changeTaskStaffing(
        path.resolve(args.state),
        args.id,
        Number(args.revision),
        readJSON(args.change),
      );
    case "failure-classify": {
      const input = withRuntimeSignal(
        validateFailureEvidence(readJSON(args.failure)),
      );
      const decision = classifyFailure(input);
      if (args.state && args.org)
        await shadowFailureFallback({
          org: validateOrg(readJSON(args.org)),
          stateDir: path.resolve(args.state),
          input,
          decision,
        });
      return decision;
    }
    case "lesson-record":
      return recordLessonCandidate(
        path.resolve(args.state),
        readJSON(args.lesson),
      );
    case "incident-ingest":
      return ingestIncident(
        path.resolve(args.state),
        readJSON(args.event),
        readJSON(args.config),
      );
    case "incident-observe":
      return observeIncident(
        path.resolve(args.state),
        readJSON(args.observation),
        readJSON(args.config),
      );
    case "incident-status":
      return incidentStatus(path.resolve(args.state));
    case "quota-record":
      return recordQuotaSnapshot(
        path.resolve(args.state),
        readJSON(args.snapshot),
      );
    case "quota-compare":
      return compareQuotaSnapshots(readJSON(args.before), readJSON(args.after));
    case "merge-check":
      return mergeCheck(args);
    case "aggregate":
      return aggregate(
        (args.report ?? []).map((file) => ({
          ...readJSON(file),
          reportPath: path.resolve(file),
        })),
        args.expected.split(","),
      );
    case "director-signal": {
      if (args.kind === "close-ready") {
        // D1: reads this kickoff's pinned auditPolicy, not a fresh
        // organization.json, so removing org.auditor after claim cannot let
        // close-ready pass while an outcome objection is still unresolved.
        // There is no live-read fallback (director decision msg_0b114271f1f5):
        // a legacy entry with no pinned auditPolicy refuses outright, naming
        // the retrofit command.
        const [entry] = listKickoffs(args.org, args.worktree).kickoffs;
        assert(
          entry?.auditPolicy !== undefined,
          `Kickoff ${args.worktree} has no pinned audit policy; the director must run ` +
            "kickoff-audit-policy-retrofit for this worktree before close-ready can be signaled",
        );
        const auditorConfigured = entry.auditPolicy.auditorConfigured;
        if (auditorConfigured) {
          assert(
            await hasValidAcceptance(
              args.org,
              args.worktree,
              "outcome",
              args.head,
              // The result repository comes from the recorded workflow
              // decision; --source is only compared with it (B.3).
              bindKickoffResultRepo(entry, args.source),
            ),
            "close-ready requires a valid outcome-audit acceptance for this kickoff; " +
              "resolve the outcome audit checkpoint (audit-response/audit-ruling/audit-accept) " +
              "before sending it",
          );
        }
      }
      let signal;
      try {
        signal = sendSignal(args.org, {
          worktreeId: args.worktree,
          kind: args.kind,
          text: args.text,
          head: args.head,
          source: args.source,
        });
      } catch (error) {
        if (!/^Duplicate pending /.test(error.message)) throw error;
        const record = listInbox(args.org).signals.find(
          (item) =>
            item.worktreeId === args.worktree &&
            item.kind === args.kind &&
            item.text === args.text.trim() &&
            (args.kind !== "close-ready" ||
              (item.head === args.head && item.source === args.source)),
        );
        if (!record) throw error;
        const [entry] = listKickoffs(args.org, args.worktree).kickoffs;
        signal = { signaled: false, id: record.id, entry, record };
      }
      const { signaled, id, entry } = signal;
      if (!signaled) return { signaled, id, replayed: true };
      let delivery;
      let notifyError;
      try {
        delivery = await sendOrcaMessage({
          to: entry.director.terminalHandle,
          type: "status",
          subject: `${args.kind} from ${args.worktree}`,
          body: args.text,
          executable: args.orca,
        });
      } catch (error) {
        notifyError = error.message;
      }
      return {
        signaled,
        id,
        ...(delivery ? { delivery } : {}),
        ...(notifyError ? { notifyError } : {}),
      };
    }
    case "director-inbox":
      return listInbox(args.org, {
        directorTerminal: directorCallerTerminal(args),
      });
    case "director-reply":
      return replySignal(args.org, {
        signalId: args.signal,
        text: args.text,
        directorTerminal: directorCallerTerminal(args),
      });
    case "director-ack": {
      if (args.delivery) {
        const callerTerminal =
          args["director-terminal"] ??
          args.terminal ??
          process.env.ORCA_TERMINAL_HANDLE;
        return acknowledgeDelivery(args.org, args.delivery, { callerTerminal });
      }
      assert(args.signal, "director-ack needs --signal ID or --delivery ID");
      return acknowledgeSignal(args.org, args.signal, {
        directorTerminal: directorCallerTerminal(args),
      });
    }
    case "director-delivery":
      return recordDeliveryReceipt(args.org, {
        source: args.source,
        head: args.head,
        pr: args.pr,
        target: args.target,
        directorTerminal: args["director-terminal"],
        text: args.text,
        orcaExecutable: args.orca,
      });
    case "director-deliveries":
      return listDeliveries(args.org, {
        unacknowledgedOnly: Boolean(args.unacknowledged),
      });
    case "resource-acquire":
      return acquireResource(args.org, {
        worktreeId: args.worktree,
        kind: args.kind,
        note: args.note,
        ownerPid: args["owner-pid"] ? Number(args["owner-pid"]) : undefined,
      });
    case "resource-release":
      return releaseResource(args.org, args.slot);
    case "director-command":
      return directorCommand(
        validateOrg(readJSON(args.org)),
        directorRequest(args),
      );
    case "director-terminal": {
      const org = validateOrg(readJSON(args.org));
      const request = directorRequest(args);
      const command = directorCommand(org, request);
      const checkout = path.resolve(args.checkout ?? ownerProject(args.org));
      // The calling terminal is the one the user is looking at, so a split of
      // it is visible; a terminal created in the owner checkout may not be.
      const fromTerminal =
        args["from-terminal"] ?? process.env.ORCA_TERMINAL_HANDLE ?? undefined;
      const opened = await openDirectorTerminal({
        checkout,
        command,
        title: args.title,
        fromTerminal: fromTerminal || undefined,
        executable: args.orca,
      });
      const reassigned =
        opened.ready && args.replace
          ? reassignDirector(args.org, {
              from: args.replace,
              to: opened.terminal,
              checkoutPath: checkout,
            })
          : null;
      return { ...opened, brief: request.brief ?? null, reassigned };
    }
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

// What a director launch asks for: an organization profile or an explicit
// provider, and the brief whose fixed-wording prompt becomes the first prompt.
function directorRequest(args) {
  const brief = args.brief === undefined ? undefined : path.resolve(args.brief);
  assert(
    brief === undefined || fs.existsSync(brief),
    `Brief not found: ${brief}`,
  );
  return {
    profile: args.profile,
    provider: args.provider,
    model: args.model,
    effort: args.effort,
    ...(brief ? { brief, firstPrompt: directorBriefPrompt(brief) } : {}),
  };
}

const BLOCKING_STATUSES = ["failed", "blocked"];
// A prompt answer that was refused, went upward or left the question on the
// screen did not do what the caller asked.
const PROMPT_ANSWER_BLOCKING = ["refused", "escalate", "unresolved"];

// Commands do not share one envelope: a worker report carries `status`, the
// workflow mutations wrap the new state in `{state, ...}`, and the review and
// acceptance commands report `gateStatus`. Reading only the top-level `status`
// left a settled failure and a revoked approval exiting 0, so a calling
// script saw success. Each known shape is checked explicitly.
/**
 * Tells whether a command's printed output makes the CLI exit non-zero.
 *
 * @param {unknown} output - The value a command returned before it is printed.
 * @returns {boolean} `true` when the output carries a failed or blocked status
 *   in any of the known envelope shapes.
 */
export function blockingOutcome(output) {
  if (!output || typeof output !== "object") return false;
  if (output.event === "prompt-answer")
    return PROMPT_ANSWER_BLOCKING.includes(output.status);
  return [output.status, output.state?.status, output.gateStatus?.status].some(
    (value) => BLOCKING_STATUSES.includes(value),
  );
}

/**
 * Runs the CLI, prints JSON output, and sets failure exit status when applicable.
 *
 * @param {string[]} [argv=process.argv.slice(2)] - CLI arguments.
 * @returns {Promise<void>}
 * @throws {Error} For invalid arguments or a failed domain operation.
 */
export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.includes("--help")) {
    console.log(HELP);
    return;
  }
  const args = parseArgs(argv);
  validateArgs(args);
  const output = await executeCommand(args);
  if (output === undefined) return;
  // The spec goes straight into task-create; printed as JSON it arrived there
  // escaped, quotes and all (#41).
  if (args.command === "role-spec" && args.text) {
    console.log(output.spec);
    return;
  }
  console.log(JSON.stringify(output, null, 2));
  if (blockingOutcome(output)) process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
