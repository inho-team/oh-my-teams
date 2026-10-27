/** Enforces OMT report invariants and renders validated data as standalone HTML. */

/**
 * Checks schema and semantic invariants without treating reports as authoritative state.
 * @param {object} value - Parsed message object.
 * @param {(value: object) => string[]} schemaErrors - JSON Schema validation port.
 * @returns {object} The unchanged document when valid.
 */
export function assertOmtDocument(value, schemaErrors) {
  const errors = schemaErrors(value);
  if (errors.length) throw new SyntaxError(errors.join("\n"));
  const { kind, payload, subject, issuer } = value;
  const ensure = (condition, message) => {
    if (!condition) throw new SyntaxError(message);
  };
  if (kind.startsWith("review_")) {
    if (payload.purpose === "auditor") {
      ensure(
        subject.commit,
        "auditor documents require a fixed subject.commit",
      );
      ensure(
        subject.implementation_session_id,
        "auditor documents require subject.implementation_session_id",
      );
      ensure(
        payload.acceptance_criteria?.length || kind === "review_result",
        "auditor requests require acceptance criteria",
      );
    }
    if (kind === "review_result") {
      if (payload.independent) {
        ensure(
          subject.commit && subject.implementation_session_id,
          "independent reviews require a commit and implementation session",
        );
        ensure(
          issuer.session_id !== subject.implementation_session_id,
          "the implementation session cannot claim independent review",
        );
      }
      if (payload.conclusion === "no_findings")
        ensure(!payload.findings.length, "no_findings cannot contain findings");
      if (payload.conclusion === "changes_requested")
        ensure(payload.findings.length, "changes_requested requires findings");
      if (payload.conclusion === "inconclusive")
        ensure(
          payload.uncertainties.length,
          "inconclusive requires uncertainties",
        );
    }
  } else if (kind === "status_report") {
    ensure(
      subject.worktree_id === payload.worktree.id,
      "subject and observed worktree IDs must match",
    );
    if (payload.observation !== "complete")
      ensure(
        payload.uncertainties.length,
        "incomplete observation requires uncertainties",
      );
    if (payload.observation === "failed") {
      ensure(
        payload.execution === "unknown" && payload.git === null,
        "failed observation requires unknown execution and null git",
      );
      ensure(
        payload.ci.every((item) => item.status === "unknown"),
        "failed observation cannot assert current CI results",
      );
    }
    for (const check of payload.ci) checkCi(check, payload.git?.head, ensure);
  } else {
    checkLifecycle(value, ensure);
  }
  if (
    ["status_report", "completion_report", "interruption_report"].includes(kind)
  ) {
    if (payload.delivery.state === "delivered")
      ensure(
        payload.delivery.reference,
        "delivered results require a reference",
      );
    if (payload.cleanup.state === "completed")
      ensure(
        !payload.cleanup.remaining.length,
        "completed cleanup cannot have remaining worktrees",
      );
    if (payload.cleanup.state === "preserved")
      ensure(
        payload.cleanup.remaining.length,
        "preserved cleanup requires remaining worktrees",
      );
  }
  return value;
}

function checkCi(check, head, ensure) {
  if (!["unregistered", "unknown"].includes(check.status))
    ensure(check.build_id, "observed CI execution requires build_id");
  if (check.status === "unregistered")
    ensure(check.build_id === null, "unregistered CI cannot have build_id");
  if (check.status === "passed") {
    ensure(
      check.source_commit && check.target_branch,
      "passed CI requires source_commit and target_branch",
    );
    ensure(
      check.source_commit === head,
      "passed CI must correspond to observed Git HEAD",
    );
  }
}

function checkLifecycle({ kind, subject, payload }, ensure) {
  ensure(subject.commit, "lifecycle documents require a fixed subject.commit");
  if (kind === "task_request") {
    ensure(
      new Set(payload.acceptance_criteria).size ===
        payload.acceptance_criteria.length,
      "task acceptance criteria must be unique",
    );
    ensure(
      new Set(payload.required_checks.map((item) => item.name)).size ===
        payload.required_checks.length,
      "required check names must be unique",
    );
    if (payload.delivery.mode === "none")
      ensure(
        payload.delivery.target === null,
        "no delivery must have null target",
      );
    else
      ensure(payload.delivery.target, "requested delivery requires a target");
    if (payload.delivery.mode === "merge")
      ensure(
        payload.delivery.authorization,
        "merge delivery requires recorded authorization",
      );
  } else if (kind === "completion_report") {
    const { acceptance_results: results, checks } = payload;
    ensure(
      new Set(results.map((item) => item.criterion)).size === results.length,
      "acceptance results must have unique criteria",
    );
    ensure(
      new Set(checks.map((item) => item.name)).size === checks.length,
      "completion check names must be unique",
    );
    for (const result of results)
      if (result.result === "met")
        ensure(
          result.evidence.length,
          "met acceptance criteria require evidence",
        );
    for (const check of checks)
      if (check.status === "passed")
        ensure(check.evidence.length, "passed checks require evidence");
    for (const check of payload.ci) checkCi(check, subject.commit, ensure);
    if (payload.outcome === "completed") {
      ensure(
        results.every((item) => item.result === "met"),
        "completed outcome requires all acceptance criteria to be met",
      );
      ensure(
        checks.every((item) => !item.required || item.status === "passed"),
        "completed outcome requires mandatory checks to pass",
      );
      ensure(
        payload.ci.every((item) => item.status === "passed"),
        "completed outcome requires CI approvals to pass",
      );
      ensure(
        !payload.remaining.length,
        "completed outcome cannot have remaining required work",
      );
    } else
      ensure(
        payload.remaining.length,
        "incomplete outcome requires remaining work",
      );
  } else {
    for (const session of payload.sessions) {
      if (session.action !== "preserved")
        ensure(
          session.stop_authorization,
          "stopping a session requires recorded authorization",
        );
      if (session.action === "stopped")
        ensure(
          session.liveness === "exited",
          "stopped sessions require confirmed exit",
        );
      if (session.liveness === "unknown")
        ensure(
          payload.uncertainties.length,
          "unknown session liveness requires uncertainties",
        );
    }
  }
}

/**
 * Checks a lifecycle report against the original task rather than a reduced scope.
 * @param {object} request - Validated task_request document.
 * @param {object} response - Validated completion_report or interruption_report document.
 * @returns {void} Throws when task identity, required criteria, checks, delivery, or cleanup differ.
 */
export function assertTaskResponse(request, response) {
  const ensure = (condition, message) => {
    if (!condition) throw new SyntaxError(message);
  };
  ensure(
    request.kind === "task_request" &&
      ["completion_report", "interruption_report"].includes(response.kind),
    "task correlation requires a task and a lifecycle report",
  );
  ensure(
    response.in_reply_to === request.id &&
      response.subject.worktree_id === request.subject.worktree_id,
    "lifecycle report must match task ID and worktree",
  );
  if (response.kind !== "completion_report") return;
  const { payload: task } = request;
  const { payload: report } = response;
  const criteria = report.acceptance_results.map((item) => item.criterion);
  ensure(
    criteria.length === task.acceptance_criteria.length &&
      task.acceptance_criteria.every((item) => criteria.includes(item)),
    "completion must preserve every requested acceptance criterion",
  );
  for (const expected of task.required_checks) {
    const check = report.checks.find((item) => item.name === expected.name);
    ensure(
      check && check.required && check.command === expected.command,
      "completion must preserve required check names and commands",
    );
  }
  if (report.outcome === "completed") {
    if (task.delivery.mode !== "none")
      ensure(
        report.delivery.state === "delivered",
        "completed task requires requested delivery",
      );
    if (task.cleanup_required)
      ensure(
        report.cleanup.state === "completed",
        "completed task requires requested cleanup",
      );
  }
}

/**
 * Correlates a validated review result with the exact request it answers.
 * @param {object} request - Validated review_request document.
 * @param {object} result - Validated review_result document.
 * @returns {void} Throws when identity, purpose, or fixed review subject differs.
 */
export function assertReviewResponse(request, result) {
  if (request.kind !== "review_request" || result.kind !== "review_result") {
    throw new SyntaxError("review correlation requires a request and a result");
  }
  if (
    result.in_reply_to !== request.id ||
    result.payload.purpose !== request.payload.purpose
  ) {
    throw new SyntaxError("review response must match request ID and purpose");
  }
  for (const field of ["worktree_id", "commit", "implementation_session_id"]) {
    if (request.subject[field] !== result.subject[field])
      throw new SyntaxError(`review subject.${field} differs from request`);
  }
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
}

const labels = {
  task_request: "작업 요청",
  completion_report: "완료 보고",
  interruption_report: "중단·인계 보고",
  goal: "목표",
  scope: "작업 범위",
  required_checks: "필수 검사",
  command: "명령",
  mode: "전달 방식",
  target: "전달 대상",
  authorization: "허가 근거",
  cleanup_required: "필수 정리 여부",
  outcome: "완료 판단",
  acceptance_results: "수용 기준별 결과",
  criterion: "수용 기준",
  result: "판정",
  checks: "검증 결과",
  required: "필수 여부",
  reason: "중단 사유",
  undelivered_changes: "미전달 변경",
  sessions: "관측한 세션",
  liveness: "생존 상태",
  action: "수행한 조치",
  stop_authorization: "종료 허가 근거",
  resume_steps: "재개 절차",
  review_request: "검토 요청",
  review_result: "검토 결과",
  status_report: "상태 보고",
  schema_version: "문서 형식 버전",
  kind: "문서 종류",
  id: "식별자",
  issued_at: "작성 시각",
  issuer: "작성 세션",
  session_id: "세션 식별자",
  subject: "대상",
  worktree_id: "워크트리 식별자",
  commit: "대상 커밋",
  implementation_session_id: "구현 세션 식별자",
  in_reply_to: "요청 식별자",
  purpose: "검토 목적",
  question: "질문",
  facts: "관련 사실",
  options: "선택지",
  constraints: "제약",
  acceptance_criteria: "수용 기준",
  evidence: "근거",
  source: "출처",
  locator: "위치",
  excerpt: "인용",
  conclusion: "판단",
  summary: "요약",
  recommendation: "추천 사항",
  counterarguments: "반대 근거",
  independent: "독립 검토 여부",
  findings: "지적 사항",
  severity: "심각도",
  description: "설명",
  uncertainties: "확인하지 못한 사항",
  observation: "관측 결과",
  execution: "작업 상태",
  worktree: "관측한 워크트리",
  instance_id: "인스턴스 식별자",
  owner_session_id: "소유 세션 식별자",
  git: "Git 상태",
  head: "HEAD",
  dirty: "미커밋 변경 여부",
  ci: "CI 검사",
  name: "이름",
  build_id: "빌드 식별자",
  source_commit: "검사한 소스 커밋",
  target_branch: "대상 브랜치",
  status: "상태",
  observed_at: "관측 시각",
  delivery: "결과 전달",
  cleanup: "워크트리 정리",
  state: "상태",
  reference: "전달 위치",
  remaining: "남은 작업",
};

function renderValue(value) {
  if (value === null)
    return '<span class="muted">확인되지 않았거나 해당하지 않습니다.</span>';
  if (Array.isArray(value)) {
    return value.length
      ? `<ol>${value.map((item) => `<li>${renderValue(item)}</li>`).join("")}</ol>`
      : '<span class="muted">항목이 없습니다.</span>';
  }
  if (typeof value === "object") {
    return `<dl>${Object.entries(value)
      .map(
        ([key, child]) =>
          `<dt>${escapeHtml(labels[key] ?? key)}</dt><dd>${renderValue(child)}</dd>`,
      )
      .join("")}</dl>`;
  }
  return `<span class="value">${escapeHtml(typeof value === "boolean" ? (value ? "예" : "아니요") : value)}</span>`;
}

/**
 * Renders an already validated report as inert, self-contained Korean HTML.
 * @param {object} value - Validated OMT document; untrusted strings are always escaped.
 * @returns {string} Complete HTML without scripts, external assets, or executable links.
 */
export function renderOmtHtml(value) {
  const title = labels[value.kind];
  const { payload, ...metadata } = value;
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>OMT ${escapeHtml(title)}</title>
<style>
:root{color-scheme:light;font-family:system-ui,sans-serif;color:#17243a;background:#edf2f7}
*{box-sizing:border-box}body{margin:0;padding:32px 16px}main{max-width:1000px;margin:auto}
header{padding:24px 0}header p{color:#53647a}h1{margin:8px 0;font-size:2rem}h2{margin-top:0;font-size:1.2rem}
section{background:white;border:1px solid #d7e0ea;border-radius:12px;padding:24px;margin-bottom:20px}
dl{display:grid;grid-template-columns:minmax(120px,190px) minmax(0,1fr);gap:12px 20px;margin:0}
dt{font-weight:650;color:#43556d}dd{margin:0;min-width:0}dd dl{grid-template-columns:minmax(100px,140px) minmax(0,1fr)}
ol{margin:0;padding-left:24px}li+li{margin-top:16px}.value{white-space:pre-wrap;overflow-wrap:anywhere}
.muted{color:#63748a;font-size:.9rem}footer{color:#53647a;font-size:.85rem;padding:4px}
@media(max-width:650px){dl,dd dl{grid-template-columns:minmax(0,1fr)}dd{margin-bottom:12px}section{padding:18px}}
@media print{body{background:white;padding:0}section{break-inside:auto;border-radius:0}header{padding-top:0}}
</style></head><body><main><header><p>OH MY TEAMS · 문서 형식 v1</p><h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(value.id)} · ${escapeHtml(value.issued_at)}</p></header>
<section aria-label="본문"><h2>보고 내용</h2>${renderValue(payload)}</section>
<section aria-label="문서 정보"><h2>문서 정보</h2>${renderValue(metadata)}</section>
<footer>이 화면은 문서의 표시 결과입니다. 실제 실행 상태와 증거는 Orca, Git 및 CI에서 확인합니다.</footer>
</main></body></html>\n`;
}
