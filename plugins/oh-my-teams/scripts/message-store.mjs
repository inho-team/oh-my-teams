/**
 * Durable, kickoff-scoped messages independent of terminal input and Orca mailboxes.
 * @module message-store
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assert, readJSON, withFileLock, writeJSON } from "./core.mjs";

const HASH = /^[a-f0-9]{64}$/;
const ACTOR = /^(director|pm|task:[a-zA-Z0-9_-]+)$/;
const KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const TYPES = new Set([
  "status",
  "question",
  "decision",
  "blocked",
  "close-ready",
  "progress",
  "instruction",
  "escalation",
]);

function checkScope(kickoffHash, actor) {
  assert(HASH.test(kickoffHash), "Invalid kickoff hash");
  validateMessageActor(actor);
}

/**
 * Validate a logical mailbox identity without requiring a registered kickoff.
 * @param {string} actor - Logical actor name.
 * @returns {string} Valid actor name.
 */
export function validateMessageActor(actor) {
  assert(ACTOR.test(actor ?? ""), `Invalid message actor: ${actor}`);
  return actor;
}

function messagesDir(stateDir, kickoffHash) {
  const state = path.resolve(stateDir);
  const root = path.join(state, "messages");
  const scoped = path.join(root, kickoffHash);
  for (const directory of [root, scoped, path.join(scoped, "records")]) {
    if (fs.existsSync(directory))
      assert(
        !fs.lstatSync(directory).isSymbolicLink(),
        "Message store path cannot be a symlink",
      );
  }
  return scoped;
}

function recordFile(stateDir, kickoffHash, id) {
  assert(/^msg_[a-f0-9]{64}$/.test(id), "Invalid message id");
  const file = path.join(
    messagesDir(stateDir, kickoffHash),
    "records",
    `${id}.json`,
  );
  if (fs.existsSync(file))
    assert(
      !fs.lstatSync(file).isSymbolicLink(),
      "Message record cannot be a symlink",
    );
  return file;
}

/**
 * Derive a stable id for a sender's retry key within one kickoff.
 * @param {string} kickoffHash - Registered kickoff hash.
 * @param {string} from - Sender actor.
 * @param {string} key - Sender's retry key.
 * @returns {string} Stable message id.
 */
export function messageIdFor(kickoffHash, from, key) {
  checkScope(kickoffHash, from);
  assert(KEY.test(key ?? ""), "Message key must be 1-128 safe characters");
  const digest = crypto
    .createHash("sha256")
    .update(`${kickoffHash}\0${from}\0${key}`)
    .digest("hex");
  return `msg_${digest}`;
}

function records(stateDir, kickoffHash) {
  const directory = path.join(messagesDir(stateDir, kickoffHash), "records");
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => /^msg_[a-f0-9]{64}\.json$/.test(name))
    .map((name) =>
      readJSON(recordFile(stateDir, kickoffHash, name.slice(0, -5))),
    );
}

/**
 * Store one message. Repeating the same sender and key returns the first record.
 * @param {string} stateDir - Registered PM state directory.
 * @param {string} kickoffHash - Registered kickoff hash.
 * @param {{from: string, to: string, key: string, type: string, subject: string, body: string}} message - Message envelope.
 * @returns {{message: object, replayed: boolean}} Stored record and retry status.
 */
export function sendMessage(stateDir, kickoffHash, message) {
  checkScope(kickoffHash, message.from);
  checkScope(kickoffHash, message.to);
  assert(message.from !== message.to, "A message cannot target its sender");
  assert(
    KEY.test(message.key ?? ""),
    "Message key must be 1-128 safe characters",
  );
  assert(TYPES.has(message.type), `Invalid message type: ${message.type}`);
  const subject = String(message.subject ?? "").trim();
  const body = String(message.body ?? "").trim();
  assert(
    subject.length > 0 && subject.length <= 300,
    "Message subject must be 1-300 characters",
  );
  assert(
    body.length > 0 && body.length <= 65536,
    "Message body must be 1-65536 characters",
  );
  const id = messageIdFor(kickoffHash, message.from, message.key);
  const file = recordFile(stateDir, kickoffHash, id);
  const envelope = {
    from: message.from,
    to: message.to,
    key: message.key,
    type: message.type,
    subject,
    body,
  };
  return withFileLock(
    path.join(messagesDir(stateDir, kickoffHash), ".lock"),
    () => {
      if (fs.existsSync(file)) {
        const existing = readJSON(file);
        assert(
          Object.entries(envelope).every(
            ([field, value]) => existing[field] === value,
          ),
          `Message key ${message.key} was already used with different content`,
        );
        return { message: existing, replayed: true };
      }
      const stored = {
        schemaVersion: 1,
        id,
        kickoffHash,
        ...envelope,
        status: "pending",
        sentAt: new Date().toISOString(),
      };
      writeJSON(file, stored);
      return { message: stored, replayed: false };
    },
    "Message store busy",
  );
}

/**
 * Read messages addressed to one actor without acknowledging them.
 * @param {string} stateDir - Registered PM state directory.
 * @param {string} kickoffHash - Registered kickoff hash.
 * @param {string} actor - Fixed receiver identity.
 * @param {object} [options] - List options.
 * @param {number} [options.limit=50] - Maximum records.
 * @param {boolean} [options.includeAcknowledged=false] - Include completed records.
 * @returns {object[]} Matching messages in stable order.
 */
export function receiveMessages(
  stateDir,
  kickoffHash,
  actor,
  { limit = 50, includeAcknowledged = false } = {},
) {
  checkScope(kickoffHash, actor);
  assert(
    Number.isInteger(limit) && limit >= 1 && limit <= 500,
    "Message limit must be 1-500",
  );
  return records(stateDir, kickoffHash)
    .filter(
      (message) =>
        message.to === actor &&
        (includeAcknowledged || message.status === "pending"),
    )
    .sort(
      (a, b) => a.sentAt.localeCompare(b.sentAt) || a.id.localeCompare(b.id),
    )
    .slice(0, limit);
}

/**
 * Read a message visible to its sender or receiver.
 * @param {string} stateDir - Registered PM state directory.
 * @param {string} kickoffHash - Registered kickoff hash.
 * @param {string} actor - Fixed caller identity.
 * @param {string} id - Message id.
 * @returns {object} Stored message.
 */
export function getMessage(stateDir, kickoffHash, actor, id) {
  checkScope(kickoffHash, actor);
  const file = recordFile(stateDir, kickoffHash, id);
  assert(fs.existsSync(file), `Message ${id} not found`);
  const message = readJSON(file);
  assert(
    message.kickoffHash === kickoffHash &&
      [message.from, message.to].includes(actor),
    "Message is outside caller scope",
  );
  return message;
}

/**
 * Acknowledge a received message after its content has been handled.
 * @param {string} stateDir - Registered PM state directory.
 * @param {string} kickoffHash - Registered kickoff hash.
 * @param {string} actor - Fixed receiver identity.
 * @param {string} id - Message id.
 * @returns {{message: object, replayed: boolean}} Updated record and retry status.
 */
export function acknowledgeMessage(stateDir, kickoffHash, actor, id) {
  checkScope(kickoffHash, actor);
  return withFileLock(
    path.join(messagesDir(stateDir, kickoffHash), ".lock"),
    () => {
      const message = getMessage(stateDir, kickoffHash, actor, id);
      assert(
        message.to === actor,
        "Only the receiver can acknowledge a message",
      );
      if (message.status === "acknowledged") return { message, replayed: true };
      const updated = {
        ...message,
        status: "acknowledged",
        acknowledgedAt: new Date().toISOString(),
      };
      writeJSON(recordFile(stateDir, kickoffHash, id), updated);
      return { message: updated, replayed: false };
    },
    "Message store busy",
  );
}

/**
 * Wait for unacknowledged messages with bounded polling.
 * @param {string} stateDir - Registered PM state directory.
 * @param {string} kickoffHash - Registered kickoff hash.
 * @param {string} actor - Fixed receiver identity.
 * @param {object} [options] - Wait options.
 * @param {number} [options.timeoutMs=30000] - Maximum wait in milliseconds.
 * @param {number} [options.limit=50] - Maximum records.
 * @returns {Promise<{messages: object[], timedOut: boolean}>} Pending messages or timeout.
 */
export async function waitMessages(
  stateDir,
  kickoffHash,
  actor,
  { timeoutMs = 30000, limit = 50 } = {},
) {
  assert(
    Number.isInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 60000,
    "Message timeout must be 0-60000 milliseconds",
  );
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const messages = receiveMessages(stateDir, kickoffHash, actor, { limit });
    if (messages.length) return { messages, timedOut: false };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { messages: [], timedOut: true };
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(250, remaining)),
    );
  }
}
