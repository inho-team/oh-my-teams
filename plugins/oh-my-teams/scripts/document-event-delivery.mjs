/**
 * Durable event delivery.
 * @module document-event-delivery
 */
import fs from "node:fs";
import path from "node:path";
import { readJSON, writeJSON } from "./core.mjs";
import { sendMessage } from "./message-store.mjs";
import { workflowDirectory } from "./workflow-store.mjs";

const kickoffDocumentsRoot = (stateDir, kickoffHash) =>
  path.join(stateDir, "documents", kickoffHash);

/**
 * Delivers undelivered events through the kickoff message store.
 * @param {string} stateDir - State directory.
 * @param {string} kickoffHash - Kickoff hash.
 * @param {string} workflowId - Workflow ID.
 * @param {Function} deliverFn - Delivery function.
 * @param {object} options - Options.
 * @returns {Promise<void>}
 */
export async function deliverUndeliveredEvents(
  stateDir,
  kickoffHash,
  workflowId,
  deliverFn = deliverEventToMessage,
  { actor, to } = {},
) {
  if (deliverFn === deliverEventToMessage && (!actor || !to))
    throw new Error("Missing actor or recipient for event delivery");

  const eventsDir = workflowId
    ? path.join(workflowDirectory(stateDir, workflowId), "events")
    : path.join(kickoffDocumentsRoot(stateDir, kickoffHash), "events");

  const undeliveredDir = path.join(eventsDir, "undelivered");
  if (!fs.existsSync(undeliveredDir)) return;

  const deliveredDir = path.join(eventsDir, "delivered");
  if (!fs.existsSync(deliveredDir)) {
    fs.mkdirSync(deliveredDir, { recursive: true });
  }

  for (const file of fs.readdirSync(undeliveredDir)) {
    if (!file.endsWith(".json")) continue;
    const eventPath = path.join(undeliveredDir, file);
    const event = readJSON(eventPath);
    const receiptPath = path.join(deliveredDir, `${event.id}.json`);

    if (fs.existsSync(receiptPath)) {
      // receipt가 있으면 재큐잉하지 않는다. (큐 파일 삭제)
      fs.unlinkSync(eventPath);
      continue;
    }

    // Deliver through the idempotent message store.
    // If it throws, the loop will terminate and the file is left for retry.
    await deliverFn(event, { stateDir, kickoffHash, actor, to });

    // 이벤트 ID별 delivered receipt를 영속화
    // 송신 후 receipt 기록 전에 중단되어도 이벤트 ID의 메시지 키로 재시도를 합친다.
    writeJSON(receiptPath, { deliveredAt: new Date().toISOString() });

    // Delete from queue only on successful delivery and receipt persistence.
    fs.unlinkSync(eventPath);
  }
}

/**
 * Delivers a single document event through Message MCP storage.
 * @param {object} event - Event object.
 * @param {object} options - Options.
 * @returns {Promise<void>}
 */
export async function deliverEventToMessage(
  event,
  { stateDir, kickoffHash, actor, to } = {},
) {
  if (!actor || !to)
    throw new Error("Missing actor or recipient for event delivery");
  sendMessage(stateDir, kickoffHash, {
    from: actor,
    to,
    key: `doc-event:${event.id}`,
    type: "status",
    subject: `document-event: ${event.type}`,
    body: JSON.stringify(event),
  });
}
