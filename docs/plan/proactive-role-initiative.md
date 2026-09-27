# 주도적 역할 운영 설계 (Revision 1)

## 1. 역할별 현행 권한·보고·실행 계약 조사

현재 OMT에 구현된 여섯 가지 역할의 실제 권한과 한계를 `plugins/oh-my-teams/` 내의 스킬, 런타임, 테스트 경로와 줄 번호를 기준으로 명시합니다. 계획 중인 `auditor`는 현행 개발 워크트리를 분리하여 조사했습니다.

- **director**: `skills/director/SKILL.md` 17~19, 33~34, 60~71줄. 조직을 편성하고, kickoff를 시작하며 여러 kickoff를 동시 감독합니다. PM이 올린 결정 요청을 `director-inbox`로 조회하고 사용자 확인 경계 내외인지 심사하여 결정을 내립니다(`director-reply`).
- **pm**: `skills/pm/SKILL.md` 37, 80~87, 147~158줄. `workflow-reserve`로 자원을 예약하고 `worker-start`로 하위 역할에 task를 분배합니다. 프롬프트 질문 때문에 점검이 거부되면 에스컬레이션하고, 이사에게 진행·결정·완료 준비를 `director-signal`로 전송합니다.
- **pl**: `skills/pl/SKILL.md` 25~29줄. 작업 파동을 결정하고 작업 단위를 나누어 하위 역할에게 분할 명세를 배정합니다. 통합 후 `verify` 및 `merge-check`로 취합하며, 스스로 코드나 문서를 커밋하지 않습니다.
- **senior**: `skills/senior/SKILL.md` 23~28, 31~37줄. PL의 계획을 구체적 인터페이스, 변경 순서, 검증 방법으로 설계합니다. 자신이 배정받지 않은 기능 구현을 수행하지 않으며, 자신이 설계한 변경을 독립 검토로 스스로 승인할 수 없습니다.
- **junior**: `skills/junior/SKILL.md` 25~36줄. 배정된 파일만 편집하고 단위 테스트를 수행합니다. 작업 범위나 수용 기준을 스스로 변경할 수 없으며, 설계 판단이 필요한 반복 실패는 거부 증거와 함께 상위로 보고합니다.
- **auditor**: `/Users/jinsungkim/orca/oh-my-teams/.omt/briefs/139-auditor-2026-09-27.md` (계획 상태). 개발 워크트리를 분리하고 읽기 전용으로 조사하여 설계 및 구현에 대해 독립적인 비판적 반례 검토를 수행합니다. 런타임 구현은 현 단계와 별도로 계획됩니다.

## 2. 소유자와 상태 전이

OMT가 지속하는 독립 객체의 소유자와 정본, 상태 전이 주체를 분리하여 명시합니다. Orca가 관장하는 생명주기(worktree, terminal, Task, Dispatch, settlement)를 중복 구현하지 않습니다.

| 객체 | 소유자 | 정본 및 상태 전이 주체 |
| --- | --- | --- |
| **조직 (Organization)** | director | `.omt/organization.json` 생성, 갱신 및 해산. |
| **브리프 (Brief)** | director | `.omt/briefs/*.md` 초안 작성, 확정 및 갱신. |
| **Goal & kickoff 등록부** | PM | Orca Goal 등록 및 진행 추적. |
| **Run & workflow** | PM | `scripts/workflow.mjs` 바인딩, 재시도, 완료 처리. |
| **Task & Dispatch** | Orca | `references/orca-runtime.md`에 따른 대기, 진행, 정산. |
| **worker & 자원 슬롯** | 개별 worker | `scripts/teams-org.mjs` (335~337줄) `resource-acquire` / `release`를 통한 점유 및 해제. |
| **검증 증거 & 감사** | auditor / PL | `review-record` 및 `gate-check` 증거 기록, 이의 제기 혹은 승인. |
| **단계별 `.omt` 문서** | 담당 역할 | 각 배정 문서의 revision 증가, 정산 전이. |

## 3. 역할별 다음 행동 및 상태 전이 표

여섯 역할이 이벤트(현재 상태) 발생 시 주도적으로 결정할 후속 행동과 권한 담당자, 근거입니다.

| 역할 | 이벤트 (현재 상태) | 다음 행동 | 권한 담당자 | 완료 확인 방법 및 근거 |
| --- | --- | --- | --- | --- |
| **director** | 브리프 확정 완료 | PM에게 kickoff 할당. | director | PM의 Run 바인딩 보고 (`reply`). |
| **director** | PM 결정 요청 대기 | 사용자 경계 대조 후 자율 결정 혹은 사용자 질문. | director | `director-reply` 전송 및 신호 수신 확인. |
| **PM** | 결정 필요 (경계 외) | 이사에게 `director-signal` 전송. 직접 질문 금지. | PM | 이사의 응답 및 후속 지시. |
| **PM** | 진행 정체 / 의존성 지연 | 수동 개입 대기를 중단하고 우회 혹은 다른 배정 탐색. | PM | 런타임 `rework` / `reopen` 증거. |
| **PL** | 하위 작업 배정 필요 | 작업 분할 후 `worker-start`로 시작. | PL | Dispatch 생성 확인, 테스트 완료 보고 수신. |
| **PL** | 하위 결과 반려 | 원인 분석 후 파동 재설정하여 재작업 분배. | PL | 하위의 `verify` 및 `merge-check` 재통과. |
| **senior** | 검증 승인 완료 | 필수 수용 기준을 대조한 `worker_done` 보고. | senior | `review-record` 승인 및 테스트 통과 기록. |
| **senior** | 반복 구현 오류 / 정체 | 실패 증거 첨부하여 PL/PM에게 보고. 자체 축소 금지. | senior | 보고 언어 규칙을 준수한 `reply` 전송. |
| **junior** | 독립 작업 (대기 중) | 다음 배정까지 코드 읽기 및 분석. | junior | `assist` 호출 로그. |
| **junior** | 범위 초과 / 지시 충돌 | 범위 변경 없이 거부 코드 및 실패 증거 보고. | junior | `reply` / `worker_done` 거부. |
| **auditor** | 독립 검증 완료 | 수용 기준 대조 후 반례 제출 또는 승인 기록. | auditor | 반례 목록 또는 승인 JSON 기록. |

## 4. 이사와 PM의 판단 권한 (사용자 확인 경계)

이사와 PM은 `references/autonomy.md` (7, 11~14, 29~37줄)의 4가지 사용자 확인 경계 내에서만 사용자에게 확인을 요청합니다.
1. **계약 변경**: 주 버전(major version) 변경, 비목표 달성 요구, `delivery` 방식 변경.
2. **새 범위 추가**: 당초 브리프나 목표를 명백히 벗어나는 기능 추가.
3. **되돌릴 수 없는 외부 영향**: 비용 결제 승인, 새 계정 생성, 외부 API의 영구적 전송.
4. **사용자만 아는 사실**: 시스템 상태로 추론할 수 없는 비밀번호 등 암묵지.

경계에 해당하는 경우 PM은 이사에게 `director-signal`을 올리며, 이사가 최종적으로 사용자 질문을 판정합니다. 경계 밖이면 상향 보고 없이 주도적으로 결정하며 결정 근거와 되돌림 규약을 반드시 기록합니다.

## 5. PL·Senior·Junior·auditor의 주도성 한계와 보고 조건

하위 역할들의 독립성 범위와 보고 조건입니다.

| 역할 | 자율 판단 범위 | 상위 보고 조건 | 독립 승인 금지 |
| --- | --- | --- | --- |
| **PL** | 의존성과 중단기 작업 파동 결정. | 하위 worker 시작이 거부(depth 초과 등)될 시. | 통합 충돌을 스스로 고쳐 쓰지 않고 담당자에게 반환. |
| **senior**| 인터페이스, 변경 순서, 실패 조건 대안 탐색. | 로드맵 충돌 또는 구조적 반복 실패 발견 시. | 자신이 직접 작성/설계한 산출물을 스스로 승인할 수 없음. |
| **junior**| 배정 파일 안에서의 상세 로직과 테스트 작성. | 배정 범위를 벗어나는 수정이 불가피할 시. | 작업 범위를 스스로 넓히거나 줄일 수 없음. 자기 승인 금지. |
| **auditor**| 요구사항과 완성본 사이의 논리적 모순/반례 탐색. | 검증이 기술적으로 차단되거나 증거가 훼손되었을 시. | 상대의 논거 없는 주장을 맹목적으로 수용하거나 철회 불가. |

## 6. 다른 kickoff에서의 관측 사례 5가지

현행 kickoff에서 식별된 오판 사례들을 관측 원문 기준으로 바로잡고 새 계약을 정의합니다.

1. **tui-idle 거부 (adaptive-team-staffing)**
   - **관측 경로 및 줄**: `feat-adaptive-team-staffing/.omt/workflows/adaptive-staffing-wave1/events/000003-attach-design-approved-1.json` 10~21줄.
   - **원인**: 터미널이 idle 신호를 제때 보고하지 않아 timeout이 발생했고 "no Dispatch was created"가 기록됨.
   - **현재 안전 대응**: 기다리지 않고 즉시 재할당 혹은 fallback 전략.
   - **새 계약 행동**: 장애 원인을 명확히 기록한 후 무한정 대기를 종료하고 상위로 복구 절차 에스컬레이션.
2. **독립 검토 및 의존성 지연 (adaptive-team-staffing)**
   - **관측 경로 및 줄**: `feat-adaptive-team-staffing/.omt/workflows/adaptive-staffing-wave1/events/000004-settle-design-dispatch-1.json` 9~18줄.
   - **원인**: completed settlement와 independent review followup이 기록되었으며, `documentRevision: missing`은 세션 유실이 아닌 후속 처리 대기 상태임.
   - **현재 안전 대응**: 현재 흐름을 중단하지 않고 독립 검토를 이어서 진행.
   - **새 계약 행동**: 모든 상태 전이를 문서 revision으로 추적하며 `missing`을 임의로 세션 유실로 단정 짓지 않고 검토를 지속.
3. **중복 Dispatch 방지 (dynamic-model-catalogs)**
   - **관측 경로 및 줄**: `feat-dynamic-model-catalogs/.omt/plan/w1-rereview-start.json` 106~116줄.
   - **원인**: 이전 시각에 생성되어 `already-started` (task-id-in-transcript)로 기록된 작업에 대한 재진입 시도.
   - **현재 안전 대응**: 새로운 생성 없이 기존 제출 세션에 즉시 재결합.
   - **새 계약 행동**: 정본 문서를 읽고 이미 실행 중인 Task에 대해 중복 Dispatch를 생성하지 않고 기존 흐름에 동기화.
4. **활동 정지 오판 방지 (139-auditor)**
   - **관측 경로 및 줄**: `feat-139-auditor/.omt/supervision/obs.json` 1줄.
   - **원인**: `lastActivityAt`이 `now`와 일치하여 실제로는 정체되지 않았으나 정체로 오해될 소지가 있음.
   - **현재 안전 대응**: 섣불리 stalled로 단정하지 않음.
   - **새 계약 행동**: OMT 내부에서 타이머를 돌려 추측성 프로세스 감독을 하지 않으며, 명시된 Orca 신호 기반으로만 진행.
5. **열린 finding 및 의존성 지연 (structured-omt-documents)**
   - **관측 경로 및 줄**: `feat-structured-omt-documents/.omt/gates/omt-docs-design.json` 15~27줄.
   - **원인**: `dependencies-runtime-path-missing-opencodex-segment` finding이 해결되지 않아 블록됨.
   - **현재 안전 대응**: 강제 무시하지 않고 조건을 충족할 때까지 블록 상태 유지.
   - **새 계약 행동**: 수동 개입을 무작정 기다리지 않고 PM에게 에스컬레이션하여 다른 배정이나 안전한 호환 우회를 요청.

## 7. 회복 규약

불명 상태 발생 시의 권한 있는 관측(authoritative reconciliation) 절차를 규정합니다.
- 시스템은 재개 시 문서 revision 결정 ID, 시도 ID, 메시지 ID의 조회 순서로 정본을 읽어 메시지 중복을 방지합니다.
- `scripts/workflow.mjs` 867~947줄에 따라 관측이 없는 running attempt는 `reconcile-required`로 남깁니다.
- 5가지 receipt ID(Run, Task, Dispatch, Execution, worktree)를 교차 요구하며, 불명 상태를 진행/종료로 임의 추정하거나 새 Dispatch를 생성하지 않고 상향 보고합니다.

## 8. 변경 지점 및 호환 전략

OMT에 새 감시자를 두지 않고 기존 런타임에 연결합니다.
- **매핑 및 변경 지점**: 기존 1:1 매핑을 탈피하여 재시도, 재작업, 복수 Dispatch 흐름을 통합 수용합니다.
- **이전 및 자원 전략**: 호환 입력을 유지하며, 자원 획득 시 `scripts/teams-org.mjs` 335~337줄의 `resource-acquire` 및 `resource-release`를 명시적으로 사용하여 공유 슬롯을 관리합니다. `workflow-reserve`와 실제 전역 리소스 슬롯 점유 절차를 명확히 분리합니다.

## 9. 반증 시나리오와 수용 테스트 (계측값)

설계 반증 및 런타임 적용 수용 테스트 시나리오입니다.

| 시나리오 | 초기 상태 | 실행 입력 | 기대 전이 (관측 지점) | 실패 기준 및 임계치 |
| --- | --- | --- | --- | --- |
| **A. 증거 없는 완료 선언** | PM 검증 증거 미비. | `completed` 신호 제출. | `gate-check`에서 런타임 검증 거부. | `unverifiable_completions` > 0 |
| **B. 이사의 권한 밖 사용자 질문** | 이사의 권한 범위 내 자율 상황. | 사용자에게 질문 에스컬레이션 전송. | `autonomy.md` 런타임 검사에서 발송 차단. | `invalid_escalation_count` > 0 |
| **C. 감사의 맹목적 승인** | 감사가 반례나 논거 없이 검토 접수. | 이의 제기 없이 맹목적 승인 기록. | `review-record` 이의 절차 누락 감지 및 차단. | `blind_approvals_accepted` > 0 |
| **D. 중복 Dispatch 방어 실패** | worker 진행 상태 미확인(`unverifiable`). | 동일 Task ID로 중복 Dispatch 요청. | `workflow.mjs` 중복 억제 로직이 거부 반환. | `duplicate_dispatch_created` > 0 |

## 10. 다음 단계 및 의존성

- **검토 및 재작업 완료**: 현재 설계안(Revision 1)은 10건의 PL 독립 검토 반례를 전면 수용하여 정본 경로 기반으로 완전히 재작성되었습니다. 보고 언어 안정성 반례(`report-language-contract-drift`)에 따라 진행 및 완료 보고 시 한국어 완전 문장(인용, 코드 제외)을 사용해야 하는 요건이 향후 런타임에 적용됩니다.
- **의존성 상태**: 실제 `scripts/*` 런타임과 스키마 구현은 현 설계안 이후 단계에서 수행됩니다. PM 워크트리 통합과 런타임 후속 검증이 실현될 때까지, PL의 `independent-review-evidence-and-pm-boundary-open` finding은 열린 채로 유지합니다.
