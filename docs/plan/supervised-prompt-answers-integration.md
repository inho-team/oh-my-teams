# supervised-prompt-answers 통합 기록

## 통합 HEAD 구성

이 문서가 설명하는 코드 기준 커밋은 345def2e021d93f80dab2b4a431e170803d9cf47입니다. 이 문서를 더하기 전의 통합 브랜치이며, 아래 실제 경로 검증에 쓴 워크트리도 이 커밋에서 만들었습니다. 최종 통합 HEAD는 이 문서를 반영한 병합 커밋이고, 그 커밋은 코드 기준 커밋에 이 문서만 더했으므로 코드 트리는 같습니다. 그래서 특정 최종 병합 커밋의 해시는 적지 않습니다.

코드 기준 커밋은 다음 변경사항을 포함하고 있습니다.

**병합 이력 (코드 기준 커밋까지의 git log --first-parent)**
- 345def2: merge: origin/main(b625b25) 반영
- a59022b: merge: supervised-prompt-answers task 결과 통합 (capture·submission·classifier·supervisor-path)

이 문서를 반영한 병합 커밋은 위 목록의 맨 위에 더해집니다.

**수용된 task 결과 (네 개)**

| task | 수용 커밋 | 기준 | 검사 |
|---|---|---|---|
| capture | e645778 | 형식·동기화·검사 통과, 독립 재검토 approved | format·sync·lint·test ✓ |
| submission | 7ae0f0f | 형식·동기화·검사 통과, 독립 재검토 approved | format·sync·lint·test ✓ |
| classifier | 991bc6e | 형식·동기화·검사 통과, 독립 재검토 approved | format·sync·lint·test ✓ |
| supervisor-path | 3cf39ee | 형식·동기화·검사 통과, 독립 재검토 approved | format·sync·lint·test(617개) ✓ |

**병합 후 처리**

origin/main을 --no-ff로 병합한 뒤, 수치 문서 충돌에서 통합 브랜치 쪽 내용을 받았습니다. 이 상태에서 npm run sync를 실행하여 다중 파일에 기재된 버전과 감사 수치를 다시 계산했습니다.

## 코드 기준 커밋의 검사 결과

코드 기준 커밋과 최종 통합 HEAD는 코드 트리가 같고 차이는 이 문서뿐이므로, 아래 결과는 두 커밋의 코드에 모두 해당합니다.

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
- submission: enter-sent (명령이 입력줄에 남아 있어 Enter를 한 번 보냄)
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
- turnStart: observed (worker-start 영수증이 턴 시작을 관측했다는 값)
- dispatchId: ctx_1d04553e945f
- freshContext.cleared: false
- freshContext.reason: first-task (첫 작업이므로 대화 초기화 없음)
- binding.role: junior
- binding.modelProof: unproven (role-terminal 결과의 화면 모델로 모델 확인)

**turnStart를 영수증으로 증명한 범위**

turnStart: observed는 이 첫 시작에서만 관측했습니다. 같은 통합 단계에서 `--workflow-task` 없이 같은 터미널을 다시 시작한 worker-start 두 번(start-verify-claude-2, start-verify-claude-3)과 통합 검토 시작(start-review-integration-1)은 모두 turnStart: unsupported였습니다. 앞의 두 번은 영수증으로는 턴 시작을 증명하지 못해 화면으로 진행을 확인했고, 세 시작 모두 worker는 이후 작업을 수행하고 결과를 보고했습니다. 이 kickoff에서는 /clear가 없던 시작은 observed, /clear 뒤의 시작은 unsupported로 나오는 경향이 되풀이되었으나 원인은 확인하지 않았습니다.

## Agy와 Codex

이번 통합 시점에는 두 클라이언트의 검증이 미완료입니다.

**Agy**
현재 /Users/jinsungkim/orca/oh-my-teams/.omt/organization.json의 역할 구성에 Agy 프로필을 사용하는 역할이 없어 검증을 시작할 수 없습니다. 조직의 모든 역할이 Claude 프로필이라 role-terminal과 prompt-answer 경로로 Agy나 Codex를 열 수 없기 때문입니다.

이 때문에 PM이 2026-09-21 17시대(UTC)에 director-signal decision(id 1f7bbebc-a5ee-4813-8cf3-6421ab2dbc18)으로 이사에게 결정을 요청했고, 알림은 전달되었습니다(notified true). 요청한 선택지는 두 가지입니다. (A)는 검증 전용 역할 매핑(예: junior를 agy-oss로, 한도가 풀린 뒤 junior를 codex-luna로)과 검증 전용 workflow를 만드는 것이고, (B)는 Agy와 Codex를 미검증으로 남기는 것입니다. 근거 기록을 남긴 시점까지 이사의 답은 없었습니다.

**Codex**
Codex의 주간 사용량 한도가 2026-09-26 06:11 KST에 리셋될 예정이므로, 그 이후에 같은 경로(새 워크트리 생성 → role-terminal → prompt-answer → worker-start)를 검증합니다. 현재 결과 표에는 Codex를 완료로 나타내지 않습니다.

| 클라이언트 | 확인한 경로 | 미확인 단계 | 상태 |
|---|---|---|---|
| Claude (Haiku 4.5) | wt, rt(신뢰 질문 제외), pa, idle, ws | 신뢰 질문 경로(prompt-answer 키 전달) | ✓ 부분 확인 |
| Agy | — | 모든 경로 | ⏳ 이사에게 요청한 역할 매핑 결정 대기 (답 없음) |
| Codex | — | 모든 경로 | ⏳ 한도 리셋(2026-09-26 06:11 KST) 뒤 예정 |

## 2.8.0 기능 관측 요약

### supervision-wait --ack

점진적 전달 확인 플래그 --ack를 사용하여 PM이 대기 중에 heartbeat 메시지를 자동으로 필터링하고, 실제 업무 메시지만 모델을 깨우는 동작을 검증했습니다.

**관찰 내용**
- --ack 플래그가 있는 대기에서 heartbeat가 여러 건 전달되었으나 래퍼가 흡수했고 모델을 깨우지 않았습니다. 예를 들어 대기 1(heartbeats: 1), 대기 2(heartbeats: 1), 대기 3(heartbeats: 1), 대기 5(heartbeats: 1), 대기 8(heartbeats: 1) 등에서 heartbeat가 흡수되었습니다.
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
| 검토 시작(--purpose review) | true | review | 새 대화로 시작 (/clear 전송) |
| 직전 시작이 검토였던 구현 시작(같은 task, purpose 없음) | true | purpose-changed | 새 대화로 시작 (/clear 전송) |
| --workflow-task 없이 다시 시작 | true | task-unidentified | 새 대화로 시작 (/clear 전송) |

purpose-changed는 task가 바뀌어서 나온 값이 아닙니다. 같은 터미널에서 submission 검토 뒤에 같은 submission 구현을 다시 시작했을 때, 직전 시작이 검토였고 이번에는 purpose가 없었으므로 나온 값입니다. task-unidentified는 통합 단계에서 `--workflow-task` 없이 같은 터미널에 지시를 다시 넘긴 두 번(start-verify-claude-2, start-verify-claude-3)에서 관측했으며, 두 번 모두 reason이 task-unidentified였고 /clear가 나갔습니다.

특별히, 같은 task 검토를 두 번 실행하면 첫 번째·두 번째 모두 대화를 새로 시작합니다(previousLaunchAt 기록). 이는 문서의 "검토는 항상 새 대화로 시작한다"는 규칙과 일치합니다.

## 남은 사항

남은 사항은 성격이 서로 다르므로 미구현, 미검증, 결정 필요로 나누어 적습니다.

### 미구현: 업데이트 안내와 명령 승인 화면

업데이트 안내와 명령 승인 질문은 어느 CLI에서도 화면이 캡처되지 않았습니다(docs/plan/prompt-screen-captures.md의 캡처 결과표). Claude의 업데이트 안내는 신뢰된 워크트리에서 읽은 화면 5건에 나타나지 않아 관측되지 않은 상태이고, 나머지는 미검증입니다. 그래서 분류기(`prompt-answers.mjs`)는 이 화면을 알아보지 못하고 `unknown`으로 분류합니다.

명령 범위를 판정하는 `judgeCommandScope`와 `decideApproval`은 `prompt-answers.mjs`에 구현되어 `tests/prompt-answers.test.mjs`에서 검증되지만, `prompt-answers.mjs` 밖의 런타임 코드에서는 호출되지 않습니다(저장소 전체에서 두 이름을 검색해 확인했습니다). 따라서 명령 승인 질문에 감독자가 대신 답하는 동작은 아직 작동하지 않습니다.

`orca-runtime.md`의 「프롬프트 질문 답하기」 절과 `waiting-on-human-prompt` 항목은 폴더 신뢰나 명령 승인 같은 질문에 감독자가 `prompt-answer`로 답한다고 적고, 같은 절의 4번 항목은 명령 승인 화면을 분류기가 아직 알아보지 못한다고 적습니다. 이 서술들은 함께 읽어야 합니다. 현재 코드에서 분류기가 질문으로 인식하지 못한 화면(`kind`가 `unknown`이고 CLI를 특정하지 못한 경우)은 `prompt-supervision.mjs`가 키를 보내지 않고 `no-question`과 `next: resume-precheck`로 기록합니다. 따라서 명령 승인 화면이 나오면 감독자는 답하지 못하고, 그 화면이 상위 보고로 이어지는지는 `escalate`의 `waiting-on-human-prompt` 판정을 거치는 별도 경로에 달려 있으며 이번 통합에서 실측하지 않았습니다. 이 서술의 어긋남을 문서에서 고치는 일도 남아 있습니다.

### 미검증: Codex와 Agy, 그리고 Enter와 Esc의 효과

- Codex와 Agy의 신뢰 질문 이후 화면(업데이트 안내, 명령 승인, 사용자 질문 등)은 확인하지 못했습니다. 신뢰 질문에 답하면 사용자 설정에 신뢰가 기록되므로 캡처 단계에서 답하지 않았습니다.
- Codex와 Agy에서 신뢰 질문에 Esc를 보냈을 때의 동작은 확인하지 못했습니다. Claude에서는 Esc를 한 번 보냈을 때 질문이 닫히고 Claude가 종료되었으며, 이 관측은 지시 밖 입력이었습니다.
- Codex와 Claude의 신뢰 질문에서 Enter의 효과는 어느 CLI에서도 실측하지 못했습니다. classifier의 accept 기준서에는 "Enter는 화면 안내문에서 도출한 미검증 키로 코드와 문서에 표시"되어 있고, 이 키의 근거는 `footer-text`입니다. 이번 통합 단계의 실제 경로 검증에서도 확인하지 못했습니다.
- Codex는 주간 사용량 한도로, Agy는 역할 매핑 결정 대기로 검증하지 못했습니다(앞 절의 표를 참고합니다).
- 이 문서에는 PR의 CI 결과가 없습니다. PR을 만든 뒤 `CI` 워크플로 결과를 확인해야 합니다.

### 결정 필요: Claude 신뢰 질문 실측

이번 kickoff에서 role-terminal로 연 Claude 터미널은 모두 trust not-asked였습니다(spa-supervisor, spa-verify-claude, spa-integration-doc 등). 읽기만 한 `~/.claude.json`의 `hasTrustDialogAccepted`가 true인 항목에는 주인 체크아웃(/Users/jinsungkim/orca/oh-my-teams)이 있고, 이 kickoff의 워크트리 경로(/Users/jinsungkim/orca/workspaces/oh-my-teams/...)는 항목에 없습니다. 그런데도 질문이 나오지 않은 원인이 주인 저장소의 신뢰 상속인지는 확인하지 않았습니다. 반면 capture 단계에서 `git init`만 한 임시 디렉터리에서는 Claude 신뢰 질문이 나왔습니다.

`prompt-answer`는 Orca 계보상 kickoff PM 워크트리의 후손인 워크트리에만 답하므로, 이 저장소의 kickoff에서는 Claude 신뢰 질문에 키를 보내는 실제 경로를 만들 수 없었습니다. 신뢰 기록이 없는 폴더에서 실측하려면 CLI가 답한 폴더를 사용자 신뢰 목록에 기록하게 됩니다. 캡처 단계에서 신뢰 질문에 답하지 않은 이유도 이것입니다. 따라서 이 실측을 진행할지는 이사가 정해야 합니다. 근거 파일(evidence-2.8.0-features.md)에는 이 결정을 이사에게 요청한 기록이 없습니다. 정해지기 전까지 Claude의 신뢰 질문 경로는 미검증으로 남습니다.

명령 승인과 업데이트 안내를 이번 kickoff의 범위에 남길지도 PM과 이사가 정할 사항입니다. 원본 브리프의 수용 기준 2는 화면을 캡처해 확인하지 못한 CLI와 질문을 분류기에 넣지 않는다고 정하고 있어, 캡처하지 못한 명령 승인과 업데이트 안내를 분류기가 알아보지 못하는 현재 상태는 그 기준과 어긋나지 않습니다.

### 호출자 식별의 한계

supervisor-path의 accept 기준서에서 "호출자 식별이 ORCA_TERMINAL_HANDLE에만 의존한다는 한계는 문서에 적혔다"고 기록했습니다. prompt-answer 명령은 호출자가 Run 바인딩 PM이거나 그 역할을 시작한 PL인지 확인하지만, 환경변수 기반 확인만 사용 가능한 제약이 있습니다.
