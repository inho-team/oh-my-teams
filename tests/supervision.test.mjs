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
    { progressCheckMs: 900000, unansweredLimit: 2, retry: true },
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

  // Inspections count toward the limit too: only a progress request used to,
  // so a worker that stayed unverifiable was inspected forever.
  const escalated = next({
    liveness: "unverifiable",
    lastActivityAt: minutesAgo(1),
    inspections: 2,
  });
  assert.equal(escalated.action, "escalate");
});

test("a worker with no observed activity is inspected, then escalated", () => {
  const first = next({ liveness: "live" });
  assert.equal(first.action, "inspect");
  assert.equal(first.display, "활동 기록 없음");
  assert.equal(next({ liveness: "live", inspections: 1 }).action, "inspect");
  assert.equal(next({ liveness: "live", inspections: 2 }).action, "escalate");
  // A mix of requests and inspections still reaches the limit.
  assert.equal(
    next({
      liveness: "live",
      lastActivityAt: minutesAgo(50),
      unansweredRequests: 1,
      inspections: 1,
    }).action,
    "escalate",
  );
});

test("a stall already escalated is not escalated again every period", () => {
  const escalatedAt = minutesAgo(10);
  const quiet = next({
    liveness: "live",
    lastActivityAt: minutesAgo(60),
    unansweredRequests: 2,
    escalatedAt,
  });
  assert.equal(quiet.action, "wait");
  assert.equal(quiet.reason, "already-escalated");
  assert.equal(quiet.display, "무응답 60분");

  // New activity after the escalation starts a fresh assessment.
  const resumed = next({
    liveness: "live",
    lastActivityAt: minutesAgo(1),
    escalatedAt,
  });
  assert.equal(resumed.reason, "recent-activity");
});

test("an exit or a human prompt after an escalation is still reported", () => {
  // The already-escalated rule ran first, so a worker that exited without
  // worker_done, or stopped on a prompt only a human can answer, after its
  // stall was escalated read as a stall to keep waiting on.
  const escalatedAt = minutesAgo(10);
  const exited = next({
    liveness: "exited",
    lastActivityAt: minutesAgo(60),
    unansweredRequests: 2,
    escalatedAt,
  });
  assert.equal(exited.action, "escalate");
  assert.equal(exited.reason, "exited-without-worker-done");

  const prompted = next({
    liveness: "live",
    lastActivityAt: minutesAgo(60),
    unansweredRequests: 2,
    escalatedAt,
    agentWait: { evidence: "prompt-text" },
  });
  assert.equal(prompted.action, "escalate");
  assert.equal(prompted.reason, "waiting-on-human-prompt");
});

test("an exit or a human prompt already reported is not reported every period", () => {
  // Checking those facts before the already-escalated rule had a side effect:
  // an exit or a prompt that had been escalated was escalated again at every
  // check, so one stopped worker filled the report with copies of itself.
  const escalatedAt = minutesAgo(10);
  const exited = next({
    liveness: "exited",
    lastActivityAt: minutesAgo(60),
    escalatedAt,
    escalatedReason: "exited-without-worker-done",
  });
  assert.equal(exited.action, "wait");
  assert.equal(exited.reason, "already-escalated");

  const prompted = next({
    liveness: "live",
    lastActivityAt: minutesAgo(60),
    escalatedAt,
    escalatedReason: "waiting-on-human-prompt",
    agentWait: { evidence: "prompt-text" },
  });
  assert.equal(prompted.action, "wait");

  // A different fact than the one reported is still news: a stall reported
  // earlier that has since become an exit must be escalated.
  const changed = next({
    liveness: "exited",
    lastActivityAt: minutesAgo(60),
    escalatedAt,
    escalatedReason: "silent-after-progress-requests",
  });
  assert.equal(changed.action, "escalate");
  assert.equal(changed.reason, "exited-without-worker-done");
});

test("an unreadable clock is refused instead of printing NaN", () => {
  assert.throws(
    () =>
      next({ liveness: "live", lastActivityAt: minutesAgo(5), now: "later" }),
    /now/,
  );
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
