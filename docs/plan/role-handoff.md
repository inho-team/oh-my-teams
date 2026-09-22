# 사용 한도에 걸린 역할의 handoff 설계

## 목적

역할 worker가 사용 한도에 걸려 멈추면, 같은 workflow task를 **다른 provider의 fallback 프로필**이 handoff 문서를 읽고 이어받게 한다. 지금은 한도에 걸린 worker가 멈춘 채로 남고, PM이 화면을 읽어 원인을 알아낸 뒤 사용자에게 보고하는 것이 전부다. 이 문서는 그 공백을 메우는 설계와 단계별 계획을 정리한다.

한 provider의 여러 계정을 번갈아 써서 한도를 피하는 방식은 이 설계에 포함하지 않는다. provider의 약관과 충돌할 수 있고 계정 정지 위험이 있기 때문이다. 이어받는 쪽은 항상 할당량을 공유하지 않는 다른 provider이거나 다른 구독이다.

## 1. 현재 상태

아래 사실은 코드에서 확인했다. 줄 번호는 `plugins/oh-my-teams/` 기준이다.

### 1.1 한도를 감지하지 못한다

- Orca 터미널 경로(`role-terminal` → `terminal-idle-check` → `worker-start --terminal`)에는 한도를 인식하는 코드가 없다. `scripts/orca-adapter.mjs`의 `ORCA_FAILURE_HINTS`(24-40)에 한도 관련 코드가 없고, `assertTerminalIdle`(430-527)은 작업을 넘기기 전의 대기 여부만 본다.
- 감독 판정(`scripts/status.mjs:80-152`의 `nextSupervisionAction`)은 무응답을 기준으로 `ask-progress`, `inspect`, `escalate`를 고른다. 한도 원인은 PM이 `worker-read`로 화면을 직접 읽어야만 알 수 있다.
- headless 경로는 `scripts/headless.mjs`가 provider별로 `rateLimited`를 판정한다(65-70, 118-120, 175-178). 하지만 이 값은 `dashboard.html:273`의 표시에만 쓰이고, outcome 판정(825-834)이나 라우팅에는 쓰이지 않는다.

### 1.2 감지하더라도 이어받을 경로가 없다

- 한도 실패는 `quota-exhausted`로 분류되고 다음 담당은 PM, 조치는 `apply-saved-quota-policy`이다(`scripts/failures.mjs:24-34`). `rate-limit` 코드는 `quota-unknown`으로 번역되므로(`scripts/local-adapter.mjs:73-78`) 재시도 가능 여부가 `false`가 된다.
- 역할의 `fallbacks`는 조직 파일 검증(`scripts/core.mjs:765-773`)을 거치지만, 실제로 쓰는 곳은 JSON 편집 하네스(`scripts/worker.mjs:380-383`, 484-501)뿐이다. 그마저도 `pool-exhausted`일 때만 다음 프로필로 넘어간다.
- 터미널 경로와 headless 경로는 역할의 기본 프로필 하나만 읽는다(`scripts/role-launch.mjs:228-283`, 345-406). `retryTask`는 역할을 원래 요청한 역할로 되돌릴 뿐이며(`scripts/workflow.mjs:1398`), 프로필을 바꾸는 입력이 없다.
- 절차 문서도 이 상태를 그대로 따른다. PM은 모델·계정·구독을 바꾸지 않고(`skills/pm/SKILL.md:38`), 소진되면 저장된 정책으로 처리한다(54). 실행 중에 프로필을 다시 묶는 절차는 없다(`references/orca-runtime.md:157`).
- 현재 조직 파일(`.omt/organization.json`)의 네 역할은 모두 Claude 프로필이고 `fallbacks`는 모두 비어 있다. preset과 조직 초안도 fallback을 비운다(`scripts/presets.mjs:176`, `scripts/org-draft.mjs:115`).

### 1.3 이어받을 사람이 읽을 기록이 없다

- `worker-start --spec`으로 넘긴 브리프는 Orca Task spec에만 들어가고 파일로 남지 않는다(`scripts/role-launch.mjs:454-509`).
- 터미널 대화는 provider CLI의 자체 기록에만 남으며, 다른 provider는 그 기록을 이어받을 수 없다. headless의 session resume도 같은 provider에서만 동작한다.
- 코드와 커밋은 child worktree에 남는다. 하지만 "무엇을 끝냈고 무엇이 남았는지"를 구조화해 남기는 곳은 없다.

## 2. 설계 원칙

1. **fallback은 사용자가 미리 정한다.** 이어받을 프로필은 조직 파일의 역할 `fallbacks`에 사용자가 선언한 것만 쓴다. 조직 정책이 `onExhaustion: "fallback"`일 때에만 PM이 저장된 정책으로서 handoff를 실행한다. `stop`이면 지금처럼 멈추고 보고한다. 따라서 "PM은 스스로 모델을 바꾸지 않는다"는 규칙과 충돌하지 않는다.
2. **할당량을 공유하는 fallback은 받지 않는다.** 같은 계정이나 같은 `pool`을 쓰는 프로필은 handoff 대상이 될 수 없다. 다른 경로로 같은 계정에 닿는 경우도 포함한다. 예를 들어 Codex를 OpenCodex로 감싸서 같은 Claude 구독으로 보내는 프로필은 Claude 프로필의 fallback이 아니다.
3. **한도에 걸린 에이전트는 문서를 쓸 수 없다.** 모델 호출이 막혔기 때문이다. 그래서 handoff 문서는 평소에 에이전트가 갱신하는 체크포인트와, 한도를 감지했을 때 런타임이 모델 없이 모으는 사실 두 부분으로 구성한다.
4. **문서보다 worktree가 우선한다.** 이어받는 에이전트는 문서를 믿고 바로 진행하지 않는다. 먼저 `git status`와 커밋 기록으로 문서 내용을 대조하고, 어긋나면 worktree를 기준으로 삼아 그 차이를 문서에 적는다.
5. **추측으로 채우지 않는다.** 런타임이 모으는 부분에는 확인한 사실만 넣는다. 체크포인트가 한 번도 없으면 "체크포인트 없음"이라고 적고, 진행 상황을 지어내지 않는다.

## 3. 구성 요소

### 3.1 handoff 문서

위치는 workflow 기록 안의 task 디렉터리로 한다.

```text
<stateDir>/workflows/<workflowId>/tasks/<taskId>/handoff/
  checkpoint.md        # 에이전트가 갱신한다
  checkpoint.json      # 갱신 시각, 커밋, 프로필 같은 메타데이터
  snapshot-<n>.json    # handoff마다 런타임이 만든다
```

`checkpoint.md`는 다음 절을 정해진 제목으로 가진다. 절이 빠지면 체크포인트 명령이 거부한다.

| 절          | 내용                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------ |
| 목표        | task 계약의 목표와 수용 기준을 옮긴다.                                                           |
| 끝낸 일     | 완료한 단계와 그 근거(커밋 SHA, 통과한 검사)를 적는다.                                           |
| 남은 일     | 남은 단계를 순서대로 적는다.                                                                     |
| 결정과 이유 | 구현 중에 내린 선택과 그 이유를 적는다. 이어받는 쪽이 같은 고민을 반복하지 않게 하기 위해서이다. |
| 검증 상태   | 마지막으로 실행한 검사와 결과를 적는다.                                                          |
| 다음 단계   | 바로 다음에 할 한 가지 행동을 적는다.                                                            |
| 주의 사항   | 실패한 시도, 건드리면 안 되는 곳, 열린 질문을 적는다.                                            |

`snapshot-<n>.json`은 런타임이 한도를 감지했을 때 만든다. 모델을 호출하지 않고 다음 사실만 담는다.

- task 계약의 해시와 `baseRef`
- `baseRef` 이후의 커밋 목록, 커밋하지 않은 변경 파일 목록과 diff 통계
- 마지막 체크포인트의 시각과 그 뒤에 생긴 커밋 수
- 한도 신호의 원문, provider가 알려 준 갱신 시각(`scripts/providers/shared.mjs:191`의 "resets in" 추출을 재사용)
- 멈춘 프로필과 이어받을 프로필

### 3.2 체크포인트 명령

`teams-org.mjs handoff-checkpoint --state <pm-state> --workflow-id <id> --workflow-task <taskId> --file <checkpoint.md>`를 추가한다. 이 명령은 절 구성을 검증하고, 현재 HEAD와 프로필을 `checkpoint.json`에 기록한 뒤 파일을 원자적으로 교체한다.

worker 브리프 머리글(`scripts/role-launch.mjs:488`)에 체크포인트 규칙을 넣는다. 에이전트는 커밋할 때마다, 그리고 검사를 실행해 결과를 얻을 때마다 체크포인트를 갱신한다. 시간 간격 대신 커밋과 검사를 기준으로 삼는 이유는 에이전트가 경과 시간을 안정적으로 알지 못하기 때문이다.

### 3.3 한도 감지

0단계 실측(8절) 결과에 따라, 화면 문구보다 provider CLI가 남기는 **세션 기록의 구조화된 오류 필드**를 우선 근거로 삼는다.

- **터미널 경로:** `worker-limit-check --worktree <path> --provider <provider>`를 추가한다. 이 명령은 그 worktree에서 가장 최근에 시작된 provider 세션 기록을 찾아, 마지막 turn이 한도 오류로 끝났는지 오류 필드만 읽고 판정한다. 역할 worker는 worktree를 공유하지 않으므로(`scripts/teams-org.mjs:669-674`) worktree 경로로 세션을 특정할 수 있다. 세션 기록을 찾지 못하면 화면(`worker-read`)을 보조 근거로 읽는다. 감독 판정이 `inspect`나 `escalate`를 고를 때 PM이 이 명령을 먼저 실행하도록 `references/orca-runtime.md`의 감독 절차를 고친다.
- **headless 경로:** 이미 판정한 `rateLimited`를 outcome에 반영해, 한도로 끝난 turn을 일반 실패와 구분한다. 다만 판정 범위를 오류 필드와 실패 상태로 좁힌다. 응답 본문 전체에 정규식을 적용하면, worker가 본문에서 "rate limit"이라는 낱말을 쓰기만 해도 한도로 판정되는 오탐이 이미 기록되어 있다(`.omt/history/audit-wave1-close/state/lessons_in/rate-limited-false-positive.json`).
- **사용 한도와 용량 부족을 구분한다.** 사용 한도(`usage-limit`)는 갱신 시각까지 그 구독을 쓸 수 없으므로 handoff 대상이다. 용량 부족(`capacity`, 예: Codex `server_overloaded`, Agy `UNAVAILABLE (code 503)`)은 잠시 뒤 같은 프로필로 다시 시도하면 풀릴 수 있으므로, 같은 turn에서 곧바로 handoff하지 않고 재시도 대상으로 먼저 분류한다.

### 3.4 실패 분류

- `scripts/execution.mjs`의 중립 신호에 `rate-limited`를 추가한다.
- `scripts/failures.mjs`에 `capacity-handoff` 경로를 추가한다. 조건은 한도 신호이면서, 조직 정책이 `fallback`이고, 그 역할에 아직 쓰지 않은 fallback 프로필이 있는 경우이다. 다음 담당은 PM, 조치는 `handoff-to-fallback`, 재시도 가능 여부는 `true`이다.
- 조건을 채우지 못하면 지금처럼 `quota-exhausted`로 분류한다.

### 3.5 workflow 전이

`workflow-handoff --state <pm-state> --id <workflowId> --task <taskId> --profile <fallback id> --reason <signal.json>`을 추가한다.

- 현재 attempt를 한도로 끝난 것으로 기록하고, task를 새 프로필로 다시 대기 상태에 둔다.
- 요청한 프로필이 조직 스냅샷에서 그 역할의 `fallbacks`에 있고, 이번 task에서 아직 쓰지 않았고, 멈춘 프로필과 계정·`pool`을 공유하지 않을 때에만 받아들인다.
- worktree는 그대로 둔다. 재시도와 달리 작업 결과를 버리지 않는다.
- 런타임이 `snapshot-<n>.json`을 만들고 이벤트에 그 경로를 남긴다.

### 3.6 fallback 프로필로 실행

- `role-terminal`과 `worker-start`에 `--profile`을 추가한다. 이 값은 workflow에 기록된 handoff 프로필과 같을 때에만 받는다. 그 밖에는 지금처럼 역할의 기본 프로필을 쓴다.
- 같은 worktree를 다른 터미널이 쓰지 못하게 하는 검사(`scripts/teams-org.mjs:669-674`)는 유지한다. 따라서 이어받기 전에 한도에 걸린 터미널을 `worker-stop`으로 멈추거나, 멈춘 것을 확인하지 못하면 `worker-abandon`으로 봉인한다. 새 터미널은 그 뒤에 연다.
- `worker-start`는 handoff일 때 브리프 앞에 handoff 문서의 경로와 "먼저 worktree와 대조하라"는 지시를 붙인다.
- 실행 기록(`scripts/usage-ledger.mjs`)에 `handoffFrom`과 `handoffIndex`를 남긴다.

### 3.7 검토

검토자에게 넘기는 브리프에 handoff 이력(어느 프로필이 어디까지 했는지)을 포함한다. 두 모델이 나누어 만든 변경이라는 사실을 검토자가 알고 있어야, 경계에서 생긴 불일치를 놓치지 않기 때문이다.

## 4. 단계별 계획

| 단계                                               | 내용                                                                                                                                                                                      | 완료 기준                                                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 0. 실측 (완료)                                     | Claude, Codex, Agy의 한도 화면 문구와 headless 출력을 수집한다.                                                                                                                           | provider별 원문 고정 자료가 저장되고, 수집하지 못한 provider가 목록으로 남는다. 결과는 8절에 있다.                             |
| 1. 문서와 체크포인트 (구현 완료, 터미널 확인 남음) | `handoff-checkpoint`, 문서 형식 검증, 브리프 머리글의 체크포인트 규칙을 만든다. 브리프 규칙은 `worker-start`와 `role-spec`에 `--workflow-id`와 `--workflow-task`가 함께 주어질 때 붙는다. | worker가 커밋할 때 체크포인트를 갱신하는 것을 실제 Orca 터미널에서 확인한다. 이 단계만으로도 사람이 수동으로 이어받을 수 있다. |
| 2. 감지와 분류 (완료)                              | `worker-limit-check`, headless outcome 반영, `rate-limited` 신호, `capacity-handoff` 경로를 만든다.                                                                                       | 고정 자료로 감지와 분류를 검사하는 테스트가 통과한다.                                                                          |
| 3. 전이와 실행 (구현 완료, 터미널 확인 남음)       | `workflow-handoff`, `--profile`, snapshot 생성, 실행 기록 필드를 만든다.                                                                                                                  | 한도 상황을 흉내 낸 workflow에서 fallback 프로필이 같은 worktree에서 task를 끝내고 검토를 통과한다.                            |
| 4. 절차와 평가                                     | PM 스킬, 감독 절차, 조직 구성 스킬(`skills/form`)의 fallback 안내를 고치고 eval 시나리오를 추가한다.                                                                                      | `npm run sync`, `npm run lint`, `npm test`가 통과한다.                                                                         |

## 5. 비목표

- 한 provider의 여러 계정을 번갈아 쓰는 계정 풀
- 한도가 풀린 뒤 진행 중인 task를 원래 프로필로 되돌리는 동작. 원래 프로필은 다음 task부터 다시 쓴다.
- PM 자신이 한도에 걸린 경우의 인계. PM의 인계는 이사가 담당해야 하므로 별도 설계로 다룬다.
- 대화 기록 자체를 다른 provider로 옮기는 기능

## 6. 결정 사항

2026-09-22에 사용자가 다음과 같이 정했다.

1. **시도 예산:** handoff는 task의 `maxAttempts`를 소모하지 않는다. 대신 한 task의 handoff 횟수는 그 역할에 선언된 fallback 개수를 넘지 못한다. 한도는 작업의 결함이 아니라 용량의 문제이기 때문이다.
2. **실행 방식:** 조직 정책이 `fallback`이면 PM이 저장된 정책으로서 곧바로 handoff를 실행하고, 실행한 사실을 이사에게 `progress` 신호로 알린다. 정책이 `stop`이면 지금처럼 멈추고 보고한다. 이 방식은 2절의 원칙 1과 같다.

## 7. 남은 결정

- **역할별 fallback:** 현재 조직 파일의 각 역할(`pm`, `pl`, `senior`, `junior`)에 어떤 Codex 또는 Agy 프로필을 fallback으로 둘지는 아직 정하지 않았다. 3단계에서 실제 handoff를 확인하기 전까지 사용자가 정한다.

## 8. 0단계 실측 결과

2026-09-22에 이 머신의 provider CLI 기록과 Orca 터미널에서 실제 한도 오류를 수집했다. 식별자와 시각만 지우고 문구는 그대로 `tests/fixtures/provider-limit-events.json`에 저장했다.

### 8.1 provider별로 확인한 기록

| provider    | 기록 위치                                                                           | 한도 오류의 형태                                                                                                                                                                                                               | 작업 디렉터리 기록                                               |
| ----------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Codex       | `~/.codex/sessions/**/rollout-*.jsonl`                                              | `event_msg`의 `task_complete` 이벤트에 `error.codex_error_info`가 붙는다. 사용 한도는 `usage_limit_exceeded`, 용량 부족은 `server_overloaded`이다.                                                                             | 첫 줄 `session_meta`의 `cwd`                                     |
| Claude Code | `~/.claude/projects/<cwd 변환>/*.jsonl`                                             | `isApiErrorMessage: true`, `error: "rate_limit"`인 assistant 메시지가 남는다. 모델 값은 `<synthetic>`이다.                                                                                                                     | 디렉터리 이름과 각 줄의 `cwd`                                    |
| Agy         | `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl` | `source: "SYSTEM"`, `type: "ERROR_MESSAGE"`인 항목의 `error`에 `RESOURCE_EXHAUSTED (code 429): Individual quota reached ... Resets in <시간>`이 들어간다. 용량 부족은 `UNAVAILABLE (code 503): No capacity available ...`이다. | 구조화된 필드는 없다. 첫 입력에 Orca가 넣은 task ID가 들어 있다. |

Codex는 한도에 걸린 상태의 계정으로 Orca 터미널에서 직접 요청을 보내 확인했다. 화면에 오류가 표시되는 것과 동시에 같은 문구가 세션 기록에 `usage_limit_exceeded`로 남았고, 그 기록의 `cwd`는 터미널의 worktree와 같았다. Claude와 Agy는 과거 기록에서만 수집했다.

### 8.2 설계에 반영한 사실

- **화면 문구는 근거로 약하다.** Codex 화면에서는 오류 문장이 터미널 폭에 맞춰 문장 중간에서 줄바꿈되었고, 진행 표시 문자가 같은 줄에 섞였다. 게다가 문구에는 곧은 따옴표(`You've`)와 굽은 따옴표(`You’ve`)가 모두 나타났고, 모델별 한도 문구(`You've hit your usage limit for GPT-5.3-Codex-Spark`)처럼 형태도 여러 가지였다. 반면 세션 기록의 오류 필드는 값이 고정되어 있다.
- **갱신 시각의 형식이 provider마다 다르다.** Codex는 `try again at 4:54 AM`이나 `try again at Sep 26th, 2026 6:11 AM`처럼 절대 시각을, Agy는 `Resets in 1h11m42s`처럼 남은 시간을 준다. Claude 기록에는 갱신 시각이 없었다.
- **Agy는 내부에서 재시도한다.** 같은 turn 안에서 `API error (attempt 1)`부터 `(attempt 8)`까지 이어진 기록이 있다. 따라서 첫 오류를 보자마자 handoff하지 않고 turn이 끝났는지 확인해야 한다.

### 8.3 수집하지 못한 것

- **Claude의 5시간·주간 사용 한도 문구:** 이 머신의 기록에는 Fable 사용 크레딧 소진(`You're out of usage credits`) 한 가지만 있었다. 구독의 5시간·주간 한도에 걸렸을 때도 같은 `error: "rate_limit"` 필드가 남는지는 확인하지 못했다. 2단계에서 필드 값만으로 판정하되, 실제 한도에 처음 걸렸을 때 이 가정을 검증하고 고정 자료에 추가한다.
- **Claude와 Agy의 터미널 화면 문구:** 두 provider는 지금 한도에 걸려 있지 않아 화면을 재현하지 못했다. 한도에 걸리지 않은 계정으로 한도를 일부러 소진하는 실측은 하지 않았다.
- **Agy 세션과 worktree의 연결:** Agy 기록에는 `cwd` 필드가 없다. 2단계에서는 Orca task ID 대신, 1단계 브리프 규칙이 첫 입력에 넣는 `--workflow-id <id> --workflow-task <task>` 문자열로 세션을 찾도록 구현했다. 이 방법은 고정 자료로만 검사했고, 실제 Agy worker로는 아직 확인하지 않았다. 세션을 찾지 못하면 `worker-limit-check`는 `--terminal`의 화면을 읽는다.

## 9. 2단계 구현에서 정한 세부 사항

설계에 적혀 있지 않아 구현하면서 정한 내용이다. 3단계에서 바꿀 수 있다.

- **판정 값:** `worker-limit-check`는 `verdict`로 `handoff`(사용 한도로 turn이 끝남), `retry`(용량 부족으로 turn이 끝남), `wait`(provider가 아직 재시도 중), `none`(한도로 끝나지 않음), `unknown`(세션 기록도 화면도 없음) 가운데 하나를 돌려준다. `source`는 근거가 세션 기록인지(`session`) 화면인지(`screen`)를 나타낸다.
- **마지막 turn의 기준:** Codex는 마지막 `task_started`, `task_complete`, `turn_aborted` 이벤트를, Claude는 마지막 `user` 또는 `assistant` 기록을, Agy는 마지막 기록을 본다. 한도 오류 뒤에 새 입력이나 새 turn이 있으면 한도는 이미 지나간 것으로 본다.
- **Agy 재시도:** 이 머신의 Agy 기록에서 `RESOURCE_EXHAUSTED (code 429)`는 7번 모두 `attempt 8`까지 이어진 뒤 turn이 끝났고, `UNAVAILABLE (code 503)`은 6번 모두 1~2번째 시도 뒤 회복되었다. 그래서 429는 `attempt 8`에 이르렀을 때에만 `handoff`로, 그 전과 503은 `wait`로 판정한다.
- **화면 판정:** 화면의 마지막 40줄만 이어 붙여 읽는다. worker가 자기 출력에서 한도 문구를 인용한 것을 provider 오류로 오인하지 않기 위해서이다. Claude 화면 문구는 확인된 `You're out of usage credits` 하나만 인식한다.
- **용량 부족의 경로:** `rate-limited` 신호에 `limitKind: "capacity"`가 붙으면 `provider-capacity` 경로(다음 담당 PM, 조치 `retry-after-capacity`, 재시도 가능)로 분류한다.
- **남은 fallback 계산:** workflow가 실패를 분류할 때 조직 스냅샷의 `policy.onExhaustion`과, 그 역할의 `fallbacks` 수가 task의 `handoffs` 기록 수보다 많은지를 함께 넘긴다. `handoffs` 기록은 3단계의 `workflow-handoff`가 만든다.
- **headless outcome:** 실패한 turn이 한도로 끝났으면 `exit-error` 대신 `rate-limited`를 쓰고 `limitKind`를 함께 보고한다. Agy는 실패한 결과의 `error` 필드만 읽고, 성공한 응답 본문은 읽지 않는다.

## 10. 3단계 구현에서 정한 세부 사항

- **명령 형식:** 3.5절의 플래그 대신 다른 workflow 명령과 같은 형식인 `workflow-handoff --id <workflowId> --state <pm-state> --revision <N> --handoff <handoff.json>`을 쓴다. 입력 파일에는 `schemaVersion: 1`, `eventId`, `taskId`, `profile`, `worktree`, `reason`(`worker-limit-check` 출력), `evidence`를 적는다. `reason`에 `verdict`가 있으면 `handoff`여야 한다.
- **받아들이는 조건:** task가 `capacity-handoff` 경로로 실패했고, 조직 스냅샷의 `policy.onExhaustion`이 `fallback`이며, 요청한 프로필이 그 역할의 `fallbacks`에 있고, 이 task에서 아직 실행되지 않았을 때에만 받아들인다. 멈춘 프로필은 마지막 handoff의 대상이고, handoff가 없으면 역할의 기본 프로필이다. 두 프로필이 같은 `pool`을 선언했거나, provider와 `account`가 같으면 같은 한도를 쓰는 것으로 보고 거부한다. 멈춘 attempt의 receipt가 `<repo-id>::<path>` 형식의 worktree를 기록했다면, 입력한 `worktree`가 그 경로와 같아야 한다.
- **snapshot:** `snapshot-<n>.json`에는 멈춘 시점의 HEAD, 기준 commit 이후의 커밋 목록, 커밋하지 않은 파일(`git status --porcelain -uall`), 기준 commit과의 diff 요약, 마지막 checkpoint의 시각과 그 뒤에 쌓인 커밋 수, 한도 근거, 두 프로필을 기록한다.
- **시도 예산:** handoff 뒤의 첫 실행(`handoffPending`)은 `attemptsUsed`를 늘리지 않으며, 시도 예산이 다 쓰인 뒤에도 `dispatch-ready`로 나온다. 그 실행을 `workflow-release`로 되돌리면 같은 fallback을 다시 기다린다. 호출 예산(`maxCalls`)은 handoff에도 그대로 적용된다.
- **프로필 유지:** handoff한 task는 이후 재시도도 fallback 프로필로 실행한다. `dispatch-ready`에는 `profile`과 `worktree`가 붙고, handoff 뒤 첫 실행에는 `handoffIndex`도 붙는다. 5절의 비목표와 같이, 진행 중인 task를 원래 프로필로 되돌리지 않는다.
- **실행:** `role-terminal`과 `worker-start`의 `--profile`은 `--workflow-id`, `--state`, `--workflow-task`와 함께 주어져야 하고, 그 task의 마지막 handoff 대상과 같아야 하며, task가 `pending`, `reserved`, `running` 가운데 하나여야 한다. `headless-start`에는 아직 `--profile`을 추가하지 않았다.
- **브리프:** `--workflow-task`가 주어진 브리프에는 그 task의 handoff 이력이 붙는다. handoff 뒤 첫 실행을 기다리거나 그 실행이 예약·진행 중인 동안에는 checkpoint.md와 snapshot 경로, 그리고 "먼저 worktree와 대조하라"는 지시도 붙는다. 검토 브리프도 같은 task를 가리키므로 이력을 함께 받는다.
- **실행 기록:** handoff 실행은 `handoffFrom`(멈춘 프로필)과 `handoffIndex`를 남긴다. handoff가 아닌 실행에는 두 필드가 없다.
