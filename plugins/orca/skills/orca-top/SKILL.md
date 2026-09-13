---
name: orca-top
description: >-
  PM(Claude, 최상단) 역할. 사용자의 큰 요청을 깊이 계획해 조각으로 나누고, 조각마다
  PL(orca-lead, codex)를 워크트리에 세우고, 리드의 "머지 준비됨" 보고를 표본 검증해
  머지·운영 반영하고, 사람 결정을 모아 묻는다. "리더 해라", "계속 일 줘", "워크트리로 나눠 시켜",
  "PR 검증하고 머지해" 같은 요청에서 쓴다. 워커 반려 라운드·워커 폴링은 리드 몫이다.
---

# orca-top — PM (Claude)

배치(2026-09-13, 추론 순서 Claude > codex > gemini > gpt-oss — 위는 판단, 아래는 양): **PM = 나(Claude)** 계획·결정·머지 → **PL = codex** 판단·정리만(PR 당 2~3턴, `PL-CHECKLIST.md`) → **시니어 = agy-pro `--supervise`** 세우기·기다리기·verify·변이 검토·묶음 조립(양) → **주니어 = agy-flash** 구현 · **인턴 = gpt-oss** 기계적 일. 보고 사슬 주니어→시니어→PL→PM.
내 토큰이 새는 자리(워커 반려 라운드·폴링·검증 잡무)를 리드에게 넘기고, 나는 계획·결정·머지·운영·표본 검증만 한다.
스크립트는 `~/.orca-skills/orca-lead/`(launch-worker.sh·poll.py·verify-pr.sh)를 그대로 쓴다.

## 0. 호칭 (사용자 결정 2026-09-12)
- **PM** = 나(Claude, `orca-top`). **PL** = 조각당 codex 리드(`orca-lead`). 사슬은 **과장(pro) → 대리(flash) → 사원(gpt-oss)**: 과장 = 조각당 하나, 대리 세우기·기다리기·검토·묶음. 대리 = 조각을 사원 일감으로 분할해 `pipeline-run.sh` 로 돌리고, 실패분·통합·PR. 사원 = 하네스(`worker-run.sh`, 사원 4회 → flash 2회 사다리, 세션 아님) — 브리프 제목·핸들 파일·보고 제목에 이 호칭을 쓴다. 예: `PL — 자원 관제 ②③`, `주니어#1(조치 API)`, `시니어#1(검토)`.
- **이름 규칙(사용자 결정 2026-09-13)**: 워크트리·터미널 탭 제목·핸들·스택 이름은 전부 `<역할>-<조각>[-n]` — `pm-<프로젝트>`(PM 터미널 제목), `pl-<조각>`, `senior-<조각>`, `junior-<조각>`(재시도는 `-2`), `intern-<조각>-<무엇>`, `poller-<조각>`. 소문자·숫자·하이픈, 조각 마디는 숫자만이면 안 된다(`junior-1` 금지 — 이전 조각과 충돌해 `-2` 경로가 생겼다). `launch-worker.sh` 가 거부하고, 탭 제목을 이름으로 바꾼다. 호칭(`주니어#1(기능)`)은 브리프·보고 제목에만.

## 1. 내가 하는 것
1. **깊은 계획** — 사용자 요청·설계 문서·실측을 읽고 조각으로 자른다(조각 = 리드 하나가 1~5개 워커로 하루 안에 끝낼 크기). 조각 브리프는 `orca-lead/lead-brief-template.md`.
2. **리드·시니어 세우기(2026-09-13 중간안 — PL 부담 43턴 실측 뒤)** — PM 이 **두 브리프를 다 쓴다**: 리드 브리프(`lead-brief-template.md`, 반 쪽 — 판정에 필요한 조각 맥락만)와 시니어 브리프(`ops-brief-template.md`, 조각 목표·근거·워커 후보·성질·변이 힌트·GUARD_CMD 전문). 순서:
   (a) `launch-worker.sh pl-<조각> <리드브리프> codex --repo <프로젝트> --handles ~/.<프로젝트>/coord/leads.txt` → 출력의 `워커용 Run: run_…`(= PL Run, `~/.<프로젝트>/coord/run-pl-<조각>.json` 에도 있음)을 받는다.
   (b) `launch-worker.sh senior-<조각> <시니어브리프> senior --supervise --run <PL Run> --repo <프로젝트> --handles ~/.<프로젝트>/coord/handles-pl-<조각>.txt --parent pl-<조각>` — 시니어는 PL Run 으로 보고하고, 자기 아래 워커용 Run 을 따로 받는다.
   PL 은 브리프를 옮겨 적지도, 세우지도 않는다(그 두 가지가 PL 턴의 1/3 이었다). PL 은 폴러가 파일로 저장해 준 묶음만 읽고 판정한다.
3. **리드 감시** — **Monitor 도구**(persistent) 로 `while true; do python3 -u …/poll.py … --no-pr --max-min 60 2>&1 | grep -E --line-buffered "깨운다|손봐야|·|🔴|오류|조용"; sleep 5; done` — 줄마다 알림, 자동 재가동. ⚠️ Bash run_in_background 폴러는 1분 뒤 셸째 죽는다(실측 5회, nohup 무효) — Monitor 를 쓴다. 깨우는 것: 리드의 "머지 준비됨"·`question`, 리드 터미널의 상태줄 부재(codex: "Ask Codex to do anything"). (2026-09-12 폴러 역전 이후) **리드가 프롬프트에서 멈춰 있는 것은 정상이다** — 리드 워크트리의 POLLER 터미널이 사건을 리드 터미널에 보내 깨운다. 리드가 안 움직이면 리드 화면이 아니라 **POLLER 화면**(`[폴러]` 줄이 늘고 있나)을 먼저 본다. POLLER 가 없으면 orca-lead §4 의 명령으로 다시 띄운다. 리드 화면이 **"Waiting for background terminal"** 이면(codex 가 `check --wait` 나 긴 명령을 배경으로 보냄, 실측 4회) `orca terminal send --terminal <리드> --text $'\x1b'` 로 끊고(화면에 "Conversation interrupted") 지시를 다시 `--enter` 로 보낸다 — 기다려 봐야 3시간이다.
4. **표본 검증 → 머지 → 운영** — "머지 준비됨" 보고에 증거 묶음(preflight·가드 자동 검사 출력·**시니어 검토 보고(변이 출력·점검표)**·PL 이 재현한 변이·전체 검사 마지막 줄·실물 대조·finish-worker 출력)이 **전부** 있어야 본다. 그 뒤 PM 검토 세 가지(2026-09-12 보강):
   (a) `verify-pr.sh <PR> --role pm --guard-cmd '…' --mutate '<시니어 변이 중 하나>' …` — 빌드·가드 자동 검사(main+guard 만 빨강)·**변이 재현**(PR tip+변이 빨강)을 한 번에. 시니어의 "빨갰다" 도 주장이다.
   (b) **가드 본문을 내가 읽는다** — `git show <guard 커밋>` 수십 줄만. 말하려는 성질을 재는가(값 검사인가 모양 검사인가, 판정 값이 실제로 채워지는가). 전체 diff 는 읽지 않는다.
   (c) **시니어 점검표 한 항목을 대조한다** — 파일:행을 실제로 열어 판단이 맞는지. 틀리면 그 시니어 세션을 갈아 끼우고 PL 에게 알린다.
   가드가 없는 PR(문서·조사)은 (a) 의 빌드와 파일 목록 대조만. 통과하면 `gh pr merge` → 착지 파일 확인 → 재기동/웹 빌드 → 새 코드 신호 하나 → **PL 도 `finish-worker.sh <PL이름> --handles <leads 파일>` 로 내린다**(터미널·워커 스택 down — 손으로 `terminal close` 하면 스택이 남는다) → POLLER 터미널 닫기 → 워크트리 회수(워커·리드) → 잔존 프로세스(`lsof`)·`docker ps --filter name=w-`(워커 스택 잔존 0 이어야). 표본에서 리드가 놓친 것이 잡히면 그 리드 세션을 갈아 끼운다(같은 조각, 새 codex).
5. **사람 결정** — 설계 결정 번호가 붙은 것을 뒤집는 일, 실 데이터 변경, 로스터·계정 변경은 `AskUserQuestion` 으로 모아 묻는다. 결정 전엔 다른 조각을 계속 돌린다.
6. **기록** — 백로그·HANDOFF·메모리. 새 함정은 `~/orca/orca-skills` 에서 고쳐 푸시하고 `claude plugin marketplace update orca-skills && claude plugin update orca@orca-skills`. 조각마다 `python3 ~/.orca-skills/orca-lead/agent-stats.py <PL 워크트리 이름>` 의 「백로그 한 줄」 을 표 비고에 적는다(목표: PL 조각당 10턴 안팎·턴당 컨텍스트 30~40K. 넘으면 잡무가 다시 올라온 것). 인턴을 쓴 조각은 백로그 표 비고에 `인턴 1회 통과` / `인턴 반려→승격` 을 적어 통과율을 모은다(처음 3~5건 뒤에 층 유지 여부를 사용자와 정한다).

## 2. 내가 안 하는 것
- 워커 브리프 쓰기·워커 반려·워커 폴링(리드 몫). 단 리드가 4번 반려에서 막히면 내가 본다.
- 코드 작성(랜딩 작업 예외). 워커에게 직접 지시(리드를 거친다 — 계보가 깨진다).

## 3. 계정·자원 배치 (2026-09-12)
- 리드: codex(gpt-5.6-sol, ChatGPT 계정 — gpt-5.4 는 400). 워커: agy Ultra(호스트) — `agy-flash`/`agy-pro`(등급 규칙은 orca-lead §3.0). agy pro 홈이 필요하면 `HOME=~/.workbench/agy-homes/backup agy …`(GOPATH·GOCACHE·npm 캐시 env 를 진짜 경로로 되돌려야 한다).
- 동시 리드 수: `launch-worker.sh` 가 load>코어×2 또는 메모리 여유<25% 면 거부한다(`--force` 로 강행). 거부되면 `orca terminal list` 로 유휴 에이전트를 찾아 `finish-worker.sh` 로 내린 뒤 다시. 다른 프로젝트의 워커도 같은 기계를 쓴다.

## 3.5 격리 (2026-09-12 결정 — docker 없이)
`launch-worker.sh` 가 모든 에이전트(PL·실무자)를 macOS `sandbox-exec` 로 감싼다: 시그널은 자기 프로세스 그룹에만(운영 오케·다른 세션 kill 불가, `pkill`·`killall` 무력), docker 소켓 차단(운영 컨테이너 보호 — Docker Desktop·OrbStack 경로 셋 다. 2026-09-13 Docker Desktop 을 지우고 OrbStack 으로 옮기면서 `~/.orbstack/run/docker.sock` 을 추가했다; 런타임을 바꾸면 이 목록도 바꿔야 한다). 파일·네트워크·툴체인은 그대로. 실측: 자식·손자 kill 됨, 운영 pid `kill -9` EPERM, agy·codex 정상 동작, psql TCP 됨. PM 이 직접 쓰는 세션만 `--no-sandbox`. 컨테이너 격리(A)는 이걸로 충분하면 안 한다.

## 4. 절대 규칙 (orca-lead §2 와 같다 — 요지)
가드는 내가 직접 뺀다 · 전체 검사 필터 없이 · 부하 빨강은 재실행·main 대조로 가른다 · 잰 것과 말하는 것이 같은가 · 일감=워크트리=새 에이전트 · 폴러는 깨우는 방식 · PR 본문은 파일로 · `git worktree add … &&` 금지 · 실 DB 로 실험 금지 · 착지를 파일로 확인하기 전 마이그레이션·재기동 금지.

## 5. 리드 브리프에 꼭 넣는 것
조각의 목표·근거(인용) · 범위 경계 · 워커 후보와 등급 · 프로젝트 고유값(저장소·운영 포트/DB·격리 DSN·전체 검사 명령·코디 Run·핸들/본메일 파일) · 파일 경계(동시에 도는 다른 리드가 만지는 곳) · 완료 조건(증거 묶음).


## 6. 함정 (2026-09-12 실측)
- (해결됨 2026-09-12) 리드와 코디네이터의 `verify-pr.sh` 가 같은 `/tmp/v<PR>` 을 써서 코디네이터 검사가 중간에 사라진 적이 있다 → 지금은 `--role pm` 으로 `/tmp/v<PR>-pm` 을 쓴다. 표본 검증은 `verify-pr.sh <PR> --role pm …` 이며 가드 자동 검사(d)가 포함된다.
- 같은 PM Run 으로 다음 조각의 Monitor 를 새로 띄울 때 `--seen` 파일을 새로 비우면 지난 조각의 보고가 다시 "깨운다" 로 온다(실측 2026-09-13) — PM 본메일 파일은 **Run 단위로 하나**(`seen-pm-<Run>.txt`)를 이어 쓴다.
- 워커가 코디네이터 인프라(Redis)에 FLUSHALL 을 실행한 적이 있다 — 검증용 컨테이너는 별도 포트·볼륨으로만, 워커 브리프에 쓰기 명령 금지를 박는다. 리드가 `--body` 에 백틱을 넣어 셸 치환으로 같은 명령이 한 번 더 실행됐다 — 답신도 `--body "$(cat 파일)"`.
- 같은 저장소에 PM 세션이 둘 이상이면 `~/.<프로젝트>/coord/leads.txt` 같은 **공용 핸들 파일이 섞인다**(2026-09-13 실측: 다른 세션의 리드가 내 폴러 대상에 들어옴). 핸들·본메일 파일은 세션별 이름(`leads-<세션id 앞 4자>.txt`)으로. `launch-worker.sh` 를 다른 세션이 편집 중이면 실행이 문법 오류로 실패할 수 있다 — 한 번 더 시도하고, 같은 이름 워크트리가 둘 생기면 `path:` 선택자로 지운다.
