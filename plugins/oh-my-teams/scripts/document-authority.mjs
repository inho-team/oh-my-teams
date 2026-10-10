/**
 * Structured document CLI paths and write authority.
 * @module document-authority
 */
import fs from "node:fs";
import path from "node:path";
import {
  assert,
  canonicalRole,
  definedRoles,
  fileSha256,
  inside,
  readJSON,
} from "./core.mjs";
import { documentDirectory, documentState, parseDocId } from "./documents.mjs";
import { readWorkflow } from "./workflow.mjs";

// 3.4절이 정한 stage/docType별 작성 권한 표. 조합이 여기 없으면(예: delivery/delivery-ref는
// 표의 어느 역할 행에도 배정되지 않았다) 역할을 제한하지 않는다. design/design-contract는
// 3.4절이 "이번 실행에 하위 역할이 하나도 없을 때만 PM이 직접 쓸 수 있다"는 로스터 조건을
// 추가로 붙이며, 그 조건은 assertPmRosterCondition(3.4.2절)이 판정한다.
const DOCUMENT_AUTHOR_ROLES = {
  "planning/kickoff-brief-ref": ["director", "pm"],
  "design/design-contract": ["senior", "worker", "pm"],
  "implementation/workflow-task-ref": [
    "pm",
    "pl",
    "senior",
    "junior",
    "worker",
  ],
  "implementation/integration-ref": ["pm", "pl", "senior", "junior", "worker"],
  "review/review-ref": ["senior", "worker"],
  "acceptance/acceptance-ref": ["pm"],
  "closure/closure-record": ["director"],
};

// PL의 03. 구현 수정 권한은 "배정 관련 필드만"으로 문서 전체가 아니라 특정 필드에 한정되므로
// (3.4절), own-document 검사(직전 revision을 쓴 실행만 다음 revision을 쓸 수 있다는 제약)
// 자체는 PL을 여전히 예외로 둔다(PM이 첫 revision을, 다른 실행의 PL이 다음 revision을 쓰는
// 정상 흐름을 막지 않기 위함, 3.4.3절). 문서 전체가 아니라 필드만 제한하는 쪽은 별도로
// assertPlFieldScope가 판정한다. 05. 수용은 표가 "PM 전용"이라고만 적어 특정 PM 실행에
// 고정하지 않으므로 예외로 둔다.
function ownDocumentExempt(role, stageSlug) {
  return role === "pl" || stageSlug === "acceptance";
}

// 3.4.3절이 PL의 "배정 관련 필드"로 고정한 필드 목록. 여기 없는 stage/docType 조합에는
// assertPlFieldScope가 아무 제약도 걸지 않는다.
const PL_MUTABLE_FIELDS = {
  "implementation/workflow-task-ref": ["attemptRefs"],
  "implementation/integration-ref": ["taskHashRef", "extensionHistory"],
};

// 저장 계층이 강제하거나(revision, basedOnRevision) 매 저장마다 호출자가 새로 채워 넣어
// 직전 값과 자연히 달라지는 입력값(createdAt, author)이라 필드 비교에서 항상 제외한다
// (3.4.3절 세 번째 문단).
const PL_FIELD_SCOPE_ALWAYS_EXCLUDED = [
  "revision",
  "basedOnRevision",
  "createdAt",
  "author",
];

function withoutFields(source, fields) {
  const copy = { ...source };
  for (const field of fields) delete copy[field];
  return copy;
}

// PL이 쓰는 다음 revision에서 PL_MUTABLE_FIELDS가 허용한 필드(와 저장 계층 관리 필드)를
// 뺀 나머지가 직전 revision과 완전히 같은지 JSON.stringify 동등 비교로 판정한다(3.4.3절).
function assertPlFieldScope(priorDoc, doc, stageDocType) {
  const mutableFields = PL_MUTABLE_FIELDS[stageDocType];
  if (mutableFields === undefined) return;
  const excluded = [...PL_FIELD_SCOPE_ALWAYS_EXCLUDED, ...mutableFields];
  assert(
    JSON.stringify(withoutFields(priorDoc, excluded)) ===
      JSON.stringify(withoutFields(doc, excluded)),
    `PL may only change ${mutableFields.join(" and ")} in the next revision of ${stageDocType} (structured-omt-documents.md 3.4.3)`,
  );
}

// 3.4.2절이 정한 이번 실행의 역할 목록 판정: doc.workflowId가 있으면 그 워크플로 스냅샷의
// state.roles(없으면 스냅샷의 organization으로 definedRoles), 없으면 orgFile이 가리키는
// 조직 파일로 definedRoles를 구한다. 어느 쪽도 읽지 못하면(orgFile 부재·읽기 실패·워크플로
// 없음) 저장을 거부하는 것이 이 함수를 부르는 쪽의 몫이므로 여기서는 오류를 그대로 던진다.
function runRoleRoster(stateDir, workflowId, orgFile) {
  if (workflowId) {
    let snapshot;
    try {
      snapshot = readWorkflow(stateDir, workflowId);
    } catch (error) {
      throw new Error(
        `Cannot read workflow ${workflowId} to resolve this run's role roster (structured-omt-documents.md 3.4.2): ${error.message}`,
      );
    }
    return snapshot.state.roles ?? definedRoles(snapshot.organization);
  }
  assert(
    orgFile !== undefined,
    "Cannot resolve this run's role roster: doc.workflowId is not set and --org was not given (structured-omt-documents.md 3.4.2)",
  );
  let org;
  try {
    org = readJSON(path.resolve(orgFile));
  } catch (error) {
    throw new Error(
      `Cannot read organization file ${orgFile} to resolve this run's role roster (structured-omt-documents.md 3.4.2): ${error.message}`,
    );
  }
  return definedRoles(org);
}

// design/design-contract를 PM이 직접 쓰려면 이번 실행의 역할 목록에 pl·senior·junior가
// 하나도 없어야 한다(3.4절 PM 행, 3.4.2절). 역할 목록을 얻지 못하면(runRoleRoster가 던짐)
// 그 오류가 그대로 저장을 거부한다.
function assertPmRosterCondition(stateDir, doc, orgFile) {
  const roster = runRoleRoster(stateDir, doc.workflowId, orgFile).map(
    canonicalRole,
  );
  assert(
    !roster.includes("pl") &&
      !roster.includes("senior") &&
      !roster.includes("junior") &&
      !roster.includes("worker"),
    "PM may not author design/design-contract while this run's role roster includes pl, senior, junior, or worker (structured-omt-documents.md 3.4.2)",
  );
}

/**
 * Enforces the document-layer write authority and independence rules
 * structured-omt-documents.md 3.4 assigns, using the envelope about to be
 * saved, files already on disk under `stateDir`, and (only for the PM
 * design/design-contract roster condition) the workflow snapshot or `--org`
 * organization file named by `orgFile`.
 *
 * @param {string} stateDir - PM worktree `.omt` state directory.
 * @param {object} doc - Envelope about to be saved (already bound for `saveDocument`).
 * @param {string} [orgFile] - `--org` path; read only when `doc.workflowId`
 *   is unset and the author is a PM writing design/design-contract.
 * @returns {void} The write is allowed when no error is thrown.
 * @throws {Error} When the author's role may not write this stage/docType, the
 *   PM roster condition rejects a design/design-contract save, a different
 *   execution than the document's own author is revising it, a PL's next
 *   revision changes a field outside 3.4.3's allowed list, or a review-ref
 *   names an implementation execution that matches its own author.
 */
export function assertDocumentAuthority(stateDir, doc, orgFile) {
  const { docType } = parseDocId(doc.docId);
  const stageDocType = `${doc.stage}/${docType}`;
  const allowedRoles = DOCUMENT_AUTHOR_ROLES[stageDocType];
  if (allowedRoles !== undefined) {
    assert(
      allowedRoles.includes(doc.author.role),
      `Role ${doc.author.role} may not author ${stageDocType} documents (structured-omt-documents.md 3.4)`,
    );
  }

  if (doc.author.role === "pm" && stageDocType === "design/design-contract") {
    assertPmRosterCondition(stateDir, doc, orgFile);
  }

  const current = documentState(stateDir, doc.docId);
  if (current.exists) {
    const priorDoc = readJSON(
      path.join(
        documentDirectory(stateDir, doc.docId),
        "revisions",
        `${current.revision}.json`,
      ),
    );
    if (!ownDocumentExempt(doc.author.role, doc.stage)) {
      assert(
        priorDoc.author?.executionId === doc.author.executionId,
        `Only the execution that authored ${doc.docId} may write its next revision (structured-omt-documents.md 3.4)`,
      );
    }
    if (doc.author.role === "pl") {
      assertPlFieldScope(priorDoc, doc, stageDocType);
    }
  }

  if (stageDocType === "review/review-ref") {
    const { localId } = parseDocId(doc.docId);
    const reference = doc.reviewFileRef;
    const reviewRelativePath = `reviews/${localId}.json`;
    // Existing review-ref documents use both state-relative and project-relative spellings.
    const referencePath =
      reference?.path === reviewRelativePath ||
      reference?.path === `.omt/${reviewRelativePath}`
        ? reviewRelativePath
        : null;
    assert(
      reference &&
        typeof reference === "object" &&
        !Array.isArray(reference) &&
        referencePath &&
        typeof reference.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(reference.sha256),
      "reviewFileRef must name the backing review with its SHA-256 digest",
    );
    const reviewPath = inside(stateDir, referencePath);
    assert(fs.existsSync(reviewPath), "reviewFileRef target does not exist");
    assert(
      fileSha256(reviewPath) === reference.sha256,
      "reviewFileRef SHA-256 does not match the backing review",
    );
    const review = readJSON(reviewPath);
    assert(review.id === localId, "reviewFileRef names a different review");
    assert(
      review.reviewer?.executionId === doc.author.executionId,
      "review-ref author must be the backing review's execution",
    );
    assert(
      typeof review.implementationExecutionId === "string" &&
        review.implementationExecutionId.trim(),
      "Backing review must name an implementation execution",
    );
    assert(
      review.implementationExecutionId !== doc.author.executionId,
      "Independent review must use a different execution identity (structured-omt-documents.md 3.4)",
    );
  }
}
