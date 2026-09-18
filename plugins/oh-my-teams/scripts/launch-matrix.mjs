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
 * 호환성 표를 실측으로 검증할 때 사용한 Orca 버전. 다른 버전에서는 차단하지 않고
 * `classifyVersion`이 근거 등급을 낮춥니다.
 *
 * @type {string}
 */
export const VERIFIED_ORCA_VERSION = "1.4.204";

/**
 * 호환성 표를 실측으로 검증할 때 사용한 Antigravity CLI 버전. Agy 역할에만 적용하며,
 * 다른 버전에서는 차단하지 않고 근거 등급을 낮춥니다.
 *
 * @type {string}
 */
export const VERIFIED_CLI_VERSION = "1.2.5";

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
 * 버전 문자열을 검증에 사용한 버전과 비교해 세 상태로 분류합니다.
 *
 * Orca는 사용자가 아무것도 바꾸지 않아도 자동으로 갱신되므로, 패치 버전이
 * 달라졌다는 이유로 실행을 막으면 이미 검증된 경로까지 함께 멈춥니다(#61).
 * 그래서 이 함수는 차단 여부가 아니라 근거 등급을 낮출 정도를 돌려줍니다.
 *
 * @param {string|undefined} version - 확인할 버전 문자열.
 * @param {string} supported - 검증에 사용한 버전 문자열.
 * @returns {"match"|"patch-diff"|"unknown"} 같은 버전이면 match, 주·부 버전이
 *   같고 패치만 다르면 patch-diff, 그 밖(주·부 버전 차이, 빈 값, 형식 불일치)은
 *   unknown.
 */
export function classifyVersion(version, supported) {
  const value = String(version ?? "").trim();
  if (value === supported) return "match";
  const parse = (text) => /^(\d+)\.(\d+)\./.exec(text);
  const left = parse(value);
  const right = parse(supported);
  if (!left || !right) return "unknown";
  if (left[1] === right[1] && left[2] === right[2]) return "patch-diff";
  return "unknown";
}

/**
 * 이 조합에서 실제로 의미가 있는 버전만 골라 가장 낮은 신뢰 상태를 돌려줍니다.
 *
 * Orca 버전은 Orca 터미널을 쓰는 경로에만, Antigravity CLI 버전은 Agy 역할에만
 * 적용합니다. headless 경로는 Orca 터미널과 에이전트 인식을 거치지 않으므로 Orca
 * 버전 차이의 영향을 받지 않습니다.
 *
 * @param {MatrixResult} candidate - 표가 고른 결과.
 * @param {object} params - 환경 조합 파라미터.
 * @returns {"match"|"patch-diff"|"unknown"} 적용 대상 가운데 가장 낮은 상태.
 */
function relevantVersionStatus(candidate, { runner, orcaVersion, cliVersion }) {
  const statuses = [];
  if (candidate.path !== "headless") {
    statuses.push(classifyVersion(orcaVersion, VERIFIED_ORCA_VERSION));
  }
  if (runner === "agy") {
    statuses.push(classifyVersion(cliVersion, VERIFIED_CLI_VERSION));
  }
  if (statuses.includes("unknown")) return "unknown";
  if (statuses.includes("patch-diff")) return "patch-diff";
  return "match";
}

/**
 * 근거 등급을 한 단계 낮출 때 쓰는 대응표.
 *
 * @type {Record<string, 'verified'|'source-derived'|'unverified'>}
 */
const LOWER_EVIDENCE = {
  verified: "source-derived",
  "source-derived": "unverified",
  unverified: "unverified",
};

/**
 * 검증에 쓰지 않은 버전에서는 경로를 막는 대신 근거 등급을 낮춥니다.
 *
 * 패치 버전만 다르면 근거 등급을 그대로 두고 untested_patch_version만 붙입니다.
 * 주·부 버전이 다르거나 버전을 확인하지 못했으면 근거 등급을 한 단계 낮추고
 * untested_version을 붙입니다. 실측으로 검증한 칸은 한 단계 낮아져도 여전히 실행되고,
 * 원래 unverified였던 칸만 검증 모드 승인을 요구합니다. 이미 막힌 결과는 그대로 둡니다.
 *
 * @param {MatrixResult} candidate - 표가 고른 결과.
 * @param {object} params - 환경 조합 파라미터.
 * @returns {MatrixResult} 근거 등급과 이유 코드를 조정한 결과.
 */
function applyVersionEvidence(candidate, params) {
  if (candidate.path === "blocked") return candidate;
  const status = relevantVersionStatus(candidate, params);
  if (status === "match") return candidate;
  const patchOnly = status === "patch-diff";
  return {
    ...candidate,
    evidence: patchOnly
      ? candidate.evidence
      : LOWER_EVIDENCE[candidate.evidence],
    reason: [
      ...candidate.reason,
      patchOnly ? "untested_patch_version" : "untested_version",
    ],
  };
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
  const carried = candidate.reason.filter((code) => code !== "");
  const versionNote = carried.includes("untested_version")
    ? ` 검증에 사용한 버전은 Orca ${VERIFIED_ORCA_VERSION}, Antigravity CLI ${VERIFIED_CLI_VERSION}입니다.`
    : "";
  return {
    path: "blocked",
    reason: ["unverified-terminal-creation", ...carried],
    nextOwner: "pm",
    nextAction:
      '검증되지 않은 조합입니다. --allow-unverified "<승인 문장>" 옵션으로 명시적 승인 후 재시도하세요.' +
      versionNote,
    evidence: "unverified",
  };
}

/**
 * 표의 규칙 배열. 위에서 아래로 순서대로 평가하며, 처음 조건이 맞는 행이 적용됩니다.
 *
 * 각 규칙은 `{ match(params): boolean, result: MatrixResult }` 형태입니다.
 *
 * 설계 3절의 표 순서를 그대로 따릅니다:
 * 복합 명령 Windows Agy → 신뢰 없음(Agy) → 신뢰 없음(Codex) →
 * Claude skipPrompt=false → Claude win32 skipPrompt=true → Agy claude 계열 →
 * Agy gemini win32/powershell → Agy win32/powershell(다른 계열) →
 * Agy gemini/gpt-oss POSIX → Claude POSIX skipPrompt=true →
 * Codex 신뢰 있음 → 나머지
 *
 * @type {Array<{match: function(object): boolean, result: MatrixResult}>}
 */
const MATRIX_RULES = [
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
  // 8. Agy / gemini / win32 / 신뢰 있음 → headless
  // 실측(Orca 1.4.204): tui-idle이 120초까지 오지 않아 worker-start 불가.
  // 폭 조정(Windows에서는 mode con: cols)은 powershell 전경 문제로 에이전트 식별을 깨뜨려 두 조건을 동시에 만족할 방법이 없음.
  {
    match: ({ runner, model, platform, trustRecordExists }) =>
      runner === "agy" &&
      normalizeModelFamily(model) === "gemini" &&
      platform === "win32" &&
      trustRecordExists,
    result: {
      path: "headless",
      reason: ["orca-idle-requires-narrow-screen"],
      nextOwner: "-",
      nextAction:
        "Orca tui-idle이 좁은 화면을 요구하고 폭 조정은 에이전트 식별을 깨뜨립니다. headless 경로를 사용합니다.",
      evidence: "verified",
    },
  },
  // 9. Agy / - / win32 / 신뢰 있음 (gemini 외 다른 계열 포함) → headless
  {
    match: ({ runner, platform, trustRecordExists }) =>
      runner === "agy" && platform === "win32" && trustRecordExists,
    result: {
      path: "headless",
      reason: ["agy-headless-fallback"],
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
  // 12. Codex / 신뢰 있음 → supervised-terminal (verified)
  // 2026-09-18 Orca 1.4.204 실측: role-terminal ready → terminal-idle-check idle →
  // worker-start(task_e16a4a21060e, ctx_1a6f307bf0c3) → worker_done outcome:succeeded(b5e1cc3) →
  // ack → worker-release → 터미널·워크트리 회수 완료. binding.modelProof는 unproven이었음.
  {
    match: ({ runner, codexTrustRecordExists }) =>
      runner === "codex" && codexTrustRecordExists === true,
    result: {
      path: "supervised-terminal",
      reason: [],
      nextOwner: "-",
      nextAction: "",
      evidence: "verified",
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
        applyVersionEvidence(rule.result, params),
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
