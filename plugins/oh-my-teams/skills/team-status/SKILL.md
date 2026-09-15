---
name: team-status
description: oh my teams 상설 조직과 현재 kickoff Goal, 실행 팀, 워크트리, 검증 상태를 서로 구분하여 표시한다.
---

# 팀 현황

상설 조직 설정과 현재 kickoff 실행 상태를 별도 항목으로 표시한다.

현재 스킬 기준 `../../scripts/teams-org.mjs`를 절대 경로로 해석한다.

```text
node <runtime> show --org <project>/.omt/organization.json --state <coordinator-project>/.omt
```

설정된 조직도와 실제 실행 상태를 구분해 전달한다. 로컬 하네스 보고서가 없으면 실행 상태는 `unsettled`이며 종료 증거가 아니다. 감독 작업의 실시간 상태는 [`../../references/orca-runtime.md`](../../references/orca-runtime.md)의 discovery로 kickoff가 기록한 실행 파일을 그대로 사용해 해당 Run의 `worker-list`에서 확인한다. 이 세션에서 discovery를 이미 마쳤으면 기록된 실행 파일로 조회만 하고 가이드를 다시 읽지 않는다. `live / unverifiable / exited`를 그대로 보존한다.

상태를 사용자에게 표시하기 직전에 해당 Goal과 `worker-list`를 다시 조회한다. `live` worker 수를 함께 표시하고, Goal이 `blocked`이면 그대로 `blocked`라고 표시한다. workflow의 `blocked`는 실패한 task가 하나 있다는 뜻이며 `workflow-retry`로 되돌릴 수 있는 일시 상태다. Goal의 `blocked`와 다른 값이므로 한쪽을 다른 쪽으로 옮겨 적지 않는다. `live` worker가 0명이고 상태를 확인할 수 없는 worker도 없으면 계획, 다음 단계 또는 기존 커밋이 있더라도 `in-progress`라고 표시하지 않고 `stopped`라고 표시한다. `unverifiable` worker만 남았다면 실행 중이라고 추정하지 않고 `unverifiable`이라고 표시한다. 계획의 존재, 대기 중인 다음 단계, 완료된 코드 변경과 현재 실행 중인 구현을 서로 다른 항목으로 구분한다.

조직이 없으면 아직 구성되지 않았다고 알린다. 조직도를 보기만 하는 요청에서 구성이나 구독 질문을 시작하지 않는다. 모델 호출로 조직도를 다시 그리지 않는다.
