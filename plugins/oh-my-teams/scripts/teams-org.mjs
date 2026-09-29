#!/usr/bin/env node
/** Thin CLI adapter for the oh my teams domain modules. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  canonicalRole,
  chart,
  displayModel,
  definedRoles,
  migrateLegacyOrg,
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
import { advise, assist, draft, validateTask, work } from "./worker.mjs";
import {
  aggregate,
  git as gitEvidence,
  validateEvidence,
  verify,
} from "./evidence.mjs";
import { previewPreset } from "./presets.mjs";
import { acceptOutcome, gateCheck, recordReview } from "./gates.mjs";
import {
  checkTerminalIdle,
  createWorktreeWithRoleSession,
  discoverOrcaRuntime,
  findActiveDispatch,
  injectTask,
  reclaimWorktree,
  releaseWorker,
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
  prepareRolePromotion,
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
import { draftOrganization, draftThreeTierOrganization } from "./org-draft.mjs";
import {
  bindKickoffRun,
  classifyKickoffEntry,
  cleanupKickoffBranches,
  kickoffHashFor,
  listKickoffs,
  ownerProject,
  reassignDirector,
  recordDelivery,
  registerKickoff,
  releaseKickoff,
  verifyHandoffClaim,
} from "./kickoff-registry.mjs";
import {
  buildDocId,
  buildDocRef,
  documentState,
  parseDocId,
  resolveKickoffHash,
  saveDocument,
  stageFolderName,
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
  org-draft --name NAME --models PM,WORKER --output FILE [--tiers 1-4 (legacy)]
            (four model choices without --tiers retain the previous format)
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
  role-worktree-create --org FILE --role ROLE --repo DIR --name NAME --base SHA
                        [--setup inherit|run|skip] [--title TEXT] [--brief FILE]
                        [--workflow-id ID --state DIR --workflow-task ID]
                        [--prior-workflow-id ID --prior-task-id ID]
                        [--worktree WORKTREE_ID] [--profile FALLBACK] [--orca EXECUTABLE]
                        (creates a child only while opening and proving its Orca role session;
                        reuses a proven idle same-role worktree only after prior acceptance,
                        integration, Dispatch release, terminal closure, and Git-clean proof;
                        cross-workflow reuse requires the explicit accepted prior pair;
                        a proven no-session launch is reclaimed, an ambiguous launch is preserved)
  role-worktree-reclaim --org FILE --state DIR --workflow-id ID --workflow-task ID
                        --repo DIR --worktree ID --merge-commit SHA [--orca EXECUTABLE]
                        (reclaims an accepted and integrated child only after every related
                        Dispatch is released, every owned terminal is closed, no other terminal
                        remains, its commit is preserved by --merge-commit, and Git is clean)
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
  model-catalog [--codex-home DIR]
               (queries claude, codex and agy for the model catalog each
               currently offers; a provider that cannot be read comes back
               unavailable with a reason instead of a stale or default model)
  model-catalog-revalidate --selections FILE [--codex-home DIR]
               (verification-only: re-fetches the catalog and checks each
               selection in FILE against it, without saving anything)
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
  work --org SNAPSHOT --task FILE --repo WORKTREE --state SHARED_DIR [--role worker]
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
              [--report FILE --state DIR] [--org FILE] [--workflow-id ID]
  review-record --task FILE --report FILE --review FILE --repo DIR --state DIR
                [--org FILE] [--workflow-id ID]
  gate-check --task FILE --report FILE --repo DIR --state DIR
             [--org FILE] [--workflow-id ID]
  accept --task FILE --report FILE --decision FILE --repo DIR --state DIR
         [--org FILE] [--workflow-id ID]
         (--org resolves the state's kickoff entry to a current/legacy/
         integrity-failure judgement per structured-omt-documents.md 3.7 item 5;
         current forwards kickoffHash [and --workflow-id, if given] to the
         document ownership checks in gates.mjs, legacy omits both, and
         integrity-failure or an unresolvable entry refuses the command)
  doc-resolve-kickoff --org FILE --worktree ID
                      (resolveKickoffHash for the worktree's active kickoff)
  doc-id --kickoff-hash HASH --stage STAGE --doc-type TYPE --local-id ID
         [--workflow-id ID] [--revision N]
         (builds a docId, and a docRef when --revision is given)
  doc-show --state DIR --doc-id ID
           (documentState plus the document's real filesystem location)
  doc-save --state DIR --doc FILE [--expected-revision N] [--refs REF[,REF...]]
           [--org FILE]
           (--org is read only when doc.workflowId is unset, to resolve this
           run's role roster for the PM design/design-contract roster
           condition in structured-omt-documents.md 3.4.2; when workflowId is
           set the workflow snapshot's state.roles, or its organization when
           state.roles is absent, is used instead and --org is ignored)
  workflow-create --workflow FILE --org FILE --state DIR
  workflow-status --id ID --state DIR
  workflow-resume --id ID --state DIR --revision N [--observations FILE]
  workflow-attach --id ID --state DIR --revision N --execution FILE
  workflow-reserve --id ID --state DIR --revision N --execution FILE
  workflow-accept --id ID --state DIR --revision N [--repo DIR --report FILE]
                  [--org FILE]
                  (repo and report only when the workflow requires integration;
                  --org applies the same current/legacy/integrity-failure
                  judgement as accept, forwarding only kickoffHash since this
                  case's own --id is already the workflowId gates.mjs receives)
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
  workflow-budget --id ID --state DIR --revision N --change FILE
                  (raises state.budget.maxAttempts with a recorded approval;
                  the new limit must exceed the current maxAttempts and must
                  not sit below attemptsUsed; maxCalls, attemptsUsed,
                  callsUsed, policy and task state are unaffected)
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
  director-command --org FILE (--profile ID | --provider claude|codex|agy [--model NAME] [--effort LEVEL])
                   [--brief FILE]
                   (prints the command a director session opens with; the director is
                   the host session, not a role, so it takes a profile or an explicit provider)
  director-terminal --org FILE (--profile ID | --provider claude|codex|agy [--model NAME] [--effort LEVEL])
                    [--brief FILE] [--checkout DIR] [--from-terminal HANDLE] [--title TEXT]
                    [--replace HANDLE] [--orca EXECUTABLE]
                    (opens that command in a terminal the user can see: a vertical split of
                    --from-terminal, by default the calling terminal from ORCA_TERMINAL_HANDLE,
                    or a new tab in --checkout (default: the organization's project) when no
                    terminal is given; a terminal Orca's UI does not adopt is closed and refused;
                    --replace moves every kickoff that names that director terminal to the new one)

Existing organizations are reused; init never asks for subscriptions again.
No command automatically pushes, merges, deploys, publishes, or deletes.`;

/** Options each subcommand accepts, keyed by command name. */
export const ALLOWED_OPTIONS = {
  "org-draft": ["name", "tiers", "models", "output", "codex-home"],
  init: ["org", "from", "codex-home", "host-default"],
  edit: ["org", "from", "revision", "codex-home", "host-default"],
  preset: ["org", "name", "revision", "apply", "codex-home"],
  show: ["org", "state", "json"],
  validate: ["org"],
  "kickoff-claim": ["org", "from"],
  "kickoff-show": ["org", "worktree"],
  "kickoff-handoff-verify": ["org", "worktree", "director-terminal", "brief"],
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
  "role-worktree-create": [
    "org",
    "role",
    "repo",
    "name",
    "base",
    "setup",
    "title",
    "brief",
    "workflow-id",
    "state",
    "workflow-task",
    "prior-workflow-id",
    "prior-task-id",
    "profile",
    "worktree",
    "orca",
  ],
  "role-worktree-reclaim": [
    "org",
    "state",
    "workflow-id",
    "workflow-task",
    "repo",
    "worktree",
    "merge-commit",
    "orca",
  ],
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
    "brief",
  ],
  "host-defaults": ["project", "codex-home"],
  "model-catalog": ["codex-home"],
  "model-catalog-revalidate": ["selections", "codex-home"],
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
  "merge-check": [
    "evidence",
    "task",
    "repo",
    "base",
    "report",
    "state",
    "org",
    "workflow-id",
  ],
  aggregate: ["expected", "report"],
  "review-record": [
    "task",
    "report",
    "review",
    "repo",
    "state",
    "org",
    "workflow-id",
  ],
  "gate-check": ["task", "report", "repo", "state", "org", "workflow-id"],
  accept: ["task", "report", "decision", "repo", "state", "org", "workflow-id"],
  "doc-resolve-kickoff": ["org", "worktree"],
  "doc-id": [
    "kickoff-hash",
    "workflow-id",
    "stage",
    "doc-type",
    "local-id",
    "revision",
  ],
  "doc-show": ["state", "doc-id"],
  "doc-save": ["state", "doc", "expected-revision", "refs", "org"],
  "workflow-create": ["workflow", "org", "state"],
  "workflow-status": ["id", "state"],
  "workflow-resume": ["id", "state", "revision", "observations"],
  "workflow-attach": ["id", "state", "revision", "execution"],
  "workflow-reserve": ["id", "state", "revision", "execution"],
  "workflow-accept": ["id", "state", "revision", "repo", "report", "org"],
  "workflow-settle": ["id", "state", "revision", "settlement"],
  "workflow-release": ["id", "state", "revision", "release"],
  "workflow-retry": ["id", "state", "revision", "retry"],
  "workflow-handoff": ["id", "state", "revision", "handoff"],
  "workflow-rework": ["id", "state", "revision", "rework"],
  "workflow-depth": ["id", "state", "revision", "change"],
  "workflow-allowance": ["id", "state", "revision", "allowance"],
  "workflow-budget": ["id", "state", "revision", "change"],
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
  "director-command": [
    "org",
    "profile",
    "provider",
    "model",
    "effort",
    "brief",
  ],
  "director-terminal": [
    "org",
    "profile",
    "provider",
    "model",
    "effort",
    "brief",
    "checkout",
    "from-terminal",
    "title",
    "replace",
    "orca",
  ],
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
  "kickoff-handoff-verify": ["org", "worktree", "director-terminal", "brief"],
  "kickoff-bind": ["org", "worktree", "run"],
  "kickoff-release": ["org", "worktree", "reason"],
  "kickoff-branch-cleanup": ["org", "worktree", "branches"],
  "kickoff-check-close-ready": ["org", "worktree", "head"],
  "kickoff-merge-record": ["org", "worktree", "head", "merge-commit"],
  deliver: ["org", "worktree", "source", "head", "evidence", "task"],
  prepare: ["org", "task", "repo", "name"],
  "role-worktree-create": ["org", "role", "repo", "name", "base"],
  "role-worktree-reclaim": [
    "org",
    "state",
    "workflow-id",
    "workflow-task",
    "repo",
    "worktree",
    "merge-commit",
  ],
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
  "role-command": ["org", "role"],
  "role-terminal": ["org", "role", "worktree"],
  "host-defaults": [],
  "model-catalog": [],
  "model-catalog-revalidate": ["selections"],
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
  "doc-resolve-kickoff": ["org", "worktree"],
  "doc-id": ["kickoff-hash", "stage", "doc-type", "local-id"],
  "doc-show": ["state", "doc-id"],
  "doc-save": ["state", "doc"],
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
  "workflow-budget": ["id", "state", "revision", "change"],
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
  "director-command": ["org"],
  "director-terminal": ["org"],
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
    // `--text` is a flag only for role-spec.
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

/** Parses the comma-separated `--host-default` flag into a profile id list. */
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
  return {
    ...prepared,
    stateDir,
    note:
      "Compatibility prepare only writes the frozen input. Run role-worktree-create " +
      "to create or safely reuse the child with a proven Orca role session, then attach-workspace.",
  };
}

async function preflightRoleWorktree(args, organization, environment, matrix) {
  const command = roleCommand(organization, args.role, {
    profile: args.profile,
  });
  const worktreePath = args.worktree
    ? pathFromWorktreeId(args.worktree)
    : undefined;
  const env = await environment({
    worktreePath,
    orcaExecutable: args.orca,
  });
  const prediction = matrix({
    runner: command.provider,
    model: command.modelRequested,
    platform: env.platform,
    shell: env.shell,
    trustRecordExists: env.trustRecordExists,
    codexTrustRecordExists: env.codexTrustRecordExists,
    skipDangerousModePermissionPrompt: Boolean(
      PERMISSION_BYPASS[command.provider],
    ),
    orcaVersion: env.orcaVersion,
    cliVersion: env.cliVersion,
    isCompoundCommand: false,
  });
  assert(
    prediction.path !== "blocked",
    `Role ${args.role} is refused by the launch matrix before worktree creation: ${prediction.reason.join(", ")}. ${prediction.nextAction}`,
  );
  return { command, prediction };
}

function trustedTaskExecutionRole(task) {
  if (typeof task?.executionRole !== "string") return null;
  if (task.executionRole === task.role) return task.executionRole;
  const transition = (task.worktreeTransitions ?? []).find(
    (entry) =>
      entry?.id === task.execution?.transitionId &&
      entry.kind === "junior-to-senior" &&
      entry.fromRole === task.role &&
      entry.toRole === task.executionRole &&
      entry.toWorktreeId === task.worktreeId &&
      entry.usedAt &&
      task.execution?.executionRole === task.executionRole,
  );
  return transition ? task.executionRole : null;
}

function receiptBody(receipt) {
  return receipt?.result ?? receipt ?? {};
}

function assertReleasedReceipt(receipt, dispatchId) {
  const release = receiptBody(receipt);
  const evidence = JSON.stringify(release);
  assert(
    release.dispatchId === dispatchId &&
      release.state === "retained" &&
      release.reason === "external_terminal" &&
      release.processAction === "none" &&
      !evidence.includes("terminal_stop_unverifiable") &&
      !evidence.includes("terminalStopUnverifiable"),
    `Dispatch ${dispatchId} was not conclusively released as an external terminal; preserve its worktree`,
  );
}

function assertClosedReceipt(receipt, terminal) {
  const body = receiptBody(receipt);
  const close = body.close;
  const evidence = JSON.stringify(body);
  const hasTabId =
    (typeof close?.tabId === "string" && close.tabId.length > 0) ||
    Number.isInteger(close?.tabId);
  assert(
    close?.handle === terminal &&
      hasTabId &&
      close.ptyKilled === true &&
      !/"ptyKilled"\s*:\s*false/.test(evidence) &&
      !evidence.includes("terminal_stop_unverifiable") &&
      !evidence.includes("terminalStopUnverifiable"),
    `Terminal ${terminal} did not prove its own PTY termination; preserve its worktree`,
  );
}

async function listWorktreeTerminals({ repo, worktreeId, orca, list }) {
  const listed = await list(
    selectOrcaExecutable(orca),
    ["terminal", "list", "--worktree", `id:${worktreeId}`],
    { cwd: repo },
  );
  const terminals = receiptBody(listed).terminals;
  assert(
    Array.isArray(terminals),
    "Orca did not prove the worktree terminal list; preserve the worktree",
  );
  return { terminals, receipt: listed };
}

function closureProvesTerminal(closure, worktreeId, worktreePath, entry) {
  if (
    closure?.worktreeId !== worktreeId ||
    path.resolve(closure.worktreePath ?? "") !== worktreePath ||
    !Array.isArray(closure.terminals)
  )
    return false;
  const terminal = closure.terminals.find(
    (candidate) => candidate?.terminal === entry.terminal,
  );
  if (
    !terminal ||
    terminal.dispatch?.result?.status !== "clear" ||
    !Array.isArray(terminal.releases)
  )
    return false;
  try {
    assertClosedReceipt(terminal.close?.receipt, entry.terminal);
    for (const dispatchId of entry.workerIds) {
      const release = terminal.releases.find(
        (candidate) => candidate?.dispatchId === dispatchId,
      );
      assertReleasedReceipt(release?.receipt, dispatchId);
    }
    const after = receiptBody(closure.afterReceipt).terminals;
    return Array.isArray(after) && after.length === 0;
  } catch {
    return false;
  }
}

function ownedTerminals(launches, closures, worktreeId, worktreePath) {
  const byTerminal = new Map();
  for (const entry of launches) {
    if (
      entry.via !== "worker-start" ||
      typeof entry.terminal !== "string" ||
      typeof entry.workerId !== "string" ||
      path.resolve(entry.worktreePath ?? "") !== worktreePath
    )
      continue;
    const owned = byTerminal.get(entry.terminal) ?? {
      terminal: entry.terminal,
      workerIds: [],
    };
    if (!owned.workerIds.includes(entry.workerId))
      owned.workerIds.push(entry.workerId);
    byTerminal.set(entry.terminal, owned);
  }
  return [...byTerminal.values()].filter(
    (entry) =>
      !closures.some((closure) =>
        closureProvesTerminal(closure, worktreeId, worktreePath, entry),
      ),
  );
}

async function proveAndCloseOwnedTerminals({
  repo,
  worktreeId,
  worktreePath,
  orca,
  launches,
  closures,
  active,
  release,
  close,
  list,
}) {
  const owned = ownedTerminals(launches, closures, worktreeId, worktreePath);
  assert(
    owned.length > 0,
    "No owned Dispatch and terminal receipt matches this role worktree; preserve it for reconciliation",
  );
  const dispatchesByTerminal = new Map();
  for (const entry of owned) {
    const dispatch = await active(entry.terminal, {
      executable: orca,
      cwd: repo,
    });
    assert(
      dispatch.status === "clear",
      `Role terminal ${entry.terminal} is ${dispatch.status}; do not reuse or reclaim its worktree`,
    );
    dispatchesByTerminal.set(entry.terminal, dispatch);
  }
  const before = await listWorktreeTerminals({ repo, worktreeId, orca, list });
  const expected = new Set(owned.map((entry) => entry.terminal));
  const actual = new Set(
    before.terminals
      .map((terminal) => terminal?.handle)
      .filter((handle) => typeof handle === "string"),
  );
  assert(
    before.terminals.length === actual.size &&
      actual.size === expected.size &&
      [...actual].every((handle) => expected.has(handle)),
    "Another or unowned terminal is connected to this worktree; preserve it without closing that session",
  );
  const released = [];
  for (const entry of owned) {
    for (const dispatchId of entry.workerIds) {
      const receipt = await release(dispatchId, {
        executable: orca,
        cwd: repo,
      });
      assertReleasedReceipt(receipt, dispatchId);
      released.push({ dispatchId, receipt });
    }
  }
  const closed = [];
  for (const entry of owned) {
    const receipt = await close(
      selectOrcaExecutable(orca),
      ["terminal", "close", "--terminal", entry.terminal],
      { cwd: repo },
    );
    assertClosedReceipt(receipt, entry.terminal);
    closed.push({ terminal: entry.terminal, receipt });
  }
  const after = await listWorktreeTerminals({ repo, worktreeId, orca, list });
  assert(
    after.terminals.length === 0,
    "A connected terminal remains after close; preserve the worktree",
  );
  return {
    worktreeId,
    worktreePath,
    terminals: owned.map((entry) => ({
      terminal: entry.terminal,
      workerIds: entry.workerIds,
      dispatch: {
        terminal: entry.terminal,
        result: dispatchesByTerminal.get(entry.terminal),
      },
      releases: released.filter((item) =>
        entry.workerIds.includes(item.dispatchId),
      ),
      close: closed.find((item) => item.terminal === entry.terminal),
    })),
    beforeReceipt: before.receipt,
    afterReceipt: after.receipt,
    released,
    closed,
  };
}

/**
 * Creates one Orca child worktree only as part of opening its role session.
 * The callback reuses the same `role-terminal` implementation exposed by the
 * CLI, so a new operational path cannot accidentally bypass session proof.
 *
 * @param {object} args - Parsed `role-worktree-create` command arguments.
 * @param {object} [ports] - Injectable ports for focused lifecycle tests.
 * @param {Function} [ports.create=createWorktreeWithRoleSession] - Creator.
 * @param {Function} [ports.open] - Role-terminal opener.
 * @param {Function} [ports.read=readWorkflow] - Workflow-state reader.
 * @param {Function} [ports.git=gitEvidence] - Git evidence reader.
 * @param {Function} [ports.closures=readTerminalClosures] - Durable closure-proof reader.
 * @param {Function} [ports.recordClosure=recordTerminalClosure] - Closure-proof writer.
 * @returns {Promise<object>} Worktree identity and proven role terminal.
 */
export async function createRoleWorktree(
  args,
  {
    create = createWorktreeWithRoleSession,
    open,
    promote = prepareRolePromotion,
    read = readWorkflow,
    git = gitEvidence,
    organization = (orgFile) => validateOrg(readJSON(orgFile)),
    environment = readLaunchEnvironment,
    matrix = predictLaunchPath,
    launches = readLaunches,
    closures = readTerminalClosures,
    recordClosure = (evidence) => recordTerminalClosure(args.org, evidence),
    active = findActiveDispatch,
    release = releaseWorker,
    close = runOrcaJson,
    list = runOrcaJson,
  } = {},
) {
  const workflowOptions = [
    args["workflow-id"] !== undefined,
    args["workflow-task"] !== undefined,
    args.state !== undefined,
  ];
  const hasWorkflow = workflowOptions.some(Boolean);
  assert(
    !hasWorkflow || workflowOptions.every(Boolean),
    "--workflow-id, --workflow-task, and --state must be provided together",
  );
  const sourceWorkflowId = args["prior-workflow-id"];
  const sourceWorkflowTask = args["prior-task-id"];
  assert(
    Boolean(sourceWorkflowId) === Boolean(sourceWorkflowTask),
    "--prior-workflow-id and --prior-task-id must be provided together",
  );
  assert(
    !sourceWorkflowId || args.worktree,
    "A prior workflow/task is only valid when reusing its --worktree",
  );
  assert(
    !sourceWorkflowId ||
      (args["workflow-id"] && args["workflow-task"] && args.state),
    "Cross-workflow reuse requires the current --workflow-id, --workflow-task, and --state",
  );
  let promotion = null;
  let reusable = null;
  let snapshot = null;
  let state = null;
  let task = null;
  if (hasWorkflow) {
    snapshot = read(path.resolve(args.state), args["workflow-id"]);
    state = snapshot?.state;
    assert(
      state?.tasks && typeof state.tasks === "object",
      `Workflow ${args["workflow-id"]} has no readable task state`,
    );
    task = state.tasks[args["workflow-task"]];
    assert(task, `Unknown workflow task ${args["workflow-task"]}`);
    const existing = task?.worktreeId ?? task?.execution?.worktreeId;
    promotion =
      existing &&
      task.role === "junior" &&
      args.role === "senior" &&
      ["submitted", "review-pending", "reviewed"].includes(task.state)
        ? { fromWorktreeId: existing }
        : null;
    const assignedRole = trustedTaskExecutionRole(task) ?? task.role;
    assert(
      promotion || assignedRole === args.role,
      `Workflow task ${args["workflow-task"]} is assigned to ${assignedRole ?? "no role"}, not ${args.role}; only a reviewed Junior-to-Senior promotion may change roles`,
    );
    assert(
      !existing || promotion,
      `Task ${args["workflow-task"]} already has worktree ${existing}; reuse it with role-terminal instead of creating another`,
    );
    if (args.worktree) {
      let source = null;
      if (sourceWorkflowId) {
        const sourceState =
          sourceWorkflowId === args["workflow-id"]
            ? state
            : read(path.resolve(args.state), sourceWorkflowId).state;
        assert(
          sourceState?.tasks && typeof sourceState.tasks === "object",
          `Prior workflow ${sourceWorkflowId} has no readable task state`,
        );
        source = {
          workflowId: sourceWorkflowId,
          taskId: sourceWorkflowTask,
          state: sourceState,
        };
      }
      const prior = source
        ? [source.taskId, source.state.tasks[source.taskId]]
        : Object.entries(state.tasks).find(
            ([taskId, item]) =>
              taskId !== args["workflow-task"] &&
              item.state === "accepted" &&
              (item.worktreeId ?? item.execution?.worktreeId) ===
                args.worktree &&
              (item.executionRole ?? item.role) === args.role,
          );
      assert(
        prior?.[1]?.state === "accepted" &&
          (prior[1].worktreeId ?? prior[1].execution?.worktreeId) ===
            args.worktree &&
          (prior[1].executionRole ?? prior[1].role) === args.role,
        source
          ? "The explicit prior workflow/task must be accepted, use this worktree, and match the execution role"
          : "A reused role worktree needs an accepted prior task of the same execution role",
      );
      reusable = {
        workflowId: source?.workflowId ?? args["workflow-id"],
        taskId: prior[0],
        task: prior[1],
      };
      const conflictingTask = Object.entries(state.tasks).find(
        ([taskId, item]) =>
          taskId !== args["workflow-task"] &&
          taskId !== reusable.taskId &&
          (item.worktreeId ?? item.execution?.worktreeId) === args.worktree,
      );
      assert(
        !conflictingTask,
        `Worktree ${args.worktree} is also owned by current workflow task ${conflictingTask?.[0]}; preserve it instead of opening another role session`,
      );
    }
  }
  // A workflow freezes its organization. This happens only after task and
  // role ownership are proven, and before any Orca create/open/release/close
  // effect, so the matrix predicts the same launch that role-terminal opens.
  const preflightOrganization = hasWorkflow
    ? snapshot.organization
    : organization(args.org);
  assert(
    preflightOrganization,
    `Workflow ${args["workflow-id"]} has no frozen organization snapshot`,
  );
  await preflightRoleWorktree(args, preflightOrganization, environment, matrix);
  assert(
    !args.worktree || reusable,
    "--worktree requires an accepted prior task of the same role; a promotion also preserves and closes that Senior session first",
  );
  const openRoleSession =
    open ??
    ((workspace) =>
      executeCommand({
        ...args,
        command: "role-terminal",
        worktree: `id:${workspace.id}`,
      }));
  const existingRoleWorktree = Boolean(
    args.worktree && (promotion || reusable),
  );
  const created = existingRoleWorktree
    ? await (async () => {
        if (promotion)
          assert(
            args.worktree !== promotion.fromWorktreeId,
            "Senior promotion needs a separate Senior role worktree",
          );
        const workspace = {
          id: args.worktree,
          path: pathFromWorktreeId(args.worktree),
        };
        const clean = await git(workspace.path, [
          "status",
          "--porcelain=v1",
          "-uall",
        ]);
        assert(
          !clean,
          "A reused role worktree must be clean before opening a new role session",
        );
        if (reusable) {
          const previousHead = await git(workspace.path, ["rev-parse", "HEAD"]);
          const integrationCommit = await git(workspace.path, [
            "rev-parse",
            `${args.base}^{commit}`,
          ]);
          const integrationHead = await git(path.resolve(args.repo), [
            "rev-parse",
            "HEAD",
          ]);
          assert(
            integrationCommit === integrationHead,
            "A reused role worktree must be based on the current PM integration HEAD",
          );
          await git(workspace.path, [
            "merge-base",
            "--is-ancestor",
            previousHead,
            integrationCommit,
          ]);
          const terminalEvidence = await proveAndCloseOwnedTerminals({
            repo: path.resolve(args.repo),
            worktreeId: workspace.id,
            worktreePath: workspace.path,
            orca: args.orca,
            launches: launches(args.org),
            closures: closures(args.org),
            active,
            release,
            close,
            list,
          });
          recordClosure(terminalEvidence);
        }
        const session = await openRoleSession(workspace);
        assert(
          session?.ready === true &&
            session.terminal &&
            session.role === args.role &&
            session.worktree === `id:${workspace.id}` &&
            session.modelRequested,
          "Existing Senior worktree has no matching proven role session",
        );
        return { workspace, session };
      })()
    : await create(path.resolve(args.repo), {
        name: args.name,
        base: args.base,
        setup: args.setup ?? "inherit",
        executable: args.orca,
        openRoleSession: async (workspace) => {
          let opened;
          try {
            opened = await openRoleSession(workspace);
          } catch (error) {
            // The matrix refuses before creating a terminal. Other throws may
            // follow a terminal/process creation and must stay for reconciliation.
            if (error.matrixRefusal) {
              return { ready: false, sessionObserved: false };
            }
            throw error;
          }
          return {
            ...opened,
            // A returned terminal alone can still be a shell or a blocked prompt.
            // Only role-terminal's ready proof is a session; an absent terminal is
            // the one failure state safe to reclaim automatically.
            sessionObserved:
              opened?.ready === true ||
              (typeof opened?.terminal === "string" &&
                opened.terminal.length > 0),
          };
        },
      });
  let transition;
  if (promotion) {
    transition = await promote(
      path.resolve(args.state),
      args["workflow-id"],
      args["workflow-task"],
      {
        ...promotion,
        toWorktreeId: created.workspace.id,
        fromWorktreePath: pathFromWorktreeId(promotion.fromWorktreeId),
        toWorktreePath: created.workspace.path,
        base: args.base,
      },
    );
  }
  return {
    ...created.workspace,
    session: created.session,
    ...(reusable
      ? {
          reusedFrom: {
            workflowId: reusable.workflowId,
            workflowTaskId: reusable.taskId,
          },
        }
      : {}),
    ...(transition ? { transition: transition.transition } : {}),
  };
}

function pathFromWorktreeId(worktreeId) {
  const separator = String(worktreeId).indexOf("::");
  assert(separator > 0, "Workflow worktree receipt must include its path");
  return path.resolve(String(worktreeId).slice(separator + 2));
}

/**
 * Reclaims a child only after the completed workflow proves it is no longer a
 * live execution and its exact commit has reached an integration commit.
 *
 * This intentionally has no fallback removal path. A missing ledger row,
 * unknown Dispatch state, dirty child, or incomplete merge evidence leaves the
 * worktree intact for the PM to reconcile or reuse.
 *
 * @param {object} args - Parsed `role-worktree-reclaim` command arguments.
 * @param {object} [ports] - Injectable lifecycle ports for focused tests.
 * @param {Function} [ports.read=readWorkflow] - Workflow state reader.
 * @param {Function} [ports.launches=readLaunches] - Role-session ledger reader.
 * @param {Function} [ports.closures=readTerminalClosures] - Durable closure-proof reader.
 * @param {Function} [ports.recordClosure=recordTerminalClosure] - Closure-proof writer.
 * @param {Function} [ports.git=gitEvidence] - Explicit-repository Git adapter.
 * @param {Function} [ports.active=findActiveDispatch] - Orca Dispatch lookup.
 * @param {Function} [ports.release=releaseWorker] - Settled Dispatch releaser.
 * @param {Function} [ports.close=runOrcaJson] - Orca terminal closer.
 * @param {Function} [ports.list=runOrcaJson] - Orca worktree terminal lister.
 * @param {Function} [ports.reclaim=reclaimWorktree] - Orca worktree reclaimer.
 * @returns {Promise<object>} Evidence and Orca receipts for the reclaimed child.
 * @throws {Error} When any process, commit, integration, or cleanliness proof is absent.
 */
export async function reclaimIntegratedRoleWorktree(
  args,
  {
    read = readWorkflow,
    launches = readLaunches,
    closures = readTerminalClosures,
    recordClosure = (evidence) => recordTerminalClosure(args.org, evidence),
    git = gitEvidence,
    active = findActiveDispatch,
    release = releaseWorker,
    close = runOrcaJson,
    list = runOrcaJson,
    reclaim = reclaimWorktree,
  } = {},
) {
  const repo = path.resolve(args.repo);
  const { state } = read(path.resolve(args.state), args["workflow-id"]);
  const task = state.tasks[args["workflow-task"]];
  assert(task, `Unknown workflow task ${args["workflow-task"]}`);
  assert(
    task.state === "accepted",
    `Task ${args["workflow-task"]} is ${task.state}; accepted task required before reclaim`,
  );
  const currentWorktreeId = task.worktreeId ?? task.execution?.worktreeId;
  const retiredTransition = (task.worktreeTransitions ?? []).find(
    (transition) =>
      transition.usedAt && transition.fromWorktreeId === args.worktree,
  );
  const worktreeId = retiredTransition?.fromWorktreeId ?? currentWorktreeId;
  assert(worktreeId, "Accepted task has no role-worktree receipt to reclaim");
  assert(
    worktreeId === args.worktree,
    `Task ${args["workflow-task"]} is bound to ${currentWorktreeId}, not ${args.worktree}`,
  );
  const worktreePath = pathFromWorktreeId(worktreeId);
  // A reused child can carry receipts from earlier tasks. The terminal list is
  // worktree-scoped, so release and close every ledger-owned Dispatch in that
  // worktree rather than selecting only this task's newest receipt.
  const worktreeLaunches = launches(args.org);
  const status = await git(worktreePath, ["status", "--porcelain=v1", "-uall"]);
  assert(!status, "Child worktree has uncommitted changes; do not reclaim it");
  const head = await git(worktreePath, ["rev-parse", "HEAD"]);
  const mergeCommit = await git(repo, [
    "rev-parse",
    "--verify",
    `${args["merge-commit"]}^{commit}`,
  ]);
  const integrationHead = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, [
    "merge-base",
    "--is-ancestor",
    mergeCommit,
    integrationHead,
  ]);
  await git(repo, ["merge-base", "--is-ancestor", head, mergeCommit]);

  const terminalEvidence = await proveAndCloseOwnedTerminals({
    repo,
    worktreeId,
    worktreePath,
    orca: args.orca,
    launches: worktreeLaunches,
    closures: closures(args.org),
    active,
    release,
    close,
    list,
  });
  recordClosure(terminalEvidence);
  const postCloseStatus = await git(worktreePath, [
    "status",
    "--porcelain=v1",
    "-uall",
  ]);
  assert(
    !postCloseStatus,
    "Child worktree changed while closing its terminal; do not reclaim it",
  );
  const reclaimed = await reclaim(repo, {
    id: worktreeId,
    executable: args.orca,
  });
  return {
    worktreeId,
    worktreePath,
    head,
    mergeCommit,
    integrationHead,
    dispatches: terminalEvidence.released,
    terminals: terminalEvidence.closed,
    // Keep the former singular fields for callers that reclaim exactly one
    // dispatch, while the receipt arrays retain every lifecycle proof.
    released: terminalEvidence.released.at(-1)?.receipt,
    closed: terminalEvidence.closed.at(-1)?.receipt,
    releaseReceipts: terminalEvidence.released,
    closeReceipts: terminalEvidence.closed,
    reclaimed,
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

// Reconstructs a document's real filesystem location from its docId, following
// the public path formula structured-omt-documents.md 3.5 fixes
// (`<stateDir>/documents/<kickoffHash>/<workflowId|none>/<폴더 이름>/<docType>/<localId>`).
// documents.mjs keeps its own path-joining helper private, so `doc-show`
// rebuilds the same, stable formula from the exported `parseDocId`/`stageFolderName`.
function documentLocation(stateDir, docId) {
  const { kickoffHash, workflowId, stageSlug, docType, localId } =
    parseDocId(docId);
  return path.join(
    stateDir,
    "documents",
    kickoffHash,
    workflowId ?? "none",
    stageFolderName(stageSlug),
    docType,
    localId,
  );
}

// 3.4절이 정한 stage/docType별 작성 권한 표. 조합이 여기 없으면(예: delivery/delivery-ref는
// 표의 어느 역할 행에도 배정되지 않았다) 역할을 제한하지 않는다. design/design-contract는
// 3.4절이 "이번 실행에 하위 역할이 하나도 없을 때만 PM이 직접 쓸 수 있다"는 로스터 조건을
// 추가로 붙이며, 그 조건은 assertPmRosterCondition(3.4.2절)이 판정한다.
const DOCUMENT_AUTHOR_ROLES = {
  "planning/kickoff-brief-ref": ["director", "pm"],
  "design/design-contract": ["senior", "worker", "pm"],
  "implementation/workflow-task-ref": [
    "pm",
    "pl",
    "senior",
    "junior",
    "worker",
  ],
  "implementation/integration-ref": ["pm", "pl", "senior", "junior", "worker"],
  "review/review-ref": ["senior", "worker"],
  "acceptance/acceptance-ref": ["pm"],
  "closure/closure-record": ["director"],
};

// PL의 03. 구현 수정 권한은 "배정 관련 필드만"으로 문서 전체가 아니라 특정 필드에 한정되므로
// (3.4절), own-document 검사(직전 revision을 쓴 실행만 다음 revision을 쓸 수 있다는 제약)
// 자체는 PL을 여전히 예외로 둔다(PM이 첫 revision을, 다른 실행의 PL이 다음 revision을 쓰는
// 정상 흐름을 막지 않기 위함, 3.4.3절). 문서 전체가 아니라 필드만 제한하는 쪽은 별도로
// assertPlFieldScope가 판정한다. 05. 수용은 표가 "PM 전용"이라고만 적어 특정 PM 실행에
// 고정하지 않으므로 예외로 둔다.
function ownDocumentExempt(role, stageSlug) {
  return role === "pl" || stageSlug === "acceptance";
}

// 3.4.3절이 PL의 "배정 관련 필드"로 고정한 필드 목록. 여기 없는 stage/docType 조합에는
// assertPlFieldScope가 아무 제약도 걸지 않는다.
const PL_MUTABLE_FIELDS = {
  "implementation/workflow-task-ref": ["attemptRefs"],
  "implementation/integration-ref": ["taskHashRef", "extensionHistory"],
};

// 저장 계층이 강제하거나(revision, basedOnRevision) 매 저장마다 호출자가 새로 채워 넣어
// 직전 값과 자연히 달라지는 입력값(createdAt, author)이라 필드 비교에서 항상 제외한다
// (3.4.3절 세 번째 문단).
const PL_FIELD_SCOPE_ALWAYS_EXCLUDED = [
  "revision",
  "basedOnRevision",
  "createdAt",
  "author",
];

function withoutFields(source, fields) {
  const copy = { ...source };
  for (const field of fields) delete copy[field];
  return copy;
}

// PL이 쓰는 다음 revision에서 PL_MUTABLE_FIELDS가 허용한 필드(와 저장 계층 관리 필드)를
// 뺀 나머지가 직전 revision과 완전히 같은지 JSON.stringify 동등 비교로 판정한다(3.4.3절).
function assertPlFieldScope(priorDoc, doc, stageDocType) {
  const mutableFields = PL_MUTABLE_FIELDS[stageDocType];
  if (mutableFields === undefined) return;
  const excluded = [...PL_FIELD_SCOPE_ALWAYS_EXCLUDED, ...mutableFields];
  assert(
    JSON.stringify(withoutFields(priorDoc, excluded)) ===
      JSON.stringify(withoutFields(doc, excluded)),
    `PL may only change ${mutableFields.join(" and ")} in the next revision of ${stageDocType} (structured-omt-documents.md 3.4.3)`,
  );
}

// 3.4.2절이 정한 이번 실행의 역할 목록 판정: doc.workflowId가 있으면 그 워크플로 스냅샷의
// state.roles(없으면 스냅샷의 organization으로 definedRoles), 없으면 orgFile이 가리키는
// 조직 파일로 definedRoles를 구한다. 어느 쪽도 읽지 못하면(orgFile 부재·읽기 실패·워크플로
// 없음) 저장을 거부하는 것이 이 함수를 부르는 쪽의 몫이므로 여기서는 오류를 그대로 던진다.
function runRoleRoster(stateDir, workflowId, orgFile) {
  if (workflowId) {
    let snapshot;
    try {
      snapshot = readWorkflow(stateDir, workflowId);
    } catch (error) {
      throw new Error(
        `Cannot read workflow ${workflowId} to resolve this run's role roster (structured-omt-documents.md 3.4.2): ${error.message}`,
      );
    }
    return snapshot.state.roles ?? definedRoles(snapshot.organization);
  }
  assert(
    orgFile !== undefined,
    "Cannot resolve this run's role roster: doc.workflowId is not set and --org was not given (structured-omt-documents.md 3.4.2)",
  );
  let org;
  try {
    org = readJSON(path.resolve(orgFile));
  } catch (error) {
    throw new Error(
      `Cannot read organization file ${orgFile} to resolve this run's role roster (structured-omt-documents.md 3.4.2): ${error.message}`,
    );
  }
  return definedRoles(org);
}

// design/design-contract를 PM이 직접 쓰려면 이번 실행의 역할 목록에 pl·senior·junior가
// 하나도 없어야 한다(3.4절 PM 행, 3.4.2절). 역할 목록을 얻지 못하면(runRoleRoster가 던짐)
// 그 오류가 그대로 저장을 거부한다.
function assertPmRosterCondition(stateDir, doc, orgFile) {
  const roster = runRoleRoster(stateDir, doc.workflowId, orgFile).map(
    canonicalRole,
  );
  assert(
    !roster.includes("pl") &&
      !roster.includes("senior") &&
      !roster.includes("junior") &&
      !roster.includes("worker"),
    "PM may not author design/design-contract while this run's role roster includes pl, senior, junior, or worker (structured-omt-documents.md 3.4.2)",
  );
}

/**
 * Enforces the document-layer write authority and independence rules
 * structured-omt-documents.md 3.4 assigns, using the envelope about to be
 * saved, files already on disk under `stateDir`, and (only for the PM
 * design/design-contract roster condition) the workflow snapshot or `--org`
 * organization file named by `orgFile`.
 *
 * @param {string} stateDir - PM worktree `.omt` state directory.
 * @param {object} doc - Envelope about to be saved (already bound for `saveDocument`).
 * @param {string} [orgFile] - `--org` path; read only when `doc.workflowId`
 *   is unset and the author is a PM writing design/design-contract.
 * @throws {Error} When the author's role may not write this stage/docType, the
 *   PM roster condition rejects a design/design-contract save, a different
 *   execution than the document's own author is revising it, a PL's next
 *   revision changes a field outside 3.4.3's allowed list, or a review-ref
 *   names an implementation execution that matches its own author.
 */
function assertDocumentAuthority(stateDir, doc, orgFile) {
  const { docType } = parseDocId(doc.docId);
  const stageDocType = `${doc.stage}/${docType}`;
  const allowedRoles = DOCUMENT_AUTHOR_ROLES[stageDocType];
  if (allowedRoles !== undefined) {
    assert(
      allowedRoles.includes(doc.author.role),
      `Role ${doc.author.role} may not author ${stageDocType} documents (structured-omt-documents.md 3.4)`,
    );
  }

  if (doc.author.role === "pm" && stageDocType === "design/design-contract") {
    assertPmRosterCondition(stateDir, doc, orgFile);
  }

  const current = documentState(stateDir, doc.docId);
  if (current.exists) {
    const priorDoc = readJSON(
      path.join(
        documentLocation(stateDir, doc.docId),
        "revisions",
        `${current.revision}.json`,
      ),
    );
    if (!ownDocumentExempt(doc.author.role, doc.stage)) {
      assert(
        priorDoc.author?.executionId === doc.author.executionId,
        `Only the execution that authored ${doc.docId} may write its next revision (structured-omt-documents.md 3.4)`,
      );
    }
    if (doc.author.role === "pl") {
      assertPlFieldScope(priorDoc, doc, stageDocType);
    }
  }

  if (doc.stage === "review" && typeof doc.reviewFileRef === "string") {
    const resolvedState = path.resolve(stateDir);
    const reviewPath = path.resolve(stateDir, doc.reviewFileRef);
    const insideState =
      reviewPath === resolvedState ||
      reviewPath.startsWith(resolvedState + path.sep);
    if (insideState && fs.existsSync(reviewPath)) {
      const review = readJSON(reviewPath);
      assert(
        review.implementationExecutionId !== doc.author.executionId,
        "Independent review must use a different execution identity (structured-omt-documents.md 3.4)",
      );
    }
  }
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

async function writeDraft(args, execute) {
  const output = path.resolve(args.output);
  // A draft path that already holds a file may be the live organization, and
  // writing over it would skip the no-overwrite rule init keeps.
  assert(!fs.existsSync(output), "Draft output exists; choose a new path");
  const models = args.models.split(",");
  const organization =
    args.tiers === undefined && models.length === 2
      ? draftThreeTierOrganization({ name: args.name, models })
      : draftOrganization({
          name: args.name,
          tiers: args.tiers === undefined ? undefined : Number(args.tiers),
          models,
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
 * Dispatches a parsed CLI command to its handler.
 *
 * @param {object} args - Parsed CLI arguments.
 * @param {Function} [execute] - Injectable command runner, threaded through
 *   to every save path's `revalidateOrgForSave` call so tests can supply a
 *   fake model catalog instead of spawning the real executables. Real CLI
 *   invocations never pass this; `fetchModelCatalog` falls back to spawning
 *   the actual claude/codex/agy binaries.
 * @returns {Promise<object|undefined>} The command's JSON-serializable result.
 */
export async function executeCommand(args, execute) {
  switch (args.command) {
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
    case "kickoff-claim":
      return registerKickoff(args.org, readJSON(args.from));
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
        orgFile: args.org,
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
    case "role-worktree-create":
      return createRoleWorktree(args);
    case "role-worktree-reclaim":
      return reclaimIntegratedRoleWorktree(args);
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
      const { org, run: runCtx } = launchContext(args);
      const firstPrompt =
        args.brief === undefined
          ? undefined
          : kickoffBriefPrompt(path.resolve(args.brief));
      const command = roleCommand(org, args.role, { ...runCtx, firstPrompt });
      assert(
        !command.runner,
        "An explicit OpenCodex runner has no interactive Orca terminal path; role-terminal cannot run it as native Codex",
      );
      assert(
        firstPrompt === undefined || command.role === "pm",
        "--brief hands over an incoming-brief prompt, which only makes sense for the pm role this terminal launches",
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
        gateHookOptions(args, stateDir),
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
        path: documentLocation(stateDir, args["doc-id"]),
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
      if (args.refs !== undefined) {
        options.refs = args.refs
          .split(",")
          .map((ref) => ref.trim())
          .filter(Boolean);
      }
      return saveDocument(stateDir, doc, options);
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
  assert(
    args.profile !== undefined || args.provider !== undefined,
    "director-command needs --profile ID or --provider claude|codex|agy [--model NAME] [--effort LEVEL]",
  );
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
