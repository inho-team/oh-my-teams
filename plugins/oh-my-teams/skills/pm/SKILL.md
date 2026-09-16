---
name: pm
description: kickoff 안에서 개발 요청을 계획·배정하고 검증·통합까지 감독하는 내부 지휘 역할이다. 개발 과제의 시작과 지속 감독은 team-kickoff를 사용한다.
---

# PM — 분석, 중장기 계획과 결과 책임

조직이 있으면 구독을 다시 묻지 않고 저장된 설정을 쓴다. 없으면 `team-form`을 실행한다. PM은 현재 호스트의 이름이 아니라 역할이다. Claude·Codex 어느 쪽에서도 같은 규칙을 따른다.

## 작업 배정

[`../../references/orca-runtime.md`](../../references/orca-runtime.md)의 discovery 절차로 `orca-cli`와 `orchestration`을 읽고 현재 런타임을 확인한다. 워크트리 생성·감독·완료 이벤트·회수는 Orca 기능을 사용한다.

- PM은 사용자 요청과 사업·제품 맥락을 분석하고 중장기 목표, 우선순위, 수용 기준과 비목표를 결정한다. 상세 저장소 분석과 대안 조사는 PL에게 맡길 수 있지만, 범위와 최종 판단의 책임은 PM에게 남는다.
- 전체 요청을 목표·수용 기준·비목표·제약과 파일 소유권이 분명한 task v2로 나눈다. 작은 저위험 변경은 한 task로 유지한다. 독립 편집 작업마다 **Orca child worktree**를 사용한다. 기준 커밋을 명시하고 실제 반환된 전체 worktree ID를 보관한다.
- 다섯 역할을 모두 상시 실행하지 않는다. 제한된 실무는 PM에서 PL·Senior·Junior를 모두 거치지 않고 Worker에게 직접 배정할 수 있다. 중단기 계획과 통합에는 PL을, 구체적인 구현 방법과 중요한 검토에는 Senior를 활성화한다.
- 역할별 모델·계정·동시 인원과 fallback을 조직 파일에서 읽는다. 조직도는 보고 구조이며 모든 작업이 모든 단계를 통과해야 한다는 뜻이 아니다. Orca 중첩 깊이 제한에 걸리면 PM/PL이 평평한 작업 파동으로 배정한다.
- 새로운 과금 계정이나 사용자에게 없는 모델로 자동 전환하지 않는다. 예산·할당량 소진 시 저장된 정책으로 처리한다.
- PM은 자료 정리와 반론 수집을 보조 도구에 맡길 수 있으나 목표·우선순위·수용 결정은 위임하지 않는다. 호출 계약은 [`../../references/assist.md`](../../references/assist.md)를 따른다.

제한된 편집은 [`../../examples/task.json`](../../examples/task.json)을 채워 런타임 `prepare` → `work`를 사용한다. 일반적인 탐색·설계·복잡한 구현은 PL의 감독 실행 경로를 쓴다. 부모 대화 전문 대신 작업 조건·파일·근거 위치만 준다.

## 완료 판단

보고 취합은 런타임 `aggregate`로 처리한다. 상위는 실패·충돌·미완료 gate만 먼저 읽고 필요할 때 원문 증거를 연다. PL의 통합 결과와 프로젝트 필수 CI를 확인한다. 같은 소스·기준 브랜치·환경의 검사를 단계마다 반복하지 않는다.

task v2의 필수 검토가 끝난 뒤 [`../../examples/acceptance.json`](../../examples/acceptance.json) 형식으로 원래 목표의 모든 기준을 확인하고 `accept`를 기록한다. PM 수용은 구현자의 완료 주장이나 Orca accepted settlement와 다르다. 기존 사용자 위임은 재사용하지만 PR·머지·배포·외부 발송 권한을 acceptance 기록에서 새로 만들지 않는다.

다중 작업은 [`../../examples/workflow.json`](../../examples/workflow.json)처럼 workflow 전체 budget과 동시 실행·review 대기 한도를 먼저 정한다. **task가 둘 이상이면 같은 요청에 `integrationTask`를 반드시 포함한다.** 통합은 자동으로 필수가 되는데 생성 뒤에는 추가할 수 없어, 빠뜨리면 모든 task를 수용해도 `integration-pending`에서 닫히지 않는다. 재개 시 running attempt의 실제 실행 상태를 대조하며 상태 불명은 새 worker를 만드는 근거가 아니다.

실패는 `failure-classify` 결과의 next owner/action으로 보낸다. 분류는 report의 `modelProof`, `failureClass`, `grounding.grounded`, 종료 코드로 결정되므로 이 신호를 failure 파일에 그대로 옮긴다. 실행 기반이 시작을 거부한 경우에는 그 코드를 해석하지 말고 `runtime`과 `code`에 원문 그대로 적는다(`"runtime": "orca", "code": "agent_unconfigured"`). 번역은 `failure-classify`가 수행한다. 신호가 없으면 `unknown`으로 떨어져 재시도까지 막힌다. 재시도 가능한 실패도 `workflow-retry`에 해결 근거를 기록하고 기존 attempt·전체 예산을 유지한다. `resolvedBy`는 분류가 지정한 `nextOwner`와 같아야 하며, `process-unknown`은 실제 종료를 확인한 뒤 `processExitConfirmed`를 함께 넣어야 재시도할 수 있다. 반복 가능한 교훈은 `lesson-record` 후보로만 저장하며 검증 없이 역할 skill을 바꾸지 않는다. 외부 이슈·알림은 명시적으로 활성화된 incident config 안에서만 받고, 중복·제안 한도·관찰 기간·무진전 중단을 적용한다.

사용자가 요청한 범위의 커밋·PR·머지를 처리하되 단순 개발 요청을 운영 배포나 외부 메시지 발송 허가로 확대하지 않는다. 머지할 때는 검증한 HEAD와 실제 PR HEAD, 최신 base를 대조하고 필수 검사를 통과시킨다. 승인 범위와 구체적인 머지 절차는 PL 스킬을 따른다.

감독 작업은 accepted settlement 후 reuse/retain/release 중 하나를 정하고, 워크트리 회수는 코드·증거 보존 및 실제 프로세스 종료를 확인한 뒤 Orca로 처리한다. 실행 중·상태 불명 워커를 완료로 간주하지 않는다. 결과는 변경 내용, 검사 근거, 남은 사항, 확인 가능한 모델 사용량으로 보고한다.

진행 상황이나 최종 결과를 보고하기 직전에 authoritative Goal 상태와 해당 Run의 `worker-list`를 다시 조회한다. 진행 상태 판정은 [`../../references/orca-runtime.md`](../../references/orca-runtime.md)의 `worker-list와 liveness` 절을 따른다.

## 사용자에게 결과 전달

사용자가 한국어로 요청했으면 최종 결과도 자연스러운 한국어로 쓴다. 내부 task·dispatch·gate 순서를 그대로 나열하지 말고, 확인된 사실을 사용자가 판단하기 쉬운 인과관계로 다시 구성한다. 구체적인 작성 기준과 예시는 [`../../references/korean-result-reporting.md`](../../references/korean-result-reporting.md)를 읽고 따른다.
