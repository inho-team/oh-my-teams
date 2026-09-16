---
name: kickoff
description: 저장된 oh my teams 조직으로 하나의 개발 목표를 시작하거나 재개하고, 검증 가능한 완료 조건까지 Goal처럼 지속해서 감독한다. 팀을 모아 끝까지 진행해 달라는 요청에 사용한다.
---

# 팀 킥오프

특정 개발 과제를 수행하는 실행 팀의 진입점이다. 상설 조직이 없으면 `form`으로 먼저 결성한다. 조직이 있으면 구독이나 모델을 다시 묻지 않고 kickoff 시점의 조직 revision을 실행 스냅샷으로 고정한다.

## 하나의 지속 실행 권한

한 프로젝트에서 동시에 살아 있는 kickoff는 하나이며, 이 제약은 런타임이 배타적 잠금으로 강제한다. 시작하기 전에 점유를 조회하고, 인계를 마친 뒤에 점유를 요청한다. 현재 스킬 기준 `../../scripts/teams-org.mjs`를 절대 경로로 해석한다.

```text
node <runtime> kickoff-show --org <project>/.omt/organization.json
node <runtime> kickoff-claim --org <project>/.omt/organization.json --from <claim.json>
node <runtime> kickoff-bind --org <project>/.omt/organization.json --worktree <id> --run <runId>
```

`kickoff-show`가 `active: true`를 돌려주면 같은 목표일 때 기록된 coordinator에서 재개하고, 다른 목표이면 이를 덮어쓰거나 경쟁하는 지속 루프를 시작하지 않는다. `kickoff-claim`은 이미 점유가 있으면 실패하므로 그 결과를 성공으로 보고하지 않는다. 요청 파일의 형식, 인계 절차와 해제 조건은 [`../../references/kickoff-lease.md`](../../references/kickoff-lease.md)를 따른다.

kickoff를 선언한 세션은 목표를 확정해 브리프로 넘기고 coordinator 워크트리를 만든 뒤, 점유를 기록하고 인계 사실을 알린다. 감독은 그 자리에서 시작하지 않는다. 네이티브 Goal은 coordinator 세션이 브리프를 읽고 하나 만들며, Run도 같은 세션에서 바인딩한 뒤 `kickoff-bind`로 점유 기록에 적는다. 이 분리는 취향이 아니라 `worker-start`가 Run에 바인딩된 coordinator 터미널만 허용하기 때문에 필요하다. `workflow-create` 역시 점유를 가진 coordinator의 state 디렉터리에서만 성공하므로, 점유를 건너뛰고 실행 팀을 만들 수 없다.

Goal의 objective에는 사용자가 원하는 결과, 측정 가능한 수용 기준, 비목표, 필수 검사와 요청된 전달 범위를 포함한다. 이 가운데 사용자 요청과 저장소 상태에서 확정할 수 없는 항목은 선언 세션이 [`../../references/user-choice.md`](../../references/user-choice.md)의 방식으로 한 번에 확인해 브리프에 담고, coordinator 세션은 그 브리프로 Goal을 만든다. 확인하지 못한 수용 기준을 추측해 채우지 않으며, 사용자가 이미 답한 항목을 coordinator 세션에서 다시 묻지 않는다. 사용자가 토큰 예산을 명시하지 않았다면 임의의 토큰 예산을 설정하지 않는다. 네이티브 Goal이 없는 호스트에서는 같은 계약을 oh my teams workflow와 Orca Run에 보존하되, 네이티브 기능이 있는 것처럼 보고하지 않는다.

kickoff가 활성화된 동안에는 다른 Ralph·Goal·autopilot·Stop-hook 루프를 함께 시작하지 않는다. kickoff가 유일한 지속 실행 권한이고, PM·PL·Intern은 그 아래의 실행 주체다.

## 실행 주기

[pm](../pm/SKILL.md)과 [`../../references/orca-runtime.md`](../../references/orca-runtime.md)을 읽고 다음 주기를 수행한다.

1. 원래 Goal과 현재 저장소 상태를 대조하고, 아직 충족되지 않은 수용 기준 가운데 다음으로 의미 있는 작업을 선택한다.
2. PM이 과제 난이도로 정한 실행 깊이의 역할만 활성화하여 구현·검토·통합을 진행하고, 판단이 바뀌면 깊이를 조정한다. 깊이의 기준과 변경 규칙은 [pm](../pm/SKILL.md)의 「실행 깊이」를 따른다. 독립 편집에는 Orca child worktree를 사용한다.
3. 각 주기마다 코드 변경, 새 검사 결과, 검토 결과, 명확해진 장애물 중 하나 이상의 확인 가능한 진전을 남긴다.
4. 실패하면 같은 시도를 무한 반복하지 않는다. 실패 원인과 시도를 기록하고 접근 방법이나 담당 역할을 바꾼다. 전체 호출·attempt 한도와 사용자가 정한 중단 조건을 지킨다.
5. 대화가 이어지거나 재개되면 authoritative Goal, workflow, Run과 worker 상태를 먼저 대조한다. 계획만 존재하거나 worker 상태가 불명확하다는 이유로 새 작업을 중복 생성하지 않는다.

단순히 모델이 완료했다고 말했거나 일부 테스트가 통과했다는 이유로 루프를 끝내지 않는다. 모든 수용 기준, 필수 검토, 최신 소스에 대한 검증과 사용자가 요청한 전달 범위가 충족되어야 한다.

## 종료 경계

완료 조건이 충족되면 `close` 절차로 전달, 병합과 실행 자원 정리를 수행한다. `close`와 `disband`는 coordinator 워크트리 자체를 회수하므로 coordinator 세션이 아니라 선언 세션에서 수행하며, 점유 기록은 그 절차가 끝난 뒤에 해제된다. PR/MR 생성이나 병합처럼 아직 허가되지 않은 외부 변경이 필요하면 Goal을 완료 처리하지 않고 사용자 결정을 기다린다.

완료를 선언할 때에만 네이티브 Goal을 `complete`로 갱신한다. 실제 완료가 아니거나 예산이 얼마 남지 않았다는 이유로 완료 처리하지 않는다. 같은 장애 조건이 반복되어 호스트 Goal 정책의 차단 기준을 충족한 경우에만 `blocked`로 갱신한다. `workflow-status`가 보고하는 `blocked`는 실패한 task 하나를 뜻할 뿐이므로 그것만으로 Goal을 차단 처리하지 않는다. 사용자가 취소하거나 실패로 정리하라고 요청하면 `disband`를 사용한다.
