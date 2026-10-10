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

이 문서가 적는 수치는 소스에서 센 정적 계수이며 실행 결과가 아니다. 현재
계수는 `npm test`의 최상위 테스트 선언 1315개, `npm run quality`의
161개 활성 모듈·582개 공개 export, `npm run eval:organization`의 11개 결정적 시나리오다. 통과 여부는 각 명령을 실행한 기록의 종료 코드와 pass·fail·skipped
수로 확인한다. 2026-09-28 최종 점검에서는 `npm test`, `npm run quality`,
`npm run format:check`, `npm run eval:organization`을 실행해 모두 통과했으며, 그
날의 테스트 수는 위의 현재 계수와 같다고 보장하지 않는다. 테스트는 실제 CLI 프로세스와
테스트 전용 provider를 사용하며, 이 최종 점검에서는 추가 유료 모델을 호출하지 않았다.

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

감사(auditor) 역할의 신원 확인(`audit.mjs`의 `verifiedAuditor`·`verifiedPm`)은
호출 프로세스 자신의 `ORCA_TERMINAL_HANDLE` 환경변수를 launch ledger·Run
바인딩과 대조하는 방식이다. 이 검사가 막는 범위는 PM이나 이사가 감사
handle을 CLI 인자로 복사해 대리 판정하는 시도뿐이다. 막지 못하는 범위는
구현자·PM·이사 세션을 포함해 같은 OS 사용자로 실행되는 아무 프로세스가
자신의 환경 변수에 `ORCA_TERMINAL_HANDLE`을 직접 설정하거나 `orca terminal
send`로 감사 터미널에 명령을 넣는 경우다. 같은 OS 사용자로 실행되는 프로세스가 launch ledger(`launches.jsonl`)나
감사 기록(`audits/*.json`)을 직접 편집하는 경우도 막지 못한다. 이 파일들에는
`verifiedCaller`와 감사 수용 기록이 들어 있으므로, 직접 편집한 기록은 런타임이
검증한 기록과 파일만으로는 구별되지 않는다. 이 한계를 좁히는 lineage
bind·session-bind 설계를 검토했으나 위조 가능한 환경·조상 프로세스 구조를
신뢰 근거로 쓸 수 없다는 결함이 확인돼 구현하지 않기로 결정했다. 근거와
후속 과제(Orca 쪽 `ownerPid`·`ownerStartedAt` attestation)는
[`docs/plan/requirements-ledger-and-audit.md`의 B.6절](plan/requirements-ledger-and-audit.md)에
남겨 두었다.

## Git 실행 파일과 환경 변수의 신뢰 한계

감사 결과 수용은 결과 저장소의 HEAD를 Git으로 읽어 결속하는데, 이 조회에는
서로 다른 신뢰 수준의 두 경로가 있다.

`evidence.mjs`의 `git()`과 이를 감싼 `workspaceBinding(repo).head`는 실행 파일을
이름 `git`으로 지정하고, 호출한 프로세스의 환경 변수를 그대로 자식 프로세스에
넘긴다. 따라서 호출자가 `PATH`를 바꾸거나 `GIT_DIR`·`GIT_WORK_TREE` 같은
`GIT_*` 변수를 설정하면 조회 결과가 달라질 수 있다. 감사의 HEAD 결속과
증거 fingerprint는 이 조회 결과에 의존하므로, 같은 OS 사용자로 실행되는
프로세스가 이 값을 조작하는 경우는 현재 막지 못하는 잔여 위험이다. 이 경로를
고정 실행 파일과 고정 환경으로 바꾸는 작업은 아직 하지 않았다.

`local-adapter.mjs`의 Git 식별 조회(`--git-common-dir`)는 다르게 동작한다.
컴파일된 후보 경로(POSIX는 `/usr/bin/git`, Windows는 Git for Windows의 `bin`
또는 `cmd`)만 사용하고, POSIX에서는 root 소유이며 group·other가 쓸 수 없는
일반 파일일 때만 신뢰한다. 후보 중 신뢰할 수 있는 실행 파일이 하나도 없으면
등록되지 않은 단독 task의 자체 검사를 포함한 모든 Git 식별 조회가 실행되지
않고 거부된다. Homebrew처럼 위 경로가 아닌 곳에만 Git이 설치된 환경에서는 이
거부가 발생하며, 이것이 `resolveTrustedGitExecutable`의 오류 메시지가 이 절을
가리키는 이유다. 이 신뢰 경로는 `PATH`와 호출자 환경 변수의 조작을 막을 뿐이며,
후보 파일 자체를 수정할 권한이 있는 사용자는 막지 못한다.

복수 결과 저장소를 확정하는 증명(`requirements.mjs`의 `proveResultRepoContainment`)의
Git 호출은 같은 파일의 `runGit` 한 함수에만 있고, 이 함수는 `local-adapter.mjs`의
`runTrustedGitSync`만 호출한다. 이 실행기는 위의 `resolveTrustedGitExecutable`이 고른
고정 경로만 실행하고, 자식 프로세스에는 `process.env`의 어떤 값도 넘기지 않으며
(POSIX는 빈 환경, Windows는 `SystemRoot` 하나), 30초 시간 제한을 둔다. 신뢰할 수
있는 실행 파일이 없으면 `PATH`의 `git`으로 넘어가지 않고 증명을 거부한다. 따라서
Homebrew처럼 위 후보 경로 밖에만 Git이 설치된 환경에서는 결과 저장소를 확정할 수
없다. 테스트(`tests/auditor.test.mjs`의 f7-6b·f7-6c·f7-6d, `tests/execution-port.test.mjs`)는
다음을 고정한다. `PATH` 앞의 가짜 `git`이나 위조한 `GIT_DIR`·`GIT_WORK_TREE`·
`GIT_COMMON_DIR`가 있어도 거부 결과와 확정 결과가 같다. 신뢰 실행기 부재, 시간
초과, 프로세스 사망, 실제 Git 오류(손상된 커밋 객체, 빠진 중간 커밋)는 모두
거부로 끝나며, 이때 registry·audit·PM state 파일 바이트가 바뀌지 않는다. 신뢰
실행기 부재·시간 초과·프로세스 사망은 실제로 만들 수 없어 테스트가 띄운 자식
프로세스 안에서 `child_process.spawnSync`와 `fs.lstatSync`를 바꿔 주입한다. 이
주입은 테스트 쪽에만 있으며, 호출자가 증명의 실행기를 바꿀 인자·환경 변수·CLI
옵션은 없다.

증명은 종료 코드 0과 1만 Git의 답으로 인정한다. 부재 커밋은 `rev-parse --verify
--quiet`가, 비조상은 `merge-base --is-ancestor`가 1을 낼 때에만 "포함하지 못함"으로
세고, 그 밖의 종료 코드·실행 실패·시간 초과는 증명 실패로 거부한다.

이 실행기가 막는 것은 실행 파일 선택과 환경 변수를 통한 조작까지다. Git이 읽는
대상은 격리하지 않는다. 실측으로 확인한 바로는 후보 저장소의 자체 설정(`core.bare`
등)이 Git의 답을 바꾸고, 저장소가 아닌 하위 디렉터리는 상위 저장소로 해석된다.
시간 제한은 Git 자식에게만 종료 신호를 보내며 Git이 띄운 하위 프로세스의 회수는
보장하지 않는다. 신뢰 후보 `git` 파일을 직접 수정할 수 있는 사용자는 막지 못한다.

`kickoff-registry.mjs`의 `tryGit`은 0이 아닌 모든 종료를 같은 `null`로 돌려주므로
`isAncestor`는 Git 오류도 "조상 아님"으로 읽는다. 다만 이 함수를 쓰는 병합 기록
검증은 `null`이 되면 기록을 거부하고, 브랜치 정리는 `isAncestor`가 거짓이면(Git
오류 포함) 그 브랜치를 삭제하지 않고 `skipped` 목록에 남긴다. `errors` 목록에는
`push --delete`와 `branch --delete`가 실패한 경우만 들어간다. 따라서 Git 오류가 병합이나 조상 관계를 거짓으로 증명하는
방향으로 쓰이는 곳은 코드를 읽어 확인한 범위에서 없다.

`evidence.mjs`의 `git()`과 `kickoff-registry.mjs`의 `tryGit`은 이 실행기로 바꾸지
않았다. 두 함수가 `PATH`와 `GIT_*` 환경을 그대로 상속하는 한계는 그대로 남아 있다.
