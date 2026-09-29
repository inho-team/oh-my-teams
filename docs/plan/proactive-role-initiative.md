# 주도적 역할 운영 설계 (Revision 2)

## 0. 문서 지위와 인용 기준

이 문서는 이사와 PM을 비롯한 OMT 역할이 확인 가능한 다음 행동을 스스로 정하도록 하는 운영 계약의 설계입니다. 런타임·스킬·스키마는 이번 단계에서 구현하지 않습니다.

- **인용 기준**: 모든 경로와 줄은 `main` 4c43b24499e8ba883bffb0a0979245e42ec100be(2.10.1)를 병합한 설계 브랜치의 작업 트리를 기준으로 합니다. 작성 시점의 49bbda0이나 이전 HEAD에서 읽은 줄은 쓰지 않습니다. 경로는 저장소 루트 기준이며 `plugins/oh-my-teams/`를 줄여 `P/`로 적습니다.
- **세 가지 범주를 구분합니다.**
  1. **현행 3-tier 계약**: 새로 구성한 조직에서 `director`(호스트 세션)가 사용자와 대화하고, `pm`이 계획·통합·수용을 맡고, `worker`가 구현·설계·독립 검토를 맡는 구조입니다. `ACTIVE_ROLES = ["pm", "worker"]`(`P/scripts/core.mjs:29`)와 `P/skills/worker/SKILL.md`가 근거입니다.
  2. **r15·r16 legacy 스냅샷**: 이미 시작한 kickoff가 저장한 `pm`·`pl`·`senior`·`junior` 4역할 조직입니다. 이번 설계 workflow의 조직은 revision 16이며, 회복 workflow `proactive-role-initiative-recovery-r15`의 조직은 revision 15입니다. 두 스냅샷 모두 `roles`가 `pm, pl, senior, junior`입니다. `ROLES`에 네 역할이 남아 있고(`core.mjs:26`) `foldRole`이 선언되지 않은 역할의 일을 상위로 넘깁니다(`core.mjs:162-176`, `resolveRole` 183). 새 조직에서 `worker`가 선언되면 `senior`·`junior` 일이 `worker`로 갑니다(`core.mjs:170-171`). 해당 스킬은 "기존 kickoff의 스냅샷을 완료하기 위한 호환 스킬"이라고 스스로 밝힙니다(`P/skills/pl/SKILL.md:3,8`, `senior/SKILL.md:3,8`, `junior/SKILL.md:3,8`).
  3. **이 설계의 제안**: 아래에서 `제안`이라고 표시한 항목입니다. 현재 런타임에 없으며 `auditor`가 여기에 속합니다.
- 이 문서는 회복 workflow r15의 단일 작성 실행이 만든 revision이며, 이미 종료된 r22의 기록을 소급해서 바꾸지 않습니다.

## 1. 역할별 현행 권한·금지·보고 (근거 대조)

### 1.1 현행 3-tier 계약

| 역할 | 할 수 있는 일 | 해서는 안 되는 일 | 보고 대상 | 근거 |
|---|---|---|---|---|
| director | 목표·수용 기준·전달 방식 확정과 브리프 작성, PM 세션 개시(`role-terminal --brief`), `kickoff-claim`, `director-inbox`·`director-reply`·`director-ack`·`director-watch`, `resource-acquire`·`resource-release`, `close`·`disband`, 주인 브랜치 병합 결정 | Goal 생성, Run 바인딩, `worker-start` 호출, 산출물 직접 작성, `delivery` 밖의 배포·병합, 네 경계 밖의 사용자 질문 | 사용자 | `P/skills/director/SKILL.md:14-22,28-34,96-110,113-135` |
| pm | 목표·범위·수용 기준 결정, `workflow-*` 관리, `worker-start` 래퍼로 Worker 시작, `terminal-idle-check`, Orca `run-create`·`check`·`send`·`reply`·`worker-list`·`worker-show`·`worker-read`, `supervision-wait`·`supervision-next`, `failure-classify`, `accept`, kickoff 워크트리 사이 병합, `director-signal`, 자원 슬롯 | 하위 역할이 있는데 산출물 직접 작성, 지시문에 patch 작성, 원시 `worker-start`, 모델·계정 변경, 자기 결과의 자기 검토 승인, 원본 체크아웃 병합, 네 경계 밖 `decision` 신호 | 이사 | `P/skills/pm/SKILL.md:26-41,43-45,47-59` |
| worker | 배정된 파일·검사 범위의 구현, 다른 실행 ID에서의 독립 검토와 `review-record`, `verify`, 자원 슬롯 확보·해제, `orchestration send/reply/ask`로 PM에게 보고 | `worker-start`·재위임, 계약 revision 변경, 원본 브랜치·외부 시스템 쓰기, push·PR·배포·병합, 사용자에게 직접 질문, 자기 결과 `accept` | PM | `P/skills/worker/SKILL.md:12-31`, `P/tests/three-tier.test.mjs:196`(같은 실행 ID의 검토를 거부) |

### 1.2 r15·r16 legacy 스냅샷 (기존 kickoff에만 적용)

| 역할 | 할 수 있는 일 | 해서는 안 되는 일 | 보고 대상 | 근거 |
|---|---|---|---|---|
| pl | 작업 분할·파동·파일 소유권 결정, `aggregate`·`verify`·`merge-check`, 통합 워크트리 병합 커밋. **Orca가 중첩 worker를 허용하고(깊이 2 이상) 자기 Run을 만든 경우에만** `role-terminal`, `terminal-idle-check`, `workflow-reserve` 뒤 `worker-start` 래퍼로 Senior·Junior를 시작하고, 자기가 시작한 역할의 터미널에만 `prompt-answer`를 쓴다 | 하위 역할이 있을 때 산출물 직접 작성·커밋, 통합 충돌 직접 수정, 시작 거부 시 작업 직접 수행, 원시 `worker-start`, `workflow-handoff` 직접 수행, `accept`, 자기 계획 승인 | PM | `P/skills/pl/SKILL.md:23,36-46,51-52,76` |
| senior | 인터페이스·순서·검증 설계, `draft`·`assist`·(허용 시) `advise`, `verify`, `review-record`·`gate-check`. **workflow task의 `role`이 `senior`인 구현 task를 직접 배정받았을 때만** 허용 파일 편집·커밋 | Junior가 있을 때 구현 task 밖의 편집, patch 작성, `worker-start`·Dispatch 생성, 자기 변경의 독립 승인, `accept`, 스스로 위험 수용, push·PR·병합 | 배정자(PL, 없으면 PM) | `P/skills/senior/SKILL.md:18-23,33-40` |
| junior | 허용 파일 편집·테스트, `verify`, `assist` | `worker-start`·재위임, 범위·수용 기준·검사·계약 revision 변경, `review-record`·`accept`, push·PR·병합, 검토·수용 문서 갱신 | 배정자(PL, 없으면 PM) | `P/skills/junior/SKILL.md:18-20,28-36` |

### 1.3 제안 역할과 알려진 불일치

- **auditor(제안)**: 현행 `ROLES`(`core.mjs:26`)와 조직 스냅샷 revision 15·16에 없으며, 어떤 스킬·게이트도 이 역할에 전이를 주지 않습니다. 구현은 별도 kickoff(브리프 `139-auditor-2026-09-27.md`)이며, 이 문서는 그 계약을 확정하지 않고 §5.3에서 반증 조건만 정합니다.
- **`accepted-risk` 결정자 불일치**: `senior` 스킬은 결정자를 PM·사용자로 적지만(`senior/SKILL.md:36`) 런타임은 `pm`, `user`, `director`를 허용합니다(`P/scripts/gates.mjs:27-31`). 어느 쪽을 정본으로 할지는 후속 구현 단계에서 정하며, 이 설계는 이사를 결정자로 쓰는 것을 제안하지 않습니다.
- **역할 게이트의 상위 허용**: 검토자의 서열이 요구 역할 이상이면 통과하지만(`gates.mjs:52-58`) 실행 ID가 다르지 않으면 거부합니다(`gates.mjs:126-133` 부근의 `Independent review must use a different execution identity`). `worker`가 요구되면 `worker`와 `pm`만 통과합니다(`gates.mjs:53-54`).

## 2. 지속 객체의 소유자와 상태 전이

Orca가 소유한 생명주기는 OMT가 복제하지 않습니다(`P/references/orca-runtime.md:3,15-17`, 프로젝트 `AGENTS.md`의 아키텍처 규칙). Orca 조회는 반드시 `orca orchestration <명령>` 이름공간을 쓰며, 이 머신의 `orca 1.4.212`가 제공하는 명령은 `run-create`, `run-use`, `run-current`, `run-list`, `run-show`, `send`, `check`, `reply`, `inbox`, `task-create`, `task-list`, `task-update`, `worker-start`, `worker-show`, `worker-read`, `worker-stop`, `worker-abandon`, `worker-release`, `worker-retain`, `worker-list`, `dispatch`, `request-show`, `dispatch-show`, `ask`, `gate-create`, `gate-resolve`, `gate-list`, `reset`입니다(`orca orchestration --help`로 확인). `orca dispatch list`, `orca run-show`처럼 이름공간이 없는 명령은 존재하지 않습니다.

| 객체 | 소유자 | 정본과 조회 경로 | 생성 | 정산·종료 | 보존 |
|---|---|---|---|---|---|
| organization | 사용자 결정, 저장은 `form`·`adjust` | `.omt/organization.json`, `teams-org show/validate` | `form`·`init` | 진행 중 kickoff에는 스냅샷을 유지 | 수정 시 revision 증가 |
| brief | director | `.omt/briefs/*.md` | director가 사용자 확정 후 작성 | kickoff 내 불변 | 파일로 보존 |
| kickoff 등록부 | director | `.omt/kickoffs/*.json`, `kickoff-show`(`P/scripts/teams-org.mjs:427`) | `kickoff-claim`(`kickoff-registry.mjs:427`) | `kickoff-check-close-ready`, `kickoff-merge-record`(`:707`), `kickoff-release`(`:769`, 사유는 `completed`·`disbanded`·`taken-over`) | 항목 분류 `current`·`legacy`·`integrity-failure`(`:170`) |
| Goal | Orca·호스트 세션의 기능이며 PM 세션이 만듦 | 호스트의 Goal 상태 | PM 세션 | 호스트가 종료 | OMT는 복제하지 않고 `kickoff-bind`로 Run ID만 등록부에 기록(`:539`) |
| Run | Orca | `orca orchestration run-current/run-list/run-show` | PM이 `run-create`로 만들고 바인딩 | Orca | `unverifiable`은 종료가 아님 |
| Orca Task·Dispatch | Orca | `task-list`, `dispatch-show`, `worker-show`, `request-show` | `worker-start --spec`이 Task와 첫 Dispatch를 함께 만듦 | worker의 `worker_done` 또는 Orca settlement | receipt에 `runId`·`taskId`·`dispatchId`·`executionId`·`worktreeId` 다섯 개가 모두 있어야 OMT가 붙임(`P/skills/pl/SKILL.md:103`) |
| OMT task 계약·상태 | PM | `.omt/workflows/<id>/tasks/`, `workflow-status` | `workflow-create`(`workflow.mjs:264`) | `pending`→`reserved`→`running`→`submitted`→`review-pending`→`reviewed`→`accepted`, 또는 `failed`(`:40`의 `occupiesSlot`은 `reserved`·`running`) | 이벤트와 attempt 이력 |
| workflow | PM | `workflow-status`, 상태는 `deriveWorkflowStatus`(`:608`)가 `ready`·`running`·`blocked`·`integration-pending`·`accepted`로 계산 | `workflow-create` | `workflow-accept` | 기존 attempt·조직 스냅샷 보존 |
| worker | Orca | `worker-list`, `worker-show` | `worker-start` 래퍼 | Orca settlement, 종료 확인 전에는 `worker-stop`·`worker-abandon`으로 fence | liveness는 `live`·`unverifiable`·`exited`(`orca-runtime.md:398-408`, `P/scripts/status.mjs:29-46`) |
| 자원 슬롯 | director 또는 PM | `.omt` 슬롯 파일, `director-watch` | `resource-acquire`(`P/scripts/resources.mjs:147`) | `resource-release`(`:229`) 또는 소유 PID 종료 후 다음 획득 때 회수 | 소유자를 모르는 슬롯(`--owner-pid` 생략)은 자동 회수하지 않고 `resource-release`만 해제 |
| 검증 증거 | 검사를 실행한 역할 | `.omt/evidence/`, `verify` | `verify` | 소스 fingerprint에 고정 | 실패 증거도 보존 |
| review·gate·수용 | review는 검토 실행, 수용은 PM | `.omt/reviews/`, `.omt/gates/`, `.omt/decisions/` | `review-record`(`gates.mjs:472`), `accept`(`:549`) | 게이트는 `contract-ready`·`checks-passed`·`review-complete`·`outcome-accepted` 네 항목이며 PM 수용이 마지막(`:406`) | 이력은 불변 기록 |
| 이사 신호 | PM이 생성, 이사가 처리 | `.omt/director/inbox`, `director-inbox`(`director.mjs:554`) | `director-signal`, 종류는 `decision`·`close-ready`·`blocked`·`progress`(`:28`) | `replied`(`:584`), `acknowledged`(`:734`), `superseded`, `closed` | `progress`는 수신 확인 상태로 기록 |
| `.omt` 정형 문서 | 단계별 작성 역할 | `doc-resolve-kickoff`→`doc-id`→`doc-show`(`orca-runtime.md:455-463`) | `doc-save` | 문서 상태 `open`·`in-review`·`resolved`(`P/scripts/documents.mjs:43`) | revision |
| 최종 전달 | director | 브리프의 `delivery`(`local-merge`·`pull-request`·`none`, `kickoff-registry.mjs:33`) | `close` | `deliver`(`P/scripts/delivery.mjs:165`)와 `kickoff-merge-record` | 병합 커밋 |
| 감사·이의 | 제안, 현재 없음 | 없음 | 없음 | 없음 | 없음 |

## 3. 역할별 사건 표

각 행은 `사건 → 판단 근거와 선행 상태 → 허용된 다음 행동(담당) → 완료 증거 → 상위 보고`입니다. 사용자 결정을 기다리는 동안의 규칙은 모든 행에 공통이며 §4.2가 정합니다.

### 3.1 director

| 사건 | 근거·선행 상태 | 다음 행동 | 완료 증거 | 상위 보고 |
|---|---|---|---|---|
| 시작 | 사용자 요청, 등록부에 같은 목표 없음 | `kickoff-show`로 재개 여부 확인 → 네 항목을 한 번에 확정 → 브리프 작성 → `role-terminal --brief` → `kickoff-claim` | 등록부 항목, `director.terminalHandle` 기록 | 사용자 |
| 배정 | task 배정은 PM 권한(`director/SKILL.md:30`) | 수행하지 않음. 목표 변경이 필요하면 브리프를 고쳐 PM에게 전달 | 없음 | 사용자 |
| 반려·재작업 | 검토 반려는 PM의 `workflow-rework` 소관 | 수행하지 않음. PM의 `progress`에서 결정 근거를 확인 | `director-inbox`의 신호 | 다음 사용자 보고에 요약 |
| 정체 | `director-watch`의 signals·slots·PM liveness·`providerOverload`(`director/SKILL.md:103-105`) | `unknown`은 정상으로 보지 않음. 근거가 있으면 PM 터미널을 확인하고 PM에게 메시지, 슬롯은 필요한 것만 해제 | watch 결과 시각, 메시지 ID | 사용자에게 `무응답`으로 정확히 표기 |
| 오류 | PM `blocked` 신호 | 원인이 네 경계인지 분류. 아니면 `director-reply`로 직접 결정 | `director-reply` 기록(`notified` 확인) | 결정과 근거 한 줄 |
| 사용자 결정 대기 | `decision`이 네 경계 중 하나 | 권장안을 붙여 한 번만 질문, 답 전에 권장안 실행 금지 | 질문 메시지, `blocked` 표기 | 사용자 |
| 독립 작업 | 결정과 무관한 다른 kickoff | 다른 kickoff의 신호·close 처리를 계속 | 각 kickoff의 신호 상태 | 사용자 |
| 검증 | `close-ready`의 HEAD와 통합 워크트리 | `kickoff-check-close-ready`로 HEAD 대조(`director/SKILL.md:111,120`) | 검사 결과 | 사용자 |
| close | 검증 통과, 전달 방식 확정 | `close`로 전달·병합·정리, 실패·취소는 `disband` | 병합 커밋, `kickoff-merge-record`, `kickoff-release` | 사용자(최종 소유자) |

### 3.2 pm

| 사건 | 근거·선행 상태 | 다음 행동 | 완료 증거 | 상위 보고 |
|---|---|---|---|---|
| 시작 | 브리프가 첫 사용자 턴, `kickoff-handoff-verify`의 `match`(`pm/SKILL.md:12-20`) | 등록부·workflow 상태 조회 → task v2 분할 → `workflow-create` | workflow 상태 revision | 이사 `progress`(깊이와 이유 포함) |
| 배정 | task `pending`, 의존성 충족, `terminal-idle-check` 통과 | `workflow-reserve` → `worker-start` 래퍼 → `workflow-attach` | receipt 다섯 ID | 이사 `progress` |
| 반려 | 검토가 `changes-requested`·`inconclusive`·열린 finding | `workflow-retry`가 아니라 `workflow-rework`로 같은 attempt 연결(`pm/SKILL.md:142-153`, `workflow.mjs:1740`). 호출 한도가 없으면 사용자 예산 결정 | rework 이벤트, 수정 실행 ID | 이사 `progress` |
| 재작업(수동) | 검토 요구 없이 정산된 task를 되돌려야 함 | `workflow-reopen`(새 attempt, 전체 예산 소비, `workflow.mjs:1992`) | `task-reopened` 이벤트 | 이사 |
| 정체 | worker가 `worker_done` 없음 | `supervision-wait` 후 `supervision-next`(`status.mjs:92`)의 `wait`·`ask-progress`·`inspect`·`escalate` 결정 | 관측 파일의 `lastActivityAt`·`unansweredRequests`·`inspections` | 이사 `escalate` 증거 |
| 오류 | 정산이 `failed` | `failure-classify`의 `nextOwner`·`action`, `resolvedBy`가 같을 때 `workflow-retry`(`workflow.mjs:1888`) | retry attempt 이벤트 | 이사 `progress` |
| 예약 해소 | 실행기가 worker를 만들지 못함 | `workflow-release`: `resolution`과 `evidence` 필수, `refusal.kind`가 `not-started`일 때만 attempt를 돌려받음(`workflow.mjs:1558-1626`) | `reservation-released` 이벤트 | 이사 |
| 사용자 결정 대기 | 네 경계 중 하나 | `director-signal --kind decision`을 한 번 보내고 무관한 workflow를 계속 진행 | 신호 ID | 이사 |
| 독립 작업 | 결정 대기 중 | 다른 task 배정·검증 계속, 모두 막히면 `blocked` | 다른 task 이벤트 | 이사 `blocked` |
| 검증 | 필수 검토 통과 | `accept`(PM 실행 ID, 전체 criteria, basis 필요, `gates.mjs:564-600`) → `workflow-resume` → 통합 → `workflow-accept` | decision 파일, gate `accepted` | 이사 |
| close | 통합 워크트리 검증 HEAD | `director-signal --kind close-ready --head --source`. 주인 체크아웃에는 병합하지 않음(`pm/SKILL.md:39`) | 신호 ID, HEAD | 이사 |

### 3.3 worker

| 사건 | 근거·선행 상태 | 다음 행동 | 완료 증거 | 상위 보고 |
|---|---|---|---|---|
| 시작 | PM이 준 지시문 머리글의 계약 | 수용 기준·허용 파일·검사 확인 후 착수 | 첫 heartbeat | PM |
| 배정 | 작업 계약 | 범위 안에서 구현 또는 검토 | 변경 파일, `verify` 증거 | PM |
| 반려·재작업 | PM이 finding과 rework receipt 전달 | 같은 워크트리에서 finding을 고치고 새 실행으로 정산 | 수정 커밋, 재`verify` | PM |
| 정체·오류 | 검사 실패, 의존성 부재 | 범위 안에서 원인 분석·접근 변경. 계약 변경이 필요하면 증거와 함께 PM에게 요청 | 실패 증거 | PM |
| 사용자 결정 대기 | 사용자에게 직접 묻지 않음(`worker/SKILL.md:30`) | PM에게 질문(`ask`)하고 결정과 무관한 범위는 계속 | `ask` ID | PM |
| 독립 작업 | 다른 실행의 결과를 검토 | 구현 실행과 다른 실행 ID·별도 워크트리에서 소스와 검사 증거 확인 | `review-record` | PM |
| 검증 | 제출 전 | 수용 기준 대조와 `verify`, 실패하는 검사는 제출하지 않음 | 통과 증거 | PM |
| close | 작업 종료 | `worker_done`을 한 번만 보냄, 자기 결과는 `accept`하지 않음 | 메시지 ID | PM |

### 3.4 legacy PL

| 사건 | 근거·선행 상태 | 다음 행동 | 완료 증거 | 상위 보고 |
|---|---|---|---|---|
| 시작 | PM 지시문 | 조직 스냅샷과 범위 읽기, 분할 계획 작성 | 계획 | PM |
| 배정(깊이 1) | Orca 기본 중첩 깊이 1, 새 Run도 깊이를 초기화하지 않음(`pl/SKILL.md:51`) | 시작하지 않고 분할 계획과 거부 원문을 PM에게 돌려주며 `worker_done --outcome failed`(`:76`) | 평평한 배정 계획 | PM |
| 배정(깊이 2 이상) | 사용자가 Nested worker depth를 올림 | `run-create` → `role-worktree-create` → `terminal-idle-check` → `workflow-reserve` → `worker-start`(`:23,54-64`) | receipt | PM |
| 반려·재작업 | 통합 충돌 | 직접 고치지 않고 충돌 파일과 조건을 담당자에게 되돌림(`:37`) | 반환 메시지 | PM |
| 정체 | 감독 worker 무응답 | `supervision-wait`, `supervision-next`. 사용 한도로 보이면 `worker-limit-check`를 `escalation`으로 PM에게(`:41`) | escalation ID | PM |
| 오류 | 시작 거부(`nested_worker_depth_exceeded`, `agent_unconfigured` 등) | 스스로 수행하지 않고 코드·원문과 계획을 PM에게(`:39`) | 거부 원문 | PM |
| 사용자 결정 대기 | 사용자에게 묻지 않음 | 결정이 필요하면 PM에게 `escalation`, 무관한 분할은 계속 | 메시지 ID | PM |
| 독립 작업 | 다른 파동 | 의존성 없는 파동의 분할·통합 계속 | 통합 기록 | PM |
| 검증 | 하위 task 제출 | `aggregate`, `verify`, `merge-check`로 통합 검증. 의미 검토는 Senior에게(`:43`) | evidence 키 | PM |
| close | 통합 완료 | 통합 워크트리·검증 HEAD·작업 ID·미해결 사항을 PM에게 보고. `accept`·주인 병합은 하지 않음(`:42,113`) | 보고 | PM |

### 3.5 legacy Senior

| 사건 | 근거·선행 상태 | 다음 행동 | 완료 증거 | 상위 보고 |
|---|---|---|---|---|
| 시작 | 배정자 지시문 | 범위·검사 결과부터 읽기 | 첫 heartbeat | PL 또는 PM |
| 배정 | 설계·검토 task 또는 `role: senior` 구현 task | 설계는 인터페이스·순서·실패 조건·검증 방법, 구현은 허용 파일만 편집(`senior/SKILL.md:18-21`) | 설계 파일, 커밋 | PL 또는 PM |
| 반려·재작업 | 검토 finding 수신 | 같은 attempt에서 수정(Junior 반려 뒤 Senior 인계는 전환 기록 필요, `pm/SKILL.md:88`) | 수정 커밋 | PL 또는 PM |
| 정체·오류 | 검사·의존성 실패 | 범위 안에서 원인 분석과 대안 탐색(`assist`·`advise`), 해소 불가면 거부 코드와 증거로 상향(`:38`) | 실패 증거 | PL 또는 PM |
| 사용자 결정 대기 | 사용자에게 묻지 않음 | 배정자에게 `ask`, 무관한 검토는 계속 | `ask` ID | PL 또는 PM |
| 독립 작업 | 다른 실행의 산출물 검토 | 실행 ID가 다른 검토만 `review-record`. 열린 finding을 생략해 해결 처리하지 않음(`:54`) | review 파일 | PL 또는 PM |
| 검증 | 제출 전 | 수용 기준 대조와 `verify`(`:27`) | 통과 증거 | PL 또는 PM |
| close | 종료 | `worker_done` 한 번. 자신이 설계·작성한 변경을 승인하지 않고 `accept`·위험 수용·push·병합을 하지 않음(`:36-37`) | 메시지 ID | PL 또는 PM |

### 3.6 legacy Junior

| 사건 | 근거·선행 상태 | 다음 행동 | 완료 증거 | 상위 보고 |
|---|---|---|---|---|
| 시작 | 배정자 지시문 | 계약 revision·허용 파일·수용 기준·검사 명령 확인 | 첫 heartbeat | PL 또는 PM |
| 배정 | 닫힌 범위의 수정 | 허용 파일만 편집·커밋, `git add .` 금지(`junior/SKILL.md:18,49`) | 커밋 | PL 또는 PM |
| 반려 | 첫 검토 반려 | 수정은 Senior에게 넘어감(`:36,51`) | 인계 기록 | PL 또는 PM |
| 재작업 | 같은 task의 finding | 범위 안에서 수정, 범위 변경은 근거와 함께 요청 | 수정 커밋 | PL 또는 PM |
| 정체·오류 | 반복 실패, 설계 판단 필요 | 결론 내리지 않고 거부 코드·실패 증거로 상향(`:33`) | 실패 증거 | PL 또는 PM |
| 사용자 결정 대기 | 사용자에게 묻지 않음 | 배정자에게 `ask`, 무관한 파일 작업은 계속 | `ask` ID | PL 또는 PM |
| 독립 작업 | 좁은 반복 편집, 인용 수집 | 직접 처리, 같은 파일의 동시 편집 금지(`:43,47`) | 커밋 | PL 또는 PM |
| 검증 | 제출 전 | 수용 기준을 하나씩 대조하고 `verify`(`:24,51`) | 통과 증거 | PL 또는 PM |
| close | 종료 | 변경 파일·검사 결과·미해결 사항·report 경로와 함께 `worker_done`. 지시문에서 옮겨 적은 사실을 남기며 자기 결과를 `review-record`·`accept`로 승인하지 않음(`:30-31`) | 메시지 ID | PL 또는 PM |

## 4. 사용자 확인 경계

### 4.1 네 경계(정본 `P/references/autonomy.md:9-14`)

1. **확정한 계약의 변경**: 목표, 수용 기준, 비목표, 전달 방식(`delivery`), 주 버전(`:11`).
2. **브리프에 없는 새 범위**: 범위 안에서 끝낼 수 없다는 사실과 다음 kickoff 분리안을 함께 올림(`:12`).
3. **되돌릴 수 없고 사용자가 소유한 대상**: 외부 발송, 배포, 원격 push, 주인 체크아웃 밖의 삭제, 사용자 설정 파일 변경, 새 과금 계정·구독(`:13`).
4. **사용자만 아는 암묵지**: 기록·명령으로 확인할 수 없는 사실, kickoff 사이의 우선순위, 일정 등(`:14`).

묻지 않고 정하는 일은 실행 깊이, 역할 배정, 선언된 프로필 안의 모델, 분할·순서, 검토 지적 수용과 재작업 범위, 실패 원인 판정, 접근 방법 변경, 남은 예산 안의 재시도, 전달 방식을 바꾸지 않는 형식, 워크트리 내부 정리와 자원 슬롯입니다(`:18-25`).

### 4.2 적용 주체와 절차

| 주체 | 규칙 | 근거 |
|---|---|---|
| PM | 네 경계만 `director-signal --kind decision`. 나머지는 스스로 정한 뒤 `progress`로 알리고 결정 근거와 되돌리는 방법을 적음 | `autonomy.md:7,37`, `pm/SKILL.md:58` |
| director | `decision`을 받으면 네 경계인지 먼저 재분류. 아니면 사용자에게 올리지 않고 `director-reply`로 직접 결정하고, 다음 사용자 보고에 결정과 근거를 한 줄로 적음 | `autonomy.md:37`, `director/SKILL.md:33` |
| 묻기로 정했을 때 | 기록·명령으로 답을 구할 수 있으면 묻지 않음 → 한 번에 질문 → 권장안과 근거 첨부, 답 전 실행 금지 → 결정과 무관한 일은 계속 → 진행 불가할 때만 `blocked`로 남기고 다른 kickoff 진행 | `autonomy.md:29-33` |
| worker·legacy PL·Senior·Junior | 사용자에게 직접 묻지 않음. 결정이 필요하면 배정자에게 `ask` 또는 `escalation`으로 올리고, 범위 안의 원인 분석과 접근 변경은 스스로 함 | `worker/SKILL.md:30`, `pl/SKILL.md:44`, `senior/SKILL.md:38`, `junior/SKILL.md:33` |

### 4.3 결정 기록 형식(제안)

자율 결정을 `progress`나 `director-reply`에 적을 때는 다음 네 항목을 첫 줄 뒤에 둡니다: `결정`, `근거(경로·줄 또는 메시지 ID)`, `되돌리는 방법`, `영향받는 범위`. 이 형식은 현재 런타임이 검사하지 않으므로 제안이며, 검사는 §5의 후속 eval에서 다룹니다.

## 5. 하위 역할과 감사의 주도성 한계

### 5.1 legacy·현행 역할별 사건 표

| 역할 | 사건 | 범위 안에서 스스로 하는 일 | 중단·상향 조건 | 금지 | 완료·보고 증거 |
|---|---|---|---|---|---|
| worker | 구현 실패 | 원인 분석, 접근 방법 변경, 허용 파일 안의 좁은 수정, 재`verify` | 계약·수용 기준·검사 변경이 필요할 때, 허용 파일 밖을 건드려야 할 때 | 계약 revision 변경, 재위임, 자기 `accept` | 실패·재검사 증거, `worker_done` |
| worker | 독립 검토 | 소스·검사 증거 확인, 모든 criterion 판정 | 실행 ID가 구현과 같을 때, 검사가 실패할 때(승인 금지) | 자기 결과 승인 | `review-record`(`gates.mjs:107-175`) |
| legacy PL | 통합 충돌 | 충돌 파일·조건을 정리해 담당자에게 반환, 다음 파동 제안 | 시작 거부, 사용 한도, 깊이 부족 | 충돌 직접 수정, 직접 수행, `accept` | 반환 메시지, 거부 원문 |
| legacy Senior | 설계·검토 | 대안·반례 수집(`assist`), finding을 한 번에 모두 기록 | 검토 형식 오류는 검토자가 직접 수정, 위험 수용 요청은 PM·사용자 결정 | patch 작성, 자기 변경 승인, 위험 자기 수용 | review 파일, `verify` |
| legacy Junior | 구현 | 좁은 범위의 코드·테스트 작성, 실패 로그 확보 | 반복 실패, 설계 판단, 범위 변경 필요 | 범위 변경, 재위임, 자기 승인 | 수용 기준 대조표가 든 `worker_done` |

### 5.2 사용자 직접 질문·자기 승인·권한 밖 병합 금지(현행 근거)

사용자 직접 질문은 director만 하며(`director/SKILL.md:8,33`), 자기 산출물의 독립 승인은 런타임이 실행 ID 비교로 거부하고(`gates.mjs:126-133`, 테스트 `P/tests/three-tier.test.mjs:196`, `omt-documents.test.mjs:666`), 주인 체크아웃 병합은 director의 `close`만 수행합니다(`pm/SKILL.md:39`, `pl/SKILL.md:113`, `worker/SKILL.md:29`).

### 5.3 auditor(제안)의 반증 조건

- 근거(반례 또는 재현 경로) 없이 `approved`나 `accepted-risk`를 기록하려는 시도는 거부되어야 합니다.
- `accepted-risk`는 결정자(`authority`)와 `reason`이 있어야 하며 감사 역할이 스스로 결정자가 되지 않습니다.
- 감사 역할은 병합·`accept`·`close`를 할 수 없습니다.
- 위 세 조건은 현재 어떤 런타임에도 없으므로, 구현 kickoff가 확정한 계약과 충돌하면 그쪽을 따릅니다.

## 6. 다른 kickoff의 관측 사례 (읽기 전용)

모든 원천은 알려진 저장소 또는 이 PM의 지정 증거 경로에서 직접 읽었습니다. 값이 원천에 없으면 `미기록`, 원천 파일이 이 환경에서 확인되지 않으면 `미확인`이라고 적습니다. 다른 PM state를 광범위하게 검색하지 않았습니다.

| # | 사례 | 원천(전체 경로) | 원문 관측 | 원천에 있는 시각·ID | 원인 추론(추론임) | 현재 안전한 대응 | 새 계약의 다음 행동(제안) |
|---|---|---|---|---|---|---|---|
| 1 | `tui-idle` 거부 | `/Users/jinsungkim/orca/workspaces/oh-my-teams/feat-adaptive-team-staffing/.omt/workflows/adaptive-staffing-wave1/events/000003-attach-design-approved-1.json` | `refusal.code: "timeout"`, `kind: "execution-unconfigured"`, "did not report tui-idle within 20000ms ... no Dispatch was created. Do not repeat the start". 사용자 승인의 inject 대체 경로로 시작, `liveness: "unverifiable"`, `modelProof: "unproven"` | `recordedAt` 2026-09-27T13:56:10.295Z, Dispatch·execution `ctx_8f73f360dc76`, Run `run_6f45952f5d6d`, Task `task_066834c2a23d`, 터미널 `term_45a4c0de-…`, 이벤트 ID `attach-design-approved-1` | 터미널이 20초 안에 idle을 보고하지 않음. 원인은 원천에 없음 | 시작을 반복하지 않음(`orca-runtime.md`의 worker-start 실패 복구), 원시 `dispatch --inject` 우회 금지(`pm/SKILL.md:34`) | 거부 코드·원문을 증거로 상위에 한 번 보고하고, `terminal-idle-check`→`prompt-answer`→재점검을 PM이 수행 |
| 2 | 미측정 정산과 후속 검토 누락 | `.../feat-adaptive-team-staffing/.omt/workflows/adaptive-staffing-wave1/events/000004-settle-design-dispatch-1.json` | `outcome: "settled"`, `callsUsed: 0`, `interactiveUsage: "unmeasurable"`, `documentRevision: "missing"`, `acceptance: "not-accepted"`, `followup: "independent review and design corrections required"` | `recordedAt` 2026-09-27T14:00:26.754Z, `executionId ctx_8f73f360dc76`, 메시지 `msg_3c9ff7be134a`, `completedAt` 2026-09-27T13:58:50.800Z, head `fe50a40…` | `callsUsed: 0`은 work 하네스 호출만 뜻하므로 사용량이 0이라는 증거가 아님(원문 `callsUsedMeaning`) | 정산은 수용이 아님. 독립 검토 전까지 `submitted`로 유지 | 정산 이벤트에 `documentRevision`이 `missing`이면 PM이 문서 저장을 다음 행동으로 선택하고 이사에 `progress` |
| 3 | 관측 기록의 시각 동일 | `.../feat-139-auditor/.omt/supervision/obs.json` | `{"liveness":"live","lastActivityAt":"2026-09-27T13:27:10Z","now":"2026-09-27T13:27:10Z","unansweredRequests":0,"inspections":0}` | `lastActivityAt`=`now`=2026-09-27T13:27:10Z, ID 없음 | `nextSupervisionAction` 입력 파일임. `lastActivityAt`이 `now`와 같으면 무응답 시간이 0이므로 `wait`이 되는 것이 기대 동작이며, 이 파일만으로 Goal이 stalled였다는 결론은 나오지 않음(이전 revision의 "OMT 타이머 추정 오류" 서술은 원천이 뒷받침하지 않아 철회) | 관측 파일은 `worker-list`·`worker-show` 조회 결과로만 채움(`orca-runtime.md:322-324`) | 관측 입력의 출처를 기록하고, 값이 같은 시각이면 새 활동으로 보아 세 값을 비움(`orca-runtime.md:326`) |
| 4 | 다른 kickoff의 수정이 선행 조건 | `/Users/jinsungkim/orca/workspaces/oh-my-teams/docs-proactive-role-initiative/.omt/proactive-runtime-fix-dependency.json`, `.../proactive-test-failure-investigation.json` | 기준 HEAD에서도 `tests/opencodex.test.mjs:1568`의 ready-timeout assertion이 Node22·26에서 실패, 수정은 별도 fix kickoff `fix-opencodex-ready-timeout`(Run `run_62e0ba4c825c`)의 소관. 관측 시점에 `processLiveness: "not-observed"` | 결정 신호 `4791892c-9e7e-4684-8b63-d3456259cca7`, 메시지 `msg_42fe52058ce2`·`msg_bbf7a529f0af`, 기록 2026-09-27T16:05:50.655Z | 검사 실패의 원인이 이 kickoff의 변경이 아님(기준 HEAD 비교로 확인됨) | 이 kickoff는 런타임·테스트를 고치지 않고 게이트도 완화하지 않음 | 선행 kickoff의 main 통합 여부를 `git merge-base --is-ancestor`로 확인한 뒤 진행. 현재 main에는 `04e423f`가 병합되어 있음(§9) |
| 5 | 세션의 작업 트리 경계 이탈 | `.../docs-proactive-role-initiative/.omt/proactive-rework4-worktree-boundary.json` | `declaredCwd`는 `.../docs-proactive-design`인데 실제 커밋은 `.../docs-proactive-role-initiative`의 `ed5bd25…`에서 발생 | 실행 `proactive-senior-rework-4`, stream `headless/proactive-senior-rework-4/turns/1/stream.jsonl` | 헤드리스 실행이 선언 cwd 밖에서 커밋(원인 세부는 기록 없음) | 해당 커밋을 수용·검토 증거로 쓰지 않음. 경계 기록 보존 | 커밋 전에 `git rev-parse --show-toplevel`이 브리프의 워크트리와 같은지 확인하고 다르면 중단 후 상향 |
| 6 | 보고 파일 이름 충돌 | `.../docs-proactive-role-initiative/.omt/proactive-report-name-collision.json` | PM 검증 보고 경로가 Senior 보고 경로와 겹쳐 원본 전체를 복원하지 못함 | 실행 `proactive-senior-rework-2`, 원본 stream 조각만 존재 | 저자·검증 보고가 같은 경로를 씀 | 유실된 보고를 검토·수용 증거로 쓰지 않음 | 보고 경로에 역할·실행 ID를 넣어 분리 |
| 7 | 헤더리스 시작 receipt의 Run 부재 | `.../docs-proactive-role-initiative/.omt/proactive-pl-final-review2-start.json` | receipt에 `via: "headless-start"`, `runId: null`, `dispatchId: "headless:proactive-pl-final-review-2"`, `runnerPid: 86270` | `createdAt` 2026-09-27T16:40:55.732Z | 2026-09-28부터 세션 없는 실행은 새로 시작할 수 없고 기록·복구용 역사 근거로만 읽음(`orca-runtime.md:5`) | 이 receipt에서 Orca worker 상태를 추정하지 않음 | 새 실행은 역할 터미널의 Orca receipt(다섯 ID)로만 시작 |
| 8 | `dynamic-model-catalogs`의 `already-started` | 이전 revision이 인용한 `feat-dynamic-model-catalogs/.omt/plan/w1-rereview-start.json` | **미확인**: 이 환경의 알려진 저장소에 해당 워크트리·파일이 없음 | 미확인 | 미확인 | 원문을 모르므로 결론을 내리지 않음 | 원천 확보 전에는 새 계약의 근거로 쓰지 않음 |
| 9 | `structured-omt-documents`의 열린 finding | 이전 revision이 인용한 `feat-structured-omt-documents/.omt/gates/omt-docs-design.json` | **미확인**: 위와 같음 | 미확인 | 미확인 | 위와 같음 | 위와 같음 |

브리프 조건 6의 최소 다섯 사례는 1~5번이 충족합니다. 6·7번은 참고이고 8·9번은 이전 revision의 인용이 이 환경에서 검증되지 않아 결론에서 제외했습니다.

## 7. 회복과 권한 있는 관측 규약

정본은 OMT 파일(workflow 상태와 이벤트 ID, 문서 revision, receipt, 신호 ID)과 Orca 관측(Run, Dispatch, worker, 메시지)이며, 둘이 어긋나면 해소하기 전에는 `진행 중`이나 `종료`로 추정하지 않습니다(`orca-runtime.md:398-408`).

1. **실행 파일 확인**: `orca-cli` discovery로 실행 파일을 하나 고르고 조회 실패·버전 불일치·필드 변경을 서로 다른 오류로 보존합니다(`orca-runtime.md:7-15`).
2. **조회 호출**(관측 수집은 해당 Run을 바인딩한 PM이 수행합니다):
   - `orca orchestration run-current --json`, `run-show --run <id> --json`
   - `orca orchestration worker-list --run <id> --json`(`scope.source: "flag"`와 같은 Run ID 검증, `pl/SKILL.md:70`)
   - `orca orchestration worker-show --dispatch <id> --json`, `dispatch-show`, `task-list`
   - 쓰기의 타임아웃 뒤 반영 여부가 불명확하면 `orca orchestration request-show`로 확인하고 생성 명령을 반복하지 않습니다(`orca-runtime.md:15`).
3. **비교키와 우선순위**: `taskId`+`attemptId`+`executionId`(workflow `attempt`와 receipt, `workflow.mjs:456-459`), `eventId`(`state.eventIds`로 중복 제거, `workflow.mjs:1050-1051`), 신호 ID와 `notify` 필드(`director/SKILL.md:109`), 메시지 `deliveryId`(`supervision-wait --ack`). 실행의 생존은 Orca `liveness`가 우선이고, 결과·수용은 OMT의 gate 기록이 우선입니다.
4. **누락·충돌 처리**: `unverifiable`, receipt 다섯 ID 누락, `executionId` 불일치는 `reconcile-required`로 보존하고 새 Dispatch를 만들지 않습니다.
   - `workflow-resume`은 `reserved` task에 `launch-reconcile-required`, 관측 없는 `running` task에 `reconcile-required`를 돌려주며 `dispatch-ready`는 `pending` task에만 냅니다(`workflow.mjs:896-950`, `554-597`). 테스트: `P/tests/runtime.test.mjs:1595`, `workflow-safety.test.mjs:600-662`, `lock-recovery-and-release.test.mjs:253`.
   - 관측을 주입하려면 `workflow-resume`에 `--observations`로 `{ [attemptId]: { executionId, status: "running"|"settled"|"failed", eventId, callsUsed, failure } }`를 넘깁니다(`workflow.mjs:456-503`). `eventId`가 이미 있으면 중복입니다.
   - 관측 불가가 지속되면 PM이 `escalation`이나 `director-signal --kind blocked`로 올립니다. 이때 증거는 `worker-list`의 `liveness`, `lastActivityAt`, 진행 요청 횟수입니다(`orca-runtime.md:331-334`).
5. **재개 순서**: `kickoff-show`→`doc-resolve-kickoff`→`workflow-status`→`doc-id`→`doc-show`(`orca-runtime.md:455-463`)로 다시 찾으며, 부모 대화를 복사하지 않습니다. 세션이 바뀌어도 같은 조회를 되풀이하지 않도록 직전에 처리한 문서 revision·결정·메시지 ID를 `handoff-checkpoint`(`teams-org.mjs`의 명령)에 남깁니다.

## 8. 변경 지점과 이전·호환 전략

새 루프·타이머·프로세스 감독기는 추가하지 않습니다. 감독은 Orca의 Run·Task·Dispatch와 기존 `supervision-wait`·`supervision-next`·`director-watch`를 그대로 쓰고, 이 설계가 필요로 하는 것은 아래 검사와 기록 형식뿐입니다.

| 후속 변경 지점 | 위치 | 기존 상태·호환 입력 | 선행 조건 | 도입 gate |
|---|---|---|---|---|
| 결정 기록 4항목 검사 | `P/scripts/director.mjs`의 `sendSignal`(83), `replySignal`(584) | 기존 신호 텍스트는 그대로 읽음, 새 검사는 선택 필드로 시작 | 이 문서 승인 | `director-signal.test.mjs`에 케이스 추가, 기존 테스트 무변경 통과 |
| `decision` 재분류 표시 | `director.mjs`, `P/skills/director/SKILL.md:96-110` | 기존 `decision`은 유효 | 네 경계 정본은 `autonomy.md` 하나로 유지(스킬에 로직 복제 금지, 프로젝트 `AGENTS.md`) | 스킬 문서는 링크만, `skill-instructions.test.mjs`의 "one rule lives in one place"(319) 통과 |
| 자율 결정의 `progress` 형식 | `P/skills/pm/SKILL.md:58`, `autonomy.md:7` | 자유 서식 유지 | 결정 기록 형식 확정 | eval 시나리오 추가 |
| rework·retry·reopen·release·handoff의 조건 | `workflow.mjs:1740`, `1888`, `1992`, `1558`, `2095` | 각 명령의 입력·이벤트 유지, 진행 중 attempt는 그대로 이어짐 | 변경 없음(이 설계는 기존 조건을 그대로 인용) | 변경이 생기면 `workflow-recovery.test.mjs`·`lock-recovery-and-release.test.mjs` 무변경 통과 |
| 조직 스냅샷 보존 | `workflow.mjs`의 `createWorkflow`(264), `foldRole`(`core.mjs:162`) | 워크플로는 만들 때의 조직·`roles`를 유지하며 revision이 바뀐 조직 파일은 읽지 않음 | 진행 중 kickoff가 끝날 때까지 legacy 스킬 유지(`pm/SKILL.md:8,98,109`) | legacy 스킬 제거는 별도 kickoff |
| 감사 역할 | 없음(제안) | 없음 | `139-auditor` kickoff의 계약 확정, 스냅샷에 역할 선언 | 그 kickoff의 gate, 이 문서는 §5.3 반증 조건만 제공 |

**다른 kickoff와의 접점**: 감사 구현(`139-auditor`), 적응형 조직 편성(`adaptive-team-staffing`), 모델 카탈로그(`dynamic-model-catalogs`), 정형 문서 체계(`structured-omt-documents`)는 이 문서가 계약을 확정하지 않습니다. 각 브리프의 확정 전에는 미정으로 남기고, 확정되면 이 문서의 해당 행을 갱신합니다.

**자원 슬롯과 구독 할당량**: 슬롯은 workflow의 `reserve`와 별개입니다. `reserve`는 동시성 슬롯·attempt·호출 한도를 점유하는 OMT 상태이고(`workflow.mjs:40,442-455`), 자원 슬롯은 무거운 작업을 위한 머신 수준 점유입니다(`resources.mjs:147-229`). 획득은 director 또는 PM만 하며, 메모리가 `DEFAULT_MIN_FREE_MEMORY_BYTES`(512 MiB, `resources.mjs:39`) 미만이면 거부합니다. 소유자를 모르는 슬롯은 자동 회수하지 않고 `resource-release`로만 해제하며, 생사를 판정할 수 없으면 그대로 보존합니다(`director-signal.test.mjs:643,660`). 여러 kickoff가 슬롯을 공유하므로 kickoff 사이의 우선순위는 네 경계 중 4번(사용자만 아는 암묵지)입니다.

## 9. 반증 시나리오와 수용 테스트

### 9.1 현행 검사(actual): 지금 실행하면 재현되는 것

| 시나리오 | 파일·입력·초기 상태 | 기대 관측 | 실패 기준 |
|---|---|---|---|
| 같은 실행 ID의 독립 검토 | `P/tests/three-tier.test.mjs:196`, `omt-documents.test.mjs:666`, `safety-net.test.mjs:265`: `reviewer.executionId`와 `implementationExecutionId`를 같은 값으로 `validateReviewInput` | `Independent review must use a different execution identity`로 거부 | 승인 기록이 만들어지면 실패 |
| 검토 미완료 상태의 수용 | `cli-integration.test.mjs:184`: 필수 review가 없는 task에 `accept` | `Required reviews are incomplete` | 수용이 기록되면 실패 |
| 예약 뒤 중복 시작 방지 | `workflow-safety.test.mjs:600-662`: `reserveExecution` 후 같은 task를 다시 `resumeWorkflow`, 다른 task를 `maxRunning:1`에서 예약 | `resumeWorkflow` 액션이 `launch-reconcile-required` 하나, 두 번째 예약은 `/capacity/`로 거부 | 두 번째 `dispatch-ready`가 나오면 실패 |
| 관측 없는 실행 중 attempt | `runtime.test.mjs:1595`: `attachExecution` 후 관측 없이 `resumeWorkflow` | `actions[0].type === "reconcile-required"`, `attemptId` 일치 | 그 task에 `dispatch-ready`가 나오면 실패 |
| 예약 해소의 attempt 반환 | `lock-recovery-and-release.test.mjs:253,375`: `refusal.kind`가 `not-started`가 아니면 `/Only a launch refused before any work started/` | `not-started`일 때만 `attemptsUsed`가 줄어듦(`workflow.mjs:1595-1603`), 그 밖에는 소비 유지 | 다른 refusal로 attempt가 반환되면 실패 |
| 소유자 모르는 자원 슬롯 | `director-signal.test.mjs:643,660` | 경고가 나오고 이후 어떤 획득에도 회수되지 않음 | 자동 회수되면 실패 |
| 중복 pending 신호 | `director-signal.test.mjs:319` | 같은 종류·텍스트의 pending 신호는 거부 | 두 번째가 기록되면 실패 |

### 9.2 후속 eval(proposed): 이 문서가 정하는 측정 정의, 현재 미구현·미측정

선행 구현이 없으므로 아래 값은 현재 측정되지 않습니다. 각 지표는 `evals/organization/scenarios.json`에 시나리오로 추가하는 것을 후속 단계로 제안합니다.

| 시나리오 | 입력·fixture(후속) | 계측값 | 임계값·실패 기준 |
|---|---|---|---|
| PM이 증거 없는 완료를 올림 | worker 보고에 `verify` 증거 없음, PM이 `accept` 시도 | 분자: 증거 없이 기록된 `outcome-accepted`, 분모: `accept` 시도 | 분자가 0이 아니면 실패(현행 `gateCheck`가 `checks-passed`로 막는지 먼저 실측) |
| 이사가 PM의 범위 내 판단을 사용자에게 넘김 | 네 경계에 해당하지 않는 `decision` 신호 | 분자: 사용자 질문으로 이어진 신호 수, 분모: 경계 밖 `decision` 신호 수 | 0이 아니면 실패 |
| PM이 경계 내 결정을 `progress`로만 올림 | 네 경계에 해당하는 결정 | 분자: `progress`로 처리된 경계 결정, 분모: 경계 결정 수 | 0이 아니면 실패 |
| 자율 결정에 근거·되돌리는 방법 누락 | 결정 신호·`progress` 텍스트 | 분자: §4.3 네 항목 중 빠진 것이 있는 보고 수, 분모: 자율 결정 보고 수 | 0이 아니면 실패 |
| `unverifiable` worker에 중복 Dispatch | `worker-list`가 `unverifiable`, attempt `running` | 분자: 같은 task의 새 `worker-start` 호출 수, 분모: `unverifiable` 관측 횟수 | 0이 아니면 실패(현행은 `reconcile-required`가 그 경우를 막음) |
| 감사 역할이 설득 없이 수용 | 근거 필드가 빈 승인 기록(감사 구현 이후) | 분자: 근거 없이 저장된 수용, 분모: 시도 | 0이 아니면 실패 |
| 하위 역할이 사용자에게 직접 질문 | 역할 스킬 지시문과 메시지 | 분자: 사용자 대상 질문, 분모: 하위 역할 메시지 | 0이 아니면 실패 |

## 10. 독립 검토와 제출 상태

- **문서 revision**: 2. 직전 revision 1은 PL 최종 검토 2가 15개 finding을 `open`으로 남겼습니다(`proactive-pl-final-review2.json`).
- **작성자**: 회복 workflow `proactive-role-initiative-recovery-r15`의 단일 작성 실행(Senior, 조직 revision 15). 독립 검토자와 검토 revision은 이 커밋 뒤에 기록하며, 작성자는 이 문서를 스스로 승인하지 않습니다.
- **검사 상태**: PM이 확보한 test 슬롯에서 `npm run format`, `npm run sync`, `npm run lint`, `npm test`를 실행했고 모두 종료 코드 0입니다. `sync`는 변경과 누락이 없었고, `npm test`는 1039개 중 통과 1002, 실패 0, 건너뜀 37이었습니다. 이 문서를 처음 커밋한 HEAD는 2bf62de이며, 최종 커밋 HEAD는 PM 보고와 handoff checkpoint에 적습니다.
- **선행 조건**: ready-timeout 복구 커밋 `04e423f`는 현재 main(4c43b24)의 조상 병합에 포함되어 있으므로, 남은 조건은 이 설계 HEAD에서의 `npm test` 통과와 독립 검토입니다. 게이트(`gates/proactive-design.json`의 `checks-passed`와 `review-complete`)는 이 문서의 승인으로 바뀌지 않으며 PM이 다시 판정합니다.
- **남은 구현 단계**: §8의 표가 정한 검사 추가, 결정 기록 형식, eval 시나리오, 감사 역할 계약 연동입니다. 모두 별도 kickoff이며 이 문서에서 구현하지 않습니다.

## 11. 열린 finding 15건 대응표

| ID | 증거 경로·줄 | 판단 | 문서 변경 위치 |
|---|---|---|---|
| current-contract-evidence-missing | `P/skills/pl/SKILL.md:23,39,51-52,76`, `senior/SKILL.md:21,33-40`, `junior/SKILL.md:28-36`, `worker/SKILL.md:14-31`, `director/SKILL.md:28-34`, `pm/SKILL.md:47-59`, `core.mjs:26,29,162-176`, `gates.mjs:27-31,52-58` | resolved: PL의 조건부 `worker-start` 권한을 바로잡고 3-tier·legacy·제안을 분리 | §0, §1 |
| persistent-object-ownership-collapsed | `orca orchestration --help`, `kickoff-registry.mjs:170,427,539,707,769`, `workflow.mjs:40,264,608`, `director.mjs:28,584,734`, `resources.mjs:147,229`, `gates.mjs:406,472,549`, `delivery.mjs:165` | resolved: `orca dispatch list` 제거, 객체별 생성·조회·정산·종료·보존 표 | §2 |
| role-event-matrix-incomplete | 역할 정본과 `workflow.mjs:1558,1740,1888,1992,2095` | resolved: 역할 6개 각각 9개 사건 | §3.1~3.6 |
| autonomy-boundary-and-rollback-missing | `autonomy.md:7,11-14,18-25,29-33,37` | resolved: `delivery` 포함 네 경계, PM `decision`/`progress` 분기, 재분류, 근거·rollback | §4 |
| subordinate-proactivity-not-operationalized | 각 역할 스킬의 한계 절 | resolved: 역할·사건별 범위 내 행동·상향·금지·증거, auditor 반증 조건 | §5 |
| cross-kickoff-observations-misstated | §6의 5개 원천 파일(직접 읽음) | resolved, 일부 accepted 아님: 사례 3의 잘못된 추론 철회, 사례 8·9는 원천이 없어 `미확인`으로 표기 | §6 |
| recovery-protocol-lacks-authoritative-reconciliation | `orca orchestration --help`, `orca-runtime.md:7-15,398-408,455-463`, `workflow.mjs:456-503,896-950` | resolved: 실제 이름공간의 호출, 비교키, 우선순위, reconcile 절차 | §7 |
| lifecycle-mapping-and-resource-strategy-contradicted | `workflow.mjs:40,442-455,1558,1740,1888`, `resources.mjs:39,147-229` | resolved: 변경 지점·호환·선행 조건·도입 gate 표, 슬롯과 `reserve`의 구분 | §8 |
| falsification-plan-is-not-executable | §9.1의 테스트 줄, `gates.mjs:107-175`, `workflow.mjs:896-950` | resolved: 현행 검사와 후속 eval을 분리하고 분자·분모·임계값 정의 | §9 |
| independent-review-evidence-and-pm-boundary-open | `gates/proactive-design.json`, `proactive-runtime-fix-dependency.json`, `proactive-rework4-worktree-boundary.json`, main 4c43b24 | resolved(기록 정정): 이전 HEAD를 최종으로 적던 서술 삭제, 자기 해결 주장 삭제, 검사는 미실행으로 표기 | §6 사례 4·5, §10 |
| p1-02 | `P/skills/junior/SKILL.md:18-36,43-51` | resolved | §3.6 |
| p3-02 | `P/skills/director/SKILL.md:30,96-110,111-135` | resolved | §3.1 |
| p3-03 | `workflow.mjs:1558-1626`, `lock-recovery-and-release.test.mjs:253,375` | resolved: `resolution`·`evidence` 필수, `not-started`일 때만 attempt 반환, 반환되지 않는 attempt와 소비된 호출을 명시 | §3.2 예약 해소 행, §9.1 |
| p3-05 | `pm/SKILL.md:142-164`, `workflow.mjs:1740,1888,1992` | resolved | §3.2 |
| p4-01 | `autonomy.md:7,11,27-37` | resolved | §4 |
