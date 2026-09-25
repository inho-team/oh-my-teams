/** 호환성 표(launch-matrix.mjs) 결정적 테스트 - 브리프 기준 8. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeModelFamily,
  predictLaunchPath,
  classifyVersion,
  VERIFIED_CLI_VERSION,
  VERIFIED_ORCA_VERSION,
} from "../plugins/oh-my-teams/scripts/launch-matrix.mjs";

// 기본 지원 버전
const V = {
  orcaVersion: VERIFIED_ORCA_VERSION,
  cliVersion: VERIFIED_CLI_VERSION,
};

test("검증 버전 상수가 Orca 1.4.210·Antigravity CLI 1.2.11이다 (acceptance: verified-versions)", () => {
  assert.equal(VERIFIED_ORCA_VERSION, "1.4.210");
  assert.equal(VERIFIED_CLI_VERSION, "1.2.11");
});

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
        cliVersion: VERIFIED_CLI_VERSION,
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
        orcaVersion: VERIFIED_ORCA_VERSION,
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
    // 7. (구 규칙 삭제, #104) Agy claude 계열 posix 신뢰 있음 → 10행 적용, supervised-terminal(verified)
    {
      label: "agy_claude_model_posix",
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
    // 10. Agy POSIX 신뢰 있음(모델 계열 무관) → supervised-terminal (verified)
    {
      label: "agy_gemini_posix",
      params: {
        runner: "agy",
        model: "gemini-3.8-flash-medium",
        platform: "darwin",
        shell: "posix",
        trustRecordExists: true,
        skipDangerousModePermissionPrompt: true,
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
    // 12. Codex 신뢰 있음 → supervised-terminal (verified, 실측 완료 2026-09-18)
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
        ...V,
      },
    },
    // 13. 나머지 모든 미확인 조합. 10행이 모델 계열 무관 POSIX Agy를 모두 덮으므로(#104),
    // agy·claude·codex 밖의 runner만 이 행에 남는다.
    {
      label: "unrecognized_runner",
      params: {
        runner: "some-future-runner",
        model: undefined,
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
  // 실측(Orca 1.4.204): tui-idle 120초 미도달, 폭 조정은 에이전트 식별 깨뜨림.
  // 그 판정 규칙은 1.4.210에서 교체되어 사라졌고 재검증할 Windows 머신이 없어
  // evidence는 unverified로 낮아졌다(#104). 경로(headless)는 바뀌지 않는다.
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
  assert.equal(geminiWin32.evidence, "unverified");

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

  // 예시 4: 검증에 쓰지 않은 버전 → 경로는 유지하고 근거 등급만 한 단계 낮춘다
  // 10행의 기본 근거 등급은 verified이므로, 버전 불일치는 unverified가 아니라
  // source-derived로 한 단계만 낮춘다.
  const otherVersion = predictLaunchPath({
    runner: "agy",
    model: "gemini-3.1-pro-high",
    platform: "darwin",
    shell: "posix",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    orcaVersion: "2.0.0",
    cliVersion: VERIFIED_CLI_VERSION,
  });
  assert.equal(otherVersion.path, "supervised-terminal");
  assert.equal(otherVersion.evidence, "source-derived");
  assert.ok(otherVersion.reason.includes("untested_version"));
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

  // #104: 10행이 모델 계열과 무관하게 Agy POSIX 신뢰 있음을 모두 덮으므로,
  // 이전에는 미확인 조합(13행)이던 Agy unknown 계열 linux도 이제 10행에 걸린다.
  const unknownModel = predictLaunchPath({
    runner: "agy",
    model: "future-model-xyz",
    platform: "linux",
    shell: "posix",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    ...V,
  });
  assert.equal(unknownModel.path, "supervised-terminal");
  assert.equal(unknownModel.evidence, "verified");
});

test("Orca 패치 갱신은 검증된 경로를 막지 않는다 (#61)", () => {
  // Orca가 자동 갱신되어 패치 버전만 달라진 경우. 이전에는 모든 역할이
  // unsupported_version으로 막혀 kickoff가 워커를 하나도 시작하지 못했다.
  const claudePatch = predictLaunchPath({
    runner: "claude",
    model: "sonnet",
    platform: "win32",
    shell: "powershell",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    orcaVersion: "1.4.205",
    cliVersion: "unknown",
  });
  assert.equal(claudePatch.path, "supervised-terminal");
  assert.equal(claudePatch.evidence, "verified");
  assert.ok(claudePatch.reason.includes("untested_patch_version"));

  const agyPatch = predictLaunchPath({
    runner: "agy",
    model: "gemini-3.8-flash-high",
    platform: "win32",
    shell: "powershell",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    orcaVersion: "1.4.205",
    cliVersion: VERIFIED_CLI_VERSION,
  });
  assert.equal(agyPatch.path, "headless");
  // 8행의 근거 등급은 verified가 아니라 unverified로 고정되어 있으므로(#104),
  // Orca 버전이 일치해도 패치 버전 갱신이 이를 다시 올리지 않는다.
  assert.equal(agyPatch.evidence, "unverified");
});

test("Orca 버전을 확인하지 못해도 검증된 경로는 한 단계만 낮아진다", () => {
  for (const orcaVersion of ["1.5.0", "unknown", ""]) {
    const result = predictLaunchPath({
      runner: "claude",
      model: "sonnet",
      platform: "win32",
      shell: "powershell",
      trustRecordExists: true,
      skipDangerousModePermissionPrompt: true,
      orcaVersion,
      cliVersion: "unknown",
    });
    assert.equal(
      result.path,
      "supervised-terminal",
      `Expected supervised-terminal for orcaVersion=${orcaVersion}`,
    );
    assert.equal(result.evidence, "source-derived");
    assert.ok(result.reason.includes("untested_version"));
  }
});

test("Antigravity CLI 버전은 Agy 역할에만 적용된다", () => {
  const claudeWithOldCli = predictLaunchPath({
    runner: "claude",
    model: "sonnet",
    platform: "win32",
    shell: "powershell",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    orcaVersion: VERIFIED_ORCA_VERSION,
    cliVersion: "0.1.0",
  });
  assert.equal(claudeWithOldCli.path, "supervised-terminal");
  assert.equal(claudeWithOldCli.evidence, "verified");
  assert.deepEqual(claudeWithOldCli.reason, []);

  const agyWithOldCli = predictLaunchPath({
    runner: "agy",
    model: "gemini-3.8-flash-high",
    platform: "darwin",
    shell: "posix",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    orcaVersion: VERIFIED_ORCA_VERSION,
    cliVersion: "0.1.0",
    allowUnverified: true,
    allowUnverifiedApproval: "이사 승인",
  });
  assert.equal(agyWithOldCli.path, "supervised-terminal");
  assert.ok(agyWithOldCli.reason.includes("untested_version"));
});

test("headless 경로는 Orca 버전 차이의 영향을 받지 않는다", () => {
  const headless = predictLaunchPath({
    runner: "agy",
    model: "gemini-3.8-flash-high",
    platform: "win32",
    shell: "powershell",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    orcaVersion: "9.9.9",
    cliVersion: VERIFIED_CLI_VERSION,
  });
  assert.equal(headless.path, "headless");
  assert.equal(headless.evidence, "unverified");
  assert.ok(!headless.reason.includes("untested_version"));
});

test("classifyVersion은 같은 버전·패치 차이·그 밖을 구분한다", () => {
  assert.equal(classifyVersion("1.4.204", "1.4.204"), "match");
  assert.equal(classifyVersion(" 1.4.204 ", "1.4.204"), "match");
  assert.equal(classifyVersion("1.4.205", "1.4.204"), "patch-diff");
  assert.equal(classifyVersion("1.4.0", "1.4.204"), "patch-diff");
  assert.equal(classifyVersion("1.5.0", "1.4.204"), "unknown");
  assert.equal(classifyVersion("2.0.0", "1.4.204"), "unknown");
  assert.equal(classifyVersion("", "1.4.204"), "unknown");
  assert.equal(classifyVersion(undefined, "1.4.204"), "unknown");
  assert.equal(classifyVersion("unknown", "1.4.204"), "unknown");
});

test("unverified supervised-terminal은 승인 유무와 관계없이 경고와 함께 실행된다", () => {
  // #104로 10행(Agy POSIX)의 기본 근거 등급이 verified로 올라갔으므로,
  // 여기서는 기본 근거 등급이 여전히 unverified인 11행(Claude POSIX)을 쓴다.
  const withoutApproval = predictLaunchPath({
    runner: "claude",
    model: undefined,
    platform: "darwin",
    shell: "posix",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    allowUnverified: false,
    ...V,
  });
  assert.equal(withoutApproval.path, "supervised-terminal");
  assert.deepEqual(withoutApproval.reason, ["unverified-terminal-evidence"]);

  // 기존 옵션만 전달해도 경고와 함께 실행한다.
  const withoutApprovalText = predictLaunchPath({
    runner: "claude",
    model: undefined,
    platform: "darwin",
    shell: "posix",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    allowUnverified: true,
    allowUnverifiedApproval: undefined,
    ...V,
  });
  assert.equal(withoutApprovalText.path, "supervised-terminal");
  assert.deepEqual(withoutApprovalText.reason, [
    "unverified-terminal-evidence",
  ]);

  // allowUnverified=true 승인 문장 있음 → supervised-terminal
  const withApproval = predictLaunchPath({
    runner: "claude",
    model: undefined,
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

test("Agy claude 모델은 더 이상 blocked되지 않고 POSIX에서 supervised-terminal(verified)이다 (acceptance: rule7-removed)", () => {
  // #104: Orca 1.4.210 실측으로 claude-unsupported-by-orca 규칙(구 7행)이 삭제됐다.
  const result = predictLaunchPath({
    runner: "agy",
    model: "claude-sonnet-4-6",
    platform: "linux",
    shell: "posix",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    ...V,
  });
  assert.equal(result.path, "supervised-terminal");
  assert.equal(result.evidence, "verified");
  assert.ok(!result.reason.includes("claude-unsupported-by-orca"));
  assert.deepEqual(result.reason, []);
});

test("Agy POSIX 신뢰 있음은 모델 계열과 무관하게 supervised-terminal(verified)이다 (acceptance: posix-supervised-verified)", () => {
  for (const model of [
    "gemini-3.1-pro-high",
    "claude-sonnet-4-6",
    "gpt-oss-120b-medium",
    "some-unrecognized-model",
    undefined,
  ]) {
    for (const platform of ["darwin", "linux"]) {
      const result = predictLaunchPath({
        runner: "agy",
        model,
        platform,
        shell: "posix",
        trustRecordExists: true,
        skipDangerousModePermissionPrompt: true,
        ...V,
      });
      const label = `model=${model} platform=${platform}`;
      assert.equal(result.path, "supervised-terminal", label);
      assert.equal(result.evidence, "verified", label);
      assert.deepEqual(result.reason, [], label);
    }
  }
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
  // gemini + 신뢰 있음 → 8행 headless, evidence: unverified(#104), 승인 옵션과 무관하다.
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
  assert.equal(geminiWithTrust.path, "headless");
  assert.ok(
    geminiWithTrust.reason.includes("orca-idle-requires-narrow-screen"),
    "8행 reason 코드",
  );

  // allowUnverified=true+승인 → 8행 headless (evidence는 unverified 그대로, gate 불필요)
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
  assert.equal(geminiAllowed.evidence, "unverified");
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

test("Codex 신뢰 있음은 verified supervised-terminal을 돌려주고 검증 게이트 없이 통과한다", () => {
  // codexTrustRecordExists: true → 12행 → supervised-terminal, evidence=verified
  // allowUnverified 없이도 막히지 않아야 함
  const trusted = predictLaunchPath({
    runner: "codex",
    model: undefined,
    platform: "darwin",
    shell: "posix",
    trustRecordExists: false,
    codexTrustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    allowUnverified: false,
    ...V,
  });
  assert.equal(
    trusted.path,
    "supervised-terminal",
    "codex 신뢰 있음 → supervised-terminal",
  );
  assert.equal(trusted.evidence, "verified", "evidence=verified");
  assert.deepEqual(trusted.reason, [], "reason 빈 배열");
  assert.equal(trusted.nextOwner, "-", "nextOwner='-'");
  assert.equal(trusted.nextAction, "", "nextAction=''");

  // 플랫폼·셸이 달라도 동일하게 적용됨
  const trustedWin = predictLaunchPath({
    runner: "codex",
    model: undefined,
    platform: "win32",
    shell: "powershell",
    trustRecordExists: false,
    codexTrustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    allowUnverified: false,
    ...V,
  });
  assert.equal(
    trustedWin.path,
    "supervised-terminal",
    "codex win32 신뢰 있음 → supervised-terminal",
  );
  assert.equal(trustedWin.evidence, "verified");
});

test("Codex 신뢰 없음/unknown은 4행 codex-trust-workspace로 차단된다", () => {
  for (const codexTrustRecordExists of [false, "unknown", undefined, null]) {
    const result = predictLaunchPath({
      runner: "codex",
      model: undefined,
      platform: "linux",
      shell: "posix",
      trustRecordExists: true,
      codexTrustRecordExists,
      skipDangerousModePermissionPrompt: true,
      allowUnverified: true,
      allowUnverifiedApproval: "승인",
      ...V,
    });
    assert.equal(
      result.path,
      "blocked",
      `codexTrustRecordExists=${JSON.stringify(codexTrustRecordExists)} → blocked`,
    );
    assert.ok(
      result.reason.includes("codex-trust-workspace"),
      `codexTrustRecordExists=${JSON.stringify(codexTrustRecordExists)} → codex-trust-workspace`,
    );
  }
});

test("Windows 규칙(8·9)은 headless를 유지하되 evidence가 verified가 아니다 (acceptance: windows-evidence)", () => {
  // 근거였던 Orca 1.4.204의 판정 규칙은 1.4.210에서 교체되어 더 이상 존재하지 않고,
  // 재검증할 Windows 머신이 없다(#104). 경로(headless)는 바뀌지 않는다.
  const gemini = predictLaunchPath({
    runner: "agy",
    model: "gemini-3.1-pro-high",
    platform: "win32",
    shell: "powershell",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    ...V,
  });
  assert.equal(gemini.path, "headless");
  assert.ok(gemini.reason.includes("orca-idle-requires-narrow-screen"));
  assert.notEqual(gemini.evidence, "verified");
  assert.equal(gemini.evidence, "unverified");

  const gptOss = predictLaunchPath({
    runner: "agy",
    model: "gpt-oss-120b-medium",
    platform: "win32",
    shell: "powershell",
    trustRecordExists: true,
    skipDangerousModePermissionPrompt: true,
    ...V,
  });
  assert.equal(gptOss.path, "headless");
  assert.ok(gptOss.reason.includes("agy-headless-fallback"));
  assert.notEqual(gptOss.evidence, "verified");
  assert.equal(gptOss.evidence, "unverified");
});
