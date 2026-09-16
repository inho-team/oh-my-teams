/** Registry of the kickoffs running in a project, one entry per coordinator. */
import fs from "node:fs";
import path from "node:path";
import {
  assert,
  readJSON,
  validateOrg,
  withFileLock,
  writeJSON,
} from "./core.mjs";

/** Reasons a registered kickoff may be ended, in the order they end one. */
export const RELEASE_REASONS = ["completed", "disbanded", "taken-over"];
const WORKTREE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LEGACY_LEASE = "active-kickoff.json";

function text(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Resolves the registry directory that sits beside the organization.
 *
 * The registry must live with `organization.json` rather than in a coordinator
 * worktree: `.omt/` is a separate directory per worktree, so an entry written
 * inside the coordinator is invisible to the session that closes it.
 *
 * @param {string} orgFile - Organization JSON path.
 * @returns {string} Absolute registry directory.
 * @throws {Error} When no organization path is given.
 */
export function registryDirectory(orgFile) {
  assert(text(orgFile), "Organization path required");
  return path.join(path.dirname(path.resolve(orgFile)), "kickoffs");
}

function entryFile(orgFile, worktreeId) {
  assert(
    WORKTREE_ID_PATTERN.test(worktreeId ?? ""),
    "Coordinator worktree id required",
  );
  return path.join(registryDirectory(orgFile), `${worktreeId}.json`);
}

/**
 * Validates one registry entry's goal, coordinator, brief, and timestamps.
 *
 * @param {object} entry - Registry entry to check.
 * @returns {object} The same entry when every field is acceptable.
 * @throws {Error} When a field is missing or malformed.
 */
export function validateEntry(entry) {
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
  const coordinator = entry.coordinator;
  assert(
    coordinator && typeof coordinator === "object",
    "Kickoff coordinator required",
  );
  assert(
    WORKTREE_ID_PATTERN.test(coordinator.worktreeId ?? ""),
    "Kickoff coordinator worktreeId required",
  );
  for (const key of ["path", "stateDir"]) {
    assert(text(coordinator[key]), `Kickoff coordinator ${key} required`);
  }
  return entry;
}

// A project that ran the single-lease release holds at most one lease file.
// It becomes that coordinator's entry, so its kickoff stays closable.
function migrateLegacyLease(orgFile) {
  const legacy = path.join(path.dirname(path.resolve(orgFile)), LEGACY_LEASE);
  if (!fs.existsSync(legacy)) return;
  const entry = validateEntry(readJSON(legacy));
  const file = entryFile(orgFile, entry.coordinator.worktreeId);
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
 * Lists every registered kickoff, or the one a coordinator worktree holds.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} [worktreeId] - Coordinator worktree to read alone.
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
    .sort()
    .map((name) => validateEntry(readJSON(path.join(directory, name))))
    .filter(
      (entry) => !worktreeId || entry.coordinator.worktreeId === worktreeId,
    );
  return { active: kickoffs.length > 0, kickoffs };
}

/**
 * Registers a kickoff for a coordinator worktree.
 *
 * Any number of kickoffs may run in one project, each supervised from its own
 * coordinator worktree. One worktree still holds only one: its session owns a
 * single Goal and binds a single Run, so a second entry would have nobody to
 * supervise it.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {object} claim - Goal, coordinator, brief path, and organizationRevision.
 * @returns {{claimed: boolean, file: string, entry: object}} Stored entry.
 * @throws {Error} When the worktree already holds a kickoff or the claim is invalid.
 */
export function registerKickoff(orgFile, claim) {
  return withRegistry(orgFile, () => {
    const worktreeId = claim?.coordinator?.worktreeId;
    const file = entryFile(orgFile, worktreeId);
    if (fs.existsSync(file)) {
      const existing = validateEntry(readJSON(file));
      throw new Error(
        `Worktree ${worktreeId} already supervises a kickoff ` +
          `(goal: ${existing.goal}); use another coordinator worktree`,
      );
    }
    const brief = path.resolve(text(claim.brief) ?? "");
    assert(
      fs.existsSync(brief),
      "Brief file must exist before the kickoff is registered",
    );
    assert(fs.existsSync(orgFile), "No organization; run the form skill first");
    const revision = validateOrg(readJSON(orgFile)).revision;
    assert(
      claim.organizationRevision === revision,
      `Organization is at revision ${revision}; read it again before registering`,
    );
    const entry = validateEntry({
      schemaVersion: 1,
      goal: claim.goal,
      coordinator: {
        worktreeId,
        path: path.resolve(text(claim.coordinator.path) ?? ""),
        stateDir: path.resolve(text(claim.coordinator.stateDir) ?? ""),
      },
      runId: claim.runId ?? null,
      organizationRevision: revision,
      brief,
      createdAt: new Date().toISOString(),
    });
    writeJSON(file, entry);
    return { claimed: true, file, entry };
  });
}

/**
 * Records the Run a coordinator bound, once.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {{worktreeId: string, runId: string}} binding - Coordinator and its Run.
 * @returns {{bound: boolean, file: string, entry: object}} Updated entry.
 * @throws {Error} When the worktree holds no kickoff or a different Run is bound.
 */
export function bindKickoffRun(orgFile, { worktreeId, runId }) {
  return withRegistry(orgFile, () => {
    const file = entryFile(orgFile, worktreeId);
    assert(
      fs.existsSync(file),
      `Worktree ${worktreeId} supervises no registered kickoff`,
    );
    const entry = validateEntry(readJSON(file));
    assert(text(runId), "Run identifier required");
    // Re-running the same bind after a lost receipt is not a conflict; a
    // different Run means the coordinator has split its work in two.
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
 * Ends a registered kickoff and archives its entry.
 *
 * Other kickoffs are untouched. Ending one whose coordinator cannot be reached
 * is recorded as `taken-over`, which needs explicit authorization, so a failed
 * liveness query never retires a kickoff that may still be running.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {object} request - Release request.
 * @param {string} request.worktreeId - Coordinator whose kickoff ends.
 * @param {string} request.reason - One of `RELEASE_REASONS`.
 * @param {boolean} [request.force=false] - Whether a takeover is authorized.
 * @returns {{released: boolean, reason: string, archived: string, entry: object}} Result.
 * @throws {Error} When the worktree holds no kickoff, the reason is unknown, or
 *   a takeover is requested without authorization.
 */
export function releaseKickoff(orgFile, { worktreeId, reason, force = false }) {
  return withRegistry(orgFile, () => {
    const file = entryFile(orgFile, worktreeId);
    assert(
      fs.existsSync(file),
      `Worktree ${worktreeId} supervises no registered kickoff`,
    );
    const entry = validateEntry(readJSON(file));
    assert(
      RELEASE_REASONS.includes(reason),
      `Release reason must be one of: ${RELEASE_REASONS.join(", ")}`,
    );
    assert(
      reason !== "taken-over" || force,
      "A takeover needs explicit authorization; confirm it with the user first",
    );
    const archived = path.join(
      path.dirname(registryDirectory(orgFile)),
      "history",
      `kickoff-${worktreeId}-${entry.createdAt.replace(/[:.]/g, "-")}.json`,
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
