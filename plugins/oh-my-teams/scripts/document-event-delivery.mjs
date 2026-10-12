/**
 * Durable event delivery.
 * @module document-event-delivery
 */
import fs from "node:fs";
import path from "node:path";
import { readJSON, writeJSON } from "./core.mjs";
import {
  listKickoffs,
  resolveRegisteredKickoffFromState,
} from "./kickoff-registry.mjs";
import { sendOrcaMessage } from "./orca-adapter.mjs";
import { workflowDirectory } from "./workflow-store.mjs";

const kickoffDocumentsRoot = (stateDir, kickoffHash) =>
  path.join(stateDir, "documents", kickoffHash);

/**
 * Delivers undelivered events through Orca's Run mailbox.
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
  deliverFn = deliverEventToOrca,
  { actor, to } = {},
) {
  if (deliverFn === deliverEventToOrca && (!actor || !to))
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

    // Deliver through Orca. The event ID in the body lets recipients recognize a replay.
    // If it throws, the loop will terminate and the file is left for retry.
    await deliverFn(event, { stateDir, kickoffHash, actor, to });

    // 이벤트 ID별 delivered receipt를 영속화
    // 송신 후 receipt 기록 전에 중단되면 같은 이벤트 ID가 다시 전달될 수 있다.
    writeJSON(receiptPath, { deliveredAt: new Date().toISOString() });

    // Delete from queue only on successful delivery and receipt persistence.
    fs.unlinkSync(eventPath);
  }
}

/**
 * Delivers a single document event through Orca orchestration.
 * @param {object} event - Event object.
 * @param {object} options - Options.
 * @returns {Promise<void>}
 */
export async function deliverEventToOrca(
  event,
  { stateDir, kickoffHash, actor, to } = {},
) {
  if (!actor || !to)
    throw new Error("Missing actor or recipient for event delivery");
  const registered = await resolveRegisteredKickoffFromState(stateDir);
  if (!registered || registered.kickoffHash !== kickoffHash)
    throw new Error("Document event has no registered kickoff");
  const [entry] = listKickoffs(
    registered.orgFile,
    registered.worktreeId,
  ).kickoffs;
  const recipient =
    to === "director"
      ? entry?.director?.terminalHandle
      : entry?.runId && `run:${entry.runId}`;
  if (!recipient) throw new Error("Document event has no Orca recipient");
  await sendOrcaMessage({
    to: recipient,
    type: "status",
    subject: `document-event: ${event.type}`,
    body: JSON.stringify(event),
  });
}
