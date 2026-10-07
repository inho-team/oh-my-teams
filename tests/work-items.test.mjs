/**
 * @module
 * Tests for work item management.
 */
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  saveWorkItem,
  getDocumentContent,
  listWorkItems,
} from "../plugins/oh-my-teams/scripts/work-items.mjs";

test("work-items module", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "work-items-test-"));
  const stateDir = path.join(tmpDir, ".omt");
  fs.mkdirSync(stateDir);

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const kickoffId = crypto.randomBytes(32).toString("hex");
  const workflowId = "test-workflow";

  await t.test("saveWorkItem creates and lists work items", () => {
    const docId = `${kickoffId}/${workflowId}/implementation/work-item/task-1`;
    const wfDir = path.join(stateDir, "workflows", workflowId);
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(
      path.join(wfDir, "state.json"),
      JSON.stringify({
        tasks: {
          "task-1": {
            role: "worker",
            execution: { executionId: "exec-worker-1" },
          },
        },
      }),
    );
    const doc = {
      schemaVersion: 1,
      docId,
      stage: "implementation",
      kickoffId,
      workflowId,
      revision: 1,
      state: "open",
      author: { role: "pm", executionId: "exec-1" },
      createdAt: new Date().toISOString(),
      basedOnRevision: null,
      reason: "Initial creation",
      title: "Test Task",
      description: "Test description",
      assignees: ["worker-1"],
      targetDate: null,
      documentRefs: [],
    };

    const result = saveWorkItem(stateDir, doc);
    assert.strictEqual(result.docId, docId);
    assert.strictEqual(result.revision, 1);

    const saved = getDocumentContent(stateDir, docId);
    assert.strictEqual(saved.title, "Test Task");

    const list = listWorkItems(stateDir, kickoffId, workflowId);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].title, "Test Task");
  });

  await t.test(
    "saveWorkItem rejects schema errors and leaves no events",
    () => {
      const docId = `${kickoffId}/${workflowId}/implementation/work-item/task-schema-err`;
      const doc = {
        schemaVersion: 1,
        docId,
        stage: "implementation",
        kickoffId,
        workflowId,
        revision: 1,
        state: "open",
        author: { role: "invalid-role", executionId: "exec-1" },
        createdAt: new Date().toISOString(),
        basedOnRevision: null,
        reason: "Invalid creation",
        title: 123, // Invalid type
        description: "Test description",
        assignees: [123], // Invalid item type
        body: 123, // Invalid additional property/type
        targetDate: null,
        documentRefs: [],
      };

      const eventsDir = path.join(stateDir, "workflows", workflowId, "events");
      let eventCountBefore = 0;
      if (fs.existsSync(eventsDir)) {
        eventCountBefore = fs.readdirSync(eventsDir).length;
      }

      assert.throws(
        () => saveWorkItem(stateDir, doc),
        /invalid type|additional property|must be one of/i,
      );

      // Check missing title specifically to ensure robust tests
      const docMissingTitle = {
        ...doc,
        title: undefined,
        assignees: [],
        author: { role: "pm", executionId: "exec-1" },
      };
      delete docMissingTitle.body;
      assert.throws(
        () => saveWorkItem(stateDir, docMissingTitle),
        /missing required field: title/i,
      );

      let eventCountAfter = 0;
      if (fs.existsSync(eventsDir)) {
        eventCountAfter = fs.readdirSync(eventsDir).length;
      }
      assert.strictEqual(
        eventCountBefore,
        eventCountAfter,
        "No new events should be generated on schema rejection",
      );
    },
  );

  await t.test(
    "saveWorkItem rejects concurrent updates/mismatched revision",
    () => {
      const docId = `${kickoffId}/${workflowId}/implementation/work-item/task-concurrent`;
      const doc1 = {
        schemaVersion: 1,
        docId,
        stage: "implementation",
        kickoffId,
        workflowId,
        revision: 1,
        state: "open",
        author: { role: "pm", executionId: "exec-1" },
        createdAt: new Date().toISOString(),
        basedOnRevision: null,
        reason: "Initial creation",
        title: "Concurrent Task",
        description: "Test description",
        assignees: [],
        targetDate: null,
        documentRefs: [],
      };

      // Save revision 1
      saveWorkItem(stateDir, doc1, { expectedRevision: 0 });

      const doc2 = {
        ...doc1,
        revision: 2,
        title: "Updated Task",
        basedOnRevision: 1,
      };

      // Try to save revision 2, but provide wrong expectedRevision
      assert.throws(
        () => saveWorkItem(stateDir, doc2, { expectedRevision: 0 }),
        /document changed|document revision/i,
      );

      // Save revision 2 with correct expectedRevision
      const result = saveWorkItem(stateDir, doc2, { expectedRevision: 1 });
      assert.strictEqual(result.revision, 2);

      // Try to save revision 2 again
      assert.throws(
        () => saveWorkItem(stateDir, doc2, { expectedRevision: 2 }),
        /document changed|document revision/i,
      );
    },
  );
});

test("work-items CLI interface", async (t) => {
  const { execSync } = await import("node:child_process");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "work-items-cli-test-"));
  const stateDir = path.join(tmpDir, ".omt");
  fs.mkdirSync(stateDir);

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const kickoffId = crypto.randomBytes(32).toString("hex");
  const workflowId = "cli-workflow";
  const docId = `${kickoffId}/${workflowId}/implementation/work-item/task-cli`;

  const wfDir = path.join(stateDir, "workflows", workflowId);
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(
    path.join(wfDir, "state.json"),
    JSON.stringify({
      tasks: {
        "task-cli": {
          role: "pm",
          execution: { executionId: "exec-pm-1" },
        },
      },
    }),
  );

  const doc = {
    schemaVersion: 1,
    docId,
    stage: "implementation",
    kickoffId,
    workflowId,
    revision: 1,
    state: "open",
    author: { role: "pm", executionId: "exec-pm-1" },
    createdAt: new Date().toISOString(),
    basedOnRevision: null,
    reason: "CLI test creation",
    title: "CLI Task",
    description: "CLI description",
    assignees: [],
    targetDate: null,
    documentRefs: [],
  };

  saveWorkItem(stateDir, doc);

  const scriptPath = path.join(
    process.cwd(),
    "plugins",
    "oh-my-teams",
    "scripts",
    "teams-org.mjs",
  );
  const resultStr = execSync(
    `node "${scriptPath}" work-item-list --state "${stateDir}" --kickoff-id "${kickoffId}" --workflow-id "${workflowId}"`,
    { encoding: "utf8" },
  );
  const result = JSON.parse(resultStr);

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].title, "CLI Task");

  // Add another task to test filtering
  const doc2Id = `${kickoffId}/${workflowId}/implementation/work-item/task-cli-2`;
  const doc2 = {
    ...doc,
    docId: doc2Id,
    title: "Another Task",
    state: "resolved",
    assignees: ["worker-1"],
  };
  saveWorkItem(stateDir, doc2);

  const titleResultStr = execSync(
    `node "${scriptPath}" work-item-list --state "${stateDir}" --kickoff-id "${kickoffId}" --workflow-id "${workflowId}" --title "Another"`,
    { encoding: "utf8" },
  );
  const titleResult = JSON.parse(titleResultStr);
  assert.strictEqual(titleResult.length, 1);
  assert.strictEqual(titleResult[0].title, "Another Task");

  const stateResultStr = execSync(
    `node "${scriptPath}" work-item-list --state "${stateDir}" --kickoff-id "${kickoffId}" --workflow-id "${workflowId}" --doc-state "resolved"`,
    { encoding: "utf8" },
  );
  const stateResult = JSON.parse(stateResultStr);
  assert.strictEqual(stateResult.length, 1);
  assert.strictEqual(stateResult[0].title, "Another Task");

  const assigneeResultStr = execSync(
    `node "${scriptPath}" work-item-list --state "${stateDir}" --kickoff-id "${kickoffId}" --workflow-id "${workflowId}" --assignee "worker-1"`,
    { encoding: "utf8" },
  );
  const assigneeResult = JSON.parse(assigneeResultStr);
  assert.strictEqual(assigneeResult.length, 1);
  assert.strictEqual(assigneeResult[0].title, "Another Task");

  const emptyResultStr = execSync(
    `node "${scriptPath}" work-item-list --state "${stateDir}" --kickoff-id "${kickoffId}" --workflow-id "${workflowId}" --title "Not Found"`,
    { encoding: "utf8" },
  );
  const emptyResult = JSON.parse(emptyResultStr);
  assert.strictEqual(emptyResult.length, 0);

  await t.test(
    "listWorkItems and CLI reject path traversal and scope mismatches",
    () => {
      assert.throws(
        () => listWorkItems(stateDir, "../invalid", workflowId),
        /kickoffHash must be a 64-character hex string/,
      );
      assert.throws(
        () => listWorkItems(stateDir, kickoffId, "../invalid"),
        /workflowId must be null or a valid id/,
      );

      assert.throws(
        () =>
          execSync(
            `node "${scriptPath}" work-item-list --state "${stateDir}" --kickoff-id "../invalid" --workflow-id "${workflowId}"`,
            { stdio: "pipe" },
          ),
        /kickoffHash must be a 64-character hex string/,
      );
      assert.throws(
        () =>
          execSync(
            `node "${scriptPath}" work-item-list --state "${stateDir}" --kickoff-id "${kickoffId}" --workflow-id "../invalid"`,
            { stdio: "pipe" },
          ),
        /workflowId must be null or a valid id/,
      );

      const otherKickoff = crypto.randomBytes(32).toString("hex");
      const otherDocId = `${otherKickoff}/${workflowId}/implementation/work-item/task-other`;
      const docOther = {
        ...doc,
        docId: otherDocId,
        kickoffId: otherKickoff,
        title: "Malicious Task",
      };

      const typeDir = path.join(
        stateDir,
        "documents",
        kickoffId,
        workflowId,
        "implementation",
        "work-item",
      );
      const localId = "task-malicious";
      fs.mkdirSync(path.join(typeDir, localId, "revisions"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(typeDir, localId, "current.json"),
        JSON.stringify({ revision: 1 }),
      );
      fs.writeFileSync(
        path.join(typeDir, localId, "revisions/1.json"),
        JSON.stringify(docOther),
      );

      const docs = listWorkItems(stateDir, kickoffId, workflowId);
      assert.ok(
        !docs.some((d) => d.title === "Malicious Task"),
        "Should reject envelope scope mismatch",
      );
    },
  );
});
