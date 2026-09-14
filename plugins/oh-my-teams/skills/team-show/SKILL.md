---
name: team-show
description: oh my teams 팀 이름과 PM/PL/Senior/Junior/Intern 조직도, 구독·모델 배정, 작업 상태를 표시한다.
---

# 팀 구성과 상태

현재 스킬 기준 `../../scripts/teams-org.mjs`를 절대 경로로 해석한다.

```text
node <runtime> show --org <project>/.omt/organization.json --state <coordinator-project>/.omt
```

설정된 조직도와 실제 실행 상태를 구분해 전달한다. 로컬 하네스 보고서가 없으면 실행 상태는 `unsettled`이며 종료 증거가 아니다. 감독 작업의 실시간 상태는 `orca-cli`와 `orchestration` 스킬을 읽고 해당 Run의 `worker-list`에서 확인한다. `live / unverifiable / exited`를 그대로 보존한다.

상태를 사용자에게 표시하기 직전에 해당 Goal과 `worker-list`를 다시 조회한다. `live` worker 수를 함께 표시하고, Goal이 `blocked`이면 그대로 `blocked`라고 표시한다. `live` worker가 0명이고 상태를 확인할 수 없는 worker도 없으면 계획, 다음 단계 또는 기존 커밋이 있더라도 `in-progress`라고 표시하지 않고 `stopped`라고 표시한다. `unverifiable` worker만 남았다면 실행 중이라고 추정하지 않고 `unverifiable`이라고 표시한다. 계획의 존재, 대기 중인 다음 단계, 완료된 코드 변경과 현재 실행 중인 구현을 서로 다른 항목으로 구분한다.

조직이 없으면 아직 구성되지 않았다고 알린다. 조직도를 보기만 하는 요청에서 구성이나 구독 질문을 시작하지 않는다. 모델 호출로 조직도를 다시 그리지 않는다.
