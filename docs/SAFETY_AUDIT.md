# 실행 안전성 재검증

이 기록은 기존 완료 체크박스와 주석 개수만으로 동작을 보장할 수 없다는
재검토에서 시작했다. 경량 `gpt-5.6-luna` 세 작업으로 workflow 조사,
품질 검사, CLI 통합 테스트를 나눴다. 두 작업은 사용량 한도로 중단돼
주 에이전트가 남은 수정과 검증을 이어받았다.

## 수정 및 재현 근거

- 검토·수용 기록 작성 경쟁: 공통 비동기 file lock을 검증부터 기록까지
  유지한다. 같은 review ID를 실제 CLI 프로세스 두 개로 동시에 기록하면
  하나만 성공하는 통합 테스트를 추가했다.
- 최신 반려가 이전 승인을 취소하지 못함: 최신 review sequence와 구현
  실행 ID를 사용한다. CLI 통합 테스트에서 승인·수용 후 finding 없는
  `changes-requested`를 기록하면 다시 수용할 수 없음을 확인한다.
- 전체 동시 실행 한도 우회: 실제 `attachExecution`에서 전체·역할 한도와
  실행 중인 작업의 파일 충돌을 검사한다. 추천 목록만 검증하지 않는다.
- 오래된 gate 적용: pending 작업이나 다른 실행 ID의 gate로 수용하지
  않는다. 새 반려가 도착하면 workflow의 acceptedResult도 제거한다.
- 강제 종료 후 남은 lock: 같은 호스트의 소유 PID가 종료됐다는 OS 근거가
  있을 때만 복구한다. 실제 자식 프로세스를 SIGKILL한 뒤 검증했다.
  소유자가 불명확하거나 다른 호스트인 lock은 자동 회수하지 않는다.
- event/state 중간 중단: 원자적으로 기록된 transaction에 다음 state와
  events를 함께 보관하고 lock 안에서 재적용한다. journal 저장 후
  materialization 전 중단을 모사한 회귀 테스트를 추가했다.
- 문서 검사 누락: multiline·구조분해 인자·export arrow 함수와
  backtick이 포함된 긴 실행문을 검사하는 부정 사례를 추가했다.
- 병렬 예산 중복 배정: 실행 receipt 연결 시 callAllowance를 기록하고
  running attempt의 예약량을 차감한다. 다른 attempt의 예약분을 사용한
  정산은 거부한다. `work --workflow-id ID --attempt-id ID`는 모델 호출
  직전에 원장에 callsStarted를 저장한다. 재시작·중복 worker·fallback으로
  예약량을 넘을 수 없으며 소비한 호출을 정산에서 줄일 수 없다.
  `workflow-reserve`로 외부 launch 전 자리와 호출량을 먼저 예약한다.
  같은 attempt에 `workflow-attach`로 실제 receipt를 연결하며 이때 attempt
  수를 다시 차감하지 않는다. launch 도중 중단된 예약은 재개 시
  `launch-reconcile-required`로 남으므로 실제 Orca 상태를 조회해야 한다.

## 검증 범위와 남은 항목

2026-09-16 최종 점검에서 `npm test`의 276개 테스트, `npm run quality`의
73개 활성 모듈·210개 공개 export 검사, `npm run format:check`의 Prettier
검사, `npm run eval:organization`의 7개 결정적 시나리오가 모두 통과했다. 테스트는 실제 CLI 프로세스와 테스트 전용
provider를 사용하며, 이 최종 점검에서는 추가 유료 모델을 호출하지 않았다.

품질 검사는 여전히 경량 소스 검사다. JSDoc의 의미적 정확성, 모든 JS
문법, 모든 인자별 설명까지 보장하지 않는다. 파일 journal은 단일 호스트
범위이며 전원 손실의 fsync 보장과 다중 호스트 공유 저장소는 검증하지
않았다. 소유 PID 재사용이나 복구용 lock 자체가 남는 경우에는 안전하게
중단할 수 있다.

workflow 전체 수용은 고정된 integrationTask와 현재 통합 evidence·review·PM
수용에 연결했다. 하위 수용만으로 완료되지 않으며 실패·stale source를
거부하는 테스트를 추가했다. workspace receipt는 선택된 Orca의 현재
worktree 조회 결과와 ID·경로·instance를 대조한다. 실제 외부 Dispatch
계약과의 연결은 별도 검증 범위다. GitHub 저장소 이름과 origin URL은
`inho-team/oh-my-teams`로 변경했다. 로컬 폴더도
로컬 Orca 작업 폴더로 이전하고 Git worktree 연결을 복구했다.
이전 경로에는 현재 Orca 세션을 위한 호환 심볼릭 링크를 유지한다.
Claude·Codex marketplace를 새 경로에 연결하고 1.4.0을 설치했다.
현재 문서의 과거 전체 완료 표시는 이러한
추가 검증의 완료 증거로 사용할 수 없다.
