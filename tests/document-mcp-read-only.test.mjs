/**
 * @module
 * Tests for document-mcp-read-only.test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { handleCallToolRequest } from "../plugins/oh-my-teams/scripts/document-mcp.mjs";
import { writeJSON } from "../plugins/oh-my-teams/scripts/core.mjs";

test("document-mcp-read-only: direct API tests", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-mcp-test-"));
  const kickoffHash = "a".repeat(64);
  const otherKickoff = "b".repeat(64);

  try {
    // 1. Setup mock data
    const wfDir = path.join(tmpDir, "workflows", "wf-123");
    fs.mkdirSync(wfDir, { recursive: true });
    writeJSON(path.join(wfDir, "state.json"), { kickoffId: kickoffHash });

    const docDir = path.join(
      tmpDir,
      "documents",
      kickoffHash,
      "wf-123",
      "01. 기획",
      "work-item",
      "doc1",
    );
    fs.mkdirSync(path.join(docDir, "revisions"), { recursive: true });
    writeJSON(path.join(docDir, "current.json"), { revision: 1 });
    writeJSON(path.join(docDir, "revisions", "1.json"), {
      docId: `${kickoffHash}/wf-123/planning/work-item/doc1`,
      kickoffId: kickoffHash,
      workflowId: "wf-123",
      content: "Valid document",
    });

    const otherDocDir = path.join(
      tmpDir,
      "documents",
      kickoffHash,
      "none",
      "01. 기획",
      "work-item",
      "doc2",
    );
    fs.mkdirSync(path.join(otherDocDir, "revisions"), { recursive: true });
    writeJSON(path.join(otherDocDir, "current.json"), { revision: 1 });
    writeJSON(path.join(otherDocDir, "revisions", "1.json"), {
      docId: `${kickoffHash}/none/planning/work-item/doc2`,
      kickoffId: kickoffHash,
      workflowId: null,
      content: "Other document",
    });

    // Mismatched envelope document
    const mismatchDocDir = path.join(
      tmpDir,
      "documents",
      kickoffHash,
      "wf-123",
      "01. 기획",
      "work-item",
      "doc3",
    );
    fs.mkdirSync(path.join(mismatchDocDir, "revisions"), { recursive: true });
    writeJSON(path.join(mismatchDocDir, "current.json"), { revision: 1 });
    writeJSON(path.join(mismatchDocDir, "revisions", "1.json"), {
      docId: `${kickoffHash}/wf-123/planning/work-item/doc3`,
      kickoffId: otherKickoff,
      workflowId: "wf-123",
      content: "Mismatched document",
    });

    const eventsDir = path.join(wfDir, "events");
    fs.mkdirSync(eventsDir, { recursive: true });
    writeJSON(path.join(eventsDir, "evt1.json"), {
      kickoffId: kickoffHash,
      workflowId: "wf-123",
      type: "event1",
    });
    writeJSON(path.join(eventsDir, "evt2.json"), {
      kickoffId: otherKickoff,
      workflowId: "wf-123",
      type: "event2",
    }); // mismatch

    // 2. Reject write tools & unknown tools
    assert.throws(
      () => handleCallToolRequest(tmpDir, "write_document", {}),
      /forbidden or unknown/,
    );
    assert.throws(
      () => handleCallToolRequest(tmpDir, "unknown_tool", {}),
      /forbidden or unknown/,
    );

    // 3. get_document tests
    // valid
    const res1 = handleCallToolRequest(tmpDir, "get_document", {
      kickoffHash,
      workflowId: "wf-123",
      docId: `${kickoffHash}/wf-123/planning/work-item/doc1`,
    });
    assert.match(res1.content[0].text, /Valid document/);

    // invalid docId scope
    assert.throws(
      () =>
        handleCallToolRequest(tmpDir, "get_document", {
          kickoffHash: otherKickoff,
          workflowId: "wf-123",
          docId: `${kickoffHash}/wf-123/planning/work-item/doc1`,
        }),
      /Scope mismatch/,
    );

    // mismatch envelope
    assert.throws(
      () =>
        handleCallToolRequest(tmpDir, "get_document", {
          kickoffHash,
          workflowId: "wf-123",
          docId: `${kickoffHash}/wf-123/planning/work-item/doc3`,
        }),
      /Envelope mismatch/,
    );

    // 4. list_documents tests
    assert.throws(
      () =>
        handleCallToolRequest(tmpDir, "list_documents", {
          kickoffHash,
          workflowId: "wf-123",
          docType: "work-item",
        }),
      /Envelope mismatch/,
    );

    fs.rmSync(mismatchDocDir, { recursive: true, force: true });

    const listRes = handleCallToolRequest(tmpDir, "list_documents", {
      kickoffHash,
      workflowId: "wf-123",
      docType: "work-item",
    });
    const listedDocs = JSON.parse(listRes.content[0].text);
    assert.equal(listedDocs.length, 1);
    assert.equal(listedDocs[0].content, "Valid document");

    // 5. list_events tests
    assert.throws(
      () =>
        handleCallToolRequest(tmpDir, "list_events", {
          kickoffHash: otherKickoff,
          workflowId: "wf-123",
        }),
      /Workflow kickoffId mismatch/,
    ); // because wf-123 state.json says kickoffHash

    assert.throws(
      () =>
        handleCallToolRequest(tmpDir, "list_events", {
          kickoffHash,
          workflowId: "wf-123",
        }),
      /Event does not belong to the specified kickoff/,
    );

    fs.unlinkSync(path.join(eventsDir, "evt2.json"));

    const evRes = handleCallToolRequest(tmpDir, "list_events", {
      kickoffHash,
      workflowId: "wf-123",
    });
    const listedEvents = JSON.parse(evRes.content[0].text);
    assert.equal(listedEvents.length, 1);
    assert.equal(listedEvents[0].type, "event1");

    // 6. Path Traversal & Symlink Check
    const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-ext-"));
    try {
      writeJSON(path.join(extDir, "leak.json"), {
        kickoffId: kickoffHash,
        workflowId: "wf-123",
        type: "leak",
      });
      const symlinkPath = path.join(eventsDir, "symlink");
      fs.symlinkSync(extDir, symlinkPath, "dir");

      // We don't read nested dirs in list_events, but if we did, we'd want to block it.
      // But we can test list_documents traversal.
      fs.mkdirSync(path.join(extDir, "work-item"));
      const docsSymlink = path.join(
        tmpDir,
        "documents",
        kickoffHash,
        "wf-123",
        "02. design",
      );
      fs.symlinkSync(extDir, docsSymlink, "dir");

      // list_documents will throw if it tries to traverse a symlink that resolves outside stateDir
      assert.throws(() => {
        handleCallToolRequest(tmpDir, "list_documents", {
          kickoffHash,
          workflowId: "wf-123",
          docType: "work-item",
        });
      }, /Path traversal detected/);

      // 7. Regression Tests for Scope and Symlinks
      // Test missing workflowId leak in list_documents
      const noneDir = path.join(
        tmpDir,
        "documents",
        kickoffHash,
        "none",
        "01. 기획",
        "work-item",
        "doc-leak",
      );
      fs.mkdirSync(path.join(noneDir, "revisions"), { recursive: true });
      writeJSON(path.join(noneDir, "current.json"), { revision: 1 });
      writeJSON(path.join(noneDir, "revisions", "1.json"), {
        docId: `${kickoffHash}/none/planning/work-item/doc-leak`,
        kickoffId: kickoffHash,
        workflowId: "foreign-workflow",
        content: "Leak content",
      });
      assert.throws(() => {
        handleCallToolRequest(tmpDir, "list_documents", {
          kickoffHash,
          docType: "work-item",
        });
      }, /Envelope mismatch: workflowId/);

      // Test get_document symlink traversal
      const extDocDir = path.join(extDir, "doc-ext");
      fs.mkdirSync(path.join(extDocDir, "revisions"), { recursive: true });
      writeJSON(path.join(extDocDir, "current.json"), { revision: 1 });
      writeJSON(path.join(extDocDir, "revisions", "1.json"), {
        docId: `${kickoffHash}/none/planning/work-item/doc-symlink`,
        kickoffId: kickoffHash,
        workflowId: null,
        content: "Ext content",
      });
      const symDocDir = path.join(
        tmpDir,
        "documents",
        kickoffHash,
        "none",
        "01. 기획",
        "work-item",
        "doc-symlink",
      );
      fs.mkdirSync(path.dirname(symDocDir), { recursive: true });
      fs.symlinkSync(extDocDir, symDocDir, "dir");
      assert.throws(() => {
        handleCallToolRequest(tmpDir, "get_document", {
          kickoffHash,
          docId: `${kickoffHash}/none/planning/work-item/doc-symlink`,
        });
      }, /Path traversal detected/);
    } finally {
      fs.rmSync(extDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("document-mcp-read-only: stdio actual MCP check", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-mcp-stdio-"));
  try {
    const kickoffHash = "a".repeat(64);

    const docDir = path.join(
      tmpDir,
      "documents",
      kickoffHash,
      "none",
      "01. 기획",
      "work-item",
      "doc1",
    );
    fs.mkdirSync(path.join(docDir, "revisions"), { recursive: true });
    writeJSON(path.join(docDir, "current.json"), { revision: 1 });
    writeJSON(path.join(docDir, "revisions", "1.json"), {
      docId: `${kickoffHash}/none/planning/work-item/doc1`,
      kickoffId: kickoffHash,
      content: "Stdio valid",
    });

    const mcpPath = path.resolve(
      process.cwd(),
      "plugins/oh-my-teams/scripts/document-mcp.mjs",
    );
    const child = spawn("node", [mcpPath, "--state", tmpDir], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    // Buffer to handle fragmented JSON lines
    let stdoutBuffer = "";

    const request = (method, params) =>
      new Promise((resolve, reject) => {
        const id = Math.random().toString();

        const timeout = setTimeout(() => {
          child.stdout.removeListener("data", onData);
          child.on("exit", () => {});
          reject(new Error("Timeout waiting for response"));
        }, 3000);

        const onData = (data) => {
          stdoutBuffer += data.toString();
          const lines = stdoutBuffer.split("\n");
          stdoutBuffer = lines.pop(); // keep the last incomplete line

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.id === id) {
                clearTimeout(timeout);
                child.stdout.removeListener("data", onData);
                if (msg.error) reject(new Error(msg.error.message));
                else resolve(msg.result);
              }
            } catch (e) {
              // ignore parse errors for other lines
            }
          }
        };
        child.stdout.on("data", onData);

        const req = {
          jsonrpc: "2.0",
          id,
          method,
          params,
        };
        child.stdin.write(JSON.stringify(req) + "\n");
      });

    try {
      // 0. Handshake
      await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }) + "\n",
      );

      // 1. Valid tool call
      const res = await request("tools/call", {
        name: "get_document",
        arguments: {
          kickoffHash,
          docId: `${kickoffHash}/none/planning/work-item/doc1`,
        },
      });
      assert.match(res.content[0].text, /Stdio valid/);

      // 2. Reject unknown tool
      await assert.rejects(
        request("tools/call", { name: "write_document", arguments: {} }),
        /forbidden or unknown/,
      );
    } finally {
      child.kill();
      // Wait for child to exit
      await new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null)
          return resolve();
        child.on("exit", resolve);
      });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
