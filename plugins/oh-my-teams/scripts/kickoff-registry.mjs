/** Registry of the kickoffs running in a project, one entry per PM worktree. */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  assert,
  readJSON,
  validateOrg,
  withFileLock,
  writeJSON,
} from "./core.mjs";
import { closeKickoffSignals } from "./director.mjs";

/** Reasons a registered kickoff may be ended, in the order they end one. */
export const RELEASE_REASONS = ["completed", "disbanded", "taken-over"];

/**
 * How a kickoff's result reaches the project that owns it.
 *
 * `local-merge` merges into a branch of the project's own checkout with
 * `deliver`, `pull-request` delivers through a PR or MR against that branch,
 * and `none` leaves the result in the kickoff's worktrees. The brief states the
 * mode the user confirmed, and the claim records it as the authorization.
 */
export const DELIVERY_MODES = ["local-merge", "pull-request", "none"];

// Entries written before ids were hashed are named after the id itself.
const LEGACY_ENTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LEGACY_LEASE = "active-kickoff.json";

// Entries and claims written before the PM rename name the PM worktree
// `coordinator` and the self-supervision reason `selfCoordinator`.
const RENAMED_KEYS = [
  ["coordinator", "pm"],
  ["selfCoordinator", "selfPm"],
];

// Keys a kickoff-claim request may carry. `schemaVersion` and `createdAt` belong
// to stored entries but appear in claims copied from one, so they are not
// reported as mistakes. Any other key is dropped when the entry is written.
const CLAIM_KEYS = [
  "goal",
  "pm",
  "organizationRevision",
  "brief",
  "delivery",
  "selfPm",
  "director",
  "runId",
  "schemaVersion",
  "createdAt",
];
const DIRECTOR_KEYS = ["terminalHandle", "checkoutPath"];

function text(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Names the project checkout that owns an organization's kickoffs.
 *
 * @param {string} orgFile - Organization JSON path, `<project>/.omt/organization.json`.
 * @returns {string} Absolute project directory.
 */
export function ownerProject(orgFile) {
  return path.dirname(path.dirname(path.resolve(orgFile)));
}

function validateDelivery(delivery) {
  assert(
    delivery && DELIVERY_MODES.includes(delivery.mode),
    `Kickoff delivery.mode must be one of: ${DELIVERY_MODES.join(", ")}`,
  );
  assert(
    delivery.mode === "none" || text(delivery.branch),
    `Kickoff delivery.branch required for ${delivery.mode}`,
  );
}

/**
 * Resolves the registry directory that sits beside the organization.
 *
 * The registry must live with `organization.json` rather than in the PM
 * worktree: `.omt/` is a separate directory per worktree, so an entry written
 * inside the PM worktree is invisible to the session that closes it.
 *
 * @param {string} orgFile - Organization JSON path.
 * @returns {string} Absolute registry directory.
 * @throws {Error} When no organization path is given.
 */
export function registryDirectory(orgFile) {
  assert(text(orgFile), "Organization path required");
  return path.join(path.dirname(path.resolve(orgFile)), "kickoffs");
}

// Orca worktree ids are `<repoId>::<worktreePath>`, so they hold `:` and `/`.
// Any such string is accepted as given; only control characters are refused.
function isWorktreeId(value) {
  return Boolean(text(value)) && !/[\u0000-\u001f\u007f]/.test(value);
}

// The id cannot be a file name, so the file is named after its digest. A digest
// never contains a separator or `..`, which keeps every entry in the registry.
function entryName(worktreeId) {
  assert(isWorktreeId(worktreeId), "PM worktree id required");
  return crypto.createHash("sha256").update(worktreeId).digest("hex");
}

/**
 * Names the files a kickoff's registry entry and archives are stored under.
 *
 * @param {string} worktreeId - PM worktree id of the kickoff.
 * @returns {string} Hex digest used in the entry and history file names.
 * @throws {Error} When the id is empty or holds control characters.
 */
export function kickoffEntryName(worktreeId) {
  return entryName(worktreeId);
}

function entryFile(orgFile, worktreeId) {
  return path.join(registryDirectory(orgFile), `${entryName(worktreeId)}.json`);
}

// Finds the stored entry for a PM worktree, including one an earlier release
// named after the id itself, so kickoffs registered before stay closable.
function locateEntry(orgFile, worktreeId) {
  const file = entryFile(orgFile, worktreeId);
  if (fs.existsSync(file)) return file;
  if (!LEGACY_ENTRY_NAME.test(worktreeId)) return undefined;
  const legacy = path.join(registryDirectory(orgFile), `${worktreeId}.json`);
  if (!fs.existsSync(legacy)) return undefined;
  const entry = validateEntry(readJSON(legacy));
  return entry.pm.worktreeId === worktreeId ? legacy : undefined;
}

/**
 * Reads the pre-rename keys `coordinator` and `selfCoordinator` as `pm` and
 * `selfPm`.
 *
 * Stored entries and claim files written before the rename stay readable, and
 * the next write stores them under the new keys. A record that carries both
 * spellings with different values is refused rather than resolved silently.
 *
 * @param {object} record - Registry entry or kickoff claim.
 * @returns {object} A copy that uses only the current keys.
 * @throws {Error} When an old and a new key disagree.
 */
export function normalizeKickoffKeys(record) {
  if (!record || typeof record !== "object") return record;
  let normalized = record;
  for (const [old, current] of RENAMED_KEYS) {
    if (!Object.hasOwn(normalized, old)) continue;
    const { [old]: value, ...rest } = normalized;
    assert(
      normalized[current] === undefined ||
        isDeepStrictEqual(normalized[current], value),
      `Kickoff carries both ${old} and ${current} with different values; keep only ${current}`,
    );
    normalized = { ...rest, [current]: normalized[current] ?? value };
  }
  return normalized;
}

/**
 * Validates one registry entry's goal, PM worktree, brief, and timestamps.
 *
 * @param {object} stored - Registry entry to check, in either key spelling.
 * @returns {object} The entry under the current keys when every field is acceptable.
 * @throws {Error} When a field is missing or malformed.
 */
export function validateEntry(stored) {
  const entry = normalizeKickoffKeys(stored);
  assert(entry?.schemaVersion === 1, "Kickoff schemaVersion 1 required");
  assert(text(entry.goal), "Kickoff goal required");
  assert(text(entry.brief), "Kickoff brief path required");
  assert(text(entry.createdAt), "Kickoff createdAt required");
  assert(
    Number.isInteger(entry.organizationRevision) &&
      entry.organizationRevision >= 1,
    "Kickoff organizationRevision required",
  );
  assert(
    entry.runId === null || text(entry.runId),
    "Kickoff runId must be a run identifier or null",
  );
  const pm = entry.pm;
  assert(pm && typeof pm === "object", "Kickoff pm required");
  assert(isWorktreeId(pm.worktreeId), "Kickoff pm worktreeId required");
  for (const key of ["path", "stateDir"]) {
    assert(text(pm[key]), `Kickoff pm ${key} required`);
  }
  assert(
    entry.selfPm === undefined || text(entry.selfPm),
    "Kickoff selfPm must state why no handoff was possible",
  );
  // director is optional: entries registered before director support was added
  // are valid without it, and close/disband still work for them (with a warning).
  if (entry.director !== undefined) {
    assert(
      entry.director && typeof entry.director === "object",
      "Kickoff director must be an object when present",
    );
    assert(
      text(entry.director.terminalHandle) ||
        entry.director.terminalHandle === undefined,
      "Kickoff director.terminalHandle must be a non-empty string when present",
    );
    assert(
      text(entry.director.checkoutPath),
      "Kickoff director.checkoutPath required when director is present",
    );
  }
  // Entries registered before delivery was recorded carry neither field.
  if (entry.delivery !== undefined) validateDelivery(entry.delivery);
  assert(
    entry.delivered === undefined ||
      (text(entry.delivered?.head) && text(entry.delivered?.mergeCommit)),
    "Kickoff delivered must name the head and the merge commit",
  );
  return entry;
}

// A project that ran the single-lease release holds at most one lease file.
// It becomes that PM worktree's entry, so its kickoff stays closable.
function migrateLegacyLease(orgFile) {
  const legacy = path.join(path.dirname(path.resolve(orgFile)), LEGACY_LEASE);
  if (!fs.existsSync(legacy)) return;
  const entry = validateEntry(readJSON(legacy));
  const file = entryFile(orgFile, entry.pm.worktreeId);
  if (!fs.existsSync(file)) writeJSON(file, entry);
  fs.unlinkSync(legacy);
}

function withRegistry(orgFile, callback) {
  const directory = registryDirectory(orgFile);
  fs.mkdirSync(directory, { recursive: true });
  return withFileLock(
    path.join(directory, ".lock"),
    () => {
      migrateLegacyLease(orgFile);
      return callback();
    },
    "Kickoff registry update in progress; read it again",
  );
}

/**
 * Lists every registered kickoff, or the one a PM worktree holds.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} [worktreeId] - PM worktree to read alone.
 * @returns {{active: boolean, kickoffs: object[]}} Registered kickoffs.
 * @throws {Error} When a stored entry is unreadable or malformed.
 */
export function listKickoffs(orgFile, worktreeId) {
  // Reading takes no lock, so a status query never fails because another
  // session is registering a kickoff; only a legacy lease needs the write path.
  const legacy = path.join(path.dirname(path.resolve(orgFile)), LEGACY_LEASE);
  if (fs.existsSync(legacy)) withRegistry(orgFile, () => undefined);
  const directory = registryDirectory(orgFile);
  const names = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
  const kickoffs = names
    .filter((name) => name.endsWith(".json"))
    .map((name) => validateEntry(readJSON(path.join(directory, name))))
    .filter((entry) => !worktreeId || entry.pm.worktreeId === worktreeId)
    // File names are digests, so order by the id they stand for.
    .sort((a, b) => (a.pm.worktreeId < b.pm.worktreeId ? -1 : 1));
  return { active: kickoffs.length > 0, kickoffs };
}

/**
 * Compares a claimed handoff (director terminal and brief path) against the
 * registry entry for a PM worktree.
 *
 * A director's later instruction can arrive at an already-running PM as
 * terminal-typed text indistinguishable from an outsider's paste (#86). The
 * registry entry's `director.terminalHandle` and `brief` are written only by
 * `kickoff-claim`, which only the director runs, so a claim matching both is
 * treated as the director's; anything else — including a worktree the
 * registry has not bound yet, whose director-signal target is not settled —
 * is not.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {object} claim - Values the pasted-in text asserts about itself.
 * @param {string} claim.worktreeId - PM worktree the check runs for.
 * @param {string} claim.directorTerminal - Terminal handle the text claims as the director's.
 * @param {string} claim.brief - Brief path the text claims.
 * @returns {{match: boolean, reason: string, claimed: object, expected?: object}}
 *   `expected` is present only once a registry entry with a director exists.
 */
export function verifyHandoffClaim(
  orgFile,
  { worktreeId, directorTerminal, brief },
) {
  assert(worktreeId, "verifyHandoffClaim needs worktreeId");
  assert(directorTerminal, "verifyHandoffClaim needs directorTerminal");
  assert(brief, "verifyHandoffClaim needs brief");
  const claimed = {
    directorTerminal,
    brief: path.resolve(brief),
  };
  const { kickoffs } = listKickoffs(orgFile, worktreeId);
  const entry = kickoffs[0];
  if (!entry) return { match: false, reason: "not-registered", claimed };
  if (!entry.director?.terminalHandle) {
    return { match: false, reason: "no-director-recorded", claimed };
  }
  const expected = {
    directorTerminal: entry.director.terminalHandle,
    brief: path.resolve(entry.brief),
  };
  const match =
    expected.directorTerminal === claimed.directorTerminal &&
    expected.brief === claimed.brief;
  return { match, reason: match ? "matched" : "mismatch", claimed, expected };
}

/**
 * Registers a kickoff for a PM worktree.
 *
 * Any number of kickoffs may run in one project, each supervised from its own
 * PM worktree. One worktree still holds only one: its session owns a
 * single Goal and binds a single Run, so a second entry would have nobody to
 * supervise it.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {object} request - Goal, pm, brief path, and organizationRevision. The
 *   pre-rename keys `coordinator` and `selfCoordinator` are also accepted.
 * @returns {{claimed: boolean, file: string, entry: object, warnings?: string[]}}
 *   Stored entry, and the claim keys that were ignored when there were any.
 * @throws {Error} When the worktree already holds a kickoff or the claim is invalid.
 */
export function registerKickoff(orgFile, request) {
  return withRegistry(orgFile, () => {
    const claim = normalizeKickoffKeys(request) ?? {};
    const worktreeId = claim.pm?.worktreeId;
    const file = entryFile(orgFile, worktreeId);
    const held = locateEntry(orgFile, worktreeId);
    if (held) {
      const existing = validateEntry(readJSON(held));
      throw new Error(
        `Worktree ${worktreeId} already supervises a kickoff ` +
          `(goal: ${existing.goal}); use another PM worktree`,
      );
    }
    const brief = path.resolve(text(claim.brief) ?? "");
    assert(
      fs.existsSync(brief),
      "Brief file must exist before the kickoff is registered",
    );
    assert(fs.existsSync(orgFile), "No organization; run the form skill first");
    const revision = validateOrg(readJSON(orgFile)).revision;
    // The organization sits at <project>/.omt/organization.json. A PM worktree
    // at the project itself is the declaring session supervising its own
    // kickoff, which is allowed only where no handoff exists and the user
    // agreed, so the claim has to say so.
    const project = ownerProject(orgFile);
    const pmPath = path.resolve(text(claim.pm?.path) ?? "");
    assert(
      pmPath !== project || text(claim.selfPm),
      "The declaring session cannot be the PM; hand the kickoff to a child worktree, " +
        "or record selfPm with why no handoff exists and the user's approval",
    );
    // The mode the user confirmed in the brief is what authorizes delivering
    // into the project later, so a claim without one is not registered.
    validateDelivery(claim.delivery);
    assert(
      claim.organizationRevision === revision,
      `Organization is at revision ${revision}; read it again before registering`,
    );
    // A director object without a checkout path would otherwise resolve to the
    // caller's working directory and pass every later authority check from there.
    assert(
      claim.director === undefined || text(claim.director?.checkoutPath),
      "Claim director.checkoutPath required when director is present " +
        "(form: director: {terminalHandle, checkoutPath})",
    );
    // Unknown keys are dropped when the entry is written. Renamed director
    // fields would then register no director and later authority checks would
    // warn and proceed, so the claim's sender is told which keys were ignored.
    const ignored = [
      ...Object.keys(claim).filter((key) => !CLAIM_KEYS.includes(key)),
      ...Object.keys(claim.director ?? {})
        .filter((key) => !DIRECTOR_KEYS.includes(key))
        .map((key) => `director.${key}`),
    ];
    const warnings = ignored.map(
      (key) =>
        `Claim key "${key}" is not part of the claim format and was ignored`,
    );
    for (const warning of warnings) console.warn(`[omt] Warning: ${warning}`);
    const entry = validateEntry({
      schemaVersion: 1,
      goal: claim.goal,
      pm: {
        worktreeId,
        path: pmPath,
        stateDir: path.resolve(text(claim.pm.stateDir) ?? ""),
      },
      runId: claim.runId ?? null,
      organizationRevision: revision,
      brief,
      delivery: {
        mode: claim.delivery.mode,
        ...(claim.delivery.mode === "none"
          ? {}
          : { branch: claim.delivery.branch }),
      },
      ...(claim.selfPm === undefined ? {} : { selfPm: claim.selfPm }),
      // Director identifier is optional. When present, checkoutPath is required
      // and is resolved to an absolute path so callers can compare it to cwd().
      ...(claim.director === undefined
        ? {}
        : {
            director: {
              ...(text(claim.director?.terminalHandle)
                ? { terminalHandle: claim.director.terminalHandle }
                : {}),
              checkoutPath: path.resolve(
                text(claim.director?.checkoutPath) ?? "",
              ),
            },
          }),
      createdAt: new Date().toISOString(),
    });
    writeJSON(file, entry);
    return {
      claimed: true,
      file,
      entry,
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  });
}

/**
 * Records the Run a PM bound, once.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {{worktreeId: string, runId: string}} binding - PM worktree and its Run.
 * @returns {{bound: boolean, file: string, entry: object}} Updated entry.
 * @throws {Error} When the worktree holds no kickoff or a different Run is bound.
 */
export function bindKickoffRun(orgFile, { worktreeId, runId }) {
  return withRegistry(orgFile, () => {
    const file = locateEntry(orgFile, worktreeId);
    assert(file, `Worktree ${worktreeId} supervises no registered kickoff`);
    const entry = validateEntry(readJSON(file));
    assert(text(runId), "Run identifier required");
    // Re-running the same bind after a lost receipt is not a conflict; a
    // different Run means the PM has split its work in two.
    assert(
      entry.runId === null || entry.runId === runId,
      `Kickoff is already bound to run ${entry.runId}`,
    );
    const bound = validateEntry({ ...entry, runId });
    writeJSON(file, bound);
    return { bound: true, file, entry: bound };
  });
}

// Runs a git command in the given repository, returning stdout on success.
// Returns null when the command exits non-zero, so callers decide what to skip.
function tryGit(repoDir, args) {
  try {
    return execFileSync("git", args, {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

// Checks whether every commit reachable from tipRef is also reachable from
// baseRef, which means the kickoff branch's content has reached baseRef.
function isAncestor(repoDir, tipRef, baseRef) {
  const result = tryGit(repoDir, [
    "merge-base",
    "--is-ancestor",
    tipRef,
    baseRef,
  ]);
  // tryGit returns null on non-zero exit (tip is not an ancestor).
  return result !== null;
}

// Resolves a commit id to the full object name, or null when it names no commit.
// Only hexadecimal ids are accepted, so an option-like value never reaches git.
function resolveCommit(repoDir, id) {
  if (typeof id !== "string" || !/^[0-9a-fA-F]{7,64}$/.test(id)) return null;
  return tryGit(repoDir, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${id}^{commit}`,
  ]);
}

/**
 * Confirms in the owner checkout that a recorded merge really delivered a head.
 *
 * The merge commit must exist, must be reachable from the delivery branch (the
 * local branch, or `<remote>/<branch>` after a PR merged on the remote), and
 * must contain the delivered head. `kickoff-branch-cleanup` trusts the recorded
 * merge commit, so a value that fails here must never be stored.
 *
 * @param {string} projectDir - Owner project checkout holding the repository.
 * @param {{branch: string, head: string, mergeCommit: string, remoteName?: string}} delivery -
 *   Delivery branch and the two commits being recorded.
 * @returns {{head: string, mergeCommit: string}} Both commits as full object names.
 * @throws {Error} When a commit is unknown, unreachable from the branch, or the
 *   head is not contained in the merge commit.
 */
export function verifyDeliveredCommits(
  projectDir,
  { branch, head, mergeCommit, remoteName = "origin" },
) {
  const mergeFull = resolveCommit(projectDir, mergeCommit);
  assert(
    mergeFull,
    `Merge commit ${mergeCommit} is not a commit in ${projectDir}; fetch the merge first`,
  );
  const headFull = resolveCommit(projectDir, head);
  assert(headFull, `Delivered head ${head} is not a commit in ${projectDir}`);
  const refs = [`refs/heads/${branch}`];
  if (remoteName) refs.push(`refs/remotes/${remoteName}/${branch}`);
  assert(
    refs.some(
      (ref) =>
        tryGit(projectDir, ["rev-parse", "--verify", "--quiet", ref]) !==
          null && isAncestor(projectDir, mergeFull, ref),
    ),
    `Merge commit ${mergeFull} is not reachable from ${refs.join(" or ")}; ` +
      "it was not merged into the delivery branch, or the checkout has not fetched the merge yet",
  );
  assert(
    isAncestor(projectDir, headFull, mergeFull),
    `Delivered head ${headFull} is not contained in merge commit ${mergeFull}`,
  );
  return { head: headFull, mergeCommit: mergeFull };
}

/**
 * Records that a kickoff's result was merged into the owning project.
 *
 * The commits are checked against the owner checkout's git before anything is
 * written, and the full object names are stored.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {{worktreeId: string, head: string, mergeCommit: string, remoteName?: string}} delivery -
 *   PM worktree, the delivered head, the merge commit on the owner branch, and
 *   the remote whose branch may hold a merge made elsewhere (default `origin`).
 * @returns {{recorded: boolean, entry: object}} Updated entry.
 * @throws {Error} When the worktree holds no kickoff or delivers to no branch,
 *   another head was delivered, or the commits fail verification.
 */
export function recordDelivery(
  orgFile,
  { worktreeId, head, mergeCommit, remoteName = "origin" },
) {
  return withRegistry(orgFile, () => {
    const file = locateEntry(orgFile, worktreeId);
    assert(file, `Worktree ${worktreeId} supervises no registered kickoff`);
    const entry = validateEntry(readJSON(file));
    assert(
      text(entry.delivery?.branch),
      "Kickoff records no delivery branch to verify a merge against",
    );
    const verified = verifyDeliveredCommits(ownerProject(orgFile), {
      branch: entry.delivery.branch,
      head,
      mergeCommit,
      remoteName,
    });
    assert(
      !entry.delivered || entry.delivered.head === verified.head,
      `Kickoff already delivered ${entry.delivered?.head}`,
    );
    const updated = validateEntry({
      ...entry,
      delivered: entry.delivered ?? {
        head: verified.head,
        mergeCommit: verified.mergeCommit,
        at: new Date().toISOString(),
      },
    });
    writeJSON(file, updated);
    return { recorded: true, entry: updated };
  });
}

/**
 * Ends a registered kickoff and archives its entry.
 *
 * Other kickoffs are untouched. Ending one whose PM cannot be reached
 * is recorded as `taken-over`, which needs explicit authorization, so a failed
 * liveness query never retires a kickoff that may still be running. The
 * kickoff's pending director signals are closed after the entry is archived.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {object} request - Release request.
 * @param {string} request.worktreeId - PM worktree whose kickoff ends.
 * @param {string} request.reason - One of `RELEASE_REASONS`.
 * @param {boolean} [request.force=false] - Whether a takeover is authorized.
 * @param {string} [request.callerCwd] - Caller's working directory for director check.
 * @returns {{released: boolean, reason: string, archived: string, entry: object, closedSignals: string[]}} Result.
 * @throws {Error} When the worktree holds no kickoff, the reason is unknown, or
 *   a takeover is requested without authorization.
 */
export function releaseKickoff(
  orgFile,
  { worktreeId, reason, force = false, callerCwd = process.cwd() },
) {
  const released = withRegistry(orgFile, () => {
    const file = locateEntry(orgFile, worktreeId);
    assert(file, `Worktree ${worktreeId} supervises no registered kickoff`);
    const entry = validateEntry(readJSON(file));
    assert(
      RELEASE_REASONS.includes(reason),
      `Release reason must be one of: ${RELEASE_REASONS.join(", ")}`,
    );
    assert(
      reason !== "taken-over" || force,
      "A takeover needs explicit authorization; confirm it with the user first",
    );
    // Director authority: only the session at the registered checkout path may
    // release a kickoff. Legacy entries without a director field are allowed
    // through with a warning to keep existing kickoffs closable.
    if (!entry.director) {
      console.warn(
        "[omt] Warning: kickoff has no director record; kickoff-release proceeds without director verification.",
      );
    } else if (!force) {
      const expected = path.resolve(entry.director.checkoutPath);
      const actual = path.resolve(callerCwd);
      assert(
        actual === expected,
        `kickoff-release must be run from the director's checkout at ${expected}; ` +
          `current directory is ${actual}. ` +
          "Run from the owner project checkout, or pass --force with the director's explicit authorization.",
      );
    }
    // A kickoff whose brief asked for a merge into the project is not complete
    // until that merge is recorded, or `status` would show the goal delivered.
    assert(
      reason !== "completed" ||
        entry.delivery?.mode !== "local-merge" ||
        entry.delivered ||
        force,
      `Kickoff was to merge into ${entry.delivery?.branch}, which deliver has not recorded; ` +
        "run deliver first, or pass --force with the user's decision",
    );
    const archived = path.join(
      path.dirname(registryDirectory(orgFile)),
      "history",
      `kickoff-${entryName(worktreeId)}-${entry.createdAt.replace(/[:.]/g, "-")}.json`,
    );
    writeJSON(archived, {
      ...entry,
      releasedAt: new Date().toISOString(),
      releaseReason: reason,
    });
    fs.unlinkSync(file);
    return { released: true, reason, archived, entry };
  });
  // The inbox lock is taken only after the registry lock is released, so a
  // signal being sent, which reads the registry first, never waits in a cycle.
  const { closed } = closeKickoffSignals(orgFile, worktreeId, reason);
  return { ...released, closedSignals: closed };
}

/**
 * Deletes the kickoff's working branches after verifying delivery.
 *
 * The check is content-based: every commit reachable from the kickoff branch
 * must already be reachable from the delivery target (owner branch for
 * `local-merge`, or the merged PR head for `pull-request`). Deletion is
 * skipped, not forced, when the check cannot be confirmed.
 *
 * `disband` preserves branches so that failed results stay recoverable.
 * Call this function only from `close`, never from `disband`.
 *
 * @param {object} request - Cleanup request.
 * @param {string} request.projectDir - Absolute path of the owner project.
 * @param {object} request.entry - Validated kickoff registry entry.
 * @param {string[]} request.branches - Branch names to delete (local and
 *   remote share the same name; each is tried independently).
 * @param {string} [request.remoteName="origin"] - Git remote to push the
 *   deletions to. Pass an empty string to skip remote deletion.
 * @returns {{deleted: string[], skipped: string[], errors: string[]}} Result.
 */
export function cleanupKickoffBranches({
  projectDir,
  entry,
  branches,
  remoteName = "origin",
  callerCwd = process.cwd(),
  force = false,
}) {
  assert(
    typeof projectDir === "string" && projectDir,
    "projectDir required for branch cleanup",
  );
  assert(entry && typeof entry === "object", "registry entry required");
  assert(Array.isArray(branches), "branches must be an array");

  // Authority check: same policy as releaseKickoff.
  // Entries without a director record predate this feature; allowed with warning.
  if (!entry.director) {
    console.warn(
      "[omt] Warning: kickoff has no director record; kickoff-branch-cleanup proceeds without director verification.",
    );
  } else if (!force) {
    const expected = path.resolve(entry.director.checkoutPath);
    const actual = path.resolve(callerCwd);
    assert(
      actual === expected,
      `kickoff-branch-cleanup must be run from the director's checkout at ${expected}; ` +
        `current directory is ${actual}. ` +
        "Run from the owner project checkout, or pass --force with the director's explicit authorization.",
    );
  }

  const deleted = [];
  const skipped = [];
  const errors = [];

  // Determine the delivery target reference against which to verify content.
  let deliveryRef;
  if (entry.delivery?.mode === "local-merge" && entry.delivered?.mergeCommit) {
    deliveryRef = entry.delivered.mergeCommit;
  } else if (
    entry.delivery?.mode === "pull-request" &&
    entry.delivered?.mergeCommit
  ) {
    deliveryRef = entry.delivered.mergeCommit;
  }
  // delivery.mode === "none" or no delivered record: deliveryRef stays undefined.

  for (const branch of branches) {
    if (!branch || typeof branch !== "string") continue;

    // Verify that the branch's content has reached the delivery target before
    // deleting it. Branch name or PR status alone is not sufficient.
    if (deliveryRef) {
      const verified = isAncestor(projectDir, branch, deliveryRef);
      if (!verified) {
        skipped.push(branch);
        continue;
      }
    } else {
      // No delivery record: cannot confirm content was transferred.
      skipped.push(branch);
      continue;
    }

    // Delete the remote branch first so a local failure does not leave
    // the remote in a state the caller cannot see.
    if (remoteName) {
      const remoteResult = tryGit(projectDir, [
        "push",
        remoteName,
        "--delete",
        branch,
      ]);
      if (remoteResult === null) {
        // Remote branch may not exist (already deleted or never pushed); log but continue.
        errors.push(`remote:${branch}`);
      }
    }

    // Delete the local branch with --delete (safe; refuses unmerged).
    const localResult = tryGit(projectDir, ["branch", "--delete", branch]);
    if (localResult === null) {
      errors.push(`local:${branch}`);
    } else {
      deleted.push(branch);
    }
  }

  return { deleted, skipped, errors };
}
