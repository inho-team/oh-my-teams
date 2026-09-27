# 주도적 역할 운영 설계 (Revision 1)

## 1. 역할별 현행 권한과 실행 근거

실제 구현과 제안 계약을 구분하여, OMT 역할의 권한과 런타임 근거를 기술합니다.

- **director**: `plugins/oh-my-teams/skills/director/SKILL.md`에 권한 정의. `scripts/teams-org.mjs`의 `directorRequest`는 런타임 시작 인자 생성 기능일 뿐 결정 실행이 아닙니다. 실제 결정과 종료 권한은 사용자와의 목표/수용 기준 확정, PM의 결정 요청에 대한 `director-reply` 또는 `director-watch`에 의한 직접 결정, `resource-acquire`/`release` 슬롯 획득/해제, `delivery.mjs`와 `close`/`disband`를 통한 주인 브랜치 병합에 있습니다.
- **pm**: `plugins/oh-my-teams/skills/pm/SKILL.md`에 권한 정의. `scripts/workflow.mjs` 600~606행을 통해 워크플로 상태를 계산하고 `reserveExecution`, `workflow-start`를 주도합니다. `scripts/gates.mjs` 436~448행(`acceptOutcome`)을 통해 PM 전용으로 최종 수용 여부를 결정합니다.
- **pl**: `plugins/oh-my-teams/skills/pl/SKILL.md`의 권한·한계 절에 따라 분할, 통합, 검증, PM 보고 및 조건부 하위 worker 감독을 수행합니다. PL은 직접 `worker-start`를 호출하거나 산출물을 스스로 승인할 수 없습니다.
- **senior**: `plugins/oh-my-teams/skills/senior/SKILL.md`에 권한 정의. `scripts/gates.mjs` 378~387행(`recordReview`)을 호출하여 독립 검토를 기록합니다. 직접 작성한 산출물을 자기 승인할 수 없으며, 독립 검토자는 구현자(worker)와 달라야 합니다.
- **junior**: `plugins/oh-my-teams/skills/junior/SKILL.md`에 권한 정의. 주어진 범위 내에서 파일 편집 하네스와 테스트를 구현합니다. `verify`를 수행해 수용 기준을 대조하며, 결과를 포함하여 `worker_done`을 보고해야 합니다. 임의로 작업 계약 범위를 변경하거나 다른 작업자에게 재위임할 수 없습니다.
- **auditor**: 조직 파일(revision 16)에 선언되지 않은 제안 역할이며 현행 실행 역할이 아닙니다. 계획상 현행 계약의 논거 없는 수용 차단 기능을 담당하게 되지만, 현재 런타임에는 이 역할에 부여된 실제 전이와 권한 함수가 없음을 명시합니다.

## 2. 객체 소유와 상태 전이 경계

OMT가 Orca의 소유 객체를 새로 관리하거나 생명주기를 복제하지 않도록 경계를 보존합니다. Orca 소유 전이와 OMT 기록 전이를 분리합니다. 근거: `scripts/workflow.mjs` 600~606행(상태 계산), 863~924행(dispatch-ready/reconcile), 1407~1432행(releaseReservation), `references/orca-runtime.md` 3행.

| 객체 | 소유자 | 정본 및 조회/정산 경로 | 생성 전이 | 종료 및 보존 조건 |
|---|---|---|---|---|
| **Goal** (Orca) | Orca | Orca DB | Orca가 관리 | OMT가 복제하지 않음. Orca 종료에 따름 |
| **Run** (Orca) | Orca | Orca DB | Orca가 관리 | OMT는 바인딩만 수행 |
| **Orca Task / Dispatch** (Orca) | Orca | Orca DB (`orca dispatch list`) | Orca가 생성 및 전이 | Orca가 전이 관리. OMT는 `reconcile`을 통해 상태 관측 |
| **worker** (Orca) | Orca | Orca DB (`orca worker-show`) | Orca가 생성 | OMT는 시작/종료를 기록하며 직접 소유하지 않음 |
| **organization** | director | `.omt/organization.json` | kickoff 전 director가 확정 | kickoff 내 불변 유지 보존 |
| **brief** | director | `.omt/briefs/[id].md` | kickoff 전 director가 확정 | kickoff 내 불변 유지 보존 |
| **kickoff registry** | director | `.omt/kickoffs/[id].json` | director가 `kickoff-show`로 등록 | `kickoff-release`, `kickoff-check-close-ready` 등 director 주도로 종료 및 보존 |
| **workflow** | pm | `.omt/workflows/[id]/` | `createWorkflow`로 PM이 시작 | `accepted`, `blocked`, `completed` 상태 도달 시 보존 |
| **OMT task 계약·상태** | pm | `.omt/workflows/[id]/tasks/[id]/` | workflow 시작 시 생성 | `state.json` 업데이트로 보존 |
| **resource slot** | 이사/PM | `.omt/resources/[slot].json` | PM/director가 `resource-acquire`로 획득 | 완료 후 지연 회수 또는 `resource-release`로 해제/삭제 |
| **evidence (검증)** | 담당 역할 | `.omt/evidence/` | `verify` 성공/실패 시 생성 | 파일로 영구 보존 |
| **review (검토)** / **gate** | senior/pm | `.omt/reviews/`, `.omt/gates/` | senior의 `recordReview` | pm의 `acceptOutcome` 수용 시 보존 |
| **audit·objection** | 제안 auditor | (추후 구현) | (추후 구현) | 이의 해소 시 보존 |
| **.omt docs** | 작성 역할 | 작업 워크트리 내 `docs/` | 각 문서 작업 task | PR 병합 전까지 보존 |
| **최종 delivery** | director | 워크트리 / 원격 리포지토리 | director의 `close`/`disband` 수행 | main 병합을 통해 최종 보존 |

## 3. 역할별 상태, 판단 근거, 보고 대상 및 권한

현행 5개 역할에 대한 모든 사건을 분리하고 다음 행동과 증거를 대조합니다. 근거: `skills/pl/SKILL.md` 전체, `skills/director/SKILL.md` 전체, `references/autonomy.md` 27~37행, `scripts/workflow.mjs` 1407~1432, 1531~1625, 1650~, `scripts/gates.mjs` 436~448.

| 역할 | 사건 | 판단 근거 및 조건 | 허용된 다음 행동(담당자) | 완료 증거 | 상위 보고 |
|---|---|---|---|---|---|
| **director** | 시작 | 브리프 확정 | PM 세션 생성 (`kickoff-show` 등록) | registry 파일 | 사용자 |
| **director** | 배정/재작업/정체/오류 | (업무 배정/worker-start는 PM 권한) | 진행 불가 (직접 task 배정 불가) | - | - |
| **director** | 사용자 결정 대기 | PM의 4경계 에스컬레이션 수신 (`decision`) | 신호 분류. 경계 내면 `director-reply` 직접 결정, 경계 외 사용자 질문 | 분류 및 reply 기록 | 사용자 |
| **director** | 검증/close | PR 병합 대기 | `kickoff-check-close-ready`, `close`, `disband`로 병합 수행 | main 병합 기록 | 사용자 |
| **pm** | 배정 | 목표 분할 | task 생성 및 `reserveExecution` / `worker-start` | worker 실행 기록 | director |
| **pm** | 반려 (재작업) | `changes-requested` 수신 | 동일 attempt로 `workflow-rework` 실행 (scripts/workflow.mjs 1531~) | 재작업 event | director |
| **pm** | 오류 (재시도) | `failed` 상태 수신 | 예산/주체 지정하여 `workflow-retry` 실행 (scripts/workflow.mjs 1650~) | retry attempt | director |
| **pm** | 정체 (reserve) | launch가 worker를 생성 못함 | 특정 refusal 계약 및 외부 launch 해소 증거를 바탕으로 `releaseReservation` (1407~) | release 증거/attempt 보존 | director |
| **pm** | 독립 작업 | 사용자 대기 중 | 대기 상태 유지 및 다른 workflow 진행 | 다른 workflow 기록 | director |
| **pm** | 검증 (close) | gate 통과 / review approved | `acceptOutcome` (scripts/gates.mjs 436~) 실행으로 최종 승인 | gate 승인 증거 | director |
| **pl** | 배정 (깊이 1) | 중첩 worker 배정 요청 | worker-start 거부 후 분할 계획 반환 | 평평한 배정 | pm |
| **pl** | 배정 (깊이 2+) | 깊이 2 이상 허용 시 | Run 바인딩, `terminal-idle-check`, `worker-start` | 하위 감독 기록 | pm |
| **pl** | 반려/재작업 | 통합 충돌/반려 수신 | 직접 충돌 수정 금지, 당사자 반환/새 파동 제안 | 수정 계획 | pm |
| **pl** | 검증 | 하위 task 완료 | 의미 검증을 senior에게 이관 | 의미 검증 결과 (자기 accept 불가) | pm |
| **senior** | 배정/독립작업 | 설계/검토/구현 task | 인터페이스 설계, 독립 검토, 구현 진행 | 설계/검토 파일 | 상위 역할 |
| **senior** | 재작업/오류 | 반려/오류/의존성 대기 | 허용 예산 내 자체 대안 탐색. 실패 시 거부 증거 캡처 후 상향 | 수정 완료 또는 실패 보고 | 상위 역할 |
| **senior** | 검증/close | 제출 전 자체 검증 | 수용 기준 대조 및 `verify` 실행. (자신이 작성한 코드 직접 독립 승인 불가) | 실패 누락 없는 `worker_done` | 상위 역할 |
| **junior** | 배정 | 범위 내 로직 구현 | 파일 허용 범위 및 수용 기준 확인 후 구현/테스트 추가 | 파일 수정 및 테스트 | 상위 역할 |
| **junior** | 재작업/정체/오류 | 실패/반려 | 범위 임의 변경 금지, 재위임 금지. 로그 확보 후 상향 보고 | 상향 보고 | 상위 역할 |
| **junior** | 검증/close | 구현 완료 | 필수 `verify` 실행 후 검사 결과와 미해결 사항 포함하여 보고 (자기 승인 금지) | verify 통과 및 `worker_done` | 상위 역할 |

## 4. 사용자 확인 경계와 자율성 보존

`references/autonomy.md`의 네 가지 경계(11~14행)와 지속성 규약(27~37행)을 정확히 적용합니다.

### 4.1. 네 가지 확인 경계
1. **계약 변경**: 목표, 수용 기준, 주 버전 변경 및 **비목표**(non-goals) 침범
2. **새 범위 추가**: 브리프에 없는 명백히 새로운 범위 (다음 kickoff 분리 제안 대상)
3. **되돌릴 수 없는 외부 영향**: 외부 메일 발송, 원격 저장소 push, 체크아웃 밖의 중요 데이터 삭제, 사용자 설정 변경, **배포(deployment)**, **새 과금 계정 및 구독 추가**
4. **사용자만 아는 암묵지**: 시스템 기록으로 확인할 수 없는 결정, 팀 내 일정 등

### 4.2. 적용 주체와 롤백, 독립 작업의 지속
- **에스컬레이션 주체(35~37행)**: 위 네 경계에 해당하는 의문은 **PM**이 `director-signal --kind decision`으로 올리고, **director**가 이를 재분류합니다.
- **롤백 보고**: PM과 이사가 자율적으로 결정한 사항은 해당 결정 근거와, 잘못되었을 때 즉시 되돌릴 수 있는 방법(rollback)을 명시하여 보고합니다.
- **독립 작업 계속과 blocked(27~33행)**: 사용자의 확인을 대기하는 중에도 하위 역할은 다른 독립 작업을 무조건 중단하지 않고 계속 진행합니다. 모든 병렬 가능한 작업이 막히고 더 이상 진행할 수 없는 상태에 이르렀을 때만 명시적으로 `blocked` 상태로 전이합니다.

## 5. 하위 역할의 주도적 행동 규약 (Operational Proactivity)

하위 역할과 미래 auditor의 주도성 한계와 증거를 분리하여 운영 표로 정의합니다.

| 역할 | 사건 | 범위 내 행동 | 중단/상향 에스컬레이션 조건 | 금지 사항 | 완료/보고 증거 |
|---|---|---|---|---|---|
| **pl** | 하위 worker 시작 | 깊이 2 이상 허용 시 감독 | 분할이 명확하지 않은 깊이 1 배정 | `worker-start` 거부, `acceptOutcome` 금지, 직접 병합 금지 | 하위 worker 감독 일지 |
| **senior** | 독립 검토/구현 | 리뷰 진행, finding 지속, 구현 및 테스트 | 찾은 결함이 예산 내 해결 불가 시 | 자기 산출물 독립 검토 승인, 지시문 대필 금지 | `review-record` (finding 목록), `verify` |
| **junior** | 구현 작업 | 허용 범위 내 코드/테스트 작성 | 반복된 테스트 실패, 의존성 충돌 | 범위 변경 금지, 재위임 금지, 자기 승인 금지 | `verify` 결과, 수용 기준 대조표를 포함한 `worker_done` |
| **auditor** | 독립 검토 | (추후 구현) 현행 역할 아님 | (추후 구현) 논거 없는 수용 감지 시 반려 | 근거 없는 맹목적 수용, 권한 밖 PR 병합, 자기 승인 금지 | 리뷰 시 명확한 반례와 재현 경로 (추후 구현) |

## 6. 다른 kickoff의 관측 사실 해석 및 정정

네 kickoff의 관측 사례를 대조하여 절대 원천, 레코드 시각, 식별자, 원문 관측과 추론을 분리합니다.

| 사례 | 원천 (절대 경로) | 시각 / 객체 ID | 원문 관측 (Observation) | 원인 추론 (Inference) | 새 대응 (다음 행동) |
|---|---|---|---|---|---|
| **tui-idle 거부** (adaptive-staffing-wave1) | `/Users/jinsungkim/orca/workspaces/oh-my-teams/feat-adaptive-team-staffing/.omt/workflows/adaptive-staffing-wave1/events/000003-attach-design-approved-1.json` | 2026-09-27T13:56:10.295Z / `ctx_8f73f360dc76` | `timeout`: Terminal term_45a4c0de... did not report tui-idle within 20000ms. No Dispatch was created. | TUI가 유휴 상태에 도달하지 않아 자동 거부됨 | 단순 timeout 재시작을 금지하고 안전한 상향 에스컬레이션 |
| **already-started 중복** (dynamic-model-catalogs) | `/Users/jinsungkim/orca/workspaces/oh-my-teams/feat-dynamic-model-catalogs/.omt/plan/w1-rereview-start.json` | 미기록 / `ctx_8c3ced949826` | `outcome: already-started`, `reason: task-id-in-transcript` | 새 Dispatch가 생성된 것이 아니라 기존 task ID를 가진 단말에 재진입함 | 재진입을 확인하고 불필요한 새 Dispatch 억제 |
| **독립 검토 지연** (adaptive-staffing-wave1) | `/Users/jinsungkim/orca/workspaces/oh-my-teams/feat-adaptive-team-staffing/.omt/workflows/adaptive-staffing-wave1/events/000004-settle-design-dispatch-1.json` | 2026-09-27T14:00:26.754Z / `ctx_8f73f360dc76` | `documentRevision: missing`, `followup: independent review... required` | 세션 유실이 아닌, 단순 후속 검토 대기 중 | 유실로 임의 추정하여 진행 상태를 만들지 않고 대기 보존 |
| **stalled Goal 오판** (139-auditor) | `/Users/jinsungkim/orca/workspaces/oh-my-teams/feat-139-auditor/.omt/supervision/obs.json` | 2026-09-27T13:27:10Z / (미기록) | `lastActivityAt` == `now` == 2026-09-27T13:27:10Z | 실제 멈춤이 아닌 OMT 내부 타이머의 추정 오류 | OMT 단독 타이머로 stalled를 추정하지 않고 Orca 신호 신뢰 |
| **열린 finding 차단** (structured-omt-documents) | `/Users/jinsungkim/orca/workspaces/oh-my-teams/feat-structured-omt-documents/.omt/gates/omt-docs-design.json` | (미기록) / `ctx_e94a6ebd59df` | `review-complete: pending`, `openFindings: [document-write-reference-update-atomicity-unaddressed]` | 이전 task의 finding이 완전히 닫히지 않아 workflow 블록 | 우회 방안이나 명시적 에스컬레이션을 모색하여 무한 대기 방지 |

## 7. 복구 및 권한 있는 관측(Authoritative Reconciliation) 규약

- **조회 명령**: PM은 실제 discovery된 CLI 명령인 `orca run-show`, `orca dispatch-show`, `orca worker-show`, `orca worker-list`를 이용해 정본을 수집합니다. (`run show`, `dispatch list` 등 가짜 명령 금지)
- **수집 및 우선순위**: Orca 상태를 OMT 내부 상태보다 우선 신뢰합니다. Task ID, document revision, receipt/event ID 대조를 수행합니다.
- **reconcile-required (scripts/workflow.mjs 863~924행)**: `reconcile-required` 관측 시, running attempt에 대해 임의로 종료나 라이브 상태로 추정하지 않고 새 Dispatch 생성을 금지합니다. 안전하게 상향 에스컬레이션하여 충돌을 해소하는 것을 최우선 행동으로 강제합니다. (이벤트 기록: 1044~1054행)

## 8. 변경 지점 및 호환/이전 전략

OMT에 새루프/타이머/감독기를 제안하지 않고, 후속 구현 계획으로 런타임 수정을 제안합니다. (근거: scripts/workflow.mjs 1407~1432, 1531~1625, 1650~, 1968~2024, references/orca-runtime.md 3행)

| 현행 상태 | 호환 입력 모듈 | 전이 담당자 | 실패 보존 및 마이그레이션 순서 | 공유 슬롯 (shared slot) 획득/해제 |
|---|---|---|---|---|
| workflow attempt | `workflow.mjs` (reserve/rework/retry) | pm | 기존 `.omt/workflows/` JSON 및 attempt 보존. 실패 시 에스컬레이션 | 워크플로 내부 예약이 아닌, `teams-org.mjs`의 독립 `resource-acquire`/`release`를 이사/PM이 전역 획득/해제 (unknown 시 보존) |
| review/gate 기록 | `gates.mjs` | senior/pm | 리뷰/게이트 JSON 포맷 유지. finding 목록 보존 | (슬롯과 무관) |

## 9. 반증 시나리오와 수용 테스트

실제 현행 검사와 제안(actual vs proposed)을 구분하여 실행 가능한 절차로 작성합니다.

| 분류 | 시나리오 및 기능 | 입력 / 명령 / fixture | 기대 관측 / 실패 기준 | 증거 / 평가 |
|---|---|---|---|---|
| actual | 증거 없는 완료 선언 차단 (scripts/gates.mjs) | `validateReviewInput`에 필수 증거 문자열 없이 `acceptOutcome` 호출 | 필수 증거 누락 에러 반환. 상태 approved로 기록되면 실패 | PM의 gate-check 에러 로그 |
| actual | 권한 밖 에스컬레이션 차단 (director-watch) | 범위 내 판단을 `director-signal`로 전송 | 이사가 사용자에게 묻지 않고 `director-reply`로 직접 결정해야 함 | reply 기록 / watch 로그 |
| actual | 중복 Dispatch 차단 (scripts/workflow.mjs) | 미관측 running attempt 상황에서 `worker-start` 반복 호출 | 863~924행에 의해 `reconcile-required` 반환. 새 Dispatch 생성 시 실패 | workflow-start 차단 로그 |
| proposed | auditor 논거 차단 (후속 구현) | Auditor가 논거(반례) 없는 리뷰 `approved` 제출 | 이의 제기 절차 누락 감지 및 반려. 맹목적 승인 시 실패 | 수용 테스트 / eval로 추가 |
| proposed | 한국어 위반 평가 (후속 구현) | 불완전한 한국어로 최종 보고서 제출 | 외부 보고 전 위반 정정 및 반려. 정정 없이 발송 시 실패 | 최종 보고서 diff / eval 테스트 |

## 10. 산출물 제출 및 재검토 수용 상태

이 문서는 목표 브리프가 요청한 최종 산출물 **Revision 1**입니다.

- **작성자 및 실제 HEAD**: 작성자는 **senior**, 독립 검토자는 **pl**(`proactive-pl-final-review-1` execution). 실제 boundary 증거로 기록된 대상 원본 최종 worktree는 `/Users/jinsungkim/orca/workspaces/oh-my-teams/docs-proactive-design`이며, 최신 HEAD는 `2b8a8763f6e924856fd158a81743f2330e5d2eb2`로 clean 상태입니다.
- **해결 미완료 및 의존성 명시**: 이 문서는 PL의 독립 검토 finding 15건을 해결한 내용을 담고 있습니다. 단, **별도 fix kickoff(`fix-opencodex-ready-timeout`)가 main에 통합된 최신 HEAD에서 sync, lint, test가 통과하기 전에는 본 문서를 통해 gate를 완화하거나 승인하지 않습니다.**
- **향후 절차**: 이 문서가 커밋된 후, 상기 필수 검사가 모두 통과되면 PM/이사의 gate check가 재실행되어 review-complete=approved를 달성할 수 있습니다.
