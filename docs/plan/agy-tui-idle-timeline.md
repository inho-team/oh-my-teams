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

- `tests/role-terminal.test.mjs:755-774`
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

- `plugins/oh-my-teams/scripts/workflow.mjs:1465-1474`
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
- 검증: `tests/role-terminal.test.mjs:755-774`이 darwin, linux, win32 세 플랫폼 모두에서 `mode con` 없음을 단언

**C. 신뢰 거부 경로가 차단 상태를 보고하지 않는 현상**
- 해결: `orca-adapter.mjs:692-733`의 catch 블록이 `injected: false`와 `injectRefusal`을 결과에 담음
- 연결: `teams-org.mjs:1108-1111`이 injected가 false일 때 `status: "blocked"`를 붙임

**D. 신뢰 거부가 예약된 시도를 차단하지 않는 현상**
- 해결: `orca-adapter.mjs:60-72`가 Orca 거부를 `kind: "not-started"`로 번역
- 분류: `failures.mjs:85-87`이 `"not-started"`를 `retryable: false`로 표시
- 제어: `workflow.mjs:1465-1474`가 `refusal.kind === "not-started"`일 때만 예약 시도 반환

**이슈 종료**는 이사의 결정입니다.

---

## 2. 문제 A 관측 기록

### 2.0 첫 관측은 무효입니다

이 절의 이전 버전(커밋 5bda6bd)이 사용한 관측은 독립 검토(`review-issue46-record-1`)에서 수집기 결함으로 지적되어 결과로 쓰지 않습니다. 결함은 두 가지입니다.

1. **`orca terminal list --json`의 응답 형태를 배열로 잘못 가정함**: 실제 응답은 `{ ok: true, result: { terminals: [...] } }` 형태인데, 수집기(`/var/tmp/collect-agy-samples.mjs:58`)는 `Array.isArray(parsed)`로 확인해 항상 거짓이 되고, 그 결과 `agentIdentity`가 32개 샘플 전부에서 `null`로 기록되었습니다.
2. **`terminal wait`·`terminal read` 호출에 `--json`을 빠뜨림**: `--json`은 선택 플래그이고 생략하면 사람이 읽는 평문을 반환하는데(`--help`로 확인), 수집기가 그 평문을 `JSON.parse`하면서 예외가 나 `catch`에서 조용히 삼켜지고 `idleOk`/`idleTimeout`이 초기값 `false`/`false`에 머물렀습니다. 문서는 이를 "32개 샘플 모두 timeout"이라고 적었지만, 코드상 `idleTimeout = !idleOk`가 정상 실행되었다면 나올 수 없는 조합이라 raw 데이터와 모순되었습니다.

결함 있는 수집기와 그 원시 데이터는 삭제하지 않고 그대로 보존했습니다: `/var/tmp/collect-agy-samples.mjs`, `/var/tmp/agy-tui-idle-samples.jsonl`. 아래는 이 두 결함과, 관측 도중 추가로 발견한 세 번째 결함을 고친 새 수집기로 다시 수행한 관측입니다.

### 2.1 관측 환경

- **macOS** 15.7.4 (Darwin 24.6.0), 셸 zsh
- **Orca CLI/runtime** 1.4.210
- **Antigravity CLI** 1.2.11
- **oh-my-teams** 2.8.10
- **기준 커밋**: 0a030a6a2a552add06941c881365a043ee33af48
- **관측용 워크트리**: `id:955a83a3-27ee-457a-8ff5-3dff4694e8aa::/Users/jinsungkim/orca/workspaces/oh-my-teams/spa-agy-trust` (PM이 사전에 이 경로가 `~/.gemini/antigravity-cli/settings.json`의 `trustedWorkspaces`에 있음을 읽기 전용으로 확인)

### 2.2 새 수집기와 사전 보정

새 수집기: `/var/tmp/cpj-agy-tui-idle-v2/collect-v2.mjs` (워크트리 밖 OS 임시 디렉터리). 위 두 결함을 고쳤고, 첫 보정 실행에서 세 번째 결함을 추가로 찾아 고쳤습니다.

3. **(새로 발견) `execFileSync`가 exit code로만 실패를 판단함**: `orca terminal wait`는 timeout처럼 business-level 실패도 exit code 1로 종료하면서 stdout에는 `{ ok:false, error:{code:"timeout",...} }` JSON을 온전히 실어 보냅니다. `execFileSync`는 exit code가 0이 아니면 무조건 예외를 던지므로, 이 JSON을 읽지 않고 버리면 진짜 명령 실패(명령을 찾지 못함 등)와 "정상 응답이지만 ok:false"를 구분할 수 없습니다. `error.stdout`에 담긴 내용을 먼저 JSON으로 파싱하도록 고쳤습니다.

**보정 절차**: 터미널 (a)(b)(c)를 만든 직후 단일 샘플을 두 번 찍어 각 필드가 실제 값을 담는지 확인했습니다.

- **보정 1회차** (결함 3 발견 전, 터미널 생성 8초 후): `terminal list`는 실제 값(`status:"connected"`, 실제 `lastOutputAt`, (a)(b) 화면에 `Antigravity CLI 1.2.11` 배너 실측)을 정상적으로 담았지만, `tuiIdle`이 세 터미널 모두 `"error"`로 나와 결함 3을 발견했습니다. 원시 기록: `/var/tmp/cpj-agy-tui-idle-v2/calibration-sample-1.jsonl`.
- **보정 2회차** (결함 3 수정 후): `agentIdentity`가 (a)(b)에서 `"antigravity"`, (c)에서 `null`로 정확히 갈렸고, `tuiIdle`이 `"timeout"`으로 정상 분류되었습니다. `orca terminal read --screen --json`을 직접 실행해 (a)(b) 화면에 Antigravity CLI 배너와 `>` 프롬프트가, (c) 화면에는 평범한 zsh 프롬프트만 있음을 육안으로도 대조했습니다(신뢰 질문 없음). 원시 기록: `/var/tmp/cpj-agy-tui-idle-v2/calibration-sample-2.jsonl`.

두 보정 파일은 42분 본 관측의 표본 수에 포함하지 않았습니다.

### 2.3 생성한 터미널

계약 2번대로, 트러스트된 워크트리에 다른 입력 없이 아래 세 터미널만 만들었습니다.

| 터미널 | 핸들 | 생성 방법 | 목적 |
|--------|------|---------|------|
| (a) 셸 직접 | `term_a487ba70-56aa-466f-8b7a-92185f180f41` | `orca terminal create --worktree <trust>` (빈 셸) 뒤 `orca terminal send --text "agy --dangerously-skip-permissions --model gpt-oss-120b-medium" --enter` | Agy 명령을 사용자가 입력하는 경로 |
| (b) 명령 실행 | `term_03695168-7e24-4f5b-ad49-ab109ef232a5` | `orca terminal create --worktree <trust> --command "agy --dangerously-skip-permissions --model gpt-oss-120b-medium"` 뒤 `orca terminal send --text "" --enter` | role-terminal의 `launchOnce`가 만드는 경로(`role-terminal.mjs:679-691`, `:718`) |
| (c) 대조군 | `term_6e5d47d8-6cc4-4f75-9507-d14cbd3f408c` | `orca terminal create --worktree <trust>` (빈 셸, 입력 없음) | tui-idle 판정의 기준선 |

신뢰 질문이나 로그인 화면 같은 프롬프트는 세 터미널 어디에도 나타나지 않았습니다(트러스트된 워크트리이므로 예상된 결과).

**`terminal send` 응답 원문과 화면 대조**(직접 관측):

- (a): `provider: "unsupported"`, `warning: "input was accepted, but this provider cannot report delivery. Inspect the terminal before retrying."` — 같은 시점 `--screen` 대조 결과 명령이 실제로 실행되어 Antigravity CLI 배너가 떠 있었으므로, 이 경고는 실제 미전달을 뜻하지 않았습니다.
- (b): 경고 없이 `accepted: true`로 반환되었고, 화면 대조 결과도 정상 실행되었습니다.

> **참고(PM 전달, 이 워커의 오케스트레이션 채널로는 확인되지 않음)**: PM은 "이사"가 이 경고 문구의 의미(제출은 대기열에 들어가 있을 뿐 유실이 아니라는 취지)와 "PM도 방금 이 워커에게 지시를 보낼 때 같은 경고가 붙었다"는 취지의 자료(`director-evidence-t4b.md`)를 scratchpad 경로로 전달했습니다. 다만 이 워커가 `orca orchestration check`로 확인한 배정 채널에는 그 시각 수신 메시지가 0건이어서, "PM이 이 워커에게 방금 지시를 보냈다"는 부분은 이 워커의 기록과 맞지 않습니다. 그래서 이 문단은 그 자료의 주장을 사실로 적지 않고, 위 (a)(b)처럼 이 워커가 직접 받은 응답과 직접 대조한 화면만 사실로 기록했습니다.

### 2.4 원시 데이터

**위치**: `/var/tmp/cpj-agy-tui-idle-v2/samples.jsonl` (43분 본 관측), `/var/tmp/cpj-agy-tui-idle-v2/calibration-sample-{1,2}.jsonl` (사전 보정)

형식: 각 줄이 하나의 샘플(JSON 객체)이며, 결함 있던 v1과 달리 명령 실패(`commandError`)와 JSON 파싱 실패(`parseError`)와 orca가 보고한 실패(`error`)를 구분해서 남깁니다.

```json
{
  "timestampUtc": "2026-09-26T02:33:17.952Z",
  "terminals": {
    "a": {
      "handle": "term_a487ba70-...",
      "agentIdentity": "antigravity",
      "status": "connected",
      "lastOutputAt": 1790389884949,
      "error": null,
      "tuiIdle": "timeout",
      "screenHash": "eadd3cb8160be874",
      "screenPreview": ["...", "...", "..."],
      "source": "screen"
    },
    "b": { "...": "..." },
    "c": { "...": "..." }
  }
}
```

### 2.5 관측 결과 요약

**관측 기간**: 2026-09-26T02:33:17.952Z ~ 2026-09-26T03:17:08.965Z (UTC) = 11:33:17.952 ~ 12:17:08.965 (KST), 약 **43분 51초**(계약이 요구한 최소 40분을 충족)  
**샘플 개수**: 35개(60초 간격 시도, 34개는 43분 정기 수집, 1개는 40분대 확보 뒤 42분 이상 여유를 두기 위해 추가한 단일 샘플)  
**원시 데이터 경로**: `/var/tmp/cpj-agy-tui-idle-v2/samples.jsonl`

#### 주요 관측 결과

| 항목 | (a) 셸 직접 | (b) 명령 실행 | (c) 대조군 |
|-----|-----------|-----------|---------|
| agentIdentity | `antigravity` (35개 샘플 전부, 첫 샘플부터) | `antigravity` (35개 샘플 전부, 첫 샘플부터) | `null` (35개 샘플 전부) |
| tui-idle 판정 | `timeout` (35개 샘플 전부, `satisfied`·`error` 0건) | `timeout` (35개 샘플 전부) | `timeout` (35개 샘플 전부) |
| 화면 해시 | 동일(`eadd3cb8160be874`, 변화 없음) | 동일(`eadd3cb8160be874`, 변화 없음) | 동일(`2aeeec7f0fc74866`, 변화 없음) |
| `lastOutputAt` | 고정(터미널 생성 직후 값, 변화 없음) | 고정(변화 없음) | 고정(변화 없음) |
| list/wait/read 오류 | 0건 | 0건 | 0건 |

#### 전이 표

| 전이 대상 | 관측 결과 |
|---|---|
| `agentIdentity`가 처음 붙는 시점 | **포착하지 못함.** 터미널 생성 및 명령 전송 뒤 첫 샘플(약 8~11초 뒤)에 이미 `antigravity`로 붙어 있었습니다. 관측 간격(60초)이 부착 시점보다 길어 "붙는 순간"은 창 밖에 있었습니다. |
| tui-idle 판정이 바뀌는 시점 | **관측되지 않음.** 43분 51초 동안 (a)(b)(c) 모두 단 한 번도 `satisfied`로 바뀌지 않았습니다. |
| 화면 변화 | **관측되지 않음.** `screenHash`와 `lastOutputAt`이 35개 샘플 내내 완전히 고정이었습니다. |
| 대조군(c)이 (a)(b)와 같은 상태가 되는 시점(지난 관측: 29분 뒤) | **재현되지 않음.** (c)는 처음부터 끝까지 `agentIdentity: null`을 유지했고, (a)(b)와 구분되는 상태(둘 다 `agentIdentity: antigravity`, tui-idle은 셋 다 `timeout`으로 동일)를 유지했습니다. |

#### 지난 관측과 비교

지난 관측(`/Users/jinsungkim/orca/oh-my-teams/.omt/history/supervised-prompt-answers-w3/agy-tui-idle-observation.md`)은 화면 변화 없이 `agentIdentity`가 도중에 새로 붙고 tui-idle 판정이 뒤바뀌는 현상, 그리고 29분 뒤 대조군도 같은 상태가 되는 현상을 보고했습니다. 이번 관측은:

- **재현됨**: 대조군(순수 idle 셸)조차 tui-idle을 43분 51초 동안 한 번도 만족하지 못한다는, 문제 A의 핵심 증상 자체는 재현되었습니다.
- **재현되지 않음**: `agentIdentity`가 관측 도중 새로 붙는 현상, tui-idle 판정이 도중에 뒤바뀌는 현상, 대조군이 일정 시간 뒤 다른 상태로 바뀌는 현상은 이번 관측 창(43분 51초) 안에서 나타나지 않았습니다.
- 두 관측의 직접 비교는 표본 간격(지난 관측은 미상, 이번은 약 76초)과 관측 시작 시점(agy 실행 직후 vs 알 수 없음)이 달라 조건이 완전히 같지 않다는 한계가 있습니다.

#### 표본 간격 분석

35개 샘플 중 43분 정기 수집분(34개)의 평균 간격은 약 76초였습니다(목표 60초보다 약 16초 긺). 원인은 매 틱마다 터미널 3개 × (`terminal wait --timeout-ms 5000` 포함 2회 호출) + `terminal list` 1회, 총 7회의 `orca` 하위 프로세스 호출이 순차 실행되기 때문으로 추정되며, 결함 수정 전 v1 수집기에서 관측된 지연(약 73~76초)과 비슷한 폭입니다.

### 2.6 확인하지 못한 것

1. **`agentIdentity`가 붙는 정확한 시점**: 첫 샘플 이전(터미널 생성~약 8~11초)에 이미 붙어 있어, 그 사이 어느 시점에 붙었는지는 확인하지 못했습니다.
2. **tui-idle이 언젠가 `satisfied`로 바뀌는지**: 43분 51초 관측 창 안에서는 세 터미널 모두 한 번도 만족하지 않았으므로, 그보다 더 긴 시간 뒤에 바뀌는지는 확인하지 못했습니다.
3. **대조군이 지난 관측처럼 29분 뒤 상태를 바꾸는지**: 이번에는 재현되지 않았습니다(위 비교 참고). 환경·시점 차이 때문인지 원래 비결정적인 현상인지는 이 관측만으로 확인할 수 없습니다.
4. **단일 시점 스냅숏의 한계**: PM이 전달한 참고 자료(§2.7의 2번)는 이사가 화면 상태를 최소 30초 이상 지속 관찰한 뒤 판정하라고 지시했다고 전합니다. 이번 관측은 60초 간격의 순간 스냅숏이므로, 두 스냅숏 사이에 있었을 수 있는 짧은 화면 변화(예: 로그인 화면이 잠깐 떴다 사라지는 경우)는 포착하지 못했을 수 있습니다.
5. **`terminal send` 경고의 일반적 의미**: 위 2.3의 (a)에서 받은 경고 하나만 직접 확인했고, 그 외의 경우(예: 실제로 입력이 유실되는 경우가 있는지)는 이번 관측 범위 밖입니다.

### 2.7 참고: PM이 전달한 다른 관측 (이 워커가 직접 관측하지 않음, 미검증)

PM이 이사로부터 전달받아 넘겨준 자료입니다. 아래 항목은 본 관측과 시점·환경이 다르고, 이 워커가 원자료나 재현 절차를 확인하지 못했으므로 §2.5·§2.6의 결론에는 반영하지 않았습니다. 계약(브리프 기준 12·13) 범위를 넓히는 근거로도 쓰지 않습니다.

1. **`terminal send` 경고의 의미(이사 전달)**: 이사가 화면과 일곱 차례 대조한 바로는, "input was accepted, but this provider cannot report delivery" 류 경고가 나타나도 같은 시각 화면에 입력이 제출 대기열에 있었거나 이미 반영되어 있었고, 일곱 번 모두 결국 전달되었다고 합니다. `--retry-request <id> --wait-submit <초>`로 재확인하면 같은 요청 ID는 프롬프트를 다시 보내지 않고 receipt만 재생한다고 합니다. tui-idle timeout과는 다른 현상이라는 점도 함께 전달되었습니다.
2. **다른 kickoff의 Agy 로그인 화면 오판(darwin, 미검증)**: 폴더 신뢰 처리 전 Agy 역할 터미널이 "Select login method" 화면을 보였는데 실제 인증은 유효했다고 합니다(같은 계정의 다른 역할이 같은 시각 정상 기동). 이사 스스로도 "신뢰 미처리가 원인"이라는 판단은 소스로 확인하지 않은 추론이라고 밝혔다고 합니다. 단일 화면 스냅숏만으로 상태를 판정하는 방식의 신뢰도 한계를 보여주는 사례로만 인용합니다.
3. **다른 kickoff의 darwin Agy 역할 두 개(Gemini 3.1 Pro (High), Gemini 3.8 Flash (High)) 사례(미검증)**: 정상 경로의 terminal-idle-check가 timeout 계열 신호로 거부되었다고 합니다. 문제 A가 Windows에 국한되지 않을 수 있다는 정황이지만, 이 문서의 관측 대상(darwin, Antigravity CLI, gpt-oss-120b-medium)과 모델·역할이 달라 직접 비교하지 않았습니다.

### 2.8 터미널 종료

**표본 수집 완료 후 실행 (2026-09-26T03:17:30Z UTC = 12:17:30 KST)**

- 터미널 (a) 종료: `orca terminal close --terminal term_a487ba70-56aa-466f-8b7a-92185f180f41` ✓ (`ptyKilled: true`)
- 터미널 (b) 종료: `orca terminal close --terminal term_03695168-7e24-4f5b-ad49-ab109ef232a5` ✓ (`ptyKilled: true`)
- 터미널 (c) 종료: `orca terminal close --terminal term_6e5d47d8-6cc4-4f75-9507-d14cbd3f408c` ✓ (`ptyKilled: true`)

모든 터미널이 정상 종료되었습니다.

---

## 참고

- 지난 관측 기록: `/Users/jinsungkim/orca/oh-my-teams/.omt/history/supervised-prompt-answers-w3/agy-tui-idle-observation.md`
- 선행 조사: `docs/plan/agy-terminal-path.md`, `docs/plan/agy-terminal-probes.md`
- 무효 처리된 첫 관측의 수집기·원시 데이터(보존, 결과로 쓰지 않음): `/var/tmp/collect-agy-samples.mjs`, `/var/tmp/agy-tui-idle-samples.jsonl`
- 이슈 #46 기본 정보: 관측 기록과 함께 생성된 댓글 참조
