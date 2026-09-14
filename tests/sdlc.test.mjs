/** Tests for immutable SDLC artifacts and deployment authorization boundaries. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  createSdlc,
  incidentToIntent,
  readSdlc,
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

function cli(args) {
  return spawnSync(
    process.execPath,
    ["plugins/oh-my-teams/scripts/teams-org.mjs", ...args],
    { cwd: path.resolve("."), encoding: "utf8" },
  );
}

test("SDLC artifacts persist immutable revisions and reject stale lifecycle updates", (t) => {
  const stateDir = fixture(t);
  createSdlc(stateDir, { id: "release-a", goal: "Ship safely" });
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
  createSdlc(stateDir, { id: "release-a", goal: "Ship safely" });
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
  const expected = {
    action: "deploy",
    lifecycleId: "release-a",
    releaseId: "release-artifact",
    releaseRevision: 2,
    sourceHash: "a".repeat(64),
    repository: "inho-team/app",
    environment: "production",
  };
  const authorization = {
    schemaVersion: 1,
    id: "deploy-auth",
    ...expected,
    actions: ["deploy"],
    authority: { kind: "human", id: "user-1" },
    issuedAt: "2026-09-15T00:00:00.000Z",
    expiresAt: "2026-09-16T00:00:00.000Z",
  };
  delete authorization.action;
  assert.equal(
    validateDeploymentAuthorization(
      authorization,
      expected,
      Date.parse("2026-09-15T12:00:00.000Z"),
    ),
    authorization,
  );
  assert.throws(
    () =>
      validateDeploymentAuthorization(
        { ...authorization, environment: "staging" },
        expected,
        Date.parse("2026-09-15T12:00:00.000Z"),
      ),
    /environment mismatch/,
  );
  assert.throws(
    () =>
      validateDeploymentAuthorization(
        authorization,
        expected,
        Date.parse("2026-09-17T00:00:00.000Z"),
      ),
    /expired/,
  );
  assert.throws(
    () =>
      validateDeploymentAuthorization(
        {
          ...authorization,
          authority: { kind: "role", id: "pm" },
        },
        expected,
        Date.parse("2026-09-15T12:00:00.000Z"),
      ),
    /External deployment authority/,
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
  createSdlc(stateDir, { id: "release-a", goal: "Ship safely" });
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
  createSdlc(stateDir, { id: "release-a", goal: "Ship safely" });
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
    JSON.stringify({ id: "release-a", goal: "Ship safely" }),
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
  createSdlc(stateDir, { id: "release-a", goal: "Operate safely" });
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
