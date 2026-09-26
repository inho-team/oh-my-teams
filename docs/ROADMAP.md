# 로드맵

이 문서는 oh my teams 저장소의 로드맵 정본이다. phase 하나는 kickoff 하나에 대응하고, phase를 맡은 팀이 그 kickoff를 수행한다. 작성 규칙은 [로드맵 작성 규칙](../plugins/oh-my-teams/references/roadmap.md)이 정한다.

## 권한

로드맵 본문은 이사만 고친다. PM은 자기 phase가 가리키는 하위 문서만 고치고 로드맵 본문은 건드리지 않는다.

## phase 목록

phase의 진행 상태는 이 표에만 적는다. 다른 자리에는 상태를 다시 적지 않는다.

| 식별자 | phase | 상태 |
|---|---|---|
| PH-01 | 로드맵 정본 체계 구축 | 진행 중 |
| PH-02 | 어댑터 경유 원칙과 직접 import 현황의 판정 | 미착수 |

## PH-01 — 로드맵 정본 체계 구축

**목표.** 앞을 내다보는 계획을 한곳에 모으고, phase의 진행 상태가 문서마다 다르게 적히지 않도록 로드맵 문서 체계를 만든다.

**수용 기준.**

- 이 문서와 [로드맵 작성 규칙](../plugins/oh-my-teams/references/roadmap.md)이 존재하고, 두 문서의 마크다운 링크가 모두 실제 파일로 해석된다.
- phase의 식별자가 중복 없이 두 자리 번호 형식을 지키고, phase마다 목표·수용 기준·검증 방법·주의사항·가이드·비목표 여섯 항목을 모두 갖춘다.
- 깨진 링크, 형식을 벗어난 식별자, 중복된 식별자, 빠진 항목, 로드맵에 섞여 든 구현을 각각 실패로 판정하는 검사가 있고, 각 경우를 재현하는 음성 테스트가 함께 있다.
- `npm run sync` 뒤 `npm run lint`와 `npm test`가 통과한다.

**검증 방법.** `npm run lint`와 `npm test`로 확인한다. 형식 검사와 그 음성 테스트는 저장소의 테스트 디렉터리 아래 새 테스트 파일에 있다.

**주의사항.**

- [`scripts/metadata.mjs`](../scripts/metadata.mjs)가 [`docs/PLAN_STATUS.md`](PLAN_STATUS.md)·[`docs/SAFETY_AUDIT.md`](SAFETY_AUDIT.md)·[`docs/CODE_QUALITY.md`](CODE_QUALITY.md)의 특정 문장을 정규식으로 찾아 활성 모듈·테스트 개수를 덮어쓰므로, 새 테스트 파일을 추가하면 그 개수가 바뀌어 `npm run sync`를 실행하지 않으면 [`tests/repository-metadata.test.mjs`](../tests/repository-metadata.test.mjs)가 실패한다.
- 로드맵 본문은 이사만 고치므로, 이 phase가 병합된 뒤 상태를 "완료"로 바꾸는 것은 PM이 아니라 이사가 한다.
- Prettier의 포맷 대상은 `.mjs`·`.json`뿐이라 마크다운은 형식 검사를 받지 않으므로, 링크와 phase 형식은 이번에 추가하는 검사로만 걸러진다.

**가이드.**

- [로드맵 작성 규칙](../plugins/oh-my-teams/references/roadmap.md)이 이 phase가 지켜야 하는 형식을 정한다.
- [`no-ghostwriting.md`](../plugins/oh-my-teams/references/no-ghostwriting.md)와 [`autonomy.md`](../plugins/oh-my-teams/references/autonomy.md)가 규칙 문서의 구성 본보기다.
- [`docs/briefs/README.md`](briefs/README.md)가 표로 하위 문서를 가리키는 구조의 선례다.
- [`docs/plan/omt-audit-2026-09.md`](plan/omt-audit-2026-09.md)의 「다음 kickoff 우선순위」 표가 로드맵과 기능적으로 가장 가까운 기존 구조물이다.

**비목표.**

- [`docs/PLAN_STATUS.md`](PLAN_STATUS.md)를 흡수하거나 옮기지 않는다. 로드맵은 링크만 한다.
- docs/plan 디렉터리 아래 문서들의 본문을 고치지 않는다.
- phase별 하위 문서를 담을 새 디렉터리를 만들지 않는다.

## PH-02 — 어댑터 경유 원칙과 직접 import 현황의 판정

**목표.** [1차 감사 보고서](plan/omt-audit-2026-09.md)의 `LAUNCH-02`가 "근거 미확인"으로 남긴 판정, 곧 Orca 실행 어댑터를 직접 import하는 지금의 호출 방식이 어댑터 경유 원칙을 지키는지를 판정하고, 필요하면 규칙 문구나 호출 경로를 정리한다.

**수용 기준.**

- `LAUNCH-02`의 판정(위반 또는 비위반)과 그 근거가 검토 기록이나 후속 문서에 남는다.
- 위반으로 판정되면 고칠 범위가 다음 kickoff의 브리프로 넘겨지고, 비위반으로 판정되면 그 판정이 [`AGENTS.md`](../AGENTS.md)의 아키텍처 규칙이나 관련 문서에 반영된다.

**검증 방법.** 판정 근거와 결정을 이 kickoff의 검토 기록 형식으로 남긴다. 문서나 규칙 문구를 고치면 `npm run lint`와 `npm test`로 확인한다.

**주의사항.**

- 1차 감사 보고서는 [`role-terminal.mjs`](../plugins/oh-my-teams/scripts/role-terminal.mjs) 한 곳만 지적했으나, [`dependencies.mjs`](../plugins/oh-my-teams/scripts/dependencies.mjs)·[`prompt-submission.mjs`](../plugins/oh-my-teams/scripts/prompt-submission.mjs)·[`teams-org.mjs`](../plugins/oh-my-teams/scripts/teams-org.mjs)·[`prompt-supervision.mjs`](../plugins/oh-my-teams/scripts/prompt-supervision.mjs)도 모두 같은 방식으로 Orca 실행 어댑터를 직접 import하고 있어(2026-09-18 기준), 판정 결과가 한 파일에만 그치지 않는다.
- [`AGENTS.md`](../AGENTS.md)의 "어댑터를 거치지 않는 직접 호출 금지" 규칙은 [2차 감사 보고서](plan/omt-audit-2026-09-r2.md)의 `DOCS-02` 수정으로 추가됐을 뿐, `LAUNCH-02`를 이 규칙에 맞춰 다시 판정한 근거는 아직 기록되지 않았다.
- [2차 감사 보고서](plan/omt-audit-2026-09-r2.md)의 「다음 kickoff 우선순위」 반영 현황에는 `LAUNCH-02`가 아예 등장하지 않는다. 같은 우선순위 묶음의 나머지 항목(`DOCS-01`~`DOCS-03`)은 수정됐다고 적혀 있어, `LAUNCH-02`만 처리도 기각도 되지 않은 채 남아 있다.

**가이드.**

- [1차 감사 보고서](plan/omt-audit-2026-09.md)의 `LAUNCH-02` 항목.
- [2차 감사 보고서](plan/omt-audit-2026-09-r2.md)의 「다음 kickoff 우선순위」 반영 현황과 일치 여부 표.
- [`AGENTS.md`](../AGENTS.md)의 아키텍처 규칙.
- [`adapters.mjs`](../plugins/oh-my-teams/scripts/adapters.mjs)와 [`orca-adapter.mjs`](../plugins/oh-my-teams/scripts/orca-adapter.mjs)가 지금의 어댑터 구조다.

**비목표.**

- 이 phase에서 코드를 직접 고치지 않는다. 판정과 다음 kickoff로 넘길 범위를 정하는 것까지만 한다.
- [`adapters.mjs`](../plugins/oh-my-teams/scripts/adapters.mjs)의 포트 구조 자체를 다시 설계하지 않는다.
