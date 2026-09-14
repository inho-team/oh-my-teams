/** Tests for immutable SDLC artifacts and deployment authorization boundaries. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSdlc,
  readSdlc,
  recordSdlcArtifact,
  sdlcArtifactHash,
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
