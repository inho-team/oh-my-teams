/**
 * @module
 * Work item management.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, readJSON } from "./core.mjs";
import {
  documentDirectory,
  saveDocument,
  documentState,
  parseDocId,
} from "./documents.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Validates a document against its schema.
 * @param {object} doc
 * @param {string} schemaName
 */
function validateDocument(doc, schemaName) {
  const schemaPath = path.join(__dirname, "..", "schemas", schemaName);
  const schema = readJSON(schemaPath);

  assert(doc && typeof doc === "object", "Document must be an object");

  if (schema.required) {
    for (const req of schema.required) {
      assert(doc[req] !== undefined, `Document missing required field: ${req}`);
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(doc)) {
      assert(
        schema.properties[key] !== undefined,
        `Document has additional property: ${key}`,
      );
    }
  }

  function validateProperty(val, propSchema, pathStr) {
    if (propSchema.const !== undefined) {
      assert(
        val === propSchema.const,
        `Field ${pathStr} must be ${propSchema.const}`,
      );
    }
    if (propSchema.enum !== undefined) {
      assert(
        propSchema.enum.includes(val),
        `Field ${pathStr} must be one of ${propSchema.enum.join(",")}`,
      );
    }
    const types = Array.isArray(propSchema.type)
      ? propSchema.type
      : propSchema.type
        ? [propSchema.type]
        : [];
    if (types.length > 0) {
      let typeValid = false;
      for (const t of types) {
        if (t === "string" && typeof val === "string") typeValid = true;
        if (t === "integer" && Number.isInteger(val)) typeValid = true;
        if (t === "array" && Array.isArray(val)) typeValid = true;
        if (t === "null" && val === null) typeValid = true;
        if (
          t === "object" &&
          typeof val === "object" &&
          val !== null &&
          !Array.isArray(val)
        )
          typeValid = true;
      }
      if (!propSchema.oneOf) {
        assert(
          typeValid,
          `Field ${pathStr} has invalid type, expected ${types.join(" or ")}`,
        );
      }
    }
    if (propSchema.oneOf) {
      let oneOfValid = false;
      for (const choice of propSchema.oneOf) {
        try {
          validateProperty(val, choice, pathStr);
          oneOfValid = true;
          break;
        } catch (e) {}
      }
      assert(oneOfValid, `Field ${pathStr} does not match any oneOf schemas`);
    }
    if (typeof val === "string") {
      if (propSchema.minLength !== undefined) {
        assert(
          val.length >= propSchema.minLength,
          `Field ${pathStr} length < ${propSchema.minLength}`,
        );
      }
      if (propSchema.pattern !== undefined) {
        const regex = new RegExp(propSchema.pattern);
        assert(
          regex.test(val),
          `Field ${pathStr} does not match pattern ${propSchema.pattern}`,
        );
      }
      if (propSchema.format === "date-time") {
        assert(
          !isNaN(Date.parse(val)),
          `Field ${pathStr} must be a valid date-time string`,
        );
      }
    }
    if (typeof val === "number") {
      if (propSchema.minimum !== undefined) {
        assert(
          val >= propSchema.minimum,
          `Field ${pathStr} < minimum ${propSchema.minimum}`,
        );
      }
    }
    if (Array.isArray(val) && propSchema.items) {
      for (let i = 0; i < val.length; i++) {
        validateProperty(val[i], propSchema.items, `${pathStr}[${i}]`);
      }
    }
  }

  for (const [key, propSchema] of Object.entries(schema.properties || {})) {
    if (doc[key] !== undefined) {
      validateProperty(doc[key], propSchema, key);
    }
  }

  if (
    doc.author &&
    typeof doc.author === "object" &&
    schema.$defs &&
    schema.$defs.author
  ) {
    const authorDef = schema.$defs.author;
    if (authorDef.required) {
      for (const req of authorDef.required) {
        assert(
          doc.author[req] !== undefined,
          `Author missing required field: ${req}`,
        );
      }
    }
    if (authorDef.additionalProperties === false) {
      for (const key of Object.keys(doc.author)) {
        assert(
          authorDef.properties[key] !== undefined,
          `Author has additional property: ${key}`,
        );
      }
    }
    for (const [key, propSchema] of Object.entries(
      authorDef.properties || {},
    )) {
      if (doc.author[key] !== undefined) {
        validateProperty(doc.author[key], propSchema, `author.${key}`);
      }
    }
  }
}

/**
 * Saves a work item.
 * @param {string} stateDir
 * @param {object} doc
 * @param {object} options
 * @returns {object}
 */
export function saveWorkItem(stateDir, doc, options = {}) {
  const parsed = parseDocId(doc.docId);
  assert(parsed.docType === "work-item", "docId must be a work-item");
  validateDocument(doc, "work-item.schema.json");
  return saveDocument(stateDir, doc, options);
}

/**
 * Gets a document's content at its current revision.
 * @param {string} stateDir
 * @param {string} docId
 * @returns {object|null}
 */
export function getDocumentContent(stateDir, docId) {
  const state = documentState(stateDir, docId);
  if (!state.exists) return null;
  const dir = documentDirectory(stateDir, docId);
  const revFile = path.join(dir, `revisions/${state.revision}.json`);
  return readJSON(revFile);
}

/**
 * Lists all work items under a kickoff and workflow.
 * @param {string} stateDir
 * @param {string} kickoffHash
 * @param {string|null} workflowId
 * @returns {Array<object>}
 */
export function listWorkItems(stateDir, kickoffHash, workflowId) {
  assert(
    typeof kickoffHash === "string" && /^[a-f0-9]{64}$/.test(kickoffHash),
    "kickoffHash must be a 64-character hex string",
  );
  if (workflowId !== null) {
    assert(
      typeof workflowId === "string" && /^[a-z0-9][a-z0-9-]*$/.test(workflowId),
      "workflowId must be null or a valid id",
    );
  }

  const docs = [];
  const baseDir = path.join(
    stateDir,
    "documents",
    kickoffHash,
    workflowId ?? "none",
  );
  if (!fs.existsSync(baseDir)) return docs;

  const docType = "work-item";
  for (const stageFolder of fs.readdirSync(baseDir)) {
    const typeDir = path.join(baseDir, stageFolder, docType);
    if (!fs.existsSync(typeDir)) continue;

    for (const localId of fs.readdirSync(typeDir)) {
      const currentFile = path.join(typeDir, localId, "current.json");
      if (fs.existsSync(currentFile)) {
        const current = readJSON(currentFile);
        if (current.revision > 0) {
          const revFile = path.join(
            typeDir,
            localId,
            `revisions/${current.revision}.json`,
          );
          if (fs.existsSync(revFile)) {
            const doc = readJSON(revFile);
            const parsed = parseDocId(doc.docId);
            if (
              parsed.kickoffHash === kickoffHash &&
              parsed.workflowId === workflowId &&
              parsed.docType === docType
            ) {
              docs.push(doc);
            }
          }
        }
      }
    }
  }
  return docs;
}
