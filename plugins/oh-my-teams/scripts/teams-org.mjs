#!/usr/bin/env node
/** Thin CLI adapter for the oh my teams domain modules. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  chart,
  readJSON,
  saveOrg,
  supervisionPolicy,
  validateOrg,
  writeJSON,
} from "./core.mjs";
import {
  assertWorktreeUnshared,
  launchBinding,
  selectedWorktreePath,
  resolveRoleLaunch,
  roleCommand,
  roleSpec,
} from "./role-launch.mjs";
import { resolveHostDefaults } from "./host-defaults.mjs";
import { assertNotKickoffOwner, deliverKickoff } from "./delivery.mjs";
import {
  answerHeadless,
  HEADLESS_PROTOCOL,
  HEADLESS_PROVIDERS,
  listHeadless,
  startHeadlessWorker,
  stopHeadless,
  waitHeadless,
} from "./headless.mjs";
import {
  openRoleTerminal,
  pinTerminalTitle,
  roleTitle,
  workerTerminal,
} from "./role-terminal.mjs";
import { assist, draft, validateTask, work } from "./worker.mjs";
import { aggregate, validateEvidence, verify } from "./evidence.mjs";
import { previewPreset } from "./presets.mjs";
import { acceptOutcome, gateCheck, recordReview } from "./gates.mjs";
import {
  checkTerminalIdle,
  createWorktree,
  discoverOrcaRuntime,
  injectTask,
  startWorker,
} from "./orca-adapter.mjs";
import { withRuntimeSignal } from "./adapters.mjs";
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
  reworkTask,
  setWorkflowDepth,
} from "./workflow.mjs";
import { classifyFailure, validateFailureEvidence } from "./failures.mjs";
import { recordLessonCandidate } from "./lessons.mjs";
import {
  incidentStatus,
  ingestIncident,
  observeIncident,
} from "./incidents.mjs";
import { compareQuotaSnapshots, recordQuotaSnapshot } from "./quota.mjs";
import { nextSupervisionAction, organizationStatus } from "./status.mjs";
import { draftOrganization } from "./org-draft.mjs";
import {
  bindKickoffRun,
  listKickoffs,
  registerKickoff,
  releaseKickoff,
} from "./kickoff-registry.mjs";
import { recordLaunch } from "./usage-ledger.mjs";
import { formatUsageTable, usageReport } from "./usage-report.mjs";

const HELP = `oh my teams organization runtime on Orca (Node >=22)
  org-draft --name NAME --models provider:model,... --output FILE [--tiers 1-5]
  init --org FILE --from CONFIG
  edit --org FILE --from CONFIG --revision N
  preset --org FILE --name opus-first|balanced|single-subscription --revision N
         [--apply]
  show --org FILE [--state DIR] [--json]
  validate --org FILE
  kickoff-claim --org FILE --from CLAIM
  kickoff-show --org FILE [--worktree ID]
  kickoff-bind --org FILE --worktree ID --run ID
  kickoff-release --org FILE --worktree ID
                  --reason completed|disbanded|taken-over [--force]
  deliver --org FILE --worktree ID --source DIR --head SHA
          --evidence FILE --task TRUSTED_TASK [--report FILE --state DIR]
          (merges a verified kickoff result into the branch its claim recorded;
          run by the declaring session in close)
  prepare --org FILE --task FILE --repo DIR --name NAME [--orca EXECUTABLE]
  prepare-input --org FILE --task FILE --repo DIR --output DIR
  prepare-verify --input DIR
  attach-workspace --org FILE --task FILE --repo DIR --workspace DIR
                   --receipt FILE --runtime FILE --state DIR --name NAME
                   [--orca EXECUTABLE]
  runtime-discover [--orca EXECUTABLE]
  worker-start --org FILE --role ROLE --repo DIR (--spec TEXT | --task ID)
               [--worktree SELECTOR] [--terminal HANDLE] [--run ID]
               [--retry-of ID] [--title TEXT] [--workflow-id ID --state DIR]
               [--inject-fallback "USER APPROVAL"]
               [--orca EXECUTABLE]
               (with --workflow-id, the workflow's organization snapshot is used;
               the worker's tab title starts with its role tag, e.g. [PL])
  headless-start --org FILE --role ROLE --cwd DIR --spec TEXT --state DIR
                 [--workflow-id ID] [--timeout-ms N] [--worker ID]
                 (runs the role as a non-interactive process, without Orca)
  headless-status --state DIR --worker ID [--wait-ms N]
  headless-answer --state DIR --worker ID --text TEXT [--timeout-ms N]
  headless-stop --state DIR --worker ID
  headless-list --state DIR
  terminal-idle-check --terminal HANDLE [--orca EXECUTABLE]
               (run before workflow-reserve for a reused terminal)
  role-spec --org FILE --role ROLE --spec TEXT [--workflow-id ID --state DIR]
            [--text]
  role-command --org FILE --role ROLE [--workflow-id ID --state DIR]
  role-terminal --org FILE --role ROLE --worktree SELECTOR [--title TEXT]
                [--workflow-id ID --state DIR] [--orca EXECUTABLE]
                (the tab title is the role tag, e.g. [PM], then TEXT or the worktree)
  host-defaults [--project DIR] [--codex-home DIR]
  usage-report --org FILE [--worktree ID | --all] [--state DIR]
               [--place ROLE=DIR ...] [--claude-home DIR] [--codex-home DIR]
               [--agy-home DIR] [--write] [--json]
               (per-role turns and tokens from provider session records, read-only;
               --write stores the report in <project>/.omt/history)
  supervision-next --org FILE --observation FILE
  work --org SNAPSHOT --task FILE --repo WORKTREE --state SHARED_DIR [--role intern]
       [--workflow-id ID --attempt-id ID]
  draft --org FILE --task FILE --repo DIR [--kind citations|checklist]
  assist --org FILE --task FILE --repo DIR --state DIR --role ROLE
         --kind research|checklist|edit [--profile PROFILE]
  verify --task FILE --repo DIR --state DIR
  merge-check --evidence FILE --task TRUSTED_TASK --repo DIR --base REF
              [--report FILE --state DIR]
  review-record --task FILE --report FILE --review FILE --repo DIR --state DIR
  gate-check --task FILE --report FILE --repo DIR --state DIR
  accept --task FILE --report FILE --decision FILE --repo DIR --state DIR
  workflow-create --workflow FILE --org FILE --state DIR
  workflow-status --id ID --state DIR
  workflow-resume --id ID --state DIR --revision N [--observations FILE]
  workflow-attach --id ID --state DIR --revision N --execution FILE
  workflow-reserve --id ID --state DIR --revision N --execution FILE
  workflow-accept --id ID --state DIR --revision N [--repo DIR --report FILE]
                  (repo and report only when the workflow requires integration)
  workflow-settle --id ID --state DIR --revision N --settlement FILE
  workflow-release --id ID --state DIR --revision N --release FILE
  workflow-retry --id ID --state DIR --revision N --retry FILE
  workflow-rework --id ID --state DIR --revision N --rework FILE
                  (attaches the corrected execution after a review asked for changes)
  workflow-depth --id ID --state DIR --revision N --change FILE
  failure-classify --failure FILE
  lesson-record --lesson FILE --state DIR
  incident-ingest --event FILE --config FILE --state DIR
  incident-observe --observation FILE --config FILE --state DIR
  incident-status --state DIR
  quota-record --snapshot FILE --state DIR
  quota-compare --before FILE --after FILE
  aggregate --expected id,id --report FILE [--report FILE ...]

Existing organizations are reused; init never asks for subscriptions again.
No command automatically pushes, merges, deploys, publishes, or deletes.`;

/** Options each subcommand accepts, keyed by command name. */
export const ALLOWED_OPTIONS = {
  "org-draft": ["name", "tiers", "models", "output"],
  init: ["org", "from"],
  edit: ["org", "from", "revision"],
  preset: ["org", "name", "revision", "apply"],
  show: ["org", "state", "json"],
  validate: ["org"],
  "kickoff-claim": ["org", "from"],
  "kickoff-show": ["org", "worktree"],
  "kickoff-bind": ["org", "worktree", "run"],
  "kickoff-release": ["org", "worktree", "reason", "force"],
  deliver: [
    "org",
    "worktree",
    "source",
    "head",
    "evidence",
    "task",
    "report",
    "state",
  ],
  prepare: ["org", "task", "repo", "name", "orca"],
  "prepare-input": ["org", "task", "repo", "output"],
  "prepare-verify": ["input"],
  "attach-workspace": [
    "org",
    "task",
    "repo",
    "workspace",
    "receipt",
    "runtime",
    "state",
    "name",
    "orca",
  ],
  "runtime-discover": ["orca"],
  "role-spec": ["org", "role", "spec", "workflow-id", "state", "text"],
  "terminal-idle-check": ["terminal", "orca"],
  "headless-start": [
    "org",
    "role",
    "cwd",
    "spec",
    "state",
    "workflow-id",
    "timeout-ms",
    "worker",
  ],
  "headless-status": ["state", "worker", "wait-ms"],
  "headless-answer": ["state", "worker", "text", "timeout-ms"],
  "headless-stop": ["state", "worker"],
  "headless-list": ["state"],
  "role-command": ["org", "role", "workflow-id", "state"],
  "role-terminal": [
    "org",
    "role",
    "worktree",
    "title",
    "workflow-id",
    "state",
    "orca",
  ],
  "host-defaults": ["project", "codex-home"],
  "usage-report": [
    "org",
    "worktree",
    "all",
    "state",
    "place",
    "claude-home",
    "codex-home",
    "agy-home",
    "write",
    "json",
  ],
  "supervision-next": ["org", "observation"],
  "worker-start": [
    "org",
    "role",
    "repo",
    "task",
    "spec",
    "worktree",
    "agent",
    "terminal",
    "model",
    "effort",
    "run",
    "retry-of",
    "title",
    "inject-fallback",
    "workflow-id",
    "state",
    "orca",
  ],
  work: ["org", "task", "repo", "state", "role", "workflow-id", "attempt-id"],
  draft: ["org", "task", "repo", "kind"],
  assist: ["org", "task", "repo", "state", "role", "kind", "profile"],
  verify: ["task", "repo", "state"],
  "merge-check": ["evidence", "task", "repo", "base", "report", "state"],
  aggregate: ["expected", "report"],
  "review-record": ["task", "report", "review", "repo", "state"],
  "gate-check": ["task", "report", "repo", "state"],
  accept: ["task", "report", "decision", "repo", "state"],
  "workflow-create": ["workflow", "org", "state"],
  "workflow-status": ["id", "state"],
  "workflow-resume": ["id", "state", "revision", "observations"],
  "workflow-attach": ["id", "state", "revision", "execution"],
  "workflow-reserve": ["id", "state", "revision", "execution"],
  "workflow-accept": ["id", "state", "revision", "repo", "report"],
  "workflow-settle": ["id", "state", "revision", "settlement"],
  "workflow-release": ["id", "state", "revision", "release"],
  "workflow-retry": ["id", "state", "revision", "retry"],
  "workflow-rework": ["id", "state", "revision", "rework"],
  "workflow-depth": ["id", "state", "revision", "change"],
  "failure-classify": ["failure"],
  "lesson-record": ["lesson", "state"],
  "incident-ingest": ["event", "config", "state"],
  "incident-observe": ["observation", "config", "state"],
  "incident-status": ["state"],
  "quota-record": ["snapshot", "state"],
  "quota-compare": ["before", "after"],
};

/** Options each subcommand must receive, keyed by command name. */
export const REQUIRED_OPTIONS = {
  "org-draft": ["name", "models", "output"],
  init: ["org", "from"],
  edit: ["org", "from", "revision"],
  preset: ["org", "name", "revision"],
  show: ["org"],
  validate: ["org"],
  "kickoff-claim": ["org", "from"],
  "kickoff-show": ["org"],
  "kickoff-bind": ["org", "worktree", "run"],
  "kickoff-release": ["org", "worktree", "reason"],
  deliver: ["org", "worktree", "source", "head", "evidence", "task"],
  prepare: ["org", "task", "repo", "name"],
  "prepare-input": ["org", "task", "repo", "output"],
  "prepare-verify": ["input"],
  "attach-workspace": [
    "org",
    "task",
    "repo",
    "workspace",
    "receipt",
    "runtime",
    "state",
    "name",
  ],
  "runtime-discover": [],
  "worker-start": ["org", "role", "repo"],
  "role-spec": ["org", "role", "spec"],
  "terminal-idle-check": ["terminal"],
  "headless-start": ["org", "role", "cwd", "spec", "state"],
  "headless-status": ["state", "worker"],
  "headless-answer": ["state", "worker", "text"],
  "headless-stop": ["state", "worker"],
  "headless-list": ["state"],
  "role-command": ["org", "role"],
  "role-terminal": ["org", "role", "worktree"],
  "host-defaults": [],
  "usage-report": ["org"],
  "supervision-next": ["org", "observation"],
  work: ["org", "task", "repo", "state"],
  draft: ["org", "task", "repo"],
  assist: ["org", "task", "repo", "state", "role", "kind"],
  verify: ["task", "repo", "state"],
  "merge-check": ["evidence", "task", "repo", "base"],
  aggregate: ["expected"],
  "review-record": ["task", "report", "review", "repo", "state"],
  "gate-check": ["task", "report", "repo", "state"],
  accept: ["task", "report", "decision", "repo", "state"],
  "workflow-create": ["workflow", "org", "state"],
  "workflow-status": ["id", "state"],
  "workflow-resume": ["id", "state", "revision"],
  "workflow-attach": ["id", "state", "revision", "execution"],
  "workflow-reserve": ["id", "state", "revision", "execution"],
  "workflow-accept": ["id", "state", "revision"],
  "workflow-settle": ["id", "state", "revision", "settlement"],
  "workflow-release": ["id", "state", "revision", "release"],
  "workflow-retry": ["id", "state", "revision", "retry"],
  "workflow-rework": ["id", "state", "revision", "rework"],
  "workflow-depth": ["id", "state", "revision", "change"],
  "failure-classify": ["failure"],
  "lesson-record": ["lesson", "state"],
  "incident-ingest": ["event", "config", "state"],
  "incident-observe": ["observation", "config", "state"],
  "incident-status": ["state"],
  "quota-record": ["snapshot", "state"],
  "quota-compare": ["before", "after"],
};

/**
 * Parses strict `--key value` CLI input and the repeatable `--report` and
 * `--place` values.
 *
 * @param {string[]} argv - Arguments excluding executable and script path.
 * @returns {object} Command plus parsed option values.
 * @throws {Error} For positional input, duplicates, or missing values.
 */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    assert(key.startsWith("--"), `Unexpected argument: ${key}`);
    const option = key.slice(2);
    // `--text` is a flag only for role-spec; headless-answer takes a value.
    if (
      ["json", "apply", "force", "all", "write"].includes(option) ||
      (option === "text" && command === "role-spec")
    ) {
      args[option] = true;
      continue;
    }
    const optionValue = rest[index + 1];
    assert(
      optionValue && !optionValue.startsWith("--"),
      `Missing value: ${key}`,
    );
    index += 1;
    if (
      (option === "report" && command === "aggregate") ||
      (option === "place" && command === "usage-report")
    ) {
      args[option] ??= [];
      args[option].push(optionValue);
    } else {
      assert(!(option in args), `Duplicate option: ${key}`);
      args[option] = optionValue;
    }
  }
  return args;
}

function validateArgs(args) {
  const allowed = ALLOWED_OPTIONS[args.command];
  assert(allowed, `Unknown command: ${args.command}`);
  for (const key of Object.keys(args)) {
    assert(
      key === "command" || allowed.includes(key),
      `Unknown option: --${key}`,
    );
  }
  for (const key of REQUIRED_OPTIONS[args.command]) {
    assert(args[key], `--${key} required`);
  }
}

function applyPreset(args) {
  const current = validateOrg(readJSON(args.org));
  assert(
    Number(args.revision) === current.revision,
    "Organization changed; read it again before applying a preset",
  );
  const preview = previewPreset(current, args.name);
  if (!args.apply) {
    return { ...preview, organization: undefined, applied: false };
  }
  const saved = saveOrg(args.org, preview.organization, {
    update: true,
    expectedRevision: current.revision,
  });
  return { ...preview, organization: saved.organization, applied: true };
}

function showOrganization(args) {
  const org = validateOrg(readJSON(args.org));
  const status = organizationStatus(org, args.state);
  if (args.json) return { organization: org, ...status };
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
  const created = await createWorktree(repo, {
    name: args.name,
    base: prepared.frozenTask.baseRef,
    executable: args.orca,
  });
  const attached = await attachWorkspace({
    parentRepo: repo,
    workspace: created.path,
    stateDir,
    name: args.name,
    org,
    task: prepared.frozenTask,
    receipt: created.receipt,
    executable: created.executable,
    runtime: created.discovery,
  });
  return {
    ...attached,
    note:
      "Compatibility prepare completed. New integrations should use " +
      "prepare-input, current Orca discovery, then attach-workspace.",
  };
}

// The receipt is returned whether or not the start reached `ready`, because a
// start that failed still names the Dispatch and the resources someone has to
// reclaim. A refusal that produced no Dispatch throws, and its neutral signal
// travels with the error so the caller can route it rather than reread prose.
//
// The agent, model and effort come from the role's saved profile. Explicit
// values are accepted only when they restate it, so a hand-typed launch can no
// longer drop the model the user chose. A reused terminal keeps whatever model
// it was started with, so it gets no model arguments and its proof stays
// unproven.
async function startSupervisedWorker(args) {
  const { org, run } = launchContext(args);
  const launch = resolveRoleLaunch(
    org,
    args.role,
    { agent: args.agent, model: args.model, effort: args.effort },
    { ...run, terminal: args.terminal },
  );
  // `new-child` makes a worktree nobody works in yet, so only a named or
  // current worktree can belong to another role's task or to the owner.
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
  const viaTerminal = launch.via === "terminal";
  const launchedAt = new Date().toISOString();
  try {
    const started = await startWorker(path.resolve(args.repo), {
      task: args.task,
      spec: args.spec && roleSpec(org, launch.role, args.spec, run),
      worktree: args.worktree ?? "current",
      agent: viaTerminal ? undefined : launch.agent,
      terminal: args.terminal,
      model: viaTerminal ? undefined : (launch.model ?? undefined),
      effort: viaTerminal ? undefined : (launch.effort ?? undefined),
      runId: args.run,
      retryOf: args["retry-of"],
      executable: args.orca,
    });
    const binding = launchBinding(launch, started);
    // Orca names a new worker's tab after the agent, which does not say which
    // role it holds; the tab gets the role tag once the terminal exists.
    const worker = workerTerminal(started.receipt, args.terminal);
    const title = worker.handle
      ? roleTitle(launch.role, args.title ?? worker.place)
      : null;
    const titlePinned = Boolean(
      title &&
      (await pinTerminalTitle({
        orca: started.executable,
        handle: worker.handle,
        title,
      })),
    );
    const ledger = recordLaunchSafely(args.org, launchedAt, {
      via: "worker-start",
      role: launch.role,
      profile: launch.profile,
      provider: launch.provider,
      modelRequested: launch.model,
      effortRequested: launch.effort,
      worktreePath:
        selectedWorktreePath(args.worktree ?? "current", args.repo) ??
        receiptWorktreePath(started.receipt),
      worktreeSelector: args.worktree ?? "current",
      terminal: worker.handle,
      workerId: started.workerId ?? null,
      workflowId: args["workflow-id"] ?? null,
      stateDir: args.state ?? null,
    });
    return {
      ...started,
      ...ledger,
      title,
      titlePinned,
      binding: { ...binding, roleHeader: Boolean(args.spec) },
      // A launch Orca recorded with another model must not be handed work.
      ...(binding.modelProof === "mismatched" ? { status: "blocked" } : {}),
    };
  } catch (error) {
    if (!error.signal) throw error;
    if (
      args["inject-fallback"] &&
      viaTerminal &&
      error.signal.kind === "execution-unconfigured" &&
      error.signal.code === "timeout"
    ) {
      return injectFallback(args, org, run, launch, error.signal);
    }
    error.message = `${error.message}\n${JSON.stringify(
      { signal: error.signal, receipt: error.receipt ?? null },
      null,
      2,
    )}`;
    throw error;
  }
}

// A role run as a non-interactive process gets the same checks a terminal
// launch does: its profile, whether this run holds the role, the owner
// checkout, and another role's worktree. The instruction carries the role's
// charter and the headless protocol, since no one answers a prompt.
function startHeadlessRole(args) {
  // `--state` is where the worker is recorded; it names workflow state only
  // together with `--workflow-id`.
  const { org, run } = launchContext(
    args["workflow-id"] ? args : { ...args, state: undefined },
  );
  const command = roleCommand(org, args.role, run);
  // roleCommand also serves the PM's terminal; a worker is never PM.
  assert(
    command.role !== "pm",
    args.role === "pm"
      ? "PM runs in its own terminal opened with role-command; it is not started as a headless worker"
      : `${args.role} folds to pm, which does its work itself`,
  );
  assert(
    HEADLESS_PROVIDERS.includes(command.provider),
    `Role ${command.role} uses ${command.provider}, which has no headless runtime; ` +
      `supported: ${HEADLESS_PROVIDERS.join(", ")}`,
  );
  const cwd = path.resolve(args.cwd);
  assertNotKickoffOwner(cwd, `starting ${command.role}`);
  assertWorktreeUnshared(run.workflowState, command.role, `path:${cwd}`, cwd);
  const workerId = args.worker ?? `${command.role}-${Date.now().toString(36)}`;
  const launchedAt = new Date().toISOString();
  const started = startHeadlessWorker({
    stateDir: args.state,
    workerId,
    role: command.role,
    profile: command.profile,
    provider: command.provider,
    binary: [command.argv[0]],
    model: command.modelRequested,
    effort: command.effortRequested,
    cwd,
    prompt: `${roleSpec(org, command.role, args.spec, run)}
${HEADLESS_PROTOCOL}
`,
    ...(args["timeout-ms"] === undefined
      ? {}
      : { timeoutMs: Number(args["timeout-ms"]) }),
  });
  return {
    ...started,
    ...recordLaunchSafely(args.org, launchedAt, {
      via: "headless-start",
      role: command.role,
      profile: command.profile,
      provider: command.provider,
      modelRequested: command.modelRequested,
      effortRequested: command.effortRequested,
      worktreePath: cwd,
      worktreeSelector: `path:${cwd}`,
      workerId,
      workflowId: args["workflow-id"] ?? null,
      stateDir: args.state,
    }),
  };
}

// A usage report can attribute a session to a role only through this line,
// but a launch that already started must not fail because the ledger could
// not be written, so the failure travels in the result instead. The line is
// stamped with when the launch began: opening a terminal waits for the agent
// to be ready, and its session is created well before that wait ends.
function recordLaunchSafely(orgFile, launchedAt, launch) {
  try {
    const { file } = recordLaunch(
      orgFile,
      { ...launch, callerCwd: process.cwd() },
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
    "--inject-fallback takes the user's approval in words, e.g. who approved it and why",
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
      ...launchBinding(launch, {}),
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
  return {
    org: snapshot.organization,
    run: {
      ...located,
      ...(snapshot.state.roles ? { roles: snapshot.state.roles } : {}),
      workflowId: args["workflow-id"],
      stateDir,
      workflowState: snapshot.state,
    },
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
    const gates = await gateCheck(
      repo,
      task,
      readJSON(args.report),
      path.resolve(args.state),
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

function writeDraft(args) {
  const output = path.resolve(args.output);
  // A draft path that already holds a file may be the live organization, and
  // writing over it would skip the no-overwrite rule init keeps.
  assert(!fs.existsSync(output), "Draft output exists; choose a new path");
  const organization = draftOrganization({
    name: args.name,
    tiers: args.tiers === undefined ? undefined : Number(args.tiers),
    models: args.models.split(","),
  });
  writeJSON(output, organization);
  return { output, organization };
}

async function executeCommand(args) {
  switch (args.command) {
    case "org-draft":
      return writeDraft(args);
    case "init":
      return fs.existsSync(args.org)
        ? { created: false, organization: validateOrg(readJSON(args.org)) }
        : saveOrg(args.org, readJSON(args.from));
    case "edit":
      return saveOrg(args.org, readJSON(args.from), {
        update: true,
        expectedRevision: Number(args.revision),
      });
    case "preset":
      return applyPreset(args);
    case "show":
      return showOrganization(args);
    case "validate":
      return { valid: Boolean(validateOrg(readJSON(args.org))) };
    case "kickoff-claim":
      return registerKickoff(args.org, readJSON(args.from));
    case "kickoff-show":
      return listKickoffs(args.org, args.worktree);
    case "kickoff-bind":
      return bindKickoffRun(args.org, {
        worktreeId: args.worktree,
        runId: args.run,
      });
    case "deliver":
      return deliverKickoff({
        orgFile: args.org,
        worktreeId: args.worktree,
        source: args.source,
        head: args.head,
        gate: ({ source, base }) => mergeCheck({ ...args, repo: source, base }),
      });
    case "kickoff-release":
      return releaseKickoff(args.org, {
        worktreeId: args.worktree,
        reason: args.reason,
        force: Boolean(args.force),
      });
    case "prepare":
      return compatibilityPrepare(args);
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
    case "worker-start":
      return startSupervisedWorker(args);
    case "headless-start":
      return startHeadlessRole(args);
    case "headless-status":
      return waitHeadless(
        args.state,
        args.worker,
        args["wait-ms"] === undefined ? 0 : Number(args["wait-ms"]),
      );
    case "headless-answer":
      return answerHeadless(args.state, args.worker, args.text, {
        timeoutMs:
          args["timeout-ms"] === undefined
            ? undefined
            : Number(args["timeout-ms"]),
      });
    case "headless-stop":
      return stopHeadless(args.state, args.worker);
    case "headless-list":
      return listHeadless(args.state);
    case "terminal-idle-check":
      return checkTerminalIdle(args.terminal, {
        executable: args.orca,
        cwd: process.cwd(),
      });
    case "role-spec":
      return (({ org, run }) => ({
        role: args.role,
        spec: roleSpec(org, args.role, args.spec, run),
      }))(launchContext(args));
    case "role-command":
      return (({ org, run }) => roleCommand(org, args.role, run))(
        launchContext(args),
      );
    case "role-terminal":
      return (({ org, run }) => {
        const command = roleCommand(org, args.role, run);
        const target = selectedWorktreePath(args.worktree, process.cwd());
        if (target) assertNotKickoffOwner(target, `starting ${command.role}`);
        const launchedAt = new Date().toISOString();
        assertWorktreeUnshared(
          run.workflowState,
          command.role,
          args.worktree,
          process.cwd(),
        );
        return openRoleTerminal({
          worktree: args.worktree,
          command,
          title: args.title,
          executable: args.orca,
        }).then((opened) => ({
          ...opened,
          ...recordLaunchSafely(args.org, launchedAt, {
            via: "role-terminal",
            role: command.role,
            profile: command.profile,
            provider: command.provider,
            modelRequested: command.modelRequested,
            effortRequested: command.effortRequested,
            worktreePath: target,
            worktreeSelector: args.worktree,
            terminal: opened.terminal,
            workflowId: args["workflow-id"] ?? null,
            stateDir: args.state ?? null,
          }),
        }));
      })(launchContext(args));
    case "host-defaults":
      return resolveHostDefaults({
        project: args.project && path.resolve(args.project),
        codexHome: args["codex-home"] && path.resolve(args["codex-home"]),
      });
    case "usage-report":
      return reportUsage(args);
    case "supervision-next":
      return nextSupervisionAction({
        ...readJSON(args.observation),
        policy: supervisionPolicy(validateOrg(readJSON(args.org))),
      });
    case "work":
      return work(
        path.resolve(args.repo),
        readJSON(args.org),
        readJSON(args.task),
        {
          role: args.role || "intern",
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
    case "assist":
      return assist(
        path.resolve(args.repo),
        readJSON(args.org),
        readJSON(args.task),
        {
          role: args.role,
          kind: args.kind,
          stateDir: path.resolve(args.state),
          profileId: args.profile,
        },
      );
    case "verify": {
      const task = validateTask(readJSON(args.task));
      return verify(path.resolve(args.repo), {
        commands: task.checks,
        baseRef: task.baseRef,
        environment: task.environment,
        store: path.join(path.resolve(args.state), "evidence"),
      });
    }
    case "review-record":
      return recordReview(
        path.resolve(args.repo),
        validateTask(readJSON(args.task)),
        readJSON(args.report),
        readJSON(args.review),
        path.resolve(args.state),
      );
    case "gate-check":
      return gateCheck(
        path.resolve(args.repo),
        validateTask(readJSON(args.task)),
        readJSON(args.report),
        path.resolve(args.state),
      );
    case "accept":
      return acceptOutcome(
        path.resolve(args.repo),
        validateTask(readJSON(args.task)),
        readJSON(args.report),
        readJSON(args.decision),
        path.resolve(args.state),
      );
    case "workflow-create":
      return createWorkflow(
        path.resolve(args.state),
        readJSON(args.workflow),
        validateOrg(readJSON(args.org)),
        path.dirname(path.resolve(args.workflow)),
      );
    case "workflow-status":
      return readWorkflow(path.resolve(args.state), args.id).state;
    case "workflow-accept":
      return acceptWorkflowIntegration(
        path.resolve(args.state),
        args.id,
        Number(args.revision),
        args.repo && path.resolve(args.repo),
        args.report && readJSON(args.report),
      );
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
    case "workflow-depth":
      return setWorkflowDepth(
        path.resolve(args.state),
        args.id,
        Number(args.revision),
        readJSON(args.change),
      );
    case "failure-classify":
      return classifyFailure(
        withRuntimeSignal(validateFailureEvidence(readJSON(args.failure))),
      );
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
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

const BLOCKING_STATUSES = ["failed", "blocked"];

// Commands do not share one envelope: a worker report carries `status`, the
// workflow mutations wrap the new state in `{state, ...}`, and the review and
// acceptance commands report `gateStatus`. Reading only the top-level `status`
// left a settled failure and a revoked approval exiting 0, so a calling
// script saw success. Each known shape is checked explicitly.
function blockingOutcome(output) {
  if (!output || typeof output !== "object") return false;
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
