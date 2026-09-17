/** 호환성 표(launch-matrix.mjs) 결정적 테스트 - 브리프 기준 8. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeModelFamily,
  predictLaunchPath,
  SUPPORTED_CLI_VERSION,
  SUPPORTED_ORCA_VERSION,
} from "../plugins/oh-my-teams/scripts/launch-matrix.mjs";

// 기본 지원 버전
const V = {
  orcaVersion: SUPPORTED_ORCA_VERSION,
  cliVersion: SUPPORTED_CLI_VERSION,
};

// 모든 결과에 필수 필드가 있는지 확인하는 헬퍼
function assertValidResult(result, label) {
  const paths = ["supervised-terminal", "headless", "blocked"];
  const evidences = ["verified", "source-derived", "unverified"];
  assert.ok(
    paths.includes(result.path),
    `${label}: path must be one of ${paths.join("|")}, got "${result.path}"`,
  );
  assert.ok(Array.isArray(result.reason), `${label}: reason must be an array`);
  assert.ok(
    typeof result.nextOwner === "string",
    `${label}: nextOwner must be a string`,
  );
  assert.ok(
    typeof result.nextAction === "string",
    `${label}: nextAction must be a string`,
  );
  assert.ok(
    evidences.includes(result.evidence),
    `${label}: evidence must be one of ${evidences.join("|")}, got "${result.evidence}"`,
  );
}

test("Agy 모델 계열 정규화", () => {
  assert.equal(normalizeModelFamily("gemini-3.1-pro-high"), "gemini");
  assert.equal(normalizeModelFamily("gemini-3.8-flash-medium"), "gemini");
  assert.equal(normalizeModelFamily("claude-sonnet-4-6"), "claude");
  assert.equal(normalizeModelFamily("claude-opus-4-6-thinking"), "claude");
  assert.equal(normalizeModelFamily("gpt-oss-120b-medium"), "gpt-oss");
  assert.equal(normalizeModelFamily(undefined), "unknown");
  assert.equal(normalizeModelFamily(""), "unknown");
  assert.equal(normalizeModelFamily("GEMINI-3.1-pro"), "gemini");
});

test("표의 모든 행이 유효한 path·reason·nextOwner·nextAction·evidence를 가진다", () => {
  // 각 규칙을 트리거하는 대표 파라미터 목록
  const cases = [
    // 1. 버전 범위 밖 - Orca 버전 다름
    {
      label: "unsupported_orca_version",
      params: {
        runner: "agy",
        model: "gemini-3.1-pro-high",
        platform: "win32",
        shell: "posix",
        trustRecordExists: true,
        skipDangerousModePermissionPrompt: true,
        orcaVersion: "1.3.0",
        cliVersion: SUPPORTED_CLI_VERSION,
      },
    },
    // 1. 버전 범위 밖 - CLI 버전 다름
    {
      label: "unsupported_cli_version",
      params: {
        runner: "agy",
        model: "gemini-3.1-pro-high",
        platform: "darwin",
        shell: "posix",
        trustRecordExists: true,
        skipDangerousModePermissionPrompt: true,
        orcaVersion: SUPPORTED_ORCA_VERSION,
        cliVersion: "1.2.4",
      },
    },
    // 2. Agy win32 powershell (복합 명령 → no_agent_detected)
    {
      label: "agy_win32_powershell_no_agent_detected",
      params: {
        runner: "agy",
        model: "gemini-3.1-pro-high",
        platform: "win32",
        shell: "powershell",
        trustRecordExists: true,
        skipDangerousModePermissionPrompt: true,
        isCompoundCommand: true,
        ...V,
      },
    },
    // 3. Agy 신뢰 없음
    {
      label: "agy_no_trust",
      params: {
        runner: "agy",
        model: "gemini-3.1-pro-high",
        platform: "darwin",
        shell: "posix",
        trustRecordExists: false,
        skipDangerousModePermissionPrompt: true,
        ...V,
      },
    },
    // 4. Codex 신뢰 없음 (codexTrustRecordExists !== true)
    {
      label: "codex_no_trust",
      params: {
        runner: "codex",
        model: undefined,
        platform: "darwin",
        shell: "posix",
        trustRecordExists: true,
        codexTrustRecordExists: false,
        skipDangerousModePermissionPrompt: true,
        ...V,
      },
    },
    // 5. Claude skipPrompt=false
    {
      label: "claude_no_skip_prompt",
      params: {
        runner: "claude",
        model: undefined,
        platform: "darwin",
        shell: "posix",
        trustRecordExists: true,
        skipDangerousModePermissionPrompt: false,
        ...V,
      },
    },
    // 6. Claude win32 skipPrompt=true → supervised-terminal (verified)
    {
      label: "claude_win32_skip_prompt",
      params: {
        runner: "claude",
        model: undefined,
        platform: "win32",
        shell: "powershell",
        trustRecordExists: true,
        skipDangerousModePermissionPrompt: true,
        ...V,
      },
    },
    // 7. Agy claude 계열 신뢰 있음 → blocked
    {
      label: "agy_claude_model",
      params: {
        runner: "agy",
        model: "claude-sonnet-4-6",
        platform: "darwin",
        shell: "posix",
        trustRecordExists: true,
        skipDangerousModePermissionPrompt: true,
        ...V,
      },
    },
    // 8. Agy gemini win32 신뢰 있음 → headless (orca-idle-requires-narrow-screen)
    {
      label: "agy_gemini_win32_headless",
      params: {
        runner: "agy",
        model: "gemini-3.1-pro-high",
        platform: "win32",
        shell: "posix",
        trustRecordExists: true,
        skipDangerousModePermissionPrompt: true,
        ...V,
      },
    },
    // 9. Agy gpt-oss win32 신뢰 있음 → headless
    {
      label: "agy_gpt_oss_win32",
      params: {
        runner: "agy",
        model: "gpt-oss-120b-medium",
        platform: "win32",
        shell: "posix",
        trustRecordExists: true,
        skipDangerousModePermissionPrompt: true,
        ...V,
      },
    },
    // 10. Agy gemini posix 신뢰 있음 → supervised-terminal unverified
    {
      label: "agy_gemini_posix",
      params: {
        runner: "agy",
        model: "gemini-3.8-flash-medium",
        platform: "darwin",
        shell: "posix",
        trustRecordExists: true,
        skipDangerousModePermissionPrompt: true,
        allowUnverified: true,
        allowUnverifiedApproval: "승인: 검증 모드",
        ...V,
      },
    },
    // 11. Claude posix skipPrompt=true → supervised-terminal unverified
    {
      label: "claude_posix_skip_prompt",
      params: {
        runner: "claude",
        model: undefined,
        platform: "linux",
        shell: "posix",
        trustRecordExists: true,
        skipDangerousModePermissionPrompt: true,
        allowUnverified: true,
        allowUnverifiedApproval: "승인: 검증 모드",
        ...V,
      },
    },
    // 12. Codex 신뢰 있음 → supervised-terminal (unverified, 실측 대기)
    {
      label: "codex_trusted",
      params: {
        runner: "codex",
        model: undefined,
        platform: "darwin",
        shell: "posix",
        trustRecordExists: false,
        codexTrustRecordExists: true,
        skipDangerousModePermissionPrompt: true,
        allowUnverified: true,
        allowUnverifiedApproval: "승인: 검증 모드",
        ...V,
      },
    },
    // 13. 나머지 모든 미확인 조합 (Agy unknown 계열 posix)
    {
      label: "agy_unknown_model_posix",
      params: {
        runner: "agy",
        model: "some-future-model",
        platform: "linux",
        shell: "posix",
        trustRecordExists: true,
        skipDangerousModePermissionPrompt: true,
        ...V,
      },
    },
  ];

  for (const { label, params } of cases) {
    const result = predictLaunchPath(params);
    assertValidResult(result, label);
  }
});

test("설계 3절 규칙 적용 예시가 모두 같은 결과를 낸다", () => {
  // 예시 1: Windows Claude → supervised-terminal
  const claudeWin = predictLaunchPath({
    runner: "claude",
    model: undefined,
    platform: "win32",
    shell: "powershell",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    ...V,
  });
  assert.equal(claudeWin.path, "supervised-terminal");
  assert.equal(claudeWin.evidence, "verified");

  // 예시 2: Windows gemini Agy → headless (orca-idle-requires-narrow-screen)
  // 실측: tui-idle 120초 미도달, 폭 조정은 에이전트 식별 깨뜨림
  const geminiWin32 = predictLaunchPath({
    runner: "agy",
    model: "gemini-3.1-pro-high",
    platform: "win32",
    shell: "posix",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    ...V,
  });
  assert.equal(geminiWin32.path, "headless");
  assert.ok(
    geminiWin32.reason.includes("orca-idle-requires-narrow-screen"),
    "8행 reason 코드",
  );
  assert.equal(geminiWin32.evidence, "verified");

  // 예시 3: Codex 신뢰 없음 → blocked (codex-trust-workspace)
  const codexNoTrust = predictLaunchPath({
    runner: "codex",
    model: undefined,
    platform: "darwin",
    shell: "posix",
    trustRecordExists: true,
    codexTrustRecordExists: false,
    skipDangerousModePermissionPrompt: true,
    ...V,
  });
  assert.equal(codexNoTrust.path, "blocked");
  assert.ok(codexNoTrust.reason.includes("codex-trust-workspace"));

  // 예시 4: 버전 범위 밖 → blocked (unsupported_version)
  const badVersion = predictLaunchPath({
    runner: "agy",
    model: "gemini-3.1-pro-high",
    platform: "darwin",
    shell: "posix",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    orcaVersion: "2.0.0",
    cliVersion: SUPPORTED_CLI_VERSION,
  });
  assert.equal(badVersion.path, "blocked");
  assert.ok(badVersion.reason.includes("unsupported_version"));
});

test("마지막 행(untested_combination)이 나머지 모든 조합을 덮는다", () => {
  // 알 수 없는 runner
  const unknownRunner = predictLaunchPath({
    runner: "ollama",
    model: undefined,
    platform: "linux",
    shell: "posix",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    ...V,
  });
  assert.equal(unknownRunner.path, "blocked");
  assert.ok(unknownRunner.reason.includes("untested_combination"));

  // Agy unknown 계열 linux
  const unknownModel = predictLaunchPath({
    runner: "agy",
    model: "future-model-xyz",
    platform: "linux",
    shell: "posix",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    ...V,
  });
  assert.equal(unknownModel.path, "blocked");
  assert.ok(unknownModel.reason.includes("untested_combination"));
});

test("버전 범위 밖은 unsupported_version으로 차단된다", () => {
  const cases = [
    { orcaVersion: "0.9.0", cliVersion: SUPPORTED_CLI_VERSION },
    { orcaVersion: SUPPORTED_ORCA_VERSION, cliVersion: "1.0.0" },
    { orcaVersion: "2.0.0", cliVersion: "2.0.0" },
    { orcaVersion: "", cliVersion: SUPPORTED_CLI_VERSION },
    { orcaVersion: SUPPORTED_ORCA_VERSION, cliVersion: "" },
  ];
  for (const versionParams of cases) {
    const result = predictLaunchPath({
      runner: "claude",
      model: undefined,
      platform: "win32",
      shell: "powershell",
      trustRecordExists: true,
      skipDangerousModePermissionPrompt: true,
      ...versionParams,
    });
    assert.equal(
      result.path,
      "blocked",
      `Expected blocked for ${JSON.stringify(versionParams)}`,
    );
    assert.ok(
      result.reason.includes("unsupported_version"),
      `Expected unsupported_version for ${JSON.stringify(versionParams)}`,
    );
  }
});

test("unverified supervised-terminal은 검증 모드 없이 blocked된다", () => {
  // Agy gemini posix - unverified
  const withoutApproval = predictLaunchPath({
    runner: "agy",
    model: "gemini-3.8-flash-high",
    platform: "darwin",
    shell: "posix",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    allowUnverified: false,
    ...V,
  });
  assert.equal(withoutApproval.path, "blocked");
  assert.deepEqual(withoutApproval.reason, ["unverified-terminal-creation"]);

  // allowUnverified=true지만 승인 문장 없음 → blocked
  const withoutApprovalText = predictLaunchPath({
    runner: "agy",
    model: "gemini-3.8-flash-high",
    platform: "darwin",
    shell: "posix",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    allowUnverified: true,
    allowUnverifiedApproval: undefined,
    ...V,
  });
  assert.equal(withoutApprovalText.path, "blocked");
  assert.deepEqual(withoutApprovalText.reason, [
    "unverified-terminal-creation",
  ]);

  // allowUnverified=true 승인 문장 있음 → supervised-terminal
  const withApproval = predictLaunchPath({
    runner: "agy",
    model: "gemini-3.8-flash-high",
    platform: "darwin",
    shell: "posix",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    allowUnverified: true,
    allowUnverifiedApproval: "PM 승인: 2026-09-17",
    ...V,
  });
  assert.equal(withApproval.path, "supervised-terminal");
  assert.equal(withApproval.evidence, "unverified");
});

test("Agy claude 모델은 신뢰 기록 있어도 blocked된다", () => {
  const result = predictLaunchPath({
    runner: "agy",
    model: "claude-sonnet-4-6",
    platform: "linux",
    shell: "posix",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    ...V,
  });
  assert.equal(result.path, "blocked");
  assert.ok(result.reason.includes("claude-unsupported-by-orca"));
  assert.equal(result.evidence, "verified");
});

test("Windows Agy powershell 복합 명령은 no_agent_detected로 차단된다", () => {
  // isCompoundCommand=true(복합 명령)일 때만 no_agent_detected → 2행 적용
  for (const model of ["gemini-3.1-pro-high", "gpt-oss-120b-medium"]) {
    const result = predictLaunchPath({
      runner: "agy",
      model,
      platform: "win32",
      shell: "powershell",
      trustRecordExists: true,
      skipDangerousModePermissionPrompt: true,
      isCompoundCommand: true,
      allowUnverified: true,
      allowUnverifiedApproval: "승인",
      ...V,
    });
    assert.equal(result.path, "blocked", `model=${model} should be blocked`);
    assert.ok(
      result.reason.includes("no_agent_detected"),
      `model=${model} should have no_agent_detected`,
    );
  }
});

test("Windows Agy powershell 단일 명령은 no_agent_detected 없이 진행한다", () => {
  // 실측 수정: 구현은 Windows에서 폭 조정을 생략해 단일 명령만 입력(isCompoundCommand=false).
  // gemini → 표 3행(신뢰 없음) 또는 표 8행(gemini win32 신뢰 있음) 도달.
  // gemini + 신뢰 있음 → 8행 supervised-terminal/unverified → allowUnverified 없으면 blocked(unverified-terminal-creation)
  const geminiWithTrust = predictLaunchPath({
    runner: "agy",
    model: "gemini-3.1-pro-high",
    platform: "win32",
    shell: "powershell",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    isCompoundCommand: false,
    allowUnverified: false,
    ...V,
  });
  // gemini+win32+신뢰 있음 → 8행 headless (orca-idle-requires-narrow-screen)
  // evidence=verified → applyVerificationGate 미적용 → headless 그대로 반환
  assert.equal(geminiWithTrust.path, "headless");
  assert.ok(
    geminiWithTrust.reason.includes("orca-idle-requires-narrow-screen"),
    "8행 reason 코드",
  );

  // allowUnverified=true+승인 → 8행 headless (verified, gate 불필요)
  const geminiAllowed = predictLaunchPath({
    runner: "agy",
    model: "gemini-3.1-pro-high",
    platform: "win32",
    shell: "powershell",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    isCompoundCommand: false,
    allowUnverified: true,
    allowUnverifiedApproval: "PM 승인",
    ...V,
  });
  assert.equal(geminiAllowed.path, "headless");
  assert.equal(geminiAllowed.evidence, "verified");
});

test("Codex 신뢰 기록이 표 4행 입력에 올바르게 연결된다", () => {
  // codexTrustRecordExists: true → 4행 건너뜀 → Codex 신뢰 있음 경로(13행)
  const trusted = predictLaunchPath({
    runner: "codex",
    model: undefined,
    platform: "darwin",
    shell: "posix",
    trustRecordExists: false, // Agy 신뢰 기록(무관)
    codexTrustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    ...V,
  });
  assert.notEqual(
    trusted.reason?.[0],
    "codex-trust-workspace",
    "codexTrustRecordExists=true → 4행 건너뜀",
  );

  // codexTrustRecordExists: false → 4행 적용
  const notTrustedFalse = predictLaunchPath({
    runner: "codex",
    model: undefined,
    platform: "darwin",
    shell: "posix",
    trustRecordExists: true,
    codexTrustRecordExists: false,
    skipDangerousModePermissionPrompt: true,
    ...V,
  });
  assert.equal(notTrustedFalse.path, "blocked");
  assert.ok(
    notTrustedFalse.reason.includes("codex-trust-workspace"),
    "codexTrustRecordExists=false → blocked(codex-trust-workspace)",
  );

  // codexTrustRecordExists: "unknown" → 4행 적용 (신뢰 미확인도 차단)
  const notTrustedUnknown = predictLaunchPath({
    runner: "codex",
    model: undefined,
    platform: "darwin",
    shell: "posix",
    trustRecordExists: true,
    codexTrustRecordExists: "unknown",
    skipDangerousModePermissionPrompt: true,
    ...V,
  });
  assert.equal(notTrustedUnknown.path, "blocked");
  assert.ok(
    notTrustedUnknown.reason.includes("codex-trust-workspace"),
    "codexTrustRecordExists=unknown → blocked(codex-trust-workspace)",
  );
});
