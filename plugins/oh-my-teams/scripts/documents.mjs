/**
 * Structured `.omt` document runtime: docId/docRef identifiers, deterministic
 * stage folders, append-only revisions with lock and transaction-journal
 * atomicity, reference-integrity checks, and the legacyRef compatibility rule.
 *
 * Implements docs/plan/structured-omt-documents.md 3.2, 3.5-3.11. The stage
 * folder names below are a product-canonical asset (3.8): this module is the
 * only place that converts between a `stageSlug` (logical identifier) and its
 * `01. 기획`..`07. 종료` folder name (real storage path segment).
 */
import fs from "node:fs";
import path from "node:path";
import {
  assert,
  hash,
  inside,
  readJSON,
  withFileLock,
  writeJSON,
} from "./core.mjs";
import { WORKFLOW_ID_PATTERN, workflowDirectory } from "./workflow-store.mjs";
// kickoff-registry.mjs imports documentState/deliveryRefDocId from this module
// back, forming a circular import (3.7 item 4's "documents.mjs와
// kickoff-registry.mjs를 한 작업으로 묶는다" choice exists for this reason).
// Node's ESM loader resolves both modules' bindings before either body runs,
// so this is safe as long as neither side reads the other's export from its
// own top-level code, only from inside a function that runs later; every use
// below is inside resolveKickoffHash's body.
import { kickoffHashFor, listKickoffs } from "./kickoff-registry.mjs";

/** Logical stage identifiers used by `docId`/`docRef`, never by the filesystem (3.5). */
export const STAGE_SLUGS = Object.freeze([
  "planning",
  "design",
  "implementation",
  "review",
  "acceptance",
  "delivery",
  "closure",
]);

/** States a document's common envelope may hold (3.3). */
export const DOCUMENT_STATES = Object.freeze(["open", "in-review", "resolved"]);

/** `stageSlug` to the real, git-tracked folder name a document lives under (3.5, 3.8). */
export const STAGE_FOLDER_NAMES = Object.freeze({
  planning: "01. 기획",
  design: "02. 설계",
  implementation: "03. 구현",
  review: "04. 검토",
  acceptance: "05. 수용",
  delivery: "06. 인도",
  closure: "07. 종료",
});

const HEX64 = /^[a-f0-9]{64}$/;
const DOC_TYPE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const AUTHOR_ROLES = ["director", "pm", "pl", "senior", "junior", "worker"];

/**
 * Maps a `stageSlug` to its real, NFC-normalized storage folder name.
 *
 * @param {string} stageSlug - One of `STAGE_SLUGS`.
 * @returns {string} Folder name, normalized to NFC (3.9).
 * @throws {Error} When `stageSlug` is not one of `STAGE_SLUGS`.
 */
export function stageFolderName(stageSlug) {
  const folder = STAGE_FOLDER_NAMES[stageSlug];
  assert(folder, `Unknown document stage: ${stageSlug}`);
  return folder.normalize("NFC");
}

/**
 * Assembles a document's logical identifier from its components (3.5).
 *
 * @param {object} parts - Document identity.
 * @param {string} parts.kickoffHash - 64-character hex kickoff hash.
 * @param {?string} [parts.workflowId] - Workflow id, or `null` before a workflow exists.
 * @param {string} parts.stageSlug - One of `STAGE_SLUGS`.
 * @param {string} parts.docType - Lowercase document type slug.
 * @param {string} parts.localId - Type-specific local identifier (3.7 item 5).
 * @returns {string} `docId` string.
 * @throws {Error} When any component is missing or malformed.
 */
export function buildDocId({
  kickoffHash,
  workflowId = null,
  stageSlug,
  docType,
  localId,
}) {
  assert(
    HEX64.test(kickoffHash),
    "kickoffHash must be a 64-character hex string",
  );
  assert(
    workflowId === null || WORKFLOW_ID_PATTERN.test(workflowId),
    "workflowId must be null or a valid workflow id",
  );
  assert(
    STAGE_SLUGS.includes(stageSlug),
    `stageSlug must be one of: ${STAGE_SLUGS.join(", ")}`,
  );
  assert(DOC_TYPE_PATTERN.test(docType), "docType must be a lowercase slug");
  assert(
    typeof localId === "string" && localId.length > 0 && !localId.includes("/"),
    "localId is required and must not contain '/'",
  );
  return `${kickoffHash}/${workflowId ?? "none"}/${stageSlug}/${docType}/${localId}`;
}

/**
 * Splits a `docId` back into its typed, validated components.
 *
 * @param {string} docId - Value produced by `buildDocId`.
 * @returns {{kickoffHash: string, workflowId: ?string, stageSlug: string, docType: string, localId: string}}
 * Parsed components.
 * @throws {Error} When `docId` does not have exactly five segments or a segment is malformed.
 */
export function parseDocId(docId) {
  assert(typeof docId === "string" && docId.length > 0, "docId is required");
  const parts = docId.split("/");
  assert(
    parts.length === 5,
    "docId must have exactly five '/'-separated segments",
  );
  const [kickoffHash, workflowSegment, stageSlug, docType, localId] = parts;
  assert(
    HEX64.test(kickoffHash),
    "docId's kickoffHash segment must be a 64-character hex string",
  );
  const workflowId = workflowSegment === "none" ? null : workflowSegment;
  assert(
    workflowId === null || WORKFLOW_ID_PATTERN.test(workflowId),
    "docId's workflow segment must be 'none' or a valid workflow id",
  );
  assert(
    STAGE_SLUGS.includes(stageSlug),
    `docId's stage segment must be one of: ${STAGE_SLUGS.join(", ")}`,
  );
  assert(
    DOC_TYPE_PATTERN.test(docType),
    "docId's docType segment must be a lowercase slug",
  );
  assert(localId.length > 0, "docId's localId segment is required");
  return { kickoffHash, workflowId, stageSlug, docType, localId };
}

/**
 * Builds the `omt-doc:` reference string naming one revision of a document (3.6).
 *
 * @param {string} docId - Target document's `docId`.
 * @param {number} revision - Revision number the reference pins to.
 * @returns {string} `omt-doc:<docId>@r<revision>` reference string.
 * @throws {Error} When `revision` is not a positive integer.
 */
export function buildDocRef(docId, revision) {
  parseDocId(docId);
  assert(
    Number.isInteger(revision) && revision >= 1,
    "revision must be a positive integer",
  );
  return `omt-doc:${docId}@r${revision}`;
}

/**
 * Parses an `omt-doc:` reference string into its document components and revision.
 *
 * @param {string} ref - Reference string produced by `buildDocRef`.
 * @returns {{kickoffHash: string, workflowId: ?string, stageSlug: string, docType: string,
 *   localId: string, docId: string, revision: number}} Parsed reference.
 * @throws {Error} When `ref` is not a well-formed `omt-doc:` reference.
 */
export function parseDocRef(ref) {
  assert(
    typeof ref === "string" && ref.startsWith("omt-doc:"),
    "Reference must start with omt-doc:",
  );
  const body = ref.slice("omt-doc:".length);
  const at = body.lastIndexOf("@r");
  assert(at !== -1, "Reference must end with @r<revision>");
  const docId = body.slice(0, at);
  const revisionText = body.slice(at + 2);
  assert(
    /^[0-9]+$/.test(revisionText),
    "Reference revision must be a non-negative integer",
  );
  const revision = Number(revisionText);
  assert(revision >= 1, "Reference revision must be at least 1");
  return { ...parseDocId(docId), docId, revision };
}

/**
 * Derives the `docId` a kickoff's delivery-ref document lives at (3.7 item 5).
 *
 * `localId` is the kickoff registry's `entry.delivered.mergeCommit`, which
 * `recordDelivery` already fixes as effectively immutable, so no new field is
 * written anywhere to hold this reference.
 *
 * @param {string} kickoffHash - Kickoff's `kickoffHash`.
 * @param {string} mergeCommit - `entry.delivered.mergeCommit` from the kickoff registry.
 * @returns {string} The delivery-ref document's `docId`.
 */
export function deliveryRefDocId(kickoffHash, mergeCommit) {
  return buildDocId({
    kickoffHash,
    workflowId: null,
    stageSlug: "delivery",
    docType: "delivery-ref",
    localId: mergeCommit,
  });
}

/**
 * Resolves the `kickoffHash` a worktree's currently active kickoff writes documents under (3.7 contract A).
 *
 * Reads only the active registry (`listKickoffs`), never an archived entry: a
 * released kickoff's documents are found through its closure-record's own
 * `kickoffId` field instead (3.7 item 5, "history/ 이관 이후").
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree id whose active kickoff is resolved.
 * @returns {string} 64-character hex `kickoffHash`.
 * @throws {Error} When the worktree holds no active kickoff.
 */
export function resolveKickoffHash(orgFile, worktreeId) {
  const { kickoffs } = listKickoffs(orgFile, worktreeId);
  const entry = kickoffs[0];
  assert(
    entry,
    `Worktree ${worktreeId} has no active kickoff to resolve documents for; ` +
      "a released kickoff's documents are found through its closure-record kickoffId instead",
  );
  return kickoffHashFor(entry);
}

/**
 * Resolves the canonical storage directory of a structured document.
 * @param {string} stateDir - PM state directory.
 * @param {string} docId - Structured document identifier.
 * @returns {string} Document directory.
 */
export function documentDirectory(stateDir, docId) {
  const { kickoffHash, workflowId, stageSlug, docType, localId } =
    parseDocId(docId);
  const folder = stageFolderName(stageSlug);
  return path.join(
    stateDir,
    "documents",
    kickoffHash,
    workflowId ?? "none",
    folder,
    docType,
    localId,
  );
}

function kickoffDocumentsRoot(stateDir, kickoffHash) {
  return path.join(stateDir, "documents", kickoffHash);
}

function documentLockPath(stateDir, { workflowId, kickoffHash }) {
  return workflowId
    ? path.join(workflowDirectory(stateDir, workflowId), ".lock")
    : path.join(kickoffDocumentsRoot(stateDir, kickoffHash), ".lock");
}

function journalKey({ stageSlug, docType, localId }) {
  return `${stageSlug}-${docType}-${localId.replace(/[^a-zA-Z0-9-]/g, "_")}`;
}

function documentJournalFile(stateDir, parsed) {
  const key = journalKey(parsed);
  return parsed.workflowId
    ? path.join(
        workflowDirectory(stateDir, parsed.workflowId),
        "documents",
        `${key}.transaction.json`,
      )
    : path.join(
        kickoffDocumentsRoot(stateDir, parsed.kickoffHash),
        "transactions",
        `${key}.json`,
      );
}

// Same journal-then-apply-then-delete shape as workflow-store.mjs's
// recoverTransaction (3.7 item 4), reimplemented because that function
// requires a WORKFLOW_ID_PATTERN id and the state.json/events/ layout, which
// workflowId: null documents (01. 기획/02. 설계) never have.
function recoverDocumentTransaction(journalFile) {
  if (!fs.existsSync(journalFile)) return;
  const transaction = readJSON(journalFile);
  if (!fs.existsSync(transaction.revisionFile)) {
    writeJSON(transaction.revisionFile, transaction.doc);
  }
  if (transaction.events) {
    const baseDir = path.dirname(path.dirname(journalFile));
    const eventsDir = path.join(baseDir, "events");
    const undeliveredDir = path.join(eventsDir, "undelivered");
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.mkdirSync(undeliveredDir, { recursive: true });
    for (const event of transaction.events) {
      const eventFile = path.join(eventsDir, `${event.id}.json`);
      const undeliveredFile = path.join(undeliveredDir, `${event.id}.json`);
      if (!fs.existsSync(eventFile)) {
        writeJSON(eventFile, event);
      }
      if (!fs.existsSync(undeliveredFile)) {
        writeJSON(undeliveredFile, event);
      }
    }
  }
  writeJSON(transaction.currentFile, transaction.current);
  fs.unlinkSync(journalFile);
}

function commitDocumentTransaction(journalFile, transaction) {
  writeJSON(journalFile, transaction);
  recoverDocumentTransaction(journalFile);
}

// documentStateAt(..., withLock: false) is used by saveDocument to read a
// reference target's state without re-entering a lock file it may already
// hold (core.mjs's acquireFileLock is not reentrant).
function documentStateAt(stateDir, docId, withLock) {
  const parsed = parseDocId(docId);
  const directory = documentDirectory(stateDir, docId);
  const journalFile = documentJournalFile(stateDir, parsed);
  const currentFile = path.join(directory, "current.json");
  const read = () => {
    recoverDocumentTransaction(journalFile);
    if (!fs.existsSync(currentFile)) return { exists: false };
    const current = readJSON(currentFile);
    const doc = readJSON(
      path.join(directory, "revisions", `${current.revision}.json`),
    );
    return {
      exists: true,
      revision: current.revision,
      hash: current.hash,
      state: doc.state,
      kickoffId: doc.kickoffId,
      workflowId: doc.workflowId,
    };
  };
  if (!withLock) return read();
  return withFileLock(
    documentLockPath(stateDir, parsed),
    read,
    "Document update in progress; read it again",
  );
}

/**
 * Reads a document's current committed state (3.7 item 5, the "새 documentState 계약").
 *
 * First completes any pending transaction-journal write for this document
 * (3.7 item 4), then reports whether it exists and, when it does, its
 * revision, content hash, envelope `state`, and owning `kickoffId`/`workflowId`
 * (3.7 contract B: journal-applied existence plus the fields a caller needs to
 * confirm business-state approval and ownership on its own).
 *
 * @param {string} stateDir - PM worktree `.omt` state directory.
 * @param {string} docId - Document identifier to look up.
 * @returns {{exists: boolean, revision?: number, hash?: string, state?: string,
 *   kickoffId?: string, workflowId?: ?string}} Current document state.
 * @throws {Error} When `docId` is malformed.
 */
export function documentState(stateDir, docId) {
  return documentStateAt(stateDir, docId, true);
}

function validateEnvelope(doc) {
  assert(doc && typeof doc === "object", "Document is required");
  assert(doc.schemaVersion === 1, "Document schemaVersion 1 is required");
  assert(
    STAGE_SLUGS.includes(doc.stage),
    `Document stage must be one of: ${STAGE_SLUGS.join(", ")}`,
  );
  assert(
    HEX64.test(doc.kickoffId),
    "Document kickoffId must be a 64-character hex string",
  );
  assert(
    doc.workflowId === null || WORKFLOW_ID_PATTERN.test(doc.workflowId),
    "Document workflowId must be null or a valid workflow id",
  );
  assert(
    Number.isInteger(doc.revision) && doc.revision >= 1,
    "Document revision must be a positive integer",
  );
  assert(
    DOCUMENT_STATES.includes(doc.state),
    `Document state must be one of: ${DOCUMENT_STATES.join(", ")}`,
  );
  assert(
    doc.author &&
      AUTHOR_ROLES.includes(doc.author.role) &&
      typeof doc.author.executionId === "string" &&
      doc.author.executionId,
    "Document author.role and author.executionId are required",
  );
  assert(
    typeof doc.createdAt === "string" && doc.createdAt,
    "Document createdAt is required",
  );
  assert(
    doc.basedOnRevision === null ||
      (Number.isInteger(doc.basedOnRevision) && doc.basedOnRevision >= 1),
    "Document basedOnRevision must be null or a positive integer",
  );
  assert(
    typeof doc.reason === "string" && doc.reason,
    "Document reason is required",
  );
  assert(
    doc.docId === buildDocId(parseDocId(doc.docId)),
    "Document docId must be well-formed",
  );
  const parsed = parseDocId(doc.docId);
  assert(
    doc.kickoffId === parsed.kickoffHash,
    "Document kickoffId must match its docId's kickoffHash segment",
  );
  assert(
    doc.workflowId === parsed.workflowId,
    "Document workflowId must match its docId's workflow segment",
  );
  assert(
    doc.stage === parsed.stageSlug,
    "Document stage must match its docId's stage segment",
  );
}

function validateReference(stateDir, doc, ref, ownLock) {
  const target = parseDocRef(ref);
  assert(
    target.kickoffHash === doc.kickoffId,
    `Reference ${ref} points at a different kickoff`,
  );
  assert(
    target.workflowId === null || target.workflowId === doc.workflowId,
    `Reference ${ref} points at a different workflow`,
  );
  const sameLock = documentLockPath(stateDir, target) === ownLock;
  const state = documentStateAt(stateDir, target.docId, !sameLock);
  assert(
    state.exists,
    `Reference ${ref} points at a document that does not exist`,
  );
  assert(
    state.revision === target.revision,
    `Reference ${ref} names revision ${target.revision}, but the current revision is ${state.revision}`,
  );
  assert(
    state.kickoffId === target.kickoffHash &&
      state.workflowId === target.workflowId,
    `Reference ${ref} points at a document that does not own the identity its docId names`,
  );
  assert(
    state.state === "resolved",
    `Reference ${ref} points at a document that is not resolved (state: ${state.state})`,
  );
}

/**
 * Appends a new, append-only revision of a document (3.7 items 1-5).
 *
 * Validates the envelope, enforces optimistic concurrency against the
 * document's current revision (`expectedRevision`), verifies every reference
 * this revision names resolves to an existing, resolved, same-scope document
 * (3.6, before anything is written, so a rejected write leaves no trace), and
 * commits the new revision file and pointer atomically through a
 * transaction journal (3.7 item 4), all inside the document's `.lock`.
 *
 * @param {string} stateDir - PM worktree `.omt` state directory.
 * @param {object} doc - Full document envelope and body to persist as the next revision.
 * @param {object} [options] - Write options.
 * @param {?number} [options.expectedRevision] - Revision the caller last read;
 *   `null`/omitted means "no document exists yet".
 * @param {string[]} [options.refs] - `omt-doc:` references this revision names,
 *   checked for existence, resolved state, and ownership before the write commits.
 * @returns {{docId: string, revision: number, hash: string}} The committed revision's identity.
 * @throws {Error} When the envelope, concurrency check, or a reference fails.
 */
export function saveDocument(
  stateDir,
  doc,
  { expectedRevision = null, refs = [], requestId = null } = {},
) {
  validateEnvelope(doc);
  const parsed = parseDocId(doc.docId);
  assert(
    parsed.docType !== "task-comment",
    "task-comment documents are explicitly rejected",
  );
  const ownLock = documentLockPath(stateDir, parsed);
  return withFileLock(
    ownLock,
    () => {
      const directory = documentDirectory(stateDir, doc.docId);
      const journalFile = documentJournalFile(stateDir, parsed);
      recoverDocumentTransaction(journalFile);

      const currentFile = path.join(directory, "current.json");
      const current = fs.existsSync(currentFile)
        ? readJSON(currentFile)
        : { revision: 0, requestId: null, requestIds: {} };

      const allRequestIds = Object.assign({}, current.requestIds || {});
      if (current.requestId) {
        allRequestIds[current.requestId] = {
          revision: current.revision,
          hash: current.hash,
        };
      }

      if (requestId && allRequestIds[requestId]) {
        return {
          docId: doc.docId,
          revision: allRequestIds[requestId].revision,
          hash: allRequestIds[requestId].hash,
        };
      }
      const priorRevision = current.revision;
      let priorState = null;
      if (priorRevision > 0) {
        priorState = readJSON(
          path.join(directory, "revisions", `${priorRevision}.json`),
        ).state;
      }
      const normalizedExpected = expectedRevision ?? 0;
      assert(
        normalizedExpected === priorRevision,
        `Document changed; current revision is ${priorRevision}, read it again before writing`,
      );
      assert(
        doc.revision === priorRevision + 1,
        `Document revision must be ${priorRevision + 1}, not ${doc.revision}`,
      );
      assert(
        doc.basedOnRevision === (priorRevision || null),
        "Document basedOnRevision must name the revision this one is based on",
      );

      for (const ref of refs) validateReference(stateDir, doc, ref, ownLock);

      const revisionFile = path.join(
        directory,
        "revisions",
        `${doc.revision}.json`,
      );
      const docHash = hash(doc);
      const events = [];
      const createEvent = (type, payload) => {
        const hex = hash(doc.docId + doc.revision + type);
        const id = [
          hex.substring(0, 8),
          hex.substring(8, 12),
          hex.substring(12, 16),
          hex.substring(16, 20),
          hex.substring(20, 32),
        ].join("-");

        let causality = null;
        if (doc.revision > 1) {
          causality = { basedOnRevision: priorRevision };
        }

        return {
          id,
          schemaVersion: 1,
          type,
          kickoffId: doc.kickoffId,
          workflowId: doc.workflowId,
          recordedAt: new Date().toISOString(),
          author: doc.author,
          causality,
          revisionRef: buildDocRef(doc.docId, doc.revision),
          ...payload,
        };
      };

      if (priorRevision === 0) {
        events.push(
          createEvent("document.created", {
            docId: doc.docId,
            state: doc.state,
          }),
        );
      } else {
        events.push(
          createEvent("document.revised", {
            docId: doc.docId,
            revisionRef: buildDocRef(doc.docId, doc.revision),
            priorRevision,
          }),
        );
      }

      if (priorRevision > 0 && priorState !== doc.state) {
        events.push(
          createEvent("document.state-changed", {
            docId: doc.docId,
            priorState,
            newState: doc.state,
          }),
        );
      }

      if (requestId) {
        allRequestIds[requestId] = { revision: doc.revision, hash: docHash };
      }

      commitDocumentTransaction(journalFile, {
        revisionFile,
        doc,
        currentFile,
        current: {
          revision: doc.revision,
          hash: docHash,
          requestId: requestId || null,
          requestIds: allRequestIds,
        },
        events,
      });
      return { docId: doc.docId, revision: doc.revision, hash: docHash };
    },
    "Document update in progress; read it again",
  );
}

/**
 * Validates a `legacyRef` pointing at a pre-existing `.omt` file that predates
 * the structured document system (3.10).
 *
 * Confirms the referenced file exists inside `stateDir` (this doubles as the
 * kickoff-scope check, since `stateDir` is already one kickoff's own state
 * directory), that its `taskId` matches the referencing document's scope when
 * one is given, and that it was created before `organization.documentSystemActivatedAt`
 * when that field is set. A file created at or after activation must get a
 * structured document instead of a `legacyRef`.
 *
 * @param {string} stateDir - PM worktree `.omt` state directory the legacy file lives under.
 * @param {object} org - Organization object, for `documentSystemActivatedAt`.
 * @param {string} legacyRef - Path to the legacy file, relative to `stateDir`.
 * @param {object} [scope] - Expected scope of the legacy file.
 * @param {string} [scope.taskId] - Task id the legacy file must belong to, when known.
 * @returns {{legacyRef: string, record: object}} The validated reference and its parsed content.
 * @throws {Error} When the file is missing, escapes `stateDir`, is out of scope, or postdates activation.
 */
export function validateLegacyRef(stateDir, org, legacyRef, scope = {}) {
  const resolved = inside(stateDir, legacyRef);
  assert(
    fs.existsSync(resolved),
    `legacyRef target does not exist: ${legacyRef}`,
  );
  const record = readJSON(resolved);
  if (scope.taskId !== undefined) {
    assert(
      record.taskId === scope.taskId,
      `legacyRef target ${legacyRef} belongs to task ${record.taskId}, not ${scope.taskId}`,
    );
  }
  const activatedAt = org?.documentSystemActivatedAt;
  if (activatedAt) {
    assert(
      typeof record.createdAt === "string" && record.createdAt < activatedAt,
      `legacyRef target ${legacyRef} was created at or after documentSystemActivatedAt (${activatedAt}); ` +
        "it needs a structured document, not a legacyRef",
    );
  }
  return { legacyRef, record };
}
