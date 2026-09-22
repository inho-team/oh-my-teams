/** Test suite for incidents state management. */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ingestIncident,
  incidentStatus,
} from "../plugins/oh-my-teams/scripts/incidents.mjs";

test("P-10: ingestIncident and incidentStatus", () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-incidents-"));
  const config = {
    schemaVersion: 1,
    enabled: true,
    maxOpen: 5,
    maxProposalsPerWindow: 10,
    windowMs: 60000,
    observationMs: 300000,
    noProgressLimit: 3,
  };
  const event = {
    schemaVersion: 1,
    source: "tests",
    externalId: "ext-1",
    dedupeKey: "error-123",
    description: "test error",
    summary: "summary",
    evidence: "evidence",
    observedAt: new Date().toISOString(),
  };

  const result = ingestIncident(tmpdir, event, config);
  assert.equal(result.duplicate, false);
  assert.equal(result.incident.status, "proposed");

  const state = incidentStatus(tmpdir);
  assert.equal(Object.keys(state.incidents).length, 1);
  assert.equal(state.proposalTimes.length, 1);

  fs.rmSync(tmpdir, { recursive: true, force: true });
});
