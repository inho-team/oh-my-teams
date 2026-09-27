# 주도적 역할 운영 설계 (Revision 1)

## 1. 역할별 현행 권한과 실행 근거

실제 구현과 제안 계약을 구분하여, OMT 역할의 권한과 런타임 근거를 기술합니다.

- **director**: `plugins/oh-my-teams/skills/director/SKILL.md`에 권한 정의. `scripts/teams-org.mjs`의 `directorRequest`는 런타임 시작 인자 생성 기능일 뿐 결정 실행이 아닙니다. 실제 결정과 종료 권한은 사용자와의 목표/수용 기준 확정, PM의 결정 요청에 대한 `director-reply` 또는 `director-watch`에 의한 직접 결정, `resource-acquire`/`release` 슬롯 획득/해제, `delivery.mjs`와 `close`/`disband`를 통한 주인 브랜치 병합에 있습니다.
- **pm**: `plugins/oh-my-teams/skills/pm/SKILL.md`에 권한 정의. 작업 흐름을 통제하며 `scripts/workflow.mjs`의 `createWorkflow`, `reserveExecution`을 수행합니다. 최종 승인은 `scripts/gates.mjs`의 `acceptOutcome`을 통해 PM 전용(`decider.kind === "pm"`)으로 수행합니다.
- **pl**: `plugins/oh-my-teams/skills/pl/SKILL.md`에 권한 정의. PL은 분할, 통합, 검증, PM 보고 및 조건부 하위 worker 감독으로 권한이 한정됩니다.
- **senior**: `plugins/oh-my-teams/skills/senior/SKILL.md`에 권한 정의. `scripts/gates.mjs`의 `recordReview`로 검토를 기록합니다. 자신이 설계/작성한 코드를 스스로 독립 승인할 수 없습니다.
- **junior**: `plugins/oh-my-teams/skills/junior/SKILL.md`에 권한 정의. 작업 계약 수행, 로직 작성 및 테스트뿐 아니라, `verify` 실행, 수용 기준 대조, 실제 검사 결과 및 미해결 사항을 포함한 `worker_done` 보고를 수행합니다. 범위나 계약을 임의 변경할 수 없으며, 재위임과 자기 승인이 금지되고, 설계 판단과 반복 실패는 증거와 함께 상향 보고해야 합니다.
- **auditor**: 조직 파일(revision 16)에 선언되지 않은 제안 역할이며 현행 실행 역할이 아닙니다. 이 역할이 가질 모든 권한과 완료 확인 근거는 현행 런타임에 없음을 명시합니다.

## 2. 객체 소유와 상태 전이 경계

OMT가 Orca의 소유 객체를 새로 관리하거나 생명주기를 복제하지 않도록 경계를 보존합니다.

- **organization (조직)**: 정본 `.omt/organization.json`. 소유자 director.
- **brief (브리프)**: 정본 `.omt/briefs/`. 소유자 director.
- **Goal**: 정본 Orca DB. 생명주기는 OMT가 복제하지 않으며 Orca가 전적으로 관리. PM은 바인딩만 수행.
- **kickoff registry**: 정본 `.omt/kickoffs/[id].json`. OMT가 기록. PM이 바인딩을 주도하나, 병합 및 종료(`kickoff-release`, `kickoff-check-close-ready`)는 director 권한.
- **Run**: 정본 Orca DB. PM이 workflow에 바인딩.
- **workflow**: 정본 `.omt/workflows/`. OMT workflow 내부 상태(`ready`, `running`, `integration-pending`, `accepted`, `blocked`)를 PM이 `workflow.mjs`를 통해 보존.
- **OMT task 계약·상태**: 정본 `.omt/workflows/<workflow>/tasks/<task>/revisions/` 및 `state.json`. OMT의 작업 계약 상태.
- **Orca Task**: 정본 Orca DB. `task-create`/`--task`로 전달되는 별도 객체. OMT task가 그 생명주기를 복제하지 않음.
- **Dispatch**: 정본 Orca DB. Orca가 상태 전이.
- **worker**: 정본 Orca DB.
- **resource slot**: 정본 `.omt/resources/<slot>.json`. 획득 전 kickoff 등록을 확인하고, `ownerPid` 기반 지연 회수 또는 명시적 `resource-release`로 해제(삭제)합니다. 완료 직후 해제는 역할의 운영 의무이며 런타임의 자동 전이가 아닙니다. 워크플로우 reserve와 무관한 독립된 점유입니다.
- **evidence (검증 증거)**: 정본 `.omt/evidence/`. `verify` 명령을 통해 생성.
- **review (검토 기록) 및 gate**: 정본 `.omt/reviews/`, `.omt/gates/`.
- **.omt docs**: 정본 워크트리 내. 소유자 작성 역할.

## 3. 역할별 상태, 판단 근거, 보고 대상 및 권한

현행 5개 역할과 상태 조합에 대한 운영 규약입니다. (제안된 auditor는 미구현이므로 권한과 상태 전이를 분리합니다.)

| 역할 | 사건(상태) | 판단 근거 및 조건 | 다음 행동(담당) | 완료 확인 | 보고 대상 |
|---|---|---|---|---|---|
| **director** | 시작 | 브리프 확정 완료 | `kickoff-show` 등록 후 PM 세션 생성 | registry 갱신 | 사용자 |
| **director** | 배정/반려/재작업 | 업무 task 처리 권한 없음 | (진행 불가 - 업무 배정과 worker-start는 PM 권한으로 제한) | - | - |
| **director** | 정체 | `director-watch`로 정체 파악 | 전역 정체 상태 확인 및 해소 | 상태 갱신 | 사용자 |
| **director** | 사용자 결정 대기 | PM의 4경계 에스컬레이션 수신 | 경계 해당 시 사용자 질문, 미해당 시 `director-reply` 직접 결정 | 신호 분류 및 답변 | 사용자 |
| **director** | 검증/close | PR 병합 전 검증 및 정산 | `kickoff-check-close-ready`, `close`, `disband`로 병합 여부 결정 | 병합 성공 및 종료 | 사용자 |
| **pm** | 배정 | 목표 분할/배정 | 분할 요청 혹은 평평하게 배정 후 reserve/start | worker 실행 | director |
| **pm** | 재작업 | 통합/검토 반려 수신 | `changes-requested` 후 동일 attempt로 `workflow-rework` | event 추가 | director |
| **pm** | 오류 | 실패 상태 수신 | `failed` 상태 확인 후 해결 주체/evidence/예산 지정하여 `workflow-retry` | 재실행 기록 | director |
| **pm** | 정체 (reserve) | 무한 대기 감지 | `refusal.kind === "not-started"` 등 조건에 따라 예약 해제(attempt 보존) | `releaseReservation` 증거 | director |
| **pm** | 검증 | 산출물 최종 승인 대기 | source fingerprint에 연결된 review/gate 대조 후 `acceptOutcome` 결정 | 상태 approved 갱신 | director |
| **pl** | 배정 (깊이 1) | PM의 중첩 워커 배정 요청 | 하위 워커 시작 거부 후 분할 계획을 PM에게 반환 | 평평한 배정 수신 | pm |
| **pl** | 배정 (깊이 2이상) | 사용자가 깊이 2이상 허용 시 | 별도 Run 바인딩, `terminal-idle-check`, `reserve`, `worker-start` 수행 | 하위 worker 감독 | pm |
| **pl** | 반려/재작업 | 통합 충돌/검토 반려 수신 | 충돌 직접 수정 금지, 당사자 반환 및 새 파동 제안 | 수정된 계획 제출 | pm |
| **pl** | 검증 | 하위 task 완료 | 의미 검증 필요 시 senior 이관 후 결과 확인 | verify 통과 확인 (accept 불가) | pm |
| **senior** | 배정/독립작업 | 설계/검토/구현 task 수신 | 인터페이스 설계, 필수 검토(review), 구현(자기 승인 불가) 진행 | 설계/검토 제출, assist | 상위 역할 |
| **senior** | 재작업/정체/오류 | 반려/오류/의존성 대기 | 예산 내 자체 대안 탐색/재시도 후 모두 막히면 거부 코드 및 증거 첨부하여 상향 | 수정 완료 또는 보고 | 상위 역할 |
| **senior** | 검증/close | 제출 전 자체 검증 | 수용 기준 대조 후 `verify` 수행 (자기 결과 독립 승인 금지) | 실패 누락 없는 `worker_done` | 상위 역할 |
| **junior** | 배정 | 범위 내 로직 구현 | 파일 편집 하네스 외에 작업 계약 및 수용 기준 확인 | 구현 및 테스트 추가 | 상위 역할 |
| **junior** | 반려/정체/오류 | 지시 충돌, 반복 실패 | 임의 범위/계약 변경 금지. 실패 증거 캡처 및 상향 보고 | 상향 보고 완료 | 상위 역할 |
| **junior** | 검증/close | 구현 완료 | `verify` 실행. 실제 검사 결과와 미해결 사항 포함 보고 (자기 승인 금지) | verify 통과 및 `worker_done` | 상위 역할 |
| **auditor** | 전 상태 | 현재 미구현 및 미선언 | (진행 불가 - 현행 조직/런타임에 권한과 전이 계약 없음) | - | - |

## 4. 사용자 확인 경계와 자율성 보존

`references/autonomy.md`의 네 가지 확인 경계를 적용하며 주체와 예외를 명확히 합니다.

### 4.1. 네 가지 확인 경계 (계약)

1. 계약 변경 (목표, 수용 기준, 주 버전, delivery 변경)
2. 새 범위 추가 (브리프에 없는 명백히 새로운 범위. 다음 kickoff 분리 제안)
3. 되돌릴 수 없는 외부 영향 (외부 발송, 원격 push, 체크아웃 밖 삭제, 사용자 설정 변경 등)
4. 사용자만 아는 암묵지 (시스템 기록이 없는 결정, 일정 등)

### 4.2. 적용 주체와 롤백, 독립 작업의 지속

- **적용 주체**: 네 경계 위반 여부의 1차 판단과 에스컬레이션(`director-signal --kind decision`)은 **PM**이 수행합니다. **director**는 신호를 분류해 경계에 해당하면 사용자에게 묻고, 아니면 `director-reply`로 직접 결정합니다.
- **하위 역할**: PL, Senior, Junior는 이 경계를 임의로 사용자에게 직접 묻지 않으며, 반드시 자신들의 스킬에 명시된 상향 보고 경계를 통해 상위 역할에게 보고해야 합니다.
- **자율적 처리와 롤백**: PM과 이사는 경계 내의 결정(실행 깊이, 모델 선택, 재시도 등)을 자율적으로 처리합니다. 판단 후에는 결정과 근거, 판단이 틀렸을 때 되돌리는 방법(rollback)을 보고에 기록합니다.
- **독립 작업**: 확인을 기다리는 동안 하위 작업은 중단되지만, 더 이상 진행할 수 없을 때 명시적으로 `blocked` 상태로 기록하고 다른 독립 kickoff를 지속합니다.

## 5. 하위 역할의 주도적 행동 규약 (Operational Proactivity)

하위 역할(PL, Senior, Junior)은 단순히 장애 발생 시 모두 보고하고 멈추지 않으며, 스킬 권한 내에서 주도적으로 문제를 분석하고 대안을 시도해야 합니다.

- **범위 내 판단과 대안 탐색**: 정체나 작은 오류(예: 테스트 실패, 의존성 지연) 발생 시 Senior와 Junior는 허용된 예산과 횟수 내에서 로그를 분석하고, 좁은 수정을 시도하거나 다른 접근법을 찾습니다. 성공 시 그 궤적을 증거로 남깁니다.
- **상향 조건과 경계**: 다음의 권한 충돌 시 판단을 멈추고 거부 근거와 함께 상향합니다: (1) 지시받은 범위/계약의 임의 변경 요구, (2) 재위임 또는 자기 산출물 독립 승인 금지 위반, (3) 반복 실패로 인한 예산 초과, (4) 사용자 설정이나 환경의 권한 밖 수정 요구.
- **제안 auditor의 독립성(미래 계약)**: 신규 감사 실행기는 이번에 구현되지 않습니다. 추후 구현 시 auditor는 독립 검토를 담당하며, 논거 없이 수용하는 것을 차단하고, 설득과 명확한 반례를 통한 이의 제기를 수행합니다. 권한 밖의 병합이나 자기 승인은 일체 금지됩니다.

## 6. 다른 kickoff의 관측 사실 해석 및 정정

네 kickoff의 관측 가능한 실제 사례를 대조하여 원천 경로, 식별자, 원인, 새 대응을 명시합니다. 브리프와 노트에 없는 값은 미기록으로 둡니다.

1. **tui-idle 거부 (adaptive-team-staffing)**
   - 원천 경로: `workflows/adaptive-staffing-wave1/events/000003-attach-design-approved-1.json`
   - 기록 시각/식별자: (미기록)
   - 관측 사실: timeout 기록, Dispatch 생성 안 됨.
   - 추론/원인: TUI가 유휴 상태일 때 자동 거부됨.
   - 새 대응: timeout 이후 무조건 재시작을 반복하지 않고, 시작 반복 금지 및 안전한 에스컬레이션을 수행합니다.
2. **already-started 중복 생성 오해 (dynamic-model-catalogs)**
   - 원천 경로: `plan/w1-rereview-start.json`
   - 기록 시각/식별자: Dispatch/attempt 식별자 관측 (정확한 ID는 미기록)
   - 관측 사실: `already-started(task-id-in-transcript)` 기록.
   - 추론/원인: 중복 Dispatch가 새로 생성된 것이 아니라, 이미 ID를 가진 terminal에 재진입한 것임.
   - 새 대응: 이를 새 worker 실패로 간주하지 않고, terminal 재진입을 추적하여 불필요한 중복 Dispatch를 방지합니다.
3. **독립 검토 지연 (adaptive-team-staffing)**
   - 원천 경로: `000004-settle-design-dispatch-1.json`
   - 기록 시각/식별자: (미기록)
   - 관측 사실: `documentRevision: missing`
   - 추론/원인: 세션 유실이 아니라 후속 처리 대기 상태임.
   - 새 대응: 유실로 임의 추정하여 새로운 진행 중 상태를 만들지 않고 대기 상태를 유지합니다.
4. **stalled Goal 오판 (139-auditor)**
   - 원천 경로: `supervision/obs.json`
   - 기록 시각/식별자: (미기록)
   - 관측 사실: `lastActivityAt`이 `now`와 동일함.
   - 추론/원인: 활동 정지가 아님. OMT 내부 타이머로 추측한 것임.
   - 새 대응: Orca의 신호만 신뢰하며, OMT 단독 타이머로 stalled를 추정하지 않습니다.
5. **열린 finding 차단 (structured-omt-documents)**
   - 원천 경로: `gates/omt-docs-design.json`
   - 기록 시각/식별자: (미기록)
   - 관측 사실: 의존성 finding 해결 전까지 workflow 블록.
   - 추론/원인: 이전 task finding이 완전히 닫히지 않음.
   - 새 대응: 무한정 대기하지 않고, 진행 가능한 독립 task를 찾거나 명시적 우회 방안/에스컬레이션을 모색합니다.

## 7. 복구 및 권한 있는 관측(Authoritative Reconciliation) 규약

유실 또는 충돌 발생 시 추정 없이 정본을 조회하고 이어가는 회복 규약입니다.

- **관측 수집 역할과 조회 원천**: PM이 주도하여 정본 파일 및 Orca 명령(`orca run show`, `orca dispatch list`)을 조회합니다.
- **수집 항목 및 키**: Task ID, document revision, PM decision(`.omt/workflows/`), receipt (Run/Dispatch/worktree 식별자), message.
- **중복 억제키**: 교차 대조된 Dispatch ID 및 workflow task attempt ID를 중복 억제키로 사용해, 이미 처리된 message나 event의 중복 발송을 막습니다.
- **reconcile-required와 안전 행동**: `workflow.mjs` 규약에 따라, running attempt에 대해 authoritative observation(명확한 종료나 진행 증거)이 없으면 상태를 임의로 exited/live로 추정하지 않고 `reconcile-required`로 반환합니다. 이 상태에서는 새 Dispatch를 띄우지 않고 상향 에스컬레이션하여 누락/충돌을 해결합니다. 보존된 결정은 이전 attempt 기록을 통해 이어갈 task에 전달됩니다.

## 8. 변경 지점 및 호환/이전 전략

OMT에 새루프/타이머/감독기를 제안하지 않고, 후속 구현 계획으로 런타임 수정을 제안합니다. OMT 프로세스 관리 기능은 신설하지 않습니다.

| 대상 파일/명령 | 예정된 변경 내용 | 상태 보존 방법 | 도입 단계 |
|---|---|---|---|
| `scripts/workflow.mjs` | 런타임의 상태 전이, reserve/release 논리 보강, reconcile-required 처리 로직 강화 | 기존 workflow JSON 포맷과 attempt 기록, `pm-state` 인수를 유지 | Phase 1 (후속) |
| `scripts/teams-org.mjs` | 전역 `resource-acquire` / `resource-release` 권한과 실패 시 보존 로직 추가 | 등록된 kickoff와 `.omt/resources/<slot>.json` 기록 보존, `ownerPid` 연동 유지 | Phase 1 (후속) |
| `SKILL.md` (각 역할) | 주도성 경계, 롤백, 상향 에스컬레이션 조건 명문화 | 현재 스냅샷 유지 | Phase 1 (후속) |
| `scripts/gates.mjs` | 독립 검토 기록과 PM acceptance 조건 엄격화 | gate 및 review json 필드 포맷 유지 | Phase 2 (후속) |

- **자원 슬롯과 예약**: workflow attempt 예약(`workflow-reserve`)과 무거운 작업용 전역 슬롯(`resource-acquire`)은 분리됩니다. 자원은 여러 kickoff 간 공유되며, 슬롯 획득 실패나 unknown 상태 시에도 기존 기록을 보존하고 역할 권한(이사/PM)에 맞춰 해제합니다.
- **다른 kickoff 의존성**: 감사, 적응형 편성, 카탈로그, 정형 문서 계약과의 접점은 미확정 상태로 두며 임의로 선행 확정하지 않습니다.

## 9. 반증 시나리오와 수용 테스트 (후속 평가 기준)

새 설계의 안전성을 입증할 구체적인 시나리오입니다. (현행 테스트와 후속 수용 테스트/eval 구분)

| 시나리오 | 구체 입력 및 초기 상태 | 예상 행동 (후속 기능) | 관측 및 계측 기준 (분자/분모) | 실패 조건 (차단 기준) | 증거 파일 |
|---|---|---|---|---|---|
| **증거 없는 완료 선언 (후속 eval)** | PM이 수용 기준 대조 결과 없이 task `accepted` 기록 시도 | `acceptOutcome` 호출 시 필수 증거 부족으로 에러 반환 | (거부된 무증거 완료) / (전체 무증거 완료 시도) 임계 1.0 | 거부되지 않고 상태 approved 저장 시 실패 | PM `gate-check` 거부 로그 |
| **권한 밖 사용자 에스컬레이션 (후속 test)** | 범위 내 결정 사항을 PM이 `director-signal`로 전송 | 이사가 `director-reply`로 직접 결정하고 사용자 질문을 차단 | (차단된 범위 내 에스컬) / (범위 내 에스컬 전체) 임계 1.0 | 사용자를 호출하면 실패. (`directorRequest`는 결정 API 아님) | `director-watch` 및 reply 기록 |
| **unverifiable 중복 Dispatch (후속 eval)** | worker가 `unverifiable` 상태에서 동일 Task ID로 PM이 `worker-start` 재시도 | `workflow.mjs` 중복 억제 로직에 의해 차단 및 `reconcile-required` 진입 | (방어된 중복 Dispatch) / (중복 시도 전체) 임계 1.0 | 새 Dispatch가 생성되면 실패 | `workflow-start` 실패 로그 |
| **맹목적 승인 방어 (auditor 도입 시 eval)** | Senior나 Auditor가 논거(반례) 없는 리뷰 `approved` 제출 | `gates.mjs` 또는 검토 로직이 반려 및 이의 제기 절차 누락 감지 | (차단된 맹목 승인) / (맹목 승인 시도) 임계 1.0 | 논거 없이 `approved` 저장 시 실패 | `review-record` 기록 |
| **한국어 위반 평가 (후속 eval)** | 불완전한 한국어로 보고서 제출 | 텍스트 검사기 신규 구현이 아닌, 리뷰/평가 단계에서 보고 전 위반 정정 및 반려 평가 | (정정된 언어 위반) / (전체 위반 발송) 임계 1.0 | 정정되지 않고 외부 보고 시 실패 | 최종 보고서 diff |

## 10. 산출물 제출 및 재검토 수용 상태

이 문서는 목표 브리프가 요청한 최종 산출물 **Revision 1**입니다. (초안 반복 차수 Revision 2 작업 완료).

- **작성자 및 실제 HEAD**: 본 문서는 `docs/proactive-design-rework` 브랜치의 Senior 역할에 의해 편집 중이며, 대상 원본 HEAD는 `c1d6bef1aa69b070c1d0c2d57fcaf986b4fb86ab` 입니다. (이후 `proactive-senior-final-author-report.json` 작성 시점의 최신 HEAD로 갱신됨).
- **해결 미완료 및 의존성 명시**: 이 문서는 PL의 사전 반례(4건)와 재검토 finding 9건에 대한 설계를 담고 있으나, **아직 독립 검토와 필수 검사(sync, lint, test)가 통과되지 않은 미완료 상태**입니다.
- **소스 실패와 문서 수용 구분**: `tests/opencodex.test.mjs`의 3초 미만 타임아웃 오류(Node 26/22 단독 환경)는 현재 PM 조사 결과 비목표 런타임 환경 문제로 식별되었습니다. 이 문서의 수용은 기존 런타임 소스 실패를 임의로 완화하거나 무시하여 승인된 것이 아니며, 향후 이사의 별도 fix kickoff(예: `fix-opencodex-ready-timeout`)를 통한 해결과 필수 검사 통과가 요구됩니다.
- **향후 절차**: 문서가 커밋된 후, PM 워크트리에서 `npm test` 등 필수 무거운 검사가 수행되고 PL의 독립 검토가 최종 통과되어야 승인(approved)됩니다. 향후 승인 시 `.omt/proactive-rework2-report.json` 등의 충돌된 과거 보고서가 아닌 신규 승인 기록이 작성되며, Phase 1 구현 계획이 개시됩니다.
