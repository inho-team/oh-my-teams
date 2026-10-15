---
name: status
description: Orca의 워크트리·세션 상태와 Git 결과를 조회해 현재 팀 작업의 소유자와 남은 일을 보여 준다.
---

# 작업 상태

사용 중인 Orca CLI의 `orca-cli` 가이드를 확인하고 Orca에서 저장소의 워크트리 목록, 각 워크트리의 전체 ID, 세션과 터미널 상태를 조회한다. Git에서 각 워크트리의 브랜치, HEAD와 수정 여부를 확인한다. 네이티브 Goal이 있다면 실제 Goal 상태도 조회한다.

확인한 작업의 소유 세션, 진행 중인 편집, 전달된 결과, 회수할 수 있는 자식 워크트리와 보존해야 하는 워크트리를 구분해 보고한다. Orca 조회가 불완전하면 그 사실을 표시하고, 보이지 않는 세션을 종료됐다고 추정하지 않는다. 과거 `.omt` 기록을 현재 실행 상태의 근거로 사용하지 않는다.

보고 본문은 [YAML 문서 규칙](../../references/documents/protocol.yaml)과 [JSON Schema](../../references/documents/document.schema.json)의 `status_report`로 작성한다. [상태 보고 예제](../../references/documents/status-report.example.yaml)의 가상 식별자와 값을 실제 관측값으로 바꾼다. `observation`과 `execution`, `delivery`와 `cleanup`을 각각 구분하고, 조회하지 못한 상태를 성공이나 종료로 채우지 않는다. 사용자에게 보여주는 문서는 검증한 같은 데이터에서 HTML로 생성하며, 표시를 지원하지 않는 호스트에서는 제약을 밝히고 요약한다.

CI 상태와 관측 오류, 재개할 실행의 상태는 [실패 상황의 판단 기준](../../references/failure-handling.md)에 따라 구분한다. 터미널 연결이나 출력 변화만으로 의미 있는 진전이나 작업 완료를 주장하지 않는다.
