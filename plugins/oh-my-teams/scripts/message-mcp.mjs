#!/usr/bin/env node
/**
 * Kickoff-scoped Message MCP server with durable send, receive, and acknowledgement.
 * @module message-mcp
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  kickoffHashFor,
  listKickoffs,
  resolveRegisteredKickoffFromState,
} from "./kickoff-registry.mjs";
import {
  acknowledgeMessage,
  getMessage,
  receiveMessages,
  sendMessage,
  validateMessageActor,
  waitMessages,
} from "./message-store.mjs";

const tool = (name, description, properties, required = []) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  },
});

const string = { type: "string" };
const tools = [
  tool(
    "send_message",
    "Store a message for another OMT role. Reuse the same key to retry without duplication.",
    {
      to: string,
      key: string,
      type: {
        type: "string",
        enum: [
          "status",
          "question",
          "decision",
          "blocked",
          "close-ready",
          "progress",
          "instruction",
          "escalation",
        ],
      },
      subject: string,
      body: string,
      worktreeId: string,
    },
    ["to", "key", "type", "subject", "body"],
  ),
  tool(
    "receive_messages",
    "Read pending OMT messages. They remain pending until ack_message succeeds.",
    {
      limit: { type: "integer", minimum: 1, maximum: 500 },
      timeoutMs: { type: "integer", minimum: 0, maximum: 60000 },
    },
  ),
  tool(
    "ack_message",
    "Acknowledge one message only after handling its content.",
    { id: string, worktreeId: string },
    ["id"],
  ),
  tool(
    "get_message",
    "Read the current receipt for a message you sent or received.",
    { id: string, worktreeId: string },
    ["id"],
  ),
];

/**
 * Execute one Message MCP tool with an identity fixed at server startup.
 * @param {{stateDir?: string, orgFile?: string, kickoffHash?: string, actor: string}} context - Bound kickoff or director organization and caller.
 * @param {string} name - Tool name.
 * @param {object} [args] - Tool arguments.
 * @returns {Promise<object>} MCP tool response.
 */
export async function handleMessageTool(context, name, args = {}) {
  const { stateDir, actor } = context;
  if (context.orgFile) {
    if (actor !== "director")
      throw new Error("Organization mailbox is director-only");
    const kickoffs = () =>
      listKickoffs(context.orgFile).kickoffs.filter(
        (entry) => entry.registrationSeq !== undefined,
      );
    const scope = () => {
      const entry = kickoffs().find(
        (item) => item.pm.worktreeId === args.worktreeId,
      );
      if (!entry)
        throw new Error("Director message requires a registered worktreeId");
      return {
        stateDir: entry.pm.stateDir,
        kickoffHash: kickoffHashFor(entry),
      };
    };
    let result;
    if (name === "receive_messages") {
      const limit = args.limit ?? 50;
      const timeoutMs = args.timeoutMs ?? 0;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500)
        throw new Error("Message limit must be 1-500");
      if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60000)
        throw new Error("Message timeout must be 0-60000 milliseconds");
      const deadline = Date.now() + timeoutMs;
      let messages = [];
      for (;;) {
        messages = kickoffs().flatMap((entry) =>
          receiveMessages(entry.pm.stateDir, kickoffHashFor(entry), actor).map(
            (message) => ({ worktreeId: entry.pm.worktreeId, message }),
          ),
        );
        messages.sort(
          (a, b) =>
            a.message.sentAt.localeCompare(b.message.sentAt) ||
            a.message.id.localeCompare(b.message.id),
        );
        messages = messages.slice(0, limit);
        if (messages.length || Date.now() >= deadline) break;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(250, deadline - Date.now())),
        );
      }
      result = { messages, timedOut: messages.length === 0 };
    } else {
      const target = scope();
      switch (name) {
        case "send_message":
          result = sendMessage(target.stateDir, target.kickoffHash, {
            ...args,
            from: actor,
          });
          break;
        case "ack_message":
          result = acknowledgeMessage(
            target.stateDir,
            target.kickoffHash,
            actor,
            args.id,
          );
          break;
        case "get_message":
          result = getMessage(
            target.stateDir,
            target.kickoffHash,
            actor,
            args.id,
          );
          break;
        default:
          throw new Error(`Unknown Message MCP tool: ${name}`);
      }
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  }
  const kickoffHash =
    context.kickoffHash ??
    (await resolveRegisteredKickoffFromState(stateDir))?.kickoffHash;
  if (!kickoffHash)
    throw new Error("Message MCP requires a registered kickoff state");
  let result;
  switch (name) {
    case "send_message":
      result = sendMessage(stateDir, kickoffHash, { ...args, from: actor });
      break;
    case "receive_messages":
      result =
        args.timeoutMs === undefined
          ? {
              messages: receiveMessages(stateDir, kickoffHash, actor, {
                limit: args.limit,
              }),
              timedOut: false,
            }
          : await waitMessages(stateDir, kickoffHash, actor, {
              timeoutMs: args.timeoutMs,
              limit: args.limit,
            });
      break;
    case "ack_message":
      result = acknowledgeMessage(stateDir, kickoffHash, actor, args.id);
      break;
    case "get_message":
      result = getMessage(stateDir, kickoffHash, actor, args.id);
      break;
    default:
      throw new Error(`Unknown Message MCP tool: ${name}`);
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

/**
 * Create an MCP server bound to one registered kickoff and role actor.
 * @param {{stateDir?: string, orgFile?: string, kickoffHash?: string, actor: string}} context - Bound kickoff or director organization and caller.
 * @returns {Server} MCP server.
 */
export function createMessageMcpServer(context) {
  const server = new Server(
    { name: "oh-my-teams-message-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await handleMessageTool(
        context,
        request.params.name,
        request.params.arguments ?? {},
      );
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error.message }],
      };
    }
  });
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { values } = parseArgs({
    options: {
      state: { type: "string" },
      org: { type: "string" },
      actor: { type: "string" },
    },
  });
  if (
    (!values.state && !values.org) ||
    (values.state && values.org) ||
    !values.actor
  ) {
    console.error(
      "Message MCP requires exactly one of --state or --org, and --actor",
    );
    process.exit(1);
  }
  try {
    const context = {
      ...(values.org
        ? { orgFile: path.resolve(values.org) }
        : { stateDir: path.resolve(values.state) }),
      actor: validateMessageActor(values.actor),
    };
    await createMessageMcpServer(context).connect(new StdioServerTransport());
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
