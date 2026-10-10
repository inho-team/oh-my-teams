/**
 * Tests for document event core automation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

import { readJSON, writeJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  buildDocId,
  buildDocRef,
  saveDocument,
} from "../plugins/oh-my-teams/scripts/documents.mjs";
import {
  kickoffHashFor,
  registerKickoff,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";

import { minimalRequirements } from "./requirements-draft-fixture.mjs";

const exampleOrgPath = path.join(
  process.cwd(),
  "plugins",
  "oh-my-teams",
  "examples",
  "organization.json",
);

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omt-event-test-"));
}

function createProjectStructure(tempDir, worktreeId) {
  const projectDir = tempDir;
  const orgDir = path.join(projectDir, ".omt");
  fs.mkdirSync(orgDir, { recursive: true });

  const orgFile = path.join(orgDir, "organization.json");
  fs.copyFileSync(exampleOrgPath, orgFile);

  const org = readJSON(orgFile);
  org.documentSystemActivatedAt = new Date().toISOString();
  fs.writeFileSync(orgFile, JSON.stringify(org, null, 2));

  const gitOptions = { cwd: projectDir, stdio: "ignore" };
  execFileSync("git", ["init"], gitOptions);
  execFileSync("git", ["config", "user.name", "Test User"], gitOptions);
  execFileSync("git", ["config", "user.email", "test@example.com"], gitOptions);
  execFileSync(
    "git",
    ["commit", "--allow-empty", "-m", "Initial commit"],
    gitOptions,
  );

  const briefFile = path.join(projectDir, "brief.md");
  fs.writeFileSync(briefFile, "# Test Brief\n");

  const pmDir = path.join(projectDir, "pm-wt");
  fs.mkdirSync(pmDir, { recursive: true });

  const stateDir = path.join(orgDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });

  return { orgFile, org, orgDir, briefFile, pmDir, stateDir, projectDir };
}

function createKickoffRequest(
  worktreeId,
  briefFile,
  pmDir,
  revision,
  stateDir,
) {
  const projectDir = path.dirname(briefFile);
  const orgFile = path.join(projectDir, ".omt", "organization.json");
  return {
    goal: "Test kickoff",
    pm: {
      worktreeId,
      path: pmDir,
      ...(stateDir ? { stateDir } : {}),
    },
    organizationRevision: revision,
    brief: briefFile,
    requirements: minimalRequirements(orgFile, worktreeId),
    director: {
      terminalHandle: `term_director_${worktreeId}`,
      checkoutPath: projectDir,
    },
    delivery: {
      mode: "local-merge",
      branch: "main",
    },
  };
}

function createTestDocument(
  kickoffId,
  stageSlug,
  docType,
  localId,
  author,
  workflowId = null,
) {
  return {
    schemaVersion: 1,
    docId: buildDocId({
      kickoffHash: kickoffId,
      workflowId,
      stageSlug,
      docType,
      localId,
    }),
    stage: stageSlug,
    kickoffId,
    workflowId,
    revision: 1,
    state: "open",
    author,
    createdAt: new Date().toISOString(),
    basedOnRevision: null,
    reason: "test document creation",
  };
}

test("이벤트_기록", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-events",
    );

    const request = createKickoffRequest(
      "test-wt-events",
      briefFile,
      pmDir,
      org.revision,
    );
    const { entry } = registerKickoff(orgFile, request);
    const kickoffId = kickoffHashFor(entry);

    const doc = createTestDocument(
      kickoffId,
      "planning",
      "kickoff-brief-ref",
      "entry-1",
      { role: "director", executionId: "alice-exec-1" },
    );
    doc.briefPath = briefFile;
    doc.acceptanceSummary = "test acceptance";
    doc.nonGoals = [];
    doc.constraints = [];
    doc.kickoffEntryRef = entry.kickoffId;

    // 1. Revision 1 저장 시 document.created 발생 확인
    const r1 = saveDocument(stateDir, doc);
    assert.equal(r1.revision, 1);

    const eventsDir = path.join(stateDir, "documents", kickoffId, "events");
    const undeliveredDir = path.join(eventsDir, "undelivered");

    let events = fs.readdirSync(eventsDir).filter((f) => f.endsWith(".json"));
    assert.equal(events.length, 1);
    const createdEvent = readJSON(path.join(eventsDir, events[0]));
    assert.equal(createdEvent.type, "document.created");
    assert.equal(createdEvent.schemaVersion, 1);
    assert.equal(createdEvent.docId, doc.docId);
    assert.equal(createdEvent.state, "open");

    const createdUndelivered = readJSON(path.join(undeliveredDir, events[0]));
    assert.deepEqual(createdUndelivered, createdEvent);

    // 2. Revision 2 저장 시 document.revised 발생 확인
    doc.revision = 2;
    doc.basedOnRevision = 1;
    doc.reason = "update";
    const r2 = saveDocument(stateDir, doc, { expectedRevision: 1 });
    assert.equal(r2.revision, 2);

    events = fs.readdirSync(eventsDir).filter((f) => f.endsWith(".json"));
    assert.equal(events.length, 2); // 1 created, 1 revised
    const revisedEventFile = events.find((f) => {
      const e = readJSON(path.join(eventsDir, f));
      return e.type === "document.revised";
    });
    const revisedEvent = readJSON(path.join(eventsDir, revisedEventFile));
    assert.equal(revisedEvent.priorRevision, 1);
    assert.equal(revisedEvent.revisionRef, buildDocRef(doc.docId, 2));

    // 3. 상태 변경 저장 시 document.state-changed 발생 확인
    doc.revision = 3;
    doc.basedOnRevision = 2;
    doc.state = "resolved";
    const r3 = saveDocument(stateDir, doc, { expectedRevision: 2 });
    assert.equal(r3.revision, 3);

    events = fs.readdirSync(eventsDir).filter((f) => f.endsWith(".json"));
    assert.equal(events.length, 4);
    const stateChangedEventFile = events.find((f) => {
      const e = readJSON(path.join(eventsDir, f));
      return e.type === "document.state-changed";
    });
    const stateChangedEvent = readJSON(
      path.join(eventsDir, stateChangedEventFile),
    );
    assert.equal(stateChangedEvent.priorState, "open");
    assert.equal(stateChangedEvent.newState, "resolved");

    // 4. task-comment 저장 시 task-comment 거부 발생 확인
    const commentDoc = createTestDocument(
      kickoffId,
      "implementation",
      "task-comment",
      "comment-1",
      { role: "pm", executionId: "pm-1" },
      null,
    );
    commentDoc.taskId = "task-xyz";
    assert.throws(
      () => saveDocument(stateDir, commentDoc),
      /task-comment documents are explicitly rejected/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("이벤트_중복소비방지 (kickoff-scoped)", async () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-dedup-ko",
    );
    const request = createKickoffRequest(
      "test-wt-dedup-ko",
      briefFile,
      pmDir,
      org.revision,
      stateDir,
    );
    const { entry } = registerKickoff(orgFile, request);
    const kickoffId = kickoffHashFor(entry);

    const event = {
      id: "12345678-1234-1234-1234-1234567890ab",
      recordedAt: new Date().toISOString(),
      author: { role: "pm", executionId: "pm-1" },
      docId: buildDocId({
        kickoffHash: kickoffId,
        workflowId: null,
        stageSlug: "planning",
        docType: "kickoff-brief-ref",
        localId: "doc-ko-1",
      }),
      schemaVersion: 1,
      type: "document.created",
      kickoffId,
      workflowId: null,
    };

    const eventFile = path.join(tempDir, "event.json");
    writeJSON(eventFile, event);

    const { executeCommand } =
      await import("../plugins/oh-my-teams/scripts/teams-org.mjs");

    const rc1 = await executeCommand({
      command: "doc-event-consume",
      state: stateDir,
      event: eventFile,
    });
    assert.equal(rc1, true, "First consumption must return true");

    const rc2 = await executeCommand({
      command: "doc-event-consume",
      state: stateDir,
      event: eventFile,
    });
    assert.equal(rc2, false, "Second consumption must return false");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("이벤트_중복소비방지 (workflow-scoped)", async () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-dedup-wf",
    );
    const request = createKickoffRequest(
      "test-wt-dedup-wf",
      briefFile,
      pmDir,
      org.revision,
      stateDir,
    );
    const { entry } = registerKickoff(orgFile, request);
    const kickoffId = kickoffHashFor(entry);

    const exampleTask = readJSON(
      path.join(
        process.cwd(),
        "plugins",
        "oh-my-teams",
        "examples",
        "task.v2.json",
      ),
    );
    const taskFile = path.join(pmDir, "task-1.json");
    exampleTask.id = "task-1";
    exampleTask.baseRef = "HEAD";
    writeJSON(taskFile, exampleTask);

    const wfRequest = {
      schemaVersion: 1,
      id: "wf-1",
      goal: "Test workflow",
      repo: pmDir,
      tasks: [{ file: taskFile, role: "worker" }],
      policy: { maxRunning: 1, maxReviewPending: 1 },
      budget: { maxAttempts: 1, maxCalls: 1 },
    };
    const wfRequestFile = path.join(tempDir, "workflow.json");
    writeJSON(wfRequestFile, wfRequest);

    const { executeCommand } =
      await import("../plugins/oh-my-teams/scripts/teams-org.mjs");

    await executeCommand({
      command: "workflow-create",
      state: stateDir,
      workflow: wfRequestFile,
      org: orgFile,
    });
    const workflowStateFile = path.join(
      stateDir,
      "workflows",
      "wf-1",
      "state.json",
    );
    const priorEventIds = readJSON(workflowStateFile).eventIds;

    const event = {
      id: "12345678-1234-1234-1234-1234567890ab",
      recordedAt: new Date().toISOString(),
      author: { role: "pm", executionId: "pm-1" },
      docId: buildDocId({
        kickoffHash: kickoffId,
        workflowId: "wf-1",
        stageSlug: "planning",
        docType: "kickoff-brief-ref",
        localId: "doc-wf-1",
      }),
      schemaVersion: 1,
      type: "document.created",
      kickoffId,
      workflowId: "wf-1",
    };
    const eventFile = path.join(tempDir, "event.json");
    writeJSON(eventFile, event);

    const rc1 = await executeCommand({
      command: "doc-event-consume",
      state: stateDir,
      event: eventFile,
    });
    assert.equal(rc1, true, "First consumption must return true");
    const storedEvent = path.join(
      stateDir,
      "workflows",
      "wf-1",
      "events",
      `${String(priorEventIds.length + 1).padStart(6, "0")}-${event.id}.json`,
    );
    assert.equal(fs.existsSync(storedEvent), true);
    assert.deepEqual(readJSON(workflowStateFile).eventIds, [
      ...priorEventIds,
      event.id,
    ]);

    const rc2 = await executeCommand({
      command: "doc-event-consume",
      state: stateDir,
      event: eventFile,
    });
    assert.equal(rc2, false, "Second consumption must return false");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("저장_거부_및_요청ID_재시도", () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-retry",
    );
    const request = createKickoffRequest(
      "test-wt-retry",
      briefFile,
      pmDir,
      org.revision,
      stateDir,
    );
    const { entry } = registerKickoff(orgFile, request);
    const kickoffId = kickoffHashFor(entry);

    const doc = createTestDocument(
      kickoffId,
      "planning",
      "kickoff-brief-ref",
      "entry-retry",
      { role: "director", executionId: "alice" },
    );
    doc.briefPath = briefFile;
    doc.acceptanceSummary = "test";
    doc.nonGoals = [];
    doc.constraints = [];
    doc.kickoffEntryRef = entry.kickoffId;

    // 1. Initial save with requestId
    const requestId = "req-123";
    const r1 = saveDocument(stateDir, doc, { requestId });
    assert.equal(r1.revision, 1);

    // 2. Duplicate retry with same requestId should return immediately
    doc.acceptanceSummary = "this should not be saved";
    const r2 = saveDocument(stateDir, doc, { requestId });
    assert.equal(r2.revision, 1);
    assert.equal(r2.hash, r1.hash);

    // 3. Reject on expectedRevision mismatch
    doc.revision = 2;
    doc.basedOnRevision = 1;
    assert.throws(
      () => saveDocument(stateDir, doc, { expectedRevision: 0 }),
      /Document changed; current revision is 1/,
    );

    // 4. Successful update with new requestId
    const r3 = saveDocument(stateDir, doc, {
      expectedRevision: 1,
      requestId: "req-456",
    });
    assert.equal(r3.revision, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("이벤트_스키마_검증_및_필수필드", async () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-schema",
    );
    const request = createKickoffRequest(
      "test-wt-schema",
      briefFile,
      pmDir,
      org.revision,
      stateDir,
    );
    const { entry } = registerKickoff(orgFile, request);
    const kickoffId = kickoffHashFor(entry);

    // 1. Missing author fields
    const event1 = {
      id: "12345678-1234-1234-1234-1234567890ab",
      recordedAt: new Date().toISOString(),
      docId: "doc-1",
      schemaVersion: 1,
      type: "document.created",
      kickoffId,
      workflowId: null,
    };

    const { executeCommand } =
      await import("../plugins/oh-my-teams/scripts/teams-org.mjs");

    const eventFile = path.join(tempDir, "event.json");
    writeJSON(eventFile, event1);

    await assert.rejects(
      executeCommand({
        command: "doc-event-consume",
        state: stateDir,
        event: eventFile,
      }),
      /Event missing required field: author/,
    );

    // 2. Schema mismatch
    const event2 = {
      id: "12345678-1234-1234-1234-1234567890ab",
      recordedAt: new Date().toISOString(),
      author: { role: "pm", executionId: "pm-1" },
      docId: "doc-1",
      schemaVersion: 1,
      type: "document.created",
      kickoffId,
      workflowId: null,
      causality: 123, // Mismatch! Should be string or null
    };
    writeJSON(eventFile, event2);

    await assert.rejects(
      executeCommand({
        command: "doc-event-consume",
        state: stateDir,
        event: eventFile,
      }),
      /Field causality has invalid type integer/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("저널_복구_eventFile만_존재시_undelivered큐_복원", async () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, org, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "test-wt-journal-recovery",
    );
    const request = createKickoffRequest(
      "test-wt-journal-recovery",
      briefFile,
      pmDir,
      org.revision,
      stateDir,
    );
    const { entry } = registerKickoff(orgFile, request);
    const kickoffId = kickoffHashFor(entry);

    const doc = createTestDocument(
      kickoffId,
      "planning",
      "kickoff-brief-ref",
      "entry-journal",
      { role: "director", executionId: "alice" },
    );
    doc.briefPath = briefFile;
    doc.acceptanceSummary = "test";
    doc.nonGoals = [];
    doc.constraints = [];
    doc.kickoffEntryRef = entry.kickoffId;

    const key = `planning-kickoff-brief-ref-entry-journal`;
    const directory = path.join(
      stateDir,
      "documents",
      kickoffId,
      "none",
      "01. 기획",
      "kickoff-brief-ref",
      "entry-journal",
    );
    fs.mkdirSync(path.join(directory, "revisions"), { recursive: true });

    const revisionFile = path.join(directory, "revisions", "1.json");
    const currentFile = path.join(directory, "current.json");
    const eventsDir = path.join(stateDir, "documents", kickoffId, "events");
    const undeliveredDir = path.join(eventsDir, "undelivered");

    const event = { id: "evt-123", type: "document.created", docId: doc.docId };
    const transaction = {
      revisionFile,
      doc,
      currentFile,
      current: { revision: 1, requestId: null },
      events: [event],
    };

    const journalFile = path.join(
      stateDir,
      "documents",
      kickoffId,
      "transactions",
      `${key}.json`,
    );
    fs.mkdirSync(path.dirname(journalFile), { recursive: true });
    writeJSON(journalFile, transaction);

    fs.mkdirSync(eventsDir, { recursive: true });
    writeJSON(path.join(eventsDir, "evt-123.json"), event);

    // Trigger recovery by reading the document state
    const { documentState } =
      await import("../plugins/oh-my-teams/scripts/documents.mjs");
    documentState(stateDir, doc.docId);
    assert.equal(
      fs.existsSync(path.join(undeliveredDir, "evt-123.json")),
      true,
    );

    const recoveredEvent = readJSON(path.join(undeliveredDir, "evt-123.json"));
    assert.equal(recoveredEvent.id, "evt-123");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

import { deliverUndeliveredEvents } from "../plugins/oh-my-teams/scripts/document-event-delivery.mjs";
import { run as runOrcaCommand } from "../plugins/oh-my-teams/scripts/core.mjs";
import { resolveRoleLaunch } from "../plugins/oh-my-teams/scripts/role-launch.mjs";
import { createWorkflow } from "../plugins/oh-my-teams/scripts/workflow.mjs";
import { readWorkflowSnapshot } from "../plugins/oh-my-teams/scripts/workflow-store.mjs";

test("doc-event-consume CLI 명령어 호출 (긍정 및 거부)", async () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "cli-consume",
    );
    const { entry } = registerKickoff(
      orgFile,
      createKickoffRequest("cli-consume", briefFile, pmDir, 1, stateDir),
    );
    const kickoffId = kickoffHashFor(entry);

    const docId = buildDocId({
      kickoffHash: kickoffId,
      workflowId: null,
      stageSlug: "planning",
      docType: "kickoff-brief-ref",
      localId: "test",
    });
    const event = {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      type: "document.created",
      kickoffId,
      workflowId: null,
      docId,
      recordedAt: new Date().toISOString(),
      author: { role: "director", executionId: "e1" },
    };

    const cli = path.join(
      process.cwd(),
      "plugins",
      "oh-my-teams",
      "scripts",
      "teams-org.mjs",
    );
    const consume = () =>
      execFileSync(
        process.execPath,
        [cli, "doc-event-consume", "--state", stateDir, "--event", eventFile],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim();

    // Positive
    const eventFile = path.join(tempDir, "event.json");
    writeJSON(eventFile, event);
    assert.equal(consume(), "true");

    // Duplicate
    assert.equal(consume(), "false");

    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            cli,
            "doc-event-deliver",
            "--state",
            stateDir,
            "--kickoff-hash",
            kickoffId,
          ],
          {
            cwd: process.cwd(),
            env: { ...process.env, ORCA_TERMINAL_HANDLE: "" },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
      /--actor required/,
    );

    // Cross-scope rejection
    const event2 = {
      ...event,
      id: crypto.randomUUID(),
      kickoffId: "invalid-kickoff",
    };
    writeJSON(eventFile, event2);
    assert.throws(consume, /Cross-scope event/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("task-comment 문서 CLI 거부 및 부작용 없음", async () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "tc-reject",
    );
    const { entry } = registerKickoff(
      orgFile,
      createKickoffRequest("tc-reject", briefFile, pmDir, 1, stateDir),
    );
    const kickoffId = kickoffHashFor(entry);

    const docId = buildDocId({
      kickoffHash: kickoffId,
      workflowId: null,
      stageSlug: "planning",
      docType: "task-comment",
      localId: "test",
    });
    const doc = {
      schemaVersion: 1,
      docId,
      kickoffId,
      workflowId: null,
      stage: "planning",
      state: "open",
      revision: 1,
      basedOnRevision: null,
      reason: "test",
      author: { role: "director", executionId: "e1" },
      createdAt: new Date().toISOString(),
    };
    const docFile = path.join(tempDir, "doc.json");
    writeJSON(docFile, doc);

    const { executeCommand } =
      await import("../plugins/oh-my-teams/scripts/teams-org.mjs");
    await assert.rejects(
      executeCommand({
        command: "doc-save",
        state: stateDir,
        doc: docFile,
        org: orgFile,
      }),
      /task-comment documents are explicitly rejected/,
    );

    const docDir = path.join(
      stateDir,
      "documents",
      kickoffId,
      "planning",
      "task-comment",
      "test",
    );
    assert.equal(fs.existsSync(docDir), false, "No side effects should occur");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("수신확인 실패 시 큐 유지 및 재시도 시 재전송 방지", async () => {
  const tempDir = makeTempDir();
  try {
    const { orgFile, stateDir, briefFile, pmDir } = createProjectStructure(
      tempDir,
      "delivery-fault",
    );
    const { entry } = registerKickoff(
      orgFile,
      createKickoffRequest("delivery-fault", briefFile, pmDir, 1, stateDir),
    );
    const kickoffId = kickoffHashFor(entry);

    const doc = createTestDocument(
      kickoffId,
      "planning",
      "kickoff-brief-ref",
      "delivery-test",
      { role: "director", executionId: "e1" },
    );
    doc.briefPath = "test";
    doc.acceptanceSummary = "";
    doc.nonGoals = [];
    doc.constraints = [];
    doc.kickoffEntryRef = kickoffId;
    saveDocument(stateDir, doc);

    let deliveryCount = 0;
    const deliverFn = async (ev) => {
      deliveryCount++;
    };

    // Fault injection: throw when writing receipt
    const originalWriteFileSync = fs.writeFileSync;
    let faultInjected = true;
    fs.writeFileSync = (p, d, o) => {
      if (faultInjected && typeof p === "string" && p.includes("delivered")) {
        throw new Error("Fault injected");
      }
      return originalWriteFileSync(p, d, o);
    };

    try {
      const { deliverUndeliveredEvents: testDeliver } =
        await import("../plugins/oh-my-teams/scripts/document-event-delivery.mjs");

      // First attempt fails during receipt write
      await assert.rejects(
        testDeliver(stateDir, kickoffId, null, deliverFn, {
          runId: "r1",
          terminalId: "t1",
        }),
        /Fault injected/,
      );
      assert.equal(deliveryCount, 1);

      // Read the actual event file before second attempt deletes it
      const undeliveredDir = path.join(
        stateDir,
        "documents",
        kickoffId,
        "events",
        "undelivered",
      );
      const eventFile = fs.readdirSync(undeliveredDir)[0];
      const originalEventContent = fs.readFileSync(
        path.join(undeliveredDir, eventFile),
      );

      // Second attempt succeeds
      faultInjected = false;
      await testDeliver(stateDir, kickoffId, null, deliverFn, {
        runId: "r1",
        terminalId: "t1",
      });
      assert.equal(deliveryCount, 2);
      assert.equal(
        fs.readdirSync(undeliveredDir).length,
        0,
        "Queue must be cleared on success",
      );

      // Third attempt (post-receipt) does not resend
      // Manually put the event back in undelivered to simulate pre-receipt crash replay
      fs.writeFileSync(
        path.join(undeliveredDir, eventFile),
        originalEventContent,
      );

      await testDeliver(stateDir, kickoffId, null, deliverFn, {
        runId: "r1",
        terminalId: "t1",
      });
      assert.equal(deliveryCount, 2, "Does not resend if receipt exists");
      assert.equal(
        fs.readdirSync(undeliveredDir).length,
        0,
        "Deletes duplicate queue file",
      );
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
