---
name: close
description: 성공한 oh my teams kickoff를 검증하고 허가된 PR/MR 생성·병합과 워크트리 회수까지 마친 뒤 Goal을 완료한다.
---

# 팀 종료

종료 전에 Intern이 수행한 좁은 실무와 Junior의 통합·수정, Senior의 독립 검토가 실제 receipt와 필수 gate에 연결되었는지 확인한다. Intern 미사용 또는 상위 승격 사유와 결정적 검사 결과를 보존하며, 호출 수나 비용 추정만으로 수용하지 않는다.

성공한 kickoff의 전달과 정리를 담당한다. 활성 kickoff가 없으면 삭제나 병합을 추측해서 수행하지 않는다.

병합은 두 종류로 나뉜다. kickoff의 워크트리끼리 합치는 병합(worker 브랜치를 통합 워크트리나 PM 워크트리에 합치는 일)은 팀 내부 작업이므로 PM·PL이 게이트를 통과시킨 뒤 별도 허가 없이 수행한다. 반면 **주인 체크아웃**, 즉 kickoff를 선언한 원본 프로젝트의 브랜치로 결과를 넣는 병합은 이 절차에서 선언 세션만 수행한다. 사용자가 브리프에서 확정한 전달 방식이 그 허가이며, 등록 항목의 `delivery`에 기록되어 있다. 런타임은 kickoff가 진행 중인 주인 체크아웃에서 `merge-check`를 실행하거나 역할을 띄우는 요청을 거부하므로, 워커의 커밋이 주인 브랜치로 바로 들어가지 않는다.

종료할 kickoff의 PM 워크트리 ID로 `kickoff-show --worktree <pm-worktree-id>`를 먼저 조회한다. kickoff가 여럿이면 사용자가 지목한 것만 종료한다. 기록된 `pm.stateDir`이 아래 명령의 `<pm-state>`이고, 회수 대상은 기록된 PM 워크트리와 그 아래의 자식 워크트리다. 이 절차는 PM 세션이 아니라 kickoff를 선언한 세션에서 수행한다. 자기가 서 있는 워크트리는 스스로 제거할 수 없기 때문이다. 등록 항목의 형식은 [`../../references/kickoff-registry.md`](../../references/kickoff-registry.md)를 따른다.

1. 원래 Goal의 모든 수용 기준, 필수 검토, 최신 HEAD의 검사와 미해결 사항을 확인한다.
2. 눈으로 확인하지 말고 게이트를 실행한다. `merge-check`는 필수 검토와 PM 수용이 source·task hash에 연결되기 전에는 병합을 거부하며, 비정상 종료는 병합 중단 조건이다.

```text
node <runtime> verify --task <integration-task.json> --repo <integration-worktree> --state <pm-state>
node <runtime> merge-check --evidence <evidence.json> --task <integration-task.json> --repo <integration-worktree> --base <origin/main> --report <report.json> --state <pm-state>
node <runtime> workflow-status --id <workflow> --state <pm-state>
```

   게이트는 kickoff의 통합 워크트리에서 실행한다. 주인 체크아웃을 `--repo`로 주면 `merge-check`가 거부한다.
3. 등록 항목의 `delivery`로 주인 체크아웃에 전달하는 방법을 정한다. 이 값은 브리프에서 사용자가 확정한 전달 방식이므로 다시 묻지 않고 허가로 사용하며, 기록된 방식 밖으로 넓히지 않는다.
   - `local-merge`: 게이트를 통과한 통합 워크트리의 HEAD를 고정해 `deliver`로 `delivery.branch`에 병합한다. `deliver`는 병합 직전에 같은 `merge-check`를 다시 실행하고, 통합 워크트리가 그 HEAD에서 움직였거나, 주인 체크아웃이 기록된 브랜치가 아니거나 커밋되지 않은 변경이 있으면 거부한다. 병합이 충돌하면 `git merge --abort`로 되돌리고 실패를 보고한다. 이때 주인 체크아웃에서 충돌을 직접 해결하지 않고, 주인 브랜치를 통합 워크트리에 합쳐 해결하도록 PM에게 돌려보낸 뒤 게이트부터 다시 실행한다. 같은 HEAD로 다시 실행하면 병합하지 않고 기록된 결과를 돌려준다.
   - `pull-request`: `delivery.branch`를 base로 PR/MR을 만들고, 실제 head SHA, 최신 base, 필수 CI와 승인 상태를 다시 확인한 뒤 [pl](../pl/SKILL.md)의 머지 절차에 따라 HEAD를 고정하여 병합한다.
   - `none`: 주인 체크아웃에 병합하지 않는다.
   - `delivery`가 없는 항목은 이 기록을 도입하기 전에 등록된 kickoff다. 전달 방식을 추측하지 않고 사용자에게 확인한다.

```text
node <runtime> deliver --org <project>/.omt/organization.json --worktree <pm-worktree-id> --source <integration-worktree> --head <verified-head> --evidence <evidence.json> --task <integration-task.json> --report <report.json> --state <pm-state>
```

4. PR/MR 생성, 병합 또는 push를 할 수 없는 환경이면 수행한 것으로 표현하지 않고 정확한 제약과 필요한 후속 작업을 알린다.
5. 코드, 검사 증거, 검토 결과와 병합 식별자를 영속적인 위치에 보존한다. 워크트리를 회수하면 PM state의 headless 기록도 사라지므로, 회수 전에 역할별 사용량 스냅샷을 `<project>/.omt/history`에 남긴다. 스냅샷에 실패하면 그 사실을 최종 기록에 적고 종료 절차는 계속한다.

```text
node <runtime> usage-report --org <project>/.omt/organization.json --worktree <pm-worktree-id> --write
```

   실행 중인 프로세스가 없는지 확인한다. "정산"은 세 대상을 가리키므로 각각 따로 확인한다. Orca Dispatch의 accepted settlement, `workflow-status`가 보고하는 모든 attempt의 종결 상태, 그리고 하네스 보고서가 없을 때 붙는 `unsettled` 표시는 저장 위치와 확인 명령이 서로 다르다.
6. Orca의 현재 가이드에 따라 정산이 끝난 worker를 release하고 child worktree를 회수한다. 보존되지 않은 변경, 살아 있는 프로세스, 상태 불명 worker가 있으면 삭제하지 않으며, 종료를 확인하지 못한 worker는 `worker-abandon`으로 봉인한다.
7. kickoff 브랜치를 정리한다. 전달(병합)이 확인된 뒤에만 원격 브랜치와 로컬 브랜치, 그리고 회수한 하위 워크트리의 브랜치를 삭제한다. 확인은 브랜치 이름이나 PR 상태가 아니라 커밋 내용이 전달 대상에 포함되었는지를 검사한다(`git merge-base --is-ancestor`). 전달이 확인되지 않은 브랜치는 지우지 않고 결과에 남긴다. `disband`는 실패 결과를 복구할 수 있도록 브랜치를 보존하므로, 이 단계는 `close`에서만 수행하고 `disband`에서는 수행하지 않는다.

```text
node <runtime> kickoff-branch-cleanup --org <project>/.omt/organization.json --worktree <pm-worktree-id> --branches <branch>[,<branch>...] [--remote <remote-name>]
```

8. 환경이 워크트리 삭제를 지원하지만 별도 최종 승인이 필요한 경우에는 정확한 대상을 제시하고 승인을 받은 뒤 삭제한다. 승인은 [`../../references/user-choice.md`](../../references/user-choice.md)의 방식으로 받으며, 삭제 대상과 되돌릴 수 없다는 사실을 선택지에 함께 적는다. 환경이 삭제 자체를 지원하지 않으면 불가능한 승인을 요구하지 않고 사용자가 실행할 정리 절차를 제공한다.
9. 요청된 전달과 정리가 모두 끝난 뒤에만 kickoff Goal을 완료 처리한다. 환경 제약으로 정리를 사용자에게 넘긴 경우에는 남은 정리 항목을 명시해 보고한 뒤 완료 처리한다.
10. 마지막으로 이 kickoff의 등록 항목을 해제한다. `delivery.mode`가 `local-merge`인데 `deliver`가 병합을 기록하지 않았으면 `--reason completed`는 거부된다. 브리프가 요구한 전달 없이 완료로 닫으려면 사용자의 결정을 받은 뒤에만 `--force`를 붙이고, 전달하지 않은 사실을 보고에 적는다. 이 단계를 건너뛰면 `status`가 끝난 kickoff를 계속 진행 중으로 보여 주고, 그 워크트리에서 새 kickoff를 등록할 수 없다. 사용자에게 넘긴 정리 항목이 남아 있어도 Goal을 완료 처리했으면 항목은 해제하고, 남은 항목을 보고에 함께 적는다.

```text
node <runtime> kickoff-release --org <project>/.omt/organization.json --worktree <pm-worktree-id> --reason completed
```

최종 기록에는 Goal 결과, 전달 방식, 사용량 스냅샷 경로, PR/MR 주소 또는 식별자, 주인 브랜치의 병합 커밋, 검사 근거, 회수·삭제한 워크트리와 보존한 후속 항목을 포함한다. 사용자에게 전달하는 문장은 [`../../references/korean-result-reporting.md`](../../references/korean-result-reporting.md)의 기준을 따른다.
