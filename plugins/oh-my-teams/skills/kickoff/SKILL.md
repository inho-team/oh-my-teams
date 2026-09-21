---
name: kickoff
description: 저장된 oh my teams 조직으로 하나의 개발 목표를 시작하거나 재개하고, 검증 가능한 완료 조건까지 Goal처럼 지속해서 감독한다. 팀을 모아 끝까지 진행해 달라는 요청에 사용한다.
---

# 팀 킥오프

특정 개발 과제를 수행하는 실행 팀의 진입점이다. 상설 조직이 없으면 `form`으로 먼저 결성한다. 조직이 있으면 구독이나 모델을 다시 묻지 않고 kickoff 시점의 조직 revision을 실행 스냅샷으로 고정한다.

## 하나의 지속 실행 권한

한 프로젝트에서 kickoff를 몇 개든 동시에 진행할 수 있다. 각 kickoff는 자기 PM 워크트리에서 감독되고, 어떤 kickoff가 어느 워크트리에서 도는지는 등록부에 남는다. 시작하기 전에 등록된 kickoff를 조회하고, 인계를 마친 뒤에 등록한다. 현재 스킬 기준 `../../scripts/teams-org.mjs`를 절대 경로로 해석한다.

```text
node <runtime> kickoff-show --org <project>/.omt/organization.json
node <runtime> kickoff-claim --org <project>/.omt/organization.json --from <claim.json>
node <runtime> kickoff-bind --org <project>/.omt/organization.json --worktree <id> --run <runId>
```

`kickoff-show`에 같은 목표가 이미 있으면 새로 시작하지 않고 기록된 PM 워크트리에서 재개한다. 다른 목표는 함께 진행해도 되지만, 같은 구독을 쓰는 kickoff가 늘면 할당량을 함께 소모한다는 점을 사용자에게 알린다. `kickoff-claim`은 같은 워크트리가 이미 kickoff를 감독하고 있거나 요청 파일에 전달 방식(`delivery`)이 없으면 실패하므로 그 결과를 성공으로 보고하지 않는다. 요청 파일의 형식, 병렬 kickoff의 비용, 인계 절차와 종료 조건은 [`../../references/kickoff-registry.md`](../../references/kickoff-registry.md)를 따른다.

kickoff를 선언한 세션은 목표를 확정해 브리프로 넘기고 PM 워크트리를 만든 뒤, 등록하고 인계 사실을 알린다. PM은 [`../../references/orca-runtime.md`](../../references/orca-runtime.md)의 `PM 실행` 절에 따라 `role-terminal`로 PM 프로필의 명령을 실행한 새 터미널에서 띄운다. `orca worktree create --agent`나 `terminal create --command`를 직접 호출해 띄우지 않으며, `role-terminal`이 `ready: false`를 돌려주거나 PM 프로필의 모델을 전달할 수 없거나 화면의 모델이 다르면 멈추고 보고한다.

**선언 세션은 PM을 대신 맡지 않는다.** PM을 띄우지 못했다는 이유로 선언 세션이 Goal을 만들거나 Run을 바인딩하거나 `worker-start`를 호출하지 않는다. 그러면 선언 세션의 대화 맥락과 모델이 PM 프로필을 대신하고, 종료 절차가 회수할 PM 워크트리도 사라진다. 선언 세션이 PM을 겸하는 경우는 [`../../references/kickoff-registry.md`](../../references/kickoff-registry.md)의 「인계할 수 없는 호스트」 절이 정한 조건을 충족하고 사용자가 승인했을 때뿐이다. 감독은 선언 세션에서 시작하지 않는다. 네이티브 Goal은 PM 세션이 브리프를 읽고 하나 만들며, Run도 같은 세션에서 바인딩한 뒤 `kickoff-bind`로 등록부에 적는다. 이 분리는 취향이 아니라 `worker-start`가 Run에 바인딩된 coordinator 터미널만 허용하기 때문에 필요하다. 등록을 건너뛴 kickoff는 `status`·`close`·`disband`가 찾지 못하므로 반드시 등록한다.

Goal의 objective에는 사용자가 원하는 결과, 측정 가능한 수용 기준, 비목표, 필수 검사와 요청된 전달 범위를 포함한다. 전달 범위에는 결과를 원본 프로젝트의 어느 브랜치에 어떤 방식(`local-merge`, `pull-request`, `none`)으로 넣을지를 반드시 포함한다. 이 값은 종료할 때 주인 체크아웃에 병합하는 허가가 되므로, 브리프에 문장으로 적고 등록 요청의 `delivery`에도 같은 값을 적는다. 이 가운데 사용자 요청과 저장소 상태에서 확정할 수 없는 항목은 선언 세션이 [`../../references/user-choice.md`](../../references/user-choice.md)의 방식으로 한 번에 확인해 브리프에 담고, PM 세션은 그 브리프로 Goal을 만든다. 확인하지 못한 수용 기준을 추측해 채우지 않으며, 사용자가 이미 답한 항목을 PM 세션에서 다시 묻지 않는다. 브리프는 [두괄식](../../references/bluf.md)의 「아래로 내리는 지시」 순서대로 목표와 수용 기준을 맨 앞에 두고, 범위·제약·전달 방식과 근거를 뒤에 쓴다. 사용자가 토큰 예산을 명시하지 않았다면 임의의 토큰 예산을 설정하지 않는다. 네이티브 Goal이 없는 호스트에서는 같은 계약을 oh my teams workflow와 Orca Run에 보존하되, 네이티브 기능이 있는 것처럼 보고하지 않는다.

kickoff가 활성화된 동안에는 다른 Ralph·Goal·autopilot·Stop-hook 루프를 함께 시작하지 않는다. kickoff가 유일한 지속 실행 권한이고, PM·PL·Intern은 그 아래의 실행 주체다.

## 실행 주기

PM은 실행 깊이와 무관하게 이번 workflow에 선언된 Intern이 맡을 수 있는 경계가 닫힌 조사·집계·인용·반복 편집·작은 독립 구현을 먼저 식별한다. 같은 종류의 작업은 하나의 배정으로 묶고, 파일 소유권·입출력·검사·종료 조건과 Intern을 쓰지 않는 경우의 이유를 기록한다. Junior는 통합·수정 책임을, Senior는 독립 검토와 중요한 경계 판단을 맡으며, 필수 검토와 기존 실패 예산을 줄이지 않는다.

사용자가 지정한 역할은 우선하고, 조직 또는 workflow에 Intern이 없으면 기존 역할 해석 규칙에 따라 가장 가까운 상위 역할이 이어받는다. 기존 workflow와 스냅샷의 state·hash·실행 의미는 보존하며, 실제 실행 역할과 승격 사유는 실행 기록에서 확인한다.

[pm](../pm/SKILL.md)과 [`../../references/orca-runtime.md`](../../references/orca-runtime.md)을 읽고 다음 주기를 수행한다.

1. 원래 Goal과 현재 저장소 상태를 대조하고, 아직 충족되지 않은 수용 기준 가운데 다음으로 의미 있는 작업을 선택한다.
2. PM이 과제 난이도로 정한 실행 깊이의 역할만 활성화하여 구현·검토·통합을 진행하고, 판단이 바뀌면 깊이를 조정한다. 깊이의 기준과 변경 규칙은 [pm](../pm/SKILL.md)의 「실행 깊이」를 따른다. 독립 편집에는 Orca child worktree를 사용한다. 역할은 원시 `orca orchestration worker-start`가 아니라 `worker-start --org --role --workflow-id --state` 래퍼로만 띄우고, 산출물은 PM·PL이 아니라 이번 실행의 역할 가운데 그 일을 맡을 수 있는 가장 낮은 역할이 만든다.
3. 각 주기마다 코드 변경, 새 검사 결과, 검토 결과, 명확해진 장애물 중 하나 이상의 확인 가능한 진전을 남긴다.
4. 실패하면 같은 시도를 무한 반복하지 않는다. 실패 원인과 시도를 기록하고 접근 방법이나 담당 역할을 바꾼다. `work` 실행·attempt마다 적용되는 provider 호출 한도, workflow의 호출 예산과 attempt 한도, 사용자가 정한 중단 조건을 지킨다. 대화형 역할 터미널의 턴은 이 한도에 세지 않으므로, 사용량은 `usage-report`로 따로 확인한다.
5. worker를 기다리는 동안 `check --wait`의 제한 시간마다 [`../../references/orca-runtime.md`](../../references/orca-runtime.md)의 `무응답 worker 감독` 절을 적용하고, 무응답 worker를 `진행 중`으로 보고하지 않는다.
6. 대화가 이어지거나 재개되면 authoritative Goal, workflow, Run과 worker 상태를 먼저 대조한다. 계획만 존재하거나 worker 상태가 불명확하다는 이유로 새 작업을 중복 생성하지 않는다.

단순히 모델이 완료했다고 말했거나 일부 테스트가 통과했다는 이유로 루프를 끝내지 않는다. 모든 수용 기준, 필수 검토, 최신 소스에 대한 검증과 사용자가 요청한 전달 범위가 충족되어야 한다.

## 종료 경계

kickoff의 워크트리끼리 합치는 병합은 PM·PL이 게이트를 통과시킨 뒤 별도 허가 없이 진행한다. 원본 프로젝트, 즉 주인 체크아웃에는 어떤 역할도 커밋하거나 병합하지 않으며, 결과는 `close`에서 선언 세션이 기록된 전달 방식으로만 넣는다.

완료 조건이 충족되면 `close` 절차로 전달, 병합과 실행 자원 정리를 수행한다. `close`와 `disband`는 PM 워크트리 자체를 회수하므로 PM 세션이 아니라 선언 세션에서 수행하며, 등록 항목은 그 절차가 끝난 뒤에 해제된다. 다른 kickoff의 항목은 건드리지 않는다. 브리프에 기록된 전달 방식 밖의 외부 변경(예: `none`인데 병합이 필요하거나, 기록되지 않은 원격 push)이 필요하면 Goal을 완료 처리하지 않고 사용자 결정을 기다린다.

완료를 선언할 때에만 네이티브 Goal을 `complete`로 갱신한다. 실제 완료가 아니거나 예산이 얼마 남지 않았다는 이유로 완료 처리하지 않는다. 같은 장애 조건이 반복되어 호스트 Goal 정책의 차단 기준을 충족한 경우에만 `blocked`로 갱신한다. `workflow-status`가 보고하는 `blocked`는 실패한 task 하나를 뜻할 뿐이므로 그것만으로 Goal을 차단 처리하지 않는다. 사용자가 취소하거나 실패로 정리하라고 요청하면 `disband`를 사용한다.
