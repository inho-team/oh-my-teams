# 예약과 실행 연결

여러 작업의 예산과 동시 실행 제약은 다음 순서로 적용한다.

1. `workflow-resume`에서 실행 가능한 task를 확인한다.
2. 외부 실행 전에 `workflow-reserve --id ID --state DIR --revision N --execution FILE`을 호출한다.
3. 현재 Orca 가이드로 worker를 시작한다. 예약한 attempt ID를 실행 기록에 연결한다.
4. 실제 receipt를 받으면 `workflow-attach`로 같은 task/attempt에 연결한다.
5. 제한 편집 worker는 `work`에 `--workflow-id ID --attempt-id ID`를 함께 전달한다.
6. provider 호출마다 원장에서 호출권을 소비하며, 종료 시 `workflow-settle`로 정산한다.

예약 입력:

```json
{
  "schemaVersion": 1,
  "eventId": "reserve-task-a-1",
  "taskId": "task-a",
  "attemptId": "attempt-task-a-1",
  "callAllowance": 2
}
```

receipt 연결에는 다른 eventId와 실제 실행 식별자를 사용한다. 예약량은
연결 중 변경할 수 없다. 예약과 receipt 연결 사이에 중단되면 새로운
worker를 곧바로 만들지 않고 기존 launch를 조회한다. 외부 명령이 실제로
예약 전에 호출되지 않도록 하는 책임은 이 순서를 실행하는 coordinator에
있다. 직접 외부 CLI를 호출하는 프로그램까지 원장이 강제 통제하지 않는다.

모델 호출권은 provider 호출 전에 저장된다. 이 직후 프로세스가 죽으면
호출 여부가 불명확하므로 해당 호출권을 다시 사용하지 않는다. 이미 소비한
호출보다 작은 값을 정산하면 거부한다. 다른 worker로 동일 attempt를 재실행할
수 없으며, 종료 사실과 재작업 근거를 기록한 새 attempt를 사용한다.

## 최종 통합 수용

다중 task workflow는 생성 요청에 `integrationTask`로 최종 통합 task v2
파일을 지정한다. 생성 시 base와 계약 해시를 고정하며 하위 task와 다른
task ID를 사용한다. 기존 다중 workflow에 이 계약이 없으면 통합 수용은
차단되므로 새 계약을 포함해 workflow를 구성해야 한다.

하위 결과가 모두 수용되면 상태는 `integration-pending`이다. 최종 통합
checkout에서 고정 계약의 report·review·PM acceptance를 준비한 뒤
`workflow-accept --id ID --state DIR --revision N --repo DIR --report FILE`로
수용한다. 이 명령은 현재 source의 검증과 gate를 다시 확인하고 하위 task
revision·attempt·수용 결과 ID 집합을 통합 결정에 기록한다. `workflow-resume`은
과거 통합 결과를 현재 소스 검증 없이 재수용하지 않는다.
