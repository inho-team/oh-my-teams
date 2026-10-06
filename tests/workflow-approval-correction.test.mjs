/** Deterministic tests for approval provenance append-only correction. */
import { after } from "node:test";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { readJSON, writeJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  createWorkflow,
  readWorkflow,
  correctApprovalProvenance,
  increaseCallAllowance,
  reserveExecution,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";

const organization = readJSON(
  new URL("../plugins/oh-my-teams/examples/organization.json", import.meta.url),
);

const task = (id, files = [`${id}.txt`]) => ({
  schemaVersion: 2,
  revision: 1,
  kind: "edit",
  id,
  goal: "Test workflow safety",
  instruction: "Make the change",
  nonGoals: [],
  constraints: [],
  files,
  checks: [[process.execPath, "-e", "process.exit(0)"]],
  acceptance: [
    { id: "check", description: "check", method: "check", checkIndexes: [0] },
  ],
  dependencies: [],
  contractRefs: [],
  contextRefs: [],
  openQuestions: [],
  reviewRequirements: [],
  environment: "test",
  risk: "low",
  baseRef: "HEAD",
});

async function repo(t) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "workflow-correction-test-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync(
    "git",
    [
      "commit",
      "--allow-empty",
      "-m",
      "root",
      "--author=Test <test@example.com>",
    ],
    { cwd: dir },
  );
  return dir;
}

test("correctApprovalProvenance records split append-only events, handles duplicates, leaves canonical data alone", async (t) => {
  const dir = await repo(t);
  const stateDir = path.join(dir, ".omt");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".omt/\n");
  writeJSON(path.join(dir, "task-a.json"), task("task-a"));

  const request = {
    schemaVersion: 1,
    id: "correction-test",
    goal: "Test",
    repo: ".",
    tasks: [{ file: "task-a.json", role: "worker" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 1, maxCalls: 16 },
  };

  const initial = await createWorkflow(stateDir, request, organization, dir);
  const targetEventId = "allowance-36041363";

  reserveExecution(stateDir, "correction-test", initial.revision, {
    schemaVersion: 1,
    eventId: "exec-1",
    taskId: "task-a",
    attemptId: "attempt-1",
    callAllowance: 1,
  });

  const increased = increaseCallAllowance(
    stateDir,
    "correction-test",
    initial.revision + 1,
    {
      schemaVersion: 1,
      eventId: targetEventId,
      taskId: "task-a",
      attemptId: "attempt-1",
      allowance: 2,
      approvedBy: "user",
      reason: "Increase",
    },
  );

  const correctionInput = {
    schemaVersion: 1,
    eventId: "correction-1",
    targetEventId,
    wrongApprovedBy: "user",
    attestation: "사용자의 2026-09-30 ㄱㄱ 응답은 새로운 승인이다.",
    approvedBy: "pm",
    approvalTime: "2026-09-30T10:00:00Z",
    sourceContext: "Slack DM",
  };

  const corrected = correctApprovalProvenance(
    stateDir,
    "correction-test",
    increased.state.revision,
    correctionInput,
  );

  assert.strictEqual(corrected.duplicate, false);
  assert.strictEqual(corrected.state.approvalCorrections.length, 1);
  assert.strictEqual(
    corrected.state.approvalCorrections[0].targetEventId,
    targetEventId,
  );
  assert.strictEqual(
    corrected.state.approvalCorrections[0].wrongApprovedBy,
    "user",
  );

  // Immutability check
  const taskState = corrected.state.tasks["task-a"];
  const attempt = taskState.attempts.find((a) => a.id === "attempt-1");
  const history = attempt.allowanceHistory[0];
  assert.strictEqual(
    history.approvedBy,
    "user",
    "Original approvedBy must not be mutated",
  );
  assert.strictEqual(corrected.state.budget.maxCalls, 16);

  // Idempotency (exact match replay)
  const replayed = correctApprovalProvenance(
    stateDir,
    "correction-test",
    corrected.state.revision,
    correctionInput,
  );
  assert.strictEqual(replayed.duplicate, true);
  assert.strictEqual(replayed.state.revision, corrected.state.revision);

  // Replay with different payload must fail (for EACH semantic field)
  const mutationTests = [
    {
      field: "wrongApprovedBy",
      value: "other",
      error: /Duplicate eventId with different correction payload/,
    },
    {
      field: "attestation",
      value: "changed attestation",
      error: /Duplicate eventId with different attestation payload/,
    },
    {
      field: "approvedBy",
      value: "changed",
      error: /Duplicate eventId with different attestation payload/,
    },
    {
      field: "approvalTime",
      value: "2026-10-01T10:00:00Z",
      error: /Duplicate eventId with different attestation payload/,
    },
    {
      field: "sourceContext",
      value: "changed context",
      error: /Duplicate eventId with different attestation payload/,
    },
  ];

  for (const { field, value, error } of mutationTests) {
    assert.throws(
      () =>
        correctApprovalProvenance(
          stateDir,
          "correction-test",
          corrected.state.revision,
          {
            ...correctionInput,
            [field]: value,
          },
        ),
      error,
      `Failed to throw on mutated ${field}`,
    );
  }

  // Event check (two events)
  const eventPath = path.join(
    stateDir,
    "workflows",
    "correction-test",
    "events",
  );

  // Test missing event file integrity
  const attEvents = fs
    .readdirSync(eventPath)
    .filter((f) => f.includes("correction-1-att"));
  assert.strictEqual(attEvents.length, 1);
  const attFile = path.join(eventPath, attEvents[0]);

  const attFileBackup = fs.readFileSync(attFile);
  fs.unlinkSync(attFile); // Delete the file

  assert.throws(
    () =>
      correctApprovalProvenance(
        stateDir,
        "correction-test",
        corrected.state.revision,
        correctionInput,
      ),
    /Missing attestation event file for duplicate check/,
    "Failed to throw when attestation event file is missing",
  );

  // Restore file
  fs.writeFileSync(attFile, attFileBackup);

  // Test missing correction event file
  const corrEvents = fs
    .readdirSync(eventPath)
    .filter((f) => f.endsWith("correction-1.json"));
  assert.strictEqual(corrEvents.length, 1);
  const corrFile = path.join(eventPath, corrEvents[0]);

  const corrFileBackup = fs.readFileSync(corrFile);
  fs.unlinkSync(corrFile);

  assert.throws(
    () =>
      correctApprovalProvenance(
        stateDir,
        "correction-test",
        corrected.state.revision,
        correctionInput,
      ),
    /Missing correction event file for duplicate check/,
    "Failed to throw when correction event file is missing",
  );

  // Restore file
  fs.writeFileSync(corrFile, corrFileBackup);

  const attBody = readJSON(attFile);
  assert.strictEqual(attBody.type, "approval-attestation-recorded");
  assert.strictEqual(attBody.correctionEventId, "correction-1");
  assert.strictEqual(attBody.approvalTime, "2026-09-30T10:00:00Z");

  const corrBody = readJSON(corrFile);
  assert.strictEqual(corrBody.type, "approval-provenance-corrected");
  assert.strictEqual(corrBody.targetEventId, targetEventId);
  assert.strictEqual(corrBody.wrongApprovedBy, "user");
  assert.strictEqual(corrBody.attestationEventId, "correction-1-att");
});

test("correctApprovalProvenance works on legacy state missing approvalCorrections array", async (t) => {
  const dir = await repo(t);
  const stateDir = path.join(dir, ".omt");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".omt/\\n");
  writeJSON(path.join(dir, "task-b.json"), task("task-b"));

  const request = {
    schemaVersion: 1,
    id: "legacy-test",
    goal: "Test",
    repo: ".",
    tasks: [{ file: "task-b.json", role: "worker" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 1, maxCalls: 16 },
  };

  const initial = await createWorkflow(stateDir, request, organization, dir);

  // Simulate legacy state missing approvalCorrections entirely
  const { state, dir: wDir } = readWorkflow(stateDir, "legacy-test");
  delete state.approvalCorrections;

  // Manually add an allowance event to legacy state
  reserveExecution(stateDir, "legacy-test", state.revision, {
    schemaVersion: 1,
    eventId: "exec-1",
    taskId: "task-b",
    attemptId: "attempt-1",
    callAllowance: 1,
  });

  const increased = increaseCallAllowance(
    stateDir,
    "legacy-test",
    state.revision + 1,
    {
      schemaVersion: 1,
      eventId: "legacy-target",
      taskId: "task-b",
      attemptId: "attempt-1",
      allowance: 2,
      approvedBy: "user",
      reason: "Increase",
    },
  );

  // Ensure we really start with undefined approvalCorrections
  const preState = readWorkflow(stateDir, "legacy-test").state;
  assert.strictEqual(preState.approvalCorrections, undefined);

  const correctionInput = {
    schemaVersion: 1,
    eventId: "corr-legacy-1",
    targetEventId: "legacy-target",
    wrongApprovedBy: "user",
    attestation: "Legacy attestation",
    approvedBy: "pm",
    approvalTime: "2026-09-30T10:00:00Z",
    sourceContext: "Slack",
  };

  const corrected = correctApprovalProvenance(
    stateDir,
    "legacy-test",
    increased.state.revision,
    correctionInput,
  );
  assert.strictEqual(corrected.state.approvalCorrections.length, 1);
});

test("workflow-approval-correction executes successfully via CLI", async (t) => {
  const dir = await repo(t);
  const stateDir = path.join(dir, ".omt");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".omt/\\n");
  writeJSON(path.join(dir, "task-c.json"), task("task-c"));

  const request = {
    schemaVersion: 1,
    id: "cli-test",
    goal: "Test CLI",
    repo: ".",
    tasks: [{ file: "task-c.json", role: "worker" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 1, maxCalls: 16 },
  };

  const initial = await createWorkflow(stateDir, request, organization, dir);

  reserveExecution(stateDir, "cli-test", initial.revision, {
    schemaVersion: 1,
    eventId: "exec-1",
    taskId: "task-c",
    attemptId: "attempt-1",
    callAllowance: 1,
  });

  const increased = increaseCallAllowance(
    stateDir,
    "cli-test",
    initial.revision + 1,
    {
      schemaVersion: 1,
      eventId: "cli-target",
      taskId: "task-c",
      attemptId: "attempt-1",
      allowance: 2,
      approvedBy: "user",
      reason: "Increase",
    },
  );

  const correctionInput = {
    schemaVersion: 1,
    eventId: "cli-corr-1",
    targetEventId: "cli-target",
    wrongApprovedBy: "user",
    attestation: "CLI attestation",
    approvedBy: "pm",
    approvalTime: "2026-09-30T10:00:00Z",
    sourceContext: "Slack DM",
  };

  const correctionFile = path.join(dir, "correction.json");
  writeJSON(correctionFile, correctionInput);

  // Run the CLI
  const cliPath = path.join(
    process.cwd(),
    "plugins/oh-my-teams/scripts/teams-org.mjs",
  );

  execFileSync(process.execPath, [
    cliPath,
    "workflow-approval-correction",
    "--id",
    "cli-test",
    "--state",
    stateDir,
    "--revision",
    String(increased.state.revision),
    "--correction",
    correctionFile,
  ]);

  const { state } = readWorkflow(stateDir, "cli-test");
  assert.strictEqual(state.approvalCorrections.length, 1);
  assert.strictEqual(state.approvalCorrections[0].targetEventId, "cli-target");

  // Verify two events are recorded
  const eventPath = path.join(stateDir, "workflows", "cli-test", "events");
  const events = fs
    .readdirSync(eventPath)
    .filter((f) => f.endsWith(".json") && f.includes("cli-corr-1"));
  assert.strictEqual(
    events.length,
    2,
    "Must record exactly two events for the correction",
  );

  const hasAttestation = events.some(
    (f) =>
      readJSON(path.join(eventPath, f)).type ===
      "approval-attestation-recorded",
  );
  const hasCorrection = events.some(
    (f) =>
      readJSON(path.join(eventPath, f)).type ===
      "approval-provenance-corrected",
  );

  assert.strictEqual(hasAttestation, true, "Missing attestation event");
  assert.strictEqual(hasCorrection, true, "Missing correction event");
});
