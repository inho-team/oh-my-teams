/**
 * Core event routing and authorization utilities.
 * @module document-events
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { readJSON, writeJSON } from "./core.mjs";
import {
  appendWorkflowEvent,
  workflowDirectory,
  readWorkflowSnapshot,
  saveWorkflowState,
  withWorkflowUpdate,
} from "./workflow-store.mjs";
import { parseDocId } from "./documents.mjs";
import { resolveRegisteredKickoffFromState } from "./kickoff-registry.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const documentEventSchemaPath = path.join(
  __dirname,
  "..",
  "schemas",
  "document-event.schema.json",
);

/**
 * Validates a document event against its schema.
 * @param {object} event - The document event.
 * @returns {void}
 * @throws {Error} When validation fails.
 */
export function validateDocumentEvent(event) {
  const schema = readJSON(documentEventSchemaPath);

  assert(event && typeof event === "object", "Event must be an object");

  for (const req of schema.required) {
    assert(event[req] !== undefined, `Event missing required field: ${req}`);
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(event)) {
      assert(
        schema.properties[key] !== undefined,
        `Event has additional property: ${key}`,
      );
    }
  }

  assert(
    event.schemaVersion === schema.properties.schemaVersion.const,
    "Event schemaVersion 1 required",
  );

  const idRegex = new RegExp(schema.properties.id.pattern);
  assert(idRegex.test(event.id), "Event id must be a UUID");

  assert(
    schema.properties.type.enum.includes(event.type),
    "Invalid event type",
  );

  assert(
    event.author && typeof event.author === "object",
    "Event author must be an object",
  );
  const authorDef = schema.$defs.author;
  for (const req of authorDef.required) {
    assert(
      event.author[req] !== undefined,
      `Author missing required field: ${req}`,
    );
  }
  if (authorDef.additionalProperties === false) {
    for (const key of Object.keys(event.author)) {
      assert(
        authorDef.properties[key] !== undefined,
        `Author has additional property: ${key}`,
      );
    }
  }
  assert(
    authorDef.properties.role.enum.includes(event.author.role),
    "Event author must have a valid role",
  );
  const execIdValid =
    typeof event.author.executionId === "string" &&
    event.author.executionId.length >=
      authorDef.properties.executionId.minLength;
  assert(execIdValid, "Event author executionId must be a valid string");

  assert(
    typeof event.recordedAt === "string" && event.recordedAt,
    "Event recordedAt required",
  );

  for (const [key, value] of Object.entries(event)) {
    if (value === undefined) continue;
    const propSchema = schema.properties[key];
    if (propSchema && Array.isArray(propSchema.type)) {
      if (value === null) {
        assert(propSchema.type.includes("null"), `Field ${key} cannot be null`);
      } else {
        const typeStr =
          typeof value === "number" && Number.isInteger(value)
            ? "integer"
            : typeof value;
        assert(
          propSchema.type.includes(typeStr),
          `Field ${key} has invalid type ${typeStr}`,
        );
      }
    } else if (propSchema && propSchema.type === "string") {
      assert(typeof value === "string", `Field ${key} must be a string`);
    } else if (propSchema && propSchema.type === "integer") {
      assert(Number.isInteger(value), `Field ${key} must be an integer`);
    }
  }
}

/**
 * Consumes a document event exactly once.
 *
 * Routes the event deduplication logic depending on the event's scope:
 * - If workflowId is set, relies on workflow-store.mjs O(1) deduplication.
 * - If workflowId is null, falls back to a file-based cache scoped to the kickoff hash.
 *
 * @param {string} stateDir - PM worktree state directory.
 * @param {object} event - The document event to consume.
 * @returns {boolean} true if the event was successfully consumed (new), false if it was already processed.
 */
export async function consumeDocumentEvent(stateDir, event) {
  validateDocumentEvent(event);

  const parsed = parseDocId(event.docId);
  if (parsed.docType === "task-comment") {
    throw new Error(`Event carries an unsupported document type: task-comment`);
  }
  if (parsed.workflowId !== event.workflowId) {
    throw new Error(
      `Cross-scope event: event workflowId ${event.workflowId} does not match docId workflowId ${parsed.workflowId}`,
    );
  }
  if (parsed.kickoffHash !== event.kickoffId) {
    throw new Error(
      `Cross-scope event: event kickoffId ${event.kickoffId} does not match docId kickoffHash ${parsed.kickoffHash}`,
    );
  }

  const registryInfo = await resolveRegisteredKickoffFromState(stateDir);
  if (!registryInfo || !registryInfo.kickoffHash) {
    throw new Error(
      `Authoritative kickoff resolution failed for state directory: ${stateDir}`,
    );
  }
  if (registryInfo.kickoffHash !== event.kickoffId) {
    throw new Error(
      `Cross-scope event: event kickoffId ${event.kickoffId} does not match authoritative kickoffHash ${registryInfo.kickoffHash}`,
    );
  }

  if (event.workflowId) {
    return withWorkflowUpdate(stateDir, event.workflowId, () => {
      const { state } = readWorkflowSnapshot(stateDir, event.workflowId);

      const wfDir = workflowDirectory(stateDir, event.workflowId);
      const result = appendWorkflowEvent(wfDir, state, event);
      if (result === false) return false;
      saveWorkflowState(stateDir, event.workflowId, state);
      return true;
    });
  } else {
    const consumedDir = path.join(
      stateDir,
      "documents",
      event.kickoffId,
      "consumed-events",
    );
    const consumedFile = path.join(consumedDir, `${event.id}.json`);
    if (fs.existsSync(consumedFile)) {
      return false;
    }
    fs.mkdirSync(consumedDir, { recursive: true });
    writeJSON(consumedFile, event);
    return true;
  }
}
