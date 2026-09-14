---
name: pl
description: Orca 조직 작업의 분할·의존성·워크트리 배정과 증거 기반 통합을 담당한다. 하위 보고 취합과 PR 머지 비용을 줄인다.
---

# PL — 분할과 통합

조직 스냅샷과 작업 범위를 읽는다. `orca-cli`, `orchestration`을 사용한다. 확장된 실행 인수가 필요하면 현재 CLI의 `references/coordinator-loop.md`, `references/placement-and-remote.md`, 필요할 때만 `references/low-level-topology.md`를 읽는다.

## 실행 경로

**제한된 편집:** 현재 스킬 기준 `../../scripts/orca-org.mjs`를 사용한다.

```text
node <runtime> prepare --org <organization.json> --task <task.json> --repo <project> --name intern-<task>
node <runtime> work --org <returned-org> --task <returned-task> --repo <returned-worktree-path> --state <returned-state> --role intern
```

`prepare`는 Orca child worktree를 만들고 기준 커밋과 조직 설정을 고정한다. `work`는 Agy/Claude/Codex의 제한된 응답을 받아 명시된 파일에만 적용하고, 선택한 검사와 호출 한도를 관리한다. 보고서는 공유 state의 runs 아래에 남는다. 실행 실패 시 편집 내용을 보존한다. 이 하네스는 비대화 명령이며 자체적으로 감독 Dispatch나 `worker_done`을 만들지 않는다. 감독된 Junior가 실행했다면 하네스 결과를 확인한 뒤 자신의 실제 Dispatch에 보고한다.

**일반 감독 작업:** Run과 Task를 만들고 `worker-start --worktree new-child --name <role-task> --agent claude|codex`로 배정한다. 사용자가 선택한 모델만 `--model`로 전달하고 requested/effective를 비교한다. 별도 계정 프로필이나 Agy를 현재 worker-start가 표현하지 못하면 지원 여부를 먼저 확인하고 저수준 가이드에 따라 정확한 명령으로 터미널을 생성한 뒤 `worker-start --terminal <handle>`로 감독 소유권을 연결한다. 계정 이름만 브리프에 적어 계정이 바뀌었다고 판단하지 않는다.

감독 메시지는 현재 injected preamble의 Task/Dispatch 권한을 사용한다. 대기에는 `check --wait`를 쓰며 터미널 화면을 주기적으로 전체 읽어 모델을 깨우지 않는다. timeout은 완료나 재시도 근거가 아니다. 메시지를 처리하고 accepted settlement의 다음 소유권을 정한 뒤 acknowledge한다.

## 보고 취합과 검증 재사용

```text
node <runtime> aggregate --expected task-a,task-b --report <a/report.json> --report <b/report.json>
node <runtime> verify --task <integration-task.json> --repo <integration-worktree> --state <shared-state>
node <runtime> merge-check --evidence <evidence.json> --task <coordinator-integration-task.json> --repo <integration-worktree> --base origin/main
```

취합기는 기대한 작업의 누락·중복·실패를 막고 짧은 표만 만든다. `ready-for-verification`은 머지 승인 상태가 아니다. 각 보고의 실제 소스와 검증 기록을 대조한다. 통합은 **별도 Orca worktree**에서 하고 충돌 파일과 관련 작업 조건만 담당자에게 되돌린다.

검증 캐시는 HEAD·base 커밋·파일 내용·검사 argv·환경 지문에 묶인다. 테스트나 환경이 달라지면 새 검사를 실행한다. 환경 지문에는 도구 버전, lockfile, DB fixture/스키마 버전 등 검사에 영향을 주는 외부 상태를 포함한다. 해시와 로그는 전송 무결성 확인이며 악의적 로컬 작성자를 인증하지는 않는다.

필수 검사 실패·검수 미완료·소진을 통과로 바꾸지 않는다. 저위험 변경은 자동 검사로, 의미 검증이 필요한 변경은 Senior 검토로 처리한다. 모든 변경에 변이 검사를 의무화하지 않는다.

## 머지와 회수

사용자의 머지 권한이 있는 경우에만 실제 PR을 머지한다. 최신 remote base와 PR HEAD를 조회하고, 통합 검증 결과와 일치하는지 확인한다. `gh pr merge --match-head-commit <verified-pr-head>` 등 현재 설치된 도구가 지원하는 HEAD 제한을 사용한다. base 변경이나 경쟁 머지로 검증 전제가 달라지면 새 통합 검사 후 진행한다. 머지 뒤 실제 착지 커밋을 확인한다.

부모 보고에는 작업 ID·검증 키·변경 요약·실패/미해결 사항·원본 경로만 올린다. 전체 로그를 단계마다 다시 붙이지 않는다. accepted settlement 후 Orca worker-release를 사용하고, 워크트리 삭제는 코드와 증거가 보존되고 프로세스 종료가 입증된 경우에만 한다. 강제 종료/자동 clean/reset으로 실패 증거를 버리지 않는다.
