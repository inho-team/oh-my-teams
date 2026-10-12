/** Strict CLI command catalog, help text, and argument validation. */
import { assert } from "./core.mjs";

/** Usage text for the supported command surface. */
export const HELP = `oh my teams organization runtime on Orca (Node >=22)
  org-draft --name NAME --resources provider,... --output FILE [--concurrency N --max-calls N]
  init --org FILE --from CONFIG
  edit --org FILE --from CONFIG --revision N
  preset --org FILE --name opus-first|balanced|single-subscription|advisor-codex|advisor-claude --revision N
         [--apply]
  show --org FILE [--state DIR] [--json]
  validate --org FILE
  kickoff-claim --org FILE --from CLAIM
  kickoff-show --org FILE [--worktree ID]
  kickoff-bind --org FILE --worktree ID --run ID
  kickoff-result-repo-decide --org FILE --worktree ID --repo PATH --reason TEXT
                             (director only, run from the kickoff's registered checkout;
                             when accepted workflows recorded different result repositories,
                             proves from Git which one contains every accepted head and records
                             it append-only; the same accepted results cannot be decided twice)
  kickoff-audit-policy-retrofit --org FILE --worktree ID
                                --auditor-configured true|false --reason TEXT
                                [--profile NAME --fallbacks NAME[,NAME...]]
                                (director only, run from the kickoff's registered checkout;
                                pins a legacy entry's audit policy once, permanently — refuses
                                a kickoff already pinned at claim time, an entry with no
                                registered director, or --auditor-configured false when the
                                launch ledger already records an auditor session for it;
                                --profile/--fallbacks are required, and must each name a
                                profile in organization.json, only when --auditor-configured
                                is true)
  kickoff-release --org FILE --worktree ID
                  --reason completed|disbanded|taken-over [--force]
                  (also closes that kickoff's pending director signals)
  kickoff-cleanup-candidates --org FILE --worktree ID [--history-file FILE]
  kickoff-cleanup-reclaim --org FILE --worktree ID --history-file FILE
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
                        [--worktree WORKTREE_ID] [--fresh-reason TEXT]
                        [--profile FALLBACK] [--orca EXECUTABLE]
                        (creates a child only while opening and proving its Orca role session;
                        reuses a proven idle same-role worktree only after prior acceptance,
                        integration, Dispatch release, terminal closure, and Git-clean proof;
                        automatically checks active workflows and protocol-enrolled completed archives;
                        every new workflow child needs caller-supplied --fresh-reason, even with no candidates;
                        --fresh-reason never bypasses safe-candidate selection;
                        cross-workflow reuse requires the explicit accepted prior pair;
                        a proven no-session launch is reclaimed, an ambiguous launch is preserved)
  role-worktree-reclaim --org FILE --state DIR --workflow-id ID --workflow-task ID
                        --repo DIR --worktree ID --merge-commit SHA [--orca EXECUTABLE]
                        (reclaims an accepted and integrated child only after every related
                        Dispatch is released, every owned terminal is closed, no other terminal
                        remains, its commit is preserved by --merge-commit, and Git is clean)
  worktree-transition-reconcile --org FILE --transition ID [--orca EXECUTABLE]
                        (resolves one interrupted local role-reclaim only when Orca, Git,
                        terminal, and filesystem inventories all prove the child absent)
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
  work --org SNAPSHOT --task FILE --repo WORKTREE --state SHARED_DIR [--role worker]
       [--workflow-id ID --attempt-id ID]
  draft --org FILE --task FILE --repo DIR [--kind citations|checklist]
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
         [--org FILE --worktree ID] [--workflow-id ID]
  gate-cache-refresh --task FILE --report FILE --repo DIR --state DIR --org FILE
         [--workflow-id ID]
         (--org resolves the state's kickoff entry to a current/legacy/
         integrity-failure judgement per structured-omt-documents.md 3.7 item 5;
         current forwards kickoffHash [and --workflow-id, if given] to the
         document ownership checks in gates.mjs, legacy omits both, and
         integrity-failure or an unresolvable entry refuses the command;
         --org/--worktree also name the kickoff under a requirements/audit
         ledger and refuse while its outcome audit checkpoint has an
         unresolved objection)
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
  doc-event-consume --state DIR --event FILE
  doc-event-deliver --state DIR --kickoff-hash HASH --actor ACTOR --to ACTOR [--workflow-id ID]
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
  workflow-approval-correction --id ID --state DIR --revision N --correction FILE
                               (appends a correction for a historical approval,
                               splitting the new attestation and the attribution
                               correction into two mutually-referencing events)
  workflow-staffing --id ID --state DIR --revision N --change FILE
                    (records a PM task staffing change; named upgrades need
                    an explicit director decision)
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
                  --text TEXT [--head SHA --source DIR]
                  (writes the signal record and notifies through Orca)
  director-inbox --org FILE [--director-terminal HANDLE]
                 (lists pending signals and unacknowledged deliveries)
  director-reply --org FILE --signal ID --text TEXT [--director-terminal HANDLE]
                 (records the director's decision and queues a PM message)
  director-ack --org FILE (--signal ID | --delivery ID) [--director-terminal HANDLE]
               [--director-terminal HANDLE]
               (marks a signal and its message, or a delivery receipt, as handled)
  director-delivery --org FILE --source DIR --head SHA --director-terminal HANDLE
                    (--pr URL | --target TEXT) [--text TEXT] [--orca EXECUTABLE]
                    (records an independent worktree delivery receipt and notifies director terminal)
  director-deliveries --org FILE [--unacknowledged]
                      (lists independent worktree delivery receipts)
  resource-acquire --org FILE --worktree ID --kind test|worker|build [--note TEXT] [--owner-pid PID]
                   (acquires a resource slot; --owner-pid names the long-lived owner process, omitted the owner is unknown and the slot is only freed by resource-release)
  resource-release --org FILE --slot ID
                   (releases an acquired resource slot)
  director-command --org FILE [--profile ID | --provider claude|codex|agy [--model NAME] [--effort LEVEL]]
                   [--brief FILE]
                   (prints the command a director session opens with; the director is
                   the host session, not a role, so it takes a profile or an explicit provider)
  director-terminal --org FILE [--profile ID | --provider claude|codex|agy [--model NAME] [--effort LEVEL]]
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
  "work-item-save": ["state", "file", "expected-revision"],
  "work-item-list": [
    "state",
    "kickoff-id",
    "workflow-id",
    "title",
    "doc-state",
    "assignee",
  ],
  "org-draft": [
    "name",
    "resources",
    "concurrency",
    "max-calls",
    "output",
    "codex-home",
  ],
  init: ["org", "from", "codex-home", "host-default"],
  edit: ["org", "from", "revision", "codex-home", "host-default"],
  preset: ["org", "name", "revision", "apply", "codex-home"],
  show: ["org", "state", "json"],
  validate: ["org"],
  "kickoff-claim": ["org", "from"],
  "kickoff-show": ["org", "worktree"],
  "kickoff-handoff-verify": ["org", "worktree", "director-terminal", "brief"],
  "kickoff-bind": ["org", "worktree", "run"],
  "kickoff-result-repo-decide": ["org", "worktree", "repo", "reason"],
  "kickoff-audit-policy-retrofit": [
    "org",
    "worktree",
    "auditor-configured",
    "profile",
    "fallbacks",
    "reason",
  ],
  "kickoff-release": ["org", "worktree", "reason", "force", "repo", "head"],
  "kickoff-cleanup-candidates": ["org", "worktree", "history-file", "orca"],
  "kickoff-cleanup-reclaim": ["org", "worktree", "history-file", "orca"],
  "kickoff-branch-cleanup": ["org", "worktree", "branches", "remote", "force"],
  "kickoff-check-close-ready": ["org", "worktree", "head", "repo"],
  "kickoff-merge-record": [
    "org",
    "worktree",
    "head",
    "merge-commit",
    "remote",
    "force",
  ],
  "requirements-draft": ["org", "worktree", "from"],
  "requirements-confirm": [
    "org",
    "worktree",
    "draft",
    "checkout",
    "criterion",
    "quote",
  ],
  "requirements-retrofit": ["org", "worktree", "checkout"],
  "requirements-exception": ["org", "worktree", "from"],
  "requirements-amend": ["org", "worktree", "from"],
  "requirements-present": ["org", "worktree", "from"],
  "requirements-fidelity": ["org", "worktree", "from"],
  "requirements-fidelity-confirm": ["org", "worktree"],
  "audit-objection": ["org", "worktree", "from"],
  "audit-response": ["org", "worktree", "from"],
  "audit-ruling": ["org", "worktree", "from"],
  "audit-checked": ["org", "worktree", "checkpoint", "from", "head", "repo"],
  "audit-accept": ["org", "worktree", "checkpoint", "head", "repo"],
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
    "pm-selection",
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
    "fresh-reason",
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
  "worktree-transition-reconcile": ["org", "transition", "orca"],
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
  "gate-cache-refresh": [
    "task",
    "report",
    "repo",
    "state",
    "org",
    "workflow-id",
  ],
  accept: [
    "task",
    "report",
    "decision",
    "repo",
    "state",
    "org",
    "worktree",
    "workflow-id",
  ],
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
  "doc-save": [
    "state",
    "doc",
    "expected-revision",
    "refs",
    "org",
    "request-id",
  ],
  "doc-event-consume": ["state", "event"],
  "doc-event-deliver": ["state", "kickoff-hash", "workflow-id", "actor", "to"],
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
  "workflow-approval-correction": ["id", "state", "revision", "correction"],
  "workflow-staffing": ["id", "state", "revision", "change"],
  "workflow-staffing": ["id", "state", "revision", "change"],
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
  "director-inbox": ["org", "director-terminal"],
  "director-reply": ["org", "signal", "text", "orca", "director-terminal"],
  "director-ack": [
    "org",
    "signal",
    "delivery",
    "director-terminal",
    "terminal",
  ],
  "director-delivery": [
    "org",
    "source",
    "head",
    "pr",
    "target",
    "director-terminal",
    "text",
    "orca",
  ],
  "director-deliveries": ["org", "unacknowledged"],
  "resource-acquire": ["org", "worktree", "kind", "note", "owner-pid"],
  "resource-release": ["org", "slot"],
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
  "work-item-save": ["state", "file"],
  "work-item-list": ["state", "kickoff-id"],
  "org-draft": ["name", "output"],
  init: ["org", "from"],
  edit: ["org", "from", "revision"],
  preset: ["org", "name", "revision"],
  show: ["org"],
  validate: ["org"],
  "kickoff-claim": ["org", "from"],
  "kickoff-show": ["org"],
  "kickoff-handoff-verify": ["org", "worktree", "director-terminal", "brief"],
  "kickoff-bind": ["org", "worktree", "run"],
  "kickoff-result-repo-decide": ["org", "worktree", "repo", "reason"],
  "kickoff-audit-policy-retrofit": [
    "org",
    "worktree",
    "auditor-configured",
    "reason",
  ],
  "kickoff-release": ["org", "worktree", "reason"],
  "kickoff-cleanup-candidates": ["org", "worktree"],
  "kickoff-cleanup-reclaim": ["org", "worktree", "history-file"],
  "kickoff-branch-cleanup": ["org", "worktree", "branches"],
  "kickoff-check-close-ready": ["org", "worktree", "head"],
  "kickoff-merge-record": ["org", "worktree", "head", "merge-commit"],
  "requirements-draft": ["org", "worktree", "from"],
  "requirements-confirm": ["org", "worktree", "criterion", "quote"],
  "requirements-retrofit": ["org", "worktree"],
  "requirements-exception": ["org", "worktree", "from"],
  "requirements-amend": ["org", "worktree", "from"],
  "requirements-present": ["org", "worktree", "from"],
  "requirements-fidelity": ["org", "worktree", "from"],
  "requirements-fidelity-confirm": ["org", "worktree"],
  "audit-objection": ["org", "worktree", "from"],
  // --terminal is not required here: it is only relevant for the "outcome"
  // checkpoint's PM identity (verifiedPm); "brief" uses the caller's own cwd
  // (verifiedDirector) and never reads it.
  "audit-response": ["org", "worktree", "from"],
  "audit-ruling": ["org", "worktree", "from"],
  "audit-checked": ["org", "worktree", "checkpoint", "from"],
  "audit-accept": ["org", "worktree", "checkpoint"],
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
  "worktree-transition-reconcile": ["org", "transition"],
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
  work: ["org", "task", "repo", "state"],
  draft: ["org", "task", "repo"],
  advise: ["org", "brief", "repo", "state", "role", "kind"],
  verify: ["task", "repo", "state"],
  "merge-check": ["evidence", "task", "repo", "base"],
  aggregate: ["expected"],
  "review-record": ["task", "report", "review", "repo", "state"],
  "gate-check": ["task", "report", "repo", "state"],
  accept: ["task", "report", "decision", "repo", "state"],
  "gate-cache-refresh": ["task", "report", "repo", "state", "org"],
  "doc-resolve-kickoff": ["org", "worktree"],
  "doc-id": ["kickoff-hash", "stage", "doc-type", "local-id"],
  "doc-show": ["state", "doc-id"],
  "doc-save": ["state", "doc"],
  "doc-event-consume": ["state", "event"],
  "doc-event-deliver": ["state", "kickoff-hash", "actor", "to"],
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
  "workflow-approval-correction": ["id", "state", "revision", "correction"],
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
  "director-ack": ["org"],
  "director-delivery": ["org", "source", "head", "director-terminal"],
  "director-deliveries": ["org"],
  "resource-acquire": ["org", "worktree", "kind"],
  "resource-release": ["org", "slot"],
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
      ["json", "apply", "force", "all", "write", "dry-run", "draft"].includes(
        option,
      ) ||
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

/**
 * Validates one parsed command against the command catalog.
 * @param {object} args - Parsed command and options.
 * @returns {void} Throws when the command or an option is invalid.
 */
export function validateArgs(args) {
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
  if (args.command === "org-draft") {
    assert(
      typeof args.resources === "string" && args.resources.trim(),
      "org-draft requires --resources",
    );
  }
}
