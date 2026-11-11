<!-- document.schema.json과 protocol.yaml에서 생성한 파일입니다. 직접 수정하지 않고 `npm run cards`로 갱신합니다. -->

# interruption_report

disband에서 보존한 결과와 재개 절차를 전달할 때 사용합니다.

## 필드

`?`가 붙은 필드만 생략할 수 있으며, 여기에 없는 필드는 추가하지 않습니다. `<이름>`은 아래의 공통 구조를 가리킵니다.

```text
schema_version: 1
kind: interruption_report
id: 문자열
issued_at: RFC 3339 시각
in_reply_to: 문자열
issuer:
  session_id: 문자열
subject:
  worktree_id: 문자열
  commit?: 전체 커밋 SHA
  implementation_session_id?: 문자열
payload:
  summary: 문자열
  reason: 문자열
  undelivered_changes: 문자열 목록
  sessions: 다음 객체의 목록
    session_id: 문자열
    worktree_id: 문자열
    instance_id: 문자열
    liveness: running | exited | unknown
    action: preserved | stop_requested | stopped
    stop_authorization: 문자열 | null
  delivery: <delivery>
  cleanup: <cleanup>
  resume_steps: 문자열 목록 (1개 이상)
  uncertainties: 문자열 목록
  evidence: <evidence> 목록

<delivery>
  state: not_requested | pending | delivered | unknown
  reference: 문자열 | null
  receipt?: <deliveryReceipt>
<cleanup>
  state: not_requested | pending | completed | preserved | unknown
  remaining: 문자열 목록
<evidence>
  source: file | git | orca | ci | user
  locator: 문자열
  excerpt?: 문자열
<deliveryReceipt>
  mode: commit | pr | merge | artifact
  target: 문자열
  source_commit: 전체 커밋 SHA
  observed_at: RFC 3339 시각
  evidence: <evidence> 목록 (1개 이상)
  delivered_commit?: 전체 커밋 SHA
```

## 규칙

- 중단 사유, 마지막 커밋, 미전달 변경과 재개 절차를 기록합니다.
- 세션별 전체 워크트리 ID와 인스턴스를 보존합니다. 이 목록은 관측 기록이며 실행 등록부가 아닙니다.
- 세션 종료 요청이나 종료 조치에는 실제 사용자 허가 근거가 필요합니다.
- stopped는 실제 종료가 확인된 exited 세션에만 사용합니다.
- 생존을 확인하지 못한 세션은 unknown과 preserved로 기록하고 uncertainties에 확인할 수 없는 범위를 남깁니다.
- 결과 전달과 정리는 각각 보고하며 원래 작업의 목표와 기존 실행 식별자를 재개 절차에 보존합니다.

## 함께 읽을 자료

- 식별자, 시각, 대상과 YAML 작성의 [공통 규칙](common.md)을 따릅니다.
- 값의 형태는 예제에서 확인합니다: [interruption-report.example.yaml](../interruption-report.example.yaml). 예제의 식별자와 관측값은 가상의 값입니다.
- 이 카드에 없는 내용을 확인해야 할 때에만 [스키마](../document.schema.json)와 [사용 규칙](../protocol.yaml)을 읽습니다.
