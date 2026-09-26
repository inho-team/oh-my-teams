---
name: roadmap
description: 로드맵을 읽고 phase 정본을 갱신하며 모든 역할이 작성 규칙을 따르도록 한다. 규칙 자체는 다시 적지 않고 reference를 참조한다.
---

# 로드맵

로드맵 정본은 [`docs/ROADMAP.md`](../../../docs/ROADMAP.md)이며, 로드맵 작성 규칙은 [`../../references/roadmap.md`](../../references/roadmap.md)에 정의되어 있다.

## 로드맵 읽기

로드맵을 읽고 현재 진행 상태를 파악한다. 로드맵의 phase 목록 표에서 자신의 역할에 해당하는 진행 상황을 확인한다. 역할별 적용 지점은 [`../../references/roadmap.md`](../../references/roadmap.md)의 「역할별 적용 지점」 절에 정의되어 있다.

## 로드맵 갱신

로드맵을 갱신할 때는 다음을 따른다.

- 로드맵 본문(`docs/ROADMAP.md`)은 이사만 고친다. PM은 자기 phase가 가리키는 하위 문서만 고치고 로드맵 본문은 건드리지 않는다. 이 규칙은 [`../../references/roadmap.md`](../../references/roadmap.md)의 「권한」 절에 정의되어 있다.
- phase에 들어가는 내용과 적지 않는 내용을 구분하는 기준은 [`../../references/roadmap.md`](../../references/roadmap.md)의 「로드맵에 적어도 되는 것」과 「로드맵에 적지 않는 것」 절을 따른다.
- phase를 만들거나 상태를 바꿀 때 합리화 차단표를 참조하여 규칙을 벗어나지 않도록 한다.

## 로드맵 링크 확인

로드맵과 그 가이드 항목의 마크다운 링크가 실제 파일로 해석되는지 확인한다. 링크가 실제로 존재하는 파일을 가리키는지 `npm test`로 검증한다.
