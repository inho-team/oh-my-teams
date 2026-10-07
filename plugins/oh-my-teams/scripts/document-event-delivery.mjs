/**
 * Durable event delivery.
 * @module document-event-delivery
 */
import fs from "node:fs";
import path from "node:path";
import { readJSON, writeJSON } from "./core.mjs";
import { runOrcaJson } from "./orca-adapter.mjs";
import { workflowDirectory } from "./workflow-store.mjs";

const kickoffDocumentsRoot = (stateDir, kickoffHash) =>
  path.join(stateDir, "documents", kickoffHash);

/**
 * Delivers undelivered events via the Orca adapter.
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
  { executable = "orca", runId, terminalId } = {},
) {
  if (!runId || !terminalId) {
    throw new Error("Missing runId or terminalId for event delivery");
  }

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

    // Deliver using the adapter.
    // If it throws, the loop will terminate and the file is left for retry.
    await deliverFn(event, { executable, runId, terminalId });

    // 이벤트 ID별 delivered receipt를 영속화
    // 송신 성공 후 receipt 영속화 전 중단 시 재전송 가능성이 있음.
    // (소비 측의 consumeDocumentEvent에서 이벤트 ID별 중복 처리로 멱등성을 보장함)
    writeJSON(receiptPath, { deliveredAt: new Date().toISOString() });

    // Delete from queue only on successful delivery and receipt persistence.
    fs.unlinkSync(eventPath);
  }
}

/**
 * Delivers a single event via Orca JSON.
 * @param {object} event - Event object.
 * @param {object} options - Options.
 * @returns {Promise<void>}
 */
export async function deliverEventToOrca(
  event,
  { executable = "orca", execute, runId, terminalId } = {},
) {
  if (!runId || !terminalId) {
    throw new Error("Missing runId or terminalId for event delivery");
  }

  const args = [
    "orchestration",
    "send",
    "--to",
    `run:${runId}`,
    "--from",
    terminalId,
    "--type",
    "status",
    "--subject",
    `document-event: ${event.type}`,
    "--payload",
    JSON.stringify(event),
  ];
  await runOrcaJson(executable, args, { execute });
}
