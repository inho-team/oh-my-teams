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
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  kickoffHashFor,
  listKickoffs,
  resolveRegisteredKickoffFromState,
} from "./kickoff-registry.mjs";
import { runTrustedOrcaJson } from "./orca-adapter.mjs";
import { readLaunches } from "./usage-ledger.mjs";
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
const samePath = (left, right) => {
  try {
    return fs.realpathSync.native(left) === fs.realpathSync.native(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
};
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
 * Resolves the terminal hosting this MCP server from Orca's pane identity.
 * A bare terminal handle is intentionally insufficient: it can name another
 * Director. Orca injects the tab/leaf pair for the current process, and the
 * trusted adapter re-observes the matching live terminal. This also works
 * when a role terminal does not expose ORCA_TERMINAL_HANDLE.
 *
 * @param {NodeJS.ProcessEnv} [environment=process.env] - Session environment.
 * @returns {Promise<{terminal: string, worktreePath: string | null, source: string} | null>} Verified caller session or null.
 */
export async function resolveMessageCallerSession(environment = process.env) {
  const pane = String(environment.ORCA_AGENT_PANE ?? "").trim();
  const [tabId, leafId] = pane.split(":");
  if (!tabId || !leafId) return null;
  try {
    const observed = await runTrustedOrcaJson(["terminal", "list"]);
    const terminals = observed.result?.terminals;
    if (!Array.isArray(terminals)) return null;
    const terminal = terminals.find(
      (item) => item?.tabId === tabId && item?.leafId === leafId,
    );
    if (!terminal?.handle || terminal.orphaned === true) return null;
    const inherited = String(environment.ORCA_TERMINAL_HANDLE ?? "").trim();
    if (inherited && inherited !== terminal.handle) return null;
    return {
      terminal: terminal.handle,
      worktreePath:
        typeof terminal.worktreePath === "string"
          ? terminal.worktreePath
          : null,
      source: "orca-terminal-list-by-pane",
    };
  } catch {
    return null;
  }
}

/**
 * Refuses a state mailbox unless the fixed server session belongs to the
 * registered kickoff. The launch ledger is a startup binding, while the pane
 * lookup is the current Orca observation; neither a request worktree nor a
 * request terminal can widen this scope.
 *
 * @param {object} context - MCP server context fixed at startup.
 * @param {{orgFile: string, worktreeId: string}} registration - Registered state binding.
 * @returns {{kickoffHash: string, entry: object, session: object}} Fixed mailbox binding.
 */
function requireStateMailboxOwner(context, registration) {
  const session = context.callerSession;
  if (!session?.terminal && !session?.worktreePath) {
    throw new Error(
      "Message MCP ownership-unverifiable: recover from the registered role terminal or ask the PM to relaunch the bound server",
    );
  }
  const entry = listKickoffs(registration.orgFile, registration.worktreeId)
    .kickoffs[0];
  if (!entry || entry.registrationSeq === undefined) {
    throw new Error(
      "Message MCP state does not name a current registered kickoff",
    );
  }
  const terminal = String(session.terminal ?? "").trim();
  const launches = readLaunches(registration.orgFile);
  const boundLaunches = launches.filter(
    (launch) =>
      (!terminal || launch.terminal === terminal) &&
      launch.kickoffPmWorktreeId === entry.pm.worktreeId &&
      (!session.worktreePath ||
        (typeof launch.worktreePath === "string" &&
          samePath(launch.worktreePath, session.worktreePath))),
  );
  const bound = boundLaunches.length > 0;
  if (!bound) {
    throw new Error(
      "Message MCP ownership-unverifiable: recover from the registered role terminal; caller session is not bound to this kickoff",
    );
  }
  if (
    context.actor === "pm" &&
    !launches.some(
      (launch) =>
        (!terminal || launch.terminal === terminal) &&
        launch.role === "pm" &&
        launch.kickoffPmWorktreeId === entry.pm.worktreeId,
    )
  ) {
    throw new Error("Message MCP PM actor does not match the bound PM launch");
  }
  if (!terminal && context.actor === "pm") {
    if (boundLaunches.filter((launch) => launch.role === "pm").length !== 1)
      throw new Error(
        "Message MCP ownership-unverifiable: server-start worktree binding is ambiguous; relaunch from the recorded PM terminal",
      );
  }
  if (
    context.actor.startsWith("task:") &&
    !boundLaunches.some(
      (launch) => launch.workflowTaskId === context.actor.slice("task:".length),
    )
  ) {
    throw new Error(
      "Message MCP task actor does not match the bound task launch",
    );
  }
  if (!terminal && context.actor.startsWith("task:")) {
    const taskId = context.actor.slice("task:".length);
    if (
      boundLaunches.filter((launch) => launch.workflowTaskId === taskId)
        .length !== 1
    )
      throw new Error(
        "Message MCP ownership-unverifiable: server-start worktree binding is ambiguous; relaunch from the recorded task terminal",
      );
  }
  if (
    context.actor === "director" &&
    terminal &&
    entry.director?.terminalHandle !== terminal
  ) {
    throw new Error("Message MCP director does not own this kickoff state");
  }
  return { kickoffHash: kickoffHashFor(entry), entry, session };
}

/**
 * Execute one Message MCP tool with an identity fixed at server startup.
 * @param {{stateDir?: string, orgFile?: string, kickoffHash?: string, actor: string, callerSession?: object}} context - Bound mailbox and runtime-verified caller session.
 * @param {string} name - Tool name.
 * @param {object} [args] - Tool arguments.
 * @returns {Promise<object>} MCP tool response.
 */
export async function handleMessageTool(context, name, args = {}) {
  const { stateDir, actor } = context;
  if (context.orgFile) {
    if (actor !== "director")
      throw new Error("Organization mailbox is director-only");
    const allKickoffs = () =>
      listKickoffs(context.orgFile).kickoffs.filter(
        (entry) => entry.registrationSeq !== undefined,
      );
    const directorTerminal = String(
      context.callerSession?.terminal ?? "",
    ).trim();
    const serverStartWorktree = context.callerSession?.worktreePath
      ? path.resolve(context.callerSession.worktreePath)
      : null;
    if (!directorTerminal && !serverStartWorktree) {
      throw new Error(
        "Director Message MCP requires an Orca caller-session provenance",
      );
    }
    const kickoffs = () => {
      const owned = directorTerminal
        ? allKickoffs().filter(
            (entry) => entry.director?.terminalHandle === directorTerminal,
          )
        : allKickoffs().filter(
            (entry) =>
              entry.director?.checkoutPath &&
              path.resolve(entry.director.checkoutPath) === serverStartWorktree,
          );
      if (!directorTerminal && owned.length !== 1)
        throw new Error(
          "Director Message MCP ownership-unverifiable: server-start worktree binding is absent or ambiguous; relaunch from the registered Director terminal",
        );
      return owned;
    };
    const scope = () => {
      const entry = allKickoffs().find(
        (item) => item.pm.worktreeId === args.worktreeId,
      );
      if (!entry)
        throw new Error("Director message requires a registered worktreeId");
      if (!entry.director?.terminalHandle) {
        throw new Error(
          "Legacy or unowned kickoff is read-only and cannot use the director mailbox",
        );
      }
      if (
        directorTerminal &&
        entry.director.terminalHandle !== directorTerminal
      ) {
        throw new Error("Director terminal does not own this kickoff mailbox");
      }
      if (
        !kickoffs().some((owned) => owned.pm.worktreeId === entry.pm.worktreeId)
      )
        throw new Error(
          "Director server-start binding does not own this kickoff mailbox",
        );
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
      const unowned = allKickoffs()
        .filter((entry) => !entry.director?.terminalHandle)
        .flatMap((entry) =>
          receiveMessages(entry.pm.stateDir, kickoffHashFor(entry), actor).map(
            (message) => ({ worktreeId: entry.pm.worktreeId, message }),
          ),
        );
      result = {
        messages,
        unowned,
        timedOut: messages.length === 0,
        directorTerminal: directorTerminal || null,
        provenance: directorTerminal
          ? "orca-terminal-list-by-pane"
          : "server-start-worktree-binding",
      };
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
  const registration = context.kickoffHash
    ? null
    : await resolveRegisteredKickoffFromState(stateDir);
  const binding = registration
    ? requireStateMailboxOwner(context, registration)
    : null;
  const kickoffHash = context.kickoffHash ?? binding?.kickoffHash;
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
 * @param {{stateDir?: string, orgFile?: string, kickoffHash?: string, actor: string, callerSession?: object}} context - Bound mailbox and runtime-verified caller session.
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
    const callerSession = (await resolveMessageCallerSession()) ?? {
      worktreePath: process.cwd(),
      source: "server-start-worktree-binding",
    };
    const context = {
      ...(values.org
        ? { orgFile: path.resolve(values.org) }
        : { stateDir: path.resolve(values.state) }),
      actor: validateMessageActor(values.actor),
      callerSession,
    };
    await createMessageMcpServer(context).connect(new StdioServerTransport());
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
