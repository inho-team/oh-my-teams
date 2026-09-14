/** Tests for immutable SDLC artifacts and deployment authorization boundaries. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { organizationStatus } from "../plugins/oh-my-teams/scripts/status.mjs";
import {
  checkDeployment,
  createSdlc,
  deploymentAuthorizationPayload,
  incidentToIntent,
  readSdlc,
  recordDeployment,
  recordDeploymentAuthorization,
  recordSdlcArtifact,
  sdlcArtifactHash,
  transitionSdlcArtifact,
  validateDeploymentAuthorization,
} from "../plugins/oh-my-teams/scripts/sdlc.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omt-sdlc-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function artifact(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "intent-a",
    revision: 1,
    kind: "intent",
    state: "draft",
    title: "Intent",
    content: { goal: "Ship safely" },
    upstream: [],
    evidence: [],
    owner: { kind: "role", id: "pm" },
    createdAt: "2026-09-15T00:00:00.000Z",
    supersedes: null,
    ...overrides,
  };
}

function authorityFixture(id = "user-1", kind = "human") {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    trusted: {
      id,
      kind,
      publicKey: publicKey.export({ type: "spki", format: "pem" }),
    },
    sign(authorization) {
      const value = {
        ...authorization,
        authority: { kind, id, signature: "" },
      };
      value.authority.signature = crypto
        .sign(
          null,
          Buffer.from(deploymentAuthorizationPayload(value)),
          privateKey,
        )
        .toString("base64");
      return value;
    },
  };
}

function cli(args) {
  return spawnSync(
    process.execPath,
    ["plugins/oh-my-teams/scripts/teams-org.mjs", ...args],
    { cwd: path.resolve("."), encoding: "utf8" },
  );
}

function cliAsync(args) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["plugins/oh-my-teams/scripts/teams-org.mjs", ...args],
      { cwd: path.resolve(".") },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("SDLC artifacts persist immutable revisions and reject stale lifecycle updates", (t) => {
  const stateDir = fixture(t);
  createSdlc(stateDir, {
    schemaVersion: 1,
    id: "release-a",
    goal: "Ship safely",
  });
  const first = recordSdlcArtifact(stateDir, "release-a", 1, artifact(), "record-intent-1");
  assert.equal(first.state.revision, 2);
  assert.equal(readSdlc(stateDir, "release-a").artifacts["intent-a"].sha256, first.sha256);
  assert.throws(
    () =>
      recordSdlcArtifact(
        stateDir,
        "release-a",
        1,
        artifact({ id: "other" }),
        "stale",
      ),
    /Stale lifecycle/,
  );
  assert.throws(
    () =>
      recordSdlcArtifact(
        stateDir,
        "release-a",
        2,
        artifact(),
        "duplicate-revision",
      ),
    /advance by one/,
  );
});

test("artifact lineage requires the current upstream revision and hash", (t) => {
  const stateDir = fixture(t);
  createSdlc(stateDir, {
    schemaVersion: 1,
    id: "release-a",
    goal: "Ship safely",
  });
  const intent = recordSdlcArtifact(
    stateDir,
    "release-a",
    1,
    artifact(),
    "intent",
  );
  const research = artifact({
    id: "research-a",
    kind: "research",
    title: "Research",
    upstream: [
      { id: "intent-a", revision: 1, sha256: intent.sha256 },
    ],
  });
  recordSdlcArtifact(stateDir, "release-a", 2, research, "research");
  assert.throws(
    () =>
      recordSdlcArtifact(
        stateDir,
        "release-a",
        3,
        artifact({
          id: "design-a",
          kind: "design",
          upstream: [
            { id: "intent-a", revision: 1, sha256: "0".repeat(64) },
          ],
        }),
        "design",
      ),
    /Stale or missing upstream/,
  );
});

test("deployment authorization is explicit, scoped, and expiring", () => {
  const authority = authorityFixture();
  const expected = {
    action: "deploy",
    lifecycleId: "release-a",
    releaseId: "release-artifact",
    releaseRevision: 2,
    sourceHash: "a".repeat(64),
    repository: "inho-team/app",
    environment: "production",
  };
  const { action: _action, ...authorizationScope } = expected;
  const authorization = authority.sign({
    schemaVersion: 1,
    id: "deploy-auth",
    ...authorizationScope,
    actions: ["deploy"],
    issuedAt: "2026-09-15T00:00:00.000Z",
    expiresAt: "2026-09-16T00:00:00.000Z",
  });
  assert.equal(
    validateDeploymentAuthorization(
      authorization,
      {
        ...expected,
        trustedAuthorities: { [authority.trusted.id]: authority.trusted },
      },
      Date.parse("2026-09-15T12:00:00.000Z"),
    ),
    authorization,
  );
  assert.throws(
    () =>
      validateDeploymentAuthorization(
        authority.sign({
          ...authorizationScope,
          schemaVersion: 1,
          id: "deploy-auth-staging",
          environment: "staging",
          actions: ["deploy"],
          issuedAt: "2026-09-15T00:00:00.000Z",
          expiresAt: "2026-09-16T00:00:00.000Z",
        }),
        {
          ...expected,
          trustedAuthorities: { [authority.trusted.id]: authority.trusted },
        },
        Date.parse("2026-09-15T12:00:00.000Z"),
      ),
    /environment mismatch/,
  );
  assert.throws(
    () =>
      validateDeploymentAuthorization(
        authorization,
        {
          ...expected,
          trustedAuthorities: { [authority.trusted.id]: authority.trusted },
        },
        Date.parse("2026-09-17T00:00:00.000Z"),
      ),
    /expired/,
  );
  assert.throws(
    () =>
      validateDeploymentAuthorization(
        {
          ...authorization,
          authority: { kind: "role", id: "pm", signature: "invalid" },
        },
        {
          ...expected,
          trustedAuthorities: { [authority.trusted.id]: authority.trusted },
        },
        Date.parse("2026-09-15T12:00:00.000Z"),
      ),
    /External deployment authority/,
  );
  assert.throws(
    () =>
      validateDeploymentAuthorization(
        {
          ...authorization,
          authority: {
            kind: "policy",
            id: "untrusted-policy",
            signature: authorization.authority.signature,
          },
        },
        { ...expected, trustedAuthorities: {} },
        Date.parse("2026-09-15T12:00:00.000Z"),
      ),
    /not trusted/,
  );
});

test("artifact hashes are canonical across object key order", () => {
  const value = artifact();
  const reordered = { ...value, content: { goal: "Ship safely" } };
  assert.equal(sdlcArtifactHash(value), sdlcArtifactHash(reordered));
});

function acceptArtifact(stateDir, lifecycleId, artifactId, revision) {
  let lifecycleRevision = revision;
  for (const state of ["ready", "active", "submitted", "accepted"]) {
    const result = transitionSdlcArtifact(
      stateDir,
      lifecycleId,
      lifecycleRevision,
      {
        eventId: `${artifactId}-${state}`,
        artifactId,
        toState: state,
        now: Date.parse("2026-09-15T12:00:00.000Z") + lifecycleRevision,
      },
    );
    lifecycleRevision = result.state.revision;
  }
  return lifecycleRevision;
}

test("artifact transitions cannot skip states and preserve immutable revisions", (t) => {
  const stateDir = fixture(t);
  createSdlc(stateDir, {
    schemaVersion: 1,
    id: "release-a",
    goal: "Ship safely",
  });
  recordSdlcArtifact(stateDir, "release-a", 1, artifact(), "intent");
  assert.throws(
    () =>
      transitionSdlcArtifact(stateDir, "release-a", 2, {
        eventId: "skip",
        artifactId: "intent-a",
        toState: "accepted",
      }),
    /Invalid artifact transition/,
  );
  const finalRevision = acceptArtifact(
    stateDir,
    "release-a",
    "intent-a",
    2,
  );
  const current = readSdlc(stateDir, "release-a");
  assert.equal(current.revision, finalRevision);
  assert.equal(current.artifacts["intent-a"].state, "accepted");
  assert.equal(current.artifacts["intent-a"].revision, 5);
});

test("a new upstream revision recursively invalidates downstream artifacts", (t) => {
  const stateDir = fixture(t);
  createSdlc(stateDir, {
    schemaVersion: 1,
    id: "release-a",
    goal: "Ship safely",
  });
  let revision = 1;
  const intent = recordSdlcArtifact(
    stateDir,
    "release-a",
    revision,
    artifact(),
    "intent",
  );
  revision = acceptArtifact(stateDir, "release-a", "intent-a", 2);
  const acceptedIntent = readSdlc(stateDir, "release-a").artifacts["intent-a"];
  recordSdlcArtifact(
    stateDir,
    "release-a",
    revision,
    artifact({
      id: "research-a",
      kind: "research",
      upstream: [acceptedIntent],
    }),
    "research",
  );
  revision = acceptArtifact(
    stateDir,
    "release-a",
    "research-a",
    revision + 1,
  );
  const acceptedResearch = readSdlc(stateDir, "release-a").artifacts[
    "research-a"
  ];
  recordSdlcArtifact(
    stateDir,
    "release-a",
    revision,
    artifact({
      id: "design-a",
      kind: "design",
      upstream: [acceptedResearch],
    }),
    "design",
  );
  revision = acceptArtifact(
    stateDir,
    "release-a",
    "design-a",
    revision + 1,
  );
  const previousIntent = readSdlc(stateDir, "release-a").artifacts["intent-a"];
  const changed = artifact({
    revision: previousIntent.revision + 1,
    content: { goal: "Ship more safely" },
    supersedes: {
      id: "intent-a",
      revision: previousIntent.revision,
      sha256: previousIntent.sha256,
    },
  });
  const result = recordSdlcArtifact(
    stateDir,
    "release-a",
    revision,
    changed,
    "intent-changed",
  );
  assert.deepEqual(
    result.invalidated.map((item) => item.id).sort(),
    ["design-a", "research-a"],
  );
  assert.equal(result.state.artifacts["research-a"].state, "invalidated");
  assert.equal(result.state.artifacts["design-a"].state, "invalidated");
});

test("SDLC CLI creates, records, transitions, and reads lifecycle state", (t) => {
  const root = fixture(t);
  const stateDir = path.join(root, ".omt");
  const requestFile = path.join(root, "request.json");
  const artifactFile = path.join(root, "artifact.json");
  const transitionFile = path.join(root, "transition.json");
  fs.writeFileSync(
    requestFile,
    JSON.stringify({ schemaVersion: 1, id: "release-a", goal: "Ship safely" }),
  );
  fs.writeFileSync(artifactFile, JSON.stringify(artifact()));
  fs.writeFileSync(
    transitionFile,
    JSON.stringify({
      eventId: "intent-ready",
      artifactId: "intent-a",
      toState: "ready",
    }),
  );
  assert.equal(
    cli(["sdlc-create", "--request", requestFile, "--state", stateDir]).status,
    0,
  );
  assert.equal(
    cli([
      "artifact-record",
      "--id",
      "release-a",
      "--artifact",
      artifactFile,
      "--state",
      stateDir,
      "--revision",
      "1",
      "--event",
      "intent-recorded",
    ]).status,
    0,
  );
  assert.equal(
    cli([
      "artifact-transition",
      "--id",
      "release-a",
      "--transition",
      transitionFile,
      "--state",
      stateDir,
      "--revision",
      "2",
    ]).status,
    0,
  );
  const status = cli([
    "sdlc-status",
    "--id",
    "release-a",
    "--state",
    stateDir,
  ]);
  assert.equal(status.status, 0);
  assert.equal(JSON.parse(status.stdout).artifacts["intent-a"].state, "ready");
});

test("incident feedback creates one deduplicated intent", (t) => {
  const stateDir = fixture(t);
  createSdlc(stateDir, {
    schemaVersion: 1,
    id: "release-a",
    goal: "Operate safely",
  });
  const incident = {
    id: "incident-a",
    fingerprint: "b".repeat(64),
    summary: "Production regression",
    evidence: "receipt-1 and observation-1",
  };
  const first = incidentToIntent(
    stateDir,
    "release-a",
    1,
    incident,
    "incident-intent",
  );
  assert.equal(first.duplicate, false);
  assert.equal(first.artifact.kind, "intent");
  const second = incidentToIntent(
    stateDir,
    "release-a",
    first.state.revision,
    incident,
    "ignored-duplicate-event",
  );
  assert.equal(second.duplicate, true);
  assert.equal(Object.keys(second.state.artifacts).length, 1);
});

test("concurrent incident CLI deliveries create one intent", async (t) => {
  const root = fixture(t);
  const stateDir = path.join(root, ".omt");
  createSdlc(stateDir, {
    schemaVersion: 1,
    id: "release-a",
    goal: "Deduplicate incidents",
  });
  const incidentFile = path.join(root, "incident.json");
  fs.writeFileSync(
    incidentFile,
    JSON.stringify({
      id: "incident-a",
      fingerprint: "b".repeat(64),
      summary: "Concurrent incident",
      evidence: "same evidence",
    }),
  );
  const command = [
    "incident-to-intent",
    "--id",
    "release-a",
    "--incident",
    incidentFile,
    "--state",
    stateDir,
    "--revision",
    "1",
    "--event",
    "incident-intent",
  ];
  const results = await Promise.all([cliAsync(command), cliAsync(command)]);
  assert.deepEqual(
    results.map((result) => result.status),
    [0, 0],
  );
  assert.equal(
    results.map((result) => JSON.parse(result.stdout).duplicate).filter(Boolean)
      .length,
    1,
  );
  assert.equal(Object.keys(readSdlc(stateDir, "release-a").artifacts).length, 1);
});

test("SDLC transaction recovery serializes concurrent readers", async (t) => {
  const stateDir = fixture(t);
  const state = createSdlc(stateDir, {
    schemaVersion: 1,
    id: "release-a",
    goal: "Recover safely",
  });
  const directory = path.join(stateDir, "sdlc", "release-a");
  const recovered = {
    ...state,
    revision: 2,
    eventIds: [...state.eventIds, "recovered-event"],
    updatedAt: "2026-09-15T12:00:00.000Z",
  };
  fs.writeFileSync(
    path.join(directory, "transaction.json"),
    JSON.stringify({
      state: recovered,
      event: {
        name: "000002-recovered-event.json",
        value: {
          id: "recovered-event",
          type: "test-recovery",
          recordedAt: recovered.updatedAt,
        },
      },
    }),
  );
  const command = [
    "sdlc-status",
    "--id",
    "release-a",
    "--state",
    stateDir,
  ];
  const readers = await Promise.all([cliAsync(command), cliAsync(command)]);
  assert.deepEqual(
    readers.map((reader) => reader.status),
    [0, 0],
  );
  assert.ok(
    readers.every((reader) => JSON.parse(reader.stdout).revision === 2),
  );
  assert.equal(fs.existsSync(path.join(directory, "transaction.json")), false);
  assert.equal(
    fs.existsSync(
      path.join(directory, "events", "000002-recovered-event.json"),
    ),
    true,
  );
});

test("identical orphan artifact writes recover while conflicts fail closed", (t) => {
  const stateDir = fixture(t);
  createSdlc(stateDir, {
    schemaVersion: 1,
    id: "release-a",
    goal: "Recover orphan writes",
  });
  const value = artifact();
  const file = path.join(
    stateDir,
    "sdlc",
    "release-a",
    "artifacts",
    "intent",
    "intent-a",
    "revisions",
    "1.json",
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  const recovered = recordSdlcArtifact(
    stateDir,
    "release-a",
    1,
    value,
    "recover-orphan",
  );
  assert.equal(recovered.state.artifacts["intent-a"].revision, 1);

  const conflictingState = fixture(t);
  createSdlc(conflictingState, {
    schemaVersion: 1,
    id: "release-b",
    goal: "Reject conflicts",
  });
  const conflictFile = path.join(
    conflictingState,
    "sdlc",
    "release-b",
    "artifacts",
    "intent",
    "intent-a",
    "revisions",
    "1.json",
  );
  fs.mkdirSync(path.dirname(conflictFile), { recursive: true });
  fs.writeFileSync(conflictFile, JSON.stringify({ ...value, title: "Other" }));
  assert.throws(
    () =>
      recordSdlcArtifact(
        conflictingState,
        "release-b",
        1,
        value,
        "reject-conflict",
      ),
    /Conflicting artifact revision/,
  );
});

test("the complete lifecycle reaches learning with explicit deployment evidence", (t) => {
  const stateDir = fixture(t);
  const lifecycleId = "complete-flow";
  const authority = authorityFixture();
  createSdlc(stateDir, {
    schemaVersion: 1,
    id: lifecycleId,
    goal: "Complete the SDLC",
    trustedAuthorities: [authority.trusted],
  });
  let lifecycleRevision = 1;
  let previous = null;
  const sourceHash = "c".repeat(64);
  for (const [index, kind] of [
    "intent",
    "research",
    "design",
    "plan",
    "build",
    "verification",
    "review",
    "release",
    "deployment",
    "observation",
    "incident",
    "learning",
  ].entries()) {
    const id = `${kind}-a`;
    const content =
      kind === "plan"
        ? {
            executionPlanId: "workflow-a",
            contractHash: "a".repeat(64),
          }
        : kind === "build"
          ? {
              sourceHash,
              taskReport: {
                status: "submitted",
                taskId: "task-a",
                runId: "run-a",
              },
            }
          : kind === "verification"
            ? {
                sourceHash,
                evidence: { status: "passed", key: "evidence-a" },
              }
            : kind === "review"
              ? {
                  sourceHash,
                  review: {
                    id: "review-a",
                    conclusion: "approved",
                    implementationExecutionId: "execution-review-a",
                  },
                }
              : kind === "release"
        ? {
            sourceHash,
            repository: "inho-team/app",
            rollbackPlan: { command: "rollback" },
            observationPlan: { durationMinutes: 30 },
            acceptance: { state: "accepted", sourceHash },
          }
        : kind === "deployment"
          ? {
              releaseId: "release-a",
              releaseRevision: previous.revision,
              sourceHash,
              repository: "inho-team/app",
              environment: "production",
            }
          : kind === "observation"
            ? {
                stage: kind,
                sourceHash,
                windowMinutes: 30,
                metrics: ["error-rate"],
              }
            : kind === "incident"
              ? {
                  stage: kind,
                  sourceHash,
                  incidentId: "incident-a",
                  evidence: "observation-a",
                }
              : kind === "learning"
                ? {
                    stage: kind,
                    sourceHash,
                    target: "runtime-check",
                    verification: { status: "passed" },
                  }
            : { stage: kind };
    if (kind === "deployment") {
      const wrong = recordSdlcArtifact(
        stateDir,
        lifecycleId,
        lifecycleRevision,
        artifact({
          id: "deployment-wrong-release",
          kind,
          title: "wrong deployment",
          content: { ...content, releaseId: "another-release" },
          upstream: [previous],
        }),
        "record-deployment-wrong-release",
      );
      lifecycleRevision = wrong.state.revision;
      assert.throws(
        () =>
          transitionSdlcArtifact(
            stateDir,
            lifecycleId,
            lifecycleRevision,
            {
              eventId: "deployment-wrong-ready",
              artifactId: "deployment-wrong-release",
              toState: "ready",
            },
          ),
        /differs from upstream/,
      );
    }
    const recorded = recordSdlcArtifact(
      stateDir,
      lifecycleId,
      lifecycleRevision,
      artifact({
        id,
        kind,
        title: kind,
        content,
        upstream: previous ? [previous] : [],
      }),
      `record-${kind}`,
    );
    lifecycleRevision = recorded.state.revision;
    for (const targetState of ["ready", "active", "submitted", "accepted"]) {
      const transition = {
        eventId: `${kind}-${targetState}`,
        artifactId: id,
        toState: targetState,
        now: Date.parse("2026-09-15T12:00:00.000Z") + index,
      };
      if (
        targetState === "submitted" &&
        ["verification", "review", "release"].includes(kind)
      ) {
        transition.evidence = [previous];
      }
      if (kind === "deployment" && targetState === "accepted") {
        const authorization = authority.sign({
          schemaVersion: 1,
          id: "deploy-auth",
          lifecycleId,
          releaseId: "release-a",
          releaseRevision: previous.revision,
          sourceHash,
          repository: "inho-team/app",
          environment: "production",
          actions: ["deploy"],
          issuedAt: "2020-09-15T00:00:00.000Z",
          expiresAt: "2099-09-16T00:00:00.000Z",
        });
        const receipt = {
          schemaVersion: 1,
          id: "deploy-receipt",
          authorizationId: "deploy-auth",
          lifecycleId,
          releaseId: "release-a",
          sourceHash,
          repository: "inho-team/app",
          environment: "production",
          action: "deploy",
          status: "succeeded",
          executedAt: "2026-09-15T12:00:00.000Z",
          externalId: "provider-deployment-1",
        };
        const authorized = recordDeploymentAuthorization(
          stateDir,
          lifecycleId,
          lifecycleRevision,
          authorization,
        );
        lifecycleRevision = authorized.state.revision;
        assert.throws(
          () =>
            recordDeploymentAuthorization(
              stateDir,
              lifecycleId,
              lifecycleRevision,
              authorization,
            ),
          /already recorded/,
        );
        assert.equal(
          checkDeployment(
            stateDir,
            lifecycleId,
            id,
            authorization.id,
            transition.now,
          ).ready,
          true,
        );
        assert.throws(
          () =>
            checkDeployment(
              stateDir,
              lifecycleId,
              id,
              "../outside",
              transition.now,
            ),
          /Authorization id required/,
        );
        assert.throws(
          () =>
            recordDeployment(
              stateDir,
              lifecycleId,
              lifecycleRevision,
              {
                deploymentId: id,
                authorizationId: authorization.id,
                receipt: {
                  ...receipt,
                  id: "future-receipt",
                  executedAt: "2100-09-15T12:00:00.000Z",
                },
                eventId: "reject-future-receipt",
                now: transition.now,
              },
            ),
          /outside authorization window/,
        );
        const deployed = recordDeployment(
          stateDir,
          lifecycleId,
          lifecycleRevision,
          {
            deploymentId: id,
            authorizationId: authorization.id,
            receipt,
            eventId: transition.eventId,
            now: transition.now,
          },
        );
        lifecycleRevision = deployed.state.revision;
        previous = readSdlc(stateDir, lifecycleId).artifacts[id];
        continue;
      }
      const transitioned = transitionSdlcArtifact(
        stateDir,
        lifecycleId,
        lifecycleRevision,
        transition,
      );
      lifecycleRevision = transitioned.state.revision;
    }
    previous = readSdlc(stateDir, lifecycleId).artifacts[id];
    assert.equal(previous.state, "accepted");
  }
  const state = readSdlc(stateDir, lifecycleId);
  assert.equal(state.artifacts["learning-a"].state, "accepted");
  assert.equal(
    fs.existsSync(
      path.join(
        stateDir,
        "sdlc",
        lifecycleId,
        "authorizations",
        "deploy-auth.json",
      ),
    ),
    true,
  );
  assert.equal(
    fs.existsSync(
      path.join(
        stateDir,
        "sdlc",
        lifecycleId,
        "receipts",
        "deploy-receipt.json",
      ),
    ),
    true,
  );
  const org = JSON.parse(
    fs.readFileSync(
      "plugins/oh-my-teams/examples/organization.json",
      "utf8",
    ),
  );
  const status = organizationStatus(org, stateDir);
  assert.equal(status.sdlc[0].currentStage, "complete");
  assert.equal(status.sdlc[0].acceptedCount, 12);
});

test("deployment cannot be accepted without matching authorization and receipt", (t) => {
  const stateDir = fixture(t);
  createSdlc(stateDir, {
    schemaVersion: 1,
    id: "release-a",
    goal: "Deploy safely",
  });
  const release = recordSdlcArtifact(
    stateDir,
    "release-a",
    1,
    artifact({ id: "release-artifact", kind: "release" }),
    "release-recorded",
  );
  const acceptedRelease = {
    ...release.artifact,
    revision: 2,
    state: "accepted",
    supersedes: {
      id: "release-artifact",
      revision: 1,
      sha256: release.sha256,
    },
  };
  const acceptedHash = sdlcArtifactHash(acceptedRelease);
  const lifecycle = readSdlc(stateDir, "release-a");
  const directory = path.join(stateDir, "sdlc", "release-a");
  fs.mkdirSync(
    path.join(
      directory,
      "artifacts",
      "release",
      "release-artifact",
      "revisions",
    ),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(
      directory,
      "artifacts",
      "release",
      "release-artifact",
      "revisions",
      "2.json",
    ),
    JSON.stringify(acceptedRelease),
  );
  lifecycle.artifacts["release-artifact"] = {
    id: "release-artifact",
    kind: "release",
    revision: 2,
    state: "accepted",
    sha256: acceptedHash,
  };
  fs.writeFileSync(
    path.join(directory, "state.json"),
    JSON.stringify(lifecycle),
  );
  const deployment = recordSdlcArtifact(
    stateDir,
    "release-a",
    lifecycle.revision,
    artifact({
      id: "deployment-a",
      kind: "deployment",
      content: {
        releaseId: "release-artifact",
        releaseRevision: 2,
        sourceHash: "d".repeat(64),
        repository: "inho-team/app",
        environment: "production",
      },
      upstream: [lifecycle.artifacts["release-artifact"]],
    }),
    "deployment-recorded",
  );
  let revision = deployment.state.revision;
  for (const targetState of ["ready", "active", "submitted"]) {
    const transitioned = transitionSdlcArtifact(
      stateDir,
      "release-a",
      revision,
      {
        eventId: `deployment-${targetState}`,
        artifactId: "deployment-a",
        toState: targetState,
      },
    );
    revision = transitioned.state.revision;
  }
  assert.throws(
    () =>
      transitionSdlcArtifact(stateDir, "release-a", revision, {
        eventId: "deployment-accepted",
        artifactId: "deployment-a",
        toState: "accepted",
      }),
    /Authorization identity required/,
  );
});

test("critical submissions reject fabricated or stale evidence", (t) => {
  const stateDir = fixture(t);
  createSdlc(stateDir, {
    schemaVersion: 1,
    id: "release-a",
    goal: "Verify evidence",
  });
  const build = recordSdlcArtifact(
    stateDir,
    "release-a",
    1,
    artifact({ id: "build-a", kind: "build" }),
    "build-recorded",
  );
  const acceptedBuild = {
    ...build.artifact,
    revision: 2,
    state: "accepted",
    supersedes: { id: "build-a", revision: 1, sha256: build.sha256 },
  };
  const acceptedHash = sdlcArtifactHash(acceptedBuild);
  const directory = path.join(stateDir, "sdlc", "release-a");
  const buildFile = path.join(
    directory,
    "artifacts",
    "build",
    "build-a",
    "revisions",
    "2.json",
  );
  fs.mkdirSync(path.dirname(buildFile), { recursive: true });
  fs.writeFileSync(buildFile, JSON.stringify(acceptedBuild));
  const state = readSdlc(stateDir, "release-a");
  state.artifacts["build-a"] = {
    id: "build-a",
    kind: "build",
    revision: 2,
    state: "accepted",
    sha256: acceptedHash,
  };
  fs.writeFileSync(path.join(directory, "state.json"), JSON.stringify(state));
  const verification = recordSdlcArtifact(
    stateDir,
    "release-a",
    state.revision,
    artifact({
      id: "verification-a",
      kind: "verification",
      content: {
        sourceHash: "e".repeat(64),
        evidence: { status: "passed", key: "evidence-a" },
      },
      upstream: [state.artifacts["build-a"]],
    }),
    "verification-recorded",
  );
  let revision = verification.state.revision;
  for (const targetState of ["ready", "active"]) {
    const transitioned = transitionSdlcArtifact(
      stateDir,
      "release-a",
      revision,
      {
        eventId: `verification-${targetState}`,
        artifactId: "verification-a",
        toState: targetState,
      },
    );
    revision = transitioned.state.revision;
  }
  assert.throws(
    () =>
      transitionSdlcArtifact(stateDir, "release-a", revision, {
        eventId: "verification-submitted",
        artifactId: "verification-a",
        toState: "submitted",
        evidence: [
          { id: "fabricated", revision: 1, sha256: "f".repeat(64) },
        ],
      }),
    /Stale or unaccepted evidence/,
  );
});

test("explicit invalidation recursively invalidates accepted descendants", (t) => {
  const stateDir = fixture(t);
  createSdlc(stateDir, {
    schemaVersion: 1,
    id: "release-a",
    goal: "Invalidate safely",
  });
  const intent = recordSdlcArtifact(
    stateDir,
    "release-a",
    1,
    artifact(),
    "intent",
  );
  let revision = acceptArtifact(stateDir, "release-a", "intent-a", 2);
  const acceptedIntent = readSdlc(stateDir, "release-a").artifacts["intent-a"];
  recordSdlcArtifact(
    stateDir,
    "release-a",
    revision,
    artifact({
      id: "research-a",
      kind: "research",
      upstream: [acceptedIntent],
    }),
    "research",
  );
  revision = acceptArtifact(
    stateDir,
    "release-a",
    "research-a",
    revision + 1,
  );
  const result = transitionSdlcArtifact(
    stateDir,
    "release-a",
    revision,
    {
      eventId: "invalidate-intent",
      artifactId: "intent-a",
      toState: "invalidated",
    },
  );
  assert.equal(result.state.artifacts["intent-a"].state, "invalidated");
  assert.equal(result.state.artifacts["research-a"].state, "invalidated");
});
