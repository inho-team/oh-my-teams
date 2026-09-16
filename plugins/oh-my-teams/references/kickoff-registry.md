# 활성 kickoff 점유

한 프로젝트에서 동시에 살아 있는 kickoff는 하나다. `scripts/workflow.mjs`의 동시 인원 검사와 호출 예산 검사는 workflow 하나의 state만 세기 때문에, 같은 조직 파일을 읽는 kickoff가 둘이면 조직 파일에 적힌 `concurrency`와 `maxCalls`가 합산 기준으로는 지켜지지 않는다. 두 coordinator가 같은 구독을 동시에 소모하면서도 서로의 슬롯을 보지 못한다.

이 규칙은 런타임이 거부로 강제한다. `scripts/kickoff-lease.mjs`가 점유를 배타적 잠금 아래에서 기록하므로, 프로젝트가 비어 있다고 동시에 판단한 두 세션 가운데 하나만 점유에 성공하고 나머지는 승자의 기록을 읽게 된다. 점유 파일을 직접 만들거나 지우지 않고 아래 명령을 사용한다.

## 점유 기록의 위치와 내용

점유 기록은 `organization.json`이 있는 **원본 프로젝트**의 `.omt/active-kickoff.json`이다. `.omt/`는 Git에서 제외되고 워크트리마다 별개의 디렉터리이므로, coordinator 워크트리 안에 두면 다른 세션이 읽지 못해 점유의 의미가 사라진다. 런타임은 `--org`로 받은 조직 파일과 같은 디렉터리에서만 점유를 찾으므로, 경로를 잘못 지정해 다른 자리에 점유를 만들 수 없다.

점유를 요청할 때 작성하는 파일은 다음 네 항목만 담는다. `createdAt`과 보관 이력은 런타임이 채우며, `runId`는 뒤따르는 `kickoff-bind`가 채운다.

```json
{
  "goal": "사용자가 승인한 목표 한 문장",
  "coordinator": {
    "worktreeId": "<Orca가 실제로 반환한 ID>",
    "path": "<coordinator 워크트리 절대 경로>",
    "stateDir": "<coordinator 워크트리>/.omt"
  },
  "organizationRevision": 3,
  "brief": "<브리프 파일 절대 경로>"
}
```

브리프 파일이 실제로 존재하지 않으면 점유가 거부된다. coordinator는 부모 대화 대신 이 파일을 읽고 시작하므로, 쓰지 않은 브리프를 가리키는 점유는 아무것도 넘겨주지 못한다. `organizationRevision`이 현재 조직 revision과 다를 때에도 거부되므로, 오래된 조직 스냅샷으로 팀을 띄우는 일이 생기지 않는다.

## 명령

현재 문서 기준 `../scripts/teams-org.mjs`를 절대 경로로 해석한다.

```text
node <runtime> kickoff-show --org <project>/.omt/organization.json
node <runtime> kickoff-claim --org <project>/.omt/organization.json --from <claim.json>
node <runtime> kickoff-bind --org <project>/.omt/organization.json --worktree <id> --run <runId>
node <runtime> kickoff-release --org <project>/.omt/organization.json --worktree <id> --reason completed
```

`kickoff-show`는 점유가 없으면 `active: false`를 돌려주며, 이는 조회 실패가 아니라 시작해도 된다는 뜻이다. `kickoff-claim`은 이미 점유가 있으면 현재 보유자와 목표를 알리며 실패한다. `kickoff-bind`는 점유를 가진 워크트리에서만 성공하고, 같은 `runId`를 다시 넣는 호출은 그대로 성공하지만 다른 Run을 넣으면 거부된다. receipt를 놓쳐 다시 실행하는 경우와 Run이 둘로 갈라지는 경우는 서로 다른 사건이기 때문이다. `kickoff-release`의 `--reason`은 `completed`, `disbanded`, `taken-over` 가운데 하나다.

`workflow-create`도 같은 점유를 확인한다. 점유를 가진 coordinator의 `stateDir`이 아닌 곳에서 workflow를 만들려고 하면 거부되므로, 점유를 건너뛰고 두 번째 실행 팀을 만드는 경로가 남아 있지 않다.

## 두 세션의 역할

선언 세션과 coordinator 세션은 하는 일이 다르다.

- **선언 세션(A)**: 사용자와 목표를 확정하고, coordinator 워크트리를 만들어 인계하고, 점유 기록을 쓴다. 이후에는 조회와 종료를 담당하는 관제 자리로 남는다. Goal을 만들지 않고 Run도 바인딩하지 않는다.
- **coordinator 세션(B)**: Goal을 소유하고 PM 역할로 실행을 감독한다. `worker-start`는 Run에 바인딩된 coordinator 터미널에서만 호출할 수 있으므로([`orca-runtime.md`](orca-runtime.md)의 `worker-start 래퍼` 절), Run을 만드는 자리와 워커를 띄우는 자리는 반드시 B로 일치해야 한다.

`close`와 `disband`는 A에서 수행한다. coordinator 워크트리를 회수하는 것이 종료 절차에 포함되는데, 자기가 서 있는 워크트리는 스스로 제거할 수 없기 때문이다.

## 인계 절차

선언 세션(A)이 순서대로 수행한다.

1. `kickoff-show`로 점유를 확인한다. 이미 점유되어 있으면 새로 시작하지 않는다. 같은 목표이면 기록된 coordinator에서 재개하도록 안내하고, 다른 목표이면 현재 점유자와 그 상태를 알린 뒤 사용자의 결정을 기다린다.
2. 사용자에게 확인해야 하는 목표, 수용 기준, 비목표, 필수 검사와 전달 범위를 [`user-choice.md`](user-choice.md)의 방식으로 한 번에 확정한다.
3. 확정한 내용을 브리프 파일로 쓴다. 부모 대화 전문을 넘기지 않고 작업 조건, 대상 파일, 근거 위치와 조직 파일 경로만 담는다.
4. Orca 자식 워크트리를 만들고 coordinator 세션을 시작한 뒤 브리프 경로를 전달한다. 실제로 반환된 워크트리 ID를 그대로 보관한다.
5. `kickoff-claim`으로 점유를 기록하고, 어느 워크트리가 무엇을 맡았는지 사용자에게 알린다. A는 여기서 감독을 시작하지 않는다.

점유는 워크트리를 만든 뒤에 요청한다. 실제로 반환된 ID를 적어야 하므로 순서를 바꿀 수 없고, 점유가 거부되면 방금 만든 워크트리를 회수한 뒤 보고한다.

coordinator 세션(B)은 시작하자마자 다음을 수행한다.

1. 브리프를 읽고 Goal을 하나 만든다. 이 Goal의 유일한 소유자는 B다.
2. 같은 터미널에서 `orchestration run-create`로 Run을 만들어 바인딩한다.
3. `kickoff-bind`로 점유 기록에 그 Run을 적는다. 이 호출이 거부되면 점유를 가진 워크트리가 아니라는 뜻이므로, Run을 그대로 두고 에스컬레이션한다.

호스트가 자식 워크트리나 새 세션 생성을 지원하지 않으면 인계하지 않는다. 이때는 A가 그대로 coordinator가 되어 Goal과 Run을 소유하고, 점유 기록의 `coordinator`에 A를 적는다. 인계한 것처럼 보고하지 않으며, 이 경우 종료 절차에 회수할 자식 워크트리가 없다는 점을 함께 알린다.

## 점유 해제

점유는 `close` 또는 `disband`가 끝난 뒤에 `kickoff-release`로 해제한다. 목표를 달성하지 못했더라도 해체를 마쳤으면 해제해야 하며, 그러지 않으면 같은 프로젝트에서 다음 kickoff를 시작할 수 없다. 해제된 기록은 지워지지 않고 `.omt/history/`에 해제 시각, 해제를 요청한 워크트리와 사유가 붙어 보관된다.

`--worktree`에는 자신이 끝내려는 coordinator의 ID를 적는다. 런타임은 이 값이 실제 보유자와 다르면 해제를 거부하므로, 오래된 정보를 가진 세션이 이미 교체된 kickoff를 끝내 버리는 일이 생기지 않는다.

coordinator의 liveness가 `unverifiable`이라는 이유로 점유를 자동 해제하지 않는다. 세 값을 서로 대체하지 않는 규율은 [`orca-runtime.md`](orca-runtime.md)의 `worker-list와 liveness` 절을 따른다. 사용자가 강제로 점유를 인수하겠다고 결정한 경우에만 `--reason taken-over --force`를 사용하고, 마지막으로 확인한 liveness와 인수 사유를 보고에 남긴다. `taken-over`는 `--force` 없이는 거부되므로, 조회 실패가 곧바로 인수로 이어지지 않는다.

## 치르는 비용

coordinator가 자식 워크트리로 한 단계 내려가므로 워커들은 그보다 한 단계 더 깊은 곳에 놓인다. Orca 중첩 깊이 제한에 더 빨리 닿게 되며, 한계에 걸리면 [`../skills/pm/SKILL.md`](../skills/pm/SKILL.md)가 정한 대로 PM·PL이 평평한 작업 파동으로 배정한다.
