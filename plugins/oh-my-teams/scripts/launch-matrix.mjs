/**
 * 터미널 실행 경로 호환성 표.
 *
 * 실행기(runner) × Agy 모델 계열(modelFamily) × 플랫폼(platform) × 셸(shell) ×
 * 워크트리 신뢰 기록(trustRecordExists) × 첫 실행 확인 질문 우회(skipDangerousModePermissionPrompt) ×
 * Orca·CLI 버전 범위의 조합별 예상 결과를 한 곳에서 관리합니다.
 *
 * 규칙은 위에서 아래로 순서대로 평가하며, 처음 조건이 맞는 행이 적용됩니다.
 * 마지막 행은 나머지 모든 조합을 덮습니다.
 *
 * 출처: `docs/plan/agy-terminal-path.md` 설계 절.
 */

/**
 * `predictLaunchPath`가 반환하는 결과 스키마.
 *
 * @typedef {object} MatrixResult
 * @property {'supervised-terminal'|'headless'|'blocked'} path - 예상 실행 경로.
 * @property {string[]} reason - 거부·예외 이유 코드 목록. 성공 경로에서는 빈 배열.
 * @property {string} nextOwner - 거부 시 다음 담당자 (예: 'pm', 'user', '-').
 * @property {string} nextAction - 거부 시 다음 행동 가이드. 성공 경로에서는 빈 문자열.
 * @property {'verified'|'source-derived'|'unverified'} evidence - 근거 등급.
 */

/**
 * 지원하는 Orca 버전 범위. 범위 밖이면 `unsupported_version`으로 차단합니다.
 *
 * @type {string}
 */
export const SUPPORTED_ORCA_VERSION = "1.4.204";

/**
 * 지원하는 Antigravity CLI 버전 범위. 범위 밖이면 `unsupported_version`으로 차단합니다.
 *
 * @type {string}
 */
export const SUPPORTED_CLI_VERSION = "1.2.5";

/**
 * Agy 모델 이름을 계열('gemini', 'claude', 'gpt-oss')로 정규화합니다.
 *
 * @param {string|undefined} model - 모델 이름 (예: 'gemini-3.1-pro-high').
 * @returns {'gemini'|'claude'|'gpt-oss'|'unknown'} 정규화된 모델 계열.
 */
export function normalizeModelFamily(model) {
  const lower = String(model ?? "")
    .toLowerCase()
    .trim();
  if (!lower) return "unknown";
  if (/^gemini/.test(lower)) return "gemini";
  if (/^claude/.test(lower)) return "claude";
  if (/^gpt-oss/.test(lower)) return "gpt-oss";
  return "unknown";
}

/**
 * 버전 문자열이 지원 버전과 일치하는지 확인합니다.
 *
 * @param {string|undefined} version - 확인할 버전 문자열.
 * @param {string} supported - 지원하는 버전 문자열.
 * @returns {boolean} 지원 버전과 일치하면 true.
 */
function isVersionSupported(version, supported) {
  return String(version ?? "").trim() === supported;
}

/**
 * `unverified`인 `supervised-terminal` 결과를 검증 모드 여부로 처리합니다.
 *
 * 검증 모드(`allowUnverified=true`)일 때만 터미널 생성을 허용하고,
 * 그렇지 않으면 `blocked (unverified-terminal-creation)`으로 차단합니다.
 *
 * @param {MatrixResult} candidate - 평가 결과 후보.
 * @param {boolean} allowUnverified - 검증 모드 허용 여부.
 * @param {string|undefined} allowUnverifiedApproval - 검증 모드 승인 문장.
 * @returns {MatrixResult} 최종 결과.
 */
function applyVerificationGate(
  candidate,
  allowUnverified,
  allowUnverifiedApproval,
) {
  if (candidate.path !== "supervised-terminal") return candidate;
  if (candidate.evidence !== "unverified") return candidate;
  if (allowUnverified && allowUnverifiedApproval) return candidate;
  return {
    path: "blocked",
    reason: ["unverified-terminal-creation"],
    nextOwner: "pm",
    nextAction:
      '검증되지 않은 조합입니다. --allow-unverified "<승인 문장>" 옵션으로 명시적 승인 후 재시도하세요.',
    evidence: "unverified",
  };
}

/**
 * 표의 규칙 배열. 위에서 아래로 순서대로 평가하며, 처음 조건이 맞는 행이 적용됩니다.
 *
 * 각 규칙은 `{ match(params): boolean, result: MatrixResult }` 형태입니다.
 *
 * 설계 3절의 표 순서를 그대로 따릅니다:
 * 버전 범위 → 복합 명령 Windows Agy → 신뢰 없음(Agy) → 신뢰 없음(Codex) →
 * Claude skipPrompt=false → Claude win32 skipPrompt=true → Agy claude 계열 →
 * Agy gemini win32/powershell → Agy win32/powershell(다른 계열) →
 * Agy gemini/gpt-oss POSIX → Claude POSIX skipPrompt=true →
 * Codex 신뢰 있음 → 나머지
 *
 * @type {Array<{match: function(object): boolean, result: MatrixResult}>}
 */
const MATRIX_RULES = [
  // 1. 지원 버전 범위 밖
  {
    match: ({ orcaVersion, cliVersion }) =>
      !isVersionSupported(orcaVersion, SUPPORTED_ORCA_VERSION) ||
      !isVersionSupported(cliVersion, SUPPORTED_CLI_VERSION),
    result: {
      path: "blocked",
      reason: ["unsupported_version"],
      nextOwner: "pm",
      nextAction: "버전 지원 범위를 확인하세요.",
      evidence: "unverified",
    },
  },
  // 2. Agy / win32 / powershell — 복합 명령 실행(폭 조정과 agy를 한 줄에)
  // isCompoundCommand=true인 경우에만 적용됩니다. Windows에서 구현은 폭 조정을
  // 생략하므로 단일 명령만 입력하여 이 행에 걸리지 않습니다.
  // powershell.exe가 전경 프로세스로 남아 no_agent_detected 발생
  // (설계 7절: role-terminal.mjs 폭 조정 조건 대체)
  {
    match: ({ runner, platform, shell, isCompoundCommand }) =>
      runner === "agy" &&
      platform === "win32" &&
      shell === "powershell" &&
      isCompoundCommand === true,
    result: {
      path: "blocked",
      reason: ["no_agent_detected"],
      nextOwner: "pm",
      nextAction:
        "Windows PowerShell에서 Agy는 복합 명령 실행 시 에이전트 식별에 실패합니다. 단일 명령으로 분리하거나 headless를 사용하세요.",
      evidence: "source-derived",
    },
  },
  // 3. Agy / - / 신뢰 기록 없음
  {
    match: ({ runner, trustRecordExists }) =>
      runner === "agy" && !trustRecordExists,
    result: {
      path: "blocked",
      reason: ["agent-trust-workspace"],
      nextOwner: "user",
      nextAction: "폴더 신뢰 질문에 답하세요.",
      evidence: "verified",
    },
  },
  // 4. Codex / - / 신뢰 기록 없음 (codexTrustRecordExists가 true가 아닌 경우)
  {
    match: ({ runner, codexTrustRecordExists }) =>
      runner === "codex" && codexTrustRecordExists !== true,
    result: {
      path: "blocked",
      reason: ["codex-trust-workspace"],
      nextOwner: "user",
      nextAction: "폴더 신뢰 질문에 답하세요.",
      evidence: "source-derived",
    },
  },
  // 5. Claude / - / skipPrompt=false
  {
    match: ({ runner, skipDangerousModePermissionPrompt }) =>
      runner === "claude" && !skipDangerousModePermissionPrompt,
    result: {
      path: "blocked",
      reason: ["claude-permission-prompt"],
      nextOwner: "user",
      nextAction:
        "권한 승인 질문에 답하거나 --dangerously-skip-permissions 플래그를 사용하세요.",
      evidence: "unverified",
    },
  },
  // 6. Claude / win32 / skipPrompt=true → supervised-terminal (verified)
  {
    match: ({ runner, platform, skipDangerousModePermissionPrompt }) =>
      runner === "claude" &&
      platform === "win32" &&
      skipDangerousModePermissionPrompt,
    result: {
      path: "supervised-terminal",
      reason: [],
      nextOwner: "-",
      nextAction: "",
      evidence: "verified",
    },
  },
  // 7. Agy / claude 계열 / 신뢰 있음 → blocked (Orca가 claude 모델을 antigravity로 인식 불가)
  {
    match: ({ runner, trustRecordExists, model }) =>
      runner === "agy" &&
      trustRecordExists &&
      normalizeModelFamily(model) === "claude",
    result: {
      path: "blocked",
      reason: ["claude-unsupported-by-orca"],
      nextOwner: "pm",
      nextAction:
        "Agy claude 모델은 Orca tui-idle 판정을 통과할 수 없습니다. headless를 권장합니다.",
      evidence: "verified",
    },
  },
  // 8. Agy / gemini / win32 / powershell / 신뢰 있음
  // (위의 규칙 2에서 win32+powershell은 이미 blocked이므로 이 규칙은 실제로
  //  win32이지만 shell이 powershell이 아닌 경우만 도달합니다)
  // 설계에 따라: allowUnverified 검증 게이트 적용 (unverified)
  {
    match: ({ runner, model, platform, trustRecordExists }) =>
      runner === "agy" &&
      normalizeModelFamily(model) === "gemini" &&
      platform === "win32" &&
      trustRecordExists,
    result: {
      path: "supervised-terminal",
      reason: [],
      nextOwner: "pm",
      nextAction: "브리프 기준 9 실측(검증 모드에서만 터미널 생성 허용).",
      evidence: "unverified",
    },
  },
  // 9. Agy / - / win32 / 신뢰 있음 (gemini 외 다른 계열 포함) → headless
  {
    match: ({ runner, platform, trustRecordExists }) =>
      runner === "agy" && platform === "win32" && trustRecordExists,
    result: {
      path: "headless",
      reason: [],
      nextOwner: "-",
      nextAction: "Agy 역할 대체 경로(headless)를 사용합니다.",
      evidence: "verified",
    },
  },
  // 10. Agy / gemini 또는 gpt-oss / posix / 신뢰 있음 → supervised-terminal (unverified)
  {
    match: ({ runner, model, platform, trustRecordExists }) => {
      const family = normalizeModelFamily(model);
      return (
        runner === "agy" &&
        (family === "gemini" || family === "gpt-oss") &&
        platform !== "win32" &&
        trustRecordExists
      );
    },
    result: {
      path: "supervised-terminal",
      reason: [],
      nextOwner: "-",
      nextAction: "",
      evidence: "unverified",
    },
  },
  // 11. Claude / posix / skipPrompt=true → supervised-terminal (unverified)
  {
    match: ({ runner, platform, skipDangerousModePermissionPrompt }) =>
      runner === "claude" &&
      platform !== "win32" &&
      skipDangerousModePermissionPrompt,
    result: {
      path: "supervised-terminal",
      reason: [],
      nextOwner: "-",
      nextAction: "",
      evidence: "unverified",
    },
  },
  // 12. Codex / 신뢰 있음 → blocked (worker_done 미검증)
  {
    match: ({ runner, trustRecordExists }) =>
      runner === "codex" && trustRecordExists,
    result: {
      path: "blocked",
      reason: ["codex-worker-done-unverified"],
      nextOwner: "pm",
      nextAction: "브리프 기준 9 실측이 필요합니다.",
      evidence: "unverified",
    },
  },
  // 13. 그 외 모든 미확인 조합
  {
    match: () => true,
    result: {
      path: "blocked",
      reason: ["untested_combination"],
      nextOwner: "pm",
      nextAction: "검증이 필요한 조합입니다.",
      evidence: "unverified",
    },
  },
];

/**
 * 주어진 환경 조합에서 터미널 실행 경로와 예측 결과를 반환합니다.
 * Agy 모델은 내부에서 계열('gemini', 'claude', 'gpt-oss')로 정규화됩니다.
 *
 * @param {object} params - 환경 조합 파라미터.
 * @param {'claude'|'codex'|'agy'} params.runner - 실행기.
 * @param {string} [params.model] - 모델 이름 (예: 'gemini-3.1-pro-high').
 * @param {'win32'|'darwin'|'linux'} params.platform - 플랫폼.
 * @param {'powershell'|'posix'} params.shell - 셸 종류.
 * @param {boolean} params.trustRecordExists - 워크트리 신뢰 기록 유무 (Agy용).
 * @param {boolean|string} [params.codexTrustRecordExists="unknown"] - Codex 신뢰 기록 유무.
 *   true일 때만 4행(codex-trust-workspace) 차단을 건너뜁니다.
 * @param {boolean} params.skipDangerousModePermissionPrompt - 첫 실행 확인 질문 설정 우회 여부.
 * @param {string} params.orcaVersion - Orca 버전.
 * @param {string} params.cliVersion - Antigravity CLI 버전.
 * @param {boolean} [params.isCompoundCommand=false] - 실제로 입력하는 명령이 복합 명령(;로 연결)인지 여부.
 *   true일 때만 2행(no_agent_detected) 규칙이 적용됩니다.
 * @param {boolean} [params.allowUnverified=false] - 검증 모드. true일 때만 unverified인
 *   supervised-terminal 후보 칸이 터미널 생성을 허용합니다.
 * @param {string} [params.allowUnverifiedApproval] - 검증 모드 승인 문장. 책임 소재 추적용.
 * @returns {MatrixResult} 실행 경로 예측 결과.
 */
export function predictLaunchPath(params) {
  const { allowUnverified = false, allowUnverifiedApproval } = params;
  for (const rule of MATRIX_RULES) {
    if (rule.match(params)) {
      return applyVerificationGate(
        rule.result,
        allowUnverified,
        allowUnverifiedApproval,
      );
    }
  }
  // 이 줄에 도달하면 프로그래밍 오류입니다 (마지막 규칙이 모든 조합을 덮습니다).
  /* istanbul ignore next */
  return {
    path: "blocked",
    reason: ["untested_combination"],
    nextOwner: "pm",
    nextAction: "검증이 필요한 조합입니다.",
    evidence: "unverified",
  };
}
