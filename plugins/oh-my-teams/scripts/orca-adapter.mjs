/** Version-matched, narrow adapter for the external Orca CLI. */
import { assert, hash, run } from "./core.mjs";
import {
  assertFailureSignal,
  assertWorkerReceipt,
  assertWorkspaceReceipt,
} from "./execution.mjs";

/**
 * Neutral routing hints for the codes this Orca contract actually returns.
 *
 * Keeping the table here rather than in failure routing is what lets a second
 * execution runtime be added without teaching the classifier Orca's words.
 * Codes absent from this table stay unclassified on purpose: inventing a route
 * for an unrecognized refusal would send work to an owner who cannot fix it.
 * `invalid_argument`, `consumer_fenced`, `task_not_found`, and
 * `task_not_startable` are deliberate omissions rather than gaps. The first two
 * report that the call itself was wrong: built with bad argv, or issued from a
 * terminal that does not hold the Run. Neither a profile change nor a process
 * reconciliation repairs those, and a retry from the same place reproduces
 * them. The last two report that the coordinator named a Task the Run does not
 * hold, a bookkeeping fault whose owner only the surrounding evidence can name.
 */
const ORCA_FAILURE_HINTS = Object.freeze({
  // A runtime that does not list the requested agent refuses every attempt
  // carrying it, so only rebinding the profile changes the outcome.
  agent_unconfigured: { kind: "execution-unconfigured" },
  incompatible_runtime: { kind: "environment" },
  // The remaining codes leave the worker process unsettled. `reconcile-execution`
  // and its `processExitConfirmed` retry gate are exactly what Orca demands
  // before a replacement starts: inspect residual resources, then decide.
  inject_rejected: { processState: "unknown" },
  no_agent_detected: { processState: "unknown" },
  runtime_error: { processState: "unknown" },
  failed: { processState: "unknown" },
  outcome_unknown: { processState: "unknown" },
  start_unknown: { processState: "unknown" },
  turn_start_unobserved: { processState: "unknown" },
  unverifiable: { processState: "unknown" },
});

/**
 * Translates one Orca code into the neutral signal failure routing consumes.
 *
 * @param {string} code - Orca `error.code`, receipt state, or observed state.
 * @param {string} [message] - Orca's own explanation, when it supplied one.
 * @returns {object} Validated neutral failure signal retaining the Orca code.
 * @throws {Error} When the resulting signal violates the port contract.
 */
export function translateOrcaFailure(code, message) {
  const normalized = String(code ?? "").trim();
  const explanation = String(message ?? "").trim();
  // A failure Orca did not name is not a `runtime_error`: inventing that code
  // would put a word the runtime never said where the contract promises its
  // original one. The absence is recorded as itself, and an unnamed failure
  // leaves the process unsettled, so it routes like the other unsettled ones.
  if (!normalized) {
    return assertFailureSignal({
      processState: "unknown",
      code: "code_absent",
      message: explanation || "Orca returned a failure without naming a code",
    });
  }
  return assertFailureSignal({
    ...(ORCA_FAILURE_HINTS[normalized] ?? {}),
    code: normalized,
    message: explanation || `Orca reported ${normalized}`,
  });
}

/**
 * Translates a state whose worker the adapter has already judged unverifiable.
 *
 * A start that did not reach `ready` is unverifiable regardless of whether its
 * state appears in the hint table, so the conclusion is carried into the signal
 * instead of being left behind when an unfamiliar state arrives.
 *
 * @param {string} code - Receipt state Orca reported for the attempt.
 * @param {string} [message] - Orca's own explanation, when it supplied one.
 * @returns {object} Neutral signal that always reaches a reconciling route.
 * @throws {Error} When the resulting signal violates the port contract.
 */
export function translateUnverifiableState(code, message) {
  const signal = translateOrcaFailure(code, message);
  if (signal.kind || signal.processState) return signal;
  return assertFailureSignal({ ...signal, processState: "unknown" });
}

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
  if (result.code !== 0 || result.timedOut) {
    const detail = result.stderr || result.stdout || "Orca command failed";
    throw orcaError(
      detail,
      translateOrcaFailure(
        result.timedOut ? "start_unknown" : "runtime_error",
        detail,
      ),
    );
  }
  const parsed = parseJsonResponse(result, "Orca response is not valid JSON");
  if (parsed.ok === false) {
    throw orcaError(
      JSON.stringify(parsed),
      translateOrcaFailure(parsed.error?.code, parsed.error?.message),
    );
  }
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
  const { selected, discovery } = await resolvedDiscovery(
    executable,
    suppliedDiscovery,
    execute,
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
  return assertWorkspaceReceipt({
    executable: selected,
    discovery,
    receipt,
    // `worktree` stays for the callers that already read it; `id` and `path`
    // are what the port names, so a caller can hold either adapter's workspace
    // without knowing which runtime produced it.
    worktree: receipt.result.worktree,
    id: receipt.result.worktree.id,
    path: receipt.result.worktree.path,
  });
}

// A refusal Orca explained is only useful if the explanation survives the
// throw. The message stays what a reader sees, while `signal` and `receipt`
// carry the routing hint and any resources the caller still has to reclaim.
/**
 * Asserts a discovery receipt belongs to the executable about to be used.
 *
 * @param {object} runtime - Discovery receipt from {@link discoverOrcaRuntime}.
 * @param {string} executable - Executable the caller intends to keep using.
 * @returns {object} The same receipt, unchanged.
 * @throws {Error} When the receipt is foreign, malformed, or version-mismatched.
 */
export function assertOrcaDiscovery(runtime, executable) {
  assert(
    runtime?.schemaVersion === 1 &&
      runtime.executable === executable &&
      runtime.guide?.id === "orca-cli" &&
      /^[a-f0-9]{64}$/.test(runtime.guide.sha256),
    "Version-matched Orca runtime discovery receipt required",
  );
  assert(
    runtime.versionsMatch !== false,
    "Orca CLI and runtime versions differ; rediscover before attaching",
  );
  return runtime;
}

/**
 * Reads the workspace that a raw Orca worktree receipt claims.
 *
 * @param {object} receipt - Envelope returned by an Orca worktree command.
 * @returns {object} Neutral workspace claim, keeping the Orca instance id.
 * @throws {Error} When the envelope failed or names no worktree identity.
 */
export function readOrcaWorkspaceClaim(receipt) {
  const worktree = receipt?.result?.worktree;
  assert(
    receipt?.ok !== false && worktree?.id && worktree.path,
    "Orca receipt missing worktree identity",
  );
  return assertWorkspaceReceipt({
    id: worktree.id,
    path: worktree.path,
    instanceId: worktree.instanceId ?? null,
  });
}

/**
 * Re-observes a claimed workspace through the runtime that issued the claim.
 *
 * A receipt a caller hands over is a claim about the past. Asking the runtime
 * again is what turns it into a current fact, and it is also where a runtime
 * that restarted, or a worktree that was recreated under the same id, shows up.
 *
 * @param {object} claim - Claim from {@link readOrcaWorkspaceClaim}.
 * @param {object} options - Parent repo, executable, discovery, and runner.
 * @returns {Promise<object>} Confirmed workspace plus the raw observation.
 * @throws {Error} When the lookup, runtime identity, or instance disagrees.
 */
export async function confirmOrcaWorkspace(claim, options) {
  const { parentRepo, executable, runtime, execute } = options;
  const observed = await runOrcaJson(
    executable,
    ["worktree", "show", "--worktree", `id:${claim.id}`],
    { cwd: parentRepo, execute },
  );
  const current = observed.result?.worktree;
  assert(
    current?.id === claim.id && current.path,
    "Orca lookup does not match the supplied worktree receipt",
  );
  if (runtime?.runtimeId && observed._meta?.runtimeId) {
    assert(
      runtime.runtimeId === observed._meta.runtimeId,
      "Orca runtime changed since discovery",
    );
  }
  if (claim.instanceId) {
    assert(
      current.instanceId === claim.instanceId,
      "Orca worktree instance changed",
    );
  }
  return {
    ...assertWorkspaceReceipt({ id: current.id, path: current.path }),
    observed,
  };
}

function orcaError(message, signal, receipt) {
  const error = new Error(message);
  if (signal) error.signal = signal;
  if (receipt) error.receipt = receipt;
  return error;
}

async function resolvedDiscovery(executable, supplied, execute) {
  const selected = selectOrcaExecutable(executable ?? supplied?.executable);
  const discovery = supplied ?? (await discoverOrcaRuntime(selected, execute));
  assert(
    discovery.executable === selected && discovery.versionsMatch !== false,
    "Supplied Orca discovery does not match the selected executable",
  );
  return { selected, discovery };
}

/**
 * Starts one supervised Orca worker and returns a port-shaped receipt.
 *
 * Orca exits non-zero for `failed` and `outcome_unknown` while still returning
 * a receipt that names the Dispatch and its residual resources, so the exit
 * code alone is not read as a crash. A start that produced no receipt at all
 * is the one case that throws, because there is no Dispatch to address and
 * relaunching would only add resources to reclaim.
 *
 * @param {string} repo - Worktree the coordinator issues the command from.
 * @param {object} options - Task selection, placement, and launch options.
 * @returns {Promise<object>} Worker receipt satisfying the execution port.
 * @throws {Error} When the arguments are invalid or no receipt came back. The
 * thrown error carries a translated `signal` whenever Orca named a cause.
 */
export async function startWorker(
  repo,
  {
    task,
    spec,
    worktree = "current",
    agent,
    terminal,
    model,
    effort,
    runId,
    retryOf,
    timeoutMs = 300000,
    discovery: suppliedDiscovery,
    executable,
    execute = run,
  },
) {
  assert(
    Boolean(task) !== Boolean(spec),
    "Orca worker-start needs exactly one of task or spec",
  );
  assert(
    Boolean(agent) !== Boolean(terminal),
    "Orca worker-start needs exactly one of agent or terminal",
  );
  assert(!effort || Boolean(model), "Orca requires a model before an effort");
  assert(
    !terminal || !(model || effort),
    "Orca rejects model or effort when reusing an existing terminal",
  );
  const { selected, discovery } = await resolvedDiscovery(
    executable,
    suppliedDiscovery,
    execute,
  );

  const argv = [selected, "orchestration", "worker-start"];
  if (task) argv.push("--task", task);
  if (spec) argv.push("--spec", spec);
  argv.push("--worktree", worktree);
  if (agent) argv.push("--agent", agent);
  if (terminal) argv.push("--terminal", terminal);
  if (model) argv.push("--model", model);
  if (effort) argv.push("--effort", effort);
  if (runId) argv.push("--run", runId);
  if (retryOf) argv.push("--retry-of", retryOf);
  argv.push("--json");

  const started = await execute(argv, { cwd: repo, timeoutMs });
  if (started.timedOut || !String(started.stdout ?? "").trim()) {
    const unobserved = translateOrcaFailure(
      "start_unknown",
      "Orca worker-start returned no receipt; inspect the Run before relaunching",
    );
    throw orcaError(unobserved.message, unobserved);
  }

  const receipt = parseJsonResponse(
    started,
    "Orca worker receipt is not valid JSON",
  );
  if (receipt.ok === false) {
    const refused = translateOrcaFailure(
      receipt.error?.code,
      receipt.error?.message,
    );
    throw orcaError(refused.message, refused, receipt);
  }

  const result = receipt.result ?? {};
  // Only the Dispatch is required. A receipt that named the Dispatch but not
  // the Task still names the terminal someone has to reclaim, and discarding
  // it to enforce a field Orca does not guarantee would lose that address.
  if (typeof result.dispatchId !== "string" || !result.dispatchId) {
    const unusable = translateUnverifiableState(result.state, result.lastError);
    throw orcaError(
      "Orca worker receipt missing dispatch identity",
      unusable,
      receipt,
    );
  }
  const ready = result.state === "ready";
  const stage = result.failedStage
    ? `Orca worker-start stopped at stage ${result.failedStage}`
    : undefined;
  return assertWorkerReceipt({
    executable: selected,
    discovery,
    receipt,
    workerId: result.dispatchId,
    taskId: result.taskId ?? null,
    runId: result.runId ?? null,
    // A start that did not reach `ready` proves nothing about the process it
    // may have left behind, and absence never authorizes cleanup on its own.
    // `live` here is the verdict at this instant; `worker-list` stays the
    // authority on whether the agent is still running later.
    liveness: ready ? "live" : "unverifiable",
    residualResources: result.residualResources ?? [],
    failure: ready
      ? null
      : translateUnverifiableState(result.state, result.lastError ?? stage),
  });
}

async function dispatchVerb(verb, dispatchId, options) {
  const { executable, discovery: supplied, execute = run, cwd } = options;
  assert(
    typeof dispatchId === "string" && dispatchId.trim(),
    `Orca ${verb} requires a dispatch identifier`,
  );
  const { selected } = await resolvedDiscovery(executable, supplied, execute);
  return runOrcaJson(
    selected,
    ["orchestration", verb, "--dispatch", dispatchId],
    {
      cwd,
      execute,
    },
  );
}

/**
 * Closes the proven supervised terminal owned by one settled Dispatch.
 *
 * Use this only with positive proof the agent exited. Without that proof Orca
 * requires {@link abandonWorker}, which keeps possibly-live resources instead
 * of claiming a stop that was never observed.
 *
 * @param {string} dispatchId - Dispatch whose terminal is proven stopped.
 * @param {object} [options={}] - Executable, discovery, cwd, and runner.
 * @returns {Promise<object>} Parsed Orca envelope for the stop.
 * @throws {Error} When the dispatch is missing or Orca refuses the stop.
 */
export function stopWorker(dispatchId, options = {}) {
  return dispatchVerb("worker-stop", dispatchId, options);
}

/**
 * Fences a Dispatch whose process state could not be established.
 *
 * This performs no remote, process, or filesystem action: it records that
 * orchestration has let the attempt go while its resources may still be live.
 *
 * @param {string} dispatchId - Dispatch to fence without claiming an exit.
 * @param {object} [options={}] - Executable, discovery, cwd, and runner.
 * @returns {Promise<object>} Parsed Orca envelope for the abandonment.
 * @throws {Error} When the dispatch is missing or Orca refuses the call.
 */
export function abandonWorker(dispatchId, options = {}) {
  return dispatchVerb("worker-abandon", dispatchId, options);
}

/**
 * Releases the resources of a Dispatch whose settlement Orca accepted.
 *
 * Release is post-settlement cleanup rather than cancellation, so an accepted
 * outcome is the only thing that authorizes it.
 *
 * @param {string} dispatchId - Dispatch that reported a settled outcome.
 * @param {object} [options={}] - Executable, discovery, cwd, and runner.
 * @returns {Promise<object>} Parsed Orca envelope for the release.
 * @throws {Error} When the dispatch is missing or Orca refuses the release.
 */
export function releaseWorker(dispatchId, options = {}) {
  return dispatchVerb("worker-release", dispatchId, options);
}
