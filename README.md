# orca-skills

Claude Code 플러그인 마켓 `orca-skills` 이자, codex·agy 가 읽는 고정 경로 `~/.orca-skills` 의 원본. 여러 워크트리로 나눠 시키는 개발 작업을 **다섯 자리**로 돌리는 규칙과 스크립트다.

## 한눈에

```
사용자 ── 결정(설계·실 데이터·로스터)만 묻는다
   │
이사    Claude        계획 · 조각 나누기 · 부장/과장 브리프 · 표본 검증 · 머지 · 회수 · 기록
   │
부장    codex         판정만 — 폴러가 저장해 준 증거 묶음(/tmp/bundle-*.md)을 읽고 통과/반려, 「머지 준비됨」 정리
   │
과장    agy-pro       운영·검토 — 대리 한 명을 세우고 기다리고, PR 이 오면 verify·변이 검사·점검표 → 부장에 증거 묶음
   │
대리    agy-flash     분할·통합 — 조각을 사원 일감으로 잘라 pipeline-run.sh 로 돌리고, 실패분을 직접 하고, 통합·PR
   │
사원    gpt-oss-120b  하네스 — worker-run.sh 가 편집만 시키고 검증·재시도(4회)·flash 승격(2회)·커밋을 대신한다. 세션이 아니다
```

추론 능력(Claude > codex > gemini > gpt-oss) 순서로 **위는 판단, 아래로 갈수록 양**을 맡는다. 호칭은 한국식 직급(이사·부장·과장·대리·사원)으로 통일하고, 기계 id 는 `director / lead / manager / assistant / staff` 다(2026-09-13 결정). 예산은 Claude·agy 가 크고 codex 가 작다는 전제다.

원칙 하나: **말은 주장이고 출력이 증거다.** 층마다 아래의 보고를 믿지 않고 스크립트 출력(가드 자동 검사·변이 검사·preflight)으로 다시 잰다.

## 설치

```sh
git clone https://github.com/inho-team/orca-skills ~/orca/orca-skills   # 작업 복사본(고칠 때)
sh ~/orca/orca-skills/install.sh                                         # 마켓 등록 + 플러그인 설치 + ~/.orca-skills 링크
```

`install.sh` 는 (1) `claude plugin marketplace add inho-team/orca-skills` + `claude plugin install orca@orca-skills`, (2) `~/.orca-skills → ~/.claude/plugins/marketplaces/orca-skills/plugins/orca/skills` 링크를 만든다. Claude 는 플러그인으로 스킬(`orca:director`, `orca:orca-top`, `orca:orca-lead`, `orca:orca-worker`)을, codex·agy 는 `~/.orca-skills/…` 경로로 같은 파일을 읽는다. `~/.claude/skills/` 아래에 두지 않는다(스킬 이중 등록).

필요한 것: `orca`(Orca CLI), `gh`, `codex`, `agy`(Antigravity CLI), `python3`, macOS `sandbox-exec`(격리), 프로젝트별 `.orca/project.env`.

## 갱신 규칙

- 고칠 때: `~/orca/orca-skills` 에서 수정 → **`plugins/orca/.claude-plugin/plugin.json` 과 `.claude-plugin/marketplace.json` 의 `version` 을 올린다(patch)** → 커밋·푸시 → `claude plugin marketplace update orca-skills && claude plugin update orca@orca-skills`.
- 버전을 안 올리면 Claude 플러그인 캐시가 갱신되지 않는다(실측). `~/.orca-skills` 링크는 마켓 클론이라 `marketplace update` 만으로 최신이다.
- 새 함정·결함은 실측한 자리(SKILL.md 의 해당 절, 스크립트 주석)에 **날짜와 함께** 적는다. 이 저장소의 규칙은 전부 실제로 깨졌던 것에서 나왔다.

## 구성

```
plugins/orca/skills/
  director/SKILL.md           /orca:director <요청> — 연쇄 진입점(이사 절차 5단계)
  orca-top/SKILL.md           이사 규칙: 계획·세우기·감시·표본 검증·머지·회수·기록·격리
  orca-lead/                  부장·과장·대리·사원의 규칙과 스크립트
    SKILL.md                  절차 전문(§0 배치, §2 절대 규칙, §3 세우기·등급, §4 폴링, §5 검증, §6 반려 기준, §7 보고)
    LEAD-CHECKLIST.md           부장(codex)이 읽는 2KB — 판정표와 금지 목록
    lead-brief-template.md    이사 → 부장 브리프(판정용, 반 쪽)
    manager-brief-template.md     이사 → 과장 브리프(운영·검토)
    assistant-brief-template.md  과장 → 대리 브리프(분할·통합)
    staff-brief-template.md  사원 일감 형식(편집 지시 + 완료 조건 + 브랜치/커밋)
    review-brief-template.md  검토 규칙·점검표(과장이 참조)
    assistant-solo-brief-template.md  대리가 직접 구현할 때의 단독 브리프
    common-rules.md           워커 공통 규칙 정본 — launch-worker.sh 가 자리표시자를 채워 TASK.md 에 붙인다
    project.env.example       프로젝트 고유값 양식 → <저장소>/.orca/project.env
    launch-worker.sh          워크트리 + 에이전트 세우기(이름 규칙·기계 포화 검사·seatbelt·워커 스택·Run/POLLER 자동 배정·--notify)
    finish-worker.sh          에이전트 내리기(터미널·POLLER·워커 스택·잔존 프로세스 보고·핸들 done)
    poll.py                   폴러 — 사건(메일·새 PR·워커 상태줄)을 60초 묶음으로 감독자 터미널에 보내 깨운다. 메일 본문은 파일로
    verify-pr.sh              PR 검증 — 작업 파일 혼입·main 병합·전체 검사·가드 자동 검사(main+guard 만 빨강)·변이 검사(--mutate)·--notify
    worker-run.sh             사원 하네스 — 모델에 편집만, 검증·재시도·사다리 승격·429 감지·커밋·PR·보고는 스크립트
    pipeline-run.sh           사원 일감 순차/병렬 실행(task-NN[a-z].md, 한 브랜치, cherry-pick, 충돌은 pipe/<일감> 브랜치로)
    staff-find.sh             사원 찾기 — 질문 → 인용 대조 통과한 {file,line,quote,why}. 상위 자리의 읽기·인용을 내린다
    staff-draft.sh            사원 초안 — checklist(점검표 초안, 판정 없음) / mutations(diff 안 변이 후보). 인용은 cite-check 로 대조
    cite-check.py             인용 대조기 — 사원의 {file,line,quote} 를 실제 파일과 맞춘다(±3줄 보정, 지어낸 인용 탈락)
    agent-stats.py            codex 로그에서 턴·토큰·깨움·기다림 지표(백로그 한 줄)
    keepboth.py               문서 충돌 양쪽 보존
  orca-worker/
    SKILL.md                  대리·사원·과장이 지키는 실무 규칙(재현→고침→가드, preflight, 반려 사유였던 것)
    preflight.sh              보고 전 점검(미push·작업 파일 혼입·guard 커밋 유무·검사 결과)
install.sh                    이 머신 설치
```

## 한 조각의 흐름

1. **이사**: 요청을 읽고(추측 금지) 조각으로 자른다. 사람 결정은 한 번에 묻는다. `lead-brief-template.md`(부장)와 `manager-brief-template.md`(과장) 둘 다 쓴다. 이사 터미널은 `/rename director-<프로젝트>`.
2. **이사가 세운다**: `launch-worker.sh lead-<조각> <부장브리프> codex --repo … --handles ~/.<프로젝트>/coord/leads.txt` → 출력의 부장 Run → `launch-worker.sh manager-<조각> <과장브리프> manager --supervise --run <부장 Run> --repo … --handles ~/.<프로젝트>/coord/handles-lead-<조각>.txt --parent lead-<조각>`. 이사 Run 은 Monitor 로 감시.
3. **과장**: `assistant-brief-template.md` 로 대리를 세운다(`launch-worker.sh assistant-<조각> … assistant --run <과장 Run> --parent manager-<조각> --notify <과장 터미널>`, 배경). 폴러가 깨운다.
4. **대리**: 조각을 `task-01.md, task-02a.md, task-02b.md …`(워크트리 밖 `~/.<프로젝트>/coord/tasks-<조각>/`)로 자른다 — guard → 구현 → 문서 순서, 겹치지 않는 것은 같은 번호+글자로 병렬. `pipeline-run.sh <워크트리> <디렉터리> --branch … --notify <대리 터미널>` 배경 실행. 실패분과 cherry-pick 충돌은 직접. 통합(전체 검사·가드 빼기·preflight) → PR → 과장 Run 에 보고(`PIPELINE.md` 표 포함).
5. **과장**: `staff-draft.sh mutations/checklist` 로 사원 초안(대조된 인용만) → 변이를 골라 `verify-pr.sh <PR> --role manager --guard-cmd … --mutate … --notify <과장 터미널>`(배경, 컴파일만 깨는 변이는 ⚠️ 로 제외됨) → 점검표 행마다 판정 → 묶음을 부장 Run 에 제출. 통과 뒤 `finish-worker.sh assistant-<조각>`.
6. **부장**: 폴러가 `/tmp/bundle-*.md` 와 ✅/🔴 집계로 깨운다 → `LEAD-CHECKLIST.md` 판정표 → 통과면 이사 Run 에 「머지 준비됨」(묶음 + 판단 근거 3줄), 반려면 과장에게 사유. PR 마다 `/compact`.
7. **이사**: 표본 검증 `verify-pr.sh <PR> --role director --mutate <과장 변이 하나> …` + 가드 본문 읽기 + 점검표 한 행 대조 → `gh pr merge` → 착지를 파일로 확인 → 운영 반영 → `finish-worker.sh lead-<조각>`(POLLER·스택 포함) → 워크트리 회수 → 잔존 프로세스 → 백로그에 `agent-stats.py` 한 줄.

## 이름 규칙

워크트리·탭 제목·핸들·스택 이름은 `<역할>-<조각>[-n]`: `director-<프로젝트>`, `lead-<조각>`, `manager-<조각>`, `assistant-<조각>`(재시도 `-2`), `staff-<조각>-<무엇>`, `poller-<조각>`. 소문자·숫자·하이픈. 조각 마디는 숫자만이면 안 된다(`assistant-1` 금지 — 이전 조각과 충돌해 `-2` 경로가 생겼다). `launch-worker.sh` 가 거부한다.

## 격리와 자원

- 모든 에이전트는 macOS `sandbox-exec` 로 감싼다: 시그널은 자기 프로세스 그룹에만(`pkill`·`killall` 무력), docker 소켓 차단(Docker Desktop·OrbStack 경로 모두). 파일·네트워크·툴체인은 그대로.
- 워커별 서비스(DB 등)는 저장소의 `.orca/worker-stack.sh up|down` 이 있으면 `launch-worker.sh` 가 에이전트 **전에** 올려 DSN 을 TASK.md 「워커 스택」 에 적는다(OrbStack compose, 임의 포트, tmpfs). 워커는 docker 를 만지지 않는다. `finish-worker.sh` 가 내린다.
- `launch-worker.sh` 는 load > 코어×2 또는 메모리 여유(`memory_pressure`) < 25% 면 세우지 않는다(`--force`). 스왑 사용률은 macOS 에서 후행 지표라 쓰지 않는다.
- 끝난 에이전트는 즉시 내린다(`finish-worker.sh`). 살려 두면 100~370MB 씩 유휴로 남는다.

## 실측으로 정해진 것들 (왜 이렇게 생겼나)

- **부장이 세우기·기다리기까지 하면 조각당 48턴·4M 토큰**(codex). 판정만 남기고 세우기는 이사, 운영은 과장으로 내렸다. 폴러가 메일 본문을 파일로 저장하는 것도 부장 컨텍스트(턴당 100K→목표 30~40K) 때문.
- **codex 는 도구 실행이 30초에 끊기고**, 2분 넘는 명령을 배경으로 돌리다 못 돌아온다. 그래서 긴 스크립트는 `--notify` 로 끝을 알린다.
- **gpt-oss 는 agy 편집 도구 인자를 빠뜨리고, 셸 편집은 순서·빈 줄을 틀리며, 커밋·보고를 안 하고 "완료" 라고 쓴다.** 그래서 편집만 시키고 나머지는 하네스. 실측: 문서 2건(2~3회), Kotlin 가드 테스트 1건(4회), 파이프라인 일감 7건 통과.
- **agy `-p` 는 `--add-dir` 없이는 홈을 뒤진다**(남의 파일을 편집하려 했다). 하네스는 반드시 `--add-dir`.
- **flash 할당량은 429 로 소진된다.** 하네스가 429 를 감지하면 그 모델의 남은 시도를 건너뛴다.
- 가드 검사는 "가드 커밋을 revert" 가 아니라 **"main + guard 커밋만 올려 빨간가"**(재현 테스트 원칙). revert 는 파일 삭제로 빨개질 뿐이었다.
- `GUARD_CMD` 뒤에 `| tail` 을 붙이면 종료코드가 tail 것이 된다 — `verify-pr.sh` 는 pipefail 로 방어하지만 정본은 깨끗하게.
- 같은 이사 Run 으로 다음 조각을 감시할 때 본메일 파일을 새로 비우면 지난 보고가 다시 깨운다 — Run 단위로 하나를 이어 쓴다.
- **상위 자리 턴의 절반은 "찾아 인용하기"** 다. 요약은 검증이 안 되지만 **인용은 검증된다** — 사원(gpt-oss)이 찾고 `cite-check.py` 가 실제 파일과 대조해 통과분만 올린다(`staff-find`·`staff-draft`). 결론은 위에 남긴다. 실측: 점검표 초안 10행 전부 대조 통과·과장의 실제 근거와 일치(25초).

## 프로젝트별로 두는 것 (여기 두지 않는다)

- `<저장소>/.orca/project.env` — PROD_NOTE·TEST_DSN·CHECK_CMDS·GUARD_CMD(양식 `project.env.example`)
- `<저장소>/.orca/worker-stack.sh`·`worker-compose.yml` — 워커별 서비스가 필요할 때(예: workbench 의 Postgres)
- `~/.<프로젝트>/coord/` — Run id·핸들·본메일·브리프·일감·백로그
