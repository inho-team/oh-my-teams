<!-- document.schema.json과 protocol.yaml에서 생성한 파일입니다. 직접 수정하지 않고 `npm run cards`로 갱신합니다. -->

# review_request

consult에서 전달하는 검토 요청에 사용합니다.

## 필드

`?`가 붙은 필드만 생략할 수 있으며, 여기에 없는 필드는 추가하지 않습니다. `<이름>`은 아래의 공통 구조를 가리킵니다.

```text
schema_version: 1
kind: review_request
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
  purpose: advisor | lawyer | auditor
  question: 문자열
  facts: 문자열 목록
  options: 문자열 목록
  constraints: 문자열 목록
  acceptance_criteria: 문자열 목록 (1개 이상)
  evidence: <evidence> 목록

<evidence>
  source: file | git | orca | ci | user
  locator: 문자열
  excerpt?: 문자열
```

## 규칙

- 요청에는 질문, 사실, 선택지, 제약, 수용 기준과 근거를 구분해서 담습니다.
- 결과에는 추천 사항, 반대 근거, 지적 사항과 확인하지 못한 사항을 구분해서 담습니다.
- 지적 사항마다 출처와 위치를 포함한 근거를 하나 이상 남깁니다.
- changes_requested에는 지적 사항이 있어야 하며, no_findings에는 지적 사항이 없어야 합니다.
- inconclusive에는 판단을 완료하지 못한 이유를 uncertainties에 남깁니다.
- independent가 true이면 대상 커밋과 구현 세션을 고정하고 작성 세션이 구현 세션과 다른지 확인합니다.
- 독립 검토자의 원문은 보존하고 수정 결과를 새 요청과 새 문서로 검토받습니다.

## 함께 읽을 자료

- 식별자, 시각, 대상과 YAML 작성의 [공통 규칙](common.md)을 따릅니다.
- 값의 형태는 예제에서 확인합니다: [review-request.example.yaml](../review-request.example.yaml). 예제의 식별자와 관측값은 가상의 값입니다.
- 이 카드에 없는 내용을 확인해야 할 때에만 [스키마](../document.schema.json)와 [사용 규칙](../protocol.yaml)을 읽습니다.
