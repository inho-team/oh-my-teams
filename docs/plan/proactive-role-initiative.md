# 주도적 역할 운영 설계 (Revision 1)

## 1. 역할별 현행 권한·보고·실행 계약 조사

현재 OMT에 구현된 역할과 이슈 #139에서 계획 중인 `auditor`의 권한 및 한계를 실제 구현 파일의 경로를 통해 정리합니다.

- **director**: `plugins/oh-my-teams/skills/director/SKILL.md` (1~98줄). 팀의 조직을 편성하고, 사용자 지시를 분석하여 kickoff를 주도적으로 시작하며, 최종 병합 및 이슈 종료를 책임집니다.
- **pm**: `plugins/oh-my-teams/skills/pm/SKILL.md` (1~177줄). Run을 바인딩하고 목표를 설정하며, 하위 역할에 task를 분배하고 산출물을 검토합니다.
- **pl**: `plugins/oh-my-teams/skills/pl/SKILL.md` (1~107줄). 구체적 설계와 코드 품질을 책임지며, 하위 역할의 구현을 승인합니다.
- **senior**: `plugins/oh-my-teams/skills/senior/SKILL.md` (1~63줄). 아키텍처 규칙과 코딩 지침에 기반하여 복잡한 로직을 구현하고 검토합니다.
- **junior**: `plugins/oh-my-teams/skills/junior/SKILL.md` (1~50줄). 지시된 명세에 따라 코드를 작성하고 단순 검사를 수행합니다.
- **auditor**: (미구현. 계획 상) 독립적으로 완성된 산출물과 원래의 사용자 요구 사항을 비판적으로 대조하고, 미충족 사항이나 반례를 제기하는 역할을 맡을 예정입니다.

## 2. 소유자와 상태 전이

OMT가 지속하는 주요 객체의 소유자와 수명 주기를 Orca 생명 주기를 중복하지 않고 관리합니다.

| 객체 | 소유자 | 상태 전이 및 관리 |
| --- | --- | --- |
| **조직 (Organization)** | director | 생성 → 갱신 → 해산 (정본: `.omt/organization.json`) |
| **브리프 (Brief)** | director | 초안 → 확정 → 갱신 |
| **Goal & kickoff 등록부** | PM | 할당 → 진행 중 → 완료 (등록은 director) |
| **Run & workflow** | Orca (PM 연동) | Orca의 Run 수명 주기에 맞춰 PM이 상태 추적 및 바인딩 수행 |
| **Task & Dispatch** | 역할 담당자 | 대기 → 진행 중 (Dispatch) → 검토 대기 → 수용/반려 |
| **worker & 자원 슬롯** | 개별 worker | 확보 → 실행 → 해제 |
| **검증 증거 & 감사** | auditor / PL | 제출 → 검토 중 → 이의 제기/승인 |
| **단계별 `.omt` 문서** | 각 담당 역할 | 초안 → 검토 → revision 갱신 |
| **최종 전달** | director | 완료 신호 대기 → 통합 병합 → close |

## 3. 역할별 다음 행동 및 상태 전이 표

사용자의 지시를 기다리지 않고 이벤트에 따라 주도적으로 후속 행동을 결정하는 기준입니다.

| 역할 | 이벤트 / 현재 상태 | 다음 행동 | 실행 담당자 | 근거 / 완료 확인 방법 |
| --- | --- | --- | --- | --- |
| **director** | 브리프 확정 | PM에게 kickoff 할당 및 자원 승인 | director | PM의 Run 바인딩 및 보고 |
| **PM** | 하위 task 검토 반려 | 수정 지시 및 재작업 Dispatch | PL / senior | 수정된 검토 결과 및 증거 제출 |
| **PM** | 사용자 결정 필요(경계 밖) | 사용자에게 질문 에스컬레이션 | PM | 사용자의 답변 및 지시 |
| **PL** | 구현 오류 / 정체 | 문제 분석 후 senior에게 재배정 | PL | 테스트 통과 및 원인 해결 보고 |
| **senior** | 검토 승인 완료 | 상위 역할(PL/PM)에게 worker_done 보고 | senior | 검증 증거 및 테스트 통과 기록 |
| **auditor** | 검증 시 반례 발견 | 이의 제기 및 반론 요구 | auditor | PM/PL의 논거 및 증거 기반 재검토 |

## 4. 이사와 PM의 판단 권한 (사용자 확인 경계)

이사와 PM은 `references/autonomy.md`의 네 가지 경계 안에서 사용자에게 의존하지 않고 주도적으로 결정합니다.
- **사용자의 계약 변경**: 사용자의 본래 요구 사항을 좁히거나 없애는 경우에만 사용자에게 묻습니다.
- **새 범위 추가**: 처음 지시된 범위를 명백히 벗어나는 기능이 필요할 때 확인합니다.
- **되돌릴 수 없는 외부 영향**: 새 계정 생성이나 비용 결제, 외부 API 강제 전송 시 확인합니다.
- **사용자만 아는 사실**: 시스템 상태로 추론 불가능한 도메인 지식이나 비밀번호 등이 필요할 때만 질문합니다.
이 외의 상황에서는 이사와 PM이 근거를 남기고 주도적으로 진행하며 사용자의 개입을 유도하지 않습니다.

## 5. PL·Senior·Junior·감사의 주도성 한계와 보고 조건

하위 역할이 장애물을 발견했을 때 무조건 멈추고 보고하는 것은 주도성 목표에 어긋납니다. 실제 스킬 권한에 따라, 범위 내 원인 분석·접근 변경·좁은 수정은 스스로 수행하고, 완료 증거로 해당 상태의 기록을 남깁니다. 

- **자율 판단과 범위 내 행동**: 
  - **PL**: 하위 worker 배정 시 문제가 발생하면 즉시 원인을 분석하고, 범위 내라면 시도(attempt)를 재할당하거나 접근법을 고칩니다. 완료 증거로 테스트 통과 기록 및 `reconcile-required` 관측 결과를 제출합니다. 
  - **Senior**: 설계·구현 시 실패하는 검사가 있으면 스스로 분석하고 수정합니다. 완료 증거로 `verify` 실행 결과와 리뷰 판정(`review-record`)을 남깁니다.
  - **Junior**: 명세 내 구현 시 발생하는 단순 오류를 스스로 수정하며, 통과된 단순 검사 결과를 완료 증거로 남깁니다.
- **상향 보고(에스컬레이션) 조건**: 다음 네 가지 경계 충돌 시 스스로 해결하지 않고 상위 역할(PM 등)에 보고합니다.
  1. 사용자 확인 경계를 벗어나는 결정이 필요할 때
  2. 요구사항이나 목표를 변경해야 할 때
  3. 전역 자원(슬롯, 할당량) 고갈로 인한 블로킹
  4. 다른 역할 권한 침해(예: 타 역할이 책임지는 문서/코드 수정 요구)
- **독립 검토 및 자기 승인 금지**: 자신이 만든 산출물이나 설계를 스스로 승인할 수 없습니다. 
- **감사(Auditor) 역할의 독립성**: 아직 구현되지 않은 제안 역할이나, 향후 구현될 경우 독립 검토, 논거에 기반한 설득, 반박, 이의 제기를 수행하며, 근거 없는 무조건적 수용이나 자기 승인을 금지합니다. (신규 감사 실행기는 이번에 구현하지 않음)

## 6. 다른 kickoff에서의 관측 사례 5가지

해결된 관측 해석을 보존하되, 실제 사례 각 5건에 대해 구체적인 항목을 보충합니다. 원천에 없는 값은 `[미기록]`으로 표시합니다.

1. **tui-idle 거부 (adaptive-team-staffing)**:
   - **원천 전체 경로**: `[미기록]` (작업 트리의 `.../events/000003-attach-design-approved-1.json`)
   - **기록 시각**: `2026-09-27T13:56:10.295Z`
   - **식별자 (ID/Event)**: `attach-design-approved-1`
   - **관측 사실**: `"refusal": {"kind": "execution-unconfigured", "code": "timeout", "message": "Terminal ... did not report tui-idle within 20000ms"}`
   - **원인/추론**: 터미널이 idle 상태를 제때 보고하지 않음.
   - **현재 안전 대응**: 기다리지 않고 즉시 거부(timeout) 처리.
   - **새 다음 행동**: 재시작을 무한 반복하지 않고, 구체적 장애 원인 기록 후 재할당이나 fallback 전략으로 주도적 전환.

2. **세션 유실 및 문서 누락 (adaptive-team-staffing)**:
   - **원천 전체 경로**: `[미기록]` (`.../events/000004-settle-design-dispatch-1.json`)
   - **기록 시각**: `2026-09-27T14:00:26.754Z`
   - **식별자 (ID/Dispatch)**: `settle-design-dispatch-1`
   - **관측 사실**: `evidence` 필드 내 `"documentRevision": "missing", "acceptance": "not-accepted"`
   - **원인/추론**: 문서의 개정본 정보가 누락되어 상태 추적이 끊어짐.
   - **현재 안전 대응**: 이전 스냅샷 상태 유지 (복구 수동).
   - **새 다음 행동**: 모든 상태 전이에 문서 revision 기록을 의무화하고, `missing` 시 마지막 유효 스냅샷과 revision부터 즉시 롤백 및 복구(회복 규약).

3. **반복 시작 (dynamic-model-catalogs)**:
   - **원천 전체 경로**: `[미기록]` (`.../plan/w1-rereview-start.json`)
   - **기록 시각**: 발견 시점 `2026-09-27T14:38:10.152Z`
   - **식별자 (Task ID)**: `887d9471-7dae-4726-971f-6b3c32700846`
   - **관측 사실**: `"outcome": "already-started", "reason": "task-id-in-transcript"`
   - **원인/추론**: 동일 Task ID로 중복 Dispatch 시도(terminal 재진입). 새 중복 Dispatch 증거가 아님.
   - **현재 안전 대응**: 중복 시작으로 감지 후 실행 중단.
   - **새 다음 행동**: 정본 문서의 Task ID를 읽고 중복 억제키로 사용하여 원천 차단하며, 진행 중인 attempt로 `reconcile-required`를 통해 결합.

4. **확인 불가 / stalled Goal 의심 (139-auditor)**:
   - **원천 전체 경로**: `[미기록]` (`supervision/obs.json`)
   - **기록 시각**: `2026-09-27T13:27:10Z` (`lastActivityAt`)
   - **식별자 (Goal ID)**: `[미기록]`
   - **관측 사실**: `unansweredRequests: 0` 이나 활동 정지.
   - **원인/추론**: 네이티브 Goal 상태 관측 불가. 섣불리 'stalled'로 추정 불가.
   - **현재 안전 대응**: 상태 확인 불가로 대기.
   - **새 다음 행동**: OMT 내부 프로세스 감독기를 두지 않고, 관측 불가능한 `lastActivityAt` 상태에 의존하지 않으며, Orca 생명 주기의 명시적 orchestration 신호와 종료 증명만으로 재개.

5. **독립 검토 및 의존성 지연 (structured-omt-documents)**:
   - **원천 전체 경로**: `[미기록]` (`.../gates/omt-docs-design.json`)
   - **기록 시각**: `[미기록]` (파일 내 `taskHash` 생성 시점)
   - **식별자 (Task ID)**: `omt-docs-design`
   - **관측 사실**: `"review-complete": {"status": "pending", "missing": ["design-independent-review"], "openFindings": ["pm-design-authorship-role-limit-conflict", ...]}`
   - **원인/추론**: 독립 검토 미완료 및 open findings 존재로 인한 계류.
   - **현재 안전 대응**: 의존성 충족 전까지 블록 유지.
   - **새 다음 행동**: 수동 개입을 기다리지 않고, PM에게 에스컬레이션하여 다른 역할을 배정하거나 임시 호환 목록 기반 의존성 우회를 주도적으로 요청.

## 7. 회복 규약 (Recovery Protocol)

새로운 타이머나 감독기 없이 Orca의 상태/종료 증명 및 headless-runtime 예외를 활용합니다. 유실되거나 판정 불가능한 상태를 함부로 `진행 중` 또는 `종료`로 추정하지 않습니다.

- **조회 명령 및 정본 파일**: 시스템 재개 시, `scripts/workflow.mjs`의 `stateDir` 내 `.omt/` 정본 상태 디렉터리와 현재 workflow attempt를 대조합니다.
- **관측 수집 역할 및 비교키**: PM과 PL이 `workflow.mjs`의 상태 전이를 기반으로 현재 attempt ID와 `taskHash`를 비교키로 삼아 상태를 관측합니다.
- **누락·충돌 시 안전한 다음 행동 (reconcile-required)**: `workflow.mjs`에 명시된 대로, 확실한(authoritative) 외부 관측 결과가 없는 running attempt는 자동으로 시작하거나 재시도하지 않고 `reconcile-required` 액션을 반환하여 보류(pend)하고 상위 역할의 판단을 받습니다. unknown 상태 또한 동일하게 처리합니다.
- **중복 억제키**: 처리한 message나 event는 `taskHash`와 `attemptId`를 조합한 고유 식별자를 통해 중복 Dispatch나 반복 시작을 차단합니다.
- **Task와 결정의 연결**: 이어갈 task는 이전 시도에서 보존된 결정(`review-record`나 `gates.mjs`의 게이트 상태)을 명시적으로 참조하여 복구됩니다.

## 8. 변경 지점 및 호환 전략

현재 OMT 런타임을 수정하지 않으며, 후속 구현 계획으로 다음의 변경 예정 지점과 호환 전략을 정의합니다. 새로운 프로세스 관리 기능은 만들지 않습니다.

| 변경 예정 지점 (함수/명령/문서/테스트) | 변경 내용 | 기존 입력·스냅샷 보존 방법 | 도입 Gate | 선후 의존성 |
| --- | --- | --- | --- | --- |
| `plugins/oh-my-teams/scripts/workflow.mjs` | `reconcile-required` 관측 로직 및 회복 규약 연동 강화 | 기존 `.omt/` 스냅샷 구조 유지, attempt 로그 append-only 보존 | `workflow-reconcile-check` | 상태 관측 체계 확립 후 구현 |
| `plugins/oh-my-teams/scripts/teams-org.mjs` | 자원 획득(`workflow-reserve`) 및 해제 시 권한(PL/PM) 연동 | 전역 슬롯 및 구독 할당량 명세(호환 구조) 기반 | `resource-slot-verify` | 자원 슬롯 명령과 권한 연계 후 적용 |
| `plugins/oh-my-teams/scripts/gates.mjs` | `acceptOutcome` 등 PM 전용 결정 로직과 review 기록 분리 | 기존 review input/output 스키마 보존 | `independent-review-gate` | 리뷰 기록 분리 후 도입 |
| 각 역할 SKILL 문서 및 테스트 | 주도적 에스컬레이션 조건 및 에러 처리 시나리오 추가 반영 | 기존 진행 중인 attempt 상태를 읽기 전용으로 보존 | `role-contract-update` | 위 런타임 변경 완료 후 갱신 |

- **자원 보존 정책**: 자원 슬롯과 workflow attempt 예약은 별개입니다. 자원 슬롯은 `teams-org.mjs` 명령을 통해 전역 관리되며, 획득/해제/시작실패/unknown 발생 시 역할별 권한(예: PL이 하위 worker 배정 실패 시 해제)에 맞춰 원래 위치에 보존 및 반환되어야 합니다. 네 kickoff 간의 전역 자원을 공유합니다.
- **미확정 의존성 처리**: 감사(Auditor), 적응형 편성, 모델 카탈로그, 정형 문서 체계 등 타 kickoff의 계약 접점은 현재 읽기 전용으로 취급하며, 임의로 선행 확정하지 않습니다.

## 9. 반증 시나리오와 수용 테스트 (Falsification Plan)

다음 시나리오들은 현행 실행 가능한 수용 테스트 및 후속 업무 계약 eval로 구분되어, 새 설계의 한계를 반증 가능하게 만듭니다. 'directorRequest'는 이사 실행을 위한 profile 입력 생성 함수이지 질문·결정 처리 API가 아님을 유의합니다.

1. **PM의 증거 없는 완료 선언 (후속 eval/구현 수용 테스트)**
   - **구체 입력/초기 상태**: PM이 `review-record`나 필수 테스트 통과 증거 없이 `worker_done`을 선언함.
   - **관측 필드 / 기대 행동**: `gates.mjs`의 `acceptOutcome`이 증거 누락을 감지하고 거부(`reject`)함.
   - **계측 및 임계값**: `unverifiable_completions_rejected` 카운터 증가 (임계값: 1회 이상 시 차단 성공).
   - **실패 조건 / 증거 파일**: 차단이 우회되어 완료 처리되면 런타임 구현 실패. (`.omt/evals/unverifiable-pm.json` 기록)
2. **범위 내 PM 판단의 사용자 전가 (후속 eval/구현 수용 테스트)**
   - **구체 입력/초기 상태**: PM이 자율 권한(예: 모델 풀 승격) 내의 문제를 사용자에게 `ask`를 통해 에스컬레이션 시도.
   - **관측 필드 / 기대 행동**: `workflow.mjs` 또는 에스컬레이션 게이트에서 `autonomy.md` 경계 위반으로 차단.
   - **계측 및 임계값**: `invalid_escalation_count` 분자(전가 시도)/분모(전체 판단) 비율 계산.
   - **실패 조건 / 증거 파일**: 불필요한 질문이 그대로 발송되면 실패. (`.omt/evals/invalid-escalation.json`)
3. **Auditor의 무근거 승인 (후속 eval/구현 수용 테스트)**
   - **구체 입력/초기 상태**: Auditor 역할이 반례나 논거 필드 없이 `approved` 판정 기록 제출.
   - **관측 필드 / 기대 행동**: `validateReviewInput`이 논거 부재를 감지하고 상태를 `changes-requested` 또는 거부로 유지.
   - **실패 조건 / 증거 파일**: 무근거 승인이 그대로 통과되면 실패. (`.omt/evals/groundless-audit.json`)
4. **unverifiable 상태의 중복 Dispatch (현행 실행 가능한 테스트 기반 보강)**
   - **구체 입력/초기 상태**: worker가 unverifiable 상태일 때 동일 Task ID로 다시 Dispatch 시도.
   - **관측 필드 / 기대 행동**: 런타임이 `already-started`가 아닌 `reconcile-required`로 처리하여 중복 생성을 억제함.
   - **실패 조건 / 증거 파일**: 중복 Dispatch가 발행되면 실패. (`.omt/evals/duplicate-dispatch.json`)
5. **한국어 언어검사기 룰 위반 자기 승인 (후속 위반 정정 평가)**
   - **구체 입력/초기 상태**: 한국어 작성 규칙 위반 텍스트를 작성자 스스로 승인 시도. (신규 구현 없는 상태 기반)
   - **관측 필드 / 기대 행동**: 보고 전 독립 검토 단계에서 리뷰어가 반려함을 관측.
   - **실패 조건 / 증거 파일**: 자기 승인으로 통과되면 실패.

## 10. 산출물 상태 및 다음 단계

- **문서 개정 상태**: 본 문서는 브리프가 요청한 **Revision 1**이며, 초안 반복 차수(예: Revision 2 재검토 등)와 구분되는 최종 산출물 버전입니다.
- **검토 및 HEAD 정보**: 
  - **작성자**: Senior (`proactive-senior-rework-2` 등 이전 실행 이력 보유)
  - **현재 HEAD**: `git log -1 --format="%H"` 명령 등을 통해 조회될 실제 커밋 SHA (작업 종료 시 DONE과 함께 보고됨).
  - **최종 독립 검토 상태**: 현재 미완료. PM의 이전 `.omt/proactive-pl-rereview2-notes.md`에 따라 9건의 finding이 해결되지 않았으며, 이사 지시 하에 PM은 새 HEAD에 대해 필수 검사와 별도 PL 독립 검토를 수행해야 승인할 수 있습니다.
  - **PM 워크트리 경계 위반 이력**: 과거 워크트리 밖 임시 파일 규정 위반 및 `.omt/proactive-rework2-report.json` 경로 충돌 이력이 있습니다. 
- **필수 검사 및 수용 조건**: 
  - PM `.omt/proactive-test-failure-investigation.json` 조사 결과(Node26, Node22 환경에서의 3초 미만 타임아웃 테스트 실패 등)는 기존 소스 실패(환경적/타임아웃 이슈)에 기인한 것으로, 이 문서 수용과는 구분되나 필수 검사 통과 조건 자체를 완화하지는 않습니다. (이사는 런타임/테스트 수정과 필수 게이트 완화를 금지했습니다.)
- **최종 승인 시 기록 항목 및 의존성**: 
  - 최종 독립 검토 뒤 승인 시, `review-record`에는 실제 작성자, 리뷰어, 커밋 HEAD, 해결된 finding 내역이 기록됩니다.
  - 향후 구현(Phase)은 `workflow.mjs`의 reconcile 고도화, `teams-org.mjs` 권한 연동 순으로 진행되며, 이슈 #139(Auditor) 및 적응형 편성 kickoff의 완료 여부에 의존성을 가집니다.

