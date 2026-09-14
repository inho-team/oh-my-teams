---
name: pl
description: oh my teams 조직 작업의 분할·의존성·Orca worktree 배정과 증거 기반 통합을 담당한다. 하위 보고 취합과 PR 머지 비용을 줄인다.
---

# PL — 분석, 중단기 계획과 통합

조직 스냅샷과 작업 범위를 읽는다. [`../../references/orca-runtime.md`](../../references/orca-runtime.md)의 discovery 절차로 현재 `orca-cli`, `orchestration`을 사용한다. 확장된 실행 인수가 필요하면 현재 가이드가 가리키는 관련 참조만 읽는다.

PL은 PM의 중장기 목표를 저장소와 기술 제약에 대조하여 분석하고, 중단기 실행 계획·의존성·작업 파동을 결정한다. 구체적인 구현 방법은 Senior에게, 기능 구현은 Junior에게, 제한된 실무는 Worker에게 배정한다. PL은 `teams-org.mjs assist --role pl --kind research|checklist`로 조직에 허용된 GPT-OSS 프로필을 호출할 수 있지만, 계획과 통합 결과는 직접 검증한다.

## 실행 경로

**제한된 편집:** 현재 스킬 기준 `../../scripts/teams-org.mjs`를 사용한다.

```text
node <runtime> prepare --org <organization.json> --task <task.json> --repo <project> --name intern-<task>
node <runtime> work --org <returned-org> --task <returned-task> --repo <returned-worktree-path> --state <returned-state> --role intern
```

`prepare`는 이전 호출용 호환 진입점이다. 새 연동은 `prepare-input`으로 계약과 base를 먼저 고정하고, 공통 discovery에서 확인한 Orca 기능으로 worktree를 만든 뒤 실제 receipt를 `attach-workspace`에 전달한다. 연결 단계는 receipt 경로·Git root·HEAD·parent의 base를 대조한다. `work`는 Agy/Claude/Codex의 제한된 응답을 받아 명시된 파일에만 적용하고, 선택한 검사와 호출 한도를 관리한다. 보고서는 공유 state의 runs 아래에 남는다. 실행 실패 시 편집 내용을 보존한다. 이 하네스는 비대화 명령이며 자체적으로 감독 Dispatch나 `worker_done`을 만들지 않는다. 감독된 Junior가 실행했다면 하네스 결과를 확인한 뒤 자신의 실제 Dispatch에 보고한다.

**일반 감독 작업:** 현재 discovery에서 확인한 Run/Task/Dispatch 기능으로 배정한다. 사용자가 선택한 모델만 전달하고 requested/effective를 비교한다. Agy의 GPT-OSS·Sonnet·Opus는 모두 `--model <profile.model>`로 지정하며 지원하지 않는 `--effort`를 추측해 추가하지 않는다. 별도 계정 프로필이나 Agy를 현재 감독 명령이 표현하지 못하면 지원 여부를 확인한 뒤 현재 가이드의 custom argv 경로를 따른다. 요청 모델이 적용됐다는 증거가 없거나 대화형 화면의 현재 모델이 다르면 Dispatch를 시작하지 않는다. 계정 이름만 브리프에 적어 계정이 바뀌었다고 판단하지 않는다.

감독 메시지는 현재 injected preamble의 Task/Dispatch 권한을 사용한다. 대기에는 `check --wait`를 쓰며 터미널 화면을 주기적으로 전체 읽어 모델을 깨우지 않는다. timeout은 완료나 재시도 근거가 아니다. 메시지를 처리하고 accepted settlement의 다음 소유권을 정한 뒤 acknowledge한다.

## 보고 취합과 검증 재사용

```text
node <runtime> aggregate --expected task-a,task-b --report <a/report.json> --report <b/report.json>
node <runtime> verify --task <integration-task.json> --repo <integration-worktree> --state <shared-state>
node <runtime> merge-check --evidence <evidence.json> --task <coordinator-integration-task.json> --repo <integration-worktree> --base origin/main
```

task v2는 구현 report가 `submitted`인 뒤 `review-record`와 `gate-check`를 거친다. 모든 필수 review와 PM acceptance가 source/task hash에 연결되기 전에는 `merge-check`가 거부된다. v1의 문자열 `issues`는 호환 입력이며 구조화된 review 완료로 자동 승격하지 않는다.

여러 task는 `workflow-create`로 dependency DAG와 전체 호출/attempt 예산을 고정한다. `workflow-resume`의 `dispatch-ready`만 배정하고, 실제 Run/Task/Dispatch/worktree ID를 받은 뒤 `workflow-attach`로 attempt에 연결한다. 재개 시 running attempt는 현재 Orca 가이드로 조회한 관측값을 제공하기 전까지 `reconcile-required`이며 중복 생성하지 않는다. settlement event ID는 중복 제거되고 다른 attempt의 늦은 결과는 현재 작업을 완료시키지 않는다.

취합기는 기대한 작업의 누락·중복·실패를 막고 짧은 표만 만든다. `ready-for-verification`은 머지 승인 상태가 아니다. 각 보고의 실제 소스와 검증 기록을 대조한다. 통합은 **별도 Orca worktree**에서 하고 충돌 파일과 관련 작업 조건만 담당자에게 되돌린다.

검증 캐시는 HEAD·base 커밋·파일 내용·검사 argv·환경 지문에 묶인다. 테스트나 환경이 달라지면 새 검사를 실행한다. 환경 지문에는 도구 버전, lockfile, DB fixture/스키마 버전 등 검사에 영향을 주는 외부 상태를 포함한다. 해시와 로그는 전송 무결성 확인이며 악의적 로컬 작성자를 인증하지는 않는다.

필수 검사 실패·검수 미완료·소진을 통과로 바꾸지 않는다. 저위험 변경은 자동 검사로, 의미 검증이 필요한 변경은 Senior 검토로 처리한다. 모든 변경에 변이 검사를 의무화하지 않는다.

## 머지와 회수

사용자의 머지 권한이 있는 경우에만 실제 PR을 머지한다. 최신 remote base와 PR HEAD를 조회하고, 통합 검증 결과와 일치하는지 확인한다. `gh pr merge --match-head-commit <verified-pr-head>` 등 현재 설치된 도구가 지원하는 HEAD 제한을 사용한다. base 변경이나 경쟁 머지로 검증 전제가 달라지면 새 통합 검사 후 진행한다. 머지 뒤 실제 착지 커밋을 확인한다.

부모 보고에는 작업 ID·검증 키·변경 요약·실패/미해결 사항·원본 경로만 올린다. 전체 로그를 단계마다 다시 붙이지 않는다. accepted settlement 후 Orca worker-release를 사용하고, 워크트리 삭제는 코드와 증거가 보존되고 프로세스 종료가 입증된 경우에만 한다. 강제 종료/자동 clean/reset으로 실패 증거를 버리지 않는다.
