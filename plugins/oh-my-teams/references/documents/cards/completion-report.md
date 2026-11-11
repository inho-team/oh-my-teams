<!-- document.schema.json과 protocol.yaml에서 생성한 파일입니다. 직접 수정하지 않고 `npm run cards`로 갱신합니다. -->

# completion_report

close에서 원래 요청과 최종 결과를 대조할 때 사용합니다.

## 필드

`?`가 붙은 필드만 생략할 수 있으며, 여기에 없는 필드는 추가하지 않습니다. `<이름>`은 아래의 공통 구조를 가리킵니다.

```text
schema_version: 1
kind: completion_report
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
  outcome: completed | incomplete
  acceptance_results: 다음 객체의 목록 (1개 이상)
    criterion: 문자열
    result: met | unmet | unknown
    evidence: <evidence> 목록
  checks: 다음 객체의 목록
    name: 문자열
    required: true | false
    status: passed | failed | unknown | skipped | unregistered
    command: 문자열
    evidence: <evidence> 목록
    source_commit?: 전체 커밋 SHA
  ci: <ci> 목록
  delivery: <delivery>
  cleanup: <cleanup>
  remaining: 문자열 목록
  uncertainties: 문자열 목록
  evidence: <evidence> 목록
  reviews?: <reviewReceipt> 목록

<evidence>
  source: file | git | orca | ci | user
  locator: 문자열
  excerpt?: 문자열
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
<reviewReceipt>
  request_id: 문자열
  result_id: 문자열
  reviewer_session_id: 문자열
  implementation_session_id: 문자열
  source_commit: 전체 커밋 SHA
  conclusion: no_findings | changes_requested | inconclusive
  independent: true | false
  evidence: <evidence> 목록 (1개 이상)
<deliveryReceipt>
  mode: commit | pr | merge | artifact
  target: 문자열
  source_commit: 전체 커밋 SHA
  observed_at: RFC 3339 시각
  evidence: <evidence> 목록 (1개 이상)
  delivered_commit?: 전체 커밋 SHA
```

## 규칙

- 수용 기준마다 met, unmet 또는 unknown과 근거를 기록하며, met에는 근거가 필요합니다.
- 통과한 검사에는 근거가 필요하며 CI 성공은 최종 subject.commit과 연결합니다.
- completed는 모든 수용 기준과 필수 검사, 승인 근거로 사용한 CI가 통과하고 필수 남은 일이 없는 경우에만 사용합니다.
- incomplete에는 remaining에 남은 일을 기록합니다. 전달과 정리의 상태도 각각 기록합니다.
- 원래 작업 요청과 대조하여 수용 기준을 빠뜨리거나 필수 검사의 이름·명령·필수 여부를 줄이지 않습니다.
- completed를 기록하기 전에 요청한 전달과 필수 정리가 실제로 완료됐는지 확인합니다.
- verification이 있는 작업의 completed 보고는 통과한 checks에 최종 source_commit을 기록하고 요청한 필수 CI를 이름별로 한 번씩 포함해야 합니다. 대상 브랜치도 요청과 같아야 합니다.
- reviews를 기록하면 결과 ID가 중복되지 않아야 합니다. completed의 모든 검토는 최종 커밋·구현 세션과 연결되고 no_findings여야 하며 독립 검토자는 구현자와 달라야 합니다.
- 필수 독립 검토가 있으면 최종 커밋의 독립 검토 근거가 필요합니다. 원문 요청·결과의 대응과 실제 실행 ID는 소유 세션이 확인합니다.
- delivery.receipt는 실제 전달을 관측한 경우에만 기록하고 최종 소스 SHA와 연결합니다. 원래 작업 요청과 전달 방식·대상을 대조합니다.
- commit과 merge 전달 관측 기록에는 delivered_commit이 필요합니다. commit은 소스 SHA와 같아야 하며 merge는 소유 세션이 실제 병합 결과와 소스의 연결을 확인합니다.
- 구조 검사는 근거의 존재·진위나 실제 사용자 허가를 인증하지 않습니다. 검증 조건이 요구한 근거가 없으면 incomplete와 남은 일을 기록합니다.

## 함께 읽을 자료

- 식별자, 시각, 대상과 YAML 작성의 [공통 규칙](common.md)을 따릅니다.
- 값의 형태는 예제에서 확인합니다: [verified-completion.example.yaml](../verified-completion.example.yaml), [completion-report.example.yaml](../completion-report.example.yaml). 예제의 식별자와 관측값은 가상의 값입니다.
- 이 카드에 없는 내용을 확인해야 할 때에만 [스키마](../document.schema.json)와 [사용 규칙](../protocol.yaml)을 읽습니다.
