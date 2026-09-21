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

- **터미널 경로:** `worker-limit-check --terminal <handle> --provider <provider>`를 추가한다. 이 명령은 `worker-read`로 화면을 읽고 provider별 한도 문구와 대조한다. 감독 판정이 `inspect`나 `escalate`를 고를 때 PM이 이 명령을 먼저 실행하도록 `references/orca-runtime.md`의 감독 절차를 고친다.
- **headless 경로:** 이미 판정한 `rateLimited`를 outcome에 반영해, 한도로 끝난 turn을 일반 실패와 구분한다.
- **provider별 문구는 실측으로 정한다.** Claude, Codex, Agy가 한도에 걸렸을 때 화면에 실제로 출력하는 문구를 먼저 수집하고, 그 원문을 테스트 고정 자료로 저장한다. 수집하지 못한 provider는 감지 대상에서 빼고 문서에 그 사실을 적는다.

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

| 단계                 | 내용                                                                                                 | 완료 기준                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 0. 실측              | Claude, Codex, Agy의 한도 화면 문구와 headless 출력을 수집한다.                                      | provider별 원문 고정 자료가 저장되고, 수집하지 못한 provider가 목록으로 남는다.                                                |
| 1. 문서와 체크포인트 | `handoff-checkpoint`, 문서 형식 검증, 브리프 머리글의 체크포인트 규칙을 만든다.                      | worker가 커밋할 때 체크포인트를 갱신하는 것을 실제 Orca 터미널에서 확인한다. 이 단계만으로도 사람이 수동으로 이어받을 수 있다. |
| 2. 감지와 분류       | `worker-limit-check`, headless outcome 반영, `rate-limited` 신호, `capacity-handoff` 경로를 만든다.  | 고정 자료로 감지와 분류를 검사하는 테스트가 통과한다.                                                                          |
| 3. 전이와 실행       | `workflow-handoff`, `--profile`, snapshot 생성, 실행 기록 필드를 만든다.                             | 한도 상황을 흉내 낸 workflow에서 fallback 프로필이 같은 worktree에서 task를 끝내고 검토를 통과한다.                            |
| 4. 절차와 평가       | PM 스킬, 감독 절차, 조직 구성 스킬(`skills/form`)의 fallback 안내를 고치고 eval 시나리오를 추가한다. | `npm run sync`, `npm run lint`, `npm test`가 통과한다.                                                                         |

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
