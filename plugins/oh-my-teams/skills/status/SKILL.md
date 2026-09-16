---
name: status
description: oh my teams 상설 조직과 현재 kickoff Goal, 실행 팀, 워크트리, 검증 상태를 서로 구분하여 표시한다.
---

# 팀 현황

상설 조직 설정과 현재 kickoff 실행 상태를 별도 항목으로 표시한다.

진행 중인 kickoff와 각각이 어느 워크트리에서 돌고 있는지는 등록부에서 읽는다. kickoff가 여럿이면 항목마다 아래 조회를 반복해 kickoff별로 구분해 보여 준다. 현재 스킬 기준 `../../scripts/teams-org.mjs`를 절대 경로로 해석한다.

```text
node <runtime> kickoff-show --org <project>/.omt/organization.json
node <runtime> show --org <project>/.omt/organization.json --state <coordinator-project>/.omt
```

`kickoff-show`가 돌려준 각 항목의 `coordinator.stateDir`이 두 번째 명령의 `--state` 인자다. `active: false`이면 진행 중인 kickoff가 없다고 알리고 다른 워크트리를 뒤져 실행 상태를 추측하지 않는다. 같은 구독을 쓰는 kickoff가 둘 이상이면 함께 할당량을 소모하고 있다는 점도 표시한다. 등록 항목의 형식과 종료 조건은 [`../../references/kickoff-registry.md`](../../references/kickoff-registry.md)를 따른다.

조직도에는 선언된 역할만 나타난다. 다섯 역할을 모두 두지 않은 조직에서 생략된 역할을 누락으로 보고하지 않고, 그 역할의 일을 이어받은 역할이 무엇인지 함께 알린다. 설정된 조직도와 실제 실행 상태를 구분해 전달한다. 로컬 하네스 보고서가 없으면 실행 상태는 `unsettled`이며 종료 증거가 아니다. 감독 작업의 실시간 상태는 [`../../references/orca-runtime.md`](../../references/orca-runtime.md)의 discovery로 kickoff가 기록한 실행 파일을 그대로 사용해 해당 Run의 `worker-list`에서 확인한다. 이 세션에서 discovery를 이미 마쳤으면 기록된 실행 파일로 조회만 하고 가이드를 다시 읽지 않는다. `live / unverifiable / exited`를 그대로 보존한다.

workflow가 있으면 `workflow-status`가 돌려주는 현재 `depth`와 이번 실행이 쓰는 `roles`, 그리고 `depthHistory`의 변경 사유를 함께 표시한다. 조직도에 있지만 이번 실행 깊이에 포함되지 않은 역할은 누락이 아니라 이번 실행에서 쓰지 않는 역할로 표시한다.

상태를 사용자에게 표시하기 직전에 해당 Goal과 `worker-list`를 다시 조회한다. `live` worker 수를 함께 표시한다. 무엇을 `in-progress`·`stopped`·`unverifiable`·`blocked`로 표시할지, 그리고 workflow의 `blocked`를 Goal의 `blocked`와 구분하는 규칙은 [`../../references/orca-runtime.md`](../../references/orca-runtime.md)의 `worker-list와 liveness` 절을 따른다.

status는 조회만 하므로 등록 항목을 지우거나 고쳐 쓰지 않는다. coordinator가 응답하지 않아 liveness가 `unverifiable`로 남아도 마찬가지이며, 해제는 `close`와 `disband`만 수행한다.

조직이 없으면 아직 구성되지 않았다고 알린다. 조직도를 보기만 하는 요청에서 구성이나 구독 질문을 시작하지 않는다. 모델 호출로 조직도를 다시 그리지 않는다.
