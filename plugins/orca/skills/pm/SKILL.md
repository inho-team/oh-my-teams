---
name: pm
description: >-
  연쇄(PM=Claude 계획·머지 → PL=codex 판정만 → 과장=agy-pro 운영·검토 → 대리=agy-flash 분할·통합·어려운 로직 → 사원=gpt-oss 하네스)의 진입점. `/pm <요청>` 또는 "PM 으로 진행해",
  "PL 붙여서 해", "3층으로 돌려", "orca 로 나눠 시켜" 같은 말이면 이 스킬이다. 요청을 조각으로 잘라
  PL 을 세우고 표본 검증·머지·운영까지 끝낸다. 상세 절차는 orca-top / orca-lead / orca-worker.
---

# /pm — 연쇄 진입점

`/pm <요청>` 한 줄이면 아래가 자동으로 돈다. 사용자가 단계마다 부를 필요가 없다.

1. **읽기·계획(PM)** — 요청과 관련 설계 문서·실측을 읽고(추측 금지) 조각으로 자른다. 조각 = PL 하나가 실무자 1~5명으로 하루 안에 끝낼 크기. 사람 결정이 필요한 것은 **여기서 한 번에** 묻는다(`AskUserQuestion`).
2. **PL·시니어 세우기** — 조각마다 PM 이 브리프 둘을 쓴다(`lead-brief-template.md` 반 쪽, `ops-brief-template.md` 전문) → `launch-worker.sh pl-<조각> <PL브리프> codex --repo <프로젝트> --handles ~/.<프로젝트>/coord/leads.txt` → 출력의 PL Run 으로 `launch-worker.sh senior-<조각> <시니어브리프> senior --supervise --run <PL Run> --repo <프로젝트> --handles ~/.<프로젝트>/coord/handles-pl-<조각>.txt --parent pl-<조각>`. 시작할 때 사용자에게 **`/rename pm-<프로젝트>`** 를 한 번 쳐 달라고 한다(Claude Code 가 자동 요약으로 탭 제목을 덮어쓰므로 `orca terminal rename` 은 안 남는다 — 실측 2026-09-13. `/rename` 은 세션 이름을 탭 제목으로 고정한다. 새로 열 때는 `claude -n pm-<프로젝트>`). 기계 부하(`uptime`·`memory_pressure`)를 보고 동시 PL 수를 정한다.
3. **감시(PM)** — **Monitor 도구**(persistent) 로: `while true; do python3 -u ~/.orca-skills/orca-lead/poll.py --run <PM Run> --handles <leads.txt> --seen <seen> --no-pr --max-min 60 2>&1 | grep -E --line-buffered "깨운다|손봐야|·|🔴|오류|조용"; sleep 5; done` — 깨울 줄마다 알림이 오고 스스로 재가동한다(PR 변화가 아니라 PL 의 보고로만 깬다). ⚠️ Bash `run_in_background` 로 폴러를 돌리면 1분 뒤 셸째 조용히 죽는 것을 실측했다(5회, nohup 도 소용없음) — Monitor 를 쓴다. PL 의 `question` 에 답하고, "머지 준비됨" 이 오면 4.
4. **표본 검증 → 머지 → 운영(PM)** — 증거 묶음(시니어 검토 보고 포함) 확인 → `verify-pr.sh --role pm --mutate <시니어 변이 하나>` + 가드 본문 읽기 + 시니어 점검표 한 항목 대조(orca-top §1.4) → 머지 → 착지 확인 → 재기동/웹 빌드 → 새 코드 신호 → 주니어·시니어·PL 워크트리 회수 → 잔존 프로세스.
5. **보고(PM)** — 조각이 끝날 때마다 사용자에게 한 단락: 무엇이 main 에 들어갔나(파일로 확인한 것), 실물 신호, 남긴 것, 사람 결정 대기. 백로그·HANDOFF 갱신.

## 사용자가 쓰는 말 (전부 같은 뜻)
- `/pm <요청>` — 예: `/pm P6 DoD 다 채워`, `/pm /resources 에 조치 기능 넣어`
- "PM 으로 진행해", "PL 붙여서 해", "3층으로 돌려", "orca 로 나눠 시켜"
- 진행 중 확인: "PM 상황" → 도는 PL·실무자·열린 PR·대기 중인 사람 결정을 표로.
- 멈춤: "PM 멈춰" → 새 PL 을 안 세우고 도는 것만 마무리. 회수까지.

## 이 스킬이 하지 않는 것
- 단일 작업을 그냥 넘기는 것(`orca-cli`), 스레드 메시지 규약 설명(`orchestration`). 요청이 조각 하나로 끝나면 PL 없이 실무자 하나만 띄워도 된다 — 그래도 절차(브리프·preflight·가드 빼기)는 같다.

## 프로젝트 고유값
프로젝트 CLAUDE.md 또는 HANDOFF.md 에서 읽는다(운영 포트/DB, 격리 DSN, 전체 검사 명령, PM Run id, 핸들 파일). 없으면 첫 실행에서 만들어 두고 사용자에게 알린다.
