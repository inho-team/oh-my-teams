<!-- document.schema.json과 protocol.yaml에서 생성한 파일입니다. 직접 수정하지 않고 `npm run cards`로 갱신합니다. -->

# status_report

status에서 관측한 작업 상태를 보고할 때 사용합니다.

## 필드

`?`가 붙은 필드만 생략할 수 있으며, 여기에 없는 필드는 추가하지 않습니다. `<이름>`은 아래의 공통 구조를 가리킵니다.

```text
schema_version: 1
kind: status_report
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
  summary: 문자열
  observation: complete | partial | failed
  execution: unknown | running | succeeded | failed | stopped
  worktree:
    id: 문자열
    instance_id: 문자열
    owner_session_id: 문자열 | null
  git: 아래 객체 | null
    head: 전체 커밋 SHA
    dirty: true | false
  ci: <ci> 목록
  delivery: <delivery>
  cleanup: <cleanup>
  remaining: 문자열 목록
  uncertainties: 문자열 목록
  evidence: <evidence> 목록

<ci>
  name: 문자열
  build_id: 문자열 | null
  source_commit: 전체 커밋 SHA | null
  target_branch: 문자열 | null
  status: unregistered | queued | running | passed | failed | cancelled | skipped | unknown
  observed_at: RFC 3339 시각
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

- `authority`: Orca, Git과 CI의 실제 상태를 조회하며 별도 실행 등록부를 만들지 않습니다.
- `observation`: complete는 이번 조회의 필요한 관측을 모두 확보한 경우입니다. partial은 일부 관측에 실패한 경우이며, 실패한 범위를 uncertainties에 적습니다. failed는 필요한 관측을 확보하지 못한 경우입니다. execution은 unknown, git은 null로 두고 CI 항목을 남긴다면 현재 status는 unknown으로 기록하며 기존 build_id는 보존합니다. complete는 작업 완료를 뜻하지 않으며, succeeded는 호스트에서 작업 성공을 확인한 경우에만 사용합니다.
- `ci`: 빈 ci 배열은 검사 통과를 뜻하지 않습니다. 관측한 검사 이름과 상태를 각각 기록합니다. unregistered는 검사 미등록을 확인한 경우이며 build_id가 없어야 합니다. queued, running, passed, failed, cancelled와 skipped에는 실제 build_id가 필요합니다. passed에는 source_commit과 target_branch가 필요하며 source_commit은 관측한 Git HEAD와 같아야 합니다. 병합 커밋을 검사하는 CI에서도 source_commit에는 연결을 확인한 원본 소스 커밋을 기록합니다. 조회 실패를 검사 미등록이나 통과로 바꾸지 않습니다.
- `delivery`: delivered에는 실제 전달 위치가 필요하며 전달과 정리 상태는 별도로 보고합니다.
- `cleanup`: completed이면 remaining이 비어 있어야 합니다. preserved이면 remaining에 보존한 워크트리의 정확한 식별자와 이유를 적습니다.

## 함께 읽을 자료

- 식별자, 시각, 대상과 YAML 작성의 [공통 규칙](common.md)을 따릅니다.
- 값의 형태는 예제에서 확인합니다: [status-report.example.yaml](../status-report.example.yaml). 예제의 식별자와 관측값은 가상의 값입니다.
- 이 카드에 없는 내용을 확인해야 할 때에만 [스키마](../document.schema.json)와 [사용 규칙](../protocol.yaml)을 읽습니다.
