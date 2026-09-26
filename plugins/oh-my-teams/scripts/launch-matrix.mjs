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
export const VERIFIED_ORCA_VERSION = "1.4.210";

/**
 * 호환성 표를 실측으로 검증할 때 사용한 Antigravity CLI 버전. Agy 역할에만 적용하며,
 * 다른 버전에서는 차단하지 않고 근거 등급을 낮춥니다.
 *
 * @type {string}
 */
export const VERIFIED_CLI_VERSION = "1.2.11";

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
 * 미검증 근거는 경고로 남기며 이미 막힌 결과는 그대로 둡니다.
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
 * 실행 경로가 알려진 미검증 조합은 근거 등급을 유지하고 경고를 남깁니다.
 * 검증 기록의 부재는 실행 실패가 아니며 실제 준비 상태는 터미널에서 확인합니다.
 *
 * @param {MatrixResult} candidate - 평가 결과 후보.
 * @returns {MatrixResult} 미검증 경고가 포함된 결과.
 */
function applyEvidenceWarning(candidate) {
  if (candidate.path !== "supervised-terminal") return candidate;
  if (candidate.evidence !== "unverified") return candidate;
  return {
    ...candidate,
    reason: ["unverified-terminal-evidence", ...candidate.reason],
    nextAction: [
      candidate.nextAction,
      "검증 기록이 부족합니다. 실행 후 준비 상태와 모델을 확인하세요.",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/**
 * 신뢰 기록이 없는 조합의 다음 행동. 질문에 답하는 주체는 사람이 아니라 감독자입니다.
 *
 * @type {string}
 */
const SUPERVISED_TRUST_ACTION =
  "폴더 신뢰 질문이 나오면 감독자가 prompt-answer 명령으로 답한 뒤 terminal-idle-check로 되돌아갑니다.";

/**
 * 표의 규칙 배열. 위에서 아래로 순서대로 평가하며, 처음 조건이 맞는 행이 적용됩니다.
 *
 * 각 규칙은 `{ match(params): boolean, result: MatrixResult }` 형태입니다.
 *
 * 설계 3절의 표 순서를 그대로 따릅니다(Orca 1.4.210 실측으로 7번을 삭제하고 10번을 확장, #104;
 * 신뢰 기록 없는 Agy·Codex는 supervised-terminal로 바뀌어 감독자가 답함, #105;
 * Windows Agy는 신뢰 상태를 확인하기 전에 headless로 먼저 걸러냄, #46/agy-win-untrusted-path):
 * 복합 명령 Windows Agy → Windows Agy(신뢰 상태 무관, headless) →
 * 신뢰 없음(Agy, 남은 건 POSIX뿐, 감독자가 답함) → 신뢰 없음(Codex, 감독자가 답함) →
 * Claude skipPrompt=false → Claude win32 skipPrompt=true →
 * Agy gemini win32/powershell(신뢰 있음) → Agy win32/powershell(다른 계열, 신뢰 있음) →
 * Agy POSIX(모델 계열 무관) → Claude POSIX skipPrompt=true →
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
  // 2-1. Agy / win32 / 신뢰 상태가 true로 확인되지 않음(false 또는 unknown) → headless
  //
  // #46이 내린 결론은 "Windows의 Agy는 감독 터미널로 시작되지 않는다"이며 신뢰 상태를
  // 조건으로 달지 않는다. 그런데 옛 순서는 신뢰 기록이 있을 때만 이 결론(규칙 8·9)을
  // 적용했고, 신뢰 기록이 없거나 확인되지 않으면 플랫폼을 보지 않는 규칙 3(agent-trust-workspace,
  // supervised-terminal)에 먼저 걸렸다. `role-terminal.mjs`의 `readLaunchEnvironment`는
  // trustedWorkspaces를 정확 일치로 판정하므로 새로 만든 워크트리는 정의상 항상
  // trustRecordExists가 false이고, 이 조합은 드문 구멍이 아니라 Windows에서 Agy 역할을
  // 처음 여는 기본 경로였다. 이 규칙을 규칙 3보다 앞에 두어 신뢰 상태를 확인하기 전에
  // win32 + agy를 먼저 headless로 걸러낸다.
  //
  // 확인한 것: `docs/plan/agy-terminal-path.md`의 2026-09-18 r3-c1 실측(Windows 11,
  // Orca 1.4.204, Antigravity CLI 1.2.5)은 신뢰 기록이 없는 새 워크트리에서 gemini Agy가
  // 터미널을 열기도 전에 agent-trust-workspace로 거부됨을 실측으로 확인했다(옛 규칙 순서의
  // 증상 재현). `docs/plan/headless-runtime.md`의 2026-09-17 Windows 검증은 신뢰 기록이
  // 없는 새 임시 Git 저장소에서 headless-start로 같은 Agy(gemini) 역할을 실행해, 신뢰
  // 질문에 막히지 않고 파일 작성과 커밋까지 `done`으로 끝냄을 실측으로 확인했다.
  // 또한 확인한 것: `plugins/oh-my-teams/scripts/headless.mjs`의 `PROVIDERS.agy.command`
  // (163번째 줄)는 headless 경로가 agy CLI를 실행할 때 `--dangerously-skip-permissions`
  // 플래그를 실제로 넘긴다는 것을 소스로 보여준다.
  // 확인하지 못한 것: 그 headless 검증 워크트리의 trustRecordExists 값이 정확히 false였는지
  // unknown이었는지(당시 기록은 "임시 Git 저장소"라고만 적었다), 그리고 위 플래그가 폴더
  // 신뢰 질문까지 억제하는지의 메커니즘(플래그의 존재 자체는 확인했으나 그 효과 범위는
  // 확인하지 못했다), Windows에서 Agy 자체가 trustedWorkspaces에 기록하는 경로 표기.
  // 규칙 8·9와 같은 이유로(#104: 근거였던 Orca 1.4.204 판정 규칙이 1.4.210에서 교체되었고
  // 재검증할 Windows 머신이 없음) evidence는 verified로 올리지 않는다.
  //
  // 경로 표기 차이(대소문자·구분자) 문제는 이 규칙이 이미 판정 결과에서 분리했으므로,
  // `role-terminal.mjs`의 신뢰 기록 비교에 정규화를 두지 않았다(독립 검토 finding
  // trust-normalization-speculative-scope에 따라 되돌림). 앞으로 win32에서 신뢰 기록 값에
  // 따라 갈리는 규칙이 생기면 그때 정규화를 다시 판단한다.
  {
    match: ({ runner, platform, trustRecordExists }) =>
      runner === "agy" && platform === "win32" && trustRecordExists !== true,
    result: {
      path: "headless",
      reason: ["agy-headless-no-trust"],
      nextOwner: "-",
      nextAction:
        "신뢰 기록이 없거나 확인되지 않아도 Windows의 Agy는 감독 터미널을 열지 않고 headless 경로를 대신 사용합니다.",
      evidence: "unverified",
    },
  },
  // 3. Agy / - / 신뢰 기록 없음 → supervised-terminal
  // 폴더 신뢰 질문은 터미널이 열린 뒤에 화면에 나타나며, 감독자(PM 또는 그 역할을 시작한 PL)가
  // prompt-answer 명령으로 분류기를 거쳐 한 번 답합니다. 사람이 그 터미널에서 답하는 경로가 아닙니다.
  // win32는 규칙 2-1이 먼저 걸러내므로, 이 규칙은 실질적으로 POSIX(darwin·linux)에만 적용됩니다.
  {
    match: ({ runner, trustRecordExists }) =>
      runner === "agy" && !trustRecordExists,
    result: {
      path: "supervised-terminal",
      reason: ["agent-trust-workspace"],
      nextOwner: "pm",
      nextAction: SUPERVISED_TRUST_ACTION,
      evidence: "source-derived",
    },
  },
  // 4. Codex / - / 신뢰 기록 없음 (codexTrustRecordExists가 true가 아닌 경우) → supervised-terminal
  // Codex 폴더 신뢰 응답은 아직 실측하지 않았으므로 근거 등급을 verified로 올리지 않습니다.
  {
    match: ({ runner, codexTrustRecordExists }) =>
      runner === "codex" && codexTrustRecordExists !== true,
    result: {
      path: "supervised-terminal",
      reason: ["codex-trust-workspace"],
      nextOwner: "pm",
      nextAction: SUPERVISED_TRUST_ACTION,
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
  // 7. (삭제됨) Agy + claude 계열 + 신뢰 있음 → blocked였던 규칙. Orca 1.4.210 실측으로 반증되어 삭제(#104).
  // 8. Agy / gemini / win32 / 신뢰 있음 → headless
  // 실측(Orca 1.4.204): tui-idle이 120초까지 오지 않아 worker-start 불가.
  // 폭 조정(Windows에서는 mode con: cols)은 powershell 전경 문제로 에이전트 식별을 깨뜨려 두 조건을 동시에 만족할 방법이 없음.
  // 근거였던 Orca 1.4.204의 판정 규칙은 1.4.210에서 교체되어 더 이상 존재하지 않고, 재검증할 Windows 머신이
  // 없으므로 evidence를 verified에서 unverified로 낮춘다. 경로(headless)는 바꾸지 않는다(#104).
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
        "1.4.204에서는 좁은 화면이 아니면 tui-idle에 도달하지 못한다고 실측됐지만, 그 판정 규칙은 1.4.210에서 교체되어 근거를 잃었고 Windows에서는 아직 재검증되지 않았습니다. 확인될 때까지 headless 경로를 사용합니다.",
      evidence: "unverified",
    },
  },
  // 9. Agy / - / win32 / 신뢰 있음 (gemini 외 다른 계열 포함) → headless
  // 근거였던 Orca 1.4.204의 판정 규칙은 1.4.210에서 교체되어 더 이상 존재하지 않고, 재검증할 Windows 머신이
  // 없으므로 evidence를 verified에서 unverified로 낮춘다. 경로(headless)는 바꾸지 않는다(#104).
  {
    match: ({ runner, platform, trustRecordExists }) =>
      runner === "agy" && platform === "win32" && trustRecordExists,
    result: {
      path: "headless",
      reason: ["agy-headless-fallback"],
      nextOwner: "-",
      nextAction: "Agy 역할 대체 경로(headless)를 사용합니다.",
      evidence: "unverified",
    },
  },
  // 10. Agy / POSIX(platform !== win32) / 신뢰 있음 → supervised-terminal (verified), 모델 계열 무관.
  // 실측(macOS darwin 24.6.0, Orca 1.4.210, Antigravity CLI 1.2.11, #104): `agy --model claude-sonnet-4-6`,
  // `agy --model gemini-3.1-pro-high`, `stty cols 44; agy --model gemini-3.1-pro-high` 세 조합 모두
  // tui-idle satisfied:true, agentIdentity:antigravity로 확인됐다. Orca의 새 판정 함수는 모델 줄을 읽지 않으므로
  // claude 계열도 통과하며, 폭 조정 여부와 결과가 같아 gemini·gpt-oss 한정 조건은 근거를 잃었다.
  {
    match: ({ runner, platform, trustRecordExists }) =>
      runner === "agy" && platform !== "win32" && trustRecordExists,
    result: {
      path: "supervised-terminal",
      reason: [],
      nextOwner: "-",
      nextAction: "",
      evidence: "verified",
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
 *   true가 아니면 4행(codex-trust-workspace)이 적용되어 터미널은 열리고 질문은 감독자가 답합니다.
 * @param {boolean} params.skipDangerousModePermissionPrompt - 첫 실행 확인 질문 설정 우회 여부.
 * @param {string} params.orcaVersion - Orca 버전.
 * @param {string} params.cliVersion - Antigravity CLI 버전.
 * @param {boolean} [params.isCompoundCommand=false] - 실제로 입력하는 명령이 복합 명령(;로 연결)인지 여부.
 *   true일 때만 2행(no_agent_detected) 규칙이 적용됩니다.
 * @param {boolean} [params.allowUnverified=false] - 이전 호출과의 호환을 위한 옵션이며 경로에 영향을 주지 않습니다.
 * @param {string} [params.allowUnverifiedApproval] - 이전 호출에서 전달하던 승인 문장입니다.
 * @returns {MatrixResult} 실행 경로 예측 결과.
 */
export function predictLaunchPath(params) {
  for (const rule of MATRIX_RULES) {
    if (rule.match(params)) {
      return applyEvidenceWarning(applyVersionEvidence(rule.result, params));
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
