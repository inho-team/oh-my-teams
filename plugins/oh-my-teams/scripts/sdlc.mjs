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
  active: ["submitted", "archived"],
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

function artifactFile(directory, artifact) {
  return path.join(
    directory,
    "artifacts",
    artifact.kind,
    artifact.id,
    "revisions",
    `${artifact.revision}.json`,
  );
}

function readCurrentArtifact(directory, reference) {
  return readJSON(artifactFile(directory, reference));
}

function referenceFor(artifact, sha256 = sdlcArtifactHash(artifact)) {
  return {
    id: artifact.id,
    kind: artifact.kind,
    revision: artifact.revision,
    state: artifact.state,
    sha256,
  };
}

function writeEvent(directory, state, eventId, type, details) {
  state.eventIds.push(eventId);
  const sequence = String(state.eventIds.length).padStart(6, "0");
  writeJSON(path.join(directory, "events", `${sequence}-${eventId}.json`), {
    id: eventId,
    type,
    ...details,
    recordedAt: state.updatedAt,
  });
}

function invalidateDownstream(directory, state, initialReference, now) {
  const queue = [initialReference];
  const invalidated = [];
  while (queue.length > 0) {
    const obsolete = queue.shift();
    for (const currentReference of Object.values(state.artifacts)) {
      if (currentReference.id === obsolete.id) continue;
      const current = readCurrentArtifact(directory, currentReference);
      const dependsOnObsolete = current.upstream.some(
        (item) =>
          item.id === obsolete.id &&
          item.revision === obsolete.revision &&
          item.sha256 === obsolete.sha256,
      );
      if (
        !dependsOnObsolete ||
        ["invalidated", "superseded", "archived"].includes(current.state)
      ) {
        continue;
      }
      const next = {
        ...current,
        revision: current.revision + 1,
        state: "invalidated",
        createdAt: now,
        supersedes: {
          id: current.id,
          revision: current.revision,
          sha256: currentReference.sha256,
        },
      };
      const digest = sdlcArtifactHash(next);
      writeJSON(artifactFile(directory, next), next);
      state.artifacts[next.id] = referenceFor(next, digest);
      invalidated.push(state.artifacts[next.id]);
      queue.push(currentReference);
    }
  }
  return invalidated;
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
  assert(artifact.state === "draft", "New artifact revisions must start draft");
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
    const target = artifactFile(directory, artifact);
    assert(!fs.existsSync(target), "Artifact revision already exists");
    writeJSON(target, artifact);
    state.artifacts[artifact.id] = referenceFor(artifact, digest);
    state.revision += 1;
    state.updatedAt = new Date().toISOString();
    const invalidated = previous
      ? invalidateDownstream(directory, state, previous, state.updatedAt)
      : [];
    writeEvent(directory, state, eventId, "artifact-recorded", {
      artifact: state.artifacts[artifact.id],
      invalidated,
    });
    writeJSON(path.join(directory, "state.json"), state);
    return { artifact, sha256: digest, invalidated, state };
  });
}

/**
 * Advances one artifact through an allowed transition as a new immutable revision.
 * @param {string} stateDir - Project `.omt` directory.
 * @param {string} lifecycleId - Lifecycle identifier.
 * @param {number} expectedRevision - Current lifecycle revision.
 * @param {object} input - Event, artifact, target state, evidence, and optional authorization.
 * @returns {object} Transitioned artifact, hash, and next lifecycle state.
 * @throws {Error} When the transition, lineage, evidence, or deployment authority is invalid.
 */
export function transitionSdlcArtifact(
  stateDir,
  lifecycleId,
  expectedRevision,
  input,
) {
  assert(ID.test(input?.eventId), "Transition event id required");
  assert(ID.test(input?.artifactId), "Transition artifact id required");
  const directory = sdlcDirectory(stateDir, lifecycleId);
  return withFileLock(path.join(directory, ".lock"), () => {
    const state = readSdlc(stateDir, lifecycleId);
    assert(state.revision === expectedRevision, "Stale lifecycle revision");
    assert(!state.eventIds.includes(input.eventId), "Duplicate lifecycle event");
    const currentReference = state.artifacts[input.artifactId];
    assert(currentReference, "Transition artifact not found");
    const current = readCurrentArtifact(directory, currentReference);
    assert(
      NEXT[current.state]?.includes(input.toState),
      `Invalid artifact transition: ${current.state}->${input.toState}`,
    );
    for (const upstream of current.upstream) {
      const latest = state.artifacts[upstream.id];
      assert(
        latest &&
          latest.revision === upstream.revision &&
          latest.sha256 === upstream.sha256 &&
          latest.state === "accepted",
        `Upstream not accepted or current: ${upstream.id}`,
      );
    }
    if (current.kind === "deployment" && input.toState === "accepted") {
      validateDeploymentAuthorization(
        input.authorization,
        {
          action: "deploy",
          lifecycleId,
          releaseId: current.content.releaseId,
          releaseRevision: current.content.releaseRevision,
          sourceHash: current.content.sourceHash,
          repository: current.content.repository,
          environment: current.content.environment,
        },
        input.now ?? Date.now(),
      );
    }
    const next = {
      ...current,
      revision: current.revision + 1,
      state: input.toState,
      evidence: input.evidence ?? current.evidence,
      createdAt: new Date(input.now ?? Date.now()).toISOString(),
      supersedes: {
        id: current.id,
        revision: current.revision,
        sha256: currentReference.sha256,
      },
    };
    const digest = sdlcArtifactHash(next);
    writeJSON(artifactFile(directory, next), next);
    state.artifacts[next.id] = referenceFor(next, digest);
    state.revision += 1;
    state.updatedAt = next.createdAt;
    writeEvent(directory, state, input.eventId, "artifact-transitioned", {
      from: currentReference,
      to: state.artifacts[next.id],
      authorizationId: input.authorization?.id ?? null,
    });
    writeJSON(path.join(directory, "state.json"), state);
    return { artifact: next, sha256: digest, state };
  });
}
