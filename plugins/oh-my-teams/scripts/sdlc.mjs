/** Immutable SDLC artifacts, lineage checks, transitions, and deployment authority. */
import fs from "node:fs";
import path from "node:path";
import { assert, hash, readJSON, withFileLock, writeJSON } from "./core.mjs";

/** Ordered SDLC artifact kinds from intent through learning. */
export const SDLC_KINDS = [
  "intent", "research", "design", "plan", "build", "verification",
  "review", "release", "deployment", "observation", "incident", "learning",
];
/** Allowed immutable artifact states. */
export const SDLC_STATES = [
  "draft", "ready", "active", "submitted", "accepted", "invalidated",
  "superseded", "archived",
];
const ID = /^[a-z0-9][a-z0-9-]*$/;
const SHA = /^[a-f0-9]{64}$/;
const NEXT = {
  draft: ["ready", "archived"], ready: ["active", "archived"],
  active: ["submitted", "blocked", "archived"],
  submitted: ["accepted", "invalidated", "archived"],
  accepted: ["superseded", "invalidated", "archived"],
  invalidated: ["ready", "archived"], superseded: ["archived"], archived: [],
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function validRef(reference, label) {
  assert(reference && ID.test(reference.id), `${label} id required`);
  assert(Number.isInteger(reference.revision) && reference.revision >= 1, `${label} revision required`);
  assert(typeof reference.sha256 === "string" && SHA.test(reference.sha256), `${label} sha256 required`);
}

/**
 * Validates one immutable lifecycle artifact.
 * @param {object} artifact - Candidate artifact.
 * @returns {object} The validated artifact.
 * @throws {Error} When required identity, state, lineage, or ownership is invalid.
 */
export function validateSdlcArtifact(artifact) {
  assert(artifact?.schemaVersion === 1, "Artifact schemaVersion=1 required");
  assert(ID.test(artifact.id), "Artifact id required");
  assert(Number.isInteger(artifact.revision) && artifact.revision >= 1, "Artifact revision required");
  assert(SDLC_KINDS.includes(artifact.kind), "Unsupported artifact kind");
  assert(SDLC_STATES.includes(artifact.state), "Unsupported artifact state");
  assert(typeof artifact.title === "string" && artifact.title.trim(), "Artifact title required");
  assert(artifact.content && typeof artifact.content === "object" && !Array.isArray(artifact.content), "Artifact content required");
  assert(Array.isArray(artifact.upstream), "Artifact upstream required");
  assert(Array.isArray(artifact.evidence), "Artifact evidence required");
  artifact.upstream.forEach((item) => validRef(item, "Upstream"));
  artifact.evidence.forEach((item) => validRef(item, "Evidence"));
  assert(["role", "human", "system"].includes(artifact.owner?.kind) && typeof artifact.owner.id === "string" && artifact.owner.id.trim(), "Artifact owner required");
  assert(Number.isFinite(Date.parse(artifact.createdAt)), "Artifact createdAt required");
  if (artifact.supersedes !== null) validRef(artifact.supersedes, "Supersedes");
  return artifact;
}

/**
 * Produces the canonical immutable artifact hash.
 * @param {object} artifact - Valid lifecycle artifact.
 * @returns {string} SHA-256 digest.
 */
export function sdlcArtifactHash(artifact) {
  return hash(canonical(validateSdlcArtifact(artifact)));
}

/**
 * Validates a scoped, expiring deployment authorization.
 * @param {object} authorization - Candidate authorization.
 * @param {object} expected - Required lifecycle, release, source, repository, environment, and action.
 * @param {number} [now=Date.now()] - Validation time.
 * @returns {object} The validated authorization.
 * @throws {Error} When authority or any scope field is absent, stale, or mismatched.
 */
export function validateDeploymentAuthorization(
  authorization,
  expected,
  now = Date.now(),
) {
  assert(
    authorization?.schemaVersion === 1 && ID.test(authorization.id),
    "Authorization identity required",
  );
  assert(
    ["human", "policy"].includes(authorization.authority?.kind) &&
      typeof authorization.authority.id === "string" &&
      authorization.authority.id.trim(),
    "External deployment authority required",
  );
  assert(
    Number.isFinite(Date.parse(authorization.issuedAt)) &&
      Number.isFinite(Date.parse(authorization.expiresAt)),
    "Authorization dates required",
  );
  assert(
    Date.parse(authorization.issuedAt) <= now &&
      now < Date.parse(authorization.expiresAt),
    "Deployment authorization expired or not active",
  );
  assert(
    Array.isArray(authorization.actions) &&
      authorization.actions.includes(expected.action),
    "Deployment action not authorized",
  );
  for (const key of ["lifecycleId", "releaseId", "releaseRevision", "sourceHash", "repository", "environment"]) {
    assert(authorization[key] === expected[key], `Deployment authorization ${key} mismatch`);
  }
  assert(SHA.test(authorization.sourceHash), "Authorization sourceHash required");
  return authorization;
}

/**
 * Resolves a lifecycle directory under coordinator state.
 * @param {string} stateDir - Project `.omt` directory.
 * @param {string} lifecycleId - Lifecycle identifier.
 * @returns {string} Exact lifecycle directory.
 */
export function sdlcDirectory(stateDir, lifecycleId) {
  assert(ID.test(lifecycleId), "Lifecycle id required");
  return path.join(stateDir, "sdlc", lifecycleId);
}

/**
 * Creates an empty lifecycle state.
 * @param {string} stateDir - Project `.omt` directory.
 * @param {object} request - Lifecycle id and goal.
 * @returns {object} Materialized lifecycle state.
 */
export function createSdlc(stateDir, request) {
  assert(
    request &&
      ID.test(request.id) &&
      typeof request.goal === "string" &&
      request.goal.trim(),
    "Lifecycle id and goal required",
  );
  const directory = sdlcDirectory(stateDir, request.id);
  return withFileLock(path.join(directory, ".lock"), () => {
    const file = path.join(directory, "state.json");
    assert(!fs.existsSync(file), "Lifecycle already exists");
    const now = new Date().toISOString();
    const state = {
      schemaVersion: 1,
      id: request.id,
      revision: 1,
      goal: request.goal,
      artifacts: {},
      eventIds: ["lifecycle-created"],
      createdAt: now,
      updatedAt: now,
    };
    writeJSON(
      path.join(directory, "events", "000001-lifecycle-created.json"),
      { id: "lifecycle-created", type: "lifecycle-created", recordedAt: now },
    );
    writeJSON(file, state);
    return state;
  });
}

/**
 * Reads the materialized lifecycle state.
 * @param {string} stateDir - Project `.omt` directory.
 * @param {string} lifecycleId - Lifecycle identifier.
 * @returns {object} Current state.
 */
export function readSdlc(stateDir, lifecycleId) {
  return readJSON(path.join(sdlcDirectory(stateDir, lifecycleId), "state.json"));
}

/**
 * Records a new immutable artifact revision after checking every upstream hash.
 * @param {string} stateDir - Project `.omt` directory.
 * @param {string} lifecycleId - Lifecycle identifier.
 * @param {number} expectedRevision - Current lifecycle revision.
 * @param {object} artifact - New artifact revision.
 * @param {string} eventId - Unique event identifier.
 * @returns {object} Stored artifact, hash, and next lifecycle state.
 */
export function recordSdlcArtifact(
  stateDir,
  lifecycleId,
  expectedRevision,
  artifact,
  eventId,
) {
  validateSdlcArtifact(artifact);
  assert(ID.test(eventId), "Event id required");
  const directory = sdlcDirectory(stateDir, lifecycleId);
  return withFileLock(path.join(directory, ".lock"), () => {
    const state = readSdlc(stateDir, lifecycleId);
    assert(state.revision === expectedRevision, "Stale lifecycle revision");
    assert(!state.eventIds.includes(eventId), "Duplicate lifecycle event");
    for (const reference of artifact.upstream) {
      const current = state.artifacts[reference.id];
      assert(
        current &&
          current.revision === reference.revision &&
          current.sha256 === reference.sha256,
        `Stale or missing upstream: ${reference.id}`,
      );
    }
    const previous = state.artifacts[artifact.id];
    assert(
      !previous || artifact.revision === previous.revision + 1,
      "Artifact revision must advance by one",
    );
    if (previous) {
      assert(
        artifact.supersedes?.id === artifact.id &&
          artifact.supersedes.revision === previous.revision &&
          artifact.supersedes.sha256 === previous.sha256,
        "Artifact supersedes must bind previous revision",
      );
    } else {
      assert(
        artifact.revision === 1 && artifact.supersedes === null,
        "First artifact revision must start at one",
      );
    }
    const digest = sdlcArtifactHash(artifact);
    const target = path.join(
      directory,
      "artifacts",
      artifact.kind,
      artifact.id,
      "revisions",
      `${artifact.revision}.json`,
    );
    assert(!fs.existsSync(target), "Artifact revision already exists");
    writeJSON(target, artifact);
    state.artifacts[artifact.id] = {
      id: artifact.id,
      kind: artifact.kind,
      revision: artifact.revision,
      state: artifact.state,
      sha256: digest,
    };
    state.revision += 1;
    state.updatedAt = new Date().toISOString();
    state.eventIds.push(eventId);
    const sequence = String(state.eventIds.length).padStart(6, "0");
    writeJSON(path.join(directory, "events", `${sequence}-${eventId}.json`), {
      id: eventId,
      type: "artifact-recorded",
      artifact: state.artifacts[artifact.id],
      recordedAt: state.updatedAt,
    });
    writeJSON(path.join(directory, "state.json"), state);
    return { artifact, sha256: digest, state };
  });
}
