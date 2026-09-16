---
name: adjust
description: 저장된 oh my teams 상설 조직의 역할, 인원, 구독·모델과 보고 구조를 조정한다. 진행 중인 kickoff에는 기존 스냅샷을 유지한다.
---

# 팀 조정

이 스킬은 상설 조직을 조정하며, 진행 중인 kickoff의 목표나 수용 기준은 변경하지 않는다.

프로젝트 `.omt/organization.json`을 읽는다. 없으면 `form`으로 이동한다. 사용자 요청으로 바뀌는 항목에 대해서만 필요한 선택을 [`../../references/user-choice.md`](../../references/user-choice.md)의 방식으로 받는다. 기존 구독 배정을 전부 다시 묻지 않는다.

1. 현재 revision과 역할·프로필을 읽고 변경 전후를 정리한다. 이름 변경, 직급별 부모와 인원, 구독/모델, 추론 강도, 대체 순서, `opus-first`/`balanced` 프리셋을 지원한다. 역할 ID는 pm/pl/senior/junior/intern이다.
2. 실제 계정 선택은 `form`의 프로필 연결 규칙을 따른다. 새 구독이나 과금 경로를 임의로 선택하지 않는다.
3. 수정안을 별도 JSON에 쓰고 현재 스킬 기준 `../../scripts/teams-org.mjs`를 호출한다.

프리셋은 먼저 `preset`으로 변경되는 역할의 프로필, 대체 순서와 **동시 인원**을 미리 본다. 프리셋은 동시 인원을 1로 고정하므로 인원을 늘려 둔 조직은 줄어든다. 미리보기의 `concurrency` 변화를 사용자에게 그대로 알린다. 기존 구독·계정 프로필을 재사용하며, 없는 모델 프로필은 사용자가 `adjust`로 연결하기 전까지 적용하지 않는다. 명시적으로 적용할 때만 `--apply`를 붙인다.

```text
node <runtime> preset --org <project>/.omt/organization.json --name balanced --revision <read-revision>
node <runtime> preset --org <project>/.omt/organization.json --name balanced --revision <read-revision> --apply
```

```text
node <runtime> edit --org <project>/.omt/organization.json --from <edited.json> --revision <read-revision>
node <runtime> show --org <project>/.omt/organization.json
```

추론 강도만 바꿀 때는 해당 프로필의 `effort` 값을 수정한다. 허용값은 `form`에 정리된 실행기별 범위를 따르며, 실행기가 지원하지 않는 값이나 Agy 모델 ID의 강도 접미사와 어긋나는 값은 런타임이 거부한다. 강도를 원래대로 되돌릴 때는 `effort`를 지운다. 빈 문자열이나 `null`로 두지 않는다. 프리셋은 역할이 참조하는 프로필 자체를 교체하므로, 적용 뒤의 강도는 새 프로필에 저장된 값을 따른다. 미리보기에서 바뀐 프로필의 `effort`를 함께 확인해 사용자에게 알린다.

런타임은 순환·누락·없는 프로필·오래된 revision을 거부하고 이전 설정을 `.omt/history/`에 남긴다. 진행 중 작업은 생성 시의 스냅샷을 유지한다. 새 배정부터 변경을 적용한다. 이미 실행 중인 세션의 계정·모델을 바꾸거나 같은 편집 작업을 중복 실행하지 않는다.
