/** Local execution adapter: plain Git worktrees and one-shot provider calls. */
import { assert, run } from "./core.mjs";
import { invoke } from "./providers.mjs";
import {
  assertFailureSignal,
  assertWorkerReceipt,
  assertWorkspaceReceipt,
} from "./execution.mjs";

// `core.mjs` kills the child on timeout or output overflow and then settles the
// call itself when no `close` arrives, so these are the results where the exit
// was never observed. Treating them as a clean exit would be the one place
// this adapter claims something it did not see.
function callUnobserved(response) {
  return (
    response?.timedOut === true ||
    response?.overflow === true ||
    response?.code === -1
  );
}

/**
 * Translates one local provider outcome into the neutral failure signal.
 *
 * A reported model that differs from the requested one invalidates the routing
 * and cost decisions that were made from the request, so it is a profile fault
 * rather than a capacity fault and never shares the quota route.
 *
 * @param {object} response - Normalized result returned by provider `invoke`.
 * @returns {object | null} Neutral failure signal, or `null` on success.
 */
export function translateLocalFailure(response) {
  if (response?.modelBinding?.status === "mismatched") {
    const { requested, effective } = response.modelBinding;
    return assertFailureSignal({
      kind: "model-binding",
      code: "model-mismatch",
      message: `Provider answered from ${effective} while ${requested} was requested`,
    });
  }
  const unobserved = callUnobserved(response);
  if (!response?.failureClass && !unobserved) return null;
  const detail = String(response.stderr ?? "").trim();
  return assertFailureSignal({
    // Quota classes stay on `failureClass` because failure routing already
    // reads that field directly, and duplicating them as a kind would give one
    // outcome two competing routes.
    ...(response.failureClass ? { failureClass: response.failureClass } : {}),
    // A call the runner had to kill left a process whose exit nobody watched,
    // so it routes for reconciliation rather than as a plain provider error.
    ...(unobserved ? { processState: "unknown", timedOut: true } : {}),
    code: unobserved ? "call_unobserved" : response.failureClass,
    message:
      detail ||
      (unobserved
        ? "The provider call was killed before its exit was observed"
        : response.failureClass),
  });
}

/**
 * Neutral routing hints for the codes this adapter's own receipts carry.
 *
 * A coordinator writing a failure record after the fact holds the code, not
 * the response object {@link translateLocalFailure} reads, so the same
 * vocabulary has to be translatable from the code alone. `model-error` is
 * absent on purpose: the provider rejected the request for a reason only the
 * recorded evidence can place.
 */
const LOCAL_FAILURE_HINTS = Object.freeze({
  call_unobserved: { processState: "unknown" },
  "model-mismatch": { kind: "model-binding" },
  "pool-exhausted": { failureClass: "pool-exhausted" },
  "quota-unknown": { failureClass: "quota-unknown" },
  "rate-limit": { failureClass: "rate-limit" },
});

/**
 * Translates one local outcome code into the neutral signal.
 *
 * @param {string} code - Code a local worker receipt recorded.
 * @param {string} [message] - Explanation captured alongside the code.
 * @returns {object} Validated neutral failure signal retaining the code.
 * @throws {Error} When the resulting signal violates the port contract.
 */
export function translateLocalCode(code, message) {
  const normalized = String(code ?? "").trim();
  assert(normalized, "A local failure code is required to translate");
  const explanation = String(message ?? "").trim();
  return assertFailureSignal({
    ...(LOCAL_FAILURE_HINTS[normalized] ?? {}),
    code: normalized,
    message: explanation || `The local runtime reported ${normalized}`,
  });
}

/**
 * Creates a plain Git worktree and confirms the identity Git reports back.
 *
 * The receipt is read from Git rather than from the arguments that were sent,
 * so a partially applied creation cannot be recorded as a usable workspace.
 *
 * @param {string} repo - Parent repository the worktree is created from.
 * @param {object} options - Branch name, base ref, target path, and runner.
 * @returns {Promise<object>} Workspace receipt satisfying the execution port.
 * @throws {Error} When creation fails or Git reports no usable identity.
 */
export async function createWorkspace(
  repo,
  { name, base, path: target, execute = run },
) {
  assert(
    typeof name === "string" && name.trim(),
    "Local workspace requires a branch name",
  );
  assert(
    typeof target === "string" && target.trim(),
    "Local workspace requires an explicit path; paths are never derived",
  );
  assert(
    typeof base === "string" && base.trim(),
    "Local workspace needs a base",
  );
  const created = await execute(
    ["git", "worktree", "add", "-b", name, target, base],
    { cwd: repo, timeoutMs: 60000 },
  );
  assert(
    created.code === 0 && !created.timedOut,
    "Local workspace creation failed; inspect residual worktrees before retry: " +
      (created.stderr || created.stdout),
  );

  const identity = await execute(
    [
      "git",
      "-C",
      target,
      "rev-parse",
      "--show-toplevel",
      "--abbrev-ref",
      "HEAD",
    ],
    // The same working directory as the creation, so a relative target names
    // the tree that was just created rather than one under the process cwd.
    { cwd: repo, timeoutMs: 30000 },
  );
  assert(
    identity.code === 0 && !identity.timedOut,
    "Created worktree reported no Git identity; it exists and must be removed " +
      "or recorded before retry: " +
      (identity.stderr || identity.stdout),
  );
  const [toplevel, branch] = String(identity.stdout).trim().split(/\r?\n/);
  return assertWorkspaceReceipt({ id: branch, path: toplevel, base });
}

/**
 * Runs one non-interactive provider call and returns a port-shaped receipt.
 *
 * This adapter starts a call that has already finished by the time it returns,
 * so it reports `exited` and never `live`. Claiming liveness it cannot observe
 * would let a caller wait for a worker that no longer exists.
 *
 * @param {string} workerId - Caller-owned identifier for this attempt.
 * @param {object} options - Profile, workspace, prompt, budget, and runner.
 * @returns {Promise<object>} Worker receipt satisfying the execution port.
 * @throws {Error} When the identifier or invocation inputs are missing.
 */
export async function startWorker(
  workerId,
  { profile, cwd, prompt, timeoutMs = 300000, execute = run },
) {
  assert(
    typeof workerId === "string" && workerId.trim(),
    "Local worker requires a caller-owned identifier",
  );
  assert(
    profile && cwd && typeof prompt === "string",
    "Local worker needs a profile, workspace and prompt",
  );
  const response = await invoke(profile, cwd, prompt, timeoutMs, execute);
  return assertWorkerReceipt({
    workerId,
    // A call that ran to completion is proven `exited`. One the runner had to
    // kill is not: the process may still be winding down, and `core.mjs` says
    // so itself by settling those calls without a close event.
    liveness: callUnobserved(response) ? "unverifiable" : "exited",
    residualResources: [],
    response,
    failure: translateLocalFailure(response),
  });
}
