# kickoff 등록부

한 프로젝트에서 kickoff를 몇 개든 동시에 진행할 수 있다. 각 kickoff는 자기 PM 워크트리에서 감독되며, 워커도 각자 자식 워크트리에서 일하므로 파일과 브랜치가 서로 겹치지 않는다. 등록부는 개수를 제한하지 않고, 어떤 kickoff가 어느 워크트리에서 돌고 있는지를 기록해 `status`·`close`·`disband`가 그 PM을 찾게 한다.

## 병렬 kickoff의 비용

워크트리 분리는 파일 충돌을 없애지만 구독 할당량까지 나누지는 않는다. 역할별 동시 인원(`concurrency`)과 호출 예산은 kickoff마다 자기 workflow state 안에서 따로 계산되고, 할당량 소진 스냅샷도 PM state마다 따로 쌓인다. 따라서 kickoff 두 개가 같은 구독을 쓰면 조직 파일에 적은 동시 인원의 두 배까지 워커가 동시에 돌 수 있고, 한쪽이 확인한 소진을 다른 쪽은 자기 호출이 실패할 때에야 안다. 여러 kickoff를 함께 진행할 때에는 이 점을 사용자에게 알리고, 필요하면 각 kickoff의 실행 깊이를 낮추거나 `adjust`로 동시 인원을 줄인다.

## 등록 위치와 내용

등록부는 `organization.json`이 있는 **원본 프로젝트**의 `.omt/kickoffs/<해시>.json`이다. Orca 워크트리 ID는 `<repoId>::<워크트리 경로>` 형식이라 `:`와 `/`를 포함하므로 파일 이름으로 쓸 수 없다. 그래서 런타임은 ID의 SHA-256 해시로 파일 이름을 정하고, 원래 ID는 항목 안의 `pm.worktreeId`에 그대로 보관한다. 해시에는 경로 구분자나 `..`가 들어가지 않으므로 어떤 ID를 받아도 항목이 등록부 밖에 쓰이지 않는다. 해시를 도입하기 전에 ID를 그대로 파일 이름으로 쓴 항목도 계속 조회·종료할 수 있다. `.omt/`는 Git에서 제외되고 워크트리마다 별개의 디렉터리이므로, PM 워크트리 안에 두면 종료를 수행하는 세션이 읽지 못한다. 런타임은 `--org`로 받은 조직 파일과 같은 자리에서만 등록부를 찾는다.

등록을 요청할 때 작성하는 파일은 다음 다섯 항목과, 이사가 시작하는 kickoff에서 덧붙이는 `director`를 담는다. `createdAt`은 런타임이 채우고, `runId`는 뒤따르는 `kickoff-bind`가 채운다.

```json
{
  "goal": "사용자가 승인한 목표 한 문장",
  "pm": {
    "worktreeId": "<Orca가 실제로 반환한 ID 전체, 예: 5a8b…::/Users/me/orca/workspaces/app/task>",
    "path": "<PM 워크트리 절대 경로>",
    "stateDir": "<PM 워크트리>/.omt"
  },
  "organizationRevision": 3,
  "brief": "<브리프 파일 절대 경로>",
  "delivery": { "mode": "local-merge", "branch": "main" },
  "director": {
    "terminalHandle": "<이사 세션의 Orca 터미널 핸들>",
    "checkoutPath": "<주인 체크아웃 절대 경로>"
  }
}
```

`director`는 이사가 자기 식별자를 기록하는 항목이다. `terminalHandle`은 PM이 `director-signal`을 보낼 터미널이고, `checkoutPath`는 `deliver`, `kickoff-release`, `kickoff-branch-cleanup`, `kickoff-merge-record`를 실행해도 되는 유일한 작업 디렉터리다. 필드 이름은 정확히 이 둘이어야 한다. `director`를 아예 적지 않은 요청은 이전 등록과 같은 호환 경로로 받아들이지만, 그 항목에서는 위 명령의 권한 검사가 경고만 남기고 진행한다.

런타임은 요청 파일의 키를 다음과 같이 다룬다. 위 형식에 없는 키는 항목에 저장되지 않으므로 등록은 성공하되 무시한 키를 `warnings`와 표준 오류의 `[omt] Warning:` 줄로 알린다. `director.terminalHandle`을 `terminal`이나 `handle`로 적는 식의 오타가 조용히 이사 기록 없는 등록이 되는 것을 막기 위해서다. `director`가 있는데 `checkoutPath`가 없으면 작업 디렉터리로 대신 채우지 않고 등록을 거부한다.

`delivery`는 브리프에 사용자가 확정한 전달 방식을 그대로 옮긴 값이며, 종료할 때 원본 프로젝트(주인 체크아웃)에 결과를 넣는 허가로 쓰인다. `mode`는 다음 셋 중 하나다.

| `mode` | 뜻 | `branch` |
|---|---|---|
| `local-merge` | `close`에서 `deliver`로 주인 체크아웃의 브랜치에 병합한다. 원격 저장소가 없거나 브리프가 로컬 커밋을 요구할 때 쓴다. | 병합할 브랜치, 필수 |
| `pull-request` | 그 브랜치를 base로 PR/MR을 만들어 병합한다. | PR의 base 브랜치, 필수 |
| `none` | 주인 체크아웃에 병합하지 않는다. | 기록하지 않는다 |

런타임은 다음 경우에 등록을 거부한다.

- 같은 워크트리가 이미 다른 kickoff를 감독하고 있을 때. PM 세션 하나는 Goal 하나를 소유하고 Run 하나를 바인딩하므로, 두 번째 kickoff에는 감독할 주체가 없다. 새 PM 워크트리를 만든다.
- `director`가 있는데 `checkoutPath`가 없을 때. 이사 기록이 어느 디렉터리를 가리키는지 알 수 없으면 권한 검사가 의미를 잃는다.
- 브리프 파일이 실제로 없을 때. PM은 부모 대화 대신 이 파일을 읽고 시작한다.
- `organizationRevision`이 현재 조직 revision과 다를 때. 오래된 조직 스냅샷으로 팀을 띄우지 않게 한다.
- `delivery`가 없거나, `mode`가 세 값이 아니거나, `local-merge`·`pull-request`인데 `branch`가 없을 때. 전달 허가가 기록되지 않은 kickoff는 종료할 때 무엇을 병합해도 되는지 알 수 없다.

단일 kickoff 시절의 `.omt/active-kickoff.json`이 남아 있으면 등록부를 처음 읽거나 쓸 때 그 PM 워크트리의 항목으로 옮겨지므로, 그 kickoff도 그대로 종료할 수 있다. 등록 항목의 키를 `pm`과 `selfPm`으로 바꾸기 전에 `coordinator`와 `selfCoordinator`로 기록된 항목과 요청 파일도 새 키로 읽으며, 항목은 다음에 기록될 때 새 키로 저장된다. 옛 키와 새 키가 함께 있고 값이 다르면 어느 쪽이 맞는지 판단할 수 없으므로 거부한다.

## 명령

현재 문서 기준 `../scripts/teams-org.mjs`를 절대 경로로 해석한다.

```text
node <runtime> kickoff-show --org <project>/.omt/organization.json
node <runtime> kickoff-claim --org <project>/.omt/organization.json --from <claim.json>
node <runtime> kickoff-bind --org <project>/.omt/organization.json --worktree <id> --run <runId>
node <runtime> kickoff-release --org <project>/.omt/organization.json --worktree <id> --reason completed
node <runtime> kickoff-merge-record --org <project>/.omt/organization.json --worktree <id> --head <검증한 HEAD> --merge-commit <병합 커밋> [--remote <remote-name>]
node <runtime> kickoff-branch-cleanup --org <project>/.omt/organization.json --worktree <id> --branches <branch>[,<branch>...] [--remote <remote-name>]
node <runtime> deliver --org <project>/.omt/organization.json --worktree <id> --source <통합 워크트리> --head <검증한 HEAD> --evidence <evidence.json> --task <task.json> [--report <report.json> --state <pm-state>]
```

`kickoff-show`는 등록된 kickoff 전체를 돌려주며, `--worktree`를 주면 그 PM 워크트리의 항목만 돌려준다. `kickoff-bind`는 같은 `runId`를 다시 넣는 호출은 그대로 성공하지만 다른 Run을 넣으면 거부한다. 수신 확인을 놓친 재실행과 Run이 둘로 갈라지는 상황은 서로 다른 사건이기 때문이다. `kickoff-release`의 `--reason`은 `completed`, `disbanded`, `taken-over` 가운데 하나이며, 다른 kickoff의 항목은 건드리지 않는다. `deliver`는 `delivery.mode`가 `local-merge`인 kickoff만 병합하고, 병합한 HEAD와 주인 브랜치의 병합 커밋을 항목의 `delivered`에 남긴다. `local-merge` kickoff는 `delivered`가 없으면 `--reason completed`로 해제되지 않으며, 사용자가 전달 없이 닫기로 결정한 경우에만 `--force`를 붙인다.

`kickoff-merge-record`는 PR이 외부에서 병합된 뒤 그 병합 커밋을 등록부에 남기며, 이사만 실행한다. 기록하기 전에 주인 체크아웃의 git으로 세 가지를 확인하고 하나라도 어긋나면 거부한다. `--merge-commit`이 실제 커밋이어야 하고, `delivery.branch`(로컬 브랜치 또는 `--remote`로 고른 원격의 같은 이름 브랜치, 기본 `origin`)에서 도달할 수 있어야 하며, `--head`가 그 병합 커밋에 포함되어야 한다. PR이 원격에서 병합되었다면 먼저 주인 체크아웃에서 `git fetch`를 실행한다. 이 검사를 통과한 값만 `delivered`에 전체 커밋 ID로 저장되므로, 병합되지 않은 브랜치의 끝 커밋을 병합 커밋으로 적어 `kickoff-branch-cleanup`이 그 브랜치를 지우게 만들 수 없다. 병합 커밋이 `--head`를 포함하지 않는 squash 병합은 이 검사에서 거부되며, `kickoff-branch-cleanup`도 브랜치 커밋이 병합 커밋에 포함되어야 삭제하므로 같은 이유로 삭제하지 않는다.

`kickoff-branch-cleanup`은 `close` 절차에서만 호출하며 `disband`에서는 호출하지 않는다. `disband`는 실패 결과를 복구할 수 있도록 브랜치를 보존해야 하기 때문이다. `--branches`에 쉼표로 구분한 브랜치 이름 목록을 주면, 각 브랜치의 커밋이 전달 대상(`local-merge`이면 병합 커밋, `pull-request`이면 병합된 PR의 커밋)에 이미 포함되어 있는지를 `git merge-base --is-ancestor`로 확인한 뒤 원격과 로컬에서 삭제한다. 확인이 되지 않은 브랜치는 삭제하지 않고 `skipped` 목록에 남긴다. `delivery.mode`가 `none`이거나 `delivered` 기록이 없는 경우에도 전달을 확인할 수 없으므로 모든 브랜치를 `skipped`에 남긴다.

## 주인 체크아웃과 병합

원본 프로젝트, 즉 `organization.json`과 등록부가 있는 체크아웃은 kickoff의 **주인 체크아웃**이다. kickoff의 워크트리끼리 합치는 병합은 팀 내부 작업이므로 PM·PL이 게이트를 통과시킨 뒤 자유롭게 진행한다. 주인 체크아웃으로 들어가는 병합만 `close`에서 이사가 `delivery`에 기록된 방식으로 수행한다.

런타임은 이 경계를 다음과 같이 강제한다. 판단 기준은 그 체크아웃의 `.omt/kickoffs`에 진행 중인 kickoff가 있는지이며, kickoff 워크트리는 자기 등록부가 없으므로 주인으로 오인되지 않는다.

- `merge-check`는 주인 체크아웃을 `--repo`로 받으면 거부한다. 게이트는 통합 워크트리에서 실행한다.
- `role-terminal`과 `worker-start`는 주인 체크아웃에서 역할을 띄우는 요청을 거부한다. 역할이 주인 체크아웃에서 일하면 그 커밋이 곧바로 주인 브랜치에 쌓이기 때문이다.
- `deliver`는 통합 워크트리가 검증한 HEAD에 그대로 있는지, 주인 체크아웃이 기록된 브랜치이고 커밋되지 않은 변경이 없는지 확인하고, 병합 직전에 `merge-check`를 다시 실행한다. 충돌하면 병합을 되돌리고 실패로 보고하므로 주인 브랜치가 반쯤 병합된 채 남지 않는다.

이 검사는 런타임을 거치는 병합만 막는다. 역할이 주인 체크아웃에서 `git merge`나 `git commit`을 직접 실행하는 것은 막지 못하므로, 역할 스킬과 지시문도 같은 금지를 적는다.

## 두 세션의 역할

이사(A)와 PM 세션(B)은 하는 일이 다르다.

- **이사(A)**: 사용자와 목표를 확정하고, PM 워크트리를 만들어 인계하고, 등록한다. 이후에는 조회와 종료를 담당하는 관제 자리로 남는다. Goal을 만들지 않고 Run도 바인딩하지 않는다. 한 이사 세션이 여러 kickoff를 차례로 인계할 수 있다.
- **PM 세션(B)**: Goal을 소유하고 PM 역할로 실행을 감독한다. `worker-start`는 Run에 바인딩된 coordinator 터미널에서만 호출할 수 있으므로([`orca-runtime.md`](orca-runtime.md)의 `worker-start 래퍼` 절), Run을 만드는 자리와 워커를 띄우는 자리는 반드시 B로 일치해야 한다.

`close`와 `disband`는 A에서 수행한다. PM 워크트리를 회수하는 것이 종료 절차에 포함되는데, 자기가 서 있는 워크트리는 스스로 제거할 수 없기 때문이다.

## 인계 절차

이사(A)가 순서대로 수행한다.

1. `kickoff-show`로 등록된 kickoff를 확인한다. 같은 목표가 이미 진행 중이면 새로 시작하지 않고 기록된 PM 워크트리에서 재개하도록 안내한다. 다른 목표라면 함께 진행해도 되며, 이때 병렬 kickoff의 비용을 알린다.
2. 사용자에게 확인해야 하는 목표, 수용 기준, 비목표, 필수 검사와 전달 범위를 [`user-choice.md`](user-choice.md)의 방식으로 한 번에 확정한다.
3. 확정한 내용을 브리프 파일로 쓴다. 부모 대화 전문을 넘기지 않고 작업 조건, 대상 파일, 근거 위치와 조직 파일 경로만 담는다.
4. Orca 자식 워크트리를 만들고 PM 세션을 시작한 뒤 브리프 경로를 전달한다. 실제로 반환된 워크트리 ID를 그대로 보관한다. PM 세션은 PM 프로필의 모델로 띄워야 하므로 `worktree create --agent`를 쓰지 않고 [`orca-runtime.md`](orca-runtime.md)의 `PM 실행` 절에 따라 `role-terminal`로 연다. 그 절차가 모델을 전달하지 못하거나 터미널이 준비되지 않으면 브리프를 보내지 않고 멈춘 뒤 보고한다. A가 PM을 대신 맡지 않는다.
5. `kickoff-claim`으로 등록하고, 어느 워크트리가 무엇을 맡았는지 알린다. A는 여기서 감독을 시작하지 않는다.

등록은 워크트리를 만든 뒤에 요청한다. 실제로 반환된 ID를 적어야 하므로 순서를 바꿀 수 없고, 등록이 거부되면 방금 만든 워크트리를 회수한 뒤 보고한다.

PM 세션(B)은 시작하자마자 다음을 수행한다.

1. 브리프를 읽고 Goal을 하나 만든다. 이 Goal의 유일한 소유자는 B다.
2. 같은 터미널에서 `orchestration run-create`로 Run을 만들어 바인딩한다.
3. `kickoff-bind`로 등록부에 그 Run을 적는다. 이 호출이 거부되면 자기 워크트리 ID로 등록된 kickoff가 없다는 뜻이므로, Run을 그대로 두고 에스컬레이션한다.

### 인계할 수 없는 호스트

A가 PM을 겸하는 것은 호스트에 인계 수단 자체가 없을 때뿐이다. Orca 실행 파일이 없거나, 설치된 Orca가 `worktree create` 또는 `terminal create` 명령을 제공하지 않는 경우가 여기에 해당하며, 그 명령의 실제 오류를 증거로 남긴다. PM 터미널이 뜨지 않았거나, `role-terminal`이 `ready: false`를 돌려주었거나, 화면의 모델이 달랐던 것은 인계 수단이 없는 것이 아니라 인계에 실패한 것이다. 이때에는 A가 PM을 대신 맡지 않고 멈춘 뒤 보고한다.

조건을 충족하더라도 사용자에게 A가 PM을 겸한다는 사실과 그 증거를 알리고 승인을 받는다. 승인을 받으면 A가 그대로 PM이 되어 Goal과 Run을 소유하고, 등록 항목의 `pm`에 A를 적는다. 런타임은 PM 경로가 원본 프로젝트와 같은 등록 요청을 `selfPm`이 없으면 거부하므로, 요청 파일의 `selfPm`에 인계할 수 없는 이유와 오류 증거, 사용자 승인을 한 문장으로 적는다. 인계한 것처럼 보고하지 않으며, 이 경우 종료 절차에 회수할 자식 워크트리가 없다는 점을 함께 알린다. A는 Goal을 하나만 소유할 수 있으므로 이 환경에서는 한 세션이 kickoff를 하나씩만 감독한다.

## 종료

kickoff의 항목은 `close` 또는 `disband`가 끝난 뒤에 `kickoff-release`로 해제한다. 목표를 달성하지 못했더라도 해체를 마쳤으면 해제해야 한다. 그러지 않으면 `status`가 끝난 kickoff를 계속 진행 중으로 보여 주고, 그 워크트리에서 새 kickoff를 등록할 수 없다. 해제된 항목은 지워지지 않고 `.omt/history/`에 해제 시각과 사유가 붙어 보관된다.

PM의 liveness가 `unverifiable`이라는 이유로 항목을 자동 해제하지 않는다. 세 값을 서로 대체하지 않는 규율은 [`orca-runtime.md`](orca-runtime.md)의 `worker-list와 liveness` 절을 따른다. 사용자가 응답하지 않는 PM의 kickoff를 끝내기로 결정한 경우에만 `--reason taken-over --force`를 사용하고, 마지막으로 확인한 liveness와 결정 사유를 보고에 남긴다. `taken-over`는 `--force` 없이는 거부되므로, 조회 실패가 곧바로 종료로 이어지지 않는다.

## 치르는 비용

PM이 자식 워크트리로 한 단계 내려가므로 워커들은 그보다 한 단계 더 깊은 곳에 놓인다. Orca 중첩 깊이 제한에 더 빨리 닿게 되며, 한계에 걸리면 [`../skills/pm/SKILL.md`](../skills/pm/SKILL.md)가 정한 대로 PM·PL이 평평한 작업 파동으로 배정한다.
