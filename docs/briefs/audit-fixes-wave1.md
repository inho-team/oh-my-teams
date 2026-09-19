# kickoff 브리프: 전수 조사 보고서의 우선순위 1~6 수정

> 기준 커밋: `main`의 `8d19baf`(2026-09-19). 근거 문서는 `docs/plan/omt-audit-2026-09.md`다. 대기 중인 `director-role`과 `supervised-prompt-answers` 브리프는 이 수정 뒤에 시작한다.

> 이관 메모(2026-09-20): 이 PC에서 등록·계획까지 진행하고 구현 전에 중단했다. 커밋은 없다. 다른 PC에서는 이 브리프로 kickoff를 새로 시작한다.

## 목표

전수 조사 보고서가 우선순위 1~6으로 정리한 결함을 고친다. 메모리 압박이 큰 폴링·파일 읽기 경로를 먼저 고치고, Windows 프로세스 트리 종료 문제를 함께 처리하며, `close` 절차의 브랜치 정리 공백을 메운다. 보고서의 나머지 항목(우선순위 7~11)과 미확인 의심 18건은 이번 범위가 아니다.

## 수용 기준

보고서의 항목 번호를 그대로 쓴다. 각 수정은 결함을 재현하거나 개선을 확인하는 검사를 함께 남긴다.

1. **F-01·F-02 (memory/high, `headless.mjs`)**: `codexRolloutModel`이 폴링마다 Codex sessions 트리를 전체 재귀 탐색하지 않고, `headlessStatus`·`headlessDetail`이 `stream.jsonl` 전체를 반복해 읽지 않는다. 캐시나 꼬리 읽기 가운데 무엇을 쓰든, 같은 worker를 반복 조회할 때 읽는 바이트 수가 파일 크기에 비례해 늘지 않아야 한다. 파싱 경로를 함께 바꾸므로 한 묶음으로 처리한다.
2. **F-03·F-06 (memory/high, `usage-sources.mjs`)**: `eachJsonLine`이 파일 전체를 메모리에 올리지 않고 줄 단위로 처리한다. 모듈 주석과 구현이 일치한다. 큰 입력에서 RSS 증가가 파일 크기에 비례하지 않는 것을 측정으로 확인한다(보고서는 50MB 입력에서 84MB 증가를 측정했다).
3. **STATE-02 (memory/medium, `core.mjs`)**: `run()`의 overflow 경로에도 fallback 타이머가 있어, 자식 프로세스가 `close`를 보내지 않아도 `timeoutMs`(기본 300초)까지 붙잡지 않는다.
4. **F-05·CHECKS-INT-01 (memory·checks/medium)**: `headless-runner.mjs`가 Windows에서 손자 프로세스까지 정리한다. 같은 원인으로 병렬 `npm test`에서 `t.after`의 `rmSync`가 EPERM으로 실패하던 문제도 함께 다룬다. 이 PC에서 **병렬 `npm test`가 통과하는 것**을 확인하고 결과를 기록한다. 통과시키지 못하면 남은 원인과 증거를 보고서 또는 PR 설명에 적고, 직렬 실행 결과로 대체한다.
5. **STATE-01 (memory/medium)**: 이벤트 ID 조회가 선형 탐색이 아니라 집합 조회가 된다.
6. **CLOSE-01 (architecture/medium)**: `close` 절차에 브랜치 정리 단계가 있다. 전달이 끝난 뒤 원격·로컬 브랜치와 회수한 하위 워크트리의 브랜치를 지우되, 다음을 지킨다.
   - 지우기 전에 그 내용이 전달 대상(병합된 PR 또는 주인 브랜치)에 실제로 들어갔는지 확인한다. 확인되지 않으면 지우지 않고 보고한다.
   - `disband`는 실패 결과를 보존해야 하므로 지우지 않는다.
   - 사람이 매번 판단하지 않도록 런타임 명령이 이 확인과 삭제를 수행하고, 스킬 문서는 그 명령을 가리킨다. 명령 이름과 인자는 기존 런타임 관례를 따른다.
7. **회귀 검사**: 위 각 항목에 대해 고치기 전에는 실패하고 고친 뒤에는 통과하는 결정적 테스트가 있다. 측정이 필요한 항목(1·2·4)은 측정 방법과 수치를 PR 설명이나 보고서 부록에 남긴다.
8. **보고서 갱신**: `docs/plan/omt-audit-2026-09.md`의 해당 항목에 수정 완료 사실과 커밋을 적는다. 우선순위 목록에서 처리한 묶음을 표시한다.
9. `npm run sync`, `npm run lint`, `npm test`가 통과하고 PR의 GitHub Actions `CI`가 통과한다.

## 비목표

- 보고서의 우선순위 7~11(F-04, DOCS 계열, 테스트 추가, 경미한 정리, legacy 호환)은 이번 범위가 아니다.
- 미확인 의심 18건의 추가 조사는 하지 않는다. 다만 수정 과정에서 자연히 확인되면 보고서에 결과만 적는다.
- 성능 최적화를 이유로 공개 인터페이스를 바꾸지 않는다. 바꿔야 하면 이사에게 결정을 요청한다.
- 버전 올리기와 릴리스는 이번 범위가 아니다. 병합 뒤 이사가 따로 처리한다.
- 대기 중인 `director-role`·`supervised-prompt-answers` 브리프의 내용을 바꾸지 않는다. 다만 6번 항목이 `close`를 건드리므로, 이사 역할 kickoff가 나중에 같은 파일을 고칠 때 충돌할 수 있다는 점을 PR 설명에 적는다.

## 제약

- 저장소 규칙은 `AGENTS.md`를 따르고 `references/minimal-change.md`의 규율을 지킨다. 요청하지 않은 리팩터링과 범위 밖 정리를 하지 않는다.
- **Agy 할당량 주의**: Senior·Junior 프로필이 모두 Agy다. 앞선 kickoff에서 소진되어 2026-09-19 오전에 초기화될 예정이다. 소진되면 새 시도를 만들지 말고 이사에게 알린다.
- 이 PC의 여유 메모리가 넉넉하지 않다. 무거운 작업은 이사가 준 차례 안에서 하나씩 돌리고, 여유 메모리가 400MB 미만이면 멈추고 알린다. 대기는 짧게 끊어 호출한다.
- 묶음마다 PR을 따로 내지 않고 이 kickoff 전체를 하나의 통합 브랜치로 전달한다. 브랜치는 `fix/audit-wave1`을 쓴다.

## 전달 방식

- `delivery`: `pull-request`, base 브랜치 `main`. 사용자는 kickoff가 완료되는 대로 이사가 `main`에 병합하도록 승인했다(2026-09-17).

## 근거 위치

- 보고서: `docs/plan/omt-audit-2026-09.md`. 항목별 `파일:줄`, 증상, 근거, 제안 수정, 회귀 검사 방법이 적혀 있다. 우선순위 표는 「다음 kickoff 우선순위」 절에 있다.
- 대상 파일: `plugins/oh-my-teams/scripts/headless.mjs`(213-238, 613-616, 688-691, 768-784), `scripts/usage-sources.mjs`(186-206), `scripts/core.mjs`(537-557), `scripts/headless-runner.mjs`(53-58), `scripts/headless.mjs`(532-538), `scripts/workflow.mjs`(STATE-01), `skills/close/SKILL.md`(42-44).
- 특이 사항: 보고서는 F-05·CHECKS-INT-01·STATE-02가 Windows 프로세스 트리 종료 미보장이라는 같은 원인을 공유한다고 적었다. 함께 고치는 것을 권고한다.
- 사용자 요청 원문: "수정 kickoff 시작해."
