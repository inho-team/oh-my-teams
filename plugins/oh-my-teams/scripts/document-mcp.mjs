#!/usr/bin/env node
/**
 * Read-only MCP Server for documents, work items, and events.
 * @module document-mcp
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { getDocumentContent } from "./work-items.mjs";
import { workflowDirectory } from "./workflow-store.mjs";
import { parseDocId, stageFolderName } from "./documents.mjs";
import { readJSON } from "./core.mjs";
import { resolveRegisteredKickoffFromState } from "./kickoff-registry.mjs";

function ensureSafePath(targetPath, stateDir) {
  if (!fs.existsSync(targetPath)) return;
  const realPath = fs.realpathSync(targetPath);
  const realStateDir = fs.realpathSync(stateDir);
  if (
    !realPath.startsWith(realStateDir + path.sep) &&
    realPath !== realStateDir
  ) {
    throw new Error("Path traversal detected");
  }
}

/**
 * Handle a tool call request.
 * @param {string} stateDir - State directory.
 * @param {string} name - Tool name.
 * @param {object} args - Tool arguments.
 * @returns {object} - Tool result.
 */
export async function handleCallToolRequest(stateDir, name, args) {
  if (
    !name ||
    [
      "get_document",
      "list_documents",
      "list_events",
      "search_documents",
    ].indexOf(name) === -1
  ) {
    throw new Error(
      `Tool ${name} is forbidden or unknown. This is a read-only MCP server.`,
    );
  }

  const resolved = await resolveRegisteredKickoffFromState(stateDir);
  if (
    resolved &&
    args.kickoffHash &&
    args.kickoffHash !== resolved.kickoffHash
  ) {
    throw new Error("kickoffHash mismatch with registered kickoff");
  }

  if (name === "get_document") {
    const { kickoffHash, workflowId, docId } = args;
    if (!/^[a-f0-9]{64}$/.test(kickoffHash))
      throw new Error("Invalid kickoffHash");
    if (workflowId && !/^[a-z0-9][a-z0-9-]*$/.test(workflowId))
      throw new Error("Invalid workflowId");

    const parsed = parseDocId(docId);
    if (parsed.kickoffHash !== kickoffHash)
      throw new Error("Scope mismatch: kickoffHash");
    if (workflowId && parsed.workflowId !== workflowId)
      throw new Error("Scope mismatch: workflowId");
    if (!workflowId && parsed.workflowId !== null)
      throw new Error("Scope mismatch: workflowId");

    const folder = stageFolderName(parsed.stageSlug);
    const targetDir = path.join(
      stateDir,
      "documents",
      kickoffHash,
      parsed.workflowId ?? "none",
      folder,
      parsed.docType,
      parsed.localId,
    );
    ensureSafePath(targetDir, stateDir);

    const currentFile = path.join(targetDir, "current.json");
    if (!fs.existsSync(currentFile)) throw new Error("Document not found");
    ensureSafePath(currentFile, stateDir);
    const current = readJSON(currentFile);
    if (current.revision <= 0) throw new Error("Document not found");

    const revFile = path.join(targetDir, `revisions/${current.revision}.json`);
    if (!fs.existsSync(revFile)) throw new Error("Document not found");
    ensureSafePath(revFile, stateDir);
    const doc = readJSON(revFile);

    if (doc.kickoffId !== kickoffHash)
      throw new Error("Envelope mismatch: kickoffId");
    if (workflowId && doc.workflowId !== workflowId)
      throw new Error("Envelope mismatch: workflowId");
    if (!workflowId && doc.workflowId)
      throw new Error("Envelope mismatch: workflowId");

    return { content: [{ type: "text", text: JSON.stringify(doc, null, 2) }] };
  }

  if (name === "list_documents") {
    const { kickoffHash, workflowId, docType } = args;
    if (!/^[a-f0-9]{64}$/.test(kickoffHash))
      throw new Error("Invalid kickoffHash");
    if (workflowId && !/^[a-z0-9][a-z0-9-]*$/.test(workflowId))
      throw new Error("Invalid workflowId");
    if (!/^[\w-]+$/.test(docType)) throw new Error("Invalid docType");

    const baseDir = path.join(
      stateDir,
      "documents",
      kickoffHash,
      workflowId ?? "none",
    );
    ensureSafePath(baseDir, stateDir);

    const docs = [];
    if (fs.existsSync(baseDir)) {
      for (const stageFolder of fs.readdirSync(baseDir)) {
        const typeDir = path.join(baseDir, stageFolder, docType);
        if (!fs.existsSync(typeDir)) continue;
        ensureSafePath(typeDir, stateDir);

        for (const localId of fs.readdirSync(typeDir)) {
          const currentFile = path.join(typeDir, localId, "current.json");
          if (fs.existsSync(currentFile)) {
            ensureSafePath(currentFile, stateDir);
            const current = readJSON(currentFile);
            if (current.revision > 0) {
              const revFile = path.join(
                typeDir,
                localId,
                `revisions/${current.revision}.json`,
              );
              if (fs.existsSync(revFile)) {
                ensureSafePath(revFile, stateDir);
                const doc = readJSON(revFile);
                if (doc.kickoffId !== kickoffHash)
                  throw new Error("Envelope mismatch: kickoffId");
                if (workflowId && doc.workflowId !== workflowId)
                  throw new Error("Envelope mismatch: workflowId");
                if (!workflowId && doc.workflowId)
                  throw new Error("Envelope mismatch: workflowId");
                docs.push(doc);
              }
            }
          }
        }
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(docs, null, 2) }] };
  }

  if (name === "list_events") {
    const { kickoffHash, workflowId } = args;
    if (!/^[a-f0-9]{64}$/.test(kickoffHash))
      throw new Error("Invalid kickoffHash");
    if (workflowId && !/^[a-z0-9][a-z0-9-]*$/.test(workflowId))
      throw new Error("Invalid workflowId");

    let eventsDir;
    if (workflowId) {
      const wfDir = workflowDirectory(stateDir, workflowId);
      ensureSafePath(wfDir, stateDir);
      const stateFile = path.join(wfDir, "state.json");
      if (!fs.existsSync(stateFile)) throw new Error("Workflow not found");
      const state = readJSON(stateFile);
      if (state.kickoffId !== kickoffHash)
        throw new Error("Workflow kickoffId mismatch");
      eventsDir = path.join(wfDir, "events");
    } else {
      eventsDir = path.join(stateDir, "documents", kickoffHash, "events");
    }

    ensureSafePath(eventsDir, stateDir);

    const events = [];
    if (fs.existsSync(eventsDir)) {
      for (const file of fs.readdirSync(eventsDir)) {
        if (file.endsWith(".json")) {
          const eventFile = path.join(eventsDir, file);
          ensureSafePath(eventFile, stateDir);
          const event = readJSON(eventFile);
          if (event.kickoffId !== kickoffHash) {
            throw new Error("Event does not belong to the specified kickoff");
          }
          if (workflowId && event.workflowId !== workflowId) {
            throw new Error("Event does not belong to the specified workflow");
          }
          if (!workflowId && event.workflowId) {
            throw new Error("Event does not belong to the specified workflow");
          }
          events.push(event);
        }
      }
    }
    return {
      content: [{ type: "text", text: JSON.stringify(events, null, 2) }],
    };
  }

  if (name === "search_documents") {
    const { kickoffHash, workflowId, query } = args;
    if (!/^[a-f0-9]{64}$/.test(kickoffHash))
      throw new Error("Invalid kickoffHash");
    if (workflowId && !/^[a-z0-9][a-z0-9-]*$/.test(workflowId))
      throw new Error("Invalid workflowId");
    if (typeof query !== "string" || !query.trim())
      throw new Error("Invalid query");

    const baseDir = path.join(
      stateDir,
      "documents",
      kickoffHash,
      workflowId ?? "none",
    );
    ensureSafePath(baseDir, stateDir);

    const results = [];
    if (fs.existsSync(baseDir)) {
      for (const stageFolder of fs.readdirSync(baseDir)) {
        const stageDir = path.join(baseDir, stageFolder);
        if (
          !fs.statSync(stageDir).isDirectory() ||
          stageFolder === "events" ||
          stageFolder === "consumed-events"
        )
          continue;
        ensureSafePath(stageDir, stateDir);

        for (const docType of fs.readdirSync(stageDir)) {
          const typeDir = path.join(stageDir, docType);
          if (!fs.statSync(typeDir).isDirectory()) continue;
          ensureSafePath(typeDir, stateDir);

          for (const localId of fs.readdirSync(typeDir)) {
            const currentFile = path.join(typeDir, localId, "current.json");
            if (fs.existsSync(currentFile)) {
              ensureSafePath(currentFile, stateDir);
              const current = readJSON(currentFile);
              if (current.revision > 0) {
                const revFile = path.join(
                  typeDir,
                  localId,
                  `revisions/${current.revision}.json`,
                );
                if (fs.existsSync(revFile)) {
                  ensureSafePath(revFile, stateDir);
                  const doc = readJSON(revFile);

                  if (doc.kickoffId !== kickoffHash)
                    throw new Error("Envelope mismatch: kickoffId");
                  if (workflowId && doc.workflowId !== workflowId)
                    throw new Error("Envelope mismatch: workflowId");
                  if (!workflowId && doc.workflowId)
                    throw new Error("Envelope mismatch: workflowId");

                  const docText = JSON.stringify(doc).toLowerCase();
                  if (docText.includes(query.toLowerCase())) {
                    results.push(doc);
                  }
                }
              }
            }
          }
        }
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

/**
 * Creates the MCP server instance.
 * @param {string} stateDir - State directory.
 * @returns {Server} - The server instance.
 */
export function createMcpServer(stateDir) {
  const server = new Server(
    { name: "oh-my-teams-document-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "get_document",
          description:
            "Retrieve a specific document or work item by its docId.",
          inputSchema: {
            type: "object",
            properties: {
              kickoffHash: { type: "string" },
              workflowId: { type: "string" },
              docId: { type: "string" },
            },
            required: ["kickoffHash", "docId"],
          },
        },
        {
          name: "list_documents",
          description: "List documents of a specific type.",
          inputSchema: {
            type: "object",
            properties: {
              kickoffHash: { type: "string" },
              workflowId: { type: "string" },
              docType: { type: "string" },
            },
            required: ["kickoffHash", "docType"],
          },
        },
        {
          name: "list_events",
          description: "List all events.",
          inputSchema: {
            type: "object",
            properties: {
              kickoffHash: { type: "string" },
              workflowId: { type: "string" },
            },
            required: ["kickoffHash"],
          },
        },
        {
          name: "search_documents",
          description:
            "Search for text across documents, work items, and comments in a kickoff or workflow.",
          inputSchema: {
            type: "object",
            properties: {
              kickoffHash: { type: "string" },
              workflowId: { type: "string" },
              query: { type: "string" },
            },
            required: ["kickoffHash", "query"],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return handleCallToolRequest(
      stateDir,
      request.params.name,
      request.params.arguments,
    );
  });

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values: options } = parseArgs({
    options: { state: { type: "string" } },
    strict: false,
  });

  if (!options.state) {
    console.error("Missing --state argument");
    process.exit(1);
  }

  const stateDir = path.resolve(options.state);
  if (!fs.existsSync(stateDir)) {
    console.error(`State directory not found: ${stateDir}`);
    process.exit(1);
  }

  const server = createMcpServer(stateDir);
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    console.error("MCP server failed to start", err);
    process.exit(1);
  });
}
