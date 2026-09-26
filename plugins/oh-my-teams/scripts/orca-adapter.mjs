/** Version-matched, narrow adapter for the external Orca CLI. */
import { assert, hash, run } from "./core.mjs";
import {
  assertFailureSignal,
  assertWorkerReceipt,
  assertWorkspaceReceipt,
} from "./execution.mjs";
import { confirmWorkerSubmission } from "./prompt-submission.mjs";

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
 * Codes `dispatch --inject` returns when it refuses before typing anything.
 *
 * On that path they prove no work reached the terminal. The same codes met
 * during `worker-start` may follow an agent the launch already started, which
 * is why the general table leaves them unsettled.
 */
const INJECT_REFUSALS = new Set(["inject_rejected", "no_agent_detected"]);

/**
 * Translates a refusal of `dispatch --inject` into a neutral signal.
 *
 * @param {string} code - Orca `error.code` from the dispatch call.
 * @param {string} [message] - Orca's own explanation, when it supplied one.
 * @returns {object} `not-started` for an injection refusal, otherwise the
 *   general translation.
 * @throws {Error} When the resulting signal violates the port contract.
 */
export function translateInjectRefusal(code, message) {
  const normalized = String(code ?? "").trim();
  if (!INJECT_REFUSALS.has(normalized)) {
    return translateOrcaFailure(code, message);
  }
  return assertFailureSignal({
    kind: "not-started",
    code: normalized,
    message:
      String(message ?? "").trim() ||
      `Orca refused the injection: ${normalized}`,
  });
}

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

const IDLE_PROBE_MS = 20000;

const BLOCK_PROBE_MS = 3000;

// Reads terminal diagnostics when idle check fails. Always returns an object,
// never null: a read failure is recorded via `diagnosticsError` (or
// `screenFieldMissing`) instead, so it never replaces the original idle
// failure this attaches to.
//
// The `--screen --json` envelope carries the screen at `result.terminal.tail`
// with `result.terminal.source`, the same shape role-terminal.mjs's
// readScreen and prompt-supervision.mjs's readTerminalScreen read. Only a
// `source` of "screen" is a rendered screen; a stream source can still hold a
// stale startup line (e.g. Agy's "not signed in" banner) after the terminal
// is actually ready, so that case is recorded as no screen plus the source
// received rather than trusted.
async function readTerminalDiagnostics(orca, terminal, { cwd, execute }) {
  try {
    const screen = await execute(
      [orca, "terminal", "read", "--terminal", terminal, "--screen", "--json"],
      { cwd, timeoutMs: 10000 },
    );
    let screenLines = null;
    let screenSource = null;
    let screenFailed = false;
    let screenFieldMissing = false;
    let screenTopLevelKeys;
    if (screen.code === 0) {
      try {
        const parsed = JSON.parse(screen.stdout);
        const terminalField = parsed.result?.terminal;
        if (terminalField && Array.isArray(terminalField.tail)) {
          screenSource = terminalField.source ?? null;
          screenLines = screenSource === "screen" ? terminalField.tail : null;
        } else {
          // The response did not carry the shape this adapter reads. Recording
          // this distinctly (rather than a silently empty screen) is what let
          // this bug be caught: an earlier version read a field, `result.screen`,
          // that no Orca response actually returns.
          screenFieldMissing = true;
          screenTopLevelKeys = Object.keys(parsed.result ?? parsed ?? {});
        }
      } catch {
        // Ignore JSON parse errors
      }
    } else {
      screenFailed = true;
    }

    const list = await execute([orca, "terminal", "list", "--json"], {
      cwd,
      timeoutMs: 10000,
    });
    let terminalState = null;
    let listFailed = false;
    if (list.code === 0) {
      try {
        const parsed = JSON.parse(list.stdout);
        const terminals = parsed.result?.terminals ?? [];
        terminalState = terminals.find((t) => t.handle === terminal) ?? null;
      } catch {
        // Ignore JSON parse errors
      }
    } else {
      listFailed = true;
    }

    const diagnostics = { screen: screenLines, screenSource, terminalState };
    if (screenFieldMissing) {
      diagnostics.screenFieldMissing = true;
      diagnostics.screenTopLevelKeys = screenTopLevelKeys;
    }
    // If any read failed, record that fact
    if (screenFailed || listFailed) diagnostics.diagnosticsError = true;
    return diagnostics;
  } catch (error) {
    // Record the error so the failure includes diagnostic failure
    return {
      diagnosticsError: true,
      message: String(error.message).slice(0, 100),
    };
  }
}

// Runs `terminal wait --for tui-idle` and reads the envelope Orca returns.
// Orca reports the timeout in its JSON envelope; whether it also exits
// non-zero is not relied on, so the envelope is read before the exit code.
async function waitForTuiIdle(orca, terminal, { cwd, execute, timeoutMs }) {
  const waited = await execute(
    [
      orca,
      "terminal",
      "wait",
      "--terminal",
      terminal,
      "--for",
      "tui-idle",
      "--timeout-ms",
      String(timeoutMs),
      "--json",
    ],
    { cwd, timeoutMs: timeoutMs + 25000 },
  );
  let envelope = null;
  try {
    envelope = JSON.parse(waited.stdout);
  } catch {
    // Not JSON: the exit code decides.
  }
  return { waited, envelope };
}

/**
 * Asks Orca whether a terminal is held at a question, using the same
 * `terminal wait --for tui-idle` answer the launch pre-check reads.
 *
 * A wait that is not satisfied and names a `blockedReason` means Orca sees a
 * trust, update or approval question. A wait that is satisfied, or that is not
 * satisfied without a reason or runs out its short timeout, means Orca reports
 * no such stop. Anything else, such as a failed command or an envelope without
 * `wait.satisfied`, leaves the state unknown, which is not the same as clear.
 *
 * @param {string} orca - Orca executable.
 * @param {string} terminal - Terminal handle.
 * @param {object} options - Probe options.
 * @param {Function} options.execute - Command runner.
 * @param {string} [options.cwd] - Directory to run in.
 * @param {number} [options.timeoutMs=3000] - How long Orca may wait for idle.
 * @returns {Promise<{state: "idle" | "busy" | "blocked" | "unknown", blockedReason?: string, detail?: string}>}
 *   `blocked` carries Orca's reason; `unknown` carries what went wrong.
 */
export async function probeTerminalBlock(
  orca,
  terminal,
  { cwd, execute, timeoutMs = BLOCK_PROBE_MS },
) {
  const { waited, envelope } = await waitForTuiIdle(orca, terminal, {
    cwd,
    execute,
    timeoutMs,
  });
  const unknown = (detail) => ({
    state: "unknown",
    detail: String(detail).slice(0, 200),
  });
  if (waited.timedOut || !envelope)
    return unknown(waited.stderr || waited.stdout || "no Orca answer");
  if (envelope.ok === false)
    return envelope.error?.code === "timeout"
      ? { state: "busy" }
      : unknown(envelope.error?.message ?? envelope.error?.code ?? "refused");
  const wait = envelope.result?.wait;
  if (wait?.satisfied === true) return { state: "idle" };
  if (wait?.satisfied !== false) return unknown("no wait.satisfied in answer");
  return wait.blockedReason
    ? { state: "blocked", blockedReason: String(wait.blockedReason) }
    : { state: "busy" };
}

// Orca creates the Dispatch before it waits for a reused terminal to reach
// `tui-idle`, so a terminal that never reports idle leaves a failed Dispatch
// and a spent attempt behind. Orca 1.4.204 reports no idle for `antigravity`
// terminals. The same wait is run first, and a terminal that times out is
// refused before any Dispatch exists. The probe names no agent, so a runtime
// that starts reporting idle reopens the path without a code change.
async function assertTerminalIdle(
  orca,
  terminal,
  { cwd, execute, matrixPrediction },
) {
  const { waited, envelope } = await waitForTuiIdle(orca, terminal, {
    cwd,
    execute,
    timeoutMs: IDLE_PROBE_MS,
  });

  if (!waited.timedOut && envelope?.ok === false) {
    if (envelope.error?.code === "timeout") {
      // `timeout` means "not idle" only for this wait, so the route is chosen
      // here rather than in the hint table. Handing the same profile's
      // terminal over again reproduces it; only another profile changes it.
      const refused = assertFailureSignal({
        kind: "execution-unconfigured",
        code: "timeout",
        message:
          `Terminal ${terminal} did not report tui-idle within ${IDLE_PROBE_MS}ms, ` +
          "which Orca worker-start waits for before handing over a task; no Dispatch was created. " +
          "Do not repeat the start (references/orca-runtime.md)",
      });
      const error = orcaError(refused.message, refused, envelope);
      error.diagnostics = await readTerminalDiagnostics(orca, terminal, {
        cwd,
        execute,
      });
      throw error;
    }
    const failed = translateOrcaFailure(
      envelope.error?.code,
      envelope.error?.message,
    );
    const error = orcaError(JSON.stringify(envelope), failed, envelope);
    error.diagnostics = await readTerminalDiagnostics(orca, terminal, {
      cwd,
      execute,
    });
    throw error;
  }
  const wait = envelope?.result?.wait;
  if (!waited.timedOut && wait?.satisfied === false) {
    // Orca stops waiting at once when the screen holds a trust, update or
    // approval prompt, and says so only inside an `ok` envelope. The signal is
    // built without the hint table: a reason that matched a hinted code would
    // gain a route. The question is answered by the supervisor through the
    // `prompt-answer` command, not by a person at the terminal.
    const reason = wait.blockedReason ?? "not_idle";
    const state = wait.blockedReason
      ? `is held at a prompt (${reason})`
      : "was reported not idle without a reason";
    // When the matrix predicted the terminal would reach supervised-terminal
    // but Orca refused it here, the prediction itself is wrong: signal that
    // so the table can be revised rather than the same start repeated.
    // A trust question the matrix already named (its reason lists a trust code)
    // is the expected supervised path, not a wrong prediction.
    const trustExpected =
      /trust/.test(reason) &&
      (matrixPrediction?.reason ?? []).some((code) => /trust/.test(code));
    const mismatch =
      matrixPrediction?.path === "supervised-terminal" && !trustExpected
        ? "matrix-mismatch"
        : undefined;
    const refused = assertFailureSignal({
      ...(mismatch ? { kind: mismatch } : {}),
      code: reason,
      message:
        `Terminal ${terminal} ${state} instead of reporting tui-idle, ` +
        "so Orca worker-start could not hand it a task; no Dispatch was created. " +
        (wait.blockedReason
          ? "Do not repeat the start. The supervisor answers the question: run " +
            `\`teams-org.mjs prompt-answer --org <org> --terminal ${terminal} --workflow-id <id> --state <dir>\` ` +
            "(it reads the screen; for a captured question it sends one key and re-reads it, while a screen " +
            "the classifier does not recognize, such as a command approval or an update notice, gets no key and ends as " +
            "escalate with this blockedReason), then run terminal-idle-check again and worker-start only after the " +
            "terminal reports idle; when the command reports escalate or unresolved, do not run it again for the same " +
            "screen: report it upward and send a director-signal only for what a person must decide (references/orca-runtime.md)"
          : "Read the terminal screen and report it rather than repeating the start") +
        (mismatch
          ? ` (matrix-prediction-failure: predicted supervised-terminal for ${reason})`
          : ""),
    });
    const error = orcaError(refused.message, refused, envelope);
    error.diagnostics = await readTerminalDiagnostics(orca, terminal, {
      cwd,
      execute,
    });
    throw error;
  }
  if (waited.code !== 0 || waited.timedOut || !envelope) {
    const detail =
      waited.stderr || waited.stdout || "Orca terminal wait failed";
    const error = orcaError(
      detail,
      translateOrcaFailure(
        waited.timedOut ? "start_unknown" : "runtime_error",
        detail,
      ),
    );
    error.diagnostics = await readTerminalDiagnostics(orca, terminal, {
      cwd,
      execute,
    });
    throw error;
  }
}

/**
 * Checks, without creating anything, that a terminal reports `tui-idle`.
 *
 * worker-start runs the same check, but a coordinator reserves the attempt
 * before calling it, and a released reservation keeps the attempt spent. Run
 * first, this check refuses a terminal Orca cannot hand work to before any
 * attempt is reserved.
 *
 * @param {string} terminal - Terminal handle to check.
 * @param {object} [options={}] - Executable, cwd, matrixPrediction, and injectable runner.
 * @param {object} [options.matrixPrediction] - Result of `predictLaunchPath` for this terminal,
 *   used to attach a `matrix-mismatch` signal when the post-launch refusal contradicts the
 *   predicted `supervised-terminal` path.
 * @returns {Promise<{terminal: string, idle: true}>} The idle terminal.
 * @throws {Error} Carrying the translated signal when the terminal is not idle,
 *   plus a `diagnostics` field (the `--screen` screen, the `terminal list` row,
 *   or a record of the diagnostic read itself failing) for the failed attempt.
 */
export async function checkTerminalIdle(
  terminal,
  { executable, cwd, matrixPrediction, execute = run } = {},
) {
  assert(terminal, "A terminal handle is required");
  const selected = selectOrcaExecutable(executable);
  await assertTerminalIdle(selected, terminal, {
    cwd,
    execute,
    matrixPrediction,
  });
  return { terminal, idle: true };
}

/**
 * Looks up whether a terminal already holds a Dispatch nobody has closed.
 *
 * `worker-list` is the only source consulted: a terminal's `tui-idle` says
 * nothing about a Dispatch left dangling on it, and `/clear` on a terminal
 * still bound to one would drop that Dispatch's context out from under it.
 * A call that fails, an envelope without a `workers` array, or a Dispatch
 * whose `dispatchStatus` is neither settled (`completed`, `failed`) nor
 * confirmed active (`dispatched`) all count as `unknown`, since only the
 * documented `--status` vocabulary (`task-update --help`) is trusted to mean
 * settled. A `page.hasMore` truncation with no match on this page counts the
 * same way, since a later page could still hold the terminal's Dispatch.
 *
 * @param {string} terminal - Terminal handle to check.
 * @param {object} [options={}] - Executable, cwd, and injectable runner.
 * @param {string} [options.executable] - Orca executable.
 * @param {string} [options.cwd] - Directory the Orca command runs from.
 * @param {Function} [options.execute=run] - Injectable command runner.
 * @returns {Promise<{status: "active" | "clear" | "unknown", dispatchId?: string, taskId?: string | null}>}
 *   `active` names the Dispatch; `clear` means none is bound; `unknown` means
 *   the terminal's Dispatch could not be determined either way.
 */
export async function findActiveDispatch(
  terminal,
  { executable, cwd, execute = run } = {},
) {
  assert(terminal, "A terminal handle is required");
  const selected = selectOrcaExecutable(executable);
  let envelope;
  try {
    envelope = await runOrcaJson(
      selected,
      ["orchestration", "worker-list", "--limit", "100"],
      { cwd, execute },
    );
  } catch {
    return { status: "unknown" };
  }
  const workers = envelope.result?.workers;
  if (!Array.isArray(workers)) return { status: "unknown" };
  const matches = workers.filter(
    (worker) =>
      worker.agentTerminalHandle === terminal ||
      worker.resource?.terminalHandle === terminal,
  );
  const active = matches.find(
    (worker) => worker.dispatchStatus === "dispatched",
  );
  if (active) {
    return {
      status: "active",
      dispatchId: active.dispatchId,
      taskId: active.taskId ?? null,
    };
  }
  const unresolved = matches.some(
    (worker) => !["completed", "failed"].includes(worker.dispatchStatus),
  );
  const pagedPastMatch =
    matches.length === 0 && envelope.result?.page?.hasMore === true;
  return unresolved || pagedPastMatch
    ? { status: "unknown" }
    : { status: "clear" };
}

/**
 * Hands a task to a terminal with `dispatch --inject`, outside supervision.
 *
 * This is the exception path for a role whose terminal Orca cannot supervise,
 * used only with the user's recorded approval. Orca types the task into the
 * terminal but owns no worker: `worker-list` does not report its liveness,
 * `worker-release` does not reclaim it, and nothing proves the model.
 *
 * @param {string} repo - Worktree of the Run-bound coordinator terminal the commands run from.
 * @param {object} options - Task or spec, terminal, run, and runner.
 * @param {string} [options.task] - Existing Orca task to dispatch.
 * @param {string} [options.spec] - Task description when no task is given.
 * @param {string} options.terminal - Terminal to inject into.
 * @param {string} [options.runId] - Run the task belongs to.
 * @param {string} [options.executable] - Orca executable to use.
 * @param {Function} [options.execute=run] - Injectable command runner.
 * A refused injection is returned rather than thrown. It started nothing, so
 * the result carries `injected: false`, the neutral `injectRefusal`, and the
 * task this call created, closed as failed so it does not wait as `ready` in
 * the Run with no Dispatch to carry it.
 *
 * @returns {Promise<object>} Task, Dispatch and whether Orca injected it.
 * @throws {Error} When Orca refuses the task, or fails the dispatch for any
 *   reason other than a refusal to inject.
 */
export async function injectTask(
  repo,
  { task, spec, terminal, runId, executable, execute = run },
) {
  assert(
    Boolean(task) !== Boolean(spec),
    "Inject needs exactly one of task or spec",
  );
  assert(terminal, "Inject needs a terminal");
  const selected = selectOrcaExecutable(executable);
  const runArgs = runId ? ["--run", runId] : [];
  let taskId = task;
  let taskCreated = false;
  if (!taskId) {
    const created = await runOrcaJson(
      selected,
      ["orchestration", "task-create", "--spec", spec, ...runArgs],
      { cwd: repo, execute },
    );
    taskId = created.result?.task?.id;
    assert(taskId, "Orca task-create returned no task id");
    taskCreated = true;
  }
  let dispatched;
  try {
    dispatched = await runOrcaJson(
      selected,
      [
        "orchestration",
        "dispatch",
        "--task",
        taskId,
        "--to",
        terminal,
        "--inject",
        ...runArgs,
      ],
      { cwd: repo, execute },
    );
  } catch (error) {
    if (!INJECT_REFUSALS.has(error.signal?.code)) throw error;
    const injectRefusal = translateInjectRefusal(
      error.signal.code,
      error.signal.message,
    );
    let taskClosed = false;
    if (taskCreated) {
      try {
        await runOrcaJson(
          selected,
          [
            "orchestration",
            "task-update",
            "--id",
            taskId,
            "--status",
            "failed",
            "--result",
            JSON.stringify({ refused: injectRefusal.code }),
            ...runArgs,
          ],
          { cwd: repo, execute },
        );
        taskClosed = true;
      } catch {
        // The refusal is the fact to report; a task left open is named by
        // taskClosed so the coordinator closes it rather than guessing.
      }
    }
    return {
      taskId,
      taskCreated,
      taskClosed,
      dispatchId: null,
      runId: runId ?? null,
      terminal,
      injected: false,
      injectRefusal,
      orcaResponse: error.message,
    };
  }
  const dispatch = dispatched.result?.dispatch;
  assert(dispatch?.id, "Orca dispatch returned no dispatch id");
  return {
    taskId,
    dispatchId: dispatch.id,
    runId: dispatch.run_id ?? runId ?? null,
    terminal,
    injected: dispatched.result?.injected === true,
  };
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
 * A reused terminal is first checked for `tui-idle`, the condition Orca waits
 * for before injecting, and one that never reports it is refused without
 * calling `worker-start`. When that same terminal comes back `ready` without
 * `turn_started`, `confirmWorkerSubmission` (prompt-submission.mjs) reads its
 * screen once and presses Enter at most once, and the result rides along as
 * the receipt's `submission` field.
 *
 * @param {string} repo - Worktree the coordinator issues the command from.
 * @param {object} options - Task selection, placement, and launch options.
 * @param {object} [options.matrixPrediction] - Result of `predictLaunchPath` for the reused
 *   terminal, used to attach a `matrix-mismatch` signal when the post-launch refusal contradicts
 *   the predicted `supervised-terminal` path.
 * @returns {Promise<object>} Worker receipt satisfying the execution port, with a `submission`
 *   field added only for a reused terminal whose `ready` receipt lacked `turn_started`.
 * @throws {Error} When the arguments are invalid, a reused terminal is not
 * idle, or no receipt came back. The thrown error carries a translated
 * `signal` whenever Orca named a cause.
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
    matrixPrediction,
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
  if (terminal) {
    await assertTerminalIdle(selected, terminal, {
      cwd: repo,
      execute,
      matrixPrediction,
    });
  }

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
  // A reused terminal that Orca reports ready without `turn_started` may
  // still hold the task unsubmitted at the prompt (#87); a fresh terminal
  // from `--agent` never showed this, so only the reused-terminal path is
  // confirmed here, mirroring the `--terminal`-only idle check above.
  let submission;
  if (
    terminal &&
    ready &&
    !(result.prompt?.stages ?? []).includes("turn_started")
  ) {
    submission = await confirmWorkerSubmission({
      orca: selected,
      terminal,
      stages: result.prompt?.stages ?? [],
      taskId: result.taskId ?? null,
      execute,
    });
  }
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
    ...(submission ? { submission } : {}),
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

// A heartbeat proves liveness only; its payload names the Dispatch it is for.
function heartbeatDispatch(message) {
  try {
    const payload = JSON.parse(message.payload ?? "null");
    return typeof payload?.dispatchId === "string" ? payload.dispatchId : null;
  } catch {
    return null;
  }
}

/**
 * Waits on a Run's coordinator mailbox until a message other than a heartbeat arrives.
 *
 * In one kickoff 11 of 68 PM turns were started by nothing but a worker
 * heartbeat. Orca pushes "You have N orchestration messages" into the
 * coordinator session for every unread type that no waiter's `--types`
 * covers, so a `check --wait --types worker_done,...` still let heartbeats
 * wake the model. This loop waits without `--types`, which keeps Orca from
 * pushing anything while it waits, and consumes heartbeat-only Deliveries
 * itself by acknowledging them with the next `check --ack`, so the same
 * heartbeat is neither replayed nor pushed later. A Delivery holding any other
 * message is returned unacknowledged: the caller processes every message and
 * passes its `deliveryId` as `ack` to the next wait, as with a raw `check`.
 *
 * @param {object} options - Wait options.
 * @param {string} options.runId - Run whose coordinator mailbox is read.
 * @param {number} options.timeoutMs - Overall wait, normally `policy.supervision.progressCheckMs`.
 * @param {string} [options.ack] - Delivery the caller finished processing, acknowledged first.
 * @param {string} [options.executable] - Orca executable.
 * @param {string} [options.cwd] - Directory the Orca commands run from.
 * @param {Function} [options.execute=run] - Injectable command runner.
 * @param {Function} [options.now=Date.now] - Injectable clock in milliseconds.
 * @returns {Promise<object>} `{timedOut: false, deliveryId, messages, heartbeats, lastHeartbeats}`
 *   with the non-heartbeat messages, or `{timedOut: true, deliveryId, heartbeats, lastHeartbeats}`.
 *   Either way a non-null `deliveryId` is passed as `ack` to the next wait.
 * @throws {Error} When Orca refuses a check, for example because another waiter holds the Run.
 */
export async function waitForSupervisionMessage({
  runId,
  timeoutMs,
  ack,
  executable,
  cwd,
  execute = run,
  now = Date.now,
}) {
  assert(runId, "A Run id is required");
  assert(
    Number.isInteger(timeoutMs) && timeoutMs > 0,
    "timeoutMs must be a positive integer",
  );
  const selected = selectOrcaExecutable(executable);
  const deadline = now() + timeoutMs;
  const lastHeartbeats = {};
  let heartbeats = 0;
  let pendingAck = ack;
  for (;;) {
    const remaining = deadline - now();
    // A heartbeat-only Delivery left unacknowledged at the deadline is handed
    // back as `deliveryId`, which the caller acknowledges on its next wait.
    if (remaining <= 0)
      return {
        timedOut: true,
        runId,
        deliveryId: pendingAck ?? null,
        heartbeats,
        lastHeartbeats,
      };
    const args = ["orchestration", "check", "--run", runId];
    if (pendingAck) args.push("--ack", pendingAck);
    args.push("--wait", "--timeout-ms", String(remaining));
    const envelope = await runOrcaJson(selected, args, {
      cwd,
      timeoutMs: remaining + 30000,
      execute,
    });
    pendingAck = undefined;
    const result = envelope.result ?? {};
    const messages = Array.isArray(result.messages) ? result.messages : [];
    const others = messages.filter((message) => message?.type !== "heartbeat");
    for (const message of messages) {
      if (message?.type !== "heartbeat") continue;
      heartbeats += 1;
      const dispatch =
        heartbeatDispatch(message) ?? message.from_handle ?? "unknown";
      if (
        !lastHeartbeats[dispatch] ||
        lastHeartbeats[dispatch] < message.created_at
      ) {
        lastHeartbeats[dispatch] = message.created_at ?? null;
      }
    }
    if (others.length > 0) {
      return {
        timedOut: false,
        runId,
        deliveryId: result.deliveryId ?? null,
        replayed: result.replayed === true,
        messages: others,
        heartbeats,
        lastHeartbeats,
      };
    }
    // A heartbeat-only Delivery is acknowledged on the next check; an empty
    // result has nothing to acknowledge.
    if (result.deliveryId) {
      pendingAck = result.deliveryId;
      continue;
    }
    // Nothing arrived: the wait timed out or was cancelled. An empty answer
    // Orca did not mark either way is read the same, so the loop never spins.
    return {
      timedOut: true,
      ...(result.cancelled === true ? { cancelled: true } : {}),
      runId,
      deliveryId: null,
      heartbeats,
      lastHeartbeats,
    };
  }
}
