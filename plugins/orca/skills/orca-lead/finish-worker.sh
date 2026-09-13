#!/bin/sh
# orca-lead 워커 내리기 — 「머지 준비됨」 을 보내기 **직전에** 부장이 돌린다. (2026-09-12)
#
# 사용:  finish-worker.sh <이름> --handles <핸들파일> [--port <포트>]... [--environment <orca 환경>]
#   <이름> 은 launch-worker.sh 에 준 워크트리 이름(핸들 파일의 `<이름>:<term> (agent)` 줄).
#
# 하는 일: 마지막 화면 몇 줄을 남긴다 → 워커 터미널(=에이전트)을 닫는다 → 워커가 띄운 것이 남았는지 본다
#   (--port 로 준 포트의 리스너, 워크트리를 cwd 로 가진 프로세스) → 핸들 파일의 그 줄에 `done <시각>` 을 표기한다.
# 워크트리와 브랜치는 **남긴다** — 코드는 origin 에 있고, 회수는 이사가 머지 뒤에 한다(orca-top §1.4).
# 왜: 에이전트를 살려 두면 100~370MB 씩 잡고 유휴로 남는다(실측: 맥북에 5~14시간 유휴 agy 6개, swap 91%).
#     반려로 재작업이 필요하면 같은 워크트리에 새 에이전트를 띄운다(§3.0 마지막 줄과 같은 규칙) — 그게 더 싸다.
# 🔴 남은 리스너·프로세스는 **보고만** 한다. 내리는 것은 pid 를 보고 부장이 결정한다(운영 프로세스일 수도 있다).
set -u
NAME="${1:-}"; shift 2>/dev/null || true
HANDLES=""; ENV=""; PORTS=""
while [ $# -gt 0 ]; do case "$1" in --handles) HANDLES="$2"; shift 2;; --port) PORTS="$PORTS $2"; shift 2;; --environment) ENV="$2"; shift 2;; *) shift;; esac; done
[ -n "$NAME" ] && [ -n "$HANDLES" ] || { echo "사용: finish-worker.sh <이름> --handles <핸들파일> [--port <포트>]..."; exit 1; }
[ -f "$HANDLES" ] || { echo "🔴 핸들 파일이 없다: $HANDLES"; exit 1; }
LINE="$(grep -E "^$NAME:" "$HANDLES" | grep -v ' done ' | tail -1)"
[ -n "$LINE" ] || { echo "🔴 핸들 파일에 '$NAME:' 줄이 없거나 이미 done 이다"; grep -E "^$NAME:" "$HANDLES"; exit 1; }
T="$(printf '%s' "$LINE" | cut -d: -f2 | awk '{print $1}')"
if [ "$T" = "staff-run" ] || [ "$T" = "intern-run" ]; then   # 사원은 터미널이 없다 — 남은 프로세스만 정리하고 done 표기
  PID="$(printf '%s' "$LINE" | sed -n 's/.*pid \([0-9]*\).*/\1/p')"; [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && { kill "$PID"; echo "⚠️ worker-run.sh(pid $PID)가 아직 돌고 있어 내렸다"; } || echo "✅ 사원 프로세스 없음(이미 끝남)"
  python3 - "$HANDLES" "$NAME" "$(date '+%Y-%m-%d %H:%M')" <<'PY'
import sys; p, name, ts = sys.argv[1:4]
lines = open(p, encoding='utf-8').read().split('\n'); out=[]; done=False
for l in lines:
    if not done and l.startswith(name + ':') and ' done ' not in l: l = l + ' done ' + ts; done=True
    out.append(l)
open(p, 'w', encoding='utf-8').write('\n'.join(out))
PY
  exit 0
fi
ENVOPT=""; [ -n "$ENV" ] && ENVOPT="--environment $ENV"

# 1) 워크트리 경로와 마지막 화면 — 닫기 전에 남긴다(무엇을 하다 끝났는지 보고에 붙인다)
WT="$(orca terminal show $ENVOPT --terminal "$T" --json 2>/dev/null | python3 -c '
import sys,json
try: d=json.load(sys.stdin); t=(d.get("result") or {}).get("terminal") or d.get("result") or {}; print(t.get("worktreePath") or "")
except Exception: print("")')"
echo "=== $NAME  term=$T  worktree=${WT:-?}"
echo "--- 마지막 화면 ---"
orca terminal read $ENVOPT --terminal "$T" --screen --json 2>/dev/null | python3 -c '
import sys,json
try: rows=json.load(sys.stdin)["result"]["terminal"].get("tail") or []
except Exception: rows=[]
print("\n".join([r for r in rows if r.strip()][-6:]))'

# 2) 터미널을 닫는다 = 에이전트 종료. 실패하면 멈춘다(살아 있는데 done 표기하면 안 된다).
OUT="$(orca terminal close $ENVOPT --terminal "$T" --json 2>&1)"
printf '%s' "$OUT" | grep -q '"ok": true' || { echo "🔴 터미널 닫기 실패: $(printf '%s' "$OUT" | head -3)"; exit 1; }
echo "✅ 에이전트 터미널을 닫았다"

# 3.2) 부장 이면 POLLER 터미널도 닫는다(핸들 파일의 `# <이름>-poller:<term>` 줄) — 실측: 부장만 닫으면 POLLER 가 워크트리 cwd 로 남아 🔴 로 잡힌다
PT="$(grep -E "^# $NAME-poller:" "$HANDLES" | tail -1 | cut -d: -f2 | awk '{print $1}')"
# 핸들 파일에 없으면(실측: 기록이 다른 파일로 간 적이 있다) 워크트리의 POLLER 제목 터미널을 직접 찾는다
if [ -z "$PT" ] && [ -n "$WT" ]; then
  PT="$(orca terminal list $ENVOPT --worktree "path:$WT" --json 2>/dev/null | python3 -c '
import sys,json
try: ts=(json.load(sys.stdin).get("result") or {}).get("terminals") or []
except Exception: ts=[]
print(" ".join(t["handle"] for t in ts if (t.get("title") or "")=="POLLER" or (t.get("title") or "").startswith("poller-")))')"
fi
for h in $PT; do orca terminal close $ENVOPT --terminal "$h" --json 2>&1 | grep -q '"ok": true' && echo "✅ POLLER 터미널도 닫았다($h)" || echo "⚠️ POLLER 터미널 닫기 실패($h) — 손으로 닫아라"; done
# 3) 남긴 것 — 포트 리스너, 워크트리를 cwd 로 가진 프로세스(워커가 띄운 dev 서버가 세 번 남았다)
LEFT=0
for p in $PORTS; do
  PIDS="$(lsof -nP -ti:"$p" -sTCP:LISTEN 2>/dev/null | tr '\n' ' ')"
  if [ -n "$PIDS" ]; then LEFT=1; echo "🔴 포트 $p 에 리스너가 남아 있다: pid $PIDS — $(ps -o comm= -p ${PIDS%% *} 2>/dev/null). 워커가 띄운 것이면 kill <pid>"; fi
done
if [ -n "$WT" ]; then
  ORPHANS="$(lsof -nP -d cwd -Fpn 2>/dev/null | awk -v wt="$WT" '/^p/{pid=substr($0,2)} /^n/ {n=substr($0,2); if (n==wt || index(n, wt "/")==1) print pid}' | sort -u | tr '\n' ' ')"
  if [ -n "$ORPHANS" ]; then LEFT=1; echo "🔴 워크트리를 cwd 로 가진 프로세스가 남아 있다: pid $ORPHANS"; for pid in $ORPHANS; do echo "   $pid $(ps -o etime=,comm= -p $pid 2>/dev/null)"; done; fi
fi
[ $LEFT -eq 0 ] && echo "남긴 것 없음(포트: ${PORTS:-미지정})"

# 3.5) 워커 스택 내리기(2026-09-13): launch-worker.sh 가 stack-<이름>.env 를 남겼으면 프로젝트 훅으로 down
STACK_ENV="$(cd "$(dirname "$HANDLES")" && pwd)/stack-$NAME.env"
if [ -f "$STACK_ENV" ]; then
  SREPO="$(awk -F= '/^STACK_REPO=/{print $2}' "$STACK_ENV")"
  if [ -x "$SREPO/.orca/worker-stack.sh" ]; then
    "$SREPO/.orca/worker-stack.sh" down "$NAME" 2>/dev/null | grep -q STACK_DOWN && echo "✅ 워커 스택 내림($(awk -F= '/^STACK_PROJECT=/{print $2}' "$STACK_ENV"))" || { LEFT=1; echo "🔴 워커 스택 down 실패 — 손으로: $SREPO/.orca/worker-stack.sh down $NAME"; }
    mv "$STACK_ENV" "$STACK_ENV.done" 2>/dev/null
  fi
fi
# 4) 핸들 파일에 done 표기(줄을 지우지 않는다 — 폴러가 done 줄은 건너뛴다)
python3 - "$HANDLES" "$NAME" "$(date '+%Y-%m-%d %H:%M')" <<'PY'
import sys; p, name, ts = sys.argv[1:4]
lines = open(p, encoding='utf-8').read().split('\n'); out = []; done = False
for l in lines:
    if not done and l.startswith(name + ':') and ' done ' not in l: l = l + ' done ' + ts; done = True
    out.append(l)
open(p, 'w', encoding='utf-8').write('\n'.join(out))
PY
echo "핸들 파일 갱신: $(grep -E "^$NAME:" "$HANDLES" | tail -1)"
exit $LEFT
