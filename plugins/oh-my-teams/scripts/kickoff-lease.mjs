/** Exclusive project-wide claim for the single active kickoff. */
import fs from "node:fs";
import path from "node:path";
import {
  assert,
  readJSON,
  validateOrg,
  withFileLock,
  writeJSON,
} from "./core.mjs";

/** Reasons a held kickoff may be given up, in the order they end a kickoff. */
export const RELEASE_REASONS = ["completed", "disbanded", "taken-over"];
const WORKTREE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function text(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Resolves the lease path that sits beside the organization it protects.
 *
 * The lease must live with `organization.json` rather than in the coordinator
 * worktree: `.omt/` is a separate directory per worktree, so a lease written
 * inside the coordinator is invisible to the session that would check it.
 *
 * @param {string} orgFile - Organization JSON path.
 * @returns {string} Absolute lease file path.
 * @throws {Error} When no organization path is given.
 */
export function leaseFile(orgFile) {
  assert(text(orgFile), "Organization path required");
  return path.join(path.dirname(path.resolve(orgFile)), "active-kickoff.json");
}

/**
 * Validates a lease record's required identity, coordinator, and timestamps.
 *
 * @param {object} lease - Lease record to check.
 * @returns {object} The same lease when every field is acceptable.
 * @throws {Error} When a field is missing or malformed.
 */
export function validateLease(lease) {
  assert(lease?.schemaVersion === 1, "Lease schemaVersion 1 required");
  assert(text(lease.goal), "Lease goal required");
  assert(text(lease.brief), "Lease brief path required");
  assert(text(lease.createdAt), "Lease createdAt required");
  assert(
    Number.isInteger(lease.organizationRevision) &&
      lease.organizationRevision >= 1,
    "Lease organizationRevision required",
  );
  assert(
    lease.runId === null || text(lease.runId),
    "Lease runId must be a run identifier or null",
  );
  const coordinator = lease.coordinator;
  assert(
    coordinator && typeof coordinator === "object",
    "Lease coordinator required",
  );
  assert(
    WORKTREE_ID_PATTERN.test(coordinator.worktreeId ?? ""),
    "Lease coordinator worktreeId required",
  );
  for (const key of ["path", "stateDir"]) {
    assert(text(coordinator[key]), `Lease coordinator ${key} required`);
  }
  return lease;
}

/**
 * Reads the current lease without taking or changing it.
 *
 * @param {string} orgFile - Organization JSON path.
 * @returns {{active: boolean, file: string, lease?: object}} Current holder.
 * @throws {Error} When a stored lease is unreadable or malformed.
 */
export function readLease(orgFile) {
  const file = leaseFile(orgFile);
  if (!fs.existsSync(file)) return { active: false, file };
  return { active: true, file, lease: validateLease(readJSON(file)) };
}

function currentRevision(orgFile) {
  assert(fs.existsSync(orgFile), "No organization; run the form skill first");
  return validateOrg(readJSON(orgFile)).revision;
}

function heldBy(lease) {
  return `${lease.coordinator.worktreeId} (goal: ${lease.goal})`;
}

/**
 * Claims the project's one kickoff slot for a coordinator worktree.
 *
 * The claim is written under an exclusive lock, so two sessions that both find
 * the project unclaimed cannot both proceed: the loser sees the winner's lease.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {object} claim - Goal, coordinator, brief path, and organizationRevision.
 * @returns {{claimed: boolean, file: string, lease: object}} Stored lease.
 * @throws {Error} When the project is already claimed or the claim is invalid.
 */
export function claimKickoff(orgFile, claim) {
  const file = leaseFile(orgFile);
  return withFileLock(
    `${file}.lock`,
    () => {
      if (fs.existsSync(file)) {
        const existing = validateLease(readJSON(file));
        throw new Error(
          `Active kickoff already held by ${heldBy(existing)}; ` +
            "resume it or close it before claiming another",
        );
      }
      const brief = path.resolve(text(claim?.brief) ?? "");
      assert(
        fs.existsSync(brief),
        "Brief file must exist before the kickoff is claimed",
      );
      const revision = currentRevision(orgFile);
      assert(
        claim.organizationRevision === revision,
        `Organization is at revision ${revision}; read it again before claiming`,
      );
      const lease = validateLease({
        schemaVersion: 1,
        goal: claim.goal,
        coordinator: {
          worktreeId: claim.coordinator?.worktreeId,
          path: path.resolve(text(claim.coordinator?.path) ?? ""),
          stateDir: path.resolve(text(claim.coordinator?.stateDir) ?? ""),
        },
        runId: claim.runId ?? null,
        organizationRevision: revision,
        brief,
        createdAt: new Date().toISOString(),
      });
      writeJSON(file, lease);
      return { claimed: true, file, lease };
    },
    "Kickoff claim in progress; read the lease again",
  );
}

/**
 * Records the Run the holding coordinator bound, once and only for itself.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {{worktreeId: string, runId: string}} binding - Caller and its Run.
 * @returns {{bound: boolean, file: string, lease: object}} Updated lease.
 * @throws {Error} When no lease is held, another worktree holds it, or a
 *   different Run is already bound.
 */
export function bindKickoffRun(orgFile, { worktreeId, runId }) {
  const file = leaseFile(orgFile);
  return withFileLock(
    `${file}.lock`,
    () => {
      assert(fs.existsSync(file), "No active kickoff to bind a Run to");
      const lease = validateLease(readJSON(file));
      assert(
        lease.coordinator.worktreeId === worktreeId,
        `Active kickoff is held by ${heldBy(lease)}`,
      );
      assert(text(runId), "Run identifier required");
      assert(
        lease.runId === null || lease.runId === runId,
        `Kickoff is already bound to run ${lease.runId}`,
      );
      const bound = validateLease({ ...lease, runId });
      writeJSON(file, bound);
      return { bound: true, file, lease: bound };
    },
    "Kickoff claim in progress; read the lease again",
  );
}

/**
 * Releases the project's kickoff slot and archives the lease that held it.
 *
 * A release names the coordinator it believes it is ending, so a session
 * holding stale knowledge cannot retire a kickoff that has moved on. Taking a
 * lease over from an unreachable coordinator is a separate, forced decision.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {object} request - Release request.
 * @param {string} request.worktreeId - Coordinator the caller means to end.
 * @param {string} request.reason - One of `RELEASE_REASONS`.
 * @param {boolean} [request.force=false] - Whether a takeover is authorized.
 * @returns {{released: boolean, reason: string, archived: string, lease: object}} Result.
 * @throws {Error} When nothing is held, the holder differs, or a takeover is
 *   requested without authorization.
 */
export function releaseKickoff(orgFile, { worktreeId, reason, force = false }) {
  const file = leaseFile(orgFile);
  return withFileLock(
    `${file}.lock`,
    () => {
      assert(fs.existsSync(file), "No active kickoff to release");
      const lease = validateLease(readJSON(file));
      assert(
        RELEASE_REASONS.includes(reason),
        `Release reason must be one of: ${RELEASE_REASONS.join(", ")}`,
      );
      assert(
        reason !== "taken-over" || force,
        "A takeover needs explicit authorization; confirm it with the user first",
      );
      assert(
        force || lease.coordinator.worktreeId === worktreeId,
        `Active kickoff is held by ${heldBy(lease)}`,
      );
      const archived = path.join(
        path.dirname(file),
        "history",
        `kickoff-${lease.createdAt.replace(/[:.]/g, "-")}.json`,
      );
      writeJSON(archived, {
        ...lease,
        releasedAt: new Date().toISOString(),
        releasedBy: worktreeId,
        releaseReason: reason,
      });
      fs.unlinkSync(file);
      return { released: true, reason, archived, lease };
    },
    "Kickoff claim in progress; read the lease again",
  );
}

/**
 * Refuses coordinator work started outside the worktree that holds the lease.
 *
 * Concurrency slots and the call budget are counted inside one workflow state,
 * so a second coordinator spends the same subscription without ever seeing the
 * first one's reservations. An unclaimed project is left alone: nothing has
 * asked for exclusivity there.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} stateDir - Coordinator state directory the caller is using.
 * @returns {{fenced: boolean, lease?: object}} Whether a lease was checked.
 * @throws {Error} When a lease is held by a different coordinator.
 */
export function assertCoordinator(orgFile, stateDir) {
  const current = readLease(orgFile);
  if (!current.active) return { fenced: false };
  const held = path.resolve(current.lease.coordinator.stateDir);
  assert(
    held === path.resolve(stateDir),
    `Active kickoff is held by ${heldBy(current.lease)}; ` +
      `its coordinator state is ${held}`,
  );
  return { fenced: true, lease: current.lease };
}
