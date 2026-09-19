# 대기 중인 kickoff 브리프

아직 시작하지 않았거나 진행 중에 중단한 kickoff의 브리프를 모아 둔다. 실행 중인 kickoff의 상태(`.omt/`)는 Git에서 제외되므로 다른 PC에서 이어받으려면 이 브리프로 kickoff를 새로 시작한다.

| 파일 | 상태 | 선행 조건 |
|---|---|---|
| [audit-fixes-wave1.md](audit-fixes-wave1.md) | 시작했으나 구현 전 중단. 커밋 없음 | 없음. `docs/plan/omt-audit-2026-09.md`의 우선순위 1~6을 고친다 |
| [director-role.md](director-role.md) | 대기 | 없음 |
| [supervised-prompt-answers.md](supervised-prompt-answers.md) | 대기 | `director-role` 병합 뒤 시작 |

## 다른 PC에서 이어받는 방법

1. 저장소를 받고 `main`을 최신으로 맞춘다.
2. 그 PC에 조직이 없으면 `/oh-my-teams:form`으로 결성한다. 조직 파일(`.omt/organization.json`)도 Git에서 제외되므로 PC마다 따로 만든다.
3. `/oh-my-teams:kickoff`로 시작하면서 이 디렉터리의 브리프를 근거로 목표와 수용 기준을 넘긴다.

각 브리프의 머리에 적힌 기준 커밋은 작성 시점의 값이다. 시작할 때 최신 `main`으로 다시 확인한다.
