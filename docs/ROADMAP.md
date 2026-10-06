# 로드맵

이 문서는 oh my teams 저장소의 로드맵 정본이다. phase 하나는 kickoff 하나에 대응하고, phase를 맡은 팀이 그 kickoff를 수행한다. 작성 규칙은 [로드맵 작성 규칙](../plugins/oh-my-teams/references/roadmap.md)이 정한다.

## 권한

로드맵 본문은 이사만 고친다. PM은 자기 phase가 가리키는 하위 문서만 고치고 로드맵 본문은 건드리지 않는다.

## phase 목록

phase의 진행 상태는 이 표에만 적는다. 다른 자리에는 상태를 다시 적지 않는다.

| 식별자 | phase | 상태 |
|---|---|---|
| PH-01 | 로드맵 정본 체계 구축 | 완료 |
| PH-02 | 어댑터 경유 원칙과 직접 import 현황의 판정 | 미착수 |
| PH-03 | 사용자 요구 원문 대조와 비판적 수용 게이트 | 완료 |
| PH-04 | 이사 세션의 시작·식별·교체 경로 정상화 | 미착수 |
| PH-05 | 명령 계약과 역할 보고 형식의 단일화 | 미착수 |
| PH-06 | 터미널 질문·전달·세션 재개의 결정성 확보 | 미착수 |
| PH-07 | workflow 수정·재개·역할 전환 경로 복구 | 미착수 |
| PH-08 | 증거·CI·전달·종료 판정의 일관성 확보 | 미착수 |
| PH-09 | 편집 경계와 실행 어댑터 강제 | 미착수 |
| PH-10 | macOS·Windows·Agy 경로의 재현성 확보 | 미착수 |
| PH-11 | 실제 Orca 전 과정 회귀 검증과 반복 작업 제거 | 미착수 |

구현 phase는 원칙적으로 하나씩 완료한다. 서로 독립적이라는 근거와 자원 여유가 확인된 경우에만 병렬 kickoff를 허용하며, 같은 구독의 동시 사용과 자원 슬롯 점유를 진행 보고에 함께 남긴다.

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

## PH-03 — 사용자 요구 원문 대조와 비판적 수용 게이트

**목표.** kickoff가 사용자의 원래 요구를 더 좁은 수용 기준으로 바꾼 뒤 완료 처리하는 일을 막고, 구현 결과에 대한 이의가 근거로 해소되기 전에는 수용되지 않도록 한다.

**수용 기준.**

- kickoff의 목표와 최종 수용 기록에서 사용자의 원래 요구가 빠지거나 의미가 좁아지면 완료 처리가 거부된다.
- 검토 역할은 구현 보고를 재서술하는 데 그치지 않고 원래 요구, 수용 기준, 실제 증거 사이의 불일치를 독립적으로 지적할 수 있다.
- 열린 이의는 근거와 논거로 해소되거나 미충족으로 남으며, 단순한 완료 주장이나 일부 검사 통과만으로 닫히지 않는다.
- [이슈 #139](https://github.com/inho-team/oh-my-teams/issues/139)의 재현 사례가 회귀 검사로 보존된다.

**검증 방법.** 사용자의 요구 일부를 의도적으로 누락한 workflow와 근거 없이 이의를 기각하는 검토를 각각 구성하여 완료가 거부되는지 확인하고, 정상 요구와 증거가 모두 연결된 경우에만 완료되는지 확인한다. 저장소의 필수 검사도 함께 통과해야 한다.

**주의사항.**

- 기존 acceptance와 review 기록은 서로 다른 책임을 가지므로 한 기록이 다른 기록을 대신하게 만들지 않는다.
- 사용자의 자연어를 문자열이 같은지로만 비교하면 표현이 달라진 정상 기준을 거부할 수 있으므로, 의미 보존 여부와 추적 근거를 함께 판단해야 한다.
- 이 phase의 구현 범위는 [이슈 #139](https://github.com/inho-team/oh-my-teams/issues/139)에 한정되었으며, 다른 phase의 결함은 별도로 판정한다.

**가이드.**

- [이슈 #139](https://github.com/inho-team/oh-my-teams/issues/139)가 확인된 실패 사례와 기대 동작을 설명한다.
- [`gates.mjs`](../plugins/oh-my-teams/scripts/gates.mjs)와 [`workflow.mjs`](../plugins/oh-my-teams/scripts/workflow.mjs)가 현재 수용 상태를 판정한다.
- [`pm/SKILL.md`](../plugins/oh-my-teams/skills/pm/SKILL.md)의 완료 판단 절과 [`no-ghostwriting.md`](../plugins/oh-my-teams/references/no-ghostwriting.md)가 역할의 수용 책임과 지시 경계를 정한다.

**비목표.**

- 역할 터미널의 시작 방식이나 이사 세션 교체 절차를 이번 phase에서 바꾸지 않는다.
- 보고서 생성 편의와 workflow 수정 명령을 이번 phase에서 함께 추가하지 않는다.

## PH-04 — 이사 세션의 시작·식별·교체 경로 정상화

**목표.** 이사 세션을 공식 경로로 시작하고 Orca에서 확인하며, 세션 교체와 PM 보고 대상 인계까지 등록부에 근거를 남기는 전 과정을 정상화한다.

**수용 기준.**

- 이사 세션을 여는 공식 경로가 존재하고, 역할용 명령의 금지 사항과 충돌하지 않는다.
- 공식 경로로 연 이사 터미널이 Orca 워크트리의 탭과 터미널 목록에서 같은 세션으로 확인된다.
- 이사 세션을 교체하거나 인계해도 등록부를 손으로 수정하지 않고 새 보고 대상이 권한 검사에 반영된다.
- PM과 하위 역할의 지시문에 실제 이사 터미널 식별자가 포함되어 결정 신호의 목적지가 모호하지 않다.

**검증 방법.** 깨끗한 주인 체크아웃에서 이사 세션 시작, kickoff 등록, PM 신호 전달, 이사 세션 교체, 교체 후 재전달을 실제 Orca 터미널로 확인한다. 관련 단위·통합 검사와 저장소 필수 검사도 통과해야 한다.

**주의사항.**

- 이사는 PM이나 worker가 아니므로 기존 역할 목록에 억지로 포함해 실행하면 권한과 회수 경계가 무너진다.
- 터미널 생성 성공과 Orca 탭 노출, agent 실행, 등록부 식별자 기록은 서로 다른 사실이므로 각각 증명해야 한다.
- 주인 체크아웃의 권한과 PM 워크트리의 실행 소유권을 합치지 않는다.

**가이드.**

- [이슈 #141](https://github.com/inho-team/oh-my-teams/issues/141)과 [이슈 #142](https://github.com/inho-team/oh-my-teams/issues/142)가 시작 경로와 탭 노출 실패를 설명한다.
- [이슈 #121](https://github.com/inho-team/oh-my-teams/issues/121)과 [이슈 #131](https://github.com/inho-team/oh-my-teams/issues/131)이 보고 대상 누락과 세션 교체 공백을 설명한다.
- [`director/SKILL.md`](../plugins/oh-my-teams/skills/director/SKILL.md), [`kickoff-registry.md`](../plugins/oh-my-teams/references/kickoff-registry.md), [`orca-runtime.md`](../plugins/oh-my-teams/references/orca-runtime.md)가 현재 책임과 실행 경계를 정한다.

**비목표.**

- PM 이하 역할의 workflow 수정 기능을 이번 phase에서 확장하지 않는다.
- Orca의 탭·터미널 수명주기를 플러그인 내부에서 다시 구현하지 않는다.

## PH-05 — 명령 계약과 역할 보고 형식의 단일화

**목표.** 스킬 문서, 런타임 입력 형식, 검증 결과와 구현 보고서가 같은 계약을 사용하게 하여 역할이 값을 손으로 옮기거나 형식 오류를 반복하지 않도록 한다.

**수용 기준.**

- 스킬이 안내하는 authority, 재검토 설명과 완료 메시지 필드가 런타임이 실제로 받는 형식과 일치한다.
- 검증 결과를 구현 보고서로 전달할 때 계약 식별자와 근거가 자동으로 보존되며 역할이 해시를 손으로 복사하지 않는다.
- 증분 검증이 명령 사이의 상태를 보존하는 경우 그 전제와 초기화 경계가 사용자 문서와 오류 출력에 드러난다.
- 잘못된 예시를 그대로 따른 역할이 같은 형식 오류를 반복하는 음성 시나리오가 회귀 검사에 포함된다.

**검증 방법.** 문서 예시를 실제 CLI 입력으로 실행하고, 검증 결과에서 보고서와 수용 기록까지 이어지는 식별자가 변하지 않는지 확인한다. 상태를 유지하는 연속 검증과 새 상태에서 시작하는 검증도 구분하여 확인한다.

**주의사항.**

- 문서에 런타임 검사 로직을 복제하지 않고 정본 계약을 참조해야 한다.
- 형식 변환이 성공했다는 사실만으로 증거 내용이나 구현 결과의 타당성을 승인하지 않는다.
- 이전 기록을 읽는 호환 경로와 새 기록을 쓰는 정본 형식을 구분한다.

**가이드.**

- [이슈 #127](https://github.com/inho-team/oh-my-teams/issues/127), [이슈 #137](https://github.com/inho-team/oh-my-teams/issues/137), [이슈 #124](https://github.com/inho-team/oh-my-teams/issues/124)가 현재 반복되는 형식 오류와 수동 전달 문제를 설명한다.
- [`contracts.mjs`](../plugins/oh-my-teams/scripts/contracts.mjs), [`evidence.mjs`](../plugins/oh-my-teams/scripts/evidence.mjs), [`gates.mjs`](../plugins/oh-my-teams/scripts/gates.mjs)가 현재 계약과 검증 기록을 다룬다.

**비목표.**

- 역할별 보고 문체를 획일적인 고정 문장으로 만들지 않는다.
- 검증 결과의 의미 판단을 단순한 형식 변환으로 대신하지 않는다.

## PH-06 — 터미널 질문·전달·세션 재개의 결정성 확보

**목표.** 새 워크트리와 세션에서 반복되는 신뢰 질문, 입력 제출의 모호함과 대기 판정 실패를 줄이고, 같은 사건을 다시 보내거나 사용자의 개입을 반복해서 요구하지 않도록 한다.

**수용 기준.**

- 동일한 저장소 계보에서 새 워크트리가 생길 때마다 불필요하게 신뢰 질문으로 막히는 경로가 제거되거나, 자동 처리할 수 없는 이유가 한 번의 구조화된 차단으로 보고된다.
- 터미널이 종료되었거나 작업 중이거나 질문에 멈춘 상태를 idle과 구분하고, 잘못된 상태에서 worker 시작이나 입력 재전송을 시도하지 않는다.
- 제출 대기열에 들어간 입력, 실제 전달 실패와 제출 여부 미확인을 서로 다른 결과로 보고한다.
- 역할이 사용자 선택 창을 직접 띄워 상위가 답할 수 없는 상태로 멈추지 않으며, 같은 질문에는 한 번만 답하거나 에스컬레이션한다.

**검증 방법.** Codex 신뢰 질문, Agy 대기 판정, 종료된 터미널, 제출 대기열과 역할의 사용자 질문을 각각 재현하여 입력 횟수, 상태 판정과 다음 행동이 결정적인지 확인한다.

**주의사항.**

- 플러그인은 사용자 설정 파일에 직접 신뢰 항목을 쓰지 않는다.
- 입력 수락, 제출 시작과 agent 처리 완료는 서로 다른 사건이므로 한 상태로 합치지 않는다.
- 판정할 수 없는 터미널을 idle이나 종료로 추정하지 않는다.

**가이드.**

- [이슈 #103](https://github.com/inho-team/oh-my-teams/issues/103), [이슈 #102](https://github.com/inho-team/oh-my-teams/issues/102), [이슈 #110](https://github.com/inho-team/oh-my-teams/issues/110)이 신뢰와 idle 판정 문제를 설명한다.
- [이슈 #117](https://github.com/inho-team/oh-my-teams/issues/117), [이슈 #126](https://github.com/inho-team/oh-my-teams/issues/126), [이슈 #135](https://github.com/inho-team/oh-my-teams/issues/135)가 주입 예외, 선택 창과 제출 상태 문제를 설명한다.
- [`prompt-answers.mjs`](../plugins/oh-my-teams/scripts/prompt-answers.mjs), [`prompt-submission.mjs`](../plugins/oh-my-teams/scripts/prompt-submission.mjs), [`prompt-supervision.mjs`](../plugins/oh-my-teams/scripts/prompt-supervision.mjs)가 현재 판정 경로다.

**비목표.**

- Orca의 터미널 폴링이나 프로세스 회수 기능을 플러그인 안에 복제하지 않는다.
- 판정할 수 없는 질문에 임의의 키를 보내지 않는다.

## PH-07 — workflow 수정·재개·역할 전환 경로 복구

**목표.** workflow를 처음부터 다시 만들지 않고도 빠진 범위, 잘못 굳은 결과, 부족한 호출 예산, 수용 뒤 발견된 결함과 역할 전환을 근거와 함께 수정할 수 있게 한다.

**수용 기준.**

- task의 파일 범위와 지시 계약이 어긋나면 전체 workflow 재생성 없이 안전하게 바로잡거나 명확한 거부 근거를 얻는다.
- 잘못 굳은 dependency 결과와 이미 수용된 workflow에서 새로 확인된 결함을 감사 이력을 보존하며 다시 열 수 있다.
- 승인된 호출 예산 변경이 전체 예산과 시도 예산에 일관되게 반영된다.
- 재작업 담당 역할이 바뀌어도 기존 작업을 보존하며 동시 실행 한도와 워크트리 소유권이 실제 담당 역할에 맞게 판정된다.

**검증 방법.** 파일 범위 누락, dependency 결과 정정, 예산 소진 뒤 승인된 증액, 수용 뒤 재개와 Junior에서 Senior로의 재작업을 각각 구성하여 새 workflow 없이 복구되는지 확인한다.

**주의사항.**

- 이미 실행된 작업의 역사와 수용 증거를 덮어쓰지 않고 새 사건으로 남겨야 한다.
- 역할 전환은 다른 역할의 미확인 변경을 가져가거나 같은 워크트리에 부산물을 섞는 근거가 아니다.
- 예산 증액은 사용자가 확정한 비용 경계를 조용히 넓히지 않는다.

**가이드.**

- [이슈 #108](https://github.com/inho-team/oh-my-teams/issues/108), [이슈 #118](https://github.com/inho-team/oh-my-teams/issues/118), [이슈 #120](https://github.com/inho-team/oh-my-teams/issues/120)이 역할 전환, 예산과 굳은 결과 문제를 설명한다.
- [이슈 #123](https://github.com/inho-team/oh-my-teams/issues/123), [이슈 #125](https://github.com/inho-team/oh-my-teams/issues/125), [이슈 #132](https://github.com/inho-team/oh-my-teams/issues/132)가 범위 수정, 슬롯 판정과 수용 뒤 재개 공백을 설명한다.
- [`workflow.mjs`](../plugins/oh-my-teams/scripts/workflow.mjs)와 [`workflow-store.mjs`](../plugins/oh-my-teams/scripts/workflow-store.mjs)가 현재 상태 전이와 기록을 다룬다.

**비목표.**

- 실패한 workflow의 기록을 삭제하거나 과거 수용을 없었던 일로 만들지 않는다.
- 승인 없이 모델, 계정이나 전체 호출 예산을 바꾸지 않는다.

## PH-08 — 증거·CI·전달·종료 판정의 일관성 확보

**목표.** 검증한 소스, task 계약, CI 결과, 전달 브랜치와 정리 대상이 같은 revision을 가리키게 하여 검증되지 않은 결과가 병합되거나 정상 브랜치가 남는 일을 막는다.

**수용 기준.**

- CI가 실행되지 않은 상태와 실행되어 통과한 상태를 구분하고, 전자에서는 종료가 거부된다.
- gate 명령이 workflow가 고정한 task 계약과 다른 입력을 받으면 기록 전에 거부된다.
- 기준 브랜치가 다른 workflow도 실제 전달 대상과 검증 근거를 대조하여 정상적으로 병합하거나 구체적인 불일치를 보고한다.
- kickoff 도중 기준 브랜치를 합친 뒤에는 최신 HEAD의 증거를 다시 확인하며, rebase로 전달된 브랜치도 안전성이 증명되면 정리 대상에서 빠지지 않는다.

**검증 방법.** CI run 부재, 오래된 task 계약, 다른 기준 브랜치, 기준 브랜치 병합 뒤 오래된 증거와 rebase 전달을 각각 재현하여 종료·전달·정리 판정이 기대대로 갈리는지 확인한다.

**주의사항.**

- 커밋 도달 가능성 하나만으로 CI 실행, 계약 일치와 검증 시점을 대신 증명하지 않는다.
- 전달과 브랜치 삭제는 복구 가능성이 다르므로 각각 별도의 긍정 근거가 필요하다.
- 최신 소스에 대한 증거가 없으면 이전 성공 기록을 재사용하지 않는다.

**가이드.**

- [이슈 #111](https://github.com/inho-team/oh-my-teams/issues/111), [이슈 #113](https://github.com/inho-team/oh-my-teams/issues/113), [이슈 #116](https://github.com/inho-team/oh-my-teams/issues/116)이 CI·최신 증거·task 계약 문제를 설명한다.
- [이슈 #119](https://github.com/inho-team/oh-my-teams/issues/119)와 [이슈 #134](https://github.com/inho-team/oh-my-teams/issues/134)가 전달 기준과 브랜치 정리 문제를 설명한다.
- [`delivery.mjs`](../plugins/oh-my-teams/scripts/delivery.mjs), [`evidence.mjs`](../plugins/oh-my-teams/scripts/evidence.mjs), [`kickoff-registry.mjs`](../plugins/oh-my-teams/scripts/kickoff-registry.mjs)가 현재 종료 경계를 다룬다.

**비목표.**

- 검증되지 않은 HEAD를 강제 옵션으로 정상 완료 처리하지 않는다.
- 실패하거나 취소한 kickoff의 복구용 브랜치를 성공 종료와 같은 기준으로 삭제하지 않는다.

## PH-09 — 편집 경계와 실행 어댑터 강제

**목표.** 역할이 선언한 편집 범위와 런타임 환경 접근 경계를 실제 실행에서 강제하고, 문서상의 금지가 우회 가능한 권고에 머물지 않도록 한다.

**수용 기준.**

- 감독 worker가 선언하지 않은 파일을 수정하면 수용 전에 검출되며, 그 파일은 동시 배정 충돌 판정에서도 빠지지 않는다.
- PH-02의 판정 결과가 실제 실행 경계에 반영되고, 플랫폼별 실행과 파일 시스템 접근이 정한 어댑터 밖에서 새로 발생하지 않는다.
- 범위를 넓혀야 하는 정상 재작업에는 감사 가능한 변경 절차가 있으며, 조용한 우회는 허용되지 않는다.
- 경계 위반과 정상 범위 확장을 구분하는 회귀 검사가 존재한다.

**검증 방법.** 선언 밖 파일 편집, 서로 겹치는 미선언 편집과 어댑터 우회 접근을 각각 구성하여 실행 또는 수용이 거부되는지 확인하고, 승인된 범위 확장은 기록을 남기며 통과하는지 확인한다.

**주의사항.**

- Git diff만으로 실행 중인 동시 편집 충돌을 모두 설명할 수 없으므로 task 계약과 실제 변경을 함께 대조해야 한다.
- 어댑터를 새 이름으로 감싸는 것만으로 경유 원칙을 충족했다고 판정하지 않는다.
- 헤드리스 실행 경로의 명시된 예외를 일반 실행의 우회 근거로 확대하지 않는다.

**가이드.**

- [이슈 #114](https://github.com/inho-team/oh-my-teams/issues/114)가 편집 범위 미강제와 충돌 판정 누락을 설명한다.
- [`core.mjs`](../plugins/oh-my-teams/scripts/core.mjs), [`execution.mjs`](../plugins/oh-my-teams/scripts/execution.mjs), [`adapters.mjs`](../plugins/oh-my-teams/scripts/adapters.mjs)가 현재 경계와 실행 포트를 다룬다.
- PH-02가 어댑터 직접 import의 선행 판정 범위를 정한다.

**비목표.**

- Orca의 실행 소유권과 프로세스 회수 기능을 플러그인에서 다시 만들지 않는다.
- 모든 역할에 저장소 전체 편집 권한을 주어 충돌 검사를 무력화하지 않는다.

## PH-10 — macOS·Windows·Agy 경로의 재현성 확보

**목표.** 한 플랫폼에서만 통과하는 경로와 간헐적으로 실패하는 검사를 제거하고, 지원하는 실행기와 운영체제에서 같은 계약이 재현되도록 한다.

**수용 기준.**

- Windows의 Agy 시작과 OpenCodex 프로세스 종료가 같은 입력에서 일관된 결과를 내며, 지원하지 않는 조합은 실행 전에 구체적인 이유로 거부된다.
- 경로 구분자와 프로세스 종료 방식에 대한 운영체제 가정이 테스트에서 검출된다.
- macOS의 delivery 임시 디렉터리 검사가 반복 실행에서도 간헐적인 파일 부재로 실패하지 않는다.
- 가짜 Orca의 판정은 워크트리 경로 문자열에 우연히 포함된 인자 때문에 달라지지 않는다.

**검증 방법.** macOS와 Windows CI에서 관련 검사를 반복 실행하고, 지원 가능한 Agy 경로는 실제 worker 완료까지 확인한다. 동일 커밋에서 결과가 갈렸던 시나리오는 반복 결과와 실행 환경을 함께 보존한다.

**주의사항.**

- macOS 통과를 Windows 지원의 근거로 사용하지 않으며, 반대도 마찬가지다.
- 플랫폼 실측 없이 호환성 표의 근거 등급을 올리지 않는다.
- 테스트 재시도만으로 간헐 실패를 숨기지 않는다.

**가이드.**

- [이슈 #46](https://github.com/inho-team/oh-my-teams/issues/46), [이슈 #106](https://github.com/inho-team/oh-my-teams/issues/106), [이슈 #133](https://github.com/inho-team/oh-my-teams/issues/133)이 Windows 실행과 경로 문제를 설명한다.
- [이슈 #115](https://github.com/inho-team/oh-my-teams/issues/115)와 [이슈 #136](https://github.com/inho-team/oh-my-teams/issues/136)이 테스트 판정과 macOS 간헐 실패를 설명한다.
- [`launch-matrix.mjs`](../plugins/oh-my-teams/scripts/launch-matrix.mjs)와 [`cleanup-and-portability.test.mjs`](../tests/cleanup-and-portability.test.mjs)가 현재 플랫폼 경계를 다룬다.

**비목표.**

- 실측하지 않은 운영체제와 실행기 조합을 지원한다고 선언하지 않는다.
- 간헐 실패를 단순 재시도 횟수 증가로 덮지 않는다.

## PH-11 — 실제 Orca 전 과정 회귀 검증과 반복 작업 제거

**목표.** 수정된 개별 기능을 실제 Orca의 이사 시작부터 PM 인계, worker 실행, 보고, 종료와 다음 세션 재개까지 연결하여 검증하고, 세션마다 사람이 되풀이하는 준비와 복구 절차를 제거한다.

**수용 기준.**

- 깨끗한 세션에서 공식 명령만 사용하여 이사 시작, kickoff 등록, PM 인계, worker 실행, 수용, 전달과 정리까지 완료된다.
- 새 세션이 등록부와 보존된 상태를 읽어 진행 위치를 복구하며, 이미 끝난 준비나 전달을 중복 실행하지 않는다.
- 무거운 worker·테스트·빌드가 시작되기 전에 자원 슬롯이 실제로 점유되고 종료 뒤 해제되며, live 작업과 슬롯 현황이 서로 모순되지 않는다.
- 이사가 직접 관리하는 정본 작업처럼 kickoff 등록부 밖에서 수행하는 작업도 무거운 검사 전에 안전하게 자원 슬롯을 확보하거나, 검사가 필요한 범위를 별도 kickoff로 넘길 수 있다.
- 사용자가 개입해야 하는 사건은 사용자가 소유한 결정으로 한정되고, 플러그인이 판단할 수 있는 질문과 복구는 상위 역할이 한 번만 처리한다.
- 진행 보고에는 Goal 상태, 실제 worker liveness, 마지막 확인 변경, 다음 사건이 구분되어 나타난다.

**검증 방법.** 실제 Orca에서 대표 kickoff를 새 세션과 재개 세션으로 연속 실행하고, 각 단계의 등록부·Run·worker·자원 슬롯·신호와 Git 상태를 대조한다. 중간에 터미널 종료, 질문 화면과 전달 미확인을 주입하여 중복 작업 없이 복구되는지도 확인한다.

**주의사항.**

- 결정적 fixture 통과만으로 실제 Orca 전 과정이 검증되었다고 선언하지 않는다.
- 실측을 위해 임시로 만든 스크립트와 기록은 워크트리 안에 남기지 않는다.
- 전 과정 검증 중 발견한 새 결함은 이번 phase에 무제한으로 끼워 넣지 않고 재현 근거와 영향에 따라 별도 phase나 이슈로 분리한다.

**가이드.**

- [`WORKFLOW_EXECUTION.md`](WORKFLOW_EXECUTION.md)가 현재 사용자 실행 흐름을 설명한다.
- [`orca-runtime.md`](../plugins/oh-my-teams/references/orca-runtime.md), [`kickoff-registry.md`](../plugins/oh-my-teams/references/kickoff-registry.md), [`status.mjs`](../plugins/oh-my-teams/scripts/status.mjs), [`resources.mjs`](../plugins/oh-my-teams/scripts/resources.mjs)가 전 과정에서 대조할 정본과 상태를 제공한다.
- [`docs/plan`](plan)의 기존 실측 기록은 환경과 기준 커밋이 일치하는 범위에서만 재사용한다.

**비목표.**

- Orca가 이미 제공하는 polling, lifecycle과 프로세스 회수를 플러그인 안에서 재구현하지 않는다.
- 실제 실행 근거 없이 로드맵의 전체 안정화를 완료로 바꾸지 않는다.
