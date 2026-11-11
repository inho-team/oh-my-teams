<!-- document.schema.json과 protocol.yaml에서 생성한 파일입니다. 직접 수정하지 않고 `npm run cards`로 갱신합니다. -->

# task_request

kickoff에서 목표, 수용 기준과 허가된 전달 범위를 정할 때 사용합니다.

## 필드

`?`가 붙은 필드만 생략할 수 있으며, 여기에 없는 필드는 추가하지 않습니다. `<이름>`은 아래의 공통 구조를 가리킵니다.

```text
schema_version: 1
kind: task_request
id: 문자열
issued_at: RFC 3339 시각
in_reply_to?: 문자열
issuer:
  session_id: 문자열
subject:
  worktree_id: 문자열
  commit?: 전체 커밋 SHA
  implementation_session_id?: 문자열
payload:
  goal: 문자열
  scope: 문자열 목록 (1개 이상)
  acceptance_criteria: 문자열 목록 (1개 이상)
  constraints: 문자열 목록
  required_checks: 다음 객체의 목록
    name: 문자열
    command: 문자열
  delivery:
    mode: none | commit | pr | merge | artifact
    target: 문자열 | null
    authorization: 문자열 | null
  cleanup_required: true | false
  evidence: <evidence> 목록
  verification?: <verification>

<evidence>
  source: file | git | orca | ci | user
  locator: 문자열
  excerpt?: 문자열
<verification>
  required_ci: 다음 객체의 목록
    name: 문자열
    target_branch: 문자열
  independent_review: true | false
  delivery_receipt: true | false
```

## 규칙

- 목표, 작업 범위, 중복되지 않는 수용 기준과 필수 검사 이름·명령을 구분합니다.
- 필수 검사가 없는 경우에는 빈 배열을 사용하며, 빈 배열을 검사 통과의 증거로 삼지 않습니다.
- 전달하지 않는 요청은 delivery.mode를 none, target을 null로 기록합니다.
- merge를 요청하면 실제 사용자의 허가 근거를 authorization에 기록합니다. PR 생성 허가만으로 병합을 허가받았다고 기록하지 않습니다.
- 사용자가 정리를 완료 조건으로 요구했다면 cleanup_required를 true로 기록합니다.
- 새 요청은 task-workflow.md에 따라 verification에 필수 CI 이름·대상 브랜치, 독립 검토와 전달 관측 기록의 필요 여부를 정합니다. 필요하지 않은 조건을 임의로 추가하지 않습니다.
- verification이 없는 이전 요청도 읽을 수 있지만 그 형식 검사만으로 새 검증 조건을 충족했다고 주장하지 않습니다.

## 함께 읽을 자료

- 식별자, 시각, 대상과 YAML 작성의 [공통 규칙](common.md)을 따릅니다.
- 값의 형태는 예제에서 확인합니다: [verified-task.example.yaml](../verified-task.example.yaml), [task-request.example.yaml](../task-request.example.yaml). 예제의 식별자와 관측값은 가상의 값입니다.
- 이 카드에 없는 내용을 확인해야 할 때에만 [스키마](../document.schema.json)와 [사용 규칙](../protocol.yaml)을 읽습니다.
