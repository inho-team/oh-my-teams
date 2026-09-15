/** Immutable SDLC artifacts, lineage checks, transitions, and deployment authority. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { assert, hash, readJSON, withFileLock, writeJSON } from "./core.mjs";

/** Ordered SDLC artifact kinds from intent through learning. */
export const SDLC_KINDS = [
  "intent", "research", "design", "plan", "build", "verification",
  "review", "release", "deployment", "observation", "incident", "learning",
];
/** Allowed immutable artifact states. */
export const SDLC_STATES = [
  "draft", "ready", "active", "submitted", "accepted", "invalidated",
  "blocked", "failed", "cancelled", "superseded", "archived",
];
const ID = /^[a-z0-9][a-z0-9-]*$/;
const SHA = /^[a-f0-9]{64}$/;
const PREVIOUS_KIND = Object.fromEntries(
  SDLC_KINDS.slice(1).map((kind, index) => [kind, SDLC_KINDS[index]]),
);
const NEXT = {
  draft: ["ready", "cancelled", "archived"],
  ready: ["active", "blocked", "cancelled", "archived"],
  active: ["submitted", "blocked", "failed", "cancelled", "archived"],
  submitted: [
    "accepted",
    "blocked",
    "failed",
    "cancelled",
    "invalidated",
    "archived",
  ],
  accepted: ["superseded", "invalidated", "archived"],
  invalidated: ["ready", "cancelled", "archived"],
  blocked: ["ready", "active", "cancelled", "archived"],
  failed: ["ready", "cancelled", "archived"],
  cancelled: ["archived"],
  superseded: ["archived"],
  archived: [],
};
const LOCK_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function withRetriedLock(lockFile, callback, busyMessage) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return withFileLock(lockFile, callback, busyMessage);
    } catch (error) {
      if (error.message !== busyMessage) throw error;
      Atomics.wait(LOCK_WAIT_ARRAY, 0, 0, 10);
    }
  }
  throw new Error(busyMessage);
}

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

function queueEvent(state, eventId, type, details) {
  state.eventIds.push(eventId);
  const sequence = String(state.eventIds.length).padStart(6, "0");
  return {
    name: `${sequence}-${eventId}.json`,
    value: {
      id: eventId,
      type,
      ...details,
      recordedAt: state.updatedAt,
    },
  };
}

function recoverSdlcTransaction(directory) {
  return withRetriedLock(
    path.join(directory, ".recovery.lock"),
    () => {
      const file = path.join(directory, "transaction.json");
      if (!fs.existsSync(file)) return;
      const transaction = readJSON(file);
      for (const record of transaction.records ?? []) {
        if (fs.existsSync(record.file)) {
          assert(
            JSON.stringify(readJSON(record.file)) ===
              JSON.stringify(record.value),
            "Conflicting SDLC record during recovery",
          );
        } else {
          writeJSON(record.file, record.value);
        }
      }
      const eventFile = path.join(
        directory,
        "events",
        transaction.event.name,
      );
      if (fs.existsSync(eventFile)) {
        assert(
          JSON.stringify(readJSON(eventFile)) ===
            JSON.stringify(transaction.event.value),
          "Conflicting SDLC event during recovery",
        );
      } else {
        writeJSON(eventFile, transaction.event.value);
      }
      writeJSON(path.join(directory, "state.json"), transaction.state);
      fs.unlinkSync(file);
    },
    "SDLC transaction recovery in progress",
  );
}

function commitSdlcUpdate(directory, state, event, records = []) {
  writeJSON(path.join(directory, "transaction.json"), {
    state,
    event,
    records,
  });
  recoverSdlcTransaction(directory);
}

function invalidateDownstream(
  directory,
  state,
  initialReference,
  now,
  records,
) {
  const queue = [initialReference];
  const invalidated = [];
  const pendingArtifacts = new Map(
    records
      .filter(
        (record) =>
          record.value &&
          typeof record.value.id === "string" &&
          SDLC_KINDS.includes(record.value.kind),
      )
      .map((record) => [record.value.id, record.value]),
  );
  while (queue.length > 0) {
    const obsolete = queue.shift();
    for (const currentReference of Object.values(state.artifacts)) {
      if (currentReference.id === obsolete.id) continue;
      if (
        ["invalidated", "superseded", "archived"].includes(
          currentReference.state,
        )
      ) {
        continue;
      }
      const current =
        pendingArtifacts.get(currentReference.id) ??
        readCurrentArtifact(directory, currentReference);
      const dependsOnObsolete = current.upstream.some(
        (item) =>
          item.id === obsolete.id &&
          item.revision === obsolete.revision &&
          item.sha256 === obsolete.sha256,
      );
      if (!dependsOnObsolete) continue;
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
      records.push({ file: artifactFile(directory, next), value: next });
      pendingArtifacts.set(next.id, next);
      state.artifacts[next.id] = referenceFor(next, digest);
      invalidated.push(state.artifacts[next.id]);
      queue.push(currentReference);
    }
  }
  return invalidated;
}

function validateExecutionContent(artifact) {
  const { content, kind } = artifact;
  if (kind === "plan") {
    assert(
      typeof content.executionPlanId === "string" &&
        content.executionPlanId.trim() &&
        SHA.test(content.contractHash),
      "Plan executionPlanId and contractHash required",
    );
  }
  if (kind === "build") {
    assert(
      content.taskReport?.status === "submitted" &&
        typeof content.taskReport.taskId === "string" &&
        typeof content.taskReport.runId === "string" &&
        SHA.test(content.sourceHash),
      "Build submitted task report and sourceHash required",
    );
  }
  if (kind === "verification") {
    assert(
      content.evidence?.status === "passed" &&
        typeof content.evidence.key === "string" &&
        SHA.test(content.sourceHash),
      "Verification passed evidence and sourceHash required",
    );
  }
  if (kind === "review") {
    assert(
      content.review?.conclusion === "approved" &&
        typeof content.review.id === "string" &&
        typeof content.review.implementationExecutionId === "string" &&
        SHA.test(content.sourceHash),
      "Approved independent review and sourceHash required",
    );
  }
  if (kind === "release") {
    assert(
      content.acceptance?.state === "accepted" &&
        content.acceptance.sourceHash === content.sourceHash,
      "Release acceptance must bind sourceHash",
    );
  }
  if (kind === "observation") {
    assert(
      Number.isInteger(content.windowMinutes) &&
        content.windowMinutes >= 1 &&
        Array.isArray(content.metrics) &&
        content.metrics.length > 0 &&
        SHA.test(content.sourceHash),
      "Observation window, metrics, and sourceHash required",
    );
  }
  if (kind === "incident") {
    assert(
      typeof content.incidentId === "string" &&
        content.incidentId.trim() &&
        typeof content.evidence === "string" &&
        content.evidence.trim(),
      "Incident identity and evidence required",
    );
  }
  if (kind === "learning") {
    assert(
      content.verification?.status === "passed" &&
        typeof content.target === "string" &&
        content.target.trim(),
      "Learning requires verified evidence and a target",
    );
  }
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
 * Creates the canonical bytes an external authority signs.
 * @param {object} authorization - Authorization with an optional signature.
 * @returns {string} Canonical JSON payload excluding only the signature.
 */
export function deploymentAuthorizationPayload(authorization) {
  const value = structuredClone(authorization);
  if (value.authority) delete value.authority.signature;
  return JSON.stringify(canonical(value));
}

/**
 * Creates the canonical bytes a deployment provider signs for its receipt.
 * @param {object} receipt - Receipt with an optional issuer signature.
 * @returns {string} Canonical JSON payload excluding only the signature.
 */
export function deploymentReceiptPayload(receipt) {
  const value = structuredClone(receipt);
  if (value.issuer) delete value.issuer.signature;
  return JSON.stringify(canonical(value));
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
      authorization.authority.id.trim() &&
      typeof authorization.authority.signature === "string" &&
      authorization.authority.signature.trim(),
    "External deployment authority required",
  );
  const trusted = expected.trustedAuthorities?.[authorization.authority.id];
  assert(
    trusted && trusted.kind === authorization.authority.kind,
    "Deployment authority is not trusted",
  );
  let signatureValid = false;
  try {
    signatureValid = crypto.verify(
      null,
      Buffer.from(deploymentAuthorizationPayload(authorization)),
      trusted.publicKey,
      Buffer.from(authorization.authority.signature, "base64"),
    );
  } catch {
    signatureValid = false;
  }
  assert(signatureValid, "Deployment authority signature invalid");
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

function validateDeploymentReceipt(
  receipt,
  authorization,
  deploymentId,
  trustedAuthorities,
  now,
) {
  assert(receipt?.schemaVersion === 1 && ID.test(receipt.id), "Deployment receipt identity required");
  assert(receipt.authorizationId === authorization.id, "Deployment receipt authorization mismatch");
  assert(
    receipt.deploymentId === deploymentId,
    "Deployment receipt deployment mismatch",
  );
  for (const key of ["lifecycleId", "releaseId", "sourceHash", "repository", "environment"]) {
    assert(receipt[key] === authorization[key], `Deployment receipt ${key} mismatch`);
  }
  assert(receipt.action === "deploy", "Deployment receipt must prove deployment");
  assert(authorization.actions.includes(receipt.action), "Deployment receipt action not authorized");
  assert(receipt.status === "succeeded", "Deployment receipt must prove success");
  const issuer = trustedAuthorities?.[receipt.issuer?.id];
  assert(
    issuer?.kind === "deployment-provider" &&
      typeof receipt.issuer.signature === "string",
    "Deployment receipt issuer is not trusted",
  );
  let receiptSignatureValid = false;
  try {
    receiptSignatureValid = crypto.verify(
      null,
      Buffer.from(deploymentReceiptPayload(receipt)),
      issuer.publicKey,
      Buffer.from(receipt.issuer.signature, "base64"),
    );
  } catch {
    receiptSignatureValid = false;
  }
  assert(receiptSignatureValid, "Deployment receipt signature invalid");
  const executedAt = Date.parse(receipt.executedAt);
  assert(Number.isFinite(executedAt), "Deployment receipt executedAt required");
  assert(
    Date.parse(authorization.issuedAt) <= executedAt &&
      executedAt < Date.parse(authorization.expiresAt) &&
      executedAt <= now,
    "Deployment receipt execution time outside authorization window",
  );
  assert(typeof receipt.externalId === "string" && receipt.externalId.trim(), "Deployment receipt externalId required");
  return receipt;
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
      request.schemaVersion === 1 &&
      ID.test(request.id) &&
      typeof request.goal === "string" &&
      request.goal.trim(),
    "Lifecycle schemaVersion=1, id, and goal required",
  );
  assert(
    request.trustedAuthorities === undefined ||
      (Array.isArray(request.trustedAuthorities) &&
        new Set(request.trustedAuthorities.map((item) => item.id)).size ===
          request.trustedAuthorities.length &&
        request.trustedAuthorities.every((item) => {
          if (
            !ID.test(item?.id) ||
            !["human", "policy", "deployment-provider"].includes(item.kind) ||
            typeof item.publicKey !== "string"
          ) {
            return false;
          }
          try {
            crypto.createPublicKey(item.publicKey);
            return true;
          } catch {
            return false;
          }
        })),
    "Trusted authorities must have unique IDs, kinds, and public keys",
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
      trustedAuthorities: Object.fromEntries(
        (request.trustedAuthorities ?? []).map((item) => [item.id, item]),
      ),
      artifacts: {},
      authorizations: {},
      receipts: {},
      eventIds: ["lifecycle-created"],
      createdAt: now,
      updatedAt: now,
    };
    commitSdlcUpdate(
      directory,
      state,
      {
        name: "000001-lifecycle-created.json",
        value: {
          id: "lifecycle-created",
          type: "lifecycle-created",
          recordedAt: now,
        },
      },
    );
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
  const directory = sdlcDirectory(stateDir, lifecycleId);
  recoverSdlcTransaction(directory);
  return readJSON(path.join(directory, "state.json"));
}

/**
 * Checks that an accepted release is current and has rollback and observation plans.
 * @param {string} stateDir - Project `.omt` directory.
 * @param {string} lifecycleId - Lifecycle identifier.
 * @param {string} releaseId - Release artifact identifier.
 * @returns {object} Current release reference and immutable artifact.
 * @throws {Error} When the release is stale, unaccepted, or incomplete.
 */
export function checkRelease(stateDir, lifecycleId, releaseId) {
  const state = readSdlc(stateDir, lifecycleId);
  const reference = state.artifacts[releaseId];
  assert(reference?.kind === "release", "Release artifact not found");
  assert(reference.state === "accepted", "Release artifact not accepted");
  const artifact = readCurrentArtifact(
    sdlcDirectory(stateDir, lifecycleId),
    reference,
  );
  assert(SHA.test(artifact.content.sourceHash), "Release sourceHash required");
  assert(
    typeof artifact.content.repository === "string" &&
      artifact.content.repository.trim(),
    "Release repository required",
  );
  assert(artifact.content.rollbackPlan, "Release rollback plan required");
  assert(artifact.content.observationPlan, "Release observation plan required");
  return { ready: true, reference, artifact, executesDeployment: false };
}

/**
 * Records explicit deployment authority without executing an external action.
 * @param {string} stateDir - Project `.omt` directory.
 * @param {string} lifecycleId - Lifecycle identifier.
 * @param {number} expectedRevision - Current lifecycle revision.
 * @param {object} authorization - Scoped external authorization.
 * @returns {object} Recorded authorization and next lifecycle state.
 * @throws {Error} When the release, scope, time, or authority is invalid.
 */
export function recordDeploymentAuthorization(
  stateDir,
  lifecycleId,
  expectedRevision,
  authorization,
) {
  const directory = sdlcDirectory(stateDir, lifecycleId);
  return withFileLock(path.join(directory, ".lock"), () => {
    const state = readSdlc(stateDir, lifecycleId);
    assert(state.revision === expectedRevision, "Stale lifecycle revision");
    const eventId = `authorization-${authorization.id}`;
    assert(
      !state.eventIds.includes(eventId) &&
        !state.authorizations?.[authorization.id],
      "Deployment authorization already recorded",
    );
    const release = checkRelease(stateDir, lifecycleId, authorization.releaseId);
    validateDeploymentAuthorization(authorization, {
      action: "deploy",
      lifecycleId,
      releaseId: release.reference.id,
      releaseRevision: release.reference.revision,
      sourceHash: release.artifact.content.sourceHash,
      repository: release.artifact.content.repository,
      environment: authorization.environment,
      trustedAuthorities: state.trustedAuthorities,
    });
    const target = path.join(
      directory,
      "authorizations",
      `${authorization.id}.json`,
    );
    if (fs.existsSync(target)) {
      assert(
        JSON.stringify(readJSON(target)) === JSON.stringify(authorization),
        "Conflicting deployment authorization",
      );
    }
    state.authorizations ??= {};
    state.authorizations[authorization.id] = {
      id: authorization.id,
      releaseId: authorization.releaseId,
      environment: authorization.environment,
      expiresAt: authorization.expiresAt,
    };
    state.revision += 1;
    state.updatedAt = new Date().toISOString();
    const event = queueEvent(
      state,
      eventId,
      "deployment-authorized",
      {
        authorizationId: authorization.id,
        releaseId: authorization.releaseId,
        executesDeployment: false,
      },
    );
    commitSdlcUpdate(directory, state, event, [
      { file: target, value: authorization },
    ]);
    return { authorization, state, executesDeployment: false };
  });
}

/**
 * Checks a submitted deployment against a stored, currently valid authorization.
 * @param {string} stateDir - Project `.omt` directory.
 * @param {string} lifecycleId - Lifecycle identifier.
 * @param {string} deploymentId - Deployment artifact identifier.
 * @param {string} authorizationId - Stored authorization identifier.
 * @param {number} [now=Date.now()] - Validation clock.
 * @returns {object} Readiness result that never executes deployment.
 */
export function checkDeployment(
  stateDir,
  lifecycleId,
  deploymentId,
  authorizationId,
  now = Date.now(),
) {
  const directory = sdlcDirectory(stateDir, lifecycleId);
  const state = readSdlc(stateDir, lifecycleId);
  assert(ID.test(authorizationId), "Authorization id required");
  assert(
    state.authorizations?.[authorizationId],
    "Deployment authorization not recorded",
  );
  const reference = state.artifacts[deploymentId];
  assert(reference?.kind === "deployment", "Deployment artifact not found");
  assert(reference.state === "submitted", "Deployment artifact not submitted");
  const deployment = readCurrentArtifact(directory, reference);
  const authorization = readJSON(
    path.join(directory, "authorizations", `${authorizationId}.json`),
  );
  validateDeploymentAuthorization(
    authorization,
    {
      action: "deploy",
      lifecycleId,
      releaseId: deployment.content.releaseId,
      releaseRevision: deployment.content.releaseRevision,
      sourceHash: deployment.content.sourceHash,
      repository: deployment.content.repository,
      environment: deployment.content.environment,
      trustedAuthorities: state.trustedAuthorities,
    },
    now,
  );
  return {
    ready: true,
    deployment: reference,
    authorizationId,
    executesDeployment: false,
  };
}

/**
 * Records a successful external receipt and accepts the submitted deployment.
 * @param {string} stateDir - Project `.omt` directory.
 * @param {string} lifecycleId - Lifecycle identifier.
 * @param {number} expectedRevision - Current lifecycle revision.
 * @param {object} input - Deployment, authorization, receipt, event, and clock.
 * @returns {object} Accepted deployment transition.
 */
export function recordDeployment(
  stateDir,
  lifecycleId,
  expectedRevision,
  input,
) {
  checkDeployment(
    stateDir,
    lifecycleId,
    input.deploymentId,
    input.authorizationId,
    input.now,
  );
  const directory = sdlcDirectory(stateDir, lifecycleId);
  const authorization = readJSON(
    path.join(
      directory,
      "authorizations",
      `${input.authorizationId}.json`,
    ),
  );
  return transitionSdlcArtifact(
    stateDir,
    lifecycleId,
    expectedRevision,
    {
      eventId: input.eventId,
      artifactId: input.deploymentId,
      toState: "accepted",
      authorization,
      receipt: input.receipt,
      now: input.now,
    },
  );
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
      !previous || previous.kind === artifact.kind,
      "Artifact kind cannot change across revisions",
    );
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
    if (fs.existsSync(target)) {
      assert(
        JSON.stringify(readJSON(target)) === JSON.stringify(artifact),
        "Conflicting artifact revision",
      );
    }
    state.artifacts[artifact.id] = referenceFor(artifact, digest);
    state.revision += 1;
    state.updatedAt = new Date().toISOString();
    const records = [{ file: target, value: artifact }];
    const invalidated = previous
      ? invalidateDownstream(
          directory,
          state,
          previous,
          state.updatedAt,
          records,
        )
      : [];
    const event = queueEvent(state, eventId, "artifact-recorded", {
      artifact: state.artifacts[artifact.id],
      invalidated,
    });
    commitSdlcUpdate(directory, state, event, records);
    return { artifact, sha256: digest, invalidated, state };
  });
}

/**
 * Converts one incident into a deduplicated draft intent artifact.
 * @param {string} stateDir - Project `.omt` directory.
 * @param {string} lifecycleId - Lifecycle identifier.
 * @param {number} expectedRevision - Current lifecycle revision.
 * @param {object} incident - Persisted incident with evidence and fingerprint.
 * @param {string} eventId - Unique lifecycle event identifier.
 * @returns {object} Existing intent or newly recorded artifact result.
 */
export function incidentToIntent(
  stateDir,
  lifecycleId,
  expectedRevision,
  incident,
  eventId,
) {
  assert(
    incident &&
      typeof incident.fingerprint === "string" &&
      SHA.test(incident.fingerprint) &&
      typeof incident.summary === "string" &&
      incident.summary.trim() &&
      typeof incident.evidence === "string" &&
      incident.evidence.trim(),
    "Incident fingerprint, summary, and evidence required",
  );
  const artifactId = `intent-${incident.fingerprint}`;
  const directory = sdlcDirectory(stateDir, lifecycleId);
  return withRetriedLock(
    path.join(directory, `.incident-${artifactId}.lock`),
    () => {
      const state = readSdlc(stateDir, lifecycleId);
      if (state.artifacts[artifactId]) {
        return {
          duplicate: true,
          artifact: state.artifacts[artifactId],
          state,
        };
      }
      const result = recordSdlcArtifact(
        stateDir,
        lifecycleId,
        expectedRevision,
        {
          schemaVersion: 1,
          id: artifactId,
          revision: 1,
          kind: "intent",
          state: "draft",
          title: `Incident follow-up: ${incident.summary}`,
          content: {
            sourceIncidentId: incident.id,
            sourceIncidentFingerprint: incident.fingerprint,
            goal: `Resolve and prevent recurrence: ${incident.summary}`,
            evidence: incident.evidence,
          },
          upstream: [],
          evidence: [],
          owner: { kind: "role", id: "pm" },
          createdAt: new Date().toISOString(),
          supersedes: null,
        },
        eventId,
      );
      return { duplicate: false, ...result };
    },
    "Incident intent creation in progress",
  );
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
    if (input.toState === "ready" && PREVIOUS_KIND[current.kind]) {
      assert(
        current.upstream.some(
          (reference) =>
            state.artifacts[reference.id]?.kind === PREVIOUS_KIND[current.kind],
        ),
        `${current.kind} requires ${PREVIOUS_KIND[current.kind]} upstream`,
      );
      const previousKindReference = current.upstream.find(
        (reference) =>
          state.artifacts[reference.id]?.kind === PREVIOUS_KIND[current.kind],
      );
      const previousArtifact = readCurrentArtifact(
        directory,
        state.artifacts[previousKindReference.id],
      );
      if (current.kind === "deployment") {
        assert(
          previousKindReference.id === current.content.releaseId &&
            previousKindReference.revision ===
              current.content.releaseRevision,
          "Deployment release content differs from upstream",
        );
      }
      if (current.content.sourceHash && previousArtifact.content.sourceHash) {
        assert(
          current.content.sourceHash === previousArtifact.content.sourceHash,
          `${current.kind} sourceHash differs from upstream`,
        );
      }
    }
    if (input.toState === "ready") validateExecutionContent(current);
    if (current.kind === "release" && input.toState === "ready") {
      assert(SHA.test(current.content.sourceHash), "Release sourceHash required");
      assert(typeof current.content.repository === "string" && current.content.repository.trim(), "Release repository required");
      assert(current.content.rollbackPlan, "Release rollback plan required");
      assert(current.content.observationPlan, "Release observation plan required");
    }
    if (
      ["verification", "review", "release"].includes(current.kind) &&
      input.toState === "submitted"
    ) {
      const evidence = input.evidence ?? current.evidence;
      assert(evidence.length > 0, `${current.kind} evidence required before submission`);
      for (const reference of evidence) {
        const latest = state.artifacts[reference.id];
        assert(
          latest &&
            latest.revision === reference.revision &&
            latest.sha256 === reference.sha256 &&
            latest.state === "accepted",
          `Stale or unaccepted evidence: ${reference.id}`,
        );
      }
    }
    if (current.kind === "deployment" && input.toState === "accepted") {
      const authorization = validateDeploymentAuthorization(
        input.authorization,
        {
          action: "deploy",
          lifecycleId,
          releaseId: current.content.releaseId,
          releaseRevision: current.content.releaseRevision,
          sourceHash: current.content.sourceHash,
          repository: current.content.repository,
          environment: current.content.environment,
          trustedAuthorities: state.trustedAuthorities,
        },
        input.now ?? Date.now(),
      );
      const receipt = validateDeploymentReceipt(
        input.receipt,
        authorization,
        current.id,
        state.trustedAuthorities,
        input.now ?? Date.now(),
      );
      const authorizationFile = path.join(
        directory,
        "authorizations",
        `${authorization.id}.json`,
      );
      const receiptFile = path.join(directory, "receipts", `${receipt.id}.json`);
      assert(
        !state.receipts?.[receipt.id],
        "Deployment receipt already consumed",
      );
      assert(
        state.authorizations?.[authorization.id] &&
          fs.existsSync(authorizationFile),
        "Deployment authorization must be recorded first",
      );
      assert(
        JSON.stringify(readJSON(authorizationFile)) ===
          JSON.stringify(authorization),
        "Conflicting deployment authorization",
      );
      if (fs.existsSync(receiptFile)) {
        assert(
          JSON.stringify(readJSON(receiptFile)) === JSON.stringify(receipt),
          "Conflicting deployment receipt",
        );
      }
      state.receipts ??= {};
      state.receipts[receipt.id] = {
        id: receipt.id,
        deploymentId: current.id,
        authorizationId: authorization.id,
        externalId: receipt.externalId,
        executedAt: receipt.executedAt,
      };
    }
    if (input.toState !== "submitted" && input.evidence !== undefined) {
      assert(
        JSON.stringify(input.evidence) === JSON.stringify(current.evidence),
        "Evidence can change only during submission",
      );
    }
    const next = {
      ...current,
      revision: current.revision + 1,
      state: input.toState,
      evidence:
        input.toState === "submitted"
          ? input.evidence ?? current.evidence
          : current.evidence,
      createdAt: new Date(input.now ?? Date.now()).toISOString(),
      supersedes: {
        id: current.id,
        revision: current.revision,
        sha256: currentReference.sha256,
      },
    };
    const digest = sdlcArtifactHash(next);
    const nextFile = artifactFile(directory, next);
    if (fs.existsSync(nextFile)) {
      assert(
        JSON.stringify(readJSON(nextFile)) === JSON.stringify(next),
        "Conflicting artifact transition revision",
      );
    }
    state.artifacts[next.id] = referenceFor(next, digest);
    const records = [{ file: nextFile, value: next }];
    if (input.receipt) {
      records.push({
        file: path.join(directory, "receipts", `${input.receipt.id}.json`),
        value: input.receipt,
      });
    }
    const invalidated =
      currentReference.state === "accepted" &&
      ["invalidated", "superseded", "archived"].includes(input.toState)
        ? invalidateDownstream(
            directory,
            state,
            currentReference,
            next.createdAt,
            records,
          )
        : [];
    state.revision += 1;
    state.updatedAt = next.createdAt;
    const event = queueEvent(state, input.eventId, "artifact-transitioned", {
      from: currentReference,
      to: state.artifacts[next.id],
      authorizationId: input.authorization?.id ?? null,
      receiptId: input.receipt?.id ?? null,
      invalidated,
    });
    commitSdlcUpdate(directory, state, event, records);
    return { artifact: next, sha256: digest, state };
  });
}
