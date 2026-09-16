---
name: close
description: 성공한 oh my teams kickoff를 검증하고 허가된 PR/MR 생성·병합과 워크트리 회수까지 마친 뒤 Goal을 완료한다.
---

# 팀 종료

성공한 kickoff의 전달과 정리를 담당한다. 활성 kickoff가 없으면 삭제나 병합을 추측해서 수행하지 않는다.

1. 원래 Goal의 모든 수용 기준, 필수 검토, 최신 HEAD의 검사와 미해결 사항을 확인한다.
2. 눈으로 확인하지 말고 게이트를 실행한다. `merge-check`는 필수 검토와 PM 수용이 source·task hash에 연결되기 전에는 병합을 거부하며, 비정상 종료는 병합 중단 조건이다.

```text
node <runtime> verify --task <integration-task.json> --repo <integration-worktree> --state <shared-state>
node <runtime> merge-check --evidence <evidence.json> --task <integration-task.json> --repo <integration-worktree> --base <origin/main> --report <report.json> --state <shared-state>
node <runtime> workflow-status --id <workflow> --state <shared-state>
```

3. 변경이 커밋되었고 원격 기준 브랜치와 충돌하지 않는지 확인한다. PR/MR을 만들거나 병합하는 작업은 사용자가 요청했거나 이미 위임한 범위에서만 수행한다.
4. PR/MR을 생성한 경우 실제 head SHA, 최신 base, 필수 CI와 승인 상태를 다시 확인한 뒤 [pl](../pl/SKILL.md)의 머지 절차에 따라 HEAD를 고정하여 병합한다. PR/MR 생성, 병합 또는 push를 할 수 없는 환경이면 수행한 것으로 표현하지 않고 정확한 제약과 필요한 후속 작업을 알린다.
5. 코드, 검사 증거, 검토 결과와 병합 식별자를 영속적인 위치에 보존한다. 실행 중인 프로세스가 없는지 확인한다. "정산"은 세 대상을 가리키므로 각각 따로 확인한다. Orca Dispatch의 accepted settlement, `workflow-status`가 보고하는 모든 attempt의 종결 상태, 그리고 하네스 보고서가 없을 때 붙는 `unsettled` 표시는 저장 위치와 확인 명령이 서로 다르다.
6. Orca의 현재 가이드에 따라 정산이 끝난 worker를 release하고 child worktree를 회수한다. 보존되지 않은 변경, 살아 있는 프로세스, 상태 불명 worker가 있으면 삭제하지 않으며, 종료를 확인하지 못한 worker는 `worker-abandon`으로 봉인한다.
7. 환경이 워크트리 삭제를 지원하지만 별도 최종 승인이 필요한 경우에는 정확한 대상을 제시하고 승인을 받은 뒤 삭제한다. 승인은 [`../../references/user-choice.md`](../../references/user-choice.md)의 방식으로 받으며, 삭제 대상과 되돌릴 수 없다는 사실을 선택지에 함께 적는다. 환경이 삭제 자체를 지원하지 않으면 불가능한 승인을 요구하지 않고 사용자가 실행할 정리 절차를 제공한다.
8. 요청된 전달과 정리가 모두 끝난 뒤에만 kickoff Goal을 완료 처리한다. 환경 제약으로 정리를 사용자에게 넘긴 경우에는 남은 정리 항목을 명시해 보고한 뒤 완료 처리한다.

최종 기록에는 Goal 결과, PR/MR 주소 또는 식별자, 병합 커밋, 검사 근거, 회수·삭제한 워크트리와 보존한 후속 항목을 포함한다. 사용자에게 전달하는 문장은 [`../../references/korean-result-reporting.md`](../../references/korean-result-reporting.md)의 기준을 따른다.
