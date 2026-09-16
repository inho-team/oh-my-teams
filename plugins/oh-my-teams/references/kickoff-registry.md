# kickoff 등록부

한 프로젝트에서 kickoff를 몇 개든 동시에 진행할 수 있다. 각 kickoff는 자기 coordinator 워크트리에서 감독되며, 워커도 각자 자식 워크트리에서 일하므로 파일과 브랜치가 서로 겹치지 않는다. 등록부는 개수를 제한하지 않고, 어떤 kickoff가 어느 워크트리에서 돌고 있는지를 기록해 `status`·`close`·`disband`가 그 coordinator를 찾게 한다.

## 병렬 kickoff의 비용

워크트리 분리는 파일 충돌을 없애지만 구독 할당량까지 나누지는 않는다. 역할별 동시 인원(`concurrency`)과 호출 예산은 kickoff마다 자기 workflow state 안에서 따로 계산되고, 할당량 소진 스냅샷도 coordinator state마다 따로 쌓인다. 따라서 kickoff 두 개가 같은 구독을 쓰면 조직 파일에 적은 동시 인원의 두 배까지 워커가 동시에 돌 수 있고, 한쪽이 확인한 소진을 다른 쪽은 자기 호출이 실패할 때에야 안다. 여러 kickoff를 함께 진행할 때에는 이 점을 사용자에게 알리고, 필요하면 각 kickoff의 실행 깊이를 낮추거나 `adjust`로 동시 인원을 줄인다.

## 등록 위치와 내용

등록부는 `organization.json`이 있는 **원본 프로젝트**의 `.omt/kickoffs/<해시>.json`이다. Orca 워크트리 ID는 `<repoId>::<워크트리 경로>` 형식이라 `:`와 `/`를 포함하므로 파일 이름으로 쓸 수 없다. 그래서 런타임은 ID의 SHA-256 해시로 파일 이름을 정하고, 원래 ID는 항목 안의 `coordinator.worktreeId`에 그대로 보관한다. 해시에는 경로 구분자나 `..`가 들어가지 않으므로 어떤 ID를 받아도 항목이 등록부 밖에 쓰이지 않는다. 해시를 도입하기 전에 ID를 그대로 파일 이름으로 쓴 항목도 계속 조회·종료할 수 있다. `.omt/`는 Git에서 제외되고 워크트리마다 별개의 디렉터리이므로, coordinator 워크트리 안에 두면 종료를 수행하는 세션이 읽지 못한다. 런타임은 `--org`로 받은 조직 파일과 같은 자리에서만 등록부를 찾는다.

등록을 요청할 때 작성하는 파일은 다음 네 항목만 담는다. `createdAt`은 런타임이 채우고, `runId`는 뒤따르는 `kickoff-bind`가 채운다.

```json
{
  "goal": "사용자가 승인한 목표 한 문장",
  "coordinator": {
    "worktreeId": "<Orca가 실제로 반환한 ID 전체, 예: 5a8b…::/Users/me/orca/workspaces/app/task>",
    "path": "<coordinator 워크트리 절대 경로>",
    "stateDir": "<coordinator 워크트리>/.omt"
  },
  "organizationRevision": 3,
  "brief": "<브리프 파일 절대 경로>"
}
```

런타임은 다음 경우에 등록을 거부한다.

- 같은 워크트리가 이미 다른 kickoff를 감독하고 있을 때. coordinator 세션 하나는 Goal 하나를 소유하고 Run 하나를 바인딩하므로, 두 번째 kickoff에는 감독할 주체가 없다. 새 coordinator 워크트리를 만든다.
- 브리프 파일이 실제로 없을 때. coordinator는 부모 대화 대신 이 파일을 읽고 시작한다.
- `organizationRevision`이 현재 조직 revision과 다를 때. 오래된 조직 스냅샷으로 팀을 띄우지 않게 한다.

단일 kickoff 시절의 `.omt/active-kickoff.json`이 남아 있으면 등록부를 처음 읽거나 쓸 때 그 coordinator의 항목으로 옮겨지므로, 그 kickoff도 그대로 종료할 수 있다.

## 명령

현재 문서 기준 `../scripts/teams-org.mjs`를 절대 경로로 해석한다.

```text
node <runtime> kickoff-show --org <project>/.omt/organization.json
node <runtime> kickoff-claim --org <project>/.omt/organization.json --from <claim.json>
node <runtime> kickoff-bind --org <project>/.omt/organization.json --worktree <id> --run <runId>
node <runtime> kickoff-release --org <project>/.omt/organization.json --worktree <id> --reason completed
```

`kickoff-show`는 등록된 kickoff 전체를 돌려주며, `--worktree`를 주면 그 coordinator의 항목만 돌려준다. `kickoff-bind`는 같은 `runId`를 다시 넣는 호출은 그대로 성공하지만 다른 Run을 넣으면 거부한다. 수신 확인을 놓친 재실행과 Run이 둘로 갈라지는 상황은 서로 다른 사건이기 때문이다. `kickoff-release`의 `--reason`은 `completed`, `disbanded`, `taken-over` 가운데 하나이며, 다른 kickoff의 항목은 건드리지 않는다.

## 두 세션의 역할

선언 세션과 coordinator 세션은 하는 일이 다르다.

- **선언 세션(A)**: 사용자와 목표를 확정하고, coordinator 워크트리를 만들어 인계하고, 등록한다. 이후에는 조회와 종료를 담당하는 관제 자리로 남는다. Goal을 만들지 않고 Run도 바인딩하지 않는다. 한 선언 세션이 여러 kickoff를 차례로 인계할 수 있다.
- **coordinator 세션(B)**: Goal을 소유하고 PM 역할로 실행을 감독한다. `worker-start`는 Run에 바인딩된 coordinator 터미널에서만 호출할 수 있으므로([`orca-runtime.md`](orca-runtime.md)의 `worker-start 래퍼` 절), Run을 만드는 자리와 워커를 띄우는 자리는 반드시 B로 일치해야 한다.

`close`와 `disband`는 A에서 수행한다. coordinator 워크트리를 회수하는 것이 종료 절차에 포함되는데, 자기가 서 있는 워크트리는 스스로 제거할 수 없기 때문이다.

## 인계 절차

선언 세션(A)이 순서대로 수행한다.

1. `kickoff-show`로 등록된 kickoff를 확인한다. 같은 목표가 이미 진행 중이면 새로 시작하지 않고 기록된 coordinator에서 재개하도록 안내한다. 다른 목표라면 함께 진행해도 되며, 이때 병렬 kickoff의 비용을 알린다.
2. 사용자에게 확인해야 하는 목표, 수용 기준, 비목표, 필수 검사와 전달 범위를 [`user-choice.md`](user-choice.md)의 방식으로 한 번에 확정한다.
3. 확정한 내용을 브리프 파일로 쓴다. 부모 대화 전문을 넘기지 않고 작업 조건, 대상 파일, 근거 위치와 조직 파일 경로만 담는다.
4. Orca 자식 워크트리를 만들고 coordinator 세션을 시작한 뒤 브리프 경로를 전달한다. 실제로 반환된 워크트리 ID를 그대로 보관한다. coordinator는 PM 프로필의 모델로 띄워야 하므로 `worktree create --agent`를 쓰지 않고 [`orca-runtime.md`](orca-runtime.md)의 `coordinator 실행` 절에 따라 `role-terminal`로 연다. 그 절차가 모델을 전달하지 못하거나 터미널이 준비되지 않으면 브리프를 보내지 않고 멈춘 뒤 보고한다. A가 PM을 대신 맡지 않는다.
5. `kickoff-claim`으로 등록하고, 어느 워크트리가 무엇을 맡았는지 사용자에게 알린다. A는 여기서 감독을 시작하지 않는다.

등록은 워크트리를 만든 뒤에 요청한다. 실제로 반환된 ID를 적어야 하므로 순서를 바꿀 수 없고, 등록이 거부되면 방금 만든 워크트리를 회수한 뒤 보고한다.

coordinator 세션(B)은 시작하자마자 다음을 수행한다.

1. 브리프를 읽고 Goal을 하나 만든다. 이 Goal의 유일한 소유자는 B다.
2. 같은 터미널에서 `orchestration run-create`로 Run을 만들어 바인딩한다.
3. `kickoff-bind`로 등록부에 그 Run을 적는다. 이 호출이 거부되면 자기 워크트리 ID로 등록된 kickoff가 없다는 뜻이므로, Run을 그대로 두고 에스컬레이션한다.

### 인계할 수 없는 호스트

A가 coordinator를 겸하는 것은 호스트에 인계 수단 자체가 없을 때뿐이다. Orca 실행 파일이 없거나, 설치된 Orca가 `worktree create` 또는 `terminal create` 명령을 제공하지 않는 경우가 여기에 해당하며, 그 명령의 실제 오류를 증거로 남긴다. coordinator 터미널이 뜨지 않았거나, `role-terminal`이 `ready: false`를 돌려주었거나, 화면의 모델이 달랐던 것은 인계 수단이 없는 것이 아니라 인계에 실패한 것이다. 이때에는 A가 PM을 대신 맡지 않고 멈춘 뒤 보고한다.

조건을 충족하더라도 사용자에게 A가 coordinator를 겸한다는 사실과 그 증거를 알리고 승인을 받는다. 승인을 받으면 A가 그대로 coordinator가 되어 Goal과 Run을 소유하고, 등록 항목의 `coordinator`에 A를 적는다. 런타임은 coordinator 경로가 원본 프로젝트와 같은 등록 요청을 `selfCoordinator`가 없으면 거부하므로, 요청 파일의 `selfCoordinator`에 인계할 수 없는 이유와 오류 증거, 사용자 승인을 한 문장으로 적는다. 인계한 것처럼 보고하지 않으며, 이 경우 종료 절차에 회수할 자식 워크트리가 없다는 점을 함께 알린다. A는 Goal을 하나만 소유할 수 있으므로 이 환경에서는 한 세션이 kickoff를 하나씩만 감독한다.

## 종료

kickoff의 항목은 `close` 또는 `disband`가 끝난 뒤에 `kickoff-release`로 해제한다. 목표를 달성하지 못했더라도 해체를 마쳤으면 해제해야 한다. 그러지 않으면 `status`가 끝난 kickoff를 계속 진행 중으로 보여 주고, 그 워크트리에서 새 kickoff를 등록할 수 없다. 해제된 항목은 지워지지 않고 `.omt/history/`에 해제 시각과 사유가 붙어 보관된다.

coordinator의 liveness가 `unverifiable`이라는 이유로 항목을 자동 해제하지 않는다. 세 값을 서로 대체하지 않는 규율은 [`orca-runtime.md`](orca-runtime.md)의 `worker-list와 liveness` 절을 따른다. 사용자가 응답하지 않는 coordinator의 kickoff를 끝내기로 결정한 경우에만 `--reason taken-over --force`를 사용하고, 마지막으로 확인한 liveness와 결정 사유를 보고에 남긴다. `taken-over`는 `--force` 없이는 거부되므로, 조회 실패가 곧바로 종료로 이어지지 않는다.

## 치르는 비용

coordinator가 자식 워크트리로 한 단계 내려가므로 워커들은 그보다 한 단계 더 깊은 곳에 놓인다. Orca 중첩 깊이 제한에 더 빨리 닿게 되며, 한계에 걸리면 [`../skills/pm/SKILL.md`](../skills/pm/SKILL.md)가 정한 대로 PM·PL이 평평한 작업 파동으로 배정한다.
