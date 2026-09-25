# supervised-prompt-answers 통합 기록

## 통합 HEAD 구성

이 문서가 설명하는 코드 기준 커밋은 345def2e021d93f80dab2b4a431e170803d9cf47입니다. 이 문서를 더하기 전의 통합 브랜치이며, 아래 Claude 실제 경로 검증에 쓴 워크트리도 이 커밋에서 만들었습니다. Agy 검증 워크트리는 origin/main에서 따로 만든 뒤 통합 브랜치의 8768f9c로 옮겼으며, 아래 Agy 절에 적었습니다. 이 커밋의 코드는 수정 전 상태이고, 이후 c5feb62가 `prompt-supervision.mjs`, `orca-adapter.mjs` 등의 코드를 바꾸었습니다. 그래서 통합 브랜치의 HEAD는 코드 기준 커밋과 코드 트리가 같지 않습니다.

통합 브랜치의 HEAD는 이 문서를 반영하는 병합과 코드 수정을 반영하는 병합을 거치며 바뀌었고, 이 문서를 다시 고친 커밋이 병합되면 한 번 더 바뀝니다. 그래서 최종 병합 커밋의 해시는 적지 않고, 커밋 사이의 관계와 각 시점의 검사 결과를 적습니다.

코드 기준 커밋은 다음 변경사항을 포함하고 있습니다.

**병합 이력 (git log --first-parent, 이 문서를 다시 고친 커밋의 병합 전까지)**
- e09cb6b: merge: 통합 기록 검토 반영과 미인식 질문 화면 escalate 수정. 두 번째 부모인 c5feb62를 병합했고, 코드 트리는 c5feb62와 같습니다.
- 8d11a83: merge: supervised-prompt-answers 통합 기록 반영. 345def2에 이 문서만 더했으므로 코드 트리는 345def2와 같습니다.
- 345def2: merge: origin/main(2.8.2) 반영. 병합한 origin/main 커밋은 b625b25입니다.
- a59022b: merge: supervised-prompt-answers task 결과 통합 (capture·submission·classifier·supervisor-path)

**통합 기록 브랜치(dev-inho/spa-integration-doc)의 커밋**
- a54bf6c, 9292034, 11aa6bc: 통합 기록의 작성과 수정입니다. 문서만 바꾸었고 8d11a83이 병합했습니다.
- 244ec20: 통합 기록의 독립 검토 finding 4건을 반영했습니다. 문서만 바꾸었고 c5feb62를 거쳐 e09cb6b에 포함되었습니다.
- c5feb62: 인식되지 않은 질문 화면에서 `prompt-answer`가 순환하지 않고 `escalate`로 끝나도록 코드를 수정했습니다. `orca-runtime.md`, PM·PL 스킬, 수치 문서와 회귀 테스트도 함께 바뀌었고, e09cb6b가 병합했습니다.
- 이 문서를 다시 고친 커밋: 문서만 바꾸므로 코드 트리는 c5feb62와 같습니다. 이 커밋을 병합한 커밋이 최종 통합 HEAD가 됩니다.

**수용된 task 결과 (네 개)**

| task | 수용 커밋 | 기준 | 검사 |
|---|---|---|---|
| capture | e645778 | 형식·동기화·검사 통과, 독립 재검토 approved | format·sync·lint·test ✓ |
| submission | 7ae0f0f | 형식·동기화·검사 통과, 독립 재검토 approved | format·sync·lint·test ✓ |
| classifier | 991bc6e | 형식·동기화·검사 통과, 독립 재검토 approved | format·sync·lint·test ✓ |
| supervisor-path | 3cf39ee | 형식·동기화·검사 통과, 독립 재검토 approved | format·sync·lint·test(617개) ✓ |

**병합 후 처리**

origin/main을 --no-ff로 병합한 뒤, 수치 문서 충돌에서 통합 브랜치 쪽 내용을 받았습니다. 이 상태에서 npm run sync를 실행하여 다중 파일에 기재된 버전과 감사 수치를 다시 계산했습니다.

## 시점별 검사 결과

코드 트리가 같은 커밋은 검사 결과를 공유하므로, 코드 트리가 달라지는 시점을 기준으로 두 열로 나누어 적습니다.

- 345def2와 8d11a83: 8d11a83은 345def2에 이 문서만 더했으므로 코드가 같습니다. 618개 결과는 8d11a83에서 실행한 검사(w1/verify-integration-1.json)이며, 두 커밋의 코드에 모두 해당합니다.
- e09cb6b: c5feb62의 코드 수정을 포함합니다. 623개 결과는 e09cb6b에서 실행한 검사(w1/verify-integration-2.json)입니다. 테스트가 618개에서 623개로 늘었고, c5feb62에서 바뀐 테스트 파일은 `tests/prompt-supervision.test.mjs` 하나입니다.

| 검사 | 345def2·8d11a83 (수정 전 코드) | e09cb6b (c5feb62 수정 반영) |
|---|---|---|
| npm run format | ✓ 통과 | ✓ 통과 |
| npm run sync | ✓ 통과 | ✓ 통과 |
| npm run lint | ✓ 통과 | ✓ 통과 |
| npm test | ✓ 618개 테스트 통과 | ✓ 623개 테스트 통과 |

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

이 검증에서는 turnStart: observed를 첫 시작에서만 관측했습니다. 같은 통합 단계에서 `--workflow-task` 없이 같은 터미널을 다시 시작한 worker-start 두 번(start-verify-claude-2, start-verify-claude-3)과 통합 검토 시작(start-review-integration-1)은 모두 turnStart: unsupported였습니다. 앞의 두 번은 영수증으로는 턴 시작을 증명하지 못해 화면으로 진행을 확인했고, 세 시작 모두 worker는 이후 작업을 수행하고 결과를 보고했습니다. 이 kickoff 전체에서는 turnStart 값이 /clear 여부와 관계없이 observed와 unsupported로 섞여 나왔고, 원인은 확인하지 않았습니다. /clear가 없던 시작에도 observed(start-classifier-1, start-supervisor-path-1)와 unsupported(start-capture-1, start-submission-1, 같은 task 재작업인 start-classifier-fix-1)가 모두 있었고, /clear 뒤의 시작에도 observed(start-review-submission-2, start-integration-approval-fix-1)와 unsupported(start-review-capture-1, start-review-integration-1 등)가 모두 있었습니다.

## Agy와 Codex

이번 통합 시점에 Agy는 일부 경로만 관측했고 작업 수행은 검증하지 못했습니다. Codex는 2026-09-25에 한도 리셋을 기다리지 않고 실제 경로 검증을 수행했으며, 시작 경로까지는 한도에 막히지 않았지만 첫 모델 호출이 주간 한도로 거부되어 작업 수행은 검증하지 못했습니다. Agy 검증은 실행 당시 사용자가 승인한 결정이 아니라 알림 결함으로 생긴 무승인 결정(이슈 #82)에 따라 실행되었으므로, 정정을 먼저 적습니다. 이후 2026-09-22에 사용자가 그 결과를 증거로 유지하도록 사후 승인했고, 같은 날 Codex 검증의 역할 매핑도 승인했습니다. 근거 파일은 `.omt/evidence-2.8.0-features.md`의 「무승인 결정(#82)으로 진행한 Agy 실제 경로」 절과 「사용자의 직접 결정 (2026-09-22)」 절, 「Codex 실제 경로 검증 (2026-09-25, 한도 리셋을 기다리지 않고 수행)」 절, `.omt/w2/CORRECTION-82.md`입니다.

### 무승인 결정 정정 (이슈 #82)

PM은 Agy 검증을 위해 director-signal decision으로 이사에게 결정을 세 번 요청했습니다.

| 결정 요청 신호 | 요청한 내용 | 이 결정에 따라 실행한 일 |
|---|---|---|
| 1f7bbebc | (A) 검증 전용 역할 매핑(예: junior를 agy-oss로)과 검증 전용 workflow를 만드는 것, (B) Agy와 Codex를 미검증으로 남기는 것 | 조직 revision 7·8 변경과 workflow 생성 (w2/org-edit-agy.out, w2/create.out, w2/org-edit-revert.out) |
| f7c7658f | 감독 worker-start가 시작되지 않는 Agy 터미널에 `--inject-fallback`을 쓰는 것 | workflow-reserve, worker-start `--inject-fallback`, workflow-attach (w2/reserve-agy-path-1.json, w2/start-agy-path-1.json, w2/attach-agy-path-1.json) |
| 0fa15db8 | 제공자 503 뒤에 같은 터미널에 다시 입력을 보내는 것 | `terminal send` 1회 (w2/send-retry-1.json) |

1f7bbebc는 2026-09-21 17시대(UTC)에 요청했습니다. 이사는 세 건의 답을 '사용자 결정'으로 전달했고, 그 전달에 따라 위 작업을 실행했습니다. 그러나 2026-09-22에 이사가 확인한 바로는 세 건 모두 사용자가 직접 고른 답이 아니었습니다. director-signal 알림의 Enter가 이사 화면에 열려 있던 선택 창의 첫 번째 선택지를 골랐고, 사용자는 직접 답하지 않았습니다(이슈 #82).

실행 당시 조직 매핑 변경, 주입, 재시도는 사용자 승인이 아니라 알림 결함으로 생긴 무승인 결정에 따라 실행되었습니다. 어느 것도 실행 당시의 사용자 승인을 근거로 서술하지 않습니다. `w2/start-agy-path-1.json`의 `approval` 문자열("사용자가 … 승인함")은 당시 전달받은 내용을 그대로 적은 실행 기록이며 사실과 다릅니다. 원본 실행 기록은 고치지 않았습니다. 관측 결과(신뢰 응답, 주입, 제공자 503)는 사실 기록으로 유지합니다.

### 사후 승인 (2026-09-22)

이사가 전달한 바로는, 사용자가 선택 창 없이 이사 대화에 글로 직접 답했습니다('1 A, 2 유지'). 이 결정은 두 가지입니다. 첫째, 사용자는 Agy·Codex 실제 경로 검증에 A안(검증 전용 역할 매핑)을 승인했습니다. Codex는 주간 사용량 한도가 리셋되는 2026-09-26 06:11 KST 이후 junior를 codex-luna로 매핑해 같은 절차를 따릅니다. 조건은 앞서 이사가 전달한 것과 같습니다. 조직에 있는 프로필만 매핑하고, 검증 전용 workflow를 만드는 동안만 매핑을 유지한 뒤 곧바로 되돌리며, 바꾼 revision과 되돌린 revision을 progress 신호로 알리고, 사용자 설정 파일의 신뢰 목록은 직접 고치지 않습니다. 둘째, 사용자는 이미 얻은 Agy 결과(폴더 신뢰 자동 응답, 터미널 재열기, 주입까지 확인, 작업 수행은 제공자 503으로 미검증)를 증거로 유지하도록 승인했으며, Agy는 다시 실행하지 않습니다.

이에 따라 이 문서가 적은 조직 매핑 변경, 주입, 재시도는 "실행 당시에는 무승인(#82)이었고, 2026-09-22에 사용자가 결과를 증거로 유지하도록 사후 승인함"으로 기록합니다. 사후 승인은 결과를 증거로 쓰는 것에 대한 승인이며, 실행 당시에 승인이 있었다는 뜻이 아닙니다. 이 승인을 근거로 하는 새 작업은 Codex의 junior→codex-luna 검증 전용 매핑뿐이며, 다른 매핑 변경은 시작하지 않습니다(근거: `.omt/evidence-2.8.0-features.md`의 「사용자의 직접 결정 (2026-09-22)」 절, `.omt/w2/CORRECTION-82.md`의 「사후 승인」 절).

### Agy 관측 (Antigravity CLI 1.2.7, agy-oss, 화면 모델 GPT-OSS 120B (Medium))

**조직 매핑과 workflow**
- 조직 revision 6에서 7로 바꾸어 junior를 agy-oss에 매핑했고, workflow `supervised-prompt-answers-w2-agy`(depth 2, organizationRevision 7)를 만든 직후 revision 8에서 junior를 claude-haiku로 되돌렸습니다. 세 명령은 한 셸 호출에서 연달아 실행했습니다. 이 문서를 고치는 시점의 조직 파일(revision 9)에서도 모든 역할은 Claude 프로필이며, Agy와 Codex 프로필을 쓰는 역할은 없습니다.

**워크트리 생성 (w2/wt-verify-agy.json)**
- 새 워크트리 spa-verify-agy는 Orca가 origin/main의 b625b25로 만들었고, PM이 통합 브랜치의 8768f9c로 fast-forward했습니다. 8768f9c는 c5feb62의 수정을 포함합니다. 생성 전 Agy settings.json에는 이 경로가 없었습니다(읽기만 했습니다).

**role-terminal 실행 (w2/rt-verify-agy.json)**
- profile은 agy-oss이고, 실행 명령은 `agy --dangerously-skip-permissions --model gpt-oss-120b-medium`입니다. submission은 enter-sent, trust는 accepted, ready는 true입니다.
- `reopened`에는 닫힌 터미널 term_ebd209e6과 사유 trust-question-in-buffer가 기록되었고, 준비가 끝난 터미널은 새로 열린 term_6d5f46f4입니다. 화면에는 모델 "GPT-OSS 120B (Medium)"과 작업 폴더 ~/orca/workspaces/oh-my-teams/spa-verify-agy가 표시되었습니다.

**신뢰 질문에 대한 감독자 응답 (prompt-answers.jsonl의 id 79e300e5)**
- promptAnswers 1건입니다. 감독자는 PM(run_560d98ca9f04)이고, kind는 trust, cli는 agy, 확인한 버전은 1.2.7입니다. 화면에서 대조한 줄은 "Do you trust the contents of this project?", "> Yes, I trust this folder", "No, exit", "↑/↓ Navigate · enter Confirm"이고 선택된 항목은 index 1입니다. workspace는 역할 워크트리와 같았습니다.
- 보낸 키는 Enter이고 근거는 existing-behavior입니다. 기록은 status sending에서 resolved로 바뀌었고, delivery는 accepted, 키를 보낸 뒤 화면은 kind unknown(질문이 사라짐)이며, next는 resume-precheck입니다. 감독자 응답으로 Agy의 신뢰 질문이 해소된 것을 관측했습니다.
- 응답 뒤 Agy settings.json에는 spa-verify-agy 경로가 한 건 생겼습니다(읽기만 했습니다). PM이 쓴 것이 아니라 Agy CLI가 신뢰 응답을 기록한 결과입니다.

**terminal-idle-check (w2/idle-verify-agy.json)**
- 20초 안에 tui-idle을 보고하지 않아 거부되었습니다(종료 코드 1, Dispatch 없음). `orca terminal show`의 agentWait는 null이었습니다. `orca-runtime.md`의 Agy 문단에 적힌 대로, 모델 이름이 gemini로 시작하지 않는 Agy 프로필(GPT-OSS)은 Orca의 대기 판정을 통과하지 못하므로 예상된 거부입니다. 시도를 예약하기 전이어서 workflow 예산은 쓰지 않았습니다.
- 그래서 감독 worker-start 경로로는 이 터미널에 작업을 넘길 수 없었습니다. Orca가 GPT-OSS Agy 터미널의 대기를 보고하지 못했기 때문입니다.

**주입 (무승인 결정 f7c7658f에 따라 1회 실행)**
- workflow-reserve(revision 1에서 2) 뒤 `worker-start --inject-fallback`을 실행했습니다(w2/start-agy-path-1.json, 지시문 w2/spec-agy-path-1.md). 결과는 `via: "dispatch-inject"`, `supervised: false`, `injected: true`, taskId task_e6bdb8c32de5, dispatchId ctx_5f6f07b38873, `liveness: "unverifiable"`입니다. `binding.modelProof`는 `unproven`이고, `refusal`에는 사전 점검의 timeout 원문이 남았습니다. 이 결과는 감독 worker-start 경로가 아닙니다.
- workflow-attach(revision 3)에는 via dispatch-inject, screenModel "GPT-OSS 120B (Medium)", supervised false로 기록되었습니다.

**제공자 503**
- 주입한 지시문은 Agy 화면에 도착했습니다. 그러나 Agy는 모델 호출에서 "UNAVAILABLE (code 503): No capacity available for model gpt-oss-120b-medium on the server"(Error ID f7586aaf-a0b3-4272-b070-c5a1a7eba445-1-2010)를 표시하고 입력 대기(`>`)로 돌아갔습니다. 2분 뒤에도 화면은 같았고, 워크트리에는 커밋과 변경이 없었으며, worker_done도 오지 않았습니다. 이 오류는 Orca의 주입 거부가 아니라 모델 제공자의 용량 부족입니다.
- 이어서 무승인 결정 0fa15db8에 따라 같은 터미널에 `terminal send --text "다시 시도" --enter`를 1회 보냈습니다(w2/send-retry-1.json). 결과는 `accepted: true`, stages `["input_accepted"]`이고, provider와 observation은 `unsupported`이며 "this provider cannot report delivery" 경고가 붙었습니다. 60초 뒤 화면에는 같은 503 오류(Error ID f7586aaf-a0b3-4272-b070-c5a1a7eba445-3-2010)가 다시 나왔고 워크트리에는 변경이 없었습니다. 그 뒤로 입력을 더 보내지 않았습니다.

**정산과 정리**
- workflow-settle는 outcome failed, callsUsed 2로 기록되었습니다(w2/settle-agy-path-1.json, workflow revision 4, status blocked, route unknown이며 pm이 classify-with-evidence). 명령의 종료 코드는 1이었지만 상태 파일에는 정산이 기록되었습니다. Orca Task task_e6bdb8c32de5는 failed로 닫았습니다(w2/task-close.json).
- 터미널 term_6d5f46f4를 닫았고(w2/term-close.json), 워크트리 spa-verify-agy를 제거했습니다(w2/wt-rm.json, removed true). 브랜치 dev-inho/spa-verify-agy는 8768f9c로 보존되었고 새 커밋은 없습니다. Agy CLI가 settings.json에 기록한 spa-verify-agy 신뢰 항목은 사용자 설정이므로 PM이 지우지 않았습니다.

**미검증으로 남은 것**
- Agy가 작업 계약(docs/plan/agy-path-check.md를 작업 워크트리에 커밋)을 수행하는지, worker_done을 보내는지는 확인하지 못했습니다. 두 번의 시도 모두 제공자 503으로 끝났기 때문입니다.
- 감독 worker-start 경로로 Agy에 작업을 넘기는 동작은 시작할 수 없었으므로 확인하지 못했습니다.
- 주입 경로의 결과는 `supervised: false`, `modelProof: unproven` 그대로입니다. 화면에 표시된 모델만 확인했습니다.

### Codex 관측 (OpenAI Codex CLI 0.155.1, codex-luna, 화면 모델 gpt-5.6-luna medium)

2026-09-25에 이사가 사용자 결정으로 "한도 리셋을 기다리지 말고 지금 Codex 검증을 재개하라"고 지시했습니다. 근거는 브리프 수용 기준 3의 첫 문장이며, 주간 한도가 막는 것이 모델 호출인지 신뢰 질문 화면인지를 먼저 가리라는 것이었습니다. 근거 파일은 `.omt/evidence-2.8.0-features.md`의 「Codex 실제 경로 검증 (2026-09-25, 한도 리셋을 기다리지 않고 수행)」 절이며, 실행 기록 원문은 `.omt/w3/`에 있습니다.

**조직 매핑(A안)과 검증 전용 workflow**
- 첫 편집이 거부되었습니다. junior의 profile만 codex-luna로 바꾸고 fallbacks에 codex-luna를 그대로 둔 채 `edit --revision 9`를 보냈더니 "Invalid fallbacks: junior"로 거부되었습니다. 역할의 profile은 자기 fallbacks에 다시 들어갈 수 없습니다.
- 그 거부를 확인하지 못한 채 `workflow-create`가 먼저 실행되어, junior가 claude-haiku인 조직 revision 9 스냅샷으로 workflow `supervised-prompt-answers-w3-codex`가 만들어졌습니다. 이 workflow는 Codex를 띄울 수 없으므로 쓰지 않고 폐기했습니다(attemptsUsed 0, 실행 이력 없음). 상태 디렉터리는 기록으로 남습니다.
- 되돌림 편집은 성공해 revision 10이 되었고, 내용은 revision 9와 같습니다(파일 비교로 확인했습니다).
- 두 번째 시도에서 profile을 codex-luna로, fallbacks를 `["agy-oss"]`로 함께 바꾸어 `edit --revision 10`이 성공했습니다. **바꾼 revision은 11**이며, `show`는 `JUNIOR: codex-luna | Current ChatGPT subscription | codex/gpt-5.6-luna`를 출력했습니다.
- 그 상태에서 검증 전용 workflow `supervised-prompt-answers-w3-codex-r2`를 만들었습니다(depth 2, roles [pm, junior], organizationRevision 11). 곧바로 매핑을 되돌려 **되돌린 revision은 12**가 되었고, junior는 `{profile: claude-haiku, fallbacks: [codex-luna, agy-oss]}`로 원래대로 돌아왔습니다.

**첫째 단계: 워크트리 생성과 role-terminal에서는 한도가 막지 않았고 폴더 신뢰 질문은 나타나지 않았다**
- 새 Orca 워크트리 spa-verify-codex를 만들었습니다(HEAD 636c5b3, branch dev-inho/spa-verify-codex).
- role-terminal이 터미널 term_eb005eed를 열었습니다. 실행 명령은 `codex --dangerously-bypass-approvals-and-sandbox --model gpt-5.6-luna`이고, matrix는 supervised-terminal, 경고는 untested_patch_version입니다.
- 결과의 trust는 **not-asked**였습니다. **폴더 신뢰 질문은 나타나지 않았습니다.** 화면에는 `>_ OpenAI Codex (v0.155.1)`, `directory: ~/orca/…/oh-my-teams/spa-verify-codex`, `permissions: YOLO mode`가 떴습니다.
- 신뢰 질문이 나타나지 않은 조건을 읽기만 해서 확인했습니다. 사용자 설정 파일 `~/.codex/config.toml`(읽기만 함)에는 projects 항목이 123개 있고, 그 가운데 `[projects."/Users/jinsungkim"]`의 `trust_level = "trusted"`가 있습니다. spa-verify-codex 경로는 개별 항목으로 등록되어 있지 않지만 그 홈 디렉터리 아래에 있습니다.
- 대신 다른 질문이 나타났습니다. 화면은 `✨ Update available! 0.155.1 -> 0.157.0`과 선택지 세 개(`1. Update now`, `2. Skip`, `3. Skip until next version`), `Press enter to continue`였습니다. 기본 선택은 1번이므로 Enter를 그대로 보내면 전역 npm 설치가 실행됩니다.

**둘째 단계: 분류기는 화면에 답하지 않았으나 감독자의 응답은 업데이트 질문을 해소했다**
- `classifyPromptScreen`을 그 화면 줄로 직접 호출한 결과는 `kind: unknown`, `action: none`, `key: null`이었습니다. 실제 `prompt-answer`도 같은 판정을 내렸습니다. `orcaState: "blocked"`, **`blockedReason: "agent-update-prompt"`**, **`status: "escalate"`**, **`sent: false`**, key는 null, next는 report-upstream이었습니다. 즉 분류기가 업데이트 질문을 신뢰 질문으로 잘못 인식해 Enter를 보내는 일은 일어나지 않았습니다.
- 그 화면을 넘기는 판단은 PM이 자율 권한으로 정했습니다. `1. Update now`는 전역 npm 설치이므로 되돌릴 수 없고 사용자가 소유한 대상에 영향을 주며, `3. Skip until next version`은 사용자 설정에 기록을 남길 수 있어, 아무것도 바꾸지 않는 `2. Skip`만 골랐습니다.
- 키는 두 단계로 보냈습니다. 먼저 **Down**을 보내고 화면을 다시 읽어 선택 표시가 `› 2. Skip`으로 옮겨진 것을 확인한 뒤에만 **Enter**를 보냈습니다. 기본 선택이 전역 설치였으므로 Enter를 먼저 보내지 않았습니다.
- Enter 뒤 화면에서 질문이 사라지고 `model: gpt-5.6-luna medium`, `directory: ~/orca/…/oh-my-teams/spa-verify-codex`, `permissions: YOLO mode`로 입력 대기에 들어갔습니다. 조직이 요청한 모델과 화면의 모델이 일치했습니다.

**셋째 단계: worker 시작에서는 절차가 정상적으로 진행되었고 첫 모델 호출이 한도로 막혔다**
- `terminal-idle-check`는 **idle: true**였습니다. Agy 터미널과 달리 Orca는 Codex 터미널의 대기를 판정했습니다.
- `workflow-reserve`로 attempt codex-path-1을 예약한 뒤(revision 2, status running), `worker-start --terminal`이 성공했습니다. dispatchId ctx_a0e5e8433001, taskId task_5c3ea0b1ea16, **state: ready**, **stage: input_accepted**, **turnStart: observed**, liveness: live, 터미널·워크트리는 reused, freshContext는 `{cleared: false, reason: "not-claude"}`였습니다. binding은 `{profile: codex-luna, provider: codex, via: terminal, modelRequested: gpt-5.6-luna, modelProof: unproven, screenCheck: required, roleHeader: true}`이고, 화면의 `gpt-5.6-luna medium`으로 모델을 대조했습니다.
- 지시문이 화면에 들어가고 Working이 시작된 뒤, **첫 모델 호출이 거부되었습니다.** 화면 원문은 `■ You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 26th, 2026 6:11 AM.`입니다.
- `worker-limit-check`가 세션 로그에서 같은 사실을 확인했습니다. source는 session, verdict는 handoff, limit은 `{kind: "usage-limit", resetsAt: "Sep 26th, 2026 6:11 AM"}`입니다.
- fallback으로 넘기지 않았습니다. junior의 fallback은 agy-oss인데, 사용자가 2026-09-22에 Agy를 다시 실행하지 않기로 결정했기 때문입니다.

**정산과 정리**
- workflow-attach로 receipt를 attempt에 붙인 뒤(revision 3; attach 없이 정산을 먼저 시도했을 때는 "Current attempt is not running"으로 거부되었습니다), workflow-settle로 attempt를 failed로 정산했습니다(revision 4, status blocked, task codex-path state failed, budget attemptsUsed 1·callsUsed 1). 명령의 종료 코드는 1이었지만 상태 파일에는 정산이 기록되었습니다.
- 터미널을 닫고(ptyKilled true) dispatch를 정리한 뒤(worker-abandon, state failed, alreadySettled true, processAction none) Orca Task task_5c3ea0b1ea16을 failed로 닫았습니다. 터미널을 닫기 전에 시도한 task 닫기는 "cannot move to failed while supervised Dispatch ctx_a0e5e8433001 is active"로 거부되었습니다.
- 워크트리는 미커밋 변경이 없고 HEAD가 636c5b3 그대로였습니다(Codex가 모델 호출에 이르지 못해 파일을 만들지 않았습니다). `worktree remove`로 회수했습니다(removed true).

**한도가 막는 지점**

| 단계 | 결과 | 한도가 막았는가 |
|---|---|---|
| 새 워크트리에서 Codex 띄우기 | 터미널이 열리고 화면을 읽었다 | 막지 않았다 |
| 폴더 신뢰 질문 출현 | 나타나지 않았다(trust: not-asked, 홈 디렉터리가 trusted) | 한도와 무관하다 |
| 감독자가 화면을 읽고 키 한 번 보내 답하기 | 업데이트 질문을 Down 확인 뒤 Enter 한 번으로 해소했다 | 막지 않았다 |
| 분류기가 그 화면에 답하기 | unknown → escalate, 키를 보내지 않았다 | 한도와 무관하다 |
| worker 시작(input_accepted, turnStart observed) | 관측되었다 | 막지 않았다 |
| 첫 모델 호출과 작업 수행 | 거부되었다 | **여기서 막혔다**(리셋 2026-09-26 06:11 KST) |

이사가 전달한 전제는 실측으로 확인되었습니다. 한도는 화면 단계를 막지 않았고 worker 시작까지도 막지 않았으며, 막힌 지점은 시작 뒤 첫 모델 호출입니다.

**미검증으로 남았던 것**
- Codex의 폴더 신뢰 질문 화면과 그 화면에 대한 분류기의 응답은 이 시점에는 확인하지 못했습니다. 지금 조건(홈 디렉터리 trusted, YOLO 모드)에서는 질문이 나타나지 않아 화면을 얻을 수 없었습니다. 이 항목은 아래 「Codex 폴더 신뢰 질문 검증 (2026-09-25, 이사 지시로 재시도)」 절에서 사용자 설정 파일을 고치지 않는 방법으로 해소되었습니다.
- Codex worker의 작업 수행과 worker_done, 커밋은 확인하지 못했습니다. 주간 한도로 첫 모델 호출이 거부되었기 때문입니다. 이 항목은 재시도 뒤에도 여전히 미검증으로 남습니다.

조직은 이미 revision 12로 원래 매핑입니다. 폐기한 workflow 상태(`supervised-prompt-answers-w3-codex`)와 정산된 workflow 상태(`supervised-prompt-answers-w3-codex-r2`)는 기록으로 남깁니다. 터미널과 워크트리는 회수했습니다.

### Codex 폴더 신뢰 질문 검증 (2026-09-25, 이사 지시로 재시도)

이사가 "사용자 설정 파일을 고치지 않고도 신뢰 기록이 없는 상태를 만들 수 있다"며 임시 `CODEX_HOME`과 `-c/--config`로 `trust_level`을 덮어쓰는 두 방법을 검토하라고 지시했습니다. 그 지시에 따라 재시도하여 앞서 미검증으로 남겼던 두 항목 가운데 폴더 신뢰 질문 화면과 분류기 응답을 검증했습니다. 사용자의 `~/.codex/config.toml`은 읽기만 했습니다. 근거 파일은 `.omt/evidence-2.8.0-features.md`의 「Codex 폴더 신뢰 질문과 감독자 응답 검증 (2026-09-25, 이사 지시로 재시도)」 절이며, 실행 기록 원문은 `.omt/w3/`에 있습니다.

**방법 선택과 막힌 지점**
- 먼저 임시 `CODEX_HOME`(scratchpad 아래, 권한 700)에 `auth.json`만 복사해 넣었습니다(권한 600). 그 홈에는 `config.toml`이 없어 신뢰 기록이 없는 상태였습니다.
- 이 임시 홈을 조직 프로필의 `role-terminal` 경로에 넣으려던 두 시도는 런타임이 거부했습니다. `codex-luna`의 `command`를 `["env","CODEX_HOME=…","codex"]`로 바꾸면 `launchableProfile`이 "does not use the current account with a plain command"로 거부했고(`role-launch.mjs`의 `command.length === 1` 검사), 같은 검사 때문에 `-c/--config` 인자를 프로필에 넣는 방법도 쓸 수 없었습니다.
- PM 프로세스에 `CODEX_HOME`을 설정해 `role-terminal`을 실행해도, Orca가 만드는 터미널은 PM 프로세스의 환경 변수를 상속하지 않아 열린 터미널의 Codex는 그대로 사용자의 `~/.codex`를 썼고 신뢰 질문이 나타나지 않았습니다.
- 그래서 `role-terminal`로 터미널을 열어 launch ledger에 등록한 뒤(`prompt-answer`는 `launchOf`로 ledger를 조회하므로, 다른 경로로 만든 터미널은 `terminal-not-launched`로 거부됩니다), 그 터미널의 Codex를 `/quit`로 종료하고 같은 터미널에서 임시 `CODEX_HOME`으로 Codex를 다시 실행해 질문을 만들었습니다. 이 상태는 `role-terminal`이 띄운 그대로가 아니라, 감독자가 같은 터미널에서 CLI를 다시 실행해 만든 상태입니다.

**폴더 신뢰 질문 화면 (실제 관측, Codex 0.155.1)**

`orca terminal read --screen`으로 읽은 줄은 다음과 같습니다(`w3/screen-trust-lines.json`, `w3/screen-t3-trust.json`).
```
> You are in /Users/jinsungkim/orca/workspaces/oh-my-teams/spa-verify-codex-trust
  Note: You’re in a subdirectory of a Git project. Trusting will apply to the repository root:
  /Users/jinsungkim/orca/oh-my-teams
  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection.
  Trusting the directory allows project-local config, hooks, and exec policies to load.
› 1. Yes, continue
  2. No, quit
  Press enter to continue
```
이 화면은 `--dangerously-bypass-approvals-and-sandbox`(화면의 permissions는 YOLO mode)에서도 나타났습니다. 따라서 앞서 이 질문이 나타나지 않았던 원인은 권한 우회 플래그가 아니라 신뢰 기록이었다는 것이 이 관측으로 구분되었습니다.

**분류기 판정**

같은 화면 줄로 `classifyPromptScreen`을 호출한 결과는 `kind: "trust"`, `cli: "codex"`, `action: "send-key"`, `key: {name: "Enter", basis: "footer-text"}`이고, `evidence.selected`는 `{index: 1, label: "Yes, continue"}`, `evidence.verifiedVersion`은 `"0.155.1"`, `evidence.workspace`는 화면에서 뽑아낸 워크트리 경로였습니다. `worktree`에 다른 경로를 넣으면 같은 화면이 `action: "none"`으로 바뀌었고, 사유는 화면의 작업 폴더가 역할 워크트리와 다르다는 것이었습니다.

**prompt-answer 실행 결과**

`prompt-answer`를 감독 경로 터미널에서 실행한 결과는 `kind: "trust"`, `action: "send-key"`, `status: "resolved"`, `sent: true`, `key: {name: "Enter", basis: "footer-text"}`, `delivery.accepted: true`, `verification: {result: "resolved", kind: "unknown"}`, `next: "resume-precheck"`였습니다(`w3/pa-trust-1.json`, id `e2b60295`). `supervisor`는 PM 터미널(role pm, run `run_560d98ca9f04`)로 기록되었습니다. Enter 한 번으로 질문이 사라지고 Codex 화면이 나타났으며, 임시 홈의 `config.toml`에 저장소 루트를 신뢰 대상으로 기록한 항목이 새로 생긴 것으로 승인이 실제로 저장되었다는 것도 확인했습니다. 같은 터미널에 `prompt-answer`를 다시 실행하면 `status: "no-question"`, `sent: false`, `key: null`이었습니다(`w3/pa-trust-2.json`). 두 기록은 모두 `.omt/prompt-answers.jsonl`에 남았습니다. 그 뒤 `terminal-idle-check`는 `idle: true`였습니다.

이 관측으로, 분류기의 Codex 항목에 남아 있던 "신뢰 Enter의 효과가 캡처로 확인되지 않았다"는 미검증 상태가 해소되었습니다.

**검증 방법과 그 한계**

임시 `CODEX_HOME`을 조직 프로필의 `command`나 `-c/--config` 인자로 넣는 방법은 `launchableProfile`의 "plain command" 검사(command 원소 한 개) 때문에 쓸 수 없었고, Orca 터미널은 PM 프로세스의 환경 변수를 상속하지 않았습니다. 그래서 `role-terminal`로 열어 launch ledger에 등록한 터미널에서 Codex를 `/quit`로 종료하고 같은 터미널에서 임시 `CODEX_HOME`으로 다시 실행해 이 질문을 만들었습니다. 즉 이 신뢰 질문은 `role-terminal`이 띄운 그대로의 상태에서 나온 것이 아니며, 사용자의 신뢰 목록에 저장소 루트가 들어 있는 한 조직 프로필로 띄우는 실제 경로에서는 이 질문이 나타나지 않습니다.

사용자 설정 파일은 고치지 않았습니다. `~/.codex/config.toml`은 검증 전후로 projects 항목 123개, 수정 시각 2026-09-22T11:07 그대로였고 `spa-verify-codex-trust` 항목은 없습니다. 임시 `CODEX_HOME`은 인증 파일 사본을 담고 있었으므로 검증을 마친 뒤 삭제했고, 디렉터리가 없어진 것을 확인했습니다.

**조직 revision과 남는 항목**

임시 홈을 프로필 command에 넣으려던 시도 때문에 조직을 한 번 더 바꾸었습니다. **바꾼 revision은 13**(`codex-luna`의 command를 `["env","CODEX_HOME=…","codex"]`로, junior를 codex-luna로)이고, 그 상태에서 workflow `supervised-prompt-answers-w4-codex-trust`를 만들었으나 프로필 거부 때문에 쓰지 못하고 실행 이력 없이 남겼습니다. **되돌린 revision은 14**이며, 되돌린 뒤 `codex-luna`의 command는 `["codex"]`, junior는 `{profile: claude-haiku, fallbacks: [codex-luna, agy-oss]}`로 원래대로입니다. 실제 검증은 앞서 만든 `supervised-prompt-answers-w3-codex-r2`로 진행했습니다.

이 재시도로도 Codex worker의 실제 작업 수행과 `worker_done`, 커밋은 여전히 미검증으로 남습니다. 원인은 주간 한도이며 리셋은 2026-09-26 06:11입니다.

| 클라이언트 | 확인한 경로 | 미확인 단계 | 상태 |
|---|---|---|---|
| Claude (Haiku 4.5) | wt, rt(신뢰 질문 제외), pa, idle, ws | 신뢰 질문 경로(prompt-answer 키 전달) | ✓ 부분 확인 |
| Agy (GPT-OSS 120B) | wt, rt와 신뢰 질문 감독자 응답, idle(거부), 주입(supervised false) | 감독 worker-start, 작업 수행, worker_done | 부분 관측. 실행 당시 무승인(#82)이었고, 2026-09-22 결과를 증거로 유지하도록 사후 승인됨. 제공자 503으로 중단 |
| Codex (gpt-5.6-luna) | wt, rt(신뢰 질문 제외), 업데이트 안내 화면(감독자가 직접 응답), 폴더 신뢰 질문과 분류기 응답(임시 CODEX_HOME, 2026-09-25 재시도), idle, ws(turnStart observed) | 작업 수행과 worker_done·커밋 | 부분 관측. 2026-09-25 한도 리셋을 기다리지 않고 검증, 첫 모델 호출이 주간 한도로 거부(리셋 2026-09-26 06:11 KST). 같은 날 재시도로 신뢰 질문 화면과 분류기 응답을 추가로 확인 |

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

purpose-changed는 task가 바뀌어서 나온 값이 아닙니다. 같은 터미널에서 submission 검토 뒤에 같은 submission 구현을 다시 시작했을 때, 직전 시작이 검토였고 이번에는 purpose가 없었으므로 나온 값입니다. task-unidentified는 통합 단계에서 `--workflow-task` 없이 같은 터미널에 지시를 다시 넘긴 네 번(start-verify-claude-2, start-verify-claude-3, start-integration-doc-fix-2, start-integration-approval-fix-1)에서 관측했으며, 네 번 모두 /clear가 나갔습니다. 이 네 번의 turnStart는 start-integration-approval-fix-1만 observed이고 나머지는 unsupported였습니다.

특별히, 같은 task 검토를 두 번 실행하면 첫 번째·두 번째 모두 대화를 새로 시작합니다(previousLaunchAt 기록). 이는 문서의 "검토는 항상 새 대화로 시작한다"는 규칙과 일치합니다.

## 남은 사항

남은 사항은 성격이 서로 다르므로 미구현, 미검증, 결정 필요로 나누어 적습니다.

### 미구현: 업데이트 안내와 명령 승인 화면

업데이트 안내와 명령 승인 질문은 어느 CLI에서도 화면이 캡처되지 않았습니다(docs/plan/prompt-screen-captures.md의 캡처 결과표). Claude의 업데이트 안내는 신뢰된 워크트리에서 읽은 화면 5건에 나타나지 않아 관측되지 않은 상태이고, 나머지는 미검증입니다. 그래서 분류기(`prompt-answers.mjs`)는 이 화면을 알아보지 못하고 `unknown`으로 분류합니다.

명령 범위를 판정하는 `judgeCommandScope`와 `decideApproval`은 `prompt-answers.mjs`에 구현되어 `tests/prompt-answers.test.mjs`에서 검증되지만, `prompt-answers.mjs` 밖의 런타임 코드에서는 호출되지 않습니다(저장소 전체에서 두 이름을 검색해 확인했습니다). 따라서 명령 승인 질문에 감독자가 대신 답하는 동작은 아직 작동하지 않습니다.

분류기가 알아보지 못한 화면(`kind`가 `unknown`이고 CLI를 특정하지 못한 경우)의 처리는 코드 기준 커밋(345def2) 뒤의 c5feb62에서 고쳤습니다. 고치기 전(345def2와 8d11a83)에는 `prompt-supervision.mjs`가 이 화면을 키 없이 `no-question`과 `next: resume-precheck`로 기록했고, `terminal-idle-check`와 `worker-start`의 사전 점검은 같은 화면을 Orca의 `blockedReason`으로 거부하면서 `prompt-answer`를 실행하라고 안내했습니다. 그래서 캡처되지 않은 명령 승인이나 업데이트 안내에서는 "`prompt-answer`가 `no-question` → 점검 거부 → `prompt-answer`"가 되풀이되었고 문서에도 출구가 없었습니다.

지금은 `prompt-answer`가 그런 화면에서 사전 점검과 같은 `terminal wait --for tui-idle`을 3초 동안 실행해 Orca의 상태를 읽습니다(`probeTerminalBlock`, `orca-adapter.mjs`). Orca가 `blockedReason`을 보고하면 키와 지시를 보내지 않고 `escalate`와 `next: report-upstream`으로 끝내며, 그 `blockedReason`을 결과와 `prompt-answers.jsonl`에 남깁니다. Orca가 멈춤을 보고하지 않으면(`satisfied: true`, 이유 없는 `satisfied: false`, `timeout`) 예전처럼 `no-question`입니다. Orca의 응답을 얻지 못하거나 해석하지 못하면 `orca-state-unavailable`로 거부해서, 화면을 깨끗하다고 단정하지 않습니다. 같은 화면과 같은 `blockedReason`을 감독 루프가 다시 읽으면 기록에 줄을 더하지 않고 앞선 시도를 `repeated: true`로 돌려줍니다. 화면 내용은 기록하지 않고 행의 지문만 비교하므로, 화면이나 이유가 바뀌면 새 시도로 기록합니다. `orca-runtime.md`, 두 사전 점검의 거부 메시지, PM·PL 스킬은 이 동작에 맞췄고, 명령 승인 화면을 분류기가 알아보지 못한다는 서술은 유지했습니다. 회귀 테스트는 `tests/prompt-supervision.test.mjs`에 있습니다.

이 동작은 가짜 Orca로만 검증했습니다. 실제 Orca에서 캡처되지 않은 명령 승인 화면에 `terminal wait`를 실행해 `blockedReason`이 나오는지, 짧은 대기 시간 안에 그 값이 돌아오는지는 확인하지 못했습니다. 키를 보낸 뒤 재확인에서 인식된 질문이 사라지고 캡처되지 않은 다른 질문이 이어지는 경우는 여전히 `resolved`로 기록될 수 있으며, 그다음 사전 점검이 그 질문을 거부한 뒤에야 위 경로로 드러납니다. 명령 승인에 감독자가 키로 대신 답하는 동작은 앞에서 적은 대로 아직 작동하지 않습니다.

### 미검증: Codex와 Agy, 그리고 Enter와 Esc의 효과

- Agy의 신뢰 질문 이후 화면(업데이트 안내, 명령 승인, 사용자 질문 등)은 확인하지 못했습니다. Agy는 신뢰 질문에 답한 뒤 질문이 사라지는 것까지만 관측했습니다. 신뢰 질문에 답하면 사용자 설정에 신뢰가 기록되므로 캡처 단계에서는 답하지 않았습니다. Agy 검증 워크트리에서는 무승인 결정(#82)에 따라 답했고, Agy CLI가 기록한 신뢰 항목은 지우지 않았습니다.
- Codex는 2026-09-25 첫 검증에서 폴더 신뢰 질문 화면을 얻지 못했습니다(trust: not-asked, 홈 디렉터리가 이미 trusted). 대신 나타난 업데이트 안내 화면은 분류기가 `kind: unknown`, `blockedReason: agent-update-prompt`, `status: escalate`, `sent: false`로 답하지 않고 넘겼고, PM이 자율 판단으로 Down에 이어 Enter를 한 번 보내 `2. Skip`을 선택해 해소했습니다. 이 경로는 분류기가 아니라 감독자(PM)가 직접 답한 것이므로, 분류기가 Codex의 업데이트 안내 화면에 스스로 답하는 동작은 여전히 미검증입니다. 같은 날 재시도에서는 임시 `CODEX_HOME`으로 신뢰 기록이 없는 상태를 만들어 폴더 신뢰 질문 화면과 분류기 응답을 확인했습니다(「Codex 폴더 신뢰 질문 검증 (2026-09-25, 이사 지시로 재시도)」 절을 참고합니다).
- Codex와 Agy에서 신뢰 질문에 Esc를 보냈을 때의 동작은 확인하지 못했습니다. Claude에서는 Esc를 한 번 보냈을 때 질문이 닫히고 Claude가 종료되었으며, 이 관측은 지시 밖 입력이었습니다.
- Claude의 신뢰 질문에서 Enter의 효과는 실측하지 못했습니다. classifier의 accept 기준서에는 "Enter는 화면 안내문에서 도출한 미검증 키로 코드와 문서에 표시"되어 있고, 이 키의 근거는 `footer-text`입니다. 이번 통합 단계의 Claude 실제 경로 검증에서도 확인하지 못했습니다. **Codex 쪽은 확인되었습니다.** 임시 `CODEX_HOME`으로 만든 신뢰 질문 화면에 `prompt-answer`가 같은 근거(footer-text)의 Enter를 보내자 질문이 사라지고 임시 홈의 `config.toml`에 신뢰 항목이 기록되었습니다(「Codex 폴더 신뢰 질문 검증 (2026-09-25, 이사 지시로 재시도)」 절, `w3/pa-trust-1.json`). Agy 1.2.7의 신뢰 질문에서는 Enter를 한 번 보낸 뒤 질문이 사라진 것을 관측했습니다(`prompt-answers.jsonl`의 id 79e300e5, 키 근거 existing-behavior). 이 관측은 무승인 결정(#82)에 따른 검증 중에 얻었습니다.
- Codex는 2026-09-25에 한도 리셋을 기다리지 않고 실제 경로 검증을 수행했습니다. 워크트리 생성부터 worker 시작(turnStart observed)까지는 주간 한도에 막히지 않았고, 막힌 지점은 시작 뒤 첫 모델 호출이었습니다(리셋 2026-09-26 06:11 KST). 같은 날 이사 지시로 재시도해 폴더 신뢰 질문 화면과 분류기의 응답은 확인했습니다. 미검증으로 남는 항목은 Codex worker의 작업 수행과 worker_done·커밋뿐입니다(자세한 내용은 앞의 「Codex 관측」 절과 「Codex 폴더 신뢰 질문 검증」 절을 참고합니다).
- Agy는 작업 수행과 worker_done을 검증하지 못했습니다. 주입한 지시문과 재시도 입력이 모두 제공자 503으로 끝났고, 감독 worker-start 경로는 시작할 수 없었습니다(앞 절을 참고합니다). 이미 얻은 결과는 2026-09-22에 사용자가 증거로 유지하도록 승인했으며, Agy는 다시 실행하지 않습니다.
- 이 문서에는 PR의 CI 결과가 없습니다. PR을 만든 뒤 `CI` 워크플로 결과를 확인해야 합니다.

### 결정 필요: Claude 신뢰 질문 실측

이번 kickoff에서 role-terminal로 연 Claude 터미널은 모두 trust not-asked였습니다(spa-supervisor, spa-verify-claude, spa-integration-doc 등). 읽기만 한 `~/.claude.json`의 `hasTrustDialogAccepted`가 true인 항목에는 주인 체크아웃(/Users/jinsungkim/orca/oh-my-teams)이 있고, 이 kickoff의 워크트리 경로(/Users/jinsungkim/orca/workspaces/oh-my-teams/...)는 항목에 없습니다. 그런데도 질문이 나오지 않은 원인이 주인 저장소의 신뢰 상속인지는 확인하지 않았습니다. 반면 capture 단계에서 `git init`만 한 임시 디렉터리에서는 Claude 신뢰 질문이 나왔습니다.

`prompt-answer`는 Orca 계보상 kickoff PM 워크트리의 후손인 워크트리에만 답하므로, 이 저장소의 kickoff에서는 Claude 신뢰 질문에 키를 보내는 실제 경로를 만들 수 없었습니다. 신뢰 기록이 없는 폴더에서 실측하려면 CLI가 답한 폴더를 사용자 신뢰 목록에 기록하게 됩니다. 캡처 단계에서 신뢰 질문에 답하지 않은 이유도 이것입니다. 따라서 이 실측을 진행할지는 이사가 정해야 합니다. 근거 파일(evidence-2.8.0-features.md)에는 이 결정을 이사에게 요청한 기록이 없습니다. 정해지기 전까지 Claude의 신뢰 질문 경로는 미검증으로 남습니다.

명령 승인과 업데이트 안내를 이번 kickoff의 범위에 남길지도 PM과 이사가 정할 사항입니다. 원본 브리프의 수용 기준 2는 화면을 캡처해 확인하지 못한 CLI와 질문을 분류기에 넣지 않는다고 정하고 있어, 캡처하지 못한 명령 승인과 업데이트 안내를 분류기가 알아보지 못하는 현재 상태는 그 기준과 어긋나지 않습니다.

### 호출자 식별의 한계

supervisor-path의 accept 기준서에서 "호출자 식별이 ORCA_TERMINAL_HANDLE에만 의존한다는 한계는 문서에 적혔다"고 기록했습니다. prompt-answer 명령은 호출자가 Run 바인딩 PM이거나 그 역할을 시작한 PL인지 확인하지만, 환경변수 기반 확인만 사용 가능한 제약이 있습니다.
