/** Covers the stall policy a supervisor applies to a silent subordinate. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  readJSON,
  supervisionPolicy,
  validateOrg,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import { nextSupervisionAction } from "../plugins/oh-my-teams/scripts/status.mjs";
import { draftOrganization } from "../plugins/oh-my-teams/scripts/org-draft.mjs";

const policy = { progressCheckMs: 900000, unansweredLimit: 2 };
const now = "2026-09-16T10:30:00.000Z";
const minutesAgo = (minutes) =>
  new Date(Date.parse(now) - minutes * 60000).toISOString();

const next = (observation) =>
  nextSupervisionAction({ now, policy, unansweredRequests: 0, ...observation });

test("an organization without supervision settings reads the cheap defaults", () => {
  const org = readJSON(
    new URL(
      "../plugins/oh-my-teams/examples/organization.json",
      import.meta.url,
    ),
  );
  assert.deepEqual(supervisionPolicy(validateOrg(org)), policy);

  const drafted = draftOrganization({
    name: "team",
    tiers: 1,
    models: ["claude:default"],
  });
  assert.deepEqual(drafted.policy.supervision, policy);
});

test("supervision settings outside their range are refused", () => {
  const org = draftOrganization({
    name: "team",
    tiers: 1,
    models: ["claude:default"],
  });
  for (const supervision of [
    { progressCheckMs: 1000, unansweredLimit: 2 },
    { progressCheckMs: 900000, unansweredLimit: 0 },
    { progressCheckMs: 900000 },
  ]) {
    org.policy.supervision = supervision;
    assert.throws(() => validateOrg(org), /supervision/);
  }
});

test("a live worker that spoke recently is left alone", () => {
  const result = next({ liveness: "live", lastActivityAt: minutesAgo(5) });
  assert.equal(result.action, "wait");
  assert.equal(result.display, "진행 중");
});

test("a live but silent worker is asked for progress, then escalated", () => {
  const asked = next({ liveness: "live", lastActivityAt: minutesAgo(20) });
  assert.equal(asked.action, "ask-progress");
  // A silent worker is not shown as progressing.
  assert.equal(asked.display, "무응답 20분");

  const again = next({
    liveness: "live",
    lastActivityAt: minutesAgo(40),
    unansweredRequests: 1,
  });
  assert.equal(again.action, "ask-progress");

  const escalated = next({
    liveness: "live",
    lastActivityAt: minutesAgo(60),
    unansweredRequests: 2,
  });
  assert.equal(escalated.action, "escalate");
  assert.equal(escalated.readOutput, true);
  assert.equal(escalated.display, "무응답 60분");
});

test("an unverifiable worker is inspected, never assumed alive", () => {
  const inspected = next({
    liveness: "unverifiable",
    lastActivityAt: minutesAgo(1),
  });
  assert.equal(inspected.action, "inspect");
  assert.notEqual(inspected.display, "진행 중");

  const escalated = next({
    liveness: "unverifiable",
    lastActivityAt: minutesAgo(1),
    unansweredRequests: 2,
  });
  assert.equal(escalated.action, "escalate");
});

test("a worker with no observed activity is inspected before anything else", () => {
  assert.equal(next({ liveness: "live" }).action, "inspect");
});

test("an exit without worker_done is escalated as a failure to classify", () => {
  const result = next({ liveness: "exited", lastActivityAt: minutesAgo(2) });
  assert.equal(result.action, "escalate");
  assert.equal(result.reason, "exited-without-worker-done");
  assert.equal(result.failureClassify, true);
});

test("a worker parked on a human prompt is escalated rather than nudged", () => {
  const result = next({
    liveness: "live",
    lastActivityAt: minutesAgo(30),
    agentWait: { evidence: "prompt-text" },
  });
  assert.equal(result.action, "escalate");
  assert.equal(result.reason, "waiting-on-human-prompt");
});

test("no observation ever yields an automatic retry or stop", () => {
  const actions = new Set();
  for (const liveness of ["live", "unverifiable", "exited"]) {
    for (const minutes of [0, 10, 20, 120]) {
      for (const unansweredRequests of [0, 1, 2, 5]) {
        actions.add(
          next({
            liveness,
            lastActivityAt: minutesAgo(minutes),
            unansweredRequests,
          }).action,
        );
      }
    }
  }
  assert.deepEqual(
    [...actions].sort(),
    ["ask-progress", "escalate", "inspect", "wait"].sort(),
  );
  assert.throws(() => next({ liveness: "running" }), /liveness/);
});
