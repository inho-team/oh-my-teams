/** Local execution adapter: plain Git worktrees and one-shot provider calls. */
import fs from "node:fs";
import path from "node:path";
import { assert, run } from "./core.mjs";
import { invoke } from "./providers.mjs";
import {
  assertFailureSignal,
  assertWorkerReceipt,
  assertWorkspaceReceipt,
} from "./execution.mjs";

// Compiled-in trust anchors for the `git` binary a Git-identity lookup runs,
// never derived from `PATH`, `process.env`, or any other value a caller could
// hold at the time this process started (a caller poisoning `PATH` before
// this module is even imported defeats a load-time snapshot the same way it
// defeats a live environment lookup, since both still resolve the executable
// by name through some inherited environment). Each candidate is checked by
// {@link isTrustedGitExecutable} for being a real, non-symlink file that this
// same-user process cannot itself have written, so nothing here claims to
// prove who is calling, only that the `git` invoked is not one the calling
// argv/environment could have substituted. A user with permission to modify
// one of these paths directly (or to run as root) already has the standing to
// forge whatever this check would otherwise report; that is filesystem
// compromise, not the environment/argument spoofing this defends against, and
// is out of scope the same way a corrupted `/usr/bin/git` binary would be.
// Order matches GitHub's own windows-latest runner image: its
// Install-Git.ps1 provisioning script adds `C:\Program Files\Git\bin` to the
// machine PATH (github/actions/runner-images, images/windows/scripts/build/
// Install-Git.ps1, lines 407-409), so `bin\git.exe` is checked first and
// `cmd\git.exe` second. This is provisioning-script evidence, not a local
// Windows measurement; the runner's actual layout is confirmed in the
// director's PR CI, not in this repository.
const TRUSTED_GIT_CANDIDATES = Object.freeze(
  process.platform === "win32"
    ? [
        "C:\\Program Files\\Git\\bin\\git.exe",
        "C:\\Program Files\\Git\\cmd\\git.exe",
      ]
    : ["/usr/bin/git"],
);

// POSIX: owned by root and writable by neither group nor other, so no
// same-user process could have planted or altered it. Windows has no
// equivalent ownership/mode model available here, so existence as a regular,
// non-symlink file at one of the fixed candidate paths is the whole check.
function isTrustedGitExecutable(candidate) {
  if (!path.isAbsolute(candidate)) return false;
  let stat;
  try {
    stat = fs.lstatSync(candidate);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  if (process.platform === "win32") return true;
  return stat.uid === 0 && (stat.mode & 0o022) === 0;
}

/**
 * Picks the first compiled-in candidate path that is actually present and
 * passes {@link isTrustedGitExecutable} on this platform.
 *
 * Exported so a test can assert this platform's CI runner actually has one of
 * {@link TRUSTED_GIT_CANDIDATES}: silently falling through to "no trusted git"
 * everywhere else in the suite would look identical to every accept refusing
 * for the right reason, instead of this wrong one.
 *
 * @returns {string} Absolute path to the trusted `git` executable.
 * @throws {Error} When no candidate for this platform qualifies; callers must
 *   treat this as fail-closed rather than falling back to a `PATH` lookup.
 */
export function resolveTrustedGitExecutable() {
  const found = TRUSTED_GIT_CANDIDATES.find(isTrustedGitExecutable);
  if (found) return found;
  throw new Error(
    "No trusted git executable found among: " +
      `${TRUSTED_GIT_CANDIDATES.join(", ")}. Every Git-identity lookup this ` +
      "adapter performs — including a solo (unregistered) task's own check — " +
      "fails closed without one; see docs/SAFETY_AUDIT.md for this limitation.",
  );
}

// A fixed, caller-uncontrollable child environment: nothing here is read from
// this process's own `process.env` (live or snapshotted), so a caller cannot
// widen it by setting anything before or after this module loads. POSIX needs
// nothing at all for `git rev-parse`; Windows conventionally needs `SystemRoot`
// for its own DLL loader, so that one fixed value is included rather than
// omitted and discovered missing on some future Windows-only failure.
const FIXED_CHILD_ENV = Object.freeze(
  process.platform === "win32" ? { SystemRoot: "C:\\Windows" } : {},
);

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
 * A PM or PL writing a failure record after the fact holds the code, not
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
  // Failure routing reads only two capacity classes, and a rate limit is the
  // ambiguous one: capacity is gone now, without proof the shared pool is what
  // ran out. It routes as that while `code` keeps the provider's own word.
  "rate-limit": { failureClass: "quota-unknown" },
  // A truncated prompt means the model answered from part of the contract, so
  // the work does not fit the window it was given. Splitting it is the repair,
  // and that is the same route an oversized scope already takes.
  "context-truncated": { kind: "scope" },
  // Nothing was asked, because the provider could not be reached at all.
  "provider-unavailable": { kind: "environment" },
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
 * Resolves the absolute path Git itself calls the common (main) `.git`
 * directory of whatever repository `cwd` sits inside, following linked
 * worktrees back to their owner.
 *
 * A caller-supplied `--repo` can be swapped for a different repository, so a
 * trust decision anchored on one is not safe; this anchors on `cwd` itself
 * (typically a PM's own `--state` directory), which nothing forwarded through
 * unrelated arguments can redirect. For the same reason, this never spawns
 * `git` by bare name through a caller-mutable `PATH` (which could shadow the
 * real `git` with one of the caller's own choosing, defeating the anchor);
 * it always runs {@link resolveTrustedGitExecutable}'s fixed absolute path
 * with {@link FIXED_CHILD_ENV}, a caller-uncontrollable fixed environment, so
 * `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_CEILING_DIRECTORIES`,
 * `PATH`, and every other variable a caller could hold (whether set before or
 * after this process started) play no part in what this lookup reports.
 *
 * @param {string} cwd - Directory to resolve the common dir from.
 * @param {object} [options] - Injectable runner, for tests.
 * @param {Function} [options.execute=run] - Runs the underlying `git` call.
 * @returns {Promise<string | null>} Absolute common-dir path, or `null` when
 *   `cwd` is not inside a Git working tree.
 * @throws {Error} When no trusted `git` executable is found, or the lookup
 *   fails for any other reason (timeout, a non-git-repository error the
 *   caller must not silently treat as "no repo").
 */
export async function resolveGitCommonDir(cwd, { execute = run } = {}) {
  assert(
    typeof cwd === "string" && cwd.trim(),
    "A directory is required to resolve its Git common dir",
  );
  const gitPath = resolveTrustedGitExecutable();
  const result = await execute(
    [gitPath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd, env: FIXED_CHILD_ENV, timeoutMs: 30000 },
  );
  if (result.code === 0 && !result.timedOut) {
    return String(result.stdout).trim();
  }
  if (
    !result.timedOut &&
    /not a git repository/i.test(String(result.stderr ?? ""))
  ) {
    return null;
  }
  throw new Error(
    `Git common-dir lookup failed for ${cwd}: ${result.stderr || result.stdout || `exit ${result.code}`}`,
  );
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
 * Accepts the discovery step this runtime does not have.
 *
 * Git is already on the path or the worktree command would not have run, so
 * there is nothing to discover and nothing to version-match. Saying so here
 * keeps the caller from having to ask which runtime it is holding.
 *
 * @param {object} [runtime] - Ignored; no discovery receipt exists.
 * @returns {object | undefined} Whatever was passed, unchanged.
 */
export function assertLocalDiscovery(runtime) {
  return runtime;
}

/**
 * Reads the workspace a local creation receipt claims.
 *
 * @param {object} receipt - Receipt from {@link createWorkspace}.
 * @returns {object} Validated neutral workspace claim.
 * @throws {Error} When the receipt names no identity or path.
 */
export function readLocalWorkspaceClaim(receipt) {
  return assertWorkspaceReceipt({ id: receipt?.id, path: receipt?.path });
}

/**
 * Re-reads a claimed workspace from Git to confirm it is still that workspace.
 *
 * @param {object} claim - Claim from {@link readLocalWorkspaceClaim}.
 * @param {object} options - Parent repository and injectable runner.
 * @returns {Promise<object>} Confirmed workspace plus the raw observation.
 * @throws {Error} When Git reports no identity or a different branch.
 */
export async function confirmLocalWorkspace(claim, options) {
  const { parentRepo, execute = run } = options;
  const observed = await execute(
    [
      "git",
      "-C",
      claim.path,
      "rev-parse",
      "--show-toplevel",
      "--abbrev-ref",
      "HEAD",
    ],
    { cwd: parentRepo, timeoutMs: 30000 },
  );
  assert(
    observed.code === 0 && !observed.timedOut,
    "Git lookup does not match the supplied workspace claim",
  );
  const [toplevel, branch] = String(observed.stdout).trim().split(/\r?\n/);
  assert(
    branch === claim.id,
    "Git lookup does not match the supplied workspace claim",
  );
  return {
    ...assertWorkspaceReceipt({ id: branch, path: toplevel }),
    observed,
  };
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
