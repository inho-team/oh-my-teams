# 주도적 역할 운영 설계 (Revision 2)

## 1. 역할별 현행 권한과 실행 근거

실제 구현과 제안 계약을 구분하여, OMT 역할의 권한과 런타임 근거를 기술합니다.

- **director**: `plugins/oh-my-teams/skills/director/SKILL.md`에 정의. `plugins/oh-my-teams/scripts/teams-org.mjs`의 `directorRequest`(2134줄)는 런타임 시작 인자 생성 기능일 뿐 결정 실행이 아닙니다. 실제 결정 신호 처리는 `kickoff-release` 등의 명령과 `delivery.mjs`로 수행합니다. 런타임 테스트는 `tests/director-role.test.mjs`, `tests/director-signal.test.mjs`.
- **pm**: `plugins/oh-my-teams/skills/pm/SKILL.md`에 정의. `plugins/oh-my-teams/scripts/workflow.mjs`의 `createWorkflow`(262줄), `reserveExecution`(1011줄)로 작업 흐름을 통제. 또한 `plugins/oh-my-teams/scripts/gates.mjs`의 `acceptOutcome`(436줄)은 PM 전용(decider.kind === "pm")으로 최종 승인을 수행합니다. 테스트는 `tests/workflow-runtime-gaps.test.mjs`.
- **pl**: `plugins/oh-my-teams/skills/pl/SKILL.md`에 정의. `plugins/oh-my-teams/scripts/workflow.mjs`의 `handoffTask`(1857줄) 등을 사용. `scripts/core.mjs`의 `depthRoles`(108줄)는 실행 역할 목록일 뿐 Orca 중첩 worker 깊이를 제한하는 런타임 기능이 아닙니다(실제 깊이 제한은 Orca가 관리하며 PL 스킬 계약으로 통제함). 테스트는 `tests/role-dispatch.test.mjs`.
- **senior**: `plugins/oh-my-teams/skills/senior/SKILL.md`에 정의. `plugins/oh-my-teams/scripts/gates.mjs`의 `recordReview`(378줄)로 검토(review)를 기록합니다. (승인은 PM의 권한임). 자신이 설계/작성한 코드를 스스로 독립 승인할 수 없음. 테스트는 `tests/safety-net.test.mjs`, `tests/advise.test.mjs`.
- **junior**: `plugins/oh-my-teams/skills/junior/SKILL.md`에 정의. 배정 파일 내 로직 작성 및 단위 테스트. 범위 변경 불가. 테스트는 `tests/legacy-intern.test.mjs`.
- **auditor**: 조직 파일(revision 16)에 선언되지 않은 제안 역할. 이슈 `#139` 브리프에 따라 독립 검증을 기획 중. **미구현 경계 명시:** 현행 런타임에는 auditor의 무논거 승인 차단기나 스킬이 구현되어 있지 않으므로, 이를 기설정된 런타임 차단기로 서술하지 않습니다.

## 2. 객체 소유와 상태 전이 경계

OMT가 Orca의 소유 객체를 새로 관리하거나 생명주기 및 프로세스를 중복 복제하지 않도록 경계를 보존합니다.

- **organization (조직)**: 정본 `.omt/organization.json`. 소유자 director. 생성/갱신 조건: `org-revise` 등 명령을 통한 director 권한입니다.
- **brief (브리프)**: 정본 `.omt/briefs/`. 소유자 director. 생성/갱신 조건: director 권한으로 작성 및 갱신됩니다.
- **Goal**: 정본은 Orca입니다. 소유자 Orca. 생성/갱신 조건: PM이 원래 인수 지시에서 생성하고 `kickoff-bind`와 연결할 뿐, 프로세스와 상태 전이(생성, 갱신, 종료) 및 권한은 전적으로 Orca에 따르며 OMT가 복제하지 않습니다.
- **kickoff registry**: 정본 `.omt/kickoffs/`. 생성/갱신 조건: 생성과 바인딩은 PM이 주도하지만, `kickoff-release`와 `delivery` 상태 전이(종료, 정산, 회수)는 이사(director) 권한입니다.
- **Run**: 정본은 Orca입니다. 소유자 Orca. PM이 workflow에 바인딩하여 실행을 추적합니다.
- **workflow**: 정본 `.omt/workflows/`. 소유자 PM. 생성/갱신 조건: PM이 생성하고 상태(`pending`, `active`, `settled` 등 실제 JSON enum)를 갱신 및 보존합니다.
- **Task**: 정본은 Orca입니다. 소유자 Orca. 상태 전이는 Orca가 관리합니다.
- **Dispatch**: 정본은 Orca입니다. 소유자 Orca. 전이 주체는 Orca입니다.
- **worker**: 정본은 Orca입니다. 소유자 Orca.
- **resource slot**: 정본 `.omt/slots.json` (또는 인메모리 기록). 전역 관리. 갱신/종료 조건: 무거운 작업 전 worker가 `resource-acquire`로 획득하고 완료 직후 `resource-release`로 해제(반환)합니다.
- **evidence (검증 증거)**: 정본 `.omt/evidence/`. 소유자 Senior/PL. 생성/갱신 조건: `gate-check`를 통한 checks 결과(pass/fail)와 `recordReview`의 review 결론(enum: `approved`, `changes-requested`, `inconclusive`)을 명확히 구분하여 객체 상태에 기록합니다.
- **audit/objection**: auditor가 추후 생성할 객체 (현재 미구현).
- **.omt docs (설계/계획 문서)**: 정본 워크트리 내. 소유자 작성 역할.
- **delivery**: 이사가 `scripts/delivery.mjs`로 최종 확인 후 병합합니다. 무권한 역할의 병합은 거부됩니다.

## 3. 역할별 상태, 판단 근거, 보고 대상 및 권한

여섯 역할(director, pm, pl, senior, junior, auditor)과 10개 상태(시작, 배정, 반려, 재작업, 정체, 오류, 사용자 결정 대기, 독립 작업, 검증, close)의 60개 조합에 대한 규약입니다.
제안된 auditor는 미구현 역할이므로 동일 사건에 대한 권한은 없으나 향후 설계 행동 구분을 위해 명시합니다.
PL은 통합 충돌을 스스로 고치지 단독 수정하지 않고 하위에 되돌리며, PM이 배정한 PL은 기본 깊이 1 제한에 따라 하위 worker를 직접 띄우지 못하므로 분할 계획을 PM에게 반환하여 PM이 평평하게 배정합니다.

| 역할 | 사건(상태) | 판단 근거 및 조건 | 다음 행동(담당) | 완료 확인 | 보고 대상 |
|---|---|---|---|---|---|
| **director** | 시작 | 브리프 확정 완료 | PM에게 kickoff 할당 (director) | registry 갱신 | 사용자(할당) |
| **director** | 배정 | 하위 배정 권한 없음 | (진행 불가) | - | - |
| **director** | 반려 | 거부 권한 없음 | (진행 불가) | - | - |
| **director** | 재작업 | 직접 재작업 권한 없음 | (진행 불가) | - | - |
| **director** | 정체 | 상태 정체 | (진행 불가) | - | - |
| **director** | 오류 | 자체 오류 | (진행 불가) | - | - |
| **director** | 사용자 결정 대기 | PM의 에스컬레이션 수신 | 4가지 경계 대조 후 결정 또는 질문 생성 (director) | 답변 수신 | 사용자 |
| **director** | 독립 작업 | 독립 작업 권한 없음 | (진행 불가) | - | - |
| **director** | 검증 | 직접 검증 권한 없음 | (진행 불가) | - | - |
| **director** | close | 모든 정산 및 배포 준비 완료 | delivery 명령으로 main 병합 (director) | 병합 성공 | 사용자 |
| **pm** | 시작 | 목표 브리프 수신 | workflow 생성 및 kickoff 바인딩 (pm) | 상태 갱신 | director |
| **pm** | 배정 | 목표 분할/배정 | PL에게 분할 요청 또는 평평하게 배정 후 reserve/start (pm) | worker 실행 | director |
| **pm** | 반려 | 통합 검토 반려 수신 | 파동 재설정 후 담당자 재지정 (pm) | 워크플로우 갱신 | director |
| **pm** | 재작업 | 반려/오류 뒤 복구 | reworkTask 명령으로 워크플로우 재가동 (pm) | event 추가 | 배정자(director) |
| **pm** | 정체 | 무한 대기 감지 | reserve 취소 후 우회 배정 또는 에스컬레이션 (pm) | 재할당 | director |
| **pm** | 오류 | 실패 수신 | 원인 파악 및 남은 시도 확인 후 retryTask (pm) | 재실행 | director |
| **pm** | 사용자 결정 대기 | 4가지 경계 위반 인지 | 직접 질문 금지, director-signal 전송 (pm) | signal 생성 | director |
| **pm** | 독립 작업 | 다른 작업 대기 시 | 다른 분기나 독립 task 처리 지속 (pm) | task 처리 | director |
| **pm** | 검증 | 최종 산출물 수신 | acceptOutcome(승인) 수행 (pm) | 상태 approved | director |
| **pm** | close | 자체 close 불가 | (진행 불가, release는 director) | - | - |
| **pl** | 시작 | 자체 시작 불가 | (진행 불가) | - | - |
| **pl** | 배정 | PM으로부터 분할 요청 수신 | 분할 계획 반환하여 PM이 평평하게 배정 유도 (pl) | 계획 제출 | PM (상위) |
| **pl** | 반려 | 통합 충돌 발생 | 충돌 직접 수정 금지, 충돌 파일 첨부하여 배정자에게 반환 (pl) | 반려 리포트 | PM (상위) |
| **pl** | 재작업 | 분할/통합 재작업 지시 수신 | 기존 분할 계획 수정 및 새 파동 제안 (pl) | 재작업 완료 | PM (상위) |
| **pl** | 정체 | 통합 정체 파악 | 정체 원인 파악 후 해결 불가 시 에스컬레이션 (pl) | 보고 완료 | PM (상위) |
| **pl** | 오류 | 통합 또는 worker 거부(중첩) | 분할 계획과 거부 원문을 첨부해 반환 (pl) | 반환 완료 | PM (상위) |
| **pl** | 사용자 결정 대기 | 하위 에스컬레이션 수신 | 자체 해결 불가(경계 위반) 시 상향 보고 (pl) | 상향 전달 | PM (상위) |
| **pl** | 독립 작업 | 계획/대안 탐색 중 | 통합 전용 별도 Orca 워크트리 구성 등 지속 (pl) | 구성 완료 | PM (상위) |
| **pl** | 검증 | 하위 task 완료 | 통합 결과 verify 및 merge-check (pl) | 통과 확인 | PM (상위) |
| **pl** | close | 통합 취합 완료 | 작업 ID/검증 키/변경 요약을 포함해 worker_done (pl) | 리포트 제출 | PM (상위) |
| **senior** | 시작 | 자체 시작 불가 | (진행 불가) | - | - |
| **senior** | 배정 | 설계/검토/구현 task 수신 | 인터페이스 설계 및 필수 검토(changes-requested/approved) 작성 (senior) | 설계/검토 제출 | 배정한 상위 역할 |
| **senior** | 반려 | 산출물 결함 또는 검토 반려 수신 | 독단적 변경 거부 및 changes-requested 기록 (senior) | 거부 기록 | 배정한 상위 역할 |
| **senior** | 재작업 | 반려 피드백 수신 | 대안 탐색 및 해당 결함 수정 (senior) | 결함 수정 | 배정한 상위 역할 |
| **senior** | 정체 | 의존성 또는 결정 대기 | 기다리다 막히면 독단적 판단 없이 상태 상향 보고 (senior) | 보고 완료 | 배정한 상위 역할 |
| **senior** | 오류 | 실행/구현 중 오류 | 원인 로그 캡처 및 거부 코드 첨부 상향 보고 (senior) | 에스컬레이션 | 배정한 상위 역할 |
| **senior** | 사용자 결정 대기 | 예외 상황 발생 | 범위 밖 결정 금지, 즉각 상향 보고 (senior) | 보고 완료 | 배정한 상위 역할 |
| **senior** | 독립 작업 | 리뷰/설계 중 조사 필요 | assist 호출 등 다른 task 지속 (senior) | 조사 완료 | 배정한 상위 역할 |
| **senior** | 검증 | 제출 전 검증 | 수용 기준 대조 후 자체 verify (자체 산출물 승인 금지) (senior) | verify 통과 | 배정한 상위 역할 |
| **senior** | close | 담당 범위 완료 | 실패 증거 누락 없이 worker_done 호출 (senior) | 완료 선언 | 배정한 상위 역할 |
| **junior** | 시작 | 자체 시작 불가 | (진행 불가) | - | - |
| **junior** | 배정 | 구체적 로직 구현 지시 수신 | 파일 편집 하네스 진입 및 코드 구현 (junior) | 코드 작성 | 배정한 상위 역할 |
| **junior** | 반려 | 권한 밖 지시(범위 변경) 수신 | 자체 수정 불가, 거부 증거 상향 보고 (junior) | 거부 통지 | 배정한 상위 역할 |
| **junior** | 재작업 | 결함 수정 지시 수신 | 지적 사항만 수용하여 수정 (junior) | 수정 완료 | 배정한 상위 역할 |
| **junior** | 정체 | 지시 충돌 발생 | 억지 구현 중단 및 충돌 상태 상향 보고 (junior) | 보고 완료 | 배정한 상위 역할 |
| **junior** | 오류 | 환경/단위 테스트 오류 | 원인 파악 불가 시 로그 캡처 후 상향 보고 (junior) | 에스컬레이션 | 배정한 상위 역할 |
| **junior** | 사용자 결정 대기 | 결정 불가 상황 직면 | 억측 없이 상향 보고 (junior) | 보고 완료 | 배정한 상위 역할 |
| **junior** | 독립 작업 | 코드 작성 중 | 주어진 제한된 범위 내 로직/단위테스트 지속 (junior) | 테스트 실행 | 배정한 상위 역할 |
| **junior** | 검증 | 구현 완료 후 | 단위 테스트 실행 통과 여부 확인 (junior) | 테스트 통과 | 배정한 상위 역할 |
| **junior** | close | 지시된 변경 완료 | 작업 결과를 취합하여 worker_done 호출 (junior) | 완료 선언 | 배정한 상위 역할 |
| **auditor** | 시작 | 미구현 | (진행 불가) | - | - |
| **auditor** | 배정 | 미구현 | (진행 불가) | - | - |
| **auditor** | 반려 | 미구현 | (진행 불가) | - | - |
| **auditor** | 재작업 | 미구현 | (진행 불가) | - | - |
| **auditor** | 정체 | 미구현 | (진행 불가) | - | - |
| **auditor** | 오류 | 미구현 | (진행 불가) | - | - |
| **auditor** | 사용자 결정 대기 | 미구현 | (진행 불가) | - | - |
| **auditor** | 독립 작업 | 미구현 | (진행 불가) | - | - |
| **auditor** | 검증 | 런타임 제출 수신(미래) | 논거 없는 승인 차단 및 명확한 반례 제시 (auditor) | 검증 완료 | 해당 상위 |
| **auditor** | close | 미구현 | (진행 불가) | - | - |

## 4. 사용자 확인 경계와 자율성 보존

`plugins/oh-my-teams/references/autonomy.md`의 네 가지 확인 경계의 실제 의미와 예외를 모두 보존하며, 업무 계약(비강제적 규율)과 런타임 차단 기능(코드적 거부)을 명확히 구분합니다.

### 4.1. 네 가지 확인 경계 (계약)

1. **계약 변경**: 확정된 목표, 수용 기준, 비목표, 주 버전 변경 및 확정된 전달 방식(`delivery`)을 변경해야 할 때 사용자에게 확인합니다. (형식 변경, 수용 기준을 해치지 않는 문서 정정은 예외)
2. **새 범위 추가**: 당초 목표와 브리프에 없는 명백히 새로운 범위가 필요할 때 질문합니다. 다음 kickoff로 분리하는 안을 함께 제안합니다.
3. **되돌릴 수 없는 외부 영향**: 외부 발송, 배포, 원격 push, 주인 체크아웃 밖의 삭제, 사용자 설정 파일(`~/.claude`, `~/.codex`, Agy 설정) 변경, 새 계정이나 구독의 사용과 같이 되돌릴 수 없는 동작을 수행할 때 확인합니다.
4. **사용자만 아는 암묵지**: 시스템 기록으로 알 수 없는 제품 결정, 사용자 일정, 우선순위, 사용할 계정 등에 대해서만 묻습니다.

### 4.2. 범위 안 결정과 독립 작업 (운영 절차)

- 위 네 경계에 해당하지 않는 범위 내의 판단(실행 깊이, 조직 프로필 내 모델 선택, 분할/순서, 재시도/재작업 범위, 임시 리소스 정리 등)은 무조건 상향 보고하지 않고 자율적으로 처리합니다.
- 주도적 판단 후에는 그 **결정 내용, 근거, 판단이 틀렸을 때 되돌리는 방법(rollback)**을 해당 진행 보고나 문서의 지정 위치에 기록합니다.
- 사용자나 상위 역할의 답을 대기하는 상태가 되더라도 전체 작업을 멈추지 않고, 당면한 대기 상태와 무관하게 진행할 수 있는 **독립 작업은 지속**하는 것을 운영 절차로 확립합니다.
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
