/** @module supervision-reporting-test */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readSupervisionReport,
  recordSupervisionObservation,
} from "../plugins/oh-my-teams/scripts/supervision-reporting.mjs";

const policy = { progressCheckMs: 60_000, unansweredLimit: 1 };
const now = "2026-10-11T06:00:00.000Z";

function state(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omt-supervision-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("state-backed supervision does not promote activity to semantic progress", (t) => {
  const stateDir = state(t);
  const first = recordSupervisionObservation({
    stateDir,
    dispatchId: "ctx_supervision",
    policy,
    observation: {
      liveness: "live",
      lastActivityAt: now,
      now,
      source: "orca-worker-list",
    },
  });
  assert.equal(first.semanticProgressProof, "unknown");
  assert.equal(first.semanticProgressAt, null);
  assert.equal(first.action, "inspect");
  assert.equal(first.supervision.lastProvenProgress, null);
});

test("durable supervision escalates once and suppresses a restart duplicate", (t) => {
  const stateDir = state(t);
  const observation = {
    liveness: "unverifiable",
    now,
    source: "orca-worker-list",
  };
  const first = recordSupervisionObservation({
    stateDir,
    dispatchId: "ctx_restart",
    policy,
    observation,
  });
  assert.equal(first.action, "inspect");
  const escalated = recordSupervisionObservation({
    stateDir,
    dispatchId: "ctx_restart",
    policy,
    observation: {
      ...observation,
      now: "2026-10-11T06:01:00.000Z",
      actionReceipt: {
        id: "inspect-1",
        action: "inspect",
        status: "performed",
        at: "2026-10-11T06:00:30.000Z",
        evidence: { kind: "orca-observation", key: "worker-list-1" },
      },
    },
  });
  assert.equal(escalated.action, "escalate");
  assert.equal(escalated.reason, "unverifiable-after-checks");
  const repeated = recordSupervisionObservation({
    stateDir,
    dispatchId: "ctx_restart",
    policy,
    observation: { ...observation, now: "2026-10-11T06:02:00.000Z" },
  });
  assert.equal(repeated.action, "wait");
  assert.equal(repeated.reason, "already-escalated");
  assert.equal(repeated.supervision.report.delivery, "not-attempted");
  assert.equal(repeated.supervision.report.deduplicated, true);
});

test("recommended inspections do not count until an Orca action receipt exists", (t) => {
  const stateDir = state(t);
  const first = recordSupervisionObservation({
    stateDir,
    dispatchId: "ctx_receipt",
    policy,
    observation: { liveness: "unverifiable", now },
  });
  const repeatedRecommendation = recordSupervisionObservation({
    stateDir,
    dispatchId: "ctx_receipt",
    policy,
    observation: { liveness: "unverifiable", now: "2026-10-11T06:01:00.000Z" },
  });
  assert.equal(first.action, "inspect");
  assert.equal(repeatedRecommendation.action, "inspect");
  assert.equal(repeatedRecommendation.supervision.inspections, 0);
});

test("proven semantic progress with evidence clears an old escalation cycle", (t) => {
  const stateDir = state(t);
  recordSupervisionObservation({
    stateDir,
    dispatchId: "ctx_progress",
    policy,
    observation: { liveness: "unverifiable", now, source: "orca-worker-list" },
  });
  const recovered = recordSupervisionObservation({
    stateDir,
    dispatchId: "ctx_progress",
    policy,
    observation: {
      liveness: "live",
      semanticProgressAt: "2026-10-11T06:02:00.000Z",
      semanticProgressEvidence: { kind: "frozen-verify", key: "ev_123" },
      semanticProgressSource: "verify",
      now: "2026-10-11T06:02:00.000Z",
      source: "orca-worker-list",
    },
  });
  assert.equal(recovered.action, "wait");
  assert.equal(recovered.reason, "recent-activity");
  assert.deepEqual(recovered.supervision.escalation, null);
  assert.deepEqual(
    readSupervisionReport(stateDir, "ctx_progress").lastProvenProgress.evidence,
    { kind: "frozen-verify", key: "ev_123" },
  );
});

test("supervisor absence and delayed report name different owners without sending", (t) => {
  const stateDir = state(t);
  const absent = recordSupervisionObservation({
    stateDir,
    dispatchId: "ctx_absent",
    policy,
    observation: {
      liveness: "unverifiable",
      supervisor: { status: "absent" },
      now,
    },
  });
  assert.equal(absent.reason, "supervisor-absent");
  assert.equal(absent.supervision.pendingDecision.nextOwner, "director");
  const delayed = recordSupervisionObservation({
    stateDir,
    dispatchId: "ctx_delayed",
    policy,
    observation: {
      liveness: "live",
      report: { state: "submitted", pendingAt: "2026-10-11T05:58:00.000Z" },
      now,
    },
  });
  assert.equal(delayed.reason, "report-delayed");
  assert.equal(delayed.supervision.pendingDecision.nextOwner, "pm");
  assert.equal(delayed.supervision.report.state, "stored");
});

test("unknown or invalid progress preserves a pending decision until handled evidence", (t) => {
  const stateDir = state(t);
  const escalated = recordSupervisionObservation({
    stateDir,
    dispatchId: "ctx_pending",
    policy,
    observation: {
      liveness: "unverifiable",
      supervisor: { status: "absent" },
      now,
    },
  });
  const unknown = recordSupervisionObservation({
    stateDir,
    dispatchId: "ctx_pending",
    policy,
    observation: {
      liveness: "live",
      semanticProgressAt: "2026-10-11T07:00:00.000Z",
      semanticProgressEvidence: "not proof",
      now: "2026-10-11T06:01:00.000Z",
    },
  });
  assert.equal(escalated.supervision.pendingDecision.nextOwner, "director");
  assert.equal(unknown.semanticProgressProof, "unknown");
  assert.equal(unknown.supervision.pendingDecision.nextOwner, "director");
  const handled = recordSupervisionObservation({
    stateDir,
    dispatchId: "ctx_pending",
    policy,
    observation: {
      liveness: "live",
      now: "2026-10-11T06:02:00.000Z",
      pendingDecisionResolution: {
        status: "handled",
        at: "2026-10-11T06:02:00.000Z",
        evidence: { kind: "message-ack", key: "msg_123" },
        decisionCycle: escalated.supervision.pendingDecision.cycle,
      },
    },
  });
  assert.equal(handled.supervision.pendingDecision, null);
});

test("old action receipts remain deduplicated after more than twenty later receipts", (t) => {
  const stateDir = state(t);
  const dispatchId = "ctx_all_receipts";
  for (let index = 0; index < 21; index += 1) {
    recordSupervisionObservation({
      stateDir,
      dispatchId,
      policy,
      observation: {
        liveness: "unverifiable",
        now: `2026-10-11T06:${String(index).padStart(2, "0")}:00.000Z`,
        actionReceipt: {
          id: `inspect-${index}`,
          action: "inspect",
          status: "performed",
          at: `2026-10-11T06:${String(index).padStart(2, "0")}:00.000Z`,
          evidence: { kind: "orca-observation", key: `worker-${index}` },
        },
      },
    });
  }
  const replay = recordSupervisionObservation({
    stateDir,
    dispatchId,
    policy,
    observation: {
      liveness: "unverifiable",
      now: "2026-10-11T06:30:00.000Z",
      actionReceipt: {
        id: "inspect-0",
        action: "inspect",
        status: "performed",
        at: "2026-10-11T06:30:00.000Z",
        evidence: { kind: "orca-observation", key: "replayed" },
      },
    },
  });
  assert.equal(replay.confirmedActionReceipt, null);
  assert.equal(replay.supervision.inspections, 21);
});

test("only a current decision cycle can clear a pending decision", (t) => {
  const stateDir = state(t);
  const first = recordSupervisionObservation({
    stateDir,
    dispatchId: "ctx_current_cycle",
    policy,
    observation: {
      liveness: "unverifiable",
      supervisor: { status: "absent" },
      now,
    },
  });
  const pending = first.supervision.pendingDecision;
  const stale = recordSupervisionObservation({
    stateDir,
    dispatchId: "ctx_current_cycle",
    policy,
    observation: {
      liveness: "live",
      now: "2026-10-11T06:01:00.000Z",
      pendingDecisionResolution: {
        status: "handled",
        at: "2026-10-11T05:59:00.000Z",
        decisionCycle: pending.cycle,
        evidence: { kind: "message-ack", key: "old" },
      },
    },
  });
  assert.equal(stale.supervision.pendingDecision.cycle, pending.cycle);
  const wrongCycle = recordSupervisionObservation({
    stateDir,
    dispatchId: "ctx_current_cycle",
    policy,
    observation: {
      liveness: "live",
      now: "2026-10-11T06:02:00.000Z",
      pendingDecisionResolution: {
        status: "handled",
        at: "2026-10-11T06:02:00.000Z",
        decisionCycle: "other-cycle",
        evidence: { kind: "message-ack", key: "other" },
      },
    },
  });
  assert.equal(wrongCycle.supervision.pendingDecision.cycle, pending.cycle);
});

test("locally submitted observations do not default to official Orca provenance", (t) => {
  const stateDir = state(t);
  const result = recordSupervisionObservation({
    stateDir,
    dispatchId: "ctx_source",
    policy,
    observation: { liveness: "live", now },
  });
  assert.equal(result.supervision.source, "supervisor-submitted");
});

test("progress and performed receipts survive normal and early-return decisions", (t) => {
  const stateDir = state(t);
  const progress = {
    semanticProgressAt: now,
    semanticProgressEvidence: { kind: "frozen-verify", key: "progress-1" },
    semanticProgressSource: "verify",
    actionReceipt: {
      id: "inspect-with-progress",
      action: "inspect",
      status: "performed",
      at: now,
      evidence: { kind: "orca-observation", key: "observation-1" },
    },
  };
  const cases = [
    ["normal", {}],
    ["absent", { supervisor: { status: "absent" } }],
    [
      "delayed",
      { report: { state: "submitted", pendingAt: "2026-10-11T05:58:00.000Z" } },
    ],
  ];
  for (const [label, extra] of cases) {
    const result = recordSupervisionObservation({
      stateDir,
      dispatchId: `ctx_${label}_progress_receipt`,
      policy,
      observation: { liveness: "live", now, ...progress, ...extra },
    });
    assert.equal(result.progressAdvanced, true, label);
    assert.equal(
      result.confirmedActionReceipt.id,
      "inspect-with-progress",
      label,
    );
    assert.equal(result.effectiveInspections, 1, label);
    assert.equal(result.supervision.inspections, 1, label);
    assert.deepEqual(
      result.supervision.lastProvenProgress.evidence,
      progress.semanticProgressEvidence,
      label,
    );
    assert.deepEqual(
      result.supervision.actionReceiptIds,
      ["inspect-with-progress"],
      label,
    );
    if (label === "normal") {
      assert.equal(result.supervision.pendingDecision, null);
    } else {
      assert.equal(
        result.supervision.pendingDecision.reason,
        result.reason,
        label,
      );
      assert.ok(result.supervision.pendingDecision.cycle, label);
      assert.ok(result.supervision.pendingDecision.nextOwner, label);
    }
  }
});
