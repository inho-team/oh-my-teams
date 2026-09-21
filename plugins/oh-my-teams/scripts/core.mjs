/**
 * Shared filesystem, process, hashing, locking, and organization primitives.
 *
 * Security-sensitive modules depend on this file so path containment, atomic
 * writes, and command execution have one implementation and one test surface.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawn } from "node:child_process";
import {
  adapterFor,
  PROVIDER_EFFORTS as REGISTERED_EFFORTS,
  PROVIDER_IDS,
  transportFor,
} from "./providers/index.mjs";

/**
 * Stable role identifiers used by schemas, organization graphs, and reports.
 *
 * The order is a seniority ladder from most to least senior, and `resolveRole`
 * reads it that way. An organization may omit every role except `pm`, so a
 * responsibility addressed to an absent role folds upward along this array
 * until it reaches a role the organization actually declares.
 */
export const ROLES = ["pm", "pl", "senior", "junior"];

/**
 * Role names that no longer exist, mapped to the role that took over their work.
 *
 * Intern was removed in 2.6.0 and its narrow edits went to Junior. Workflow
 * snapshots, failure records, and review requirements saved before then still
 * name it, and running kickoffs may still ask for it, so those names are read
 * as the successor instead of failing. An organization file may not declare a
 * removed role; `validateOrg` refuses it with the way to migrate.
 */
export const LEGACY_ROLE_ALIASES = Object.freeze({ intern: "junior" });

/**
 * Maps a role name, current or removed, to the role that holds it now.
 *
 * @param {string} role - Role name as written by a caller or a saved record.
 * @returns {string} Current role name; unknown names are returned unchanged.
 */
export const canonicalRole = (role) => LEGACY_ROLE_ALIASES[role] ?? role;

/**
 * The top-level role that sits above PM in the full seniority ladder.
 *
 * A director is the host session that declared the kickoff: the sole channel
 * between the user and the team, the final authority for merges and close, and
 * the supervisor of every PM. Director is never launched as a supervised worker
 * or role terminal, so it does not appear in `ROLES` and is not bound in the
 * organization's `roles` map.
 */
export const DIRECTOR_ROLE = "director";

/**
 * Full seniority ladder from most to least senior, including the director.
 *
 * `ROLES` lists only the roles an organization may bind and launch as workers.
 * `ROLE_LADDER` adds the director so that authority checks and header
 * generation can express "above PM" without mixing director into the folding
 * or depth logic that `ROLES` drives.
 */
export const ROLE_LADDER = Object.freeze([DIRECTOR_ROLE, ...ROLES]);

/** The one role every organization must declare, and the root of its graph. */
export const ROOT_ROLE = "pm";

/**
 * Roles a run of each depth uses, from the most senior down.
 *
 * Roles join in the order a team misses them most. Implementation comes first,
 * because a PM alone has nobody to hand work to; independent review comes next;
 * and PL last, since splitting and integrating parallel waves only pays off
 * once there are several of them.
 * A role left out of a depth has its work folded upward by `foldRole`.
 */
export const DEPTH_ROLES = Object.freeze({
  1: Object.freeze(["pm"]),
  2: Object.freeze(["pm", "junior"]),
  3: Object.freeze(["pm", "senior", "junior"]),
  4: Object.freeze([...ROLES]),
});

/** Depth that uses every role an organization declares. */
export const FULL_DEPTH = 4;

// Depth 5 meant the full ladder while Intern existed. Saved workflows keep that
// number, and the full ladder is now depth 4, so it is read as the full depth.
const LEGACY_FULL_DEPTH = 5;

/**
 * Lists the roles a run of one depth uses within an organization's ladder.
 *
 * An organization reduced through adjust may not declare every role a depth
 * names, so the result is the depth's roles that the organization declares.
 * PM is always among them because every organization declares it.
 *
 * @param {string[]} declared - Roles the organization declares.
 * @param {number} depth - Run depth from 1 to 4; a saved depth 5 reads as 4.
 * @returns {string[]} Active roles in ladder order.
 * @throws {Error} When the depth is outside 1..4.
 */
export function depthRoles(declared, depth) {
  const roles = DEPTH_ROLES[depth === LEGACY_FULL_DEPTH ? FULL_DEPTH : depth];
  assert(roles, `Depth must be 1..${FULL_DEPTH}`);
  const present = new Set(declared);
  return roles.filter((role) => present.has(role));
}

/**
 * Model-policy values an organization may record.
 *
 * `custom` means the roles were bound by hand. Every other value names a preset
 * in `presets.mjs`, which owns what each one does.
 */
export const MODEL_POLICY_PRESETS = [
  "custom",
  "opus-first",
  "balanced",
  "single-subscription",
  "advisor-codex",
  "advisor-claude",
];

/**
 * Lists the roles an organization declares, ordered from most to least senior.
 *
 * @param {object} org - Organization whose `roles` map is read.
 * @returns {string[]} Declared role identifiers in `ROLES` order.
 */
export const definedRoles = (org) =>
  ROLES.filter((role) => Object.hasOwn(org.roles ?? {}, role));

/**
 * Folds a responsibility addressed to one role onto the role that holds it.
 *
 * A reduced organization omits roles rather than renaming them, so failure
 * routing, review requirements, and assistant drafting keep naming the role
 * that owns the work in a full team. This resolves that name to the closest
 * senior role actually declared, which terminates at `pm` because `validateOrg`
 * requires it.
 *
 * Takes the declared names rather than the organization so a persisted workflow
 * can fold a later routing decision from the role list it recorded at creation,
 * without reopening an organization file that may have been revised since.
 *
 * @param {string[]} declared - Declared role identifiers.
 * @param {string} role - Role the caller addressed, declared or not.
 * @returns {string} Declared role that carries the responsibility.
 * @throws {Error} When the name is not a known role or nothing declares it.
 */
export function foldRole(declared, role) {
  const rank = ROLES.indexOf(canonicalRole(role));
  assert(rank >= 0, `Unknown role: ${role}`);
  const present = new Set((declared ?? []).map(canonicalRole));
  for (let index = rank; index >= 0; index -= 1) {
    if (present.has(ROLES[index])) return ROLES[index];
  }
  throw new Error(`No declared role can take over from ${role}`);
}

/**
 * Folds a role onto the declared role of one organization.
 *
 * @param {object} org - Validated organization.
 * @param {string} role - Role the caller addressed, declared or not.
 * @returns {string} Declared role that carries the responsibility.
 * @throws {Error} When the name is not a known role or nothing declares it.
 */
export const resolveRole = (org, role) => foldRole(definedRoles(org), role);

/**
 * Reasoning-effort values each provider accepts, re-exported from the registry.
 *
 * Each adapter states the levels its own provider accepts, verified against the
 * installed CLI or documented API rather than assumed, so adding a provider does
 * not mean editing a table here.
 */
export const PROVIDER_EFFORTS = REGISTERED_EFFORTS;

/**
 * Produces a SHA-256 digest for a string or JSON-serializable value.
 *
 * @param {string | unknown} value - Data to hash. Non-strings use JSON encoding.
 * @returns {string} Lowercase hexadecimal SHA-256 digest.
 */
export const hash = (value) =>
  crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");

/**
 * Reads a UTF-8 JSON document, accepting an optional byte-order mark.
 *
 * @param {string | URL} file - JSON file path or URL.
 * @returns {unknown} Parsed JSON value.
 * @throws {Error} When the file cannot be read or does not contain valid JSON.
 */
export const readJSON = (file) =>
  JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));

/**
 * Reads all `.json` files in a directory in deterministic name order.
 *
 * @param {string} directory - Directory whose direct children are records.
 * @returns {unknown[]} Parsed JSON records, or an empty array when absent.
 * @throws {Error} When a present entry cannot be read or parsed.
 */
export function readJsonDirectory(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJSON(path.join(directory, name)));
}

/**
 * Atomically writes private, formatted JSON through a same-directory temp file.
 *
 * @param {string} file - Destination path.
 * @param {unknown} value - JSON-serializable value.
 * @returns {void}
 * @throws {Error} When serialization or a filesystem operation fails.
 */
export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporaryFile = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporaryFile, file);
}

/**
 * Throws a normal Error when a runtime contract is not satisfied.
 *
 * @param {unknown} condition - Truthy value when the contract holds.
 * @param {string} message - Error message used when the contract fails.
 * @returns {asserts condition}
 * @throws {Error} When `condition` is falsy.
 */
export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Runs a synchronous critical section while holding an exclusive lock file.
 *
 * The callback may mutate state only after the lock has been acquired. The lock
 * is removed in `finally`, including when validation or persistence fails.
 *
 * @template T
 * @param {string} lockFile - Exact lock path; parent directories are created.
 * @param {() => T} callback - Critical section to execute once.
 * @param {string} [busyMessage='Update in progress'] - Concurrent-owner error.
 * @returns {T} Callback result.
 * @throws {Error} When the lock is owned or the callback fails.
 */
export function withFileLock(
  lockFile,
  callback,
  busyMessage = "Update in progress",
) {
  const release = acquireFileLock(lockFile, busyMessage);
  try {
    return callback();
  } finally {
    release();
  }
}

/**
 * Holds the same exclusive lock throughout an asynchronous transaction.
 * @param {string} lockFile - Exact lock path.
 * @param {Function} callback - Async critical section.
 * @param {string} [busyMessage] - Concurrent owner error message.
 * @returns {Promise<unknown>} Callback result after its work settles.
 * @throws {Error} On a live lock conflict or callback failure.
 */
export async function withAsyncFileLock(
  lockFile,
  callback,
  busyMessage = "Update in progress",
) {
  const release = acquireFileLock(lockFile, busyMessage);
  try {
    return await callback();
  } finally {
    release();
  }
}

function discard(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone, or owned by someone who will clean it up.
  }
}

/**
 * Reports whether a lock file names an owner on this host that has exited.
 *
 * Unknown, foreign, and live owners all answer `false`, so a lock is only ever
 * reclaimed from a process this host can prove is gone.
 *
 * @param {string} file - Lock file recording `{pid, hostname}`.
 * @returns {boolean} Whether the recorded owner is a dead local process.
 */
export function ownerHasExited(file) {
  let owner;
  try {
    owner = readJSON(file);
  } catch {
    return false;
  }
  if (
    owner?.hostname !== os.hostname() ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0
  ) {
    return false;
  }
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

// Creates `file` exclusively, reclaiming it once when the recorded owner has
// exited. The exclusive create is atomic, so a process that loses the race to
// reclaim sees EEXIST again and is refused rather than sharing the lock.
function claimExclusive(file, busyMessage) {
  try {
    return fs.openSync(file, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    assert(ownerHasExited(file), busyMessage);
    discard(file);
    try {
      return fs.openSync(file, "wx");
    } catch {
      throw new Error(busyMessage);
    }
  }
}

function recordOwner(descriptor, file) {
  try {
    fs.writeFileSync(
      descriptor,
      JSON.stringify({ pid: process.pid, hostname: os.hostname() }),
    );
  } catch (error) {
    fs.closeSync(descriptor);
    discard(file);
    throw error;
  }
}

function acquireFileLock(lockFile, busyMessage) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  let descriptor;
  try {
    descriptor = fs.openSync(lockFile, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    // Serialize recovery separately. The recovery file records its own owner:
    // an empty marker left behind by a process killed mid-recovery used to
    // fail every later attempt, stranding the lock until someone deleted it.
    const recoveryFile = `${lockFile}.recovery`;
    const recovery = claimExclusive(recoveryFile, busyMessage);
    try {
      recordOwner(recovery, recoveryFile);
      assert(ownerHasExited(lockFile), busyMessage);
      discard(lockFile);
      descriptor = fs.openSync(lockFile, "wx");
    } finally {
      fs.closeSync(recovery);
      discard(recoveryFile);
    }
  }

  recordOwner(descriptor, lockFile);
  return () => {
    fs.closeSync(descriptor);
    // Releasing must not replace the caller's own error in a finally block.
    discard(lockFile);
  };
}

const FORBIDDEN_SEGMENTS = new Set(["..", ".git", ".orca", ".omt"]);

// Windows and macOS open ".GIT" as ".git", and Windows additionally ignores
// trailing dots and spaces, so an exact-string comparison lets ".GIT/config"
// and ".git./config" reach real repository state. Compare a normalized
// segment instead, keeping the raw value when normalization empties it so
// that ".." stays forbidden.
function segment(part) {
  const lowered = part.toLowerCase();
  return lowered.replace(/[.\s]+$/, "") || lowered;
}

/**
 * Resolves an allowed relative path without permitting workspace escape.
 *
 * Both lexical traversal and symlink traversal through the nearest existing
 * ancestor are rejected. `.git`, `.orca`, and `.omt` are always outside edit
 * scope because they contain repository or PM-owned state, and the
 * comparison is made on a normalized segment so that a case-insensitive or
 * trailing-dot spelling cannot reach the same directory.
 *
 * @param {string} root - Existing workspace root.
 * @param {string} relative - Non-empty relative path within the workspace.
 * @returns {string} Absolute contained path, which may not exist yet.
 * @throws {Error} When the path is absolute, forbidden, or escapes `root`.
 */
export function inside(root, relative) {
  assert(
    typeof relative === "string" && relative && !path.isAbsolute(relative),
    "A relative file path is required",
  );
  assert(
    !relative
      .split(/[\\/]/)
      .some((part) => FORBIDDEN_SEGMENTS.has(segment(part))),
    `Forbidden path: ${relative}`,
  );

  const base = fs.realpathSync(root);
  const target = path.resolve(base, relative);
  let ancestor = target;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);

  const realAncestor = fs.realpathSync(ancestor);
  assert(
    realAncestor === base || realAncestor.startsWith(`${base}${path.sep}`),
    `Path escapes workspace: ${relative}`,
  );
  assert(
    target.startsWith(`${base}${path.sep}`),
    `Path escapes workspace: ${relative}`,
  );
  return target;
}

// Windows installs an npm CLI as a `.cmd` shim, and Node refuses to spawn one
// without a shell. Using a shell is not an option here: model text travels in
// these arguments. The package that declares the command is located instead and
// its JS entry is run through this Node binary, which needs no shell. This used
// to be hardcoded for `codex` alone, so every other npm-installed provider and
// `claude plugin list` failed with a bare ENOENT.
function npmGlobalEntry(name, env) {
  const root = path.join(env.APPDATA || "", "npm", "node_modules");
  if (!fs.existsSync(root)) return null;

  const packages = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    if (!entry.name.startsWith("@")) {
      packages.push(directory);
      continue;
    }
    for (const scoped of fs.readdirSync(directory, { withFileTypes: true })) {
      if (scoped.isDirectory())
        packages.push(path.join(directory, scoped.name));
    }
  }

  for (const directory of packages) {
    let manifest;
    try {
      manifest = readJSON(path.join(directory, "package.json"));
    } catch {
      continue;
    }
    const declared =
      typeof manifest.bin === "string"
        ? manifest.name?.split("/").pop() === name
          ? manifest.bin
          : null
        : manifest.bin?.[name];
    if (!declared) continue;
    const entry = path.resolve(directory, declared);
    if (fs.existsSync(entry)) return entry;
  }
  return null;
}

/**
 * Resolves an argv so `spawn` can start it without a shell on every platform.
 *
 * @param {string[]} argv - Executable followed by literal arguments.
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment used to find npm shims.
 * @returns {string[]} The argv to spawn; on Windows an npm-installed CLI runs through Node.
 */
export function resolveCommand(argv, env = process.env) {
  const [name, ...rest] = argv;
  if (process.platform !== "win32") return argv;
  // An explicit path or extension is already something spawn can execute.
  if (path.isAbsolute(name) || /[\\/]/.test(name) || path.extname(name)) {
    return argv;
  }
  const entry = npmGlobalEntry(name, env);
  return entry ? [process.execPath, entry, ...rest] : argv;
}

/**
 * Executes an argv array without shell interpolation and captures bounded output.
 *
 * @param {string[]} argv - Executable followed by literal arguments.
 * @param {object} [options] - Process execution options.
 * @param {string} [options.cwd] - Child working directory.
 * @param {string} [options.input=''] - UTF-8 stdin payload.
 * @param {number} [options.timeoutMs=300000] - Time before requesting termination.
 * @param {NodeJS.ProcessEnv} [options.env=process.env] - Child environment.
 * @param {number} [options.maxBytes=8388608] - Combined output safety limit.
 * @returns {Promise<object>} Exit code, output, timeout, overflow, PID, and timing.
 * @throws {Error} When `argv` is not a non-empty string array.
 */
export function run(
  argv,
  {
    cwd,
    input = "",
    timeoutMs = 300000,
    env = process.env,
    maxBytes = 8 * 1024 * 1024,
  } = {},
) {
  assert(
    Array.isArray(argv) &&
      argv.length > 0 &&
      argv.every((argument) => typeof argument === "string"),
    "Command must be an argv array",
  );

  const command = resolveCommand(argv, env);

  return new Promise((resolve) => {
    const startedAt = Date.now();
    // A shell would reinterpret model/user text embedded in arguments.
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let overflow = false;
    let finished = false;
    let fallbackTimer;
    // Track accumulated byte length to avoid re-computing on every chunk.
    let totalBytes = 0;

    const finish = (code, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer);
      clearTimeout(fallbackTimer);
      resolve({
        code: code ?? -1,
        stdout,
        stderr: stderr + (error ? String(error.message) : ""),
        timedOut,
        overflow,
        pid: child.pid ?? null,
        elapsedMs: Date.now() - startedAt,
      });
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill();
      // Some process trees never deliver `close`; return an uncertain result.
      fallbackTimer = setTimeout(() => finish(-1), 1000);
    }, timeoutMs);

    for (const [stream, streamName] of [
      [child.stdout, "stdout"],
      [child.stderr, "stderr"],
    ]) {
      stream.setEncoding("utf8");
      stream.on("data", (data) => {
        totalBytes += Buffer.byteLength(data);
        if (streamName === "stdout") stdout += data;
        else stderr += data;

        if (totalBytes > maxBytes) {
          overflow = true;
          stdout = stdout.slice(0, maxBytes / 2);
          stderr = stderr.slice(0, maxBytes / 2);
          // Recompute after slicing so subsequent chunks are measured correctly.
          totalBytes = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
          child.kill();
          // Some process trees never deliver `close`; return an uncertain result.
          fallbackTimer = setTimeout(() => finish(-1), 1000);
        }
      });
    }

    child.on("error", (error) => finish(-1, error));
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function validatePools(pools = {}) {
  assert(
    typeof pools === "object" && !Array.isArray(pools),
    "pools must be an object when provided",
  );
  for (const [id, pool] of Object.entries(pools)) {
    assert(/^[a-z0-9][a-z0-9-]*$/.test(id), `Invalid pool id: ${id}`);
    assert(
      pool && typeof pool.label === "string" && pool.label.trim(),
      `Pool label required: ${id}`,
    );
  }
}

function validateEffort(id, profile) {
  if (profile.effort === undefined) return;
  const accepted = PROVIDER_EFFORTS[profile.provider] ?? [];
  assert(
    accepted.length > 0,
    `Provider ${profile.provider} has no reasoning-effort selector: ${id}`,
  );
  assert(
    accepted.includes(profile.effort),
    `Effort for ${id} must be one of ${accepted.join("|")}`,
  );
}

function validateProfile(id, profile, pools) {
  assert(/^[a-z0-9][a-z0-9-]*$/.test(id), `Invalid profile id: ${id}`);
  assert(PROVIDER_IDS.includes(profile.provider), `Invalid provider: ${id}`);
  assert(
    typeof profile.subscription === "string" && profile.subscription.trim(),
    `Subscription label required: ${id}`,
  );
  // Throws when the profile names neither transport, names both, or names one
  // its provider cannot serve, so the checks below know which shape applies.
  const transport = transportFor(profile);
  assert(
    transport !== "process" ||
      (profile.command.length > 0 &&
        profile.command.every(
          (argument) => typeof argument === "string" && argument,
        )),
    `Command argv required: ${id}`,
  );
  assert(
    profile.model === null ||
      (typeof profile.model === "string" && profile.model.trim()),
    `Model must be an ID or null (host default): ${id}`,
  );
  assert(
    profile.account === "current" ||
      (typeof profile.account === "string" && profile.account.trim()),
    `Account profile reference required: ${id}`,
  );
  validateEffort(id, profile);
  assert(
    profile.pool === undefined || Object.hasOwn(pools, profile.pool),
    `Unknown pool for profile: ${id}`,
  );
  assert(
    !profile.env ||
      Object.entries(profile.env).every(
        ([target, source]) =>
          /^[A-Z_][A-Z0-9_]*$/.test(target) &&
          /^[A-Z_][A-Z0-9_]*$/.test(source),
      ),
    "env values must name source environment variables, never secrets",
  );
  if (profile.account !== "current") {
    assert(
      (profile.env && Object.keys(profile.env).length > 0) ||
        (transport === "process" && profile.command.length > 1),
      `Named account ${id} needs an actual command/profile or environment binding`,
    );
  }
  // Rules only the provider itself can state, such as a required context window
  // or an effort the model identifier already contradicts.
  adapterFor(profile).validateProfile?.(id, profile);
}

function validateRole(role, binding, org) {
  assert(
    Object.hasOwn(org.profiles, binding.profile),
    `Unknown profile for ${role}`,
  );
  assert(
    Number.isInteger(binding.concurrency) &&
      binding.concurrency >= 1 &&
      binding.concurrency <= 32,
    `Invalid concurrency: ${role}`,
  );
  assert(
    Number.isInteger(binding.attempts) &&
      binding.attempts >= 1 &&
      binding.attempts <= 5,
    `Invalid attempts: ${role}`,
  );
  // A reduced organization may omit roles, so naming a role the organization
  // never declared would leave this binding unreachable from PM instead of
  // merely misplaced, and the cycle walk below would end at an absent parent
  // without noticing the break.
  assert(
    binding.parent === null ||
      (Object.hasOwn(org.roles, binding.parent) && binding.parent !== role),
    `Invalid parent: ${role}`,
  );
  assert(
    role === ROOT_ROLE ? binding.parent === null : binding.parent !== null,
    "PM must be the only root",
  );

  const ancestors = new Set([role]);
  for (
    let parent = binding.parent;
    parent;
    parent = org.roles[parent]?.parent
  ) {
    assert(!ancestors.has(parent), "Organization cycle");
    ancestors.add(parent);
  }

  assert(
    Array.isArray(binding.fallbacks) &&
      new Set(binding.fallbacks).size === binding.fallbacks.length &&
      !binding.fallbacks.includes(binding.profile) &&
      binding.fallbacks.every((profile) =>
        Object.hasOwn(org.profiles, profile),
      ),
    `Invalid fallbacks: ${role}`,
  );
}

/**
 * Validates the complete organization graph and execution policy.
 *
 * @param {object} org - Organization configuration with schema version 1.
 * @returns {object} The same validated organization object.
 * @throws {Error} For malformed profiles, cycles, roots, fallbacks, or policy.
 */
export function validateOrg(org) {
  assert(
    org?.schemaVersion === 1 && typeof org.name === "string" && org.name.trim(),
    "Organization name and schemaVersion=1 required",
  );
  assert(
    Number.isInteger(org.revision) && org.revision >= 1,
    "Positive revision required",
  );
  assert(
    org.profiles && org.roles && org.policy,
    "profiles, roles and policy required",
  );

  if (org.modelPolicy) {
    assert(
      MODEL_POLICY_PRESETS.includes(org.modelPolicy.preset),
      `Model policy preset must be one of ${MODEL_POLICY_PRESETS.join("/")}`,
    );
    assert(
      Number.isInteger(org.modelPolicy.revision) &&
        org.modelPolicy.revision >= 1,
      "Model policy revision required",
    );
  }

  const pools = org.pools ?? {};
  validatePools(pools);
  for (const [id, profile] of Object.entries(org.profiles)) {
    validateProfile(id, profile, pools);
  }

  // An organization may run a reduced ladder, so only PM is mandatory. Role
  // names stay fixed because routing, skills, and reports address them by name;
  // a reduced team omits a role rather than inventing one.
  for (const [removed, successor] of Object.entries(LEGACY_ROLE_ALIASES)) {
    assert(
      !Object.hasOwn(org.roles, removed),
      `Role ${removed} was removed in 2.6.0; move its profile to ${successor} ` +
        `and delete ${removed} with the adjust skill`,
    );
  }
  assert(
    Object.keys(org.roles).every((role) => ROLES.includes(role)),
    `Roles must be named from ${ROLES.join("/")}`,
  );
  assert(
    Object.hasOwn(org.roles, ROOT_ROLE),
    `Role ${ROOT_ROLE.toUpperCase()} is required`,
  );
  for (const role of definedRoles(org)) {
    validateRole(role, org.roles[role], org);
  }

  if (org.assistants) {
    for (const [role, profiles] of Object.entries(org.assistants)) {
      assert(Object.hasOwn(org.roles, role), `Unknown assistant role: ${role}`);
      assert(
        Array.isArray(profiles) &&
          profiles.length > 0 &&
          new Set(profiles).size === profiles.length &&
          profiles.every(
            (profile) =>
              Object.hasOwn(org.profiles, profile) &&
              org.profiles[profile].model === "gpt-oss-120b-medium",
          ),
        `Invalid assistant profiles: ${role}`,
      );
    }
  }

  if (org.advisors) {
    for (const [role, profiles] of Object.entries(org.advisors)) {
      assert(Object.hasOwn(org.roles, role), `Unknown advisor role: ${role}`);
      assert(
        Array.isArray(profiles) &&
          profiles.length > 0 &&
          new Set(profiles).size === profiles.length &&
          profiles.every((profile) => Object.hasOwn(org.profiles, profile)),
        `Invalid advisor profiles: ${role}`,
      );
    }
  }

  assert(
    ["stop", "fallback"].includes(org.policy.onExhaustion),
    "onExhaustion must be stop or fallback",
  );
  assert(
    Number.isInteger(org.policy.maxCalls) &&
      org.policy.maxCalls >= 1 &&
      org.policy.maxCalls <= 20,
    "maxCalls must be 1..20",
  );
  assert(
    Number.isInteger(org.policy.timeoutMs) &&
      org.policy.timeoutMs >= 1000 &&
      org.policy.timeoutMs <= 600000,
    "timeoutMs must be 1000..600000",
  );
  assert(
    Number.isInteger(org.policy.repeatFailureLimit) &&
      org.policy.repeatFailureLimit >= 1,
    "repeatFailureLimit required",
  );
  validateSupervision(org.policy.supervision);
  assert(
    org.policy.adviceBudget === undefined ||
      (Number.isInteger(org.policy.adviceBudget) &&
        org.policy.adviceBudget >= 1 &&
        org.policy.adviceBudget <= 50),
    "adviceBudget must be 1..50",
  );
  return org;
}

/**
 * Advisor calls one shared state directory may spend when the policy sets none.
 *
 * An advisor is the most expensive model an organization runs, so its calls are
 * counted per kickoff state rather than per task: a run that keeps asking is a
 * run whose plan needs a person, not another opinion.
 */
export const ADVICE_BUDGET_DEFAULT = 6;

/**
 * Reads how many advisor calls one shared state directory may spend.
 *
 * @param {object} org - Validated organization.
 * @returns {number} Effective advice budget.
 */
export function adviceBudget(org) {
  return org.policy?.adviceBudget ?? ADVICE_BUDGET_DEFAULT;
}

/**
 * Stall-handling values used when an organization records none.
 *
 * A supervisor asks a silent worker for progress after 15 minutes and escalates
 * after two unanswered requests. Asking costs one message and escalating costs
 * none, so the defaults spend nothing beyond what the organization already runs.
 */
export const SUPERVISION_DEFAULTS = Object.freeze({
  progressCheckMs: 900000,
  unansweredLimit: 2,
});

// Organizations saved before this policy existed carry no `supervision`, and
// they stay valid by reading the defaults. A present block must be complete, so
// a half-written edit is refused rather than silently merged.
function validateSupervision(supervision) {
  if (supervision === undefined) return;
  // An unknown key is most likely a misspelled one, which would otherwise be
  // ignored while the default it meant to replace keeps applying.
  assert(
    supervision &&
      typeof supervision === "object" &&
      Object.keys(supervision).every((key) =>
        Object.hasOwn(SUPERVISION_DEFAULTS, key),
      ),
    "supervision accepts only progressCheckMs and unansweredLimit",
  );
  assert(
    Number.isInteger(supervision.progressCheckMs) &&
      supervision.progressCheckMs >= 60000 &&
      supervision.progressCheckMs <= 86400000,
    "supervision.progressCheckMs must be 60000..86400000",
  );
  assert(
    Number.isInteger(supervision.unansweredLimit) &&
      supervision.unansweredLimit >= 1 &&
      supervision.unansweredLimit <= 10,
    "supervision.unansweredLimit must be 1..10",
  );
}

/**
 * Reads an organization's stall-handling policy, filling in the defaults.
 *
 * @param {object} org - Validated organization.
 * @returns {{progressCheckMs: number, unansweredLimit: number}} Effective policy.
 */
export function supervisionPolicy(org) {
  return { ...SUPERVISION_DEFAULTS, ...(org.policy?.supervision ?? {}) };
}

/**
 * Rewrites a snapshot saved before a role was removed so the current runtime reads it.
 *
 * Only snapshots go through this: a kickoff that started before 2.6.0 must be
 * able to finish on the organization it froze. A removed role's binding is
 * dropped when its successor is declared, or renamed to the successor when not,
 * and allowlists and parents that named it follow. A live organization file is
 * never migrated silently; `validateOrg` refuses it instead.
 *
 * @param {object} org - Organization snapshot, possibly from before 2.6.0.
 * @returns {object} A migrated copy, or the same object when nothing changed.
 */
export function migrateLegacyOrg(org) {
  if (!org?.roles) return org;
  const removed = Object.keys(LEGACY_ROLE_ALIASES).filter((role) =>
    Object.hasOwn(org.roles, role),
  );
  if (!removed.length) return org;
  const migrated = structuredClone(org);
  for (const role of removed) {
    const successor = LEGACY_ROLE_ALIASES[role];
    if (!Object.hasOwn(migrated.roles, successor)) {
      migrated.roles[successor] = migrated.roles[role];
    }
    delete migrated.roles[role];
    for (const binding of Object.values(migrated.roles)) {
      if (binding.parent === role) binding.parent = successor;
    }
    for (const key of ["assistants", "advisors"]) {
      if (!migrated[key]?.[role]) continue;
      migrated[key][successor] ??= migrated[key][role];
      delete migrated[key][role];
    }
  }
  return migrated;
}

/**
 * Creates or revision-updates an organization under an exclusive file lock.
 *
 * Existing configurations are returned unchanged unless `update` is explicit.
 * Every accepted update archives the previous revision before replacing it.
 *
 * @param {string} file - Active organization JSON path.
 * @param {object} org - Proposed organization document.
 * @param {object} [options] - Update controls.
 * @param {boolean} [options.update=false] - Whether replacement is requested.
 * @param {number} [options.expectedRevision] - Required optimistic revision.
 * @returns {{created: boolean, organization: object}} Persistence result.
 * @throws {Error} For invalid data, stale revisions, or concurrent updates.
 */
export function saveOrg(file, org, { update = false, expectedRevision } = {}) {
  return withFileLock(
    `${file}.lock`,
    () => {
      let previous;
      let previousRaw;
      if (fs.existsSync(file)) {
        previousRaw = readJSON(file);
        if (!update) {
          return { created: false, organization: validateOrg(previousRaw) };
        }
        // An edit is how a file still declaring a removed role gets repaired,
        // so the file being replaced is read through the migration; the new
        // content is validated strictly and the original is archived as-is.
        previous = validateOrg(migrateLegacyOrg(previousRaw));
        assert(
          expectedRevision === previous.revision,
          "Organization changed; read it again before editing",
        );
      } else {
        assert(!update, "No organization; run the form skill first");
      }

      const next = validateOrg({
        ...org,
        revision: previous ? previous.revision + 1 : 1,
      });
      if (previous) {
        writeJSON(
          path.join(
            path.dirname(file),
            "history",
            `org-${previous.revision}.json`,
          ),
          previousRaw,
        );
      }
      writeJSON(file, next);
      return { created: !previous, organization: next };
    },
    "Organization update in progress; read it again before editing",
  );
}

/**
 * Renders a deterministic text tree for an organization configuration.
 *
 * @param {object} org - Valid organization document.
 * @returns {string} Human-readable hierarchy with profile and slot details.
 * @throws {Error} When the organization is invalid.
 */
export function chart(org) {
  validateOrg(org);
  const lines = [`Organization: ${org.name} (revision ${org.revision})`];

  function visit(role, depth) {
    const binding = org.roles[role];
    const profile = org.profiles[binding.profile];
    lines.push(
      `${"  ".repeat(depth)}${role.toUpperCase()}: ${binding.profile}` +
        ` | ${profile.subscription}` +
        ` | ${profile.provider}/${profile.model ?? "host-default"}` +
        ` | effort=${profile.effort ?? "provider-default"}` +
        ` | slots=${binding.concurrency}`,
    );
    definedRoles(org)
      .filter((child) => org.roles[child].parent === role)
      .forEach((child) => visit(child, depth + 1));
  }

  visit(ROOT_ROLE, 0);
  for (const [role, profiles] of Object.entries(org.advisors ?? {})) {
    const models = profiles.map(
      (id) => `${id} (${org.profiles[id].model ?? "host-default"})`,
    );
    lines.push(`ADVISOR for ${role.toUpperCase()}: ${models.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Resolves a profile's environment-variable references without storing secrets.
 *
 * @param {object} profile - Profile whose values name source environment keys.
 * @returns {NodeJS.ProcessEnv} Child environment with resolved bindings.
 * @throws {Error} When a referenced source environment variable is absent.
 */
export function profileEnv(profile) {
  const environment = { ...process.env };
  for (const [target, source] of Object.entries(profile.env ?? {})) {
    assert(process.env[source], `Missing environment reference: ${source}`);
    environment[target] = process.env[source];
  }
  return environment;
}
