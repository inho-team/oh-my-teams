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
import { readJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import { resolveKickoffHash } from "../plugins/oh-my-teams/scripts/documents.mjs";
import { registerKickoff } from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";
import { minimalRequirements } from "./requirements-draft-fixture.mjs";
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
  const { execFileSync, execSync } = await import("node:child_process");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "work-items-cli-test-"));
  const projectDir = path.join(tmpDir, "project");
  const pmDir = path.join(tmpDir, "pm");
  const stateDir = path.join(pmDir, ".omt");
  const orgFile = path.join(projectDir, ".omt", "organization.json");
  const brief = path.join(tmpDir, "brief.md");
  fs.mkdirSync(projectDir);
  execFileSync("git", ["init", projectDir]);
  execFileSync("git", [
    "-C",
    projectDir,
    "config",
    "user.name",
    "Work Item Test",
  ]);
  execFileSync("git", [
    "-C",
    projectDir,
    "config",
    "user.email",
    "work-item@example.invalid",
  ]);
  fs.writeFileSync(path.join(projectDir, "seed.txt"), "seed\n");
  execFileSync("git", ["-C", projectDir, "add", "seed.txt"]);
  execFileSync("git", ["-C", projectDir, "commit", "-m", "seed"]);
  execFileSync("git", ["-C", projectDir, "worktree", "add", "--detach", pmDir]);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.dirname(orgFile), { recursive: true });
  fs.copyFileSync(
    path.resolve("plugins/oh-my-teams/examples/organization.json"),
    orgFile,
  );
  fs.writeFileSync(brief, "Work-item CLI test brief\n");

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const worktreeId = "work-item-cli-pm";
  registerKickoff(orgFile, {
    goal: "Test work-item CLI scope",
    pm: { worktreeId, path: pmDir, stateDir },
    organizationRevision: readJSON(orgFile).revision,
    brief,
    delivery: { mode: "none" },
    requirements: minimalRequirements(orgFile, worktreeId),
    director: {
      terminalHandle: "term_director_work_item_cli",
      checkoutPath: pmDir,
    },
  });
  const kickoffId = resolveKickoffHash(orgFile, worktreeId);
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
  const listCommand = `node "${scriptPath}" work-item-list`;
  const resultStr = execSync(
    `${listCommand} --state "${stateDir}" --kickoff-id "${kickoffId}" --workflow-id "${workflowId}"`,
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
    `${listCommand} --state "${stateDir}" --kickoff-id "${kickoffId}" --workflow-id "${workflowId}" --title "Another"`,
    { encoding: "utf8" },
  );
  const titleResult = JSON.parse(titleResultStr);
  assert.strictEqual(titleResult.length, 1);
  assert.strictEqual(titleResult[0].title, "Another Task");

  const stateResultStr = execSync(
    `${listCommand} --state "${stateDir}" --kickoff-id "${kickoffId}" --workflow-id "${workflowId}" --doc-state "resolved"`,
    { encoding: "utf8" },
  );
  const stateResult = JSON.parse(stateResultStr);
  assert.strictEqual(stateResult.length, 1);
  assert.strictEqual(stateResult[0].title, "Another Task");

  const assigneeResultStr = execSync(
    `${listCommand} --state "${stateDir}" --kickoff-id "${kickoffId}" --workflow-id "${workflowId}" --assignee "worker-1"`,
    { encoding: "utf8" },
  );
  const assigneeResult = JSON.parse(assigneeResultStr);
  assert.strictEqual(assigneeResult.length, 1);
  assert.strictEqual(assigneeResult[0].title, "Another Task");

  const emptyResultStr = execSync(
    `${listCommand} --state "${stateDir}" --kickoff-id "${kickoffId}" --workflow-id "${workflowId}" --title "Not Found"`,
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
            `${listCommand} --state "${stateDir}" --kickoff-id "../invalid" --workflow-id "${workflowId}"`,
            { stdio: "pipe" },
          ),
        /kickoffHash must be a 64-character hex string/,
      );
      assert.throws(
        () =>
          execSync(
            `${listCommand} --state "${stateDir}" --kickoff-id "${kickoffId}" --workflow-id "../invalid"`,
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

      saveWorkItem(stateDir, docOther);
      const snapshot = () =>
        fs
          .readdirSync(stateDir, { recursive: true })
          .sort()
          .filter((entry) => fs.statSync(path.join(stateDir, entry)).isFile())
          .map((entry) => [
            entry,
            fs.readFileSync(path.join(stateDir, entry), "utf8"),
          ]);
      const beforeRejectedList = snapshot();
      assert.throws(
        () =>
          execSync(
            `${listCommand} --state "${stateDir}" --kickoff-id "${otherKickoff}" --workflow-id "${workflowId}"`,
            { stdio: "pipe" },
          ),
        /kickoff-id does not match the kickoff registered for state/,
      );
      const alternateOrg = path.join(tmpDir, "alternate", "organization.json");
      fs.mkdirSync(path.dirname(alternateOrg), { recursive: true });
      fs.copyFileSync(orgFile, alternateOrg);
      assert.throws(
        () =>
          execSync(
            `${listCommand} --state "${stateDir}" --kickoff-id "${otherKickoff}" --workflow-id "${workflowId}" --org "${alternateOrg}"`,
            { stdio: "pipe" },
          ),
        /Unknown option: --org/,
      );
      assert.deepStrictEqual(snapshot(), beforeRejectedList);

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
