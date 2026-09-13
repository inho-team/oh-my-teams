#!/bin/sh
# 사원 파이프라인 — 대리(flash)가 잘라 둔 일감(task-01.md, task-02.md, …)을 **한 브랜치에서 순서대로** worker-run.sh(사원→대리 사다리)로 돌린다. (2026-09-13)
#   배치: 과장(pro) → 대리(flash, 분할·통합·어려운 로직) → 사원(gpt-oss, 하네스). 사원 일감마다 커밋 하나. 브랜치를 여러 개 만들지 않는다(병합 충돌을 대리에게 쌓지 않기 위해).
#
# 사용:  pipeline-run.sh <워크트리> <일감 디렉터리> [--branch <브랜치>] [--notify <대리 터미널>] [--models "gpt-oss-120b-medium:4,gemini-3.8-flash-high:2"] [--stop-on-fail|--continue]
#   일감 파일: intern-brief-template.md 형식. 「브랜치」 절은 무시하고 --branch(기본: 첫 일감의 브랜치 절)를 쓴다. 「PR 제목」「보고」 절은 파이프라인이 무시한다 — PR·보고는 대리가 통합 뒤에 한다.
#   결과: <일감 디렉터리>/PIPELINE.md 에 일감별 모델·시도수·결과 표. 끝나면 --notify 터미널에 한 줄.
set -u
WT="${1:-}"; DIR="${2:-}"; shift 2 2>/dev/null || { echo "사용: pipeline-run.sh <워크트리> <일감 디렉터리> [--branch B] [--notify T] [--models …] [--continue]"; exit 2; }
BR=""; NOTIFY=""; MODELS=""; CONT=0
while [ $# -gt 0 ]; do case "$1" in --branch) BR="$2"; shift 2;; --notify) NOTIFY="$2"; shift 2;; --models) MODELS="$2"; shift 2;; --continue) CONT=1; shift;; --stop-on-fail) CONT=0; shift;; *) shift;; esac; done
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -d "$DIR" ] || { echo "🔴 일감 디렉터리가 없다: $DIR"; exit 2; }
case "$(cd "$DIR" && pwd)/" in "$(cd "$WT" && pwd)/"*) echo "🔴 일감 디렉터리는 워크트리 밖에 둬라(예: ~/.<프로젝트>/coord/tasks-<조각>/) — 하네스의 git clean/add 에 휩쓸린다"; exit 2;; esac
TASKS="$(ls "$DIR"/task-*.md 2>/dev/null | sort)"; [ -n "$TASKS" ] || { echo "🔴 $DIR 에 task-NN.md 가 없다"; exit 2; }
notify() { [ -z "$NOTIFY" ] && return 0; orca terminal send --terminal "$NOTIFY" --text "[pipeline $(date '+%H:%M')] $1 — 표: $DIR/PIPELINE.md" --enter --json >/dev/null 2>&1; return 0; }
cd "$WT" || exit 2
[ -n "$BR" ] || BR="$(awk 'BEGIN{p=0} /^## /{p=($0=="## 브랜치")} p&&$0!="## 브랜치"&&NF{print; exit}' "$(printf '%s\n' "$TASKS" | head -1)" | tr -d '` ')"
[ -n "$BR" ] || BR="pipeline/$(basename "$WT")"
git fetch -q origin 2>/dev/null; git checkout -q -B "$BR" || { echo "🔴 브랜치 실패 $BR"; exit 1; }
REPORT="$DIR/PIPELINE.md"; { echo "# 사원 파이프라인 — $(basename "$WT") @ $BR ($(date '+%Y-%m-%d %H:%M'))"; echo; echo "| # | 일감 | 결과 | 모델 | 시도 | 커밋 |"; echo "|---|---|---|---|---|---|"; } > "$REPORT"
n=0; ok=0; fail=0; FAILED=""
for t in $TASKS; do
  n=$((n+1)); name="$(basename "$t" .md)"; title="$(head -1 "$t" | sed 's/^# //' | cut -c1-60)"
  # 일감 파일을 워크트리 밖 임시 사본으로(브랜치·PR·보고 절을 지운다 — 브랜치는 파이프라인 것, PR·보고는 대리가)
  TMP="/tmp/pipe-$(basename "$WT")-$name.md"
  awk 'BEGIN{skip=0} /^## /{skip=($0=="## PR 제목"||$0=="## 보고")} !skip{print}' "$t" > "$TMP"
  grep -q '^## 브랜치' "$TMP" || printf '\n## 브랜치\n`%s`\n' "$BR" >> "$TMP"
  # 브랜치 절의 값을 파이프라인 브랜치로 강제
  python3 - "$TMP" "$BR" <<'PY'
import sys,re; p,br=sys.argv[1],sys.argv[2]; s=open(p,encoding='utf-8').read()
s=re.sub(r'(## 브랜치\n)(`[^`]*`|[^\n]*)', lambda m: m.group(1)+'`'+br+'`', s, count=1); open(p,'w',encoding='utf-8').write(s)
PY
  echo "=== [$n/$(printf '%s\n' "$TASKS" | wc -l | tr -d ' ')] $name — $title"
  BEFORE="$(git rev-parse HEAD)"
  "$HERE/worker-run.sh" "$WT" "$TMP" ${MODELS:+--models "$MODELS"} > "/tmp/pipe-$(basename "$WT")-$name.log" 2>&1; rc=$?
  LOG="/tmp/intern-$(basename "$WT").log"
  model="$(grep -oE '하네스: [0-9]+ 회 시도 통과 — 모델 [^ ]+' "$LOG" 2>/dev/null | tail -1 | sed 's/.*모델 //')"; tries="$(grep -oE '하네스: [0-9]+ 회' "$LOG" 2>/dev/null | tail -1 | grep -oE '[0-9]+')"
  AFTER="$(git rev-parse HEAD)"
  if [ $rc -eq 0 ] && [ "$AFTER" != "$BEFORE" ]; then
    ok=$((ok+1)); echo "| $n | $name | ✅ | ${model:-?} | ${tries:-?} | $(git rev-parse --short HEAD) |" >> "$REPORT"; echo "   ✅ $model ${tries}회 → $(git rev-parse --short HEAD)"
  else
    fail=$((fail+1)); FAILED="$FAILED $name"; last="$(grep -E '^🔴 하네스' "$LOG" 2>/dev/null | tail -1 | cut -c1-80)"
    echo "| $n | $name | 🔴 | $(grep -oE '거친 모델:[^)]*' "$LOG" 2>/dev/null | tail -1) | - | - |" >> "$REPORT"; echo "   🔴 실패 — $last (로그 /tmp/intern-$(basename "$WT").log)"
    cp "$LOG" "/tmp/pipe-$(basename "$WT")-$name.fail.log" 2>/dev/null
    [ $CONT = 1 ] || { echo "   중단(--continue 면 다음 일감으로 넘어간다)"; break; }
  fi
done
{ echo; echo "합계: ✅ $ok · 🔴 $fail$( [ -n "$FAILED" ] && printf ' (%s)' "$FAILED" ) · 브랜치 $BR @ $(git rev-parse --short HEAD)"; echo "실패한 일감은 대리가 직접 한다(같은 브랜치, 일감 파일의 편집 지시·완료 조건 그대로). 그 뒤 통합: 전체 검사 → preflight → PR."; } >> "$REPORT"
cat "$REPORT" | tail -4
if [ $fail -eq 0 ]; then notify "✅ 사원 일감 $ok/$n 전부 통과 — 통합(전체 검사·preflight·PR)으로 넘어가라"; exit 0
else notify "🔴 사원 일감 $fail 개 실패($FAILED) — 대리가 직접 하고 통합해라"; exit 1; fi
