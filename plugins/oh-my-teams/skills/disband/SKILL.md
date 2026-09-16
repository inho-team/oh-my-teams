---
name: disband
description: 실패·취소·중단된 oh my teams kickoff의 실행 팀을 안전하게 해체하고 원인과 복구 가능한 결과를 보존한다.
---

# 팀 해체

성공으로 종료할 수 없는 kickoff를 정리한다. 해체는 성공 완료가 아니며 실패를 숨기거나 Goal을 `complete`로 바꾸지 않는다.

원본 프로젝트의 `.omt/active-kickoff.json`을 먼저 읽어 해체 대상 coordinator와 `<shared-state>` 경로를 확인한다. coordinator 워크트리를 회수하므로 이 절차도 kickoff를 선언한 세션에서 수행한다. 점유 기록의 형식과 해제 조건은 [`../../references/kickoff-lease.md`](../../references/kickoff-lease.md)를 따른다.

1. 해체 사유를 `failed`, `cancelled`, `abandoned` 가운데 하나로 기록하고, 충족한 기준과 미완료 기준을 분리한다.
2. 새 작업 배정을 중단하고 살아 있는 worker와 프로세스에 취소를 전달한다. 종료가 확인되지 않은 프로세스를 사라진 것으로 간주하지 않는다.
3. workflow가 있으면 남은 attempt를 종결 상태로 만든다. 실행 중인 attempt는 `workflow-settle`에 `outcome: failed`와 실패 근거를 기록하고, 예약만 남은 attempt는 `workflow-release`로 반납한다. 이 단계를 건너뛰면 workflow가 영원히 `running`으로 남아 같은 목표를 다시 시작할 수 없다.

```text
node <runtime> workflow-settle --id <workflow> --state <shared-state> --revision <read-revision> --settlement <settlement.json>
node <runtime> workflow-release --id <workflow> --state <shared-state> --revision <read-revision> --release <release.json>
```

4. 유용한 변경은 커밋, 별도 브랜치 또는 복구 가능한 패치로 보존한다. 실패 로그, 검사 증거, 시도한 접근, 비용·사용량과 재개 조건을 남긴다.
5. 보존과 프로세스 종료가 확인된 child worktree만 Orca 가이드에 따라 회수하거나 삭제한다. 불명확한 워크트리는 유지하고 이유를 보고한다. 종료를 확인하지 못한 worker는 `worker-release` 대신 `worker-abandon`으로 봉인한다. `worker-release`는 정산이 끝난 worker 전용이며, 상태 불명 worker에 쓰면 살아 있을 수 있는 자원을 종료된 것으로 처리한다.
6. 해체 사유와 보존 위치를 기록한 뒤 점유를 해제한다. 실패로 끝났더라도 해제해야 같은 프로젝트에서 다시 시작할 수 있다. 다만 종료를 확인하지 못해 봉인만 해 둔 worker가 남아 있으면, 점유를 해제하면서 그 자원의 식별자와 상태를 해체 기록과 사용자 보고에 함께 남긴다.

```text
node <runtime> kickoff-release --org <project>/.omt/organization.json --worktree <coordinator-id> --reason disbanded
```

7. 상설 조직 설정과 과거 실행 기록은 삭제하지 않는다. 사용자가 조직 자체의 폐기를 명시적으로 요청한 경우에도 먼저 보관 위치와 삭제 범위를 제시하고 별도 승인을 받는다.

호스트가 Goal 취소 상태를 지원하면 그 상태를 사용한다. 지원하지 않으면 실행 기록에 해체 결과를 남기고, 실제로 차단 기준을 충족하지 않은 Goal을 임의로 `blocked` 또는 `complete`로 바꾸지 않는다.
