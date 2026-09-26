#!/usr/bin/env node
/** Thin CLI adapter for the oh my teams domain modules. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  chart,
  displayModel,
  definedRoles,
  readJSON,
  ROOT_ROLE,
  run as runOrcaCommand,
  saveOrg,
  supervisionPolicy,
  validateOrg,
  writeJSON,
} from "./core.mjs";
import {
  assertWorktreeUnshared,
  launchBinding,
  PERMISSION_BYPASS,
  selectedWorktreePath,
  resolveRoleLaunch,
  roleCommand,
  roleSpec,
} from "./role-launch.mjs";
import { resolveHostDefaults } from "./host-defaults.mjs";
import {
  assertNotKickoffOwner,
  deliverKickoff,
  assertDirectorAuthority,
  checkCloseReady,
} from "./delivery.mjs";
import { assertDistinctOpenCodexHomes } from "./opencodex.mjs";
import { startDashboard } from "./dashboard.mjs";
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
import { advise, assist, draft, validateTask, work } from "./worker.mjs";
import { aggregate, validateEvidence, verify } from "./evidence.mjs";
import { previewPreset } from "./presets.mjs";
import { acceptOutcome, gateCheck, recordReview } from "./gates.mjs";
import {
  checkTerminalIdle,
  createWorktree,
  discoverOrcaRuntime,
  injectTask,
  runOrcaJson,
  selectOrcaExecutable,
  startWorker,
  waitForSupervisionMessage,
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
  handoffTask,
  reworkTask,
  setWorkflowDepth,
  increaseCallAllowance,
  reopenTask,
  extendIntegrationChecks,
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
import { nextSupervisionAction, organizationStatus } from "./status.mjs";
import {
  shadowAutoObserve,
  shadowFailureFallback,
  shadowModelCheck,
  shadowStatusFilter,
} from "./jev.mjs";
import { draftOrganization } from "./org-draft.mjs";
import {
  bindKickoffRun,
  cleanupKickoffBranches,
  listKickoffs,
  ownerProject,
  recordDelivery,
  registerKickoff,
  releaseKickoff,
} from "./kickoff-registry.mjs";
import {
  readLaunches,
  recordLaunch,
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
  acknowledgeSignal,
  listInbox,
  notifyDirectorSignal,
  readSignal,
  replySignal,
  sendSignal,
  SIGNAL_KINDS,
} from "./director.mjs";
import {
  acquireResource,
  directorWatch,
  releaseResource,
  RESOURCE_KINDS,
} from "./resources.mjs";

const HELP = `oh my teams organization runtime on Orca (Node >=22)
  org-draft --name NAME --models provider:model,... --output FILE [--tiers 1-4]
  init --org FILE --from CONFIG
  edit --org FILE --from CONFIG --revision N
  preset --org FILE --name opus-first|balanced|single-subscription|advisor-codex|advisor-claude --revision N
         [--apply]
  show --org FILE [--state DIR] [--json]
  validate --org FILE
  kickoff-claim --org FILE --from CLAIM
  kickoff-show --org FILE [--worktree ID]
  kickoff-bind --org FILE --worktree ID --run ID
  kickoff-release --org FILE --worktree ID
                  --reason completed|disbanded|taken-over [--force]
                  (also closes that kickoff's pending director signals)
  kickoff-branch-cleanup --org FILE --worktree ID
                         --branches BRANCH[,BRANCH...] [--remote NAME]
                         (verifies delivery then deletes remote, local, and
                         reclaimed sub-worktree branches; close only, not disband)
  kickoff-check-close-ready --org FILE --worktree ID --head SHA
                         (checks that the PM's close-ready signal exists and
                         matches HEAD; for pull-request kickoffs before PR merge)
  kickoff-merge-record --org FILE --worktree ID --head SHA --merge-commit SHA
                       [--remote NAME]
                         (records a PR merge into the registry; director only;
                         rejects a merge commit that is not reachable from
                         the delivery branch or does not contain --head;
                         enables kickoff-branch-cleanup for pull-request kickoffs)
  deliver --org FILE --worktree ID --source DIR --head SHA
          --evidence FILE --task TRUSTED_TASK [--report FILE --state DIR]
          (merges a verified kickoff result into the branch its claim recorded;
          run by the director in close)
  prepare --org FILE --task FILE --repo DIR --name NAME [--orca EXECUTABLE]
  prepare-input --org FILE --task FILE --repo DIR --output DIR
  prepare-verify --input DIR
  attach-workspace --org FILE --task FILE --repo DIR --workspace DIR
                   --receipt FILE --runtime FILE --state DIR --name NAME
                   [--orca EXECUTABLE]
  runtime-discover [--orca EXECUTABLE]
  runtime-doctor --org FILE --state DIR [--format json]
  runtime-install --org FILE --state DIR [--dry-run]
  runtime-repair --org FILE --state DIR [--dry-run]
  runtime-prune --org FILE --state DIR [--dry-run]
                (removes failed runtime directories and stale staging directories;
                preserves active runtimes and paths outside the ownership prefix)
  worker-start --org FILE --role ROLE --repo DIR (--spec TEXT | --task ID)
               --terminal HANDLE [--worktree SELECTOR] [--run ID]
               [--retry-of ID] [--title TEXT] [--workflow-id ID --state DIR]
               [--workflow-task ID] [--purpose implement|review]
               [--inject-fallback "USER APPROVAL"] [--profile FALLBACK]
               [--orca EXECUTABLE]
               (with --workflow-id, the workflow's organization snapshot is used;
               --profile runs the fallback a workflow-handoff recorded for
               --workflow-task;
               the terminal comes from role-terminal; the worker's tab title
               starts with its role tag, e.g. [PL]; a Claude terminal that
               last received a different task, or any review, gets /clear first)
  headless-start --org FILE --role ROLE --cwd DIR --spec TEXT --state DIR
                 [--workflow-id ID] [--timeout-ms N] [--worker ID]
                 [--workflow-task ID --profile FALLBACK]
                 (runs the role as a non-interactive process, without Orca;
                 --profile runs the fallback a workflow-handoff recorded)
  headless-status --state DIR --worker ID [--wait-ms N]
  headless-answer --state DIR --worker ID --text TEXT [--timeout-ms N]
  headless-stop --state DIR --worker ID
  headless-list --state DIR
  dashboard --state DIR [--port N] [--host ADDRESS] [--token TEXT]
            (serves the headless workers to a browser; every request needs the token)
  terminal-idle-check --terminal HANDLE [--orca EXECUTABLE]
               (run before workflow-reserve for a reused terminal)
  prompt-answer --org FILE --terminal HANDLE --workflow-id ID --state DIR
                [--role ROLE] [--orca EXECUTABLE]
                (the role's supervisor answers the question that stopped its terminal:
                only the Run-bound PM, or the PL that started the role; one key per
                screen state, then the screen is read again; every attempt is recorded
                in <state>/prompt-answers.jsonl. status: resolved | advanced |
                unresolved | redirected | escalate | no-question | refused)
  worker-limit-check --worktree DIR --provider claude|codex|agy
                     [--workflow-id ID --workflow-task ID]
                     [--terminal HANDLE] [--orca EXECUTABLE]
                     (reads the provider's session log for the worker; the
                     screen of --terminal is read only when no log is found;
                     Agy needs the workflow task to find its log)
  role-spec --org FILE --role ROLE --spec TEXT [--workflow-id ID --state DIR]
            [--workflow-task ID] [--text]
  role-command --org FILE --role ROLE [--workflow-id ID --state DIR]
  role-terminal --org FILE --role ROLE --worktree SELECTOR [--title TEXT]
                [--workflow-id ID --state DIR] [--orca EXECUTABLE]
                [--allow-unverified "APPROVAL SENTENCE"]
                [--workflow-task ID --profile FALLBACK]
                (--profile opens the fallback a workflow-handoff recorded)
                (the tab title is the role tag, e.g. [PM], then TEXT or the worktree)
  host-defaults [--project DIR] [--codex-home DIR]
  usage-report --org FILE [--worktree ID | --all] [--state DIR]
               [--place ROLE=DIR ...] [--claude-home DIR] [--codex-home DIR]
               [--agy-home DIR] [--write] [--json]
               (per-role turns and tokens from provider session records, read-only;
               --write stores the report in <project>/.omt/history)
  supervision-next --org FILE --observation FILE
                   [--dispatch ID --state DIR] [--orca EXECUTABLE]
                   (dispatch and state only feed an experimental Jev shadow judgment)
  supervision-wait --run ID (--org FILE | --timeout-ms N) [--ack DELIVERY]
                   [--orca EXECUTABLE] [--state DIR]
                   (waits on the Run's coordinator mailbox until a message other
                   than a heartbeat arrives; heartbeat-only deliveries are
                   acknowledged here; the timeout defaults to the organization's
                   policy.supervision.progressCheckMs; pass the returned
                   deliveryId as --ack on the next wait)
  work --org SNAPSHOT --task FILE --repo WORKTREE --state SHARED_DIR [--role junior]
       [--workflow-id ID --attempt-id ID]
  draft --org FILE --task FILE --repo DIR [--kind citations|checklist]
  assist --org FILE --task FILE --repo DIR --state DIR --role ROLE
         --kind research|checklist|edit [--profile PROFILE]
  advise --org FILE --brief FILE --repo DIR --state DIR --role ROLE
         --kind plan|design|review|unblock [--profile PROFILE]
         (read-only advisor call; spends one slot of policy.adviceBudget)
  verify --task FILE --repo DIR --state DIR [--timeout-ms N]
        (per-command timeout; default 300000, max 1800000; recorded in the
        evidence fingerprint so differing timeouts never share a cache entry)
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
  workflow-handoff --id ID --state DIR --revision N --handoff FILE
                   (hands a usage-limited task to a fallback profile in the
                   same worktree; writes snapshot-<n>.json)
  workflow-rework --id ID --state DIR --revision N --rework FILE
                  (attaches the corrected execution after a review asked for changes)
  workflow-depth --id ID --state DIR --revision N --change FILE
  workflow-allowance --id ID --state DIR --revision N --allowance FILE
                     (raises the callAllowance of a reserved or running attempt;
                     the increase must fit inside the workflow's unreserved
                     call budget)
  workflow-reopen --id ID --state DIR --revision N --reopen FILE
                  (manually reopens a submitted or reviewed task by opening a
                  new attempt; requires approver and reason, spends budget)
  workflow-integration-checks --id ID --state DIR --revision N --checks FILE
                              (appends checks to an already-frozen, not yet
                              accepted integration task without touching the
                              existing ones)
  handoff-checkpoint --state DIR --workflow-id ID --workflow-task ID --file FILE
                     [--repo DIR]
                     (validates the checkpoint sections and records HEAD of
                     --repo, default the current directory)
  failure-classify --failure FILE [--org FILE --state DIR]
  lesson-record --lesson FILE --state DIR
  incident-ingest --event FILE --config FILE --state DIR
  incident-observe --observation FILE --config FILE --state DIR
  incident-status --state DIR
  quota-record --snapshot FILE --state DIR
  quota-compare --before FILE --after FILE
  aggregate --expected id,id --report FILE [--report FILE ...]
  director-signal --org FILE --worktree ID --kind decision|close-ready|blocked|progress
                  --text TEXT [--head SHA --source DIR] [--orca EXECUTABLE]
                  (writes a structured record to .omt/director/inbox/; notifies
                  the director terminal when the registry entry names one. The
                  notification is skipped without sending a key when the
                  director's screen shows a selection window or a trust
                  question, or cannot be read at all; any earlier signal still
                  undelivered for the same worktree is bundled into the same
                  message, and a signal marked delivered is never sent again)
  director-inbox --org FILE
                 (lists pending signals; progress signals are stored
                 acknowledged, and a newer close-ready supersedes an older one)
  director-reply --org FILE --signal ID --text TEXT [--orca EXECUTABLE]
                 (records the director's decision and attempts PM notification)
  director-ack --org FILE --signal ID
               (marks a signal as acknowledged without a text reply)
  resource-acquire --org FILE --worktree ID --kind test|worker|build [--note TEXT] [--owner-pid PID]
                   (acquires a resource slot; --owner-pid names the long-lived owner process, omitted the owner is unknown and the slot is only freed by resource-release)
  resource-release --org FILE --slot ID
                   (releases an acquired resource slot)
  director-watch --org FILE [--orca EXECUTABLE]
                 (shows pending signals, slot usage, free memory, and PM liveness per kickoff)

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
  "kickoff-branch-cleanup": ["org", "worktree", "branches", "remote", "force"],
  "kickoff-check-close-ready": ["org", "worktree", "head"],
  "kickoff-merge-record": [
    "org",
    "worktree",
    "head",
    "merge-commit",
    "remote",
    "force",
  ],
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
  "runtime-doctor": ["org", "state", "format"],
  "runtime-install": ["org", "state", "dry-run"],
  "runtime-repair": ["org", "state", "dry-run"],
  "runtime-prune": ["org", "state", "dry-run"],
  "role-spec": [
    "org",
    "role",
    "spec",
    "workflow-id",
    "state",
    "workflow-task",
    "text",
  ],
  "terminal-idle-check": ["terminal", "orca", "org", "role"],
  "prompt-answer": ["org", "terminal", "workflow-id", "state", "role", "orca"],
  "worker-limit-check": [
    "worktree",
    "provider",
    "workflow-id",
    "workflow-task",
    "terminal",
    "orca",
  ],
  "headless-start": [
    "org",
    "role",
    "cwd",
    "spec",
    "state",
    "workflow-id",
    "workflow-task",
    "profile",
    "timeout-ms",
    "worker",
  ],
  "headless-status": ["state", "worker", "wait-ms"],
  "headless-answer": ["state", "worker", "text", "timeout-ms"],
  "headless-stop": ["state", "worker"],
  "headless-list": ["state"],
  dashboard: ["state", "port", "host", "token"],
  "role-command": ["org", "role", "workflow-id", "state"],
  "role-terminal": [
    "org",
    "role",
    "worktree",
    "title",
    "workflow-id",
    "workflow-task",
    "profile",
    "state",
    "orca",
    "allow-unverified",
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
  "supervision-next": ["org", "observation", "dispatch", "state", "orca"],
  "supervision-wait": ["run", "org", "timeout-ms", "ack", "orca", "state"],
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
    "profile",
    "workflow-id",
    "workflow-task",
    "purpose",
    "state",
    "orca",
  ],
  work: ["org", "task", "repo", "state", "role", "workflow-id", "attempt-id"],
  draft: ["org", "task", "repo", "kind"],
  assist: ["org", "task", "repo", "state", "role", "kind", "profile"],
  advise: ["org", "brief", "repo", "state", "role", "kind", "profile"],
  verify: ["task", "repo", "state", "timeout-ms"],
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
  "workflow-handoff": ["id", "state", "revision", "handoff"],
  "workflow-rework": ["id", "state", "revision", "rework"],
  "workflow-depth": ["id", "state", "revision", "change"],
  "workflow-allowance": ["id", "state", "revision", "allowance"],
  "workflow-reopen": ["id", "state", "revision", "reopen"],
  "workflow-integration-checks": ["id", "state", "revision", "checks"],
  "handoff-checkpoint": [
    "state",
    "workflow-id",
    "workflow-task",
    "file",
    "repo",
  ],
  "failure-classify": ["failure", "org", "state"],
  "lesson-record": ["lesson", "state"],
  "incident-ingest": ["event", "config", "state"],
  "incident-observe": ["observation", "config", "state"],
  "incident-status": ["state"],
  "quota-record": ["snapshot", "state"],
  "quota-compare": ["before", "after"],
  "director-signal": [
    "org",
    "worktree",
    "kind",
    "text",
    "head",
    "source",
    "orca",
  ],
  "director-inbox": ["org"],
  "director-reply": ["org", "signal", "text", "orca"],
  "director-ack": ["org", "signal"],
  "resource-acquire": ["org", "worktree", "kind", "note", "owner-pid"],
  "resource-release": ["org", "slot"],
  "director-watch": ["org", "orca"],
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
  "kickoff-branch-cleanup": ["org", "worktree", "branches"],
  "kickoff-check-close-ready": ["org", "worktree", "head"],
  "kickoff-merge-record": ["org", "worktree", "head", "merge-commit"],
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
  "runtime-doctor": ["org", "state"],
  "runtime-install": ["org", "state"],
  "runtime-repair": ["org", "state"],
  "runtime-prune": ["org", "state"],
  "worker-start": ["org", "role", "repo"],
  "role-spec": ["org", "role", "spec"],
  "terminal-idle-check": ["terminal"],
  "prompt-answer": ["org", "terminal", "workflow-id", "state"],
  "worker-limit-check": ["worktree", "provider"],
  "headless-start": ["org", "role", "cwd", "spec", "state"],
  "headless-status": ["state", "worker"],
  "headless-answer": ["state", "worker", "text"],
  "headless-stop": ["state", "worker"],
  "headless-list": ["state"],
  dashboard: ["state"],
  "role-command": ["org", "role"],
  "role-terminal": ["org", "role", "worktree"],
  "host-defaults": [],
  "usage-report": ["org"],
  "supervision-next": ["org", "observation"],
  "supervision-wait": ["run"],
  work: ["org", "task", "repo", "state"],
  draft: ["org", "task", "repo"],
  assist: ["org", "task", "repo", "state", "role", "kind"],
  advise: ["org", "brief", "repo", "state", "role", "kind"],
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
  "workflow-handoff": ["id", "state", "revision", "handoff"],
  "workflow-rework": ["id", "state", "revision", "rework"],
  "workflow-depth": ["id", "state", "revision", "change"],
  "workflow-allowance": ["id", "state", "revision", "allowance"],
  "workflow-reopen": ["id", "state", "revision", "reopen"],
  "workflow-integration-checks": ["id", "state", "revision", "checks"],
  "handoff-checkpoint": ["state", "workflow-id", "workflow-task", "file"],
  "failure-classify": ["failure"],
  "lesson-record": ["lesson", "state"],
  "incident-ingest": ["event", "config", "state"],
  "incident-observe": ["observation", "config", "state"],
  "incident-status": ["state"],
  "quota-record": ["snapshot", "state"],
  "quota-compare": ["before", "after"],
  "director-signal": ["org", "worktree", "kind", "text"],
  "director-inbox": ["org"],
  "director-reply": ["org", "signal", "text"],
  "director-ack": ["org", "signal"],
  "resource-acquire": ["org", "worktree", "kind"],
  "resource-release": ["org", "slot"],
  "director-watch": ["org"],
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
      ["json", "apply", "force", "all", "write", "dry-run"].includes(option) ||
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

  if (args.json) {
    const orgOutput = structuredClone(org);
    for (const profile of Object.values(orgOutput.profiles)) {
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

// A role run as a non-interactive process gets the same checks a terminal
// launch does: its profile, whether this run holds the role, the owner
// checkout, and another role's worktree. The instruction carries the role's
// charter and the headless protocol, since no one answers a prompt.
function startHeadlessRole(args) {
  assert(
    args.profile === undefined || args["workflow-id"],
    "--profile requires --workflow-id, --state and --workflow-task",
  );
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
  // One run's runner accounts must not share a session home or use an account
  // home as one; the run's other roles are checked with this one.
  if (command.runner) {
    assertDistinctOpenCodexHomes(
      (run.roles ?? Object.keys(org.roles)).map(
        (name) => org.profiles[org.roles[name]?.profile],
      ),
    );
  }
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
    runner: command.runner ?? null,
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
      ...run.handoff,
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

// The wait is the progress-check interval: when it ends without a message the
// supervisor runs the stall checks in references/orca-runtime.md.
function supervisionWaitTimeout(args) {
  if (args["timeout-ms"] !== undefined) {
    const value = Number(args["timeout-ms"]);
    assert(
      Number.isInteger(value) && value > 0,
      "--timeout-ms must be a positive integer",
    );
    return value;
  }
  assert(args.org, "--org or --timeout-ms required");
  return supervisionPolicy(validateOrg(readJSON(args.org))).progressCheckMs;
}

async function writeDraft(args) {
  const output = path.resolve(args.output);
  // A draft path that already holds a file may be the live organization, and
  // writing over it would skip the no-overwrite rule init keeps.
  assert(!fs.existsSync(output), "Draft output exists; choose a new path");
  const organization = draftOrganization({
    name: args.name,
    tiers: args.tiers === undefined ? undefined : Number(args.tiers),
    models: args.models.split(","),
  });
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
  for (const profile of Object.values(organization.profiles)) {
    if (profile.model === null) {
      profile.modelResolvedAtFormation =
        defaults[profile.provider]?.model ?? null;
    }
  }
  writeJSON(output, organization);
  return { output, organization };
}

async function executeCommand(args) {
  switch (args.command) {
    case "org-draft":
      return await writeDraft(args);
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
    case "kickoff-show": {
      const result = listKickoffs(args.org, args.worktree);
      for (const k of result.kickoffs) {
        k.pm.modelDisplay = displayModel(k.pm.provider, k.pm.model);
      }
      return result;
    }
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
      });
    }
    case "kickoff-check-close-ready":
      return checkCloseReady({
        orgFile: args.org,
        worktreeId: args.worktree,
        head: args.head,
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
    case "dashboard": {
      // The server keeps the process running; only where to open it is printed.
      const started = await startDashboard({
        stateDir: path.resolve(args.state),
        port: args.port === undefined ? 4812 : Number(args.port),
        host: args.host ?? "0.0.0.0",
        token: args.token,
      });
      return {
        listening: `${started.host}:${started.port}`,
        local: `http://127.0.0.1:${started.port}${started.path}`,
        path: started.path,
        token: started.token,
      };
    }
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
        "An explicit OpenCodex runner is supported by headless-start only; role-command would print a native Codex command that bypasses it",
      );
      return command;
    }
    case "role-terminal": {
      assert(
        args.profile === undefined || args["workflow-id"],
        "--profile requires --workflow-id, --state and --workflow-task",
      );
      const { org, run: runCtx } = launchContext(args);
      const command = roleCommand(org, args.role, runCtx);
      assert(
        !command.runner,
        "An explicit OpenCodex runner is supported by headless-start only; role-terminal cannot run it as native Codex",
      );
      const target = selectedWorktreePath(args.worktree, process.cwd());
      if (target) assertNotKickoffOwner(target, `starting ${command.role}`);
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
      // 실제 환경에서 매트릭스 입력값을 읽습니다.
      // 알 수 없는 값은 'unknown'으로 전달하여 표가 unverified로 처리합니다.
      const env = await readLaunchEnvironment({
        worktreePath: target ?? undefined,
        orcaExecutable: args.orca,
      });
      const opened = await openRoleTerminal({
        worktree: args.worktree,
        command,
        title: args.title,
        executable: args.orca,
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
      if (args.state)
        await shadowModelCheck({
          org,
          stateDir: path.resolve(args.state),
          opened,
        });
      const drift = await resolveAndCheckDrift(args.org, org, command);
      const warnings = [...(opened.warnings || []), ...drift.warnings];
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
          ...runCtx.handoff,
        }),
      };
    }
    case "host-defaults":
      return resolveHostDefaults({
        project: args.project && path.resolve(args.project),
        codexHome: args["codex-home"] && path.resolve(args["codex-home"]),
      });
    case "usage-report":
      return reportUsage(args);
    case "supervision-next": {
      const org = validateOrg(readJSON(args.org));
      const observation = readJSON(args.observation);
      const decision = nextSupervisionAction({
        ...observation,
        policy: supervisionPolicy(org),
      });
      if (args.state && args.dispatch)
        await shadowAutoObserve({
          org,
          stateDir: path.resolve(args.state),
          dispatchId: args.dispatch,
          decision,
          liveness: observation.liveness,
          readOutput: (dispatchId) =>
            runOrcaJson(
              selectOrcaExecutable(args.orca),
              [
                "orchestration",
                "worker-read",
                "--dispatch",
                dispatchId,
                "--source",
                "auto",
                "--limit",
                "60",
              ],
              { cwd: process.cwd(), timeoutMs: 15000 },
            ),
        });
      return decision;
    }
    case "supervision-wait": {
      const delivery = await waitForSupervisionMessage({
        runId: args.run,
        timeoutMs: supervisionWaitTimeout(args),
        ack: args.ack,
        executable: args.orca,
        cwd: process.cwd(),
      });
      if (args.state && args.org)
        await shadowStatusFilter({
          org: validateOrg(readJSON(args.org)),
          stateDir: path.resolve(args.state),
          delivery,
        });
      return delivery;
    }
    case "work":
      return work(
        path.resolve(args.repo),
        readJSON(args.org),
        readJSON(args.task),
        {
          role: args.role || "junior",
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
      const { signaled, id, entry, record } = sendSignal(args.org, {
        worktreeId: args.worktree,
        kind: args.kind,
        text: args.text,
        head: args.head,
        source: args.source,
      });
      const notification = await notifyDirectorSignal(
        args.org,
        entry,
        record,
        args.orca,
      );
      return { signaled, id, ...notification };
    }
    case "director-inbox":
      return listInbox(args.org);
    case "director-reply":
      return replySignal(args.org, {
        signalId: args.signal,
        text: args.text,
        orcaExecutable: args.orca,
      });
    case "director-ack":
      return acknowledgeSignal(args.org, args.signal);
    case "resource-acquire":
      return acquireResource(args.org, {
        worktreeId: args.worktree,
        kind: args.kind,
        note: args.note,
        ownerPid: args["owner-pid"] ? Number(args["owner-pid"]) : undefined,
      });
    case "resource-release":
      return releaseResource(args.org, args.slot);
    case "director-watch": {
      const watch = await directorWatch(args.org, {
        orcaExecutable: args.orca,
      });
      const { kickoffs } = listKickoffs(args.org);
      for (const summary of watch.kickoffs) {
        const entry = kickoffs.find(
          (k) => k.pm.worktreeId === summary.worktreeId,
        );
        if (entry) {
          summary.pmModelDisplay = displayModel(
            entry.pm.provider,
            entry.pm.model,
          );
        }
      }
      return watch;
    }
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
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
function blockingOutcome(output) {
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
