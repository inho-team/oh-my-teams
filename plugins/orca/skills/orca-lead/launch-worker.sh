#!/bin/sh
# orca-lead 워커 띄우기 — 워크트리 하나, 터미널 **하나**, 에이전트 하나.
#
# 사용:  launch-worker.sh <이름> <브리프.md> [intern|junior|senior|agy-flash|agy-pro|codex|claude] [--repo <경로>] [--handles <핸들파일>] [--parent <워크트리이름>]
#                         [--run <RUN_ID>] [--project-env <파일>] [--supervise] [--notify <터미널>] [--force] [--no-sandbox]
#   --notify <터미널> = 끝나면(성공·실패 모두) 그 터미널에 "[launch] …" 한 줄을 보낸다. **codex 는 도구 실행이 30초에 끊겨** 이 스크립트(60~90초)의 출력을
#              끝까지 못 본다(실측 2026-09-13: 부장이 오류로 착각하고 10턴을 썼다). codex/부장은 `… --notify <내 터미널> > /tmp/launch-<이름>.log 2>&1 &` 로 띄우고 프롬프트로 돌아간다. [--account <계정>]
#   --supervise = 이 에이전트가 **아래 워커를 세우고 기다리는 자리**다(2026-09-13 배치: 부장=codex 는 판단만, 과장=agy-pro 가 운영+검토).
#              켜지면 그 터미널에서 워커용 Run 을 만들어 묶고, TASK.md 끝에 「자동 배정」(Run·핸들 파일·워커 명령)을 붙이고, POLLER 터미널을 띄운다.
#              codex 는 기본 켜짐(부장도 과장의 보고·질문을 받을 Run 이 필요하다). 과장(운영)는 `manager --supervise --run <부장 Run>` 으로.
#   기본으로 macOS seatbelt 격리(시그널은 자기 pgrp 만, docker 소켓 차단). --no-sandbox 는 이사가 직접 쓰는 세션에만.
#   intern(사원 = gpt-oss-120b 하네스 → 대리 flash 로 자동 승격) = 브리프가 다 정해 주고 테스트/셸이 판정하는 구현·문서. TUI 없음(worker-run.sh). 2026-09-13 사용자 배치: 사원 gpt-oss · 대리 flash · 과장 pro
#   junior(=assistant, agy-flash, gemini-3.8-flash-high) = 구현. 명령형 브리프로 다 정해진 일 · senior(=manager, agy-pro, gemini-3.1-pro-high) = 검토(review-brief-template)·계획이 필요한 일·대리 2회 반려 뒤 인계
#   (2026-09-12 사용자 결정: 4역할 3층 — 이사 → 부장 → {대리: 코딩, 과장: 검토}. 대리·과장은 부장의 형제 자식이고 서로 직접 말하지 않는다)
#   codex = 부장(orca-lead 역할, gpt-5.6-sol) · --parent 를 주면 그 워크트리의 자식으로 만든다(리드 → 워커 계보)
#   --run <RUN_ID> = 워커가 보고할 Run(부장이 run-create 로 만든 것). 워커(agy·claude)에는 **필수** — 공통 규칙의 보고 주소가 된다.
#   --project-env <파일> = 프로젝트 고유값(기본 <저장소>/.orca/project.env, 양식은 project.env.example). PROD_NOTE·TEST_DSN·CHECK_CMDS 를 채운다.
#   --force = 기계 포화(load>코어×2 또는 메모리 여유<25%) 검사를 무시하고 강행.
#   codex(부장) 분기의 추가 동작(2026-09-12 폴러 역전): 부장 터미널에서 워커용 Run 을 먼저 만들고(run-create → 그 터미널에 묶인다),
#     TASK.md 끝에 「자동 배정」(Run id·워커 핸들 파일·본메일 파일)을 붙인 뒤 codex 를 띄우고, 부장 워크트리에 **POLLER 터미널**을 하나 더 만들어
#     `poll.py --wake <부장 터미널> --loop` 를 돌린다. 부장은 폴러를 부르지 않는다 — 사건이 오면 폴러가 부장 터미널에 한 줄을 보내 깨운다.
#     코디 파일은 --handles 의 디렉터리에 둔다: run-<이름>.json · handles-<이름>.txt · seen-<이름>.txt
#   예:  launch-worker.sh node-drain /tmp/tasks/node-drain.md agy-flash --run run_abc --handles ~/.proj/coord/handles.txt --parent pl-resources
#
# 하는 일: 기계 포화 검사 → worktree create → TASK.md 복사 + **공통 규칙(common-rules.md) 자동 첨부** → 워크트리의 **기본 터미널**에
# 에이전트 명령을 보낸다(터미널을 따로 만들지 않는다 — 만들면 빈 셸이 하나 더 남아 "에이전트가 죽었나" 로 보인다) →
# trust 프롬프트 처리 → 상태줄 확인 → 브리프 한 줄 → 착수 확인 → 핸들 파일에 기록.
# 🔴 에이전트가 안 뜨거나 곧 죽어 셸로 돌아오면 exit 1 로 알린다(마지막 화면을 찍는다).
set -u
NAME="$1"; BRIEF="$2"; AGENT="${3:-agy}"; shift 3 2>/dev/null || shift $#
REPO="$(git rev-parse --show-toplevel 2>/dev/null)"; HANDLES=""; PARENT=""; SANDBOX=1; RUN_ID=""; PROJECT_ENV=""; FORCE=0; SUPERVISE=""; NOTIFY=""
notify() { [ -z "$NOTIFY" ] && return 0; orca terminal send --terminal "$NOTIFY" --text "[launch $(date '+%H:%M')] $NAME $1 — 로그: /tmp/launch-$NAME.log(네가 리다이렉트한 파일). 핸들 파일과 TASK.md 「자동 배정」 을 봐라." --enter --json >/dev/null 2>&1; return 0; }
die() { echo "$1"; notify "🔴 실패: $1"; exit 1; }; ACCOUNT=""
while [ $# -gt 0 ]; do case "$1" in --repo) REPO="$2"; shift 2;; --handles) HANDLES="$2"; shift 2;; --parent) PARENT="$2"; shift 2;; --run) RUN_ID="$2"; shift 2;; --project-env) PROJECT_ENV="$2"; shift 2;; --supervise) SUPERVISE=1; shift;; --notify) NOTIFY="$2"; shift 2;; --force) FORCE=1; shift;; --no-sandbox) SANDBOX=0; shift;; --account) ACCOUNT="$2"; shift 2;; *) shift;; esac; done
# id 별칭(2026-09-13 안 1): lead=codex(부장) · manager=agy-pro(과장) · assistant=agy-flash(대리) · staff=gpt-oss 하네스(사원). 옛 이름(senior/junior/intern/agy-*)도 받는다.
case "$AGENT" in lead) AGENT=codex;; manager|senior|agy-pro|agy) AGENT=manager;; assistant|junior|agy-flash) AGENT=assistant;; staff|intern) AGENT=staff;; esac
if [ "$AGENT" = codex ] && [ -z "$SUPERVISE" ]; then SUPERVISE=1; fi   # codex(부장)는 기본으로 감독 자리
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"

# 기계 포화 검사(orca-top §3·orca-lead §3.3 의 규칙을 코드로, 2026-09-12): load > 코어×2 또는 **메모리 여유 < 25%** 면 세우지 않는다.
# 실측: 맥북 load 18.7 에서 agy 9개가 돌며 6개는 5~14시간 유휴였다. 문서 규칙만으로는 리드가 안 잰다.
# ⚠️ 스왑 사용률은 쓰지 않는다 — macOS 는 스왑 파일을 즉시 회수하지 않아 압박이 풀려도 80~90% 로 남는다(실측: 여유 59% 인데 swap 88%).
#    `memory_pressure` 의 System-wide memory free percentage 가 실제 압박이다.
CORES="$(sysctl -n hw.ncpu 2>/dev/null || echo 8)"
LOAD="$(sysctl -n vm.loadavg 2>/dev/null | awk '{printf "%d", $2}')"
MEMFREE="$(memory_pressure 2>/dev/null | awk -F': ' '/System-wide memory free percentage/{gsub("%","",$2); print int($2)}')"
SWAP="$(sysctl -n vm.swapusage 2>/dev/null | awk '{gsub("[^0-9.]","",$3); gsub("[^0-9.]","",$6); if ($3+0>0) printf "%d", $6*100/$3; else print 0}')"
if [ "$FORCE" != 1 ] && { [ "${LOAD:-0}" -gt $((CORES*2)) ] || { [ -n "$MEMFREE" ] && [ "$MEMFREE" -lt 25 ]; }; }; then
  die "🔴 기계가 포화다: load=${LOAD} (상한 $((CORES*2))) 메모리 여유=${MEMFREE:-?}% (하한 25%) swap=${SWAP}% — 새 에이전트를 세우지 않는다. 유휴 워커를 먼저 내려라(finish-worker.sh). 강행은 --force."
fi
echo "기계: cores=$CORES load=$LOAD 메모리 여유=${MEMFREE:-?}% swap=${SWAP}%(참고)"
# 격리(2026-09-12 결정, docker 없이): macOS seatbelt 로 에이전트 세션을 감싼다.
#   - 시그널은 자기 프로세스 그룹에만 → 운영 오케·다른 워커·부장을 kill/pkill/killall 할 수 없다(EPERM). 실측: 하루에 4번 운영을 죽였다.
#   - docker 소켓 connect 차단(Docker Desktop·OrbStack 경로 모두) → 운영 컨테이너를 못 만진다. DB 는 psql TCP 로(docker exec 금지).
#   - 그 외(파일·네트워크·go·node·git·gh·orca)는 그대로.
# 2026-09-13: Docker Desktop → OrbStack 으로 바뀌어 소켓 경로가 ~/.orbstack/run/docker.sock 이다 — 셋 다 막는다(하나만 막으면 구멍).
SB_PROFILE='(version 1)(allow default)(deny signal)(allow signal (target self))(allow signal (target pgrp))(deny network-outbound (literal "/var/run/docker.sock"))(deny network-outbound (literal "'"$HOME"'/.docker/run/docker.sock"))(deny network-outbound (literal "'"$HOME"'/.orbstack/run/docker.sock"))'

[ -n "$REPO" ] || { echo "🔴 --repo 가 필요하다"; exit 1; }
# 이름 규칙(사용자 결정 2026-09-13): <역할>-<조각>[-n]. 역할 = pl | senior | junior | intern. 워크트리·터미널 제목·핸들·스택(w-<이름>)에 모두 쓰인다.
#   좋은 예: lead-jwt-clock, manager-jwt-clock, assistant-jwt-clock, assistant-jwt-clock-2(재시도), staff-jwt-clock-docs
#   나쁜 예: junior-1, intern-1 (조각이 안 보이고, 이전 조각과 충돌해 -2 경로가 생겼다 — 실측)
case "$AGENT" in codex) WANT=lead;; manager) WANT=manager;; assistant) WANT=assistant;; staff) WANT=staff;; claude) WANT="";; esac
# 옛 접두사(pl-/senior-/junior-/intern-)로 세운 것은 지금 도는 조각이라 허용한다(경고만)
case "$NAME" in pl-*|senior-*|junior-*|intern-*) echo "⚠️ 옛 접두사 이름($NAME) — 새 규칙은 lead-/manager-/assistant-/staff-"; WANT="";; esac
if [ -n "${WANT:-}" ] && ! printf '%s' "$NAME" | grep -qE "^$WANT-[a-z0-9]*[a-z][a-z0-9]*(-[a-z0-9]+)*$"; then   # 조각 마디는 숫자만이면 안 된다(junior-1 금지)
  die "🔴 이름 규칙 위반: '$NAME' — $AGENT 는 '$WANT-<조각>[-n]' 이어야 한다(소문자·숫자·하이픈). 예: $WANT-jwt-clock"
fi
# 등급(사용자 규칙 2026-09-12): 일반 작업 → flash, 계획이 필요한 중간관리자 → pro,
# 깊은 계획은 코디네이터(Claude)가 직접 하고 잘라 내린다 — 워커에게 주지 않는다.
case "$AGENT" in
  manager)              CMD='agy --model gemini-3.1-pro-high --dangerously-skip-permissions';   ALIVE='Gemini\|shortcuts';;   # 과장
  assistant)            CMD='agy --model gemini-3.8-flash-high --dangerously-skip-permissions'; ALIVE='Gemini\|shortcuts';;   # 대리
  staff)                CMD='agy --model gpt-oss-120b-medium --dangerously-skip-permissions';  ALIVE='GPT-OSS\|gpt-oss\|shortcuts';;   # 사원(하네스 — 아래에서 TUI 대신 worker-run.sh)   # 상태줄 실측 2026-09-13: '? for shortcuts … GPT-OSS 120B (Medium)'
  claude)        CMD="claude -n '$NAME' --dangerously-skip-permissions";                  ALIVE='Model:\|bypass permissions';;   # -n: 세션 이름=탭 제목(자동 요약 제목이 덮어쓰지 않는다)
  codex)         CMD='codex --model gpt-5.6-sol --dangerously-bypass-approvals-and-sandbox'; ALIVE='Ask Codex to do anything\|gpt-5';;   # 부장(리드)용. 이 계정은 gpt-5.4 가 400 이라 5.6-sol
  *) echo "🔴 모르는 에이전트: $AGENT (lead|codex · manager · assistant · staff · claude — 옛 이름 senior/junior/intern/agy-* 도 됨)"; exit 1;;
esac
cd "$REPO" && git fetch -q origin
if [ -n "$PARENT" ]; then PARENTOPT="--parent-worktree name:$PARENT"; else PARENTOPT="--no-parent"; fi
OUT="$(orca worktree create --name "$NAME" --repo "path:$REPO" --base-branch origin/main $PARENTOPT --json 2>&1)"
WT="$(printf '%s' "$OUT" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["worktree"]["path"])' 2>/dev/null)"
[ -n "$WT" ] && [ -d "$WT" ] || die "🔴 워크트리 생성 실패: $(printf '%s' "$OUT" | head -c 300)"
cp "$BRIEF" "$WT/TASK.md"
# 사원(intern, 2026-09-13 실측 뒤 결정): TUI 를 띄우지 않는다. worker-run.sh 가 사다리(gpt-oss 5회 → 대리급 승격 2회, 하네스 안의 flash)로 편집만 모델에 시키고
# 검증·재시도·승격·커밋·PR·보고를 스크립트로 한다. (gpt-oss: 편집 도구 인자 누락·엉성한 편집·지어낸 완료 → 하네스가 흡수. 문서 2건·Kotlin 가드 1건 통과 실측)
if [ "$AGENT" = staff ]; then
  [ -n "$RUN_ID" ] || die "🔴 사원에도 --run <RUN_ID> 가 필요하다(브리프 「보고」 절이 그 Run 으로 보낸다)"
  EX="$(git -C "$WT" rev-parse --git-path info/exclude)"; mkdir -p "$(dirname "$EX")"; grep -qx 'TASK.md' "$EX" 2>/dev/null || printf '%s\n' TASK.md '*.log' >> "$EX"
  SBP=""; [ "$SANDBOX" = 1 ] && SBP="$SB_PROFILE"
  ( STAFF_SANDBOX_PROFILE="$SBP" nohup "$SKILL_DIR/worker-run.sh" "$WT" "$WT/TASK.md" --run "$RUN_ID" --notify "$NOTIFY" > "/tmp/launch-$NAME.log" 2>&1 & echo $! > "/tmp/staff-$NAME.pid" )
  [ -n "$HANDLES" ] && printf '%s:staff-run pid %s (staff, 터미널 없음 — 폴러 감시 대상 아님)\n' "$NAME" "$(cat /tmp/staff-$NAME.pid)" >> "$HANDLES"
  echo "✅ $NAME  $WT  worker-run.sh 배경 실행(pid $(cat /tmp/staff-$NAME.pid), 사다리 gpt-oss→flash) — 끝나면 --notify 로 알림, 로그 /tmp/staff-$NAME.log"
  exit 0
fi
# 워커 스택(2026-09-13, OrbStack): 저장소에 `.orca/worker-stack.sh` 가 있으면 **에이전트를 띄우기 전에, sandbox 밖에서** `up <이름> <워크트리>` 를 불러
# 전용 DB 등을 올리고 KEY=VALUE 출력을 받는다. 워커·부장은 docker 를 만지지 않고 받은 주소만 쓴다(seatbelt 가 docker 소켓을 막는다).
# TEST_DSN 이 출력에 있으면 project.env 의 값보다 우선한다. finish-worker.sh 가 `down` 으로 내린다(stack-<이름>.env 로 찾는다).
STACK_TEST_DSN=""; STACK_LINES=""
if [ -x "$REPO/.orca/worker-stack.sh" ]; then
  STACK_ENV="$( [ -n "$HANDLES" ] && printf '%s' "$(cd "$(dirname "$HANDLES")" && pwd)" || printf '%s' "$WT" )/stack-$NAME.env"
  if STACK_LINES="$("$REPO/.orca/worker-stack.sh" up "$NAME" "$WT" 2>"/tmp/stack-$NAME.err")"; then
    printf '%s\n' "$STACK_LINES" > "$STACK_ENV"
    STACK_TEST_DSN="$(printf '%s\n' "$STACK_LINES" | awk -F= '/^TEST_DSN=/{sub(/^TEST_DSN=/,""); print}')"
    echo "워커 스택 up: $(printf '%s\n' "$STACK_LINES" | awk -F= '/^STACK_PROJECT=/{print $2}') ($STACK_ENV)"
  else
    tail -5 "/tmp/stack-$NAME.err"; die "🔴 워커 스택 up 실패 — /tmp/stack-$NAME.err"
  fi
fi
# 공통 규칙 자동 첨부(2026-09-12): 워커(agy·claude) 브리프에는 common-rules.md(정본)를 끝에 붙이고
# {{PROD_NOTE}}·{{TEST_DSN}}·{{CHECK_CMDS}} 는 project.env 에서, {{RUN_ID}} 는 --run 에서 채운다.
# 실측: 리드가 손으로 복사하다 "미리 허락됐다" 가 빠져 워커가 AskUserQuestion TUI 에서 멈췄다.
case "$AGENT" in manager|assistant|staff|claude) IS_WORKER=1;; *) IS_WORKER=0;; esac
if [ "$IS_WORKER" = 1 ]; then
  [ -n "$RUN_ID" ] || die "🔴 워커에는 --run <RUN_ID> 가 필수다 — 보고 주소가 없으면 PR 이 와도 아무도 모른다"
  [ -n "$PROJECT_ENV" ] || PROJECT_ENV="$REPO/.orca/project.env"
  PROD_NOTE=""; TEST_DSN=""; CHECK_CMDS=""
  if [ -f "$PROJECT_ENV" ]; then . "$PROJECT_ENV"; else echo "⚠️ project.env 가 없다($PROJECT_ENV) — 양식: $SKILL_DIR/project.env.example"; fi
# 역할별 구독(계정) — 사용자 결정 2026-09-13 "각 역할마다 구독을 달리할 수 있어야 한다".
#   --account <이름> 이 없으면 project.env 의 ACCOUNT_<역할>(JUNIOR/SENIOR/INTERN/부장/CLAUDE) 을, 그것도 없으면 기본 계정을 쓴다.
#   agy: <이름> 은 ~/.workbench/agy-homes/<이름>(컨테이너 직원과 같은 홈 — 자격 = .gemini/antigravity-cli/antigravity-oauth-token). 'host' = 이 사용자의 기본 HOME(Ultra).
#        HOME 만 바꾸면 go·npm·git 도 그 홈을 보므로 캐시·설정은 진짜 경로로 되돌린다(실측: HOME 교체로 pro 계정 /quota 가 그대로 나왔다).
#   codex: <이름> 은 ~/.codex-<이름>(CODEX_HOME). 'default' = ~/.codex.
if [ -z "$ACCOUNT" ]; then
  case "$AGENT" in agy-flash|junior) ACCOUNT="${ACCOUNT_JUNIOR:-}";; agy|agy-pro|senior) ACCOUNT="${ACCOUNT_SENIOR:-}";; intern) ACCOUNT="${ACCOUNT_INTERN:-}";; codex) ACCOUNT="${ACCOUNT_PL:-}";; claude) ACCOUNT="${ACCOUNT_CLAUDE:-}";; esac
fi
if [ -n "$ACCOUNT" ] && [ "$ACCOUNT" != "host" ] && [ "$ACCOUNT" != "default" ]; then
  case "$AGENT" in
    agy|agy-pro|senior|agy-flash|junior|intern)
      AH="$HOME/.workbench/agy-homes/$ACCOUNT"
      [ -f "$AH/.gemini/antigravity-cli/antigravity-oauth-token" ] || { echo "🔴 agy 계정 홈에 자격이 없다: $AH (antigravity-oauth-token)"; exit 1; }
      CMD="env HOME='$AH' GOPATH='$HOME/go' GOMODCACHE='$HOME/go/pkg/mod' GOCACHE='$HOME/Library/Caches/go-build' npm_config_cache='$HOME/.npm' GIT_CONFIG_GLOBAL='$HOME/.gitconfig' PATH='$PATH' $CMD";;
    codex)
      CH="$HOME/.codex-$ACCOUNT"; [ -f "$CH/auth.json" ] || { echo "🔴 codex 계정 홈에 auth.json 이 없다: $CH"; exit 1; }
      CMD="env CODEX_HOME='$CH' $CMD";;
  esac
  echo "[계정] $AGENT → $ACCOUNT"
fi
  [ -n "$STACK_TEST_DSN" ] && TEST_DSN="$STACK_TEST_DSN"   # 스택이 준 전용 DSN 이 정본보다 우선
  if grep -q '^## 공통 규칙' "$WT/TASK.md" && ! grep -q '여기에 쓰지 마라' "$WT/TASK.md"; then
    echo "⚠️ 브리프에 손으로 쓴 「공통 규칙」 이 있다 — 정본으로 덮는다(리드는 이 절을 쓰지 않는다)"
    python3 - "$WT/TASK.md" <<'PY'
import sys; p=sys.argv[1]; s=open(p,encoding='utf-8').read(); i=s.find('## 공통 규칙'); open(p,'w',encoding='utf-8').write(s[:i] if i>=0 else s)
PY
  fi
  RUN_ID="$RUN_ID" PROD_NOTE="$PROD_NOTE" TEST_DSN="$TEST_DSN" CHECK_CMDS="$CHECK_CMDS" PROJECT_ENV_PATH="$PROJECT_ENV" python3 - "$WT/TASK.md" "$SKILL_DIR/common-rules.md" <<'PY'
import os, sys, re
task, rules = sys.argv[1], sys.argv[2]
s = open(task, encoding='utf-8').read()
i = s.find('## 공통 규칙')
if i >= 0: s = s[:i].rstrip('\n') + '\n\n'          # 템플릿의 안내 주석 절을 정본으로 바꾼다
r = open(rules, encoding='utf-8').read()
vals = {k: os.environ.get(k, '') for k in ('RUN_ID', 'PROD_NOTE', 'TEST_DSN', 'CHECK_CMDS')}
missing = [k for k, v in vals.items() if not v and '{{%s}}' % k in r]
for k, v in vals.items(): r = r.replace('{{%s}}' % k, v or '<%s 미정 — project.env 에 채워라>' % k)
open(task, 'w', encoding='utf-8').write(s + r)
if missing: print('⚠️ 채우지 못한 자리표시자: ' + ', '.join(missing) + ' (project.env: ' + os.environ.get('PROJECT_ENV_PATH', '') + ')')
else: print('공통 규칙 첨부 완료 (RUN_ID=%s)' % vals['RUN_ID'])
PY
fi
# 워커 스택 절은 공통 규칙 처리 **뒤에** 붙인다(공통 규칙 블록이 '## 공통 규칙' 이후를 정본으로 갈아 끼우므로, 먼저 붙이면 지워진다 — 실측)
if [ -n "$STACK_LINES" ]; then
  printf '\n## 워커 스택 (launch-worker.sh 가 올렸다 — 네 전용이다. docker 는 만지지 마라, 내리는 것은 finish-worker.sh)\n' >> "$WT/TASK.md"
  printf '%s\n' "$STACK_LINES" | sed 's/^/- `/; s/$/`/' >> "$WT/TASK.md"
fi
# 🔴 작업 파일이 커밋에 섞이는 사고(2026-09-12 에 세 번: inbox 로그 310KB·테스트 시크릿·patch) 를 원천 차단 —
# 워크트리 전용 exclude 에 패턴을 심는다(git-path 가 linked worktree 의 info/exclude 를 준다). `git add .` 을 해도 안 잡힌다.
EX="$(git -C "$WT" rev-parse --git-path info/exclude)"; mkdir -p "$(dirname "$EX")"
grep -qx 'TASK.md' "$EX" 2>/dev/null || printf '%s\n' '# orca-lead 워커 작업 파일(커밋 금지)' TASK.md PR.md PR_UPDATE.md pr_body.md report.md 'inbox*' '*.log' '*.patch' '*.orig' '*.diff' '*.rej' 'temp.*' url_test.sh '*TASK*.md' >> "$EX"
# 워크트리의 기본 터미널을 잡는다(create 가 하나 만든다). 없으면 그때만 하나 만든다.
T="$(orca terminal list --worktree "path:$WT" --json 2>/dev/null | python3 -c '
import sys,json; d=json.load(sys.stdin); ts=(d.get("result") or {}).get("terminals") or d.get("terminals") or []
print(ts[0].get("handle") or ts[0].get("id") if ts else "")' 2>/dev/null)"
if [ -z "$T" ]; then
  orca terminal create --worktree "path:$WT" --json >/dev/null 2>&1
  T="$(orca terminal list --worktree "path:$WT" --json 2>/dev/null | python3 -c '
import sys,json; d=json.load(sys.stdin); ts=(d.get("result") or {}).get("terminals") or d.get("terminals") or []
print(ts[0].get("handle") or ts[0].get("id") if ts else "")')"
fi
[ -n "$T" ] || die "🔴 터미널을 못 잡았다"
screen() { orca terminal read --terminal "$T" --screen 2>/dev/null | grep -v '^\s*$'; }
if [ "$SANDBOX" = 1 ]; then CMD="sandbox-exec -p '$SB_PROFILE' $CMD"; fi
# --- 감독 자리(--supervise: codex 부장 기본, 과장 운영): 워커용 Run 을 이 터미널(셸 상태)에서 만들어 묶고, 「자동 배정」 을 TASK.md 에 붙인다 ---
POLL_RUN=""; WHANDLES=""; WSEEN=""
if [ "$SUPERVISE" = 1 ]; then
  if [ -n "$HANDLES" ]; then
    COORD="$(cd "$(dirname "$HANDLES")" && pwd)"; RUNJSON="$COORD/run-$NAME.json"; WHANDLES="$COORD/handles-$NAME.txt"; WSEEN="$COORD/seen-$NAME.txt"
    rm -f "$RUNJSON"
    orca terminal send --terminal "$T" --text "orca orchestration run-create --objective '$NAME 워커' --json > '$RUNJSON'; echo RUNCREATE_DONE" --enter >/dev/null
    i=0; while [ $i -lt 20 ]; do [ -s "$RUNJSON" ] && screen | grep -q RUNCREATE_DONE && break; sleep 1; i=$((i+1)); done
    POLL_RUN="$(python3 -c 'import sys,json; d=json.load(open(sys.argv[1])); r=d.get("result") or {}; print(r.get("runId") or r.get("id") or (r.get("run") or {}).get("id") or "")' "$RUNJSON" 2>/dev/null)"
    if [ -n "$POLL_RUN" ]; then
      touch "$WHANDLES" "$WSEEN"
      printf '\n## 자동 배정 (launch-worker.sh 가 채웠다 — 손으로 바꾸지 마라)\n- 네 아래 워커용 Run(이 터미널에 묶여 있다 — `check --run` 이 여기서 된다): `%s`\n- 워커 핸들 파일: `%s` · 본 메일: `%s`\n- 워커를 띄울 때: `launch-worker.sh <이름> <브리프> intern|junior|senior [--supervise] --run %s --repo %s --handles %s --parent %s`\n- 폴러: **네가 돌리지 않는다.** 이 워크트리의 POLLER 터미널이 돌며 사건이 생기면 이 터미널에 `[폴러 …]` 한 줄을 보낸다. 그때 메일박스와 `gh pr list` 를 보고 처리해라. 처리 뒤 프롬프트에서 멈춰도 된다.\n' \
        "$POLL_RUN" "$WHANDLES" "$WSEEN" "$POLL_RUN" "$REPO" "$WHANDLES" "$NAME" >> "$WT/TASK.md"
      echo "워커용 Run: $POLL_RUN ($NAME 터미널에 묶음)"
    else
      echo "⚠️ run-create 결과를 못 읽었다($RUNJSON) — 감독자가 직접 run-create 해야 한다. 폴러도 안 띄운다"; screen | tail -4
    fi
  else
    echo "⚠️ --handles 가 없어 코디 디렉터리를 모른다 — Run·POLLER 자동 배정을 건너뛴다"
  fi
fi
orca terminal send --terminal "$T" --text "$CMD" --enter >/dev/null
i=0; while [ $i -lt 30 ]; do screen | grep -q "$ALIVE\|Do you trust" && break; sleep 2; i=$((i+1)); done
# agy·codex 둘 다 첫 실행에 "Do you trust …" 를 묻는다(둘 다 1번이 Yes) — Enter.
if screen | grep -q "Do you trust"; then orca terminal send --terminal "$T" --text "" --enter >/dev/null; sleep 4; fi
i=0; while [ $i -lt 30 ]; do screen | grep -q "$ALIVE" && break; sleep 2; i=$((i+1)); done
screen | grep -q "$ALIVE" || { echo "🔴 에이전트 상태줄이 안 뜬다 — 마지막 화면:"; screen | tail -8; die "🔴 에이전트 상태줄이 안 뜬다"; }
orca terminal send --terminal "$T" --text "이 워크트리 루트의 TASK.md 를 읽고 그 일감을 수행해라. 파일 수정 허락은 TASK.md 공통 규칙에 있듯 이미 받았다 — 묻지 말고 진행해라. 보고는 TASK.md 마지막 줄의 orca 명령으로 한다." --enter >/dev/null
sleep 20
# 살아 있나 — 한 번 더. 첫 명령 뒤 죽어 셸로 돌아오는 경우를 여기서 잡는다.
if ! screen | grep -q "$ALIVE"; then echo "🔴 브리프를 보낸 뒤 에이전트가 사라졌다 — 마지막 화면:"; screen | tail -12; die "🔴 브리프를 보낸 뒤 에이전트가 사라졌다"; fi
orca terminal rename --terminal "$T" --title "$NAME" --json >/dev/null 2>&1   # 탭 제목 = 역할-조각 (사용자 결정 2026-09-13)
echo "✅ $NAME  $WT  $T  ($AGENT)"; screen | tail -3
[ -n "$HANDLES" ] && printf '%s:%s (%s)\n' "$NAME" "$T" "$AGENT" >> "$HANDLES"
# --- 감독 자리 전용: POLLER 터미널. 제목이 있어 정체가 분명하고, 죽으면 10초 뒤 스스로 다시 뜬다 ---
if [ "$SUPERVISE" = 1 ] && [ -n "$POLL_RUN" ]; then
  PT="$(orca terminal create --worktree "path:$WT" --title "poller-${NAME#*-}" --json 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["terminal"]["handle"])' 2>/dev/null)"
  if [ -n "$PT" ]; then
    orca terminal send --terminal "$PT" --text "while true; do python3 -u '$SKILL_DIR/poll.py' --run '$POLL_RUN' --handles '$WHANDLES' --seen '$WSEEN' --wake '$T' --loop --interval 30 --max-min 20; echo \"[폴러] 종료 rc=\$? — 10초 뒤 재시작\"; sleep 10; done" --enter >/dev/null
    sleep 3; echo "POLLER: $PT  $(orca terminal read --terminal "$PT" --screen 2>/dev/null | grep '\[폴러\]' | tail -1)"
    [ -n "$HANDLES" ] && printf '# %s-poller:%s (poller, 감시 대상 아님)\n' "$NAME" "$PT" >> "$HANDLES"
  else
    echo "⚠️ POLLER 터미널을 못 만들었다 — 부장에게 손으로 폴러를 돌리라고 해야 한다"
  fi
fi
notify "✅ 세움: 터미널 $T, 워크트리 $WT$( [ -n "$POLL_RUN" ] && printf ", Run %s, POLLER 가동" "$POLL_RUN" )"
