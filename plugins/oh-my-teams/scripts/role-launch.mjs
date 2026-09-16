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
 * Orca agent ids for the providers whose model Orca can pin at launch.
 *
 * `orchestration worker-start --model` supports Claude, Codex and Cursor. Agy
 * is `antigravity` to Orca, which launches it without a model selector, and
 * Ollama has no Orca agent at all, so neither appears here.
 */
export const ORCA_LAUNCH_AGENTS = Object.freeze({
  claude: "claude",
  codex: "codex",
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
const CUSTOM_ARGV =
  "use the custom argv path in references/orca-runtime.md (Agy 모델 선택)";

function launchableProfile(role, profileId, profile) {
  assert(
    Object.hasOwn(ORCA_LAUNCH_AGENTS, profile.provider),
    `Role ${role} uses provider ${profile.provider} (profile ${profileId}), which Orca cannot launch with a pinned model; ` +
      CUSTOM_ARGV,
  );
  // An Orca agent id names a binary, not an account. A profile that selects an
  // account through extra arguments or environment references would silently
  // run as whoever is logged in.
  assert(
    profile.account === "current" &&
      !profile.env &&
      profile.command.length === 1,
    `Role ${role} profile ${profileId} does not use the current account with a plain command; ` +
      CUSTOM_ARGV,
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

function contradiction(role, what, explicit, saved) {
  assert(
    explicit === undefined || explicit === saved,
    `Role ${role}: ${what} ${explicit} contradicts the saved profile (${saved ?? "host default"})`,
  );
}

/**
 * Resolves the Orca agent, model and effort a dispatched role must launch with.
 *
 * @param {object} requestedOrg - Organization document.
 * @param {string} requestedRole - Role the caller addresses, declared or not.
 * @param {object} [explicit={}] - Values the caller also passed on the CLI.
 * @param {string} [explicit.agent] - Orca agent id the caller named.
 * @param {string} [explicit.model] - Model id the caller named.
 * @param {string} [explicit.effort] - Effort the caller named.
 * @param {object} [run={}] - Run context.
 * @param {string[]} [run.roles] - Roles the run uses, when it recorded them.
 * @returns {object} Role, profile, provider, agent, model and effort to launch.
 * @throws {Error} For PM, an unlaunchable profile, or a contradicting value.
 */
export function resolveRoleLaunch(
  requestedOrg,
  requestedRole,
  explicit = {},
  { roles } = {},
) {
  const org = validateOrg(requestedOrg);
  const role = foldRole(activeRoles(org, roles), requestedRole);
  assert(
    role !== ROOT_ROLE,
    requestedRole === ROOT_ROLE
      ? "PM is the coordinator; launch it with role-command, not worker-start"
      : `${requestedRole} is not declared and its work folds to pm, the coordinator, which does it itself`,
  );
  const profileId = org.roles[role].profile;
  const profile = org.profiles[profileId];
  launchableProfile(role, profileId, profile);
  const agent = ORCA_LAUNCH_AGENTS[profile.provider];
  const effort = profile.effort ?? null;
  contradiction(role, "agent", explicit.agent, agent);
  contradiction(role, "model", explicit.model, profile.model);
  contradiction(role, "effort", explicit.effort, effort ?? undefined);
  return {
    requestedRole,
    role,
    profile: profileId,
    provider: profile.provider,
    agent,
    model: profile.model,
    effort,
  };
}

/**
 * Records what a launch requested and whether Orca's receipt proves the model.
 *
 * `launch.effective` is Orca's record of the launch arguments it applied, not
 * the model's own report, so `matched` still leaves the interactive screen to
 * confirm. A null requested model is `unrequested`: the agent runs its account
 * default, and no report may name a specific model from this receipt.
 *
 * @param {object} launch - Result of {@link resolveRoleLaunch}.
 * @param {object} started - Worker receipt from the Orca adapter.
 * @param {object} [options={}] - Launch circumstances.
 * @param {boolean} [options.reusedTerminal=false] - Whether a terminal was reused.
 * @returns {object} Requested values and a `modelProof` verdict.
 */
export function launchBinding(
  launch,
  started,
  { reusedTerminal = false } = {},
) {
  const effective = started?.receipt?.result?.launch?.effective;
  let modelProof;
  if (launch.model === null) modelProof = "unrequested";
  else if (reusedTerminal || !effective) modelProof = "unproven";
  else if (effective.model === launch.model) modelProof = "matched";
  else modelProof = "mismatched";
  return {
    requestedRole: launch.requestedRole,
    role: launch.role,
    profile: launch.profile,
    provider: launch.provider,
    agent: launch.agent,
    modelRequested: launch.model,
    effortRequested: launch.effort,
    modelProof,
  };
}

const SAFE_TOKEN = /^[A-Za-z0-9._:=/@+-]+$/;

// Single quotes are literal in both POSIX shells and PowerShell, the shells an
// Orca terminal runs, so one quoting rule serves both.
function shellToken(token) {
  if (SAFE_TOKEN.test(token)) return token;
  assert(!token.includes("'"), `Cannot quote argument: ${token}`);
  return `'${token}'`;
}

/**
 * Builds the interactive CLI command that launches a role with its saved model.
 *
 * `orca worktree create --agent` has no model option, so the coordinator is
 * launched with this command through `orca terminal create --command`.
 *
 * @param {object} requestedOrg - Organization document.
 * @param {string} requestedRole - Role to launch, declared or not.
 * @returns {object} Role, profile, argv, shell command and requested model.
 * @throws {Error} When the profile cannot be expressed as a plain CLI launch.
 */
export function roleCommand(requestedOrg, requestedRole) {
  const org = validateOrg(requestedOrg);
  const role = foldRole(definedRoles(org), requestedRole);
  const profileId = org.roles[role].profile;
  const profile = org.profiles[profileId];
  launchableProfile(role, profileId, profile);
  const argv = [...profile.command];
  if (profile.model) argv.push("--model", profile.model);
  // Codex takes effort only as a config override; Claude profiles cannot
  // record one, so this branch is Codex's alone.
  if (profile.effort) {
    argv.push("--config", `model_reasoning_effort=${profile.effort}`);
  }
  return {
    role,
    profile: profileId,
    provider: profile.provider,
    argv,
    command: argv.map(shellToken).join(" "),
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
 * the run whose work folds onto this one, and the roles it may start as workers.
 *
 * @param {object} requestedOrg - Organization document.
 * @param {string} requestedRole - Role receiving the task, declared or not.
 * @param {string} spec - Concrete task text.
 * @param {object} [run={}] - Run context.
 * @param {string[]} [run.roles] - Roles the run uses, when it recorded them.
 * @returns {string} Header, charter and task, in that order.
 * @throws {Error} When the role is unknown or the task is empty.
 */
export function roleSpec(requestedOrg, requestedRole, spec, { roles } = {}) {
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
    `역할 스킬 전문: ${path.join(skillsDir, role, "SKILL.md")}`,
    "",
    "아래 권한·책임·한계를 벗어나는 요청은 수행하지 않고, 거부 사유와 함께 보고 대상에게 돌려보낸다.",
    "",
    readRoleCharter(role),
    "",
    "# 작업",
    spec.trim(),
    "",
  ].join("\n");
}
