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

/** Stable role identifiers used by schemas, organization graphs, and reports. */
export const ROLES = ["pm", "pl", "senior", "junior", "intern"];

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

function acquireFileLock(lockFile, busyMessage) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  let descriptor;
  try {
    descriptor = fs.openSync(lockFile, "wx");
  } catch (error) {
    if (error.code === "EEXIST") {
      // Serialize recovery separately. Unknown/foreign/live owners stay locked.
      const recoveryFile = `${lockFile}.recovery`;
      let recovery;
      try {
        recovery = fs.openSync(recoveryFile, "wx");
      } catch {
        throw new Error(busyMessage);
      }
      try {
        let owner;
        try {
          owner = readJSON(lockFile);
        } catch {
          throw new Error(busyMessage);
        }
        assert(
          owner.hostname === os.hostname() &&
            Number.isInteger(owner.pid) &&
            owner.pid > 0,
          busyMessage,
        );
        let exited = false;
        try {
          process.kill(owner.pid, 0);
        } catch (probeError) {
          exited = probeError.code === "ESRCH";
        }
        assert(exited, busyMessage);
        fs.unlinkSync(lockFile);
        descriptor = fs.openSync(lockFile, "wx");
      } finally {
        fs.closeSync(recovery);
        fs.unlinkSync(recoveryFile);
      }
    } else {
      throw error;
    }
  }

  try {
    fs.writeFileSync(
      descriptor,
      JSON.stringify({ pid: process.pid, hostname: os.hostname() }),
    );
  } catch (error) {
    fs.closeSync(descriptor);
    fs.unlinkSync(lockFile);
    throw error;
  }
  return () => {
    fs.closeSync(descriptor);
    fs.unlinkSync(lockFile);
  };
}

/**
 * Resolves an allowed relative path without permitting workspace escape.
 *
 * Both lexical traversal and symlink traversal through the nearest existing
 * ancestor are rejected. `.git`, `.orca`, and `.omt` are always outside edit
 * scope because they contain repository or coordinator-owned state.
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
      .some((part) => ["..", ".git", ".orca", ".omt"].includes(part)),
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

  let command = argv;
  if (process.platform === "win32" && command[0] === "codex") {
    const entry = path.join(
      env.APPDATA || "",
      "npm",
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    if (fs.existsSync(entry))
      command = [process.execPath, entry, ...command.slice(1)];
  }

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
        if (streamName === "stdout") stdout += data;
        else stderr += data;

        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBytes) {
          overflow = true;
          stdout = stdout.slice(0, maxBytes / 2);
          stderr = stderr.slice(0, maxBytes / 2);
          child.kill();
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

function validateProfile(id, profile, pools) {
  assert(/^[a-z0-9][a-z0-9-]*$/.test(id), `Invalid profile id: ${id}`);
  assert(
    ["claude", "codex", "agy"].includes(profile.provider),
    `Invalid provider: ${id}`,
  );
  assert(
    typeof profile.subscription === "string" && profile.subscription.trim(),
    `Subscription label required: ${id}`,
  );
  assert(
    Array.isArray(profile.command) &&
      profile.command.length > 0 &&
      profile.command.every(
        (argument) => typeof argument === "string" && argument,
      ),
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
        profile.command.length > 1,
      `Named account ${id} needs an actual command/profile or environment binding`,
    );
  }
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
  assert(
    binding.parent === null ||
      (ROLES.includes(binding.parent) && binding.parent !== role),
    `Invalid parent: ${role}`,
  );
  assert(
    role === "pm" ? binding.parent === null : binding.parent !== null,
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
      ["custom", "opus-first", "balanced"].includes(org.modelPolicy.preset),
      "Invalid model policy preset",
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

  assert(
    Object.keys(org.roles).length === ROLES.length &&
      ROLES.every((role) => role in org.roles),
    "Exactly PM/PL/Senior/Junior/Intern required",
  );
  for (const role of ROLES) validateRole(role, org.roles[role], org);

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
  return org;
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
      if (fs.existsSync(file)) {
        previous = validateOrg(readJSON(file));
        if (!update) return { created: false, organization: previous };
        assert(
          expectedRevision === previous.revision,
          "Organization changed; read it again before editing",
        );
      } else {
        assert(!update, "No organization; run team-setup first");
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
          previous,
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
        ` | slots=${binding.concurrency}`,
    );
    ROLES.filter((child) => org.roles[child].parent === role).forEach((child) =>
      visit(child, depth + 1),
    );
  }

  visit("pm", 0);
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
