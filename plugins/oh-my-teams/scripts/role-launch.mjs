/**
 * Derives how a role is launched from its saved profile.
 *
 * A coordinator that types `--agent` and `--model` by hand can drop the model
 * the user saved, and nothing downstream notices: Orca launches the agent's
 * account default and the report still names the role's profile. Reading the
 * agent, model and effort from the organization, and refusing any explicit
 * value that disagrees, removes that hand-built step.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  definedRoles,
  foldRole,
  ROLES,
  ROOT_ROLE,
  validateOrg,
} from "./core.mjs";

/**
 * How each provider's role reaches an Orca terminal, and under which agent id.
 *
 * `orchestration worker-start --model` pins a model for Claude, Codex and
 * Cursor only, so those start with `agent`. Orca knows Agy as `antigravity`
 * but cannot pass it a model, so an Agy role is opened in a terminal with its
 * model on the command line first and then handed its task with `--terminal`.
 * Ollama has no interactive agent in Orca and runs through the `work` harness.
 */
export const ORCA_LAUNCH = Object.freeze({
  claude: Object.freeze({ agent: "claude", via: "agent" }),
  codex: Object.freeze({ agent: "codex", via: "agent" }),
  agy: Object.freeze({ agent: "antigravity", via: "terminal" }),
});

/**
 * Flag each provider's CLI takes to run tools without stopping for approval.
 *
 * A role terminal has nobody watching it: no supervisor can answer a tool
 * approval prompt, so a role opened without this flag stops at its first
 * command. Orca adds the same flags from its own agent defaults, but only to a
 * command that is the bare agent name, so a command carrying `--model` (and
 * every `agy` command, whose agent id is `antigravity`) arrives without them.
 */
export const PERMISSION_BYPASS = Object.freeze({
  claude: "--dangerously-skip-permissions",
  codex: "--dangerously-bypass-approvals-and-sandbox",
  agy: "--dangerously-skip-permissions",
});

/**
 * Roles each role may start as supervised workers, before folding.
 *
 * Only PM and PL create Dispatches. Senior hands its implementation scope back
 * instead, and Junior reaches Intern through the non-interactive `work` harness.
 */
export const DISPATCH_AUTHORITY = Object.freeze({
  pm: ["pl", "senior", "junior", "intern"],
  pl: ["senior", "junior", "intern"],
  senior: [],
  junior: [],
  intern: [],
});

/**
 * Resolves the directory an Orca worktree selector names.
 *
 * @param {string} [selector] - `current`, `active`, `id:<repo>::<path>` or `path:<dir>`.
 * @param {string} callerDir - Directory `current` and `active` resolve to.
 * @returns {string | null} Absolute directory, or null for `new-child`, `name:`
 *   and other selectors that name no directory yet.
 */
export function selectedWorktreePath(selector, callerDir) {
  const value = String(selector ?? "current").trim();
  if (value === "current" || value === "active") return path.resolve(callerDir);
  if (value.startsWith("id:")) return worktreePath(value.slice(3));
  if (value.startsWith("path:")) return path.resolve(value.slice(5));
  return null;
}

function worktreePath(worktreeId) {
  const text = String(worktreeId ?? "");
  const at = text.lastIndexOf("::");
  return at === -1 ? null : path.resolve(text.slice(at + 2));
}

/**
 * Refuses to start a role in a worktree another role's task works in.
 *
 * In the literacy-test kickoff PM opened the Agy Senior reviewer in Junior's
 * worktree, because Agy had already been trusted there. Playwright files the
 * review needed were left uncommitted beside Junior's report. A reviewer reads
 * another role's work by path and commit from its own worktree. The workflow
 * records which role each attempt ran in which worktree, so that record is the
 * check. A role that supervises the owner may still work there, as Senior does
 * in PL's worktree with `--worktree current`.
 *
 * @param {object} [workflowState] - Workflow state; nothing is checked without one.
 * @param {string} role - Role about to start, after folding.
 * @param {string} [selector] - Orca worktree selector the role is given.
 * @param {string} callerDir - Directory `current` and `active` resolve to.
 * @returns {void}
 * @throws {Error} When the worktree belongs to a role that does not supervise `role`.
 */
export function assertWorktreeUnshared(
  workflowState,
  role,
  selector,
  callerDir,
) {
  const target = selectedWorktreePath(selector, callerDir);
  if (!workflowState?.tasks || !target) return;
  for (const [taskId, item] of Object.entries(workflowState.tasks)) {
    const receipts = [
      item.execution,
      ...(item.attempts ?? []).map((attempt) => attempt.receipt),
    ];
    for (const receipt of receipts) {
      if (worktreePath(receipt?.worktreeId) !== target) continue;
      const owner = receipt.role ?? item.role;
      if (owner === role || DISPATCH_AUTHORITY[owner]?.includes(role)) continue;
      throw new Error(
        `Worktree ${target} is where ${owner} works on task ${taskId}; ` +
          `${role} does not start there. Read that work by path and commit from ` +
          `this role's own worktree, or create a worktree for ${role}.`,
      );
    }
  }
}

const CHARTER_HEADING = "## 권한·책임·한계";
const ROLE_NAMES = {
  pm: "PM",
  pl: "PL",
  senior: "Senior",
  junior: "Junior",
  intern: "Intern",
};
const skillsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../skills",
);
const BARE_COMMAND = /^[A-Za-z0-9._-]+$/;

function launchableProfile(role, profileId, profile) {
  assert(
    Object.hasOwn(ORCA_LAUNCH, profile.provider),
    `Role ${role} uses provider ${profile.provider} (profile ${profileId}), which has no interactive Orca agent; ` +
      "run its work through the work harness (references/orca-runtime.md)",
  );
  // An Orca agent id names a binary, not an account. A profile that selects an
  // account through extra arguments or environment references would silently
  // run as whoever is logged in.
  assert(
    profile.account === "current" &&
      !profile.env &&
      profile.command.length === 1,
    `Role ${role} profile ${profileId} does not use the current account with a plain command; ` +
      "Orca cannot launch it (references/orca-runtime.md)",
  );
  // Orca refuses --effort without --model, and dropping the effort would launch
  // something other than what was saved.
  assert(
    profile.effort === undefined || profile.model !== null,
    `Role ${role} profile ${profileId} sets effort without a model; pin a model with adjust first`,
  );
}

// A run may use fewer roles than the organization declares, so folding reads
// the run's own role list when one was recorded and the ladder otherwise.
function activeRoles(org, roles) {
  const declared = definedRoles(org);
  if (roles === undefined) return declared;
  assert(
    Array.isArray(roles) &&
      roles.includes(ROOT_ROLE) &&
      roles.every((role) => declared.includes(role)),
    "Run roles must include pm and name only declared roles",
  );
  return ROLES.filter((role) => roles.includes(role));
}

// Says why a role landed elsewhere: a role the organization never declared and
// a declared role this run's depth left out need different fixes.
function foldReason(org, roles, requestedRole) {
  return definedRoles(org).includes(requestedRole) && roles !== undefined
    ? `${requestedRole} is not in this run's roles`
    : `${requestedRole} is not declared`;
}

// A terminal is built for one role's profile before any task reaches it, so
// folding at hand-over time could accept it as a different role's worker. A
// prebuilt launch therefore has to name a role the run actually holds.
function assertHeldRole(org, roles, requestedRole, role) {
  assert(
    role === requestedRole,
    `${foldReason(org, roles, requestedRole)}; its work folds to ${role}, so open and hand over a terminal for ${role} instead`,
  );
}

function contradiction(role, what, explicit, saved) {
  assert(
    explicit === undefined || explicit === saved,
    `Role ${role}: ${what} ${explicit} contradicts the saved profile (${saved ?? "host default"})`,
  );
}

/**
 * Resolves how a dispatched role must launch, and with which model and effort.
 *
 * @param {object} requestedOrg - Organization document.
 * @param {string} requestedRole - Role the caller addresses, declared or not.
 * @param {object} [explicit={}] - Values the caller also passed on the CLI.
 * @param {string} [explicit.agent] - Orca agent id the caller named.
 * @param {string} [explicit.model] - Model id the caller named.
 * @param {string} [explicit.effort] - Effort the caller named.
 * @param {object} [run={}] - Run context.
 * @param {string[]} [run.roles] - Roles the run uses, when it recorded them.
 * @param {string} [run.terminal] - Terminal handle the role was opened in.
 * @returns {object} Role, profile, provider, agent, launch path, model, effort.
 * @throws {Error} For PM, an unlaunchable profile, or a contradicting value.
 */
export function resolveRoleLaunch(
  requestedOrg,
  requestedRole,
  explicit = {},
  { roles, terminal } = {},
) {
  const org = validateOrg(requestedOrg);
  const role = foldRole(activeRoles(org, roles), requestedRole);
  assert(
    role !== ROOT_ROLE,
    requestedRole === ROOT_ROLE
      ? "PM runs in its own terminal opened with role-command, not worker-start"
      : `${foldReason(org, roles, requestedRole)} and its work folds to pm, which does it itself`,
  );
  const profileId = org.roles[role].profile;
  const profile = org.profiles[profileId];
  launchableProfile(role, profileId, profile);
  const { agent, via } = ORCA_LAUNCH[profile.provider];
  if (terminal) {
    assertHeldRole(org, roles, requestedRole, role);
    // Orca refuses a model, effort or agent beside --terminal, so none is
    // accepted here either, even one that restates the profile.
    assert(
      [explicit.agent, explicit.model, explicit.effort].every(
        (value) => value === undefined,
      ),
      `Role ${role}: --agent, --model and --effort cannot combine with --terminal; the terminal keeps the model it was opened with`,
    );
  } else {
    assert(
      via === "agent",
      `Role ${role} uses agy (profile ${profileId}), which Orca cannot start with a model; ` +
        "open it with role-terminal, confirm the model on screen, then pass --terminal",
    );
    contradiction(role, "agent", explicit.agent, agent);
    contradiction(role, "model", explicit.model, profile.model);
    contradiction(role, "effort", explicit.effort, profile.effort);
  }
  return {
    requestedRole,
    role,
    profile: profileId,
    provider: profile.provider,
    agent,
    via: terminal ? "terminal" : via,
    model: profile.model,
    effort: profile.effort ?? null,
  };
}

/**
 * Records what a launch requested and whether Orca's receipt proves it.
 *
 * `launch.effective` is Orca's record of the launch arguments it applied, not
 * the model's own report, so `matched` still leaves the interactive screen to
 * confirm. A null requested model is `unrequested`: the agent runs its account
 * default, and no report may name a specific model from this receipt. A role
 * handed its task in an existing terminal is `unproven` until the screen shows
 * the model.
 *
 * @param {object} launch - Result of {@link resolveRoleLaunch}.
 * @param {object} started - Worker receipt from the Orca adapter.
 * @returns {object} Requested values, a `modelProof` verdict and `screenCheck`.
 */
export function launchBinding(launch, started) {
  const effective = started?.receipt?.result?.launch?.effective;
  let modelProof;
  if (launch.model === null) modelProof = "unrequested";
  else if (launch.via === "terminal" || !effective) modelProof = "unproven";
  else if (effective.model !== launch.model) modelProof = "mismatched";
  else if (launch.effort === null || effective.effort === launch.effort) {
    modelProof = "matched";
  } else if (effective.effort === undefined || effective.effort === null) {
    // A receipt that records no effort neither confirms nor contradicts it.
    modelProof = "unproven";
  } else modelProof = "mismatched";
  return {
    requestedRole: launch.requestedRole,
    role: launch.role,
    profile: launch.profile,
    provider: launch.provider,
    agent: launch.agent,
    via: launch.via,
    modelRequested: launch.model,
    effortRequested: launch.effort,
    modelProof,
    screenCheck: modelProof === "unrequested" ? "not-applicable" : "required",
  };
}

const SAFE_TOKEN = /^[A-Za-z0-9._:=/@+-]+$/;

// Single quotes are literal in both POSIX shells and PowerShell, the shells an
// Orca terminal runs, so one quoting rule serves both. Only arguments are ever
// quoted: PowerShell would read a quoted command name as a string.
function shellToken(token) {
  if (SAFE_TOKEN.test(token)) return token;
  assert(!token.includes("'"), `Cannot quote argument: ${token}`);
  return `'${token}'`;
}

/**
 * Builds the interactive CLI command that opens a role with its saved model.
 *
 * `orca worktree create --agent` has no model option, so the PM is
 * opened with this command through `role-terminal`. An Agy role is opened the
 * same way before `worker-start --terminal` hands it a task. The command runs
 * tools without approval prompts, since no one can answer them in a role
 * terminal.
 *
 * The role must be one the run holds. A terminal opened for a role the run
 * folds elsewhere would run that role's model while `worker-start` hands it
 * the work of the role it folded onto.
 *
 * @param {object} requestedOrg - Organization document.
 * @param {string} requestedRole - Role to launch.
 * @param {object} [run={}] - Run context.
 * @param {string[]} [run.roles] - Roles the run uses, when it recorded them.
 * @returns {object} Role, profile, argv, shell command and requested model.
 * @throws {Error} When the role is not held or the profile cannot be launched.
 */
export function roleCommand(requestedOrg, requestedRole, { roles } = {}) {
  const org = validateOrg(requestedOrg);
  const role = foldRole(activeRoles(org, roles), requestedRole);
  assertHeldRole(org, roles, requestedRole, role);
  const profileId = org.roles[role].profile;
  const profile = org.profiles[profileId];
  launchableProfile(role, profileId, profile);
  assert(
    BARE_COMMAND.test(profile.command[0]),
    `Role ${role} profile ${profileId} must name a bare executable name on PATH, not ${profile.command[0]}`,
  );
  const argv = [...profile.command];
  // Only a bare command reaches here, so the flag is never given twice, which
  // Codex would refuse.
  const bypass = PERMISSION_BYPASS[profile.provider];
  if (bypass) argv.push(bypass);
  if (profile.model) argv.push("--model", profile.model);
  if (profile.effort) {
    // Codex takes effort only as a config override; Agy and Claude have a flag.
    argv.push(
      ...(profile.provider === "codex"
        ? ["--config", `model_reasoning_effort=${profile.effort}`]
        : ["--effort", profile.effort]),
    );
  }
  return {
    role,
    profile: profileId,
    provider: profile.provider,
    argv,
    command: argv.map(shellToken).join(" "),
    permissionBypass: bypass ?? null,
    modelRequested: profile.model,
    effortRequested: profile.effort ?? null,
  };
}

/**
 * Reads the authority, responsibility and limits section of a role skill.
 *
 * @param {string} role - Role identifier.
 * @param {string} [directory] - Skills directory, for tests.
 * @returns {string} The section from its heading up to the next `## ` heading.
 * @throws {Error} When the role is unknown or its skill lacks the section.
 */
export function readRoleCharter(role, directory = skillsDir) {
  assert(ROLES.includes(role), `Unknown role: ${role}`);
  const text = fs
    .readFileSync(path.join(directory, role, "SKILL.md"), "utf8")
    .replace(/\r\n/g, "\n");
  const start = text.indexOf(`${CHARTER_HEADING}\n`);
  assert(start >= 0, `${role} skill has no ${CHARTER_HEADING} section`);
  const rest = text.slice(start + CHARTER_HEADING.length);
  const end = rest.search(/\n## /);
  return (CHARTER_HEADING + (end >= 0 ? rest.slice(0, end) : rest)).trimEnd();
}

const names = (list) =>
  list.length ? list.map((role) => ROLE_NAMES[role]).join(", ") : "없음";

/**
 * Prefixes a subordinate's task with its role, reporting line and charter.
 *
 * A dispatched worker sees only the spec, so a spec that opens with the task
 * leaves the worker to guess where its role ends. The header is derived from
 * the organization and the run: the parent it reports to, the roles absent from
 * the run whose work folds onto this one, the roles it may start as workers,
 * and the organization and workflow files a nested supervisor launches from.
 *
 * @param {object} requestedOrg - Organization document.
 * @param {string} requestedRole - Role receiving the task, declared or not.
 * @param {string} spec - Concrete task text.
 * @param {object} [run={}] - Run context.
 * @param {string[]} [run.roles] - Roles the run uses, when it recorded them.
 * @param {string} [run.orgFile] - Organization file the launch read.
 * @param {string} [run.workflowId] - Workflow the task belongs to.
 * @param {string} [run.stateDir] - PM worktree state directory of that workflow.
 * @returns {string} Header, charter and task, in that order.
 * @throws {Error} When the role is unknown or the task is empty.
 */
export function roleSpec(
  requestedOrg,
  requestedRole,
  spec,
  { roles, orgFile, workflowId, stateDir } = {},
) {
  const org = validateOrg(requestedOrg);
  assert(typeof spec === "string" && spec.trim(), "Spec text required");
  const declared = activeRoles(org, roles);
  const role = foldRole(declared, requestedRole);
  // The reporting line follows the run: a parent the run left out hands its
  // reports to whichever role took its work over.
  const parentRole = org.roles[role].parent;
  const parent = parentRole && foldRole(declared, parentRole);
  const inherited = ROLES.filter(
    (other) => !declared.includes(other) && foldRole(declared, other) === role,
  );
  const dispatchable = [
    ...new Set(
      [role, ...inherited].flatMap((holder) => DISPATCH_AUTHORITY[holder]),
    ),
  ].filter((other) => declared.includes(other) && other !== role);
  return [
    "# oh my teams 역할 지시",
    `역할: ${ROLE_NAMES[role]} (조직 revision ${org.revision})`,
    `보고 대상: ${parent ? ROLE_NAMES[parent] : "사용자"}`,
    `이번 실행에 없어 이어받는 역할: ${names(inherited)}`,
    `직접 배정할 수 있는 역할: ${names(ROLES.filter((r) => dispatchable.includes(r)))}`,
    ...(orgFile ? [`조직 파일: ${orgFile}`] : []),
    ...(workflowId ? [`workflow: ${workflowId} (state ${stateDir})`] : []),
    `역할 스킬 전문: ${path.join(skillsDir, role, "SKILL.md")}`,
    "",
    "아래 권한·책임·한계를 벗어나는 요청은 수행하지 않고, 거부 사유와 함께 보고 대상에게 돌려보낸다.",
    // Untracked files count toward verify's fingerprint, and the literacy-test
    // workers left node_modules and scratch scripts beside their report.
    "조사용 임시 스크립트, 의존성 설치, 내려받은 파일은 작업 워크트리가 아니라 워크트리 밖의 임시 디렉터리에서 만든다. 추적되지 않은 파일도 검증 증거의 지문에 들어가므로, 워크트리에 남기면 검증과 검토를 다시 해야 한다.",
    "",
    readRoleCharter(role),
    "",
    "# 작업",
    spec.trim(),
    "",
  ].join("\n");
}
