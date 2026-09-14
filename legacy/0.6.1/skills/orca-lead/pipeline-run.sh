#!/bin/sh
# 사원 파이프라인 — 대리(flash)가 잘라 둔 일감(task-01.md, task-02.md, …)을 **한 브랜치에서 순서대로** worker-run.sh(사원→대리 사다리)로 돌린다. (2026-09-13)
#   배치: 과장(pro) → 대리(flash, 분할·통합·어려운 로직) → 사원(gpt-oss, 하네스). 사원 일감마다 커밋 하나. 브랜치를 여러 개 만들지 않는다(병합 충돌을 대리에게 쌓지 않기 위해).
#
# 사용:  pipeline-run.sh <워크트리> <일감 디렉터리> [--branch <브랜치>] [--notify <대리 터미널>] [--models "gpt-oss-120b-medium:5,gemini-3.8-flash-high:2"] [--stop-on-fail|--continue]
#   일감 파일: staff-brief-template.md 형식. 「브랜치」 절은 무시하고 --branch(기본: 첫 일감의 브랜치 절)를 쓴다. 「PR 제목」「보고」 절은 파이프라인이 무시한다 — PR·보고는 대리가 통합 뒤에 한다.
#   병렬(2026-09-13 사용자 결정): 같은 번호에 글자를 붙인 일감(task-02a.md, task-02b.md)은 **한 묶음으로 병렬** 실행한다 — 대리가 "파일이 겹치지 않는다" 고 판단한 것만.
#     스크립트가 묶음마다 임시 작업 공간(git worktree, 대리 브랜치 tip 기준)을 만들어 동시에 돌리고, 끝나면 커밋을 **대리 브랜치에 순서대로 cherry-pick** 한 뒤 임시 공간을 지운다.
#     cherry-pick 이 충돌하면 그 일감의 임시 브랜치(pipe/<일감>)를 남기고 🔴 로 기록한다 — 대리가 `git cherry-pick <sha>` 로 직접 병합한다(커밋은 git 에 다 있다). 번호가 다른 일감은 순차.
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
n=0; ok=0; fail=0; FAILED=""; TOTALN="$(printf '%s\n' "$TASKS" | wc -l | tr -d ' ')"
prep() {  # 일감 파일 → 임시 사본(PR·보고 절 제거, 브랜치 강제). $1=일감 $2=브랜치 → 경로 출력
  TMP="/tmp/pipe-$(basename "$WT")-$(basename "$1" .md).md"
  awk 'BEGIN{skip=0} /^## /{skip=($0=="## PR 제목"||$0=="## 보고")} !skip{print}' "$1" > "$TMP"
  grep -q '^## 브랜치' "$TMP" || printf '\n## 브랜치\n`%s`\n' "$2" >> "$TMP"
  python3 - "$TMP" "$2" <<'PY'
import sys,re; p,br=sys.argv[1],sys.argv[2]; s=open(p,encoding='utf-8').read()
s=re.sub(r'(## 브랜치\n)(`[^`]*`|[^\n]*)', lambda m: m.group(1)+'`'+br+'`', s, count=1); open(p,'w',encoding='utf-8').write(s)
PY
  printf '%s' "$TMP"
}
record_ok() { ok=$((ok+1)); echo "| $n | $1 | ✅ | ${2:-?} | ${3:-?} | $4 |" >> "$REPORT"; echo "   ✅ $1: ${2:-?} ${3:-?}회 → $4"; }
record_fail() { fail=$((fail+1)); FAILED="$FAILED $1"; echo "| $n | $1 | 🔴 | $2 | - | $3 |" >> "$REPORT"; echo "   🔴 $1: $2 $3"; }
stats() { model="$(grep -oE '하네스: [0-9]+ 회 시도 통과 — 모델 [^ ]+' "$1" 2>/dev/null | tail -1 | sed 's/.*모델 //')"; tries="$(grep -oE '하네스: [0-9]+ 회' "$1" 2>/dev/null | tail -1 | grep -oE '[0-9]+')"; }
WAVES="$(printf '%s\n' "$TASKS" | sed -E 's|.*/task-([0-9]+)[a-z]?\.md|\1|' | sort -u)"
for wave in $WAVES; do
  GROUP="$(printf '%s\n' "$TASKS" | grep -E "/task-${wave}[a-z]?\.md$")"; cnt="$(printf '%s\n' "$GROUP" | wc -l | tr -d ' ')"
  if [ "$cnt" -eq 1 ]; then
    t="$GROUP"; n=$((n+1)); name="$(basename "$t" .md)"; echo "=== [$n/$TOTALN] $name (순차) — $(head -1 "$t" | sed 's/^# //' | cut -c1-60)"
    TMP="$(prep "$t" "$BR")"; BEFORE="$(git rev-parse HEAD)"
    "$HERE/worker-run.sh" "$WT" "$TMP" ${MODELS:+--models "$MODELS"} > "/tmp/pipe-$(basename "$WT")-$name.log" 2>&1; rc=$?
    LOG="/tmp/staff-$(basename "$WT").log"; stats "$LOG"; cp "$LOG" "/tmp/pipe-$(basename "$WT")-$name.harness.log" 2>/dev/null
    if [ $rc -eq 0 ] && [ "$(git rev-parse HEAD)" != "$BEFORE" ]; then record_ok "$name" "$model" "$tries" "$(git rev-parse --short HEAD)"
    else record_fail "$name" "$(grep -oE '거친 모델:[^)]*' "$LOG" 2>/dev/null | tail -1)" "(로그 /tmp/pipe-$(basename "$WT")-$name.harness.log)"; [ $CONT = 1 ] || { echo "   중단(--continue 면 계속)"; break; }; fi
  else
    echo "=== 묶음 $wave: $cnt 개 병렬 — $(printf '%s\n' "$GROUP" | xargs -n1 basename | sed 's/\.md$//' | tr '\n' ' ')"
    TIP="$(git rev-parse HEAD)"; PIDS=""; NAMES=""
    for t in $GROUP; do
      name="$(basename "$t" .md)"; PW="/tmp/pipe-$(basename "$WT")-$name.wt"; PB="pipe/$name"
      rm -rf "$PW"; git worktree prune; git branch -D "$PB" >/dev/null 2>&1
      git worktree add -q --detach "$PW" "$TIP" || { record_fail "$name" "임시 작업 공간 실패" ""; continue; }
      TMP="$(prep "$t" "$PB")"
      ( "$HERE/worker-run.sh" "$PW" "$TMP" ${MODELS:+--models "$MODELS"} > "/tmp/pipe-$(basename "$WT")-$name.log" 2>&1; echo $? > "/tmp/pipe-$(basename "$WT")-$name.rc" ) &
      PIDS="$PIDS $!"; NAMES="$NAMES $name"
    done
    wait $PIDS
    for name in $NAMES; do
      n=$((n+1)); PW="/tmp/pipe-$(basename "$WT")-$name.wt"; PB="pipe/$name"; rc="$(cat "/tmp/pipe-$(basename "$WT")-$name.rc" 2>/dev/null || echo 1)"
      LOG="/tmp/staff-$(basename "$PW").log"; stats "$LOG"; cp "$LOG" "/tmp/pipe-$(basename "$WT")-$name.harness.log" 2>/dev/null
      SHA="$(git -C "$PW" rev-parse HEAD 2>/dev/null)"
      if [ "$rc" = 0 ] && [ -n "$SHA" ] && [ "$SHA" != "$TIP" ]; then
        if git cherry-pick "$SHA" >/dev/null 2>&1; then
          record_ok "$name" "$model" "$tries" "$(git rev-parse --short HEAD)"; git worktree remove --force "$PW" 2>/dev/null; git branch -D "$PB" >/dev/null 2>&1
        else
          git cherry-pick --abort 2>/dev/null; git worktree remove --force "$PW" 2>/dev/null
          record_fail "$name" "cherry-pick 충돌 — 커밋은 브랜치 $PB($(git rev-parse --short "$SHA"))에 있다. 대리가 git cherry-pick $(git rev-parse --short "$SHA") 로 직접 병합" ""
        fi
      else
        git worktree remove --force "$PW" 2>/dev/null; git branch -D "$PB" >/dev/null 2>&1
        record_fail "$name" "$(grep -oE '거친 모델:[^)]*' "$LOG" 2>/dev/null | tail -1)" "(로그 /tmp/pipe-$(basename "$WT")-$name.harness.log)"
      fi
    done
    git worktree prune
    [ $fail -eq 0 ] || [ $CONT = 1 ] || { echo "   중단(--continue 면 계속)"; break; }
  fi
done
{ echo; echo "합계: ✅ $ok · 🔴 $fail$( [ -n "$FAILED" ] && printf ' (%s)' "$FAILED" ) · 브랜치 $BR @ $(git rev-parse --short HEAD)"; echo "실패한 일감은 대리가 직접 한다(같은 브랜치, 일감 파일의 편집 지시·완료 조건 그대로). 그 뒤 통합: 전체 검사 → preflight → PR."; } >> "$REPORT"
cat "$REPORT" | tail -4
if [ $fail -eq 0 ]; then notify "✅ 사원 일감 $ok/$n 전부 통과 — 통합(전체 검사·preflight·PR)으로 넘어가라"; exit 0
else notify "🔴 사원 일감 $fail 개 실패($FAILED) — 대리가 직접 하고 통합해라"; exit 1; fi
