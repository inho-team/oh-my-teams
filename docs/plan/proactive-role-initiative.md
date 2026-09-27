# 주도적 역할 운영 설계 (Revision 2)

## 1. 역할별 현행 권한과 실행 근거

실제 구현과 제안 계약을 구분하여, OMT 역할의 권한과 런타임 근거를 기술합니다.

- **director**: `plugins/oh-my-teams/skills/director/SKILL.md`에 정의. `plugins/oh-my-teams/scripts/teams-org.mjs`의 `directorRequest`(2134줄)로 결정을 내림. 런타임 테스트는 `tests/director-role.test.mjs`, `tests/director-signal.test.mjs`.
- **pm**: `plugins/oh-my-teams/skills/pm/SKILL.md`에 정의. `plugins/oh-my-teams/scripts/workflow.mjs`의 `createWorkflow`(262줄), `reserveExecution`(1011줄)로 작업 흐름을 통제. 테스트는 `tests/workflow-runtime-gaps.test.mjs`.
- **pl**: `plugins/oh-my-teams/skills/pl/SKILL.md`에 정의. `plugins/oh-my-teams/scripts/workflow.mjs`의 `handoffTask`(1857줄) 등을 사용. `scripts/core.mjs`의 `depthRoles`(108줄)에 따라 중첩 worker 기본 깊이 1 제한을 준수. 테스트는 `tests/role-dispatch.test.mjs`.
- **senior**: `plugins/oh-my-teams/skills/senior/SKILL.md`에 정의. `plugins/oh-my-teams/scripts/gates.mjs`의 `recordReview`(378줄), `acceptOutcome`(436줄)을 통해 검토와 승인을 기록. 자신이 설계/작성한 코드를 스스로 승인할 수 없음. 테스트는 `tests/safety-net.test.mjs`, `tests/advise.test.mjs`.
- **junior**: `plugins/oh-my-teams/skills/junior/SKILL.md`에 정의. 배정 파일 내 로직 작성 및 단위 테스트. 범위 변경 불가. 테스트는 `tests/legacy-intern.test.mjs`.
- **auditor**: 조직 파일(revision 16)에 선언되지 않은 제안 역할. 이슈 `#139` 브리프에 따라 독립 검증을 기획 중. **미구현 경계 명시:** 현행 런타임에는 auditor의 무논거 승인 차단기나 스킬이 구현되어 있지 않으므로, 이를 기설정된 런타임 차단기로 서술하지 않습니다.

## 2. 객체 소유와 상태 전이 경계

OMT가 Orca의 소유 객체를 새로 관리하거나 중복 구현하지 않도록 경계를 보존합니다.

- **organization (조직)**: 정본 `.omt/organization.json`. director가 생성/갱신. (worker의 `resource-acquire`는 자원 슬롯 상태만 갱신).
- **brief (브리프)**: 정본 `.omt/briefs/`. director가 작성/확정. PM은 읽기 전용.
- **Goal**: Orca 소유 객체. PM은 읽고 진행 상태를 추적할 뿐 새 상태를 관리하지 않음.
- **kickoff registry**: 정본 `.omt/kickoffs/`. PM이 kickoff 상태 전이(시작, 정산, 회수) 주체.
- **Run**: Orca 소유 객체. PM이 `workflow.mjs`에 바인딩하여 사용.
- **workflow**: 정본 `.omt/workflows/`. PM이 생성 및 전이(pending -> active -> settled).
- **Task**: Orca 소유 객체. PL/PM이 worker-start로 배정(unassigned -> active -> terminal).
- **Dispatch**: Orca 소유 객체. 전이 주체는 Orca.
- **worker**: Orca 소유 객체.
- **resource slot**: `scripts/teams-org.mjs` 기반 전역 관리. 무거운 작업 전 worker가 `resource-acquire`로 획득, 완료 후 `resource-release`로 해제.
- **evidence (검증 증거)**: 정본 `.omt/evidence/`. Senior/PL이 기록. 전이: open -> approved / changes-requested.
- **audit/objection**: auditor가 추후 생성할 객체 (현재 미구현).
- **.omt docs (설계/계획 문서)**: 담당 역할이 수정 및 갱신. 전이: draft -> review -> approved.
- **delivery**: 이사가 `scripts/delivery.mjs`로 최종 확인 후 병합(ready -> delivered). 무권한 역할의 병합 금지.

## 3. 역할별 상태, 판단 근거, 보고 대상 및 권한

여섯 역할에 대해 각각 시작, 배정, 반려, 재작업, 정체, 오류, 사용자 결정 대기 중 독립 작업, 검증, close 시의 다음 행동과 보고 대상/권한을 명시합니다. 해당하지 않는 사건은 권한 없음으로 둡니다.

| 역할 | 사건(상태) | 판단 근거 및 조건 | 다음 행동 | 보고 대상 / 권한 |
| --- | --- | --- | --- | --- |
| **director** | 시작 | 브리프 확정 완료 | PM에게 kickoff 할당 | 사용자(선택) / 할당 권한 |
| **director** | 사용자 결정 대기 | PM의 `director-signal` 에스컬레이션 수신 | 4가지 경계 대조 후 결정 또는 질문 | 사용자 / 질문 권한 |
| **director** | close | 모든 workflow 정산 및 배포 준비 완료 | `delivery` 명령으로 `main` 병합 | OMT 시스템 / 병합 권한 |
| **pm** | 시작 / 배정 | 목표 수신 | workflow 생성, `workflow-reserve` 예약, `worker-start` | 이사 / workflow 관리 권한 |
| **pm** | 반려 / 재작업 | `verify` 실패 또는 검토 반려 | 실패 원인 파악 및 `rework` 파동 재설정 | pl, senior / 재작업 지시 권한 |
| **pm** | 정체 / 오류 | 진행 정체, `workflow-reserve` 거부 | 무한 대기 중단, 에스컬레이션 또는 우회 배정 | 이사 / 우회 배정 권한 |
| **pm** | 사용자 결정 대기 | 사용자 결정 필요 상황 | 직접 질문 금지. 이사에게 `director-signal` 전송 | 이사 / 에스컬레이션 권한 |
| **pl** | 배정 | PM으로부터 Task 수신 | 작업 분할, 중첩 깊이 1 제한 내 worker 배정 | 하위 역할 / 배정 권한 |
| **pl** | 반려 / 재작업 | 하위 산출물 결함 | 충돌 직접 수정 금지. 하위 역할에게 반환 | 하위 역할 / 반려 권한 |
| **pl** | 검증 / close | 하위 작업 `worker_done` 수신 | `verify` / `merge-check` 후 취합 보고 | pm / 취합 보고 권한 |
| **senior** | 시작 / 배정 | PL 지시 수신 | 인터페이스, 변경 순서, 실패 조건 등 설계 작성 | pl / 설계 권한 |
| **senior** | 독립 작업(대기) | 결정 대기, 의존성 대기 | 직접 구현(미배정 시) 금지. `assist`로 대안 탐색 | pl / 대안 탐색 권한 |
| **senior** | 반려 / 오류 | 반복 오류, 정체 | 작업 자체 축소 금지. 증거/거부 코드 첨부 보고 | pl / 에스컬레이션 권한 |
| **senior** | 검증 | 배정 구현 Task 완료 전 | 수용 기준 대조 및 `verify`. 자기 산출물 독립 승인 금지 | pl / 완료 보고 권한 |
| **junior** | 배정 | 구현 지시 수신 | 파일 편집 및 단위 테스트 실행 | senior, pl / 파일 편집 권한 |
| **junior** | 반려 / 오류 | 범위 초과, 지시 충돌 | 범위 변경 금지. 거부 증거 상향 보고 | senior, pl / 에스컬레이션 권한 |
| **auditor** | 검증 (향후) | 런타임 산출물 제출 | 논거 없는 맹목 수용 금지. 명확한 반례 제시 | pl, pm / 이의 제기 권한 |

## 4. 사용자 확인 경계와 자율성 보존

`references/autonomy.md`의 네 가지 확인 경계를 유지하며, 범위 안 판단을 상위로 떠넘기는 것을 막습니다.

1. **계약 변경**: 주 버전 변경, 비목표 달성 요구, `delivery` 방식 변경.
2. **새 범위 추가**: 당초 목표와 브리프를 명백히 벗어나는 기능 추가.
3. **되돌릴 수 없는 외부 영향**: 결제 승인, 새 계정 생성, 외부 API 영구 전송.
4. **사용자만 아는 사실**: 시스템 상태로 추론할 수 없는 암묵지(비밀번호 등).

경계에 해당하는 경우에만 이사(또는 이사를 통해 사용자)에게 질문합니다. 범위 안의 결정은 주도적으로 처리하며, 반드시 `decision` 및 `rollback`(되돌리는 방법)을 문서에 기록하여 무분별한 상향을 막습니다.

## 5. 하위 역할의 주도적 행동 규약

상태, 행동, 근거, 보고로 구체화된 주도적 행동 규약입니다. 자기 승인, 무근거 승인, 사용자 직접 질문, 권한 없는 병합을 금지합니다.

- **pl**: 통합 충돌(상태) 발생 시, 이를 직접 고쳐 쓰지 않고(행동), 충돌 diff(근거)를 담아 담당자에게 반려(보고)합니다.
- **senior**: 설계/구현 중 장애물(상태)을 만나면, 독단적으로 목표를 줄이지 않고(행동), 오류 로그(근거)를 담아 상향(보고)합니다. 본인 코드를 `review-record`로 자체 승인하지 않습니다.
- **junior**: 지시 충돌(상태) 시, 억지 구현을 멈추고(행동), 충돌 파일과 지시(근거)를 상향(보고)합니다.
- **auditor**(제안): 검증 대기(상태) 시, 논거 없이 수용하지 않고(행동), 명확한 반례(근거)로 이의 제기(보고)합니다.

## 6. 다른 kickoff의 관측 사실 해석 및 정정

다른 kickoff는 읽기 전용으로 조사하며, 다음과 같이 오해를 정정합니다.

1. **tui-idle 거부 (adaptive-team-staffing)**
   - 관측: `workflows/adaptive-staffing-wave1/events/000003-attach-design-approved-1.json` (timestamp, file path, event 확인). timeout으로 "no Dispatch was created" 기록.
   - 정정: timeout 직후 무조건 fallback/재할당하는 것은 안전하지 않으며, 시작 반복 금지 및 상향 보고를 통해 안전하게 대응해야 합니다.
2. **already-started 중복 생성 오해 (dynamic-model-catalogs)**
   - 관측: `plan/w1-rereview-start.json` (attempt/Dispatch 식별자 확인). `already-started(task-id-in-transcript)` 기록.
   - 정정: 이는 이미 Dispatch ID를 가진 terminal에 재진입한 관측일 뿐, 중복 Dispatch가 새로 생성되었다는 증거가 아닙니다.
3. **독립 검토 지연 (adaptive-team-staffing)**
   - 관측: `000004-settle-design-dispatch-1.json`. `documentRevision: missing`.
   - 정정: 세션 유실이 아니라 후속 처리 대기 상태입니다. 임의 추정을 금지합니다.
4. **stalled 오판 (139-auditor)**
   - 관측: `supervision/obs.json`. `lastActivityAt`이 `now`와 동일.
   - 정정: 활동 정지가 아닙니다. OMT 내부 타이머로 추측성 감독을 수행하지 않고 Orca 신호만을 신뢰합니다.
5. **열린 finding 차단 (structured-omt-documents)**
   - 관측: `gates/omt-docs-design.json`. 의존성 finding 해결 전까지 블록.
   - 정정: 무한정 수동 대기하지 않고 즉시 우회 방안이나 에스컬레이션을 모색해야 합니다.

## 7. 복구 및 권한 있는 관측(Authoritative Reconciliation) 규약

유실 또는 충돌 발생 시 고정된 복구 순서입니다. unknown을 live/exited로 임의 추정하지 않습니다.

- **원천 및 순서**: 시스템 재개 시 PM이 주도하여 1) ID, 2) revision, 3) decision, 4) receipt, 5) attempt, 6) message 순으로 관측 원천을 수집합니다.
- **중복 제거**: 5가지 receipt (Run, Task, Dispatch, Execution, worktree) ID를 교차 대조하여 중복 메시지를 제거합니다.
- **reconcile-required**: `scripts/workflow.mjs` 규약에 따라 authoritative observation이 없는 running attempt는 `reconcile-required` 상태로 남깁니다. 충돌 시 새 Dispatch를 생성하지 않고 상향 에스컬레이션합니다.

## 8. 변경 지점 및 호환/이전 전략

OMT에 새루프/타이머/감독기를 제안하지 않고 현행 런타임을 변경합니다.

- **변경 지점**: `scripts/workflow.mjs`(상태 전이 및 권한 확인), `scripts/teams-org.mjs`(자원 점유 명령), 해당 스킬(`SKILL.md`), 관련 테스트 파일.
- **자원 슬롯의 목적과 순서**:
  - `workflow-reserve`: 워크플로우 attempt 실행 논리적 예약 (`teams-org.mjs`).
  - `resource-acquire`: 무거운 테스트/빌드용 전역 리소스 점유 (`teams-org.mjs`).
  - **순서**: `workflow-reserve`로 실행을 확보한 후, 실제 무거운 작업 직전에 전역 `resource-acquire`를 획득하고 완료 즉시 해제합니다.
- **호환 입력**: 기존 workflow JSON 파일 포맷 및 `pm-state` 인수 호환성을 유지하여 진행 중인 이전 단계에 영향이 없도록 합니다.

## 9. 반증 시나리오와 수용 테스트

이 설계의 안전성을 입증하기 위한 후속 수용 테스트 시나리오입니다. (실행 입력, 관측 위치, 정량 임계값 포함)

| 시나리오 | 초기 상태 | 실행 입력 (관측 위치) | 정량 임계값 / 실패 조건 | 예상 증거 (후속 구현) |
| --- | --- | --- | --- | --- |
| **증거 없는 완료 선언** | PM 검증 증거 미비 | PM이 `gate-check` 호출 시도 | `unverifiable_completions` > 0 | `gate-check` 거부 로그 반환 |
| **권한 밖 사용자 에스컬레이션** | 4가지 경계 내 자율적 상황 | 이사가 `directorRequest`로 에스컬레이션 시도 | `invalid_escalation_count` > 0 | `autonomy.md` 규약에 따른 런타임 차단 |
| **중복 Dispatch 생성 방어** | worker 진행 상태 `unverifiable` | 동일 Task ID로 `worker-start` 명령 실행 | `duplicate_dispatch_created` > 0 | `workflow.mjs` 중복 억제 로직에 의한 거부 반환 |
| **한국어 보고 언어 규칙 위반** | 완전 문장 규약 적용 환경 | 불완전 문장 또는 일본어로 `reply` 전송 | `unexpectedReportLanguageCount` > 0 | 텍스트 검사기가 발송 차단 및 오류 반환 |
| **auditor 맹목적 승인 (향후)** | 논거(반례) 없는 리뷰 접수 | auditor가 `review-record` 승인 처리 | `blind_approvals_accepted` > 0 | 이의 절차 누락 감지 및 차단 기록 |

## 10. 독립 재검토 수용 및 의존성 명시

- **재검토 반영**: 본 Revision 2는 `ca4d7eac...`에 대한 PL의 독립 재검토에서 제기된 10개 finding(실제 구현 근거 누락, 객체 분리 미비, 권한 없는 행동 금지, 관측 정정 등)을 모두 해결한 설계입니다. 해결 근거와 상세 내용은 `proactive-rework2-report.json`에 별도 보고됩니다.
- **검토 기록 및 통합 경계**: `proactive-pl-rereview.json` 검토 기록은 원본 그대로 보존됩니다. 현 커밋 이후 `npm run sync`, `npm run lint`, `npm test`의 무거운 필수 검사와 PM 워크트리로의 통합/후속 런타임 검증은 PM이 수행하며, Senior 단계에서는 미완료 항목을 완료된 것으로 기술하지 않습니다. 본 설계안은 향후 Phase의 `scripts/*` 런타임 구현에 의존합니다.
