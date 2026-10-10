/** @module message-mcp-test */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  acknowledgeMessage,
  getMessage,
  receiveMessages,
  sendMessage,
  waitMessages,
} from "../plugins/oh-my-teams/scripts/message-store.mjs";
import { handleMessageTool } from "../plugins/oh-my-teams/scripts/message-mcp.mjs";
import {
  registerKickoff,
  kickoffHashFor,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";
import {
  requirementsDraft,
  readDraft,
} from "../plugins/oh-my-teams/scripts/requirements.mjs";
import {
  executeCommand,
  parseArgs,
} from "../plugins/oh-my-teams/scripts/teams-org.mjs";
import { messageMcpLaunch } from "../plugins/oh-my-teams/scripts/message-mcp-config.mjs";
import { deliverEventToMessage } from "../plugins/oh-my-teams/scripts/document-event-delivery.mjs";
import { roleCommand } from "../plugins/oh-my-teams/scripts/role-launch.mjs";

const HASH = "a".repeat(64);
const message = {
  from: "pm",
  to: "director",
  key: "signal-1",
  type: "question",
  subject: "Decision needed",
  body: "Choose A or B.",
};

test("Message MCP store persists retries, delivery, and receiver acknowledgements", async (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "omt-message-store-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const first = sendMessage(state, HASH, message);
  assert.equal(first.replayed, false);
  assert.equal(first.message.status, "pending");
  const retry = sendMessage(state, HASH, message);
  assert.equal(retry.replayed, true);
  assert.equal(retry.message.id, first.message.id);
  assert.throws(
    () => sendMessage(state, HASH, { ...message, body: "Different" }),
    /already used/,
  );
  assert.equal(receiveMessages(state, HASH, "director").length, 1);
  assert.equal(receiveMessages(state, HASH, "pm").length, 0);
  assert.throws(
    () => acknowledgeMessage(state, HASH, "pm", first.message.id),
    /Only the receiver/,
  );
  assert.throws(
    () => getMessage(state, HASH, "task:other", first.message.id),
    /outside caller scope/,
  );
  const acknowledged = acknowledgeMessage(
    state,
    HASH,
    "director",
    first.message.id,
  );
  assert.equal(acknowledged.message.status, "acknowledged");
  assert.equal(
    acknowledgeMessage(state, HASH, "director", first.message.id).replayed,
    true,
  );
  assert.deepEqual(receiveMessages(state, HASH, "director"), []);
  assert.equal(
    getMessage(state, HASH, "pm", first.message.id).status,
    "acknowledged",
  );
});

test("Message MCP wait receives a later send without a terminal Enter", async (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "omt-message-wait-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const waiting = waitMessages(state, HASH, "director", { timeoutMs: 1500 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  sendMessage(state, HASH, message);
  const received = await waiting;
  assert.equal(received.timedOut, false);
  assert.equal(received.messages.length, 1);
  assert.equal(
    (await waitMessages(state, HASH, "pm", { timeoutMs: 0 })).timedOut,
    true,
  );
});

test("Message MCP tool binds sender to the server context", async (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "omt-message-tool-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const context = { stateDir: state, kickoffHash: HASH, actor: "pm" };
  const sent = await handleMessageTool(context, "send_message", {
    ...message,
    from: "director",
  });
  const record = sent.structuredContent.message;
  assert.equal(record.from, "pm");
  assert.equal(record.to, "director");
  assert.equal(receiveMessages(state, HASH, "director").length, 1);
});

test("Document events use the same idempotent mailbox", async (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "omt-message-event-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const event = { id: "event-1", type: "document-updated", revision: 2 };
  const options = {
    stateDir: state,
    kickoffHash: HASH,
    actor: "task:writer",
    to: "pm",
  };
  await deliverEventToMessage(event, options);
  await deliverEventToMessage(event, options);
  const received = receiveMessages(state, HASH, "pm");
  assert.equal(received.length, 1);
  assert.equal(JSON.parse(received[0].body).revision, 2);
});

test("Role launch attaches Message MCP through session arguments", () => {
  const org = JSON.parse(
    fs.readFileSync("plugins/oh-my-teams/examples/organization.json", "utf8"),
  );
  const claude = messageMcpLaunch("claude", "/tmp/omt-state", "pm");
  assert.equal(claude.available, true);
  assert.deepEqual(
    JSON.parse(claude.argv[1]).mcpServers.omt_message.args.slice(-2),
    ["--actor", "pm"],
  );
  const codex = messageMcpLaunch("codex", "/tmp/omt-state", "task:review-1");
  assert.equal(codex.available, true);
  assert.match(codex.argv[1], /mcp_servers\.omt_message=/);
  assert.deepEqual(messageMcpLaunch("agy", "/tmp/omt-state", "pm"), {
    argv: [],
    available: false,
  });
  const command = roleCommand(org, "pm", { messageState: "/tmp/omt-state" });
  assert.equal(command.messageMcp.actor, "pm");
  assert.equal(command.messageMcp.available, true);
  const director = messageMcpLaunch("claude", undefined, "director", {
    orgFile: "/tmp/organization.json",
  });
  assert.deepEqual(
    JSON.parse(director.argv[1]).mcpServers.omt_message.args.slice(-4),
    ["--org", "/tmp/organization.json", "--actor", "director"],
  );
});

function registeredState(root) {
  execFileSync("git", ["init", root], { stdio: "ignore" });
  const state = path.join(root, ".omt");
  fs.mkdirSync(path.join(state, "kickoffs"), { recursive: true });
  const orgFile = path.join(state, "organization.json");
  fs.copyFileSync(
    path.resolve("plugins/oh-my-teams/examples/organization.json"),
    orgFile,
  );
  const worktreeId = "wt-message";
  const statements = [{ id: "s1", text: "Send a message", source: "brief" }];
  const criteria = [
    {
      id: "c1",
      text: "Send a message",
      scope: "equal",
      userVisible: false,
      derivedFrom: ["s1"],
    },
  ];
  requirementsDraft(orgFile, { worktreeId, statements, criteria });
  const draft = readDraft(orgFile, worktreeId);
  const brief = path.join(root, "brief.md");
  fs.writeFileSync(brief, "Brief\n");
  const claim = {
    schemaVersion: 1,
    goal: "Message test",
    brief,
    createdAt: new Date().toISOString(),
    organizationRevision: 1,
    runId: null,
    selfPm: "test",
    pm: { worktreeId, path: root, stateDir: state },
    delivery: { mode: "none" },
    requirements: {
      statements: draft.statements,
      criteria: draft.criteria,
      confirmations: draft.confirmations,
    },
    director: { terminalHandle: "term_director", checkoutPath: process.cwd() },
  };
  const { entry } = registerKickoff(orgFile, claim);
  return { state, orgFile, worktreeId, kickoffHash: kickoffHashFor(entry) };
}

test("Director signals and replies use the OMT mailbox without terminal input", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omt-message-director-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { state, orgFile, worktreeId, kickoffHash } = registeredState(root);
  const directorLaunch = await executeCommand({
    command: "director-command",
    org: orgFile,
    provider: "codex",
  });
  assert.equal(directorLaunch.messageMcp.actor, "director");
  const signal = await executeCommand({
    command: "director-signal",
    org: orgFile,
    worktree: worktreeId,
    kind: "decision",
    text: "Choose the deployment target.",
  });
  assert.equal(signal.queued, true);
  const directorMessages = receiveMessages(state, kickoffHash, "director");
  assert.equal(directorMessages.length, 1);
  assert.equal(directorMessages[0].id, signal.messageId);
  const directorTool = await handleMessageTool(
    { orgFile, actor: "director" },
    "receive_messages",
  );
  assert.equal(
    directorTool.structuredContent.messages[0].worktreeId,
    worktreeId,
  );
  const signalRetry = await executeCommand({
    command: "director-signal",
    org: orgFile,
    worktree: worktreeId,
    kind: "decision",
    text: "Choose the deployment target.",
  });
  assert.equal(signalRetry.signaled, false);
  assert.equal(signalRetry.replayed, true);
  assert.equal(signalRetry.messageId, signal.messageId);
  fs.unlinkSync(
    path.join(
      state,
      "messages",
      kickoffHash,
      "records",
      `${signal.messageId}.json`,
    ),
  );
  const repaired = await executeCommand({
    command: "director-signal",
    org: orgFile,
    worktree: worktreeId,
    kind: "decision",
    text: "Choose the deployment target.",
  });
  assert.equal(repaired.signaled, false);
  assert.equal(repaired.replayed, false);
  assert.equal(repaired.messageId, signal.messageId);
  const reply = await executeCommand({
    command: "director-reply",
    org: orgFile,
    signal: signal.id,
    text: "Use staging.",
  });
  assert.equal(reply.queued, true);
  assert.equal(
    receiveMessages(state, kickoffHash, "pm")[0].body,
    "Use staging.",
  );
  const replay = await executeCommand({
    command: "director-reply",
    org: orgFile,
    signal: signal.id,
    text: "Use staging.",
  });
  assert.equal(replay.replayed, true);
  const watched = await executeCommand({
    command: "message-watch",
    org: orgFile,
  });
  assert.equal(watched.messages[0].message.id, signal.messageId);
  const acknowledged = await executeCommand({
    command: "director-ack",
    org: orgFile,
    signal: signal.id,
  });
  assert.equal(acknowledged.messageAcknowledged, true);
  assert.deepEqual(receiveMessages(state, kickoffHash, "director"), []);
  const inbox = await executeCommand(
    parseArgs(["message-inbox", "--state", state, "--actor", "pm"]),
  );
  assert.equal(inbox.messages.length, 1);
});

test("Message MCP stdio exposes a registered kickoff mailbox", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omt-message-stdio-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { state, kickoffHash } = registeredState(root);
  const script = path.resolve("plugins/oh-my-teams/scripts/message-mcp.mjs");
  const client = new Client({ name: "omt-message-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [script, "--state", state, "--actor", "pm"],
  });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    ["send_message", "receive_messages", "ack_message", "get_message"],
  );
  const sent = await client.callTool({
    name: "send_message",
    arguments: {
      to: "director",
      key: "stdio-1",
      type: "question",
      subject: "Need input",
      body: "Please decide.",
    },
  });
  assert.equal(sent.isError, undefined);
  assert.equal(receiveMessages(state, kickoffHash, "director").length, 1);
  const ownInbox = await client.callTool({
    name: "receive_messages",
    arguments: {},
  });
  assert.deepEqual(ownInbox.structuredContent.messages, []);
  const forbiddenAck = await client.callTool({
    name: "ack_message",
    arguments: { id: sent.structuredContent.message.id },
  });
  assert.equal(forbiddenAck.isError, true);
});

test("Supervisor wait receives a stored role message before checking Orca", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "omt-message-supervisor-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { state, kickoffHash } = registeredState(root);
  sendMessage(state, kickoffHash, {
    from: "task:worker-1",
    to: "pm",
    key: "progress-1",
    type: "status",
    subject: "Progress",
    body: "The implementation is ready for review.",
  });
  const result = await executeCommand({
    command: "supervision-wait",
    run: "run-without-orca",
    state,
    mailbox: "pm",
    "timeout-ms": "1000",
  });
  assert.equal(result.source, "message-mcp");
  assert.equal(result.messages.length, 1);
});
