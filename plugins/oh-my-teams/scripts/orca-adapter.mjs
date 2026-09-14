/** Version-matched, narrow adapter for the external Orca CLI. */
import { assert, hash, run } from "./core.mjs";

/**
 * Selects one Orca executable for a session without silent fallback.
 *
 * @param {string | undefined} explicit - Caller-provided executable.
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment used for discovery.
 * @returns {string} Exact executable to reuse for subsequent Orca commands.
 */
export function selectOrcaExecutable(explicit, env = process.env) {
  if (explicit) return explicit;
  if (env.ORCA_CLI_COMMAND) return env.ORCA_CLI_COMMAND;
  if (env.ORCA_DEV_REPO_ROOT) return "orca-dev";
  if (process.platform === "linux" && env.TERM_PROGRAM !== "Orca")
    return "orca-ide";
  return "orca";
}

function parseJsonResponse(result, invalidMessage) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(invalidMessage);
  }
}

/**
 * Executes one Orca JSON command and validates its transport envelope.
 *
 * @param {string} executable - Previously selected Orca executable.
 * @param {string[]} args - Orca subcommand and literal arguments, without `--json`.
 * @param {object} [options] - Working directory, timeout, and injectable runner.
 * @returns {Promise<object>} Parsed Orca envelope whose `ok` value is not false.
 * @throws {Error} For process failure, timeout, invalid JSON, or `ok: false`.
 */
export async function runOrcaJson(
  executable,
  args,
  { cwd, timeoutMs = 60000, execute = run } = {},
) {
  const result = await execute([executable, ...args, "--json"], {
    cwd,
    timeoutMs,
  });
  assert(
    result.code === 0 && !result.timedOut,
    result.stderr || result.stdout || "Orca command failed",
  );
  const parsed = parseJsonResponse(result, "Orca response is not valid JSON");
  assert(parsed.ok !== false, JSON.stringify(parsed));
  return parsed;
}

/**
 * Captures CLI/runtime versions and the version-matched Orca guide hash.
 *
 * @param {string} [executable] - Explicit Orca executable, if already selected.
 * @param {Function} [execute=run] - Injectable command runner for tests.
 * @returns {Promise<object>} Immutable runtime discovery receipt.
 * @throws {Error} When the binary, guide, status, or runtime readiness fails.
 */
export async function discoverOrcaRuntime(executable, execute = run) {
  const selected = selectOrcaExecutable(executable);
  const version = await execute([selected, "--version"], { timeoutMs: 30000 });
  assert(
    version.code === 0 && !version.timedOut,
    `Selected Orca executable failed: ${version.stderr || version.stdout}`,
  );

  const guide = await execute([selected, "skills", "get", "orca-cli"], {
    timeoutMs: 60000,
  });
  assert(
    guide.code === 0 && !guide.timedOut,
    `Orca guide discovery failed: ${guide.stderr || guide.stdout}`,
  );

  const status = await execute([selected, "status", "--json"], {
    timeoutMs: 30000,
  });
  assert(
    status.code === 0 && !status.timedOut,
    `Orca status failed: ${status.stderr || status.stdout}`,
  );
  const parsed = parseJsonResponse(
    status,
    "Orca status response is not valid JSON",
  );
  assert(
    parsed.ok !== false &&
      parsed.result?.runtime?.reachable === true &&
      parsed.result.runtime.state === "ready",
    "Orca runtime is not ready",
  );

  const cliVersion = version.stdout.trim();
  const runtimeVersion = parsed.result.runtime.appVersion ?? null;
  return {
    schemaVersion: 1,
    executable: selected,
    cliVersion,
    runtimeVersion,
    versionsMatch: runtimeVersion === null || cliVersion === runtimeVersion,
    runtimeId:
      parsed.result.runtime.runtimeId ?? parsed._meta?.runtimeId ?? null,
    guide: { id: "orca-cli", sha256: hash(guide.stdout) },
    discoveredAt: new Date().toISOString(),
  };
}

/**
 * Creates a child worktree using the currently documented Orca contract.
 *
 * @param {string} repo - Parent repository/worktree path.
 * @param {object} options - Worktree creation options.
 * @param {string} options.name - Lowercase worktree display name.
 * @param {string} options.base - Resolved Git base commit.
 * @param {'inherit' | 'run' | 'skip'} [options.setup='inherit'] - Orca setup policy.
 * @param {object} [options.discovery] - Existing matching runtime receipt.
 * @param {string} [options.executable] - Selected Orca executable.
 * @param {Function} [options.execute=run] - Injectable command runner.
 * @returns {Promise<object>} Discovery, raw receipt, and worktree identity.
 * @throws {Error} When creation fails or the receipt lacks identity fields.
 */
export async function createWorktree(
  repo,
  {
    name,
    base,
    setup = "inherit",
    discovery: suppliedDiscovery,
    executable,
    execute = run,
  },
) {
  assert(
    ["inherit", "run", "skip"].includes(setup),
    "Invalid Orca setup policy",
  );
  const selected = selectOrcaExecutable(
    executable ?? suppliedDiscovery?.executable,
  );
  const discovery =
    suppliedDiscovery ?? (await discoverOrcaRuntime(selected, execute));
  assert(
    discovery.executable === selected && discovery.versionsMatch !== false,
    "Supplied Orca discovery does not match the selected executable",
  );
  const started = await execute(
    [
      selected,
      "worktree",
      "create",
      "--name",
      name,
      "--parent-worktree",
      "active",
      "--base-branch",
      base,
      "--setup",
      setup,
      "--json",
    ],
    { cwd: repo, timeoutMs: 60000 },
  );
  assert(
    started.code === 0 && !started.timedOut,
    "Orca workspace creation failed; inspect residual resources before retry: " +
      (started.stderr || started.stdout),
  );

  const receipt = parseJsonResponse(
    started,
    "Orca workspace receipt is not valid JSON",
  );
  assert(
    receipt.ok !== false &&
      receipt.result?.worktree?.path &&
      receipt.result.worktree.id,
    "Orca receipt missing worktree identity",
  );
  return {
    executable: selected,
    discovery,
    receipt,
    worktree: receipt.result.worktree,
  };
}
