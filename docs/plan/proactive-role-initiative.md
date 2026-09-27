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

- **사용자 직접 질문 금지**: 사용자에게 묻지 않고, 필요 시 PM이나 director를 거칩니다.
- **독립 승인 금지**: 자신이 만든 산출물을 스스로 승인할 수 없습니다.
- **감사의 독립성**: 감사는 근거 없이 수용하거나 이의를 덮지 않아야 하며, 구현자 역시 감사의 이의를 단순 무시(force)할 수 없습니다.
- **권한 밖 병합 금지**: 최종 병합은 오직 director의 close 절차에서만 이루어집니다.

## 6. 다른 kickoff에서의 관측 사례 5가지

현재 진행 중인 4개의 kickoff 사례들을 읽기 전용으로 조사하여 식별한 구체적 관측 사례(ID, 시각, 근거)와 새 계약 도입 시의 대응입니다.

1. **tui-idle 거부 (adaptive-team-staffing)**:
   - **ID/위치**: `attach-design-approved-1` (`.../events/000003-attach-design-approved-1.json`)
   - **시각**: `2026-09-27T13:56:10.295Z`
   - **근거**: `"refusal": {"kind": "execution-unconfigured", "code": "timeout", "message": "Terminal ... did not report tui-idle within 20000ms"}`
   - **새 계약**: 터미널이 idle 상태를 제때 보고하지 않으면 기다리지 않고 구체적 장애 원인을 기록한 뒤 재할당이나 fallback 전략으로 주도적 전환합니다.
2. **세션 유실 및 문서 누락 (adaptive-team-staffing)**:
   - **ID/위치**: `settle-design-dispatch-1` (`.../events/000004-settle-design-dispatch-1.json`)
   - **시각**: `2026-09-27T14:00:26.754Z`
   - **근거**: `evidence` 필드 내 `"documentRevision": "missing", "acceptance": "not-accepted"`로 남음.
   - **새 계약**: 모든 상태 전이는 문서 revision으로 기록하며, `missing`이 발생하면 이전 스냅샷부터 복구하는 회복 규약을 의무화합니다.
3. **반복 시작 (dynamic-model-catalogs)**:
   - **ID/위치**: `887d9471-7dae-4726-971f-6b3c32700846` (`.../plan/w1-rereview-start.json`)
   - **시각**: 발견 시점 `2026-09-27T14:38:10.152Z` (이전 `2026-09-27T14:17:28.501Z`)
   - **근거**: `"outcome": "already-started", "reason": "task-id-in-transcript"`로 중복 시작 감지됨.
   - **새 계약**: 정본 문서와 Task ID를 읽고 중복 생성을 원천 차단하며, 진행 중인 세션으로 즉시 재결합합니다.
4. **확인 불가 / stalled Goal 의심 (139-auditor)**:
   - **ID/위치**: `supervision/obs.json`
   - **시각**: `2026-09-27T13:27:10Z` (`lastActivityAt`)
   - **근거**: `unansweredRequests: 0`이나 활동이 정지됨. 네이티브 Goal 상태는 내부에서 보이지 않으므로 'stalled'로 섣불리 단정하지 않고 '확인 불가'로 구분.
   - **새 계약**: OMT 내부에서 프로세스를 감독하지 않으며, Orca 생명 주기를 따르되, 관측할 수 없는 상태에 의존하지 않고 명시된 orchestration 신호 기반으로만 진행을 재개합니다.
5. **독립 검토 및 의존성 지연 (structured-omt-documents)**:
   - **ID/위치**: `omt-docs-design` (`.../gates/omt-docs-design.json`)
   - **시각**: 파일 내 `taskHash` 생성 시점
   - **근거**: `"review-complete": {"status": "pending", "missing": ["design-independent-review"], "openFindings": ["pm-design-authorship-role-limit-conflict", ...]}` 상태로 계류됨.
   - **새 계약**: 의존성이 충족되지 않아 블록된 경우, 수동 개입을 기다리지 않고 PM에게 에스컬레이션하여 다른 역할을 배정하거나 의존성 우회(임시 호환 목록)를 요청하도록 합니다.

## 7. 회복 규약

매 세션마다 동일한 조회와 지시가 반복되지 않도록 합니다.
- 시스템은 재개 시 `.omt` 내의 문서 revision, 가장 마지막 결정 및 시도 ID를 조회합니다.
- 유실되거나 판정이 모호한 상태는 무조건 `진행 중` 또는 `종료`로 추정하지 않고, 마지막으로 검증된 문서 상태를 기반으로 이어서 작업합니다.

## 8. 변경 지점 및 호환 전략

OMT 내부에 새로운 타이머나 프로세스 감독기를 두지 않습니다.
- **Orca 연동**: OMT의 workflow는 Orca의 Run/Task/Dispatch와 1:1로 매핑되며, Orca의 생명주기를 그대로 수용합니다.
- **호환 전략**: 기존의 역할 프로필 스키마를 읽어오되, 적응형 편성 및 주도적 계약을 통해 실행 시점에만 권한과 상태 전이를 분리 적용합니다. 여러 kickoff 간에 자원 슬롯이 안전하게 공유되고 해제되도록 `workflow-reserve`를 적극 활용합니다.

## 9. 반증 시나리오와 계측값

본 설계를 반증(테스트 실패)할 수 있는 시나리오와 계측 기준입니다.

- **시나리오 A**: PM이 검증 증거가 없는 상태에서 `completed`를 선언함. → 런타임이 이를 거부하는지 확인.
- **시나리오 B**: 이사가 PM의 자율 권한 범위 내에 있는 결정(예: 모델 풀 내 승격)을 사용자에게 질문함. → `autonomy.md` 규정 위반으로 거부되는지 확인.
- **시나리오 C**: 감사가 명확한 증거나 논거 없이 상대의 주장을 수용함. → 이의 제기 절차가 없었음을 감지하여 실패.
- **시나리오 D**: worker가 `unverifiable` 상태인데 중복 Dispatch를 띄우는 현상 발생. → 중복 생성을 억제하는 로직의 작동 여부 확인.
- **계측값**:
  - `invalid_escalation_count` (사용자에게 불필요하게 물어본 횟수)
  - `unverifiable_completions_rejected` (증거 없이 완료 보고되었다가 차단된 횟수)
- **실패 기준**: 상기 계측값 중 하나라도 임계치를 초과하거나, 차단 로직이 우회되는 경우 해당 런타임 구현은 무효로 간주합니다.

## 10. 다음 단계 및 의존성

- **작성 및 검토**: 현재 설계안(Revision 1)은 Senior가 작성하였으며, 독립 검토를 위해 PM이 별도의 PL 검토를 배정할 수 있도록 보고를 준비합니다. 스스로 승인하지 않습니다.
- **의존성**: 이 설계는 #139 감사 역할 완성 및 정형 문서 체계와 밀접하게 연관되어 있으나, 런타임에서 강제할 수 있는 권한과 상태 전이는 독립적으로 구현될 예정입니다. 구현 전 검토 결과에 따라 수정될 수 있습니다.
