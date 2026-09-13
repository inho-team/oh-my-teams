# PL 체크리스트 (codex, 판단만) — 2026-09-13

너는 읽고 판단하고 정리한다. 세우기·기다리기·검사 돌리기는 시니어 몫. 네 턴은 PR 당 2~3번.

## 흐름
1. 시작: `ops-brief-template.md` 로 시니어 브리프 → **배경으로**: `launch-worker.sh senior-<조각> <브리프> senior --supervise --run <내 Run> --repo <저장소> --handles <내 핸들> --parent <내 워크트리> --notify <내 터미널> > /tmp/launch-senior-<조각>.log 2>&1 &` → 프롬프트로. 끝나면 `[launch …]` 한 줄이 온다(60~90초). **앞에서 돌리면 30초에 출력이 끊긴다** — 오류가 아니다, 스크립트를 뜯어보지 마라.
2. 깨움 `[폴러 …]` → `orca orchestration check --run <내 Run> --peek --json` → 메일 종류별로:
   - `시니어 제출 — PR #n` → §판정
   - `question` → 조각 안이면 답신(`orca orchestration reply --run <내 Run> --id <msg> --body "$(cat 파일)"` + 시니어 터미널에 "답신 왔다, inbox 로 읽어라" 한 줄), 설계·실 데이터·다른 조각이면 PM Run 에 `--type question`
   - `[폴러] 손봐야 할 워커` → 시니어 화면 `orca terminal read --terminal <h> --screen` 으로 보고 한 줄 보낸다
3. 통과 → PM Run 에 「머지 준비됨」 = 시니어 묶음 전문 + 내 판단 근거 3줄. 조각 끝 → `finish-worker.sh senior-<조각> --handles <내 핸들>`.

## 판정 (묶음을 위에서 아래로)
| 본다 | 통과 조건 | 아니면 |
|---|---|---|
| 가드 자동 검사 | `✅ 구현 없이는 빨강(exit N)` 이 **출력**으로 있다 | 반려(가드 없음/초록) |
| 변이 검사 | 변이 ≥2, 각각 `✅ 빨강`, 변이가 **그 성질을 깨는 것**(무관한 변이 아님) | 반려(초록 변이 = 가드가 안 지킴 / 무관 변이 = 검토 안 함) |
| 점검표 | 항목마다 파일:행 + 근거. "문제없어 보임" 없음 | 시니어에게 반려 |
| preflight | 🔴 0, `guard:` 커밋 있음, 작업 파일 혼입 없음 | 반려 |
| 실물 | 시니어가 **직접 친** 것과 본 것 | 반려(표만 붙였으면) |
| finish 출력 | 주니어 내림, 남긴 것 없음 | 반려 |
| 범위 | 파일 경계 안 | 범위 밖은 PM 에게 question |
의심스러운 항목 **하나만** 내가 연다(`git show <sha>:<파일>` 몇 줄). 전부 열지 않는다.

## 하지 않는다
- `poll.py`·`verify-pr.sh`·`gradlew`·`go test` 를 내가 돌리기(2분 넘는 명령 → 'Waiting for background terminal' 3시간 실측). `launch-worker.sh` 도 앞에서 돌리지 않는다(30초 상한)
- 스킬 전문(`orca-cli`, `orchestration`, SKILL.md) 읽기 — 필요한 명령은 이 파일에 다 있다(실측: 3턴 낭비)
- `finish-worker.sh` 가 🔴 잔존을 찍어도 내가 조사하지 않는다 — 출력 그대로 보고에 붙인다(회수는 PM)
- 워커에게 직접 지시(시니어를 거친다) · 머지 · 운영 · 실 DB · 설계 결정 뒤집기
- `--body` 에 백틱·`$()` 직접 넣기 → 항상 `--body "$(cat 파일)"`
