/** Registry of the kickoffs running in a project, one entry per PM worktree. */
import crypto from "node:crypto";
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
 * @returns {{claimed: boolean, file: string, entry: object}} Stored entry.
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
      createdAt: new Date().toISOString(),
    });
    writeJSON(file, entry);
    return { claimed: true, file, entry };
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

/**
 * Records that a kickoff's result was merged into the owning project.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {{worktreeId: string, head: string, mergeCommit: string}} delivery -
 *   PM worktree, the delivered head, and the merge commit on the owner branch.
 * @returns {{recorded: boolean, entry: object}} Updated entry.
 * @throws {Error} When the worktree holds no kickoff or another head was delivered.
 */
export function recordDelivery(orgFile, { worktreeId, head, mergeCommit }) {
  return withRegistry(orgFile, () => {
    const file = locateEntry(orgFile, worktreeId);
    assert(file, `Worktree ${worktreeId} supervises no registered kickoff`);
    const entry = validateEntry(readJSON(file));
    assert(
      !entry.delivered || entry.delivered.head === head,
      `Kickoff already delivered ${entry.delivered?.head}`,
    );
    const updated = validateEntry({
      ...entry,
      delivered: entry.delivered ?? {
        head,
        mergeCommit,
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
 * liveness query never retires a kickoff that may still be running.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {object} request - Release request.
 * @param {string} request.worktreeId - PM worktree whose kickoff ends.
 * @param {string} request.reason - One of `RELEASE_REASONS`.
 * @param {boolean} [request.force=false] - Whether a takeover is authorized.
 * @returns {{released: boolean, reason: string, archived: string, entry: object}} Result.
 * @throws {Error} When the worktree holds no kickoff, the reason is unknown, or
 *   a takeover is requested without authorization.
 */
export function releaseKickoff(orgFile, { worktreeId, reason, force = false }) {
  return withRegistry(orgFile, () => {
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
}
