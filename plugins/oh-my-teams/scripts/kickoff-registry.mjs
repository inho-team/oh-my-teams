/** Registry of the kickoffs running in a project, one entry per PM worktree. */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  AUDITOR_ROLE,
  assert,
  hash,
  readJSON,
  validateOrg,
  withFileLock,
  writeJSON,
} from "./core.mjs";
import { closeKickoffSignals } from "./director.mjs";
import { resolveGitCommonDir } from "./local-adapter.mjs";
import {
  assertKickoffCloseReady,
  confirmedLedgerFromClaim,
  validateLedgerForClaim,
  writeConfirmedLedger,
} from "./requirements.mjs";
// documents.mjs imports listKickoffs/kickoffHashFor from this module back, a
// circular import documents.mjs's module doc explains is safe here because
// every use on both sides happens inside a function body, never at either
// module's own top level (3.7 item 4). delivery.mjs imports listKickoffs
// etc. from this module the same way, so importing assertDirectorAuthority
// back from delivery.mjs follows the identical, already-safe pattern.
import { deliveryRefDocId, documentState } from "./documents.mjs";
import { assertDirectorAuthority } from "./delivery.mjs";
import { readLaunches } from "./usage-ledger.mjs";

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
  "requirements",
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

// Validates a claim's embedded requirements draft against its own declared
// director and persists the confirmed ledger. Runs inside registerKickoff's
// withRegistry lock; writeConfirmedLedger performs no locking of its own.
function withLedgerFromClaim(orgFile, claim, worktreeId) {
  assert(
    claim.requirements && typeof claim.requirements === "object",
    "Claim requirements ledger required (requirements-draft + requirements-confirm --draft, " +
      "then kickoff-claim carries it as claim.requirements)",
  );
  const requirements = validateLedgerForClaim(
    { ...claim.requirements, worktreeId },
    claim.director,
    orgFile,
  );
  const ledger = confirmedLedgerFromClaim(requirements, claim.director);
  const written = writeConfirmedLedger(orgFile, worktreeId, ledger);
  return written.ledgerHash;
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

/**
 * Computes the `kickoffHash` a registry entry's structured documents live
 * under (docs/plan/structured-omt-documents.md 3.7 items 5 and 7, contract A).
 *
 * Combines the entry's `worktreeId`, `createdAt`, and `registrationSeq` so
 * that releasing a kickoff and registering a new one at the same worktree,
 * even within the same millisecond, never reuses the previous instance's hash.
 *
 * @param {object} entry - Validated registry entry; must carry `registrationSeq`.
 * @returns {string} 64-character hex `kickoffHash`.
 * @throws {Error} When the entry predates `registrationSeq` (registered before this feature shipped).
 */
export function kickoffHashFor(entry) {
  assert(
    Number.isInteger(entry?.registrationSeq) && entry.registrationSeq >= 1,
    "Kickoff entry has no registrationSeq; it predates the structured document system",
  );
  return hash(
    `${entry.pm.worktreeId}\u0000${entry.createdAt}\u0000${entry.registrationSeq}`,
  );
}

/**
 * Classifies an entry against the structured document system's activation
 * boundary (structured-omt-documents.md 3.7 item 5, 3.10). An entry with a
 * registrationSeq is "current" regardless of the boundary. One without it is
 * "legacy" (registrationSeq absence is expected) when documentSystemActivatedAt
 * is unset or later than entry.createdAt, the same comparison validateLegacyRef
 * uses (documents.mjs); otherwise the entry was registered after activation and
 * should have a registrationSeq but does not, which is an "integrity-failure",
 * not a legacy one. Passing org as undefined (the orgFile-less default for
 * cleanupKickoffBranches) always resolves a registrationSeq-less entry to
 * "legacy", matching that function's documented no-orgFile contract.
 *
 * @param {object} entry - Registry entry to classify.
 * @param {object} [org] - Parsed organization.json, for `documentSystemActivatedAt`.
 * @returns {"current"|"legacy"|"integrity-failure"} The entry's classification.
 */
export function classifyKickoffEntry(entry, org) {
  if (entry.registrationSeq !== undefined) return "current";
  const activatedAt = org?.documentSystemActivatedAt;
  return !activatedAt || entry.createdAt < activatedAt
    ? "legacy"
    : "integrity-failure";
}

// Issues the next registrationSeq from <project>/.omt/kickoffs/.sequence.json,
// reusing writeJSON's atomic replace. Callers must already hold the registry
// lock (withRegistry), since the project-wide serialization it provides is
// what turns "same millisecond" registrations into a total order (3.7 item 7).
function nextRegistrationSeq(orgFile) {
  const seqFile = path.join(registryDirectory(orgFile), ".sequence.json");
  const next = fs.existsSync(seqFile) ? readJSON(seqFile).next : 1;
  writeJSON(seqFile, { next: next + 1 });
  return next;
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
  // Entries registered before the structured document system (wave-2) carry
  // no registrationSeq at all; kickoffHashFor refuses those instead.
  assert(
    entry.registrationSeq === undefined ||
      (Number.isInteger(entry.registrationSeq) && entry.registrationSeq >= 1),
    "Kickoff registrationSeq must be a positive integer when present",
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
  // requirements is optional so a kickoff registered before the ledger existed
  // (docs/plan/requirements-ledger-and-audit.md A.6) stays readable; the close
  // gates, not this validator, refuse such a kickoff without a retrofit.
  if (entry.requirements !== undefined) {
    assert(
      entry.requirements &&
        typeof entry.requirements.ledgerHash === "string" &&
        entry.requirements.ledgerHash.trim(),
      "Kickoff requirements.ledgerHash required when requirements is present",
    );
  }
  assert(
    entry.delivered === undefined ||
      (text(entry.delivered?.head) && text(entry.delivered?.mergeCommit)),
    "Kickoff delivered must name the head and the merge commit",
  );
  // auditPolicy is optional so entries registered before this feature existed
  // stay readable; there is no live-organization.json fallback for those (D1,
  // director decision msg_0b114271f1f5) — close, deliver and completed
  // release all refuse them outright until a director backfills one with
  // kickoffAuditPolicyRetrofit. Recorded once, either at kickoff-claim time
  // (registerKickoff) or through that retrofit, and never overwritten by
  // either path afterward, so removing org.auditor or re-running the retrofit
  // cannot erase or loosen an audit obligation this kickoff already took on.
  if (entry.auditPolicy !== undefined) {
    const policy = entry.auditPolicy;
    assert(
      policy &&
        typeof policy === "object" &&
        typeof policy.auditorConfigured === "boolean",
      "Kickoff auditPolicy.auditorConfigured must be a boolean when present",
    );
    assert(
      ["kickoff-claim", "retrofit"].includes(policy.source),
      'Kickoff auditPolicy.source must be "kickoff-claim" or "retrofit"',
    );
    assert(
      policy.auditorConfigured ? text(policy.profile) : policy.profile === null,
      "Kickoff auditPolicy.profile must name a profile when auditorConfigured is true, and must be null otherwise",
    );
    assert(
      policy.auditorConfigured
        ? Array.isArray(policy.fallbacks) &&
            new Set(policy.fallbacks).size === policy.fallbacks.length &&
            policy.fallbacks.every((id) => text(id))
        : policy.fallbacks === null,
      "Kickoff auditPolicy.fallbacks must be a unique profile-name array when auditorConfigured is true, and null otherwise",
    );
    assert(text(policy.pinnedAt), "Kickoff auditPolicy.pinnedAt required");
    if (policy.source === "retrofit") {
      assert(
        ["launch-ledger", "director-attestation"].includes(
          policy.retrofittedFrom,
        ),
        "Kickoff auditPolicy.retrofittedFrom must be launch-ledger or director-attestation for a retrofit",
      );
      assert(
        text(policy.reason),
        "Kickoff auditPolicy.reason required for a retrofit",
      );
      assert(
        policy.retrofittedBy && text(policy.retrofittedBy.checkoutPath),
        "Kickoff auditPolicy.retrofittedBy.checkoutPath required for a retrofit",
      );
    }
  }
  // auditor is optional: recorded only once `role-terminal --role auditor`
  // successfully opens this kickoff's audit terminal (B.2).
  if (entry.auditor !== undefined) {
    assert(
      entry.auditor && typeof entry.auditor === "object",
      "Kickoff auditor must be an object when present",
    );
    assert(
      text(entry.auditor.terminalHandle),
      "Kickoff auditor.terminalHandle required when auditor is present",
    );
    assert(
      text(entry.auditor.path),
      "Kickoff auditor.path required when auditor is present",
    );
  }
  if (entry.deliveryHistory !== undefined) {
    assert(
      Array.isArray(entry.deliveryHistory) &&
        entry.deliveryHistory.length > 0 &&
        entry.delivered,
      "Kickoff deliveryHistory requires a current delivery and previous records",
    );
    const heads = new Set([entry.delivered.head]);
    for (const record of entry.deliveryHistory) {
      assert(
        text(record?.head) && text(record?.mergeCommit) && text(record?.at),
        "Kickoff deliveryHistory records require head, merge commit and timestamp",
      );
      assert(
        !heads.has(record.head),
        "Kickoff deliveryHistory heads must be unique",
      );
      heads.add(record.head);
    }
  }
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
    // ".sequence.json" holds the registrationSeq counter, not an entry; entry
    // file names (digests or LEGACY_ENTRY_NAME) never start with a dot.
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .map((name) => validateEntry(readJSON(path.join(directory, name))))
    .filter((entry) => !worktreeId || entry.pm.worktreeId === worktreeId)
    // File names are digests, so order by the id they stand for.
    .sort((a, b) => (a.pm.worktreeId < b.pm.worktreeId ? -1 : 1));
  return { active: kickoffs.length > 0, kickoffs };
}

/**
 * Reports whether `child` is `parent` itself, or sits anywhere inside it, by
 * comparing their text. Standalone general-purpose helper, kept and tested
 * as its own text-only comparison; {@link resolveRegisteredKickoffFromState}
 * does not call this function directly, since it needs the exact-match and
 * ancestor roles kept apart with different fallbacks
 * ({@link isIdenticalDirectory}, {@link isSameOrWithinByIdentity}) rather
 * than one shared comparison.
 *
 * Both arguments should be resolved with `fs.realpathSync.native`, not the
 * plain `fs.realpathSync`: verified on macOS, whose default filesystem is
 * case-preserving-but-insensitive same as Windows', `fs.realpathSync`'s own
 * JS implementation returns the input spelling unchanged instead of the
 * volume's own on-disk casing (an existing `CaseTest/Inner` resolved through
 * `casetest/inner` comes back `casetest/inner`), while `fs.realpathSync.native`
 * returns `CaseTest/Inner`. On `platform: "win32"` this function additionally
 * case-insensitively compares (`toLowerCase`) BEFORE anything else, since
 * Windows' case-preserving-but-insensitive filesystem would otherwise let two
 * spellings of the identical directory compare unequal; this normalization is
 * NOT applied on other platforms (macOS, Linux, ...) even though macOS's own
 * default filesystem shares the same case-insensitive-but-preserving trait,
 * because a case-SENSITIVE volume (most Linux filesystems) can hold two
 * genuinely distinct directories differing only by case, and lowercasing
 * unconditionally would wrongly call them the same. Depth is unbounded on
 * purpose: `pm-wt/.omt/inner`, `pm-wt/sub/.omt`, and `pm-wt/a/b/c` are all
 * "inside" `pm-wt` the same as `pm-wt/.omt` itself is.
 *
 * @param {string} parent - `fs.realpathSync.native`'d candidate ancestor directory.
 * @param {string} child - `fs.realpathSync.native`'d candidate descendant (or the same) directory.
 * @param {object} [options] - Injectable Node `path` implementation and platform.
 * @param {typeof import("node:path")} [options.path] - `path`/`path.win32`/
 *   `path.posix`, so a unit test can exercise Windows-shaped comparisons on
 *   any host, including this one.
 * @param {string} [options.platform] - `process.platform` by default; pass
 *   `"win32"` alongside `options.path` to test the case-insensitive branch
 *   on a non-Windows host.
 * @returns {boolean} Whether `child` is `parent` itself or a path beneath it.
 */
export function isSameOrWithin(
  parent,
  child,
  { path: pathImpl = path, platform = process.platform } = {},
) {
  const normalize = (value) =>
    platform === "win32" ? value.toLowerCase() : value;
  const normalizedParent = normalize(parent);
  const normalizedChild = normalize(child);
  // Compared as normalized strings, not the raw `parent`/`child` arguments:
  // on `platform: "win32"` two differently-cased spellings of the identical
  // directory must count as the same directory, which a raw `===` here would
  // miss (and which `path.relative` resolving to `""` also signals, but only
  // once it is fed the normalized values below, not the raw ones).
  if (normalizedParent === normalizedChild) return true;
  const relative = pathImpl.relative(normalizedParent, normalizedChild);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${pathImpl.sep}`) &&
    !pathImpl.isAbsolute(relative)
  );
}

/**
 * Compares two paths by device+inode, returning `true`/`false` when both
 * sides report a trustworthy inode, or `null` when the comparison cannot be
 * trusted at all -- either path failed to stat, or either side reports
 * `ino: 0n`. Several Windows filesystems report `ino: 0` for paths they do
 * not track a real inode number for, and treating two such zeroes as equal
 * would call unrelated directories the same; a caller receiving `null` must
 * fall back to some other comparison rather than reading it as "not the same
 * directory".
 *
 * Stats with `{ bigint: true }`, not the default `number` stat: Node's
 * default `number` inode can lose precision past `Number.MAX_SAFE_INTEGER`
 * on a 64-bit inode, which would risk two distinct large inodes coinciding
 * after rounding; `bigint` compares the full value exactly.
 *
 * @param {string} a - First directory path.
 * @param {string} b - Second directory path.
 * @param {object} [options] - Injectable stat function, for tests.
 * @param {(path: string) => {dev: bigint, ino: bigint}} [options.stat] -
 *   `fs.statSync(path, { bigint: true })` by default; pass a fake to
 *   simulate an unreliable (`ino: 0n`) stat without a real filesystem that
 *   reports one.
 * @returns {boolean | null} Device+inode equality, or `null` if the
 *   comparison is not trustworthy.
 */
function sameDirectoryByInode(a, b, { stat = defaultBigIntStat } = {}) {
  let statA;
  let statB;
  try {
    statA = stat(a);
    statB = stat(b);
  } catch {
    return null;
  }
  if (statA.ino === 0n || statB.ino === 0n) return null;
  return statA.dev === statB.dev && statA.ino === statB.ino;
}

function defaultBigIntStat(target) {
  return fs.statSync(target, { bigint: true });
}

/**
 * Reports whether `a` and `b` name the identical on-disk directory, for
 * EXACT-MATCH use only (recognizing a registered kickoff's own stateDir as
 * itself) -- never for "is this inside that worktree"
 * ({@link isSameOrWithinByIdentity} answers that, deliberately with a
 * different, more permissive fallback). Prefers {@link sameDirectoryByInode},
 * which is immune to case, Unicode normalization, or any other respelling
 * neither realpath implementation canonicalizes; only when that comparison
 * is untrustworthy (an unreliable/zero inode, or a stat failure) does this
 * fall back to a byte-for-byte `===` of `a` and `b`, deliberately WITHOUT
 * win32-lowercase normalization: Windows can configure a directory to be
 * case-sensitive, so `C:\PM\.omt` and `C:\PM\.OMT` can be two genuinely
 * distinct directories even there, and casefold-equating them in this
 * exact-match role would let an attacker's differently-cased directory be
 * misidentified as the registered stateDir, dodging its unresolved
 * objection entirely -- the exact accept-bypass this whole check exists to
 * close. Actual Windows inode-reliability and per-directory case-sensitivity
 * behavior is confirmed by this repository's own Windows CI runner, not
 * simulated in this file's unit tests.
 *
 * @param {string} a - First `fs.realpathSync.native`'d directory.
 * @param {string} b - Second `fs.realpathSync.native`'d directory.
 * @param {object} [options] - Injectable stat function, for tests.
 * @param {Function} [options.stat] - Forwarded to {@link sameDirectoryByInode}.
 * @returns {boolean} Whether `a` and `b` are the same directory.
 */
export function isIdenticalDirectory(a, b, { stat } = {}) {
  const byInode = sameDirectoryByInode(a, b, { stat });
  if (byInode !== null) return byInode;
  return a === b;
}

/**
 * Compares two paths for EXACT-MATCH-OR-CASEFOLD equality: device+inode
 * identity when trustworthy, else a win32-lowercase-normalized (unnormalized
 * elsewhere) text comparison. This is deliberately more permissive than
 * {@link isIdenticalDirectory} and must only ever back
 * {@link isSameOrWithinByIdentity}'s per-ancestor comparison, never exact
 * stateDir identity: a directory this function calls "the same" as
 * `pm.path` purely by casefold, but that is not actually byte-identical to
 * it, still only ever earns an ANCESTOR match (the caller's `--state` is
 * refused as "inside the registered worktree"), never an exact-match
 * acceptance -- over-rejection, the safe direction to err in when an inode
 * cannot be trusted.
 *
 * @param {string} a - First `fs.realpathSync.native`'d directory.
 * @param {string} b - Second `fs.realpathSync.native`'d directory.
 * @param {object} [options] - Injectable platform and stat function, for tests.
 * @param {string} [options.platform] - `process.platform` by default; pass
 *   `"win32"` to test the casefold fallback on a non-Windows host.
 * @param {Function} [options.stat] - Forwarded to {@link sameDirectoryByInode}.
 * @returns {boolean} Whether `a` and `b` are the same directory, allowing a
 *   casefold match when inode identity cannot be trusted.
 */
function sameDirectoryOrCasefold(
  a,
  b,
  { platform = process.platform, stat } = {},
) {
  const byInode = sameDirectoryByInode(a, b, { stat });
  if (byInode !== null) return byInode;
  const normalize = (value) =>
    platform === "win32" ? value.toLowerCase() : value;
  return normalize(a) === normalize(b);
}

/**
 * Reports whether `child` is `parent` itself, or sits anywhere inside it, by
 * walking from `child` up through `path.dirname` (stopping once it stops
 * changing, i.e. the filesystem root) and testing each ancestor -- including
 * `child` itself -- against `parent` with {@link sameDirectoryOrCasefold}
 * (NOT {@link isIdenticalDirectory}: see that function's own doc for why the
 * two must never share a comparison, only its name suggests otherwise).
 * Each step prefers device+inode identity and falls back to a casefold text
 * comparison only where that step's inode comparison is untrustworthy, so a
 * respelling neither realpath implementation canonicalizes is still caught
 * without an unreliable inode manufacturing a false EXACT match (it can
 * still manufacture a false ANCESTOR match, which is the safe direction).
 *
 * @param {string} parent - `fs.realpathSync.native`'d candidate ancestor directory.
 * @param {string} child - `fs.realpathSync.native`'d candidate descendant (or the same) directory.
 * @param {object} [options] - Forwarded to {@link sameDirectoryOrCasefold}.
 * @returns {boolean} Whether `child` is `parent` itself or a path beneath it.
 */
export function isSameOrWithinByIdentity(parent, child, options) {
  let current = child;
  for (;;) {
    if (sameDirectoryOrCasefold(parent, current, options)) return true;
    const up = path.dirname(current);
    if (up === current) return false;
    current = up;
  }
}

/**
 * Reports whether `target` shares a worktree with any of `candidates`: is
 * identical to one, sits anywhere inside one, or one sits anywhere inside it
 * (D4, design B.2's "pathWithin", replacing an exact string-set membership
 * test that a symlink, a case variant, or a nested path could all defeat).
 * Comparison is by filesystem identity via {@link isSameOrWithinByIdentity}
 * in both directions, on `fs.realpathSync.native`'d paths; a path that
 * cannot be resolved (already removed, or not yet created) falls back to its
 * plain `path.resolve`d text so a missing directory still compares, rather
 * than silently dropping out of the check.
 *
 * @param {string} target - Directory to test (e.g. the auditor's chosen worktree).
 * @param {string[]} candidates - Directories `target` must stay independent of.
 * @returns {boolean} Whether `target` shares a worktree with any candidate.
 */
export function sharesWorktreeWithAny(target, candidates) {
  const resolve = (value) => {
    try {
      return fs.realpathSync.native(value);
    } catch {
      return path.resolve(value);
    }
  };
  const targetResolved = resolve(target);
  return candidates.some((candidate) => {
    const candidateResolved = resolve(candidate);
    return (
      isSameOrWithinByIdentity(candidateResolved, targetResolved) ||
      isSameOrWithinByIdentity(targetResolved, candidateResolved)
    );
  });
}

/**
 * Finds the registered kickoff, if any, that a PM state directory belongs to.
 *
 * Resolution is anchored on `stateDir` itself, never a caller-supplied
 * `--repo` (which a caller could swap for a different repository), using
 * {@link resolveGitCommonDir} to find the owner project the same way Git
 * would. Whether the owner organization has an auditor at all plays no part
 * in this lookup (structured-omt-documents.md/requirements-ledger-and-audit.md
 * B.5): "registered" is the only question, since an organization with no
 * audit activity already has no unresolved objections for a caller to skip.
 * Both `target` and every entry's `pm.stateDir`/`pm.path` are resolved with
 * `fs.realpathSync.native`, not the plain `fs.realpathSync`, because a
 * registered entry's `pm.stateDir` is stored only `path.resolve`d, not
 * realpath'd, so a symlinked `--state` would otherwise compare unequal to its
 * own registration -- and because the plain `fs.realpathSync` does not
 * canonicalize case on a case-preserving-but-insensitive filesystem (macOS's
 * default one included, verified directly: an existing `CaseTest/Inner`
 * resolved through `casetest/inner` comes back `casetest/inner`, unchanged,
 * from `fs.realpathSync`, while `fs.realpathSync.native` returns the on-disk
 * `CaseTest/Inner`). Neither exact-match nor the same-worktree check below
 * stops at that realpath text, though, and the two deliberately do NOT share
 * one comparison function: exact-match uses {@link isIdenticalDirectory},
 * which prefers device+inode identity and drops to a byte-for-byte (never
 * casefolded) text comparison only where the inode comparison is
 * untrustworthy, so a `--state` differing from its own registration only by
 * case is never misidentified as the registered stateDir itself (Windows can
 * configure a directory case-sensitive, so two such spellings can be
 * genuinely distinct there, and casefold-equating them here would be an
 * accept-bypass in its own right). The same-worktree check instead uses
 * {@link isSameOrWithinByIdentity}, which is allowed a casefold fallback
 * where the inode is untrustworthy, since its only failure direction is
 * over-rejection ("shares the registered worktree"), the safe one to err in.
 *
 * A `stateDir` outside any Git working tree, whose owner project has no
 * `.omt/organization.json`, whose organization has never registered any
 * kickoff at all, or that sits in a DIFFERENT worktree of the owner Git
 * repository than any registered kickoff's own `pm.path` — a Senior/Worker
 * child worktree's own task state, for instance — resolves to `null`:
 * genuinely unregistered solo usage, where the caller's own
 * orgFile/worktreeId (if any) apply unchanged. Only a `stateDir` that sits
 * INSIDE a registered kickoff's own worktree (`pm.path`, realpath-compared,
 * at any depth — a direct child, a nested worktree several levels down, or
 * anything in between, not merely a direct child directory) but is not that
 * kickoff's exact `pm.stateDir` is fail-closed and throws
 * rather than returning `null`: that is a caller pointing `--state`
 * somewhere else inside the one PM directory an audited kickoff actually
 * registered, which is exactly the accept-bypass this function exists to
 * close, not a legitimate sibling task. The same fail-closed rule covers a
 * Git call failing for a reason other than "not a git repository", a
 * malformed `organization.json` (validated with {@link validateOrg}, so a
 * structurally broken org file cannot silently steer
 * {@link classifyKickoffEntry} the way one of its fields being read
 * `undefined` could), a registry entry that fails validation, and a matched
 * entry that {@link classifyKickoffEntry} calls `"integrity-failure"`
 * (registered after the structured document system activated but missing
 * its `registrationSeq`, so it is not ordinary legacy leniency). An entry
 * whose own recorded `pm.stateDir` can no longer be resolved is not simply
 * dropped from consideration either: when its recorded path is (string-)
 * identical to `stateDir` it still counts as a match (an attacker cannot
 * defeat this check by deleting exactly the entry that should have matched),
 * while any other, unrelated entry with a broken `pm.stateDir` is ignored, so
 * one kickoff's stale bookkeeping never blocks a lookup for a different,
 * healthy one.
 *
 * @param {string} stateDir - PM worktree `.omt` state directory to identify.
 * @param {object} [options] - Injectable runner, for tests.
 * @param {Function} [options.execute] - Passed through to {@link resolveGitCommonDir}.
 * @returns {Promise<{orgFile: string, worktreeId: string, kickoffHash: (string|undefined)} | null>}
 *   The kickoff this state directory is registered under, or `null`.
 * @throws {Error} On any failure other than "not inside a Git repository" or
 *   "no organization.json (or no registered kickoff at all) beside the owner project".
 */
export async function resolveRegisteredKickoffFromState(
  stateDir,
  options = {},
) {
  assert(
    typeof stateDir === "string" && stateDir.trim(),
    "PM state directory required to resolve its registered kickoff",
  );
  const commonDir = await resolveGitCommonDir(stateDir, options);
  if (commonDir === null) return null;
  const candidateOrgFile = path.join(
    path.dirname(commonDir),
    ".omt",
    "organization.json",
  );
  if (!fs.existsSync(candidateOrgFile)) return null;
  const org = validateOrg(readJSON(candidateOrgFile));
  const { kickoffs } = listKickoffs(candidateOrgFile);
  if (kickoffs.length === 0) return null;
  const target = fs.realpathSync.native(stateDir);
  const targetResolved = path.resolve(stateDir);
  const resolvedEntries = kickoffs.map((entry) => {
    const entryResolved = path.resolve(entry.pm.stateDir);
    let entryState;
    try {
      entryState = fs.realpathSync.native(entry.pm.stateDir);
    } catch {
      // An entry whose own recorded stateDir cannot be resolved is not
      // silently dropped: if its recorded path is literally this `stateDir`
      // (string-resolved, not realpath'd, since that is exactly what just
      // failed), it is treated as matching anyway, because an attacker
      // deleting/breaking their own registered entry to dodge the objection
      // check below must not work. Any OTHER entry with an unrelated broken
      // stateDir is simply irrelevant to this lookup and must not block it
      // (an unregistered child/solo stateDir sitting beside a kickoff whose
      // own directory happens to be missing, for instance).
      entryState = entryResolved === targetResolved ? target : null;
    }
    return { entry, entryState };
  });
  const match = resolvedEntries.find(
    (r) => r.entryState !== null && isIdenticalDirectory(r.entryState, target),
  );
  if (!match) {
    // A directory ANYWHERE inside a registered kickoff's own worktree
    // (`pm.path`, realpath-compared, at any depth — not only a direct child)
    // but not the exact `pm.stateDir` it registered is still refused, not
    // treated as an unregistered solo task: `pm-wt/.omt/inner`, `pm-wt/sub/
    // .omt`, and `pm-wt/a/b/c` are all a caller pointing `--state` somewhere
    // else inside the one audited PM worktree to dodge the objection check
    // below, exactly as much as a direct child of `pm-wt` would be. A
    // legitimate DIFFERENT worktree of the same owner Git repository (a
    // Senior/Worker child worktree's own task state, for instance) is
    // ordinary unregistered solo usage and must fall through to `null`, not
    // fail-closed, or every child worktree under an audited organization
    // would be unable to accept at all — but a worktree nested inside a
    // registered kickoff's own `pm.path` is refused along with it, since it
    // is still inside that same audited tree. Walked with
    // `isSameOrWithinByIdentity`, which favors device+inode identity per
    // ancestor step and drops to a CASEFOLD text comparison (deliberately
    // more permissive than the exact-match check above) only where that
    // step's inode comparison is untrustworthy: an over-broad "shares this
    // worktree" refusal here is the safe failure direction, unlike exact
    // match, where the same permissiveness would be an accept-bypass.
    const sameWorktreeOtherState = resolvedEntries.find((r) => {
      try {
        const pmPath = fs.realpathSync.native(r.entry.pm.path);
        return isSameOrWithinByIdentity(pmPath, target);
      } catch {
        return false;
      }
    });
    if (!sameWorktreeOtherState) return null;
    throw new Error(
      `${stateDir} sits inside worktree ${sameWorktreeOtherState.entry.pm.path}, ` +
        `whose registered kickoff (${sameWorktreeOtherState.entry.pm.worktreeId}) ` +
        `names a different pm.stateDir; refusing to accept from a directory ` +
        "that shares the registered kickoff's own worktree but is not the " +
        "exact state directory it registered",
    );
  }
  // classifyKickoffEntry (not a bare registrationSeq check) tells apart an
  // entry that predates the structured document system ("legacy", expected
  // and safe to give no kickoffHash) from one that postdates it yet still has
  // no registrationSeq ("integrity-failure"): a registry that should have
  // stamped one and did not, which this refuses to treat as ordinary legacy
  // leniency.
  const classification = classifyKickoffEntry(match.entry, org);
  assert(
    classification !== "integrity-failure",
    `Kickoff registry entry for worktree ${match.entry.pm.worktreeId} failed ` +
      "its integrity classification (registered after the structured " +
      "document system activated but has no registrationSeq); refusing to " +
      "trust it for acceptance",
  );
  const kickoffHash =
    classification === "current" ? kickoffHashFor(match.entry) : undefined;
  return {
    orgFile: candidateOrgFile,
    worktreeId: match.entry.pm.worktreeId,
    kickoffHash,
  };
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
    const organizationAtClaim = validateOrg(readJSON(orgFile));
    const revision = organizationAtClaim.revision;
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
    // A new claim must carry an already-confirmed requirements draft
    // (docs/plan/requirements-ledger-and-audit.md A.2/A.6); validation runs
    // against the claim's own declared director, so no registry lookup is
    // needed and the pre-registration deadlock never arises.
    const claimedLedgerHash = withLedgerFromClaim(orgFile, claim, worktreeId);
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
      requirements: { ledgerHash: claimedLedgerHash },
      // Pinned once, from this moment's organization.json (D1): close-ready
      // and every other audit-policy consumer must read this fixed value
      // instead of re-reading organization.json, so removing org.auditor
      // after the fact cannot retroactively waive this kickoff's audit. The
      // full {profile, fallbacks} shape is pinned too, not just the boolean,
      // so role-terminal --role auditor can run from this entry alone
      // (director decision msg_0b114271f1f5, checklist 5).
      auditPolicy: organizationAtClaim.auditor
        ? {
            auditorConfigured: true,
            profile: organizationAtClaim.auditor.profile,
            fallbacks: organizationAtClaim.auditor.fallbacks ?? [],
            source: "kickoff-claim",
            pinnedAt: new Date().toISOString(),
          }
        : {
            auditorConfigured: false,
            profile: null,
            fallbacks: null,
            source: "kickoff-claim",
            pinnedAt: new Date().toISOString(),
          },
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
      registrationSeq: nextRegistrationSeq(orgFile),
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

/**
 * Records which terminal and worktree opened as a kickoff's auditor.
 *
 * Called once `role-terminal --role auditor` (B.2) has already checked
 * director authority and worktree independence; this only persists the
 * result. A later auditor launch for the same kickoff overwrites the record,
 * since an auditor terminal may be reopened.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {{worktreeId: string, terminalHandle: string, path: string}} launch -
 *   PM worktree the auditor reviews, the terminal handle it opened as, and
 *   the worktree it runs from.
 * @returns {{recorded: true, file: string, entry: object}} Updated entry.
 * @throws {Error} When the worktree holds no registered kickoff.
 */
export function recordAuditorLaunch(
  orgFile,
  { worktreeId, terminalHandle, path: auditorPath },
) {
  return withRegistry(orgFile, () => {
    const file = locateEntry(orgFile, worktreeId);
    assert(file, `Worktree ${worktreeId} supervises no registered kickoff`);
    const entry = validateEntry(readJSON(file));
    const updated = validateEntry({
      ...entry,
      auditor: {
        terminalHandle: text(terminalHandle),
        path: text(auditorPath),
      },
    });
    writeJSON(file, updated);
    return { recorded: true, file, entry: updated };
  });
}

/**
 * Permanently pins the audit policy of a kickoff registered before
 * `auditPolicy` was recorded at claim time (D1, director decision
 * msg_0b114271f1f5).
 *
 * Only the kickoff's registered director may run this, from the registered
 * checkout path (`assertDirectorAuthority`, no `force`). The director must
 * state `auditorConfigured` explicitly; nothing here infers it from a live
 * `organization.json` read; that inference is exactly the D1 bypass this
 * command exists to close. The launch ledger is consulted only to refuse an
 * attestation it already contradicts: a recorded `role-terminal --role
 * auditor` launch for this kickoff makes `auditorConfigured: false` refused
 * outright. An absent ledger entry proves nothing either way (the ledger can
 * be edited directly, so it is corroborating evidence, never the sole basis)
 * and never substitutes for the director's own statement.
 *
 * Once written, `auditPolicy` can never be retrofitted again: a second call
 * for the same worktree is refused regardless of what it asks for, so a
 * pinned policy cannot be relaxed, cleared or re-pinned after the fact. This
 * also covers a kickoff whose `auditPolicy` was already pinned at claim time
 * by `registerKickoff` — retrofit is only for the legacy entries that
 * predate that pinning.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree of the kickoff to retrofit.
 * @param {object} request - Retrofit request.
 * @param {boolean} request.auditorConfigured - Director's explicit statement.
 * @param {string} [request.profile] - Auditor profile to pin; required, and
 *   must name a profile declared in `organization.json`, when
 *   `auditorConfigured` is true. Refused when `auditorConfigured` is false.
 * @param {string[]} [request.fallbacks] - Auditor fallback profiles to pin,
 *   each also required to name a profile in `organization.json`.
 * @param {string} request.reason - Non-empty justification, recorded as-is.
 * @param {string} [request.callerCwd=process.cwd()] - Caller's actual working
 *   directory (proof, not a caller-declared value), checked against the
 *   kickoff's registered director.
 * @returns {{retrofitted: boolean, auditPolicy: object}} The pinned policy.
 * @throws {Error} When the kickoff is unregistered, already has a pinned
 *   policy, the caller is not its registered director, `reason` is empty,
 *   `auditorConfigured` is not a boolean, the launch ledger already
 *   contradicts an `auditorConfigured: false` statement, or a named profile
 *   is not declared in `organization.json`.
 */
export function kickoffAuditPolicyRetrofit(
  orgFile,
  worktreeId,
  { auditorConfigured, profile, fallbacks, reason, callerCwd = process.cwd() },
) {
  return withRegistry(orgFile, () => {
    const file = locateEntry(orgFile, worktreeId);
    assert(file, `Worktree ${worktreeId} supervises no registered kickoff`);
    const entry = validateEntry(readJSON(file));
    assert(
      entry.auditPolicy === undefined,
      `Kickoff ${worktreeId} already has a pinned audit policy; ` +
        "it cannot be re-pinned, relaxed or cleared",
    );
    // assertDirectorAuthority warns and allows through when entry.director is
    // absent (a legacy accommodation other operations rely on); the director
    // decision's "항상 등록 이사 권한" for this specific command means that
    // accommodation does not apply here, so an unregistered-director entry
    // is refused outright instead of silently letting anyone retrofit it.
    assert(
      entry.director,
      `Kickoff ${worktreeId} has no registered director; ` +
        "its audit policy cannot be retrofitted until a director is recorded for it",
    );
    assertDirectorAuthority(entry, callerCwd, "kickoff-audit-policy-retrofit");
    assert(
      typeof reason === "string" && reason.trim(),
      "--reason is required and must be a non-empty justification",
    );
    assert(
      typeof auditorConfigured === "boolean",
      "--auditor-configured true|false is required as the director's explicit statement",
    );
    const hasAuditorLaunch = readLaunches(orgFile).some(
      (line) =>
        line.kickoffPmWorktreeId === entry.pm.worktreeId &&
        line.role === AUDITOR_ROLE,
    );
    assert(
      !(hasAuditorLaunch && auditorConfigured === false),
      `The launch ledger already records an auditor session for kickoff ${worktreeId}; ` +
        "auditorConfigured: false contradicts that history and is refused",
    );
    let pinnedProfile = null;
    let pinnedFallbacks = null;
    if (auditorConfigured) {
      const org = readJSON(orgFile);
      assert(
        typeof profile === "string" &&
          profile.trim() &&
          Object.hasOwn(org.profiles, profile),
        "--profile must name a profile declared in organization.json when --auditor-configured is true",
      );
      const fallbackList = fallbacks ?? [];
      assert(
        Array.isArray(fallbackList) &&
          new Set(fallbackList).size === fallbackList.length &&
          fallbackList.every((id) => Object.hasOwn(org.profiles, id)),
        "--fallbacks must be unique profiles declared in organization.json",
      );
      pinnedProfile = profile;
      pinnedFallbacks = fallbackList;
    } else {
      assert(
        profile === undefined && fallbacks === undefined,
        "--profile/--fallbacks are only accepted when --auditor-configured is true",
      );
    }
    const auditPolicy = {
      auditorConfigured,
      profile: pinnedProfile,
      fallbacks: pinnedFallbacks,
      source: "retrofit",
      retrofittedFrom: hasAuditorLaunch
        ? "launch-ledger"
        : "director-attestation",
      reason: reason.trim(),
      retrofittedBy: { checkoutPath: path.resolve(callerCwd) },
      pinnedAt: new Date().toISOString(),
    };
    const updated = validateEntry({ ...entry, auditPolicy });
    writeJSON(file, updated);
    return { retrofitted: true, auditPolicy };
  });
}

/**
 * Moves every kickoff a director terminal supervises to a new terminal.
 *
 * A director session can be replaced, by a session of another provider or
 * after its terminal was lost, while its kickoffs run on. `director-signal`
 * notifies the terminal each entry's `director.terminalHandle` names, so until
 * the entries point at the new session its PM's signals reach a closed
 * terminal (#131). Only entries naming `from` change; `checkoutPath` is kept
 * unless a new one is given.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {object} move - The handover.
 * @param {string} move.from - Terminal handle the entries name now.
 * @param {string} move.to - Terminal handle of the new director session.
 * @param {string} [move.checkoutPath] - New owner checkout, when it changed.
 * @returns {{reassigned: string[], unchanged: string[]}} PM worktree ids moved
 *   and those that named another director.
 * @throws {Error} When either handle is empty or both are the same.
 */
export function reassignDirector(orgFile, { from, to, checkoutPath }) {
  assert(
    text(from),
    "reassignDirector needs the current director terminal handle",
  );
  assert(text(to), "reassignDirector needs the new director terminal handle");
  assert(
    from !== to,
    "The new director terminal is the same as the current one",
  );
  return withRegistry(orgFile, () => {
    const reassigned = [];
    const unchanged = [];
    for (const entry of listKickoffs(orgFile).kickoffs) {
      if (entry.director?.terminalHandle !== from) {
        unchanged.push(entry.pm.worktreeId);
        continue;
      }
      const file = locateEntry(orgFile, entry.pm.worktreeId);
      const moved = validateEntry({
        ...entry,
        director: {
          ...entry.director,
          terminalHandle: to,
          ...(text(checkoutPath) ? { checkoutPath } : {}),
        },
      });
      writeJSON(file, moved);
      reassigned.push(entry.pm.worktreeId);
    }
    return { from, to, reassigned, unchanged };
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
 *   the new head omits the previous merge, or the commits fail verification.
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
    const previous = entry.delivered;
    const nextStage = previous && previous.head !== verified.head;
    assert(
      !nextStage ||
        isAncestor(ownerProject(orgFile), previous.mergeCommit, verified.head),
      `New delivery head ${verified.head} does not contain previous merge ${previous?.mergeCommit}`,
    );
    const updated = validateEntry({
      ...entry,
      deliveryHistory: nextStage
        ? [...(entry.deliveryHistory ?? []), previous]
        : entry.deliveryHistory,
      delivered:
        !previous || nextStage
          ? {
              head: verified.head,
              mergeCommit: verified.mergeCommit,
              at: new Date().toISOString(),
            }
          : previous,
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
 * For `reason: "completed"`, also runs `assertKickoffCloseReady` (A.5/B.5)
 * unconditionally, before the registry lock is taken: the requirements
 * ledger must be close-ready and, when the organization declares an auditor,
 * both checkpoints must still carry a valid acceptance. `force` bypasses only
 * the director-authority and delivered-flag checks below, never this one.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {object} request - Release request.
 * @param {string} request.worktreeId - PM worktree whose kickoff ends.
 * @param {string} request.reason - One of `RELEASE_REASONS`.
 * @param {boolean} [request.force=false] - Whether a takeover is authorized.
 * @param {string} [request.callerCwd] - Caller's working directory for director check.
 * @param {string} [request.head] - Result HEAD to check the ledger against for
 *   `reason: "completed"`; falls back to a prior `deliver`'s recorded head.
 * @param {string} [request.repo] - Workspace `head` is checked against for the
 *   outcome acceptance binding.
 * @returns {Promise<{released: boolean, reason: string, archived: string, entry: object, closedSignals: string[]}>} Result.
 * @throws {Error} When the worktree holds no kickoff, the reason is unknown,
 *   a takeover is requested without authorization, or (for `completed`) the
 *   ledger/audit check fails.
 */
export async function releaseKickoff(
  orgFile,
  { worktreeId, reason, force = false, callerCwd = process.cwd(), head, repo },
) {
  if (reason === "completed") {
    const [entry] = listKickoffs(orgFile, worktreeId).kickoffs;
    assert(entry, `Worktree ${worktreeId} supervises no registered kickoff`);
    const effectiveHead = head ?? entry.delivered?.head;
    assert(
      effectiveHead,
      "kickoff-release --reason completed requires --head (or a prior deliver) " +
        "to check the requirements ledger before closing",
    );
    await assertKickoffCloseReady(orgFile, worktreeId, {
      head: effectiveHead,
      repo,
      entry,
    });
  }
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
    // A merge was recorded: the kickoff is not truly complete until its own
    // 06. 인도 delivery-ref document is committed too (docs/plan/
    // structured-omt-documents.md 3.7 item 5's releaseKickoff extension).
    // Entries registered before the structured document system was activated
    // (the same documentSystemActivatedAt-vs-createdAt boundary 3.10 uses for
    // legacyRef) are legacy and skip this check entirely, like the legacy
    // director warning above. An entry with no registrationSeq that was
    // registered after activation is instead an integrity-failure: normal
    // registration always assigns one, so its absence is a corrupted or
    // hand-edited entry, not a legacy one, and is not let through silently.
    if (
      reason === "completed" &&
      entry.delivery?.mode === "local-merge" &&
      entry.delivered?.mergeCommit
    ) {
      const org = validateOrg(readJSON(orgFile));
      const classification = classifyKickoffEntry(entry, org);
      assert(
        classification !== "integrity-failure" || force,
        `Kickoff was registered at ${entry.createdAt}, after documentSystemActivatedAt ` +
          `(${org.documentSystemActivatedAt}), but has no registrationSeq; normal registration ` +
          "always assigns one, so completion is refused as a corrupted entry unless the user " +
          "decides to force it",
      );
      if (classification === "current") {
        const kickoffHash = kickoffHashFor(entry);
        const docId = deliveryRefDocId(
          kickoffHash,
          entry.delivered.mergeCommit,
        );
        const state = documentState(entry.pm.stateDir, docId);
        assert(
          state.exists || force,
          `Kickoff delivered ${entry.delivered.mergeCommit} but its 06. 인도 delivery-ref document ` +
            "is not committed yet; write it before completing, or pass --force with the user's decision",
        );
        assert(
          !state.exists || state.kickoffId === kickoffHash || force,
          `delivery-ref document at ${docId} belongs to a different kickoff; ` +
            "pass --force with the user's decision if this is expected",
        );
      }
    }
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
 * @param {string} [request.orgFile] - Organization JSON path, used to read
 *   `documentSystemActivatedAt` for the legacy-vs-integrity-failure boundary
 *   (structured-omt-documents.md 3.7 item 5). Optional; when omitted, an
 *   entry with no `registrationSeq` is always treated as legacy. When given
 *   but unreadable, the call is refused before any branch is checked or
 *   deleted, and `force` does not bypass that refusal.
 * @returns {{deleted: string[], skipped: string[], errors: string[]}} Result.
 */
export function cleanupKickoffBranches({
  projectDir,
  entry,
  branches,
  remoteName = "origin",
  callerCwd = process.cwd(),
  force = false,
  orgFile,
}) {
  assert(
    typeof projectDir === "string" && projectDir,
    "projectDir required for branch cleanup",
  );
  assert(entry && typeof entry === "object", "registry entry required");
  assert(Array.isArray(branches), "branches must be an array");
  const org =
    orgFile === undefined ? undefined : validateOrg(readJSON(orgFile));

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
  // A merge/PR commit is confirmed only once its 06. 인도 delivery-ref document
  // is also committed and owned by this kickoff (structured-omt-documents.md
  // 3.7 item 5's cleanupKickoffBranches extension); otherwise deliveryRef stays
  // undefined and every branch is skipped below, same as "no delivered record".
  // force bypasses the document check, matching releaseKickoff's policy. A
  // legacy entry (registrationSeq absent because it predates activation, or
  // because no orgFile was given to learn the boundary at all) keeps the
  // pre-existing, document-check-free behavior. An integrity-failure entry
  // (registrationSeq absent despite activation) cannot compute a kickoffHash,
  // so it is treated as unowned: skipped without force, bypassed with it,
  // exactly like a "current" entry whose delivery-ref document is missing.
  let deliveryRef;
  if (
    (entry.delivery?.mode === "local-merge" ||
      entry.delivery?.mode === "pull-request") &&
    entry.delivered?.mergeCommit
  ) {
    const classification = classifyKickoffEntry(entry, org);
    if (classification === "legacy") {
      deliveryRef = entry.delivered.mergeCommit;
    } else {
      let owned = false;
      if (classification === "current") {
        const kickoffHash = kickoffHashFor(entry);
        const docId = deliveryRefDocId(
          kickoffHash,
          entry.delivered.mergeCommit,
        );
        const state = documentState(entry.pm.stateDir, docId);
        owned = state.exists && state.kickoffId === kickoffHash;
      }
      if (owned || force) deliveryRef = entry.delivered.mergeCommit;
    }
  }

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
