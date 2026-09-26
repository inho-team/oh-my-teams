# 플랫폼 차이 판정 검증 및 tui-idle 관측 기록

기준 커밋: 0a030a6a2a552add06941c881365a043ee33af48 (2026-09-26 06:43:29 KST)

## 1. 문제 B, C, D 증거 재검증

### 문제 B: Windows에서 폭 조정 명령이 붙는 현상

**현황**: 해결됨

재확인한 코드:

- `plugins/oh-my-teams/scripts/role-terminal.mjs:246-248`
  ```javascript
  export function launchLine(command) {
    return { typed: command.command, columns: null };
  }
  ```
  `launchLine`이 분기 없이 `columns: null`을 반환합니다.

- `tests/role-terminal.test.mjs:755-768`
  ```javascript
  test("win32/POSIX별 실행 명령: 어떤 플랫폼에서도 폭 조정 명령이 붙지 않는다", () => {
    // #104: Orca 1.4.210에서는 POSIX Agy Gemini도 폭 조정 없이 tui-idle을 통과한다.
    const org = example();
    const gemini = roleCommand(org, "senior");
    assert.equal(gemini.provider, "agy");
    assert.match(gemini.modelRequested, /^gemini/i);

    for (const platform of ["darwin", "linux", "win32"]) {
      const result = launchLine(gemini, platform);
      assert.doesNotMatch(result.typed, /stty/);
      assert.doesNotMatch(result.typed, /mode con/);
      assert.equal(result.columns, null);
      assert.equal(result.typed, gemini.command);
    }

    // Claude는 플랫폼 무관하게 폭 조정 없음(변경 전과 동일)
    const claude = roleCommand(org, "pm");
    assert.equal(launchLine(claude, "win32").columns, null);
    assert.equal(launchLine(claude, "darwin").columns, null);
  });
  ```
  세 플랫폼(darwin, linux, win32) 모두에서 `mode con` 구문이 붙지 않음을 단언합니다.

### 문제 C: 신뢰 거부 경로가 차단 상태를 보고하지 않는 현상

**현황**: 해결됨

재확인한 코드:

- `plugins/oh-my-teams/scripts/orca-adapter.mjs:692-733`
  ```javascript
  } catch (error) {
    if (!INJECT_REFUSALS.has(error.signal?.code)) throw error;
    const injectRefusal = translateInjectRefusal(
      error.signal.code,
      error.signal.message,
    );
    let taskClosed = false;
    if (taskCreated) {
      try {
        await runOrcaJson(
          selected,
          [
            "orchestration",
            "task-update",
            "--id",
            taskId,
            "--status",
            "failed",
            "--result",
            JSON.stringify({ refused: injectRefusal.code }),
            ...runArgs,
          ],
          { cwd: repo, execute },
        );
        taskClosed = true;
      } catch {
        // The refusal is the fact to report; a task left open is named by
        // taskClosed so the coordinator closes it rather than guessing.
      }
    }
    return {
      taskId,
      taskCreated,
      taskClosed,
      dispatchId: null,
      runId: runId ?? null,
      terminal,
      injected: false,
      injectRefusal,
      orcaResponse: error.message,
    };
  }
  ```
  catch 블록이 INJECT_REFUSALS에 있는 코드만 처리하고, `injected: false`, `injectRefusal`, `taskId`, `taskClosed`, `orcaResponse`를 담은 결과를 반환합니다.

- `plugins/oh-my-teams/scripts/teams-org.mjs:1108-1111`
  ```javascript
  ...(injected.injected ? {} : { status: "blocked" }),
  ...(injected.injectRefusal
    ? { route: classifyFailure(injected.injectRefusal) }
    : {}),
  ```
  injected가 false이면 `status: "blocked"`를 붙이고, injectRefusal이 있으면 route를 붙입니다.

### 문제 D: 신뢰 거부가 예약된 시도를 차단하지 않는 현상

**현황**: 해결됨

재확인한 코드:

- `plugins/oh-my-teams/scripts/orca-adapter.mjs:60-72`
  ```javascript
  export function translateInjectRefusal(code, message) {
    const normalized = String(code ?? "").trim();
    if (!INJECT_REFUSALS.has(normalized)) {
      return translateOrcaFailure(code, message);
    }
    return assertFailureSignal({
      kind: "not-started",
      code: normalized,
      message:
        String(message ?? "").trim() ||
        `Orca refused the injection: ${normalized}`,
    });
  }
  ```
  INJECT_REFUSALS에 있는 코드를 `kind: "not-started"`로 번역합니다.

- `plugins/oh-my-teams/scripts/failures.mjs:85-87`
  ```javascript
  if (input.kind === "not-started") {
    return route("start-refused", "pm", "change-launch-path", false);
  }
  ```
  kind가 "not-started"일 때 start-refused 분류로 `retryable: false`를 지정합니다.

- `plugins/oh-my-teams/scripts/workflow.mjs:1463-1474`
  ```javascript
  const refused = input.refusal !== undefined;
  if (refused) {
    assertFailureSignal(input.refusal);
    assert(
      input.refusal.kind === "not-started",
      "Only a launch refused before any work started returns its attempt",
    );
    if (attempt.handoffIndex === undefined) state.budget.attemptsUsed -= 1;
    attempt.refusal = input.refusal;
  }
  ```
  `refusal.kind === "not-started"`일 때만 예약된 시도를 반환하고 예약된 시도 예산을 복구합니다.

### 이슈 #46 댓글 초안

아래 댓글은 PM이 이슈에 게시합니다 (본 문서 작성자가 게시하지 않음).

---

**제목: 문제 B, C, D 해결 확인**

#46의 문제 B(Windows 폭 조정), C(신뢰 거부 차단), D(신뢰 거부 예약 시도 차단)가 이미 코드에 반영되어 있음을 확인했습니다.

**B. Windows에서 폭 조정 명령이 붙는 현상**
- 해결: `role-terminal.mjs:246-248`의 `launchLine`이 분기 없이 `columns: null`을 반환
- 검증: `tests/role-terminal.test.mjs:755-768`이 darwin, linux, win32 세 플랫폼 모두에서 `mode con` 없음을 단언

**C. 신뢰 거부 경로가 차단 상태를 보고하지 않는 현상**
- 해결: `orca-adapter.mjs:692-733`의 catch 블록이 `injected: false`와 `injectRefusal`을 결과에 담음
- 연결: `teams-org.mjs:1108-1111`이 injected가 false일 때 `status: "blocked"`를 붙임

**D. 신뢰 거부가 예약된 시도를 차단하지 않는 현상**
- 해결: `orca-adapter.mjs:60-72`가 Orca 거부를 `kind: "not-started"`로 번역
- 분류: `failures.mjs:85-87`이 `"not-started"`를 `retryable: false`로 표시
- 제어: `workflow.mjs:1463-1474`가 `refusal.kind === "not-started"`일 때만 예약 시도 반환

**이슈 종료**는 이사의 결정입니다.

---

## 2. 문제 A 관측 기록

### 관측 환경

- **macOS** Darwin 24.6.0, 셸 zsh
- **Orca CLI/runtime** 1.4.210
- **Antigravity CLI** 1.2.11
- **oh-my-teams** 2.8.9
- **기준 커밋**: 0a030a6a2a552add06941c881365a043ee33af48
- **관측용 워크트리**: id:955a83a3-27ee-457a-8ff5-3dff4694e8aa::/Users/jinsungkim/orca/workspaces/oh-my-teams/spa-agy-trust

### 관측 방법

60초 간격으로 다음 정보를 수집했습니다 (40분 이상):

1. **시간** (ISO 8601, UTC)
2. **각 터미널 상태** (`terminal list --json`):
   - `agentIdentity` 필드 (있음/없음/변화)
   - `status` 필드
   - `lastOutputAt` 필드
3. **tui-idle 판정** (`terminal wait --for tui-idle --timeout-ms 5000`):
   - `satisfied` 또는 `ok` 필드
   - 타임아웃 여부
4. **화면 내용** (`terminal read --screen`):
   - 해시값으로 기록 (변화 감지용)

### 생성한 터미널

| 터미널 | 생성 방법 | 목적 |
|--------|---------|------|
| (a) 셸 직접 | `orca terminal create --worktree` (빈 셸) | Agy 명령을 사용자가 입력하는 경로 |
| (b) 명령 실행 | `orca terminal create --worktree --command "agy --dangerously-skip-permissions --model gpt-oss-120b-medium"` | role-terminal이 만드는 경로 |
| (c) 대조군 | `orca terminal create --worktree` (빈 셸) | tui-idle 판정의 기준선 |

### 원시 데이터

**위치**: `/var/tmp/agy-tui-idle-samples.jsonl` (관측 시작 시 기록)

형식: 각 줄이 하나의 샘플 (JSON 객체)

```json
{
  "timestamp": "2026-09-26T10:30:45.123Z",
  "terminals": {
    "a": {
      "agentIdentity": null or "antigravity",
      "status": "running",
      "lastOutputAt": "2026-09-26T10:29:15.456Z",
      "idleCheck": true or false,
      "idleWaitOk": true or false,
      "idleWaitTimeout": true or false,
      "screenHash": "abc123def456..."
    },
    "b": { ... },
    "c": { ... }
  }
}
```

### 관측 결과 요약

**관측 기간**: 2026-09-26T01:36:03.828Z ~ 2026-09-26T02:15:16.201Z (약 39분 12초)  
**샘플 개수**: 32개 (60초 간격 시도, 실제 간격 약 73~76초)  
**원시 데이터 경로**: `/var/tmp/agy-tui-idle-samples.jsonl`

#### 주요 관측 결과

| 항목 | (a) 셸 직접 | (b) 명령 실행 | (c) 대조군 |
|-----|-----------|-----------|---------|
| agentIdentity | null (전체 샘플) | null (전체 샘플) | null (전체 샘플) |
| tui-idle 판정 | false (전체 샘플) | false (전체 샘플) | false (전체 샘플) |
| 화면 해시 | 동일 (변화 없음) | 동일 (변화 없음) | 동일 (변화 없음) |
| 샘플 상태 | 대기 중 (idle 미판정) | 대기 중 (idle 미판정) | 대기 중 (idle 미판정) |

#### agentIdentity 변화

- **(a) 셸 직접**: 처음부터 마지막까지 null (할당되지 않음)
- **(b) 명령 실행**: 처음부터 마지막까지 null (할당되지 않음)
- **(c) 대조군**: 처음부터 마지막까지 null (할당되지 않음)

#### tui-idle 판정 변화

- **(a) 셸 직접**: 처음부터 마지막까지 false (미판정 상태 유지)
- **(b) 명령 실행**: 처음부터 마지막까지 false (미판정 상태 유지)
- **(c) 대조군**: 처음부터 마지막까지 false (미판정 상태 유지)

#### 화면 출력 변화

- 변화 관측: 없음 (모든 샘플에서 screenHash 동일)
- 변화 없음: 전체 (초기 상태 유지)

#### 표본 간격 분석

| 전환 | 간격 (초) |
|-----|---------|
| 샘플 1→2 | 72 |
| 샘플 2→3 | 76 |
| 샘플 3→4 | 76 |
| 평균 | 약 73~76 |

목표 60초보다 약 13~16초 길어졌으며, 이는 `orca terminal list`, `orca terminal wait`, `orca terminal read` 명령 실행 시간 때문으로 추정됩니다.

### 확인하지 못한 것

1. **agentIdentity 붙는 시점**: 32개 샘플 전체에서 agentIdentity가 null이었으므로, 지난 관측과 달리 이번에는 에이전트 식별이 발생하지 않았습니다. 원인은 불명확하며, 시점 차이나 환경 차이로 인한 재현 불가능성을 고려해야 합니다.

2. **tui-idle 판정 변화**: 32개 샘플 모두에서 `terminal wait --for tui-idle --timeout-ms 5000`이 timeout되었습니다. 지난 관측에서 (a) 셸은 tui-idle을 보고했으나, 이번에는 세 터미널 모두 보고하지 않았습니다.

3. **화면 출력 변화 재현 불가**: 스크린샷 해시가 변하지 않았으므로, 화면 재갱신 현상을 확인할 수 없었습니다.

### 3. 터미널 종료

**표본 수집 완료 후 실행 (2026-09-26 11:15:27 UTC)**

- 터미널 (a) 종료: `orca terminal close --terminal term_f6c0ce8d-4fd7-43be-9673-4b7def345b33` ✓
- 터미널 (b) 종료: `orca terminal close --terminal term_05e1a87f-cc81-48c4-b537-2717c20d8d5c` ✓
- 터미널 (c) 종료: `orca terminal close --terminal term_f429597f-561f-4a76-aa1f-35b2e9c4772d` ✓

모든 터미널이 정상 종료되었습니다 (PTY killed).

---

## 참고

- 지난 관측 기록: `/Users/jinsungkim/orca/oh-my-teams/.omt/history/supervised-prompt-answers-w3/agy-tui-idle-observation.md`
- 선행 조사: `docs/plan/agy-terminal-path.md`, `docs/plan/agy-terminal-probes.md`
- 이슈 #46 기본 정보: 관측 기록과 함께 생성된 댓글 참조
