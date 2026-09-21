# supervised-prompt-answers 통합 기록

## 통합 HEAD 구성

HEAD 345def2e021d93f80dab2b4a431e170803d9cf47는 다음 변경사항을 포함하고 있습니다.

**병합 이력 (git log --first-parent)**
- 345def2: merge: origin/main(b625b25) 반영
- a59022b: merge: supervised-prompt-answers task 결과 통합 (capture·submission·classifier·supervisor-path)

**수용된 task 결과 (네 개)**

| task | 수용 커밋 | 기준 | 검사 |
|---|---|---|---|
| capture | e645778 | 형식·동기화·검사 통과, 독립 재검토 approved | format·sync·lint·test ✓ |
| submission | 7ae0f0f | 형식·동기화·검사 통과, 독립 재검토 approved | format·sync·lint·test ✓ |
| classifier | 991bc6e | 형식·동기화·검사 통과, 독립 재검토 approved | format·sync·lint·test ✓ |
| supervisor-path | 3cf39ee | 형식·동기화·검사 통과, 독립 재검토 approved | format·sync·lint·test(617개) ✓ |

**병합 후 처리**

origin/main을 --no-ff로 병합한 뒤, 수치 문서 충돌에서 통합 브랜치 쪽 내용을 받았습니다. 이 상태에서 npm run sync를 실행하여 다중 파일에 기재된 버전과 감사 수치를 다시 계산했습니다.

## 통합 HEAD의 검사 결과

| 검사 | 결과 |
|---|---|
| npm run format | ✓ 통과 |
| npm run sync | ✓ 통과 |
| npm run lint | ✓ 통과 |
| npm test | ✓ 618개 테스트 통과 |

## 실제 경로 검증 (Claude)

새 Orca 워크트리에서 역할 터미널 생성부터 worker-start까지의 경로를 Claude(Haiku 4.5)로 검증했습니다.

### 워크트리 생성

**결과 필드 (w1/wt-verify-claude.json)**
- worktree.id: 955a83a3-27ee-457a-8ff5-3dff4694e8aa::/Users/jinsungkim/orca/workspaces/oh-my-teams/spa-verify-claude
- head: 345def2e021d93f80dab2b4a431e170803d9cf47
- branch: refs/heads/dev-inho/spa-verify-claude
- baseRef: feat/supervised-prompt-answers
- parentWorktreeId: 955a83a3-27ee-457a-8ff5-3dff4694e8aa::/Users/jinsungkim/orca/workspaces/oh-my-teams/feat-supervised-prompt-answers
- lineage.origin: cli

### role-terminal 실행

**결과 필드 (w1/rt-verify-claude.json)**
- trust: not-asked (신뢰 질문이 나오지 않음)
- submission: enter-sent (초기 진입 명령 Enter가 필요함)
- ready: true (터미널 준비 완료)
- screen: "Haiku 4.5 · Claude Max" 모델 확인

**의미**: trust가 not-asked인 상태는 역할 터미널 시작 시 폴더 신뢰 질문이 트리거되지 않았음을 나타냅니다.

### prompt-answer (신뢰 질문 대리 응답)

**결과 필드 (w1/pa-verify-claude-1.json)**
- status: no-question
- reason: "캡처로 확인한 폴더 신뢰 질문이나 사용자 질문 화면과 일치하지 않아 답하지 않습니다."
- action: none (아무 답도 보내지 않음)
- sent: false

**의미**: 신뢰 질문이 화면에 나타나지 않았으므로 prompt-answer 명령이 답을 보내지 않았습니다(no-question). 이 상황에서도 감독 경로의 워크트리 대조와 호출자 확인은 통과했습니다.

**trust not-asked와 no-question의 구분**:
- trust not-asked: role-terminal 단계에서 신뢰 질문 화면이 나타나지 않은 상태
- no-question: prompt-answer 단계에서 신뢰 질문 화면을 확인하지 못해 답하지 않은 상태

### terminal-idle-check

**결과 필드 (w1/idle-verify-claude.json)**
- idle: true (터미널이 지연된 작업 없이 대기 중)

### worker-start

**결과 필드 (w1/start-verify-claude-1.json)**
- receipt.state: ready
- receipt.stage: input_accepted (dispatch 입력이 수용됨)
- turnStart: observed (명령이 입력줄에 남아 있어 Enter를 한 번 보냄)
- dispatchId: ctx_1d04553e945f
- freshContext.cleared: false
- freshContext.reason: first-task (첫 작업이므로 대화 초기화 없음)
- binding.role: junior
- binding.modelProof: unproven (role-terminal 결과의 화면 모델로 모델 확인)

## Agy와 Codex

이번 통합 시점에는 두 클라이언트의 검증이 미완료입니다.

**Agy**
현재 /Users/jinsungkim/orca/oh-my-teams/.omt/organization.json의 역할 구성에 Agy 프로필을 사용하는 역할이 없어 검증을 시작할 수 없습니다. Agy 프로필의 역할 매핑 결정을 기다리는 중입니다.

**Codex**
Codex의 주간 사용량 한도가 2026-09-26 06:11 KST에 리셋될 예정이므로, 그 이후에 같은 경로(새 워크트리 생성 → role-terminal → prompt-answer → worker-start)를 검증합니다. 현재 결과 표에는 Codex를 완료로 나타내지 않습니다.

| 클라이언트 | 확인한 경로 | 미확인 단계 | 상태 |
|---|---|---|---|
| Claude (Haiku 4.5) | wt, rt(신뢰 질문 제외), pa, idle, ws | 신뢰 질문 경로(prompt-answer 키 전달) | ✓ 부분 확인 |
| Agy | — | 모든 경로 | ⏳ 역할 매핑 결정 기다리는 중 |
| Codex | — | 모든 경로 | ⏳ 한도 리셋(2026-09-26 06:11 KST) 뒤 예정 |

## 2.8.0 기능 관측 요약

### supervision-wait --ack

점진적 전달 확인 플래그 --ack를 사용하여 PM이 대기 중에 heartbeat 메시지를 자동으로 필터링하고, 실제 업무 메시지만 모델을 깨우는 동작을 검증했습니다.

**관찰 내용**
- --ack 플래그가 있는 대기에서 heartbeat가 여러 건 전달되었으나 래퍼가 흡수했고 모델을 깨우지 않았습니다(대기 1~6, 8~11, 13, 14, 17, 18 등).
- --ack로 넘긴 delivery ID의 확인 처리는 replayed 플래그(false)로 확인되어 이전 메시지가 재전달되지 않습니다(대기 2, 3 등).
- 같은 --ack를 여러 번 넘겨도 오류 없이 처리됩니다(대기 7, 8에서 delivery_69cfec6bc8d7를 두 번 넘김).
- 일반적인 timeout 시간(progressCheckMs 900초)을 관찰했으나(대기 15), 첫 프로세스 종료 직후 재대기에서 1~2분 만에 이른 timedOut이 발생한 원인은 미검증입니다(대기 7).

### worker-start 자동 /clear

worker-start 시 freshContext 필드의 cleared·reason 값으로 대화 초기화 여부를 관찰했습니다.

**관찰 내용**

| 상황 | cleared | reason | 대화 상태 |
|---|---|---|---|
| 첫 작업 | false | first-task | /clear 없음 |
| 같은 task 재작업 | false | same-task | 이전 대화 유지 |
| 다른 task(검토) | true | review | 새 대화로 시작 (/clear 전송) |
| task 변경 | true | purpose-changed | 새 대화로 시작 (/clear 전송) |

특별히, 같은 task 검토를 두 번 실행하면 첫 번째·두 번째 모두 대화를 새로 시작합니다(previousLaunchAt 기록). 이는 문서의 "검토는 항상 새 대화로 시작한다"는 규칙과 일치합니다.

## 남은 사항

### Claude 신뢰 Enter 효과 실측

Codex와 Claude의 신뢰 질문 화면에서 감독자가 prompt-answer로 보내는 Enter 키의 효과를 실제로 관찰하지 못했습니다. classifier의 accept 기준서에는 "Enter는 화면 안내문에서 도출한 미검증 키로 코드와 문서에 표시"되어 있습니다. 이 효과는 이번 통합 단계의 실제 경로 검증에서도 확인하지 못했으므로 Codex 검증 시점에 함께 추가합니다.

### 호출자 식별의 한계

supervisor-path의 accept 기준서에서 "호출자 식별이 ORCA_TERMINAL_HANDLE에만 의존한다는 한계는 문서에 적혔다"고 기록했습니다. prompt-answer 명령은 호출자가 Run 바인딩 PM이거나 그 역할을 시작한 PL인지 확인하지만, 환경변수 기반 확인만 사용 가능한 제약이 있습니다.
