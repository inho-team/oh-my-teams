---
name: org-show
description: Orca 조직 이름과 PM/PL/Senior/Junior/Intern 조직도, 구독·모델 배정, 작업 상태를 표시한다.
---

# 조직도와 상태

현재 스킬 기준 `../../scripts/orca-org.mjs`를 절대 경로로 해석한다.

```text
node <runtime> show --org <project>/.orca/organization.json --state <coordinator-project>/.orca
```

설정된 조직도와 실제 실행 상태를 구분해 전달한다. 로컬 하네스 보고서가 없으면 실행 상태는 `unsettled`이며 종료 증거가 아니다. 감독 작업의 실시간 상태는 `orca-cli`와 `orchestration` 스킬을 읽고 해당 Run의 `worker-list`에서 확인한다. `live / unverifiable / exited`를 그대로 보존한다.

조직이 없으면 아직 구성되지 않았다고 알린다. 조직도를 보기만 하는 요청에서 구성이나 구독 질문을 시작하지 않는다. 모델 호출로 조직도를 다시 그리지 않는다.
