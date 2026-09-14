#!/bin/sh
# 하네스 워커 실행기(사원→대리 승격 사다리) — 모델에게는 "편집" 하나만 시키고, 브랜치·검증·재시도·승격·커밋·PR·보고는 이 스크립트가 한다. (2026-09-13)
#   사용자 배치: 사원 = gpt-oss-120b(기본 구현·문서), 대리 = gemini flash(승격·탐색이 필요한 구현), 과장 = gemini pro(운영·검토, 코드 안 씀).
#   실측: gpt-oss 가 문서 2건(2~3회), Kotlin 가드 테스트 1건(4회, 컴파일 오류를 25줄 되돌려 주니 고침)을 통과했다. 그래서 기본 구현 자리를 사원에게 준다.
#
# 사용:  worker-run.sh <워크트리> <브리프.md> [--run <RUN_ID>] [--notify <터미널>] [--models "gpt-oss-120b-medium:5,gemini-3.8-flash-high:2"] [--no-review] [--reviewer-model gpt-oss-120b-medium]
#   검수 사원(2026-09-14 사용자 결정, 2인 1조): 작업 사원이 완료 조건을 통과하면 **검수 사원(gpt-oss)** 이 편집 지시·diff 를 보고
#   "추가로 깨질 지점" 을 **실행 가능한 형태로만**(셸 검사 ≤4, 변이 ≤2) 낸다. 스크립트가 돌려 실패하면 그 출력으로 작업 사원에게 반려(일감당 1회),
#   반려 사유는 **검사 실패**뿐. 변이 뒤에도 초록이면 ⚠️ 로 기록만(실측: gpt-oss 검수자의 변이는 헛변이가 많아 반려 사유로 쓰면 오반려). 검수자의 검사가 실행 불가(exit 127/2, 백틱 등)면 검수자 오류로 기록만. 의견은 받지 않는다 — 출력만 증거.
#   --models  모델:시도수 를 쉼표로. 앞에서부터 쓰고, 시도를 다 쓰면 다음 모델로 **승격**한다(같은 브리프·같은 실패 출력을 이어 준다). 기본은 사원(gpt-oss) 5회 → 대리급 승격(flash, 하네스 안) 2회(2026-09-14 사용자 결정: 5회 실패면 대리가 들어간다). 그래도 실패면 PIPELINE 🔴 → 대리 세션이 직접.
#   (구 worker-run.sh. --max-tries N 은 첫 모델의 시도수로 취급한다)
#   브리프(staff-brief-template.md)의 절을 읽는다:
#     ## 편집 지시      — 모델에게 주는 문장(파일·위치·전/후 텍스트). 자유 서술.
#     ## 완료 조건      — 셸 명령 한 줄씩. **모두 exit 0** 이어야 통과. 순서·형식까지 잡히게 쓴다(예: grep -A1 'Beta' f | grep -q Gamma).
#     ## 브랜치 / ## 커밋 메시지 / ## PR 제목  — 스크립트가 쓴다.
#     ## 보고           — 통과 뒤 실행할 명령 한 줄(보통 orca orchestration send …). 실패면 스크립트가 "사원 실패 → 승격" 을 같은 주소로 보낸다.
#
# 왜 이렇게 하나(실측 2026-09-13, 실험실 3회): gpt-oss 는 (1) agy 편집 도구를 부를 때 필수 인자를 빠뜨려 편집이 실패하고
#   (2) 셸 편집은 하지만 순서·빈 줄을 틀리며 (3) 커밋·보고를 안 하고도 "완료" 라고 쓴다. 그래서 편집만 맡기고 나머지는 결정적으로 돌린다.
#   실패 출력을 붙여 다시 시키면 고치는지는 이 스크립트의 재시도 루프가 잰다.
# ⚠️ agy -p 는 --add-dir 없이는 cwd 를 워크스페이스로 잡지 않고 홈을 뒤진다(실측: 남의 TASK.md.bak 을 편집하려 했다). 반드시 --add-dir.
set -u
WT="${1:-}"; BRIEF="${2:-}"; shift 2 2>/dev/null || { echo "사용: worker-run.sh <워크트리> <브리프.md> [--run R] [--notify T] [--max-tries N]"; exit 2; }
RUN_ID=""; NOTIFY=""; MAX=""; MODELS="gpt-oss-120b-medium:5,gemini-3.8-flash-high:2"; REVIEW=1; REVIEWER="gpt-oss-120b-medium"
while [ $# -gt 0 ]; do case "$1" in --run) RUN_ID="$2"; shift 2;; --notify) NOTIFY="$2"; shift 2;; --max-tries) MAX="$2"; shift 2;; --models) MODELS="$2"; shift 2;; --model) MODELS="$2:${MAX:-3}"; shift 2;; --no-review) REVIEW=0; shift;; --reviewer-model) REVIEWER="$2"; shift 2;; *) shift;; esac; done
[ -n "$MAX" ] && MODELS="$(printf '%s' "$MODELS" | sed "s/^\([^:,]*\):[0-9]*/\1:$MAX/")"
# 사다리 펼치기: "m1:4,m2:2" → 시도 순서 목록(m1 m1 m1 m1 m2 m2)
LADDER=""; OLDIFS="$IFS"; IFS=','; for spec in $MODELS; do m="${spec%%:*}"; n="${spec#*:}"; [ "$n" = "$spec" ] && n=3; i=0; while [ $i -lt "$n" ]; do LADDER="$LADDER $m"; i=$((i+1)); done; done; IFS="$OLDIFS"
TOTAL=$(printf '%s' "$LADDER" | wc -w | tr -d ' ')
[ -d "$WT/.git" ] || git -C "$WT" rev-parse --git-dir >/dev/null 2>&1 || { echo "🔴 워크트리가 아니다: $WT"; exit 2; }
[ -f "$BRIEF" ] || { echo "🔴 브리프가 없다: $BRIEF"; exit 2; }
NAME="$(basename "$WT")"; LOG="/tmp/staff-$NAME.log"; : > "$LOG"
section() { awk -v h="## $1" 'BEGIN{p=0} /^## /{p=($0==h)} p&&$0!=h{print}' "$BRIEF" | sed '/^[[:space:]]*$/d;/^<!--/d'; }
EDIT="$(awk -v h="## 편집 지시" 'BEGIN{p=0} /^## /{p=($0==h)} p&&$0!=h{print}' "$BRIEF")"
CONDS="$(section "완료 조건" | sed 's/^- //; s/^`//; s/`$//')"
BR="$(section "브랜치" | head -1 | tr -d '` ')"; MSG="$(section "커밋 메시지" | head -1 | sed 's/^`//; s/`$//')"; TITLE="$(section "PR 제목" | head -1 | sed 's/^`//; s/`$//')"
REPORT="$(section "보고" | head -1 | sed 's/^`//; s/`$//')"
[ -n "$EDIT" ] && [ -n "$CONDS" ] && [ -n "$BR" ] && [ -n "$MSG" ] || { echo "🔴 브리프에 편집 지시/완료 조건/브랜치/커밋 메시지 절이 다 있어야 한다"; exit 2; }
notify() { [ -z "$NOTIFY" ] && return 0; orca terminal send --terminal "$NOTIFY" --text "[intern $(date '+%H:%M')] $NAME $1 — 로그: $LOG" --enter --json >/dev/null 2>&1; return 0; }
report() { [ -z "$REPORT" ] && return 0; ( cd "$WT" && sh -c "$REPORT" ) >>"$LOG" 2>&1; }

cd "$WT" || exit 2
git fetch -q origin 2>/dev/null; git checkout -q -B "$BR" 2>>"$LOG" || { echo "🔴 브랜치 생성 실패 $BR"; exit 1; }
BASE="$(git rev-parse HEAD)"
check() {  # 완료 조건 전부 실행. 실패한 것을 $FAILS 에 모은다
  FAILS=""; n=0
  OLDIFS="$IFS"; IFS='
'
  for c in $CONDS; do
    n=$((n+1)); out="$(sh -c "$c" 2>&1)"; rc=$?
    if [ $rc -ne 0 ]; then FAILS="$FAILS
[$n] $c
   → exit=$rc
$(printf '%s' "$out" | head -25)"; fi
  done; IFS="$OLDIFS"
  [ -z "$FAILS" ]
}
run_agy() {  # $1=모델 $2=프롬프트 $3=출력파일
  if [ -n "${STAFF_SANDBOX_PROFILE:-}" ]; then sandbox-exec -p "$STAFF_SANDBOX_PROFILE" agy --model "$1" --dangerously-skip-permissions --add-dir "$WT" --print-timeout 4m -p "$2" >"$3" 2>&1
  else agy --model "$1" --dangerously-skip-permissions --add-dir "$WT" --print-timeout 4m -p "$2" >"$3" 2>&1; fi
}
REVIEW_REJECTS=0; REVIEW_SUMMARY=""
review() {  # 검수 사원. 작업트리는 임시 커밋 상태. 반려면 RFAILS 에 출력을 모으고 1 을 돌려준다.
  RFAILS=""; ROUT="/tmp/staff-$NAME-review$try.out"; RJSON="/tmp/staff-$NAME-review$try.json"
  DIFF="$(git diff HEAD~1 --stat | tail -1; git diff HEAD~1 | head -300)"
  RPROMPT="너는 검수 사원이다. 아래 편집 지시대로 동료가 고친 결과(diff)를 검수한다. **의견을 쓰지 마라** — 실행해서 참/거짓이 갈리는 것만 낸다. 워크스페이스 $WT 에서 run_command 로 cat/grep 만 써서 확인해도 된다(파일을 고치지 마라, git 명령 금지).
답은 JSON 하나만: {\"checks\":[{\"cmd\":\"<워크스페이스 루트에서 실행할 셸 한 줄. 결과가 올바르면 exit 0, 아니면 0 이 아닌 값>\",\"why\":\"<무엇을 잡는지 한 문장>\"}], \"mutations\":[{\"cmd\":\"<파일 한 곳을 깨뜨리는 sed -i '' 또는 perl -pi 한 줄>\",\"red_cmd\":\"<그 뒤 실패해야 하는 검사/테스트 명령>\",\"why\":\"<어떤 성질을 지키는지>\"}]}
규칙: checks 는 최대 4개 — 편집 지시의 위치·순서·빈 줄·형식·컴파일처럼 **편집 지시에서 요구했으나 아래 완료 조건이 안 잡는 것**만(「빈 줄 하나」는 앞뒤 줄이 모두 비어 있지 않은지까지). cmd 안에 백틱(\`)을 쓰지 마라(셸이 실행해 버린다) — 문자열 비교는 grep -F 로. mutations 는 최대 2개, 가드/테스트가 이 일감에 있을 때만(없으면 빈 배열) — 변이는 **가드가 지키는 성질을 깨뜨리는** 변경이어야 하고, red_cmd 는 그 가드 명령이다(조건을 만족시키는 변경은 변이가 아니다). 실행 안 되는 명령을 내면 네 오류로 기록된다.

## 편집 지시
$EDIT

## 이미 통과한 완료 조건(중복하지 마라)
$CONDS

## diff
$DIFF"
  run_agy "$REVIEWER" "$RPROMPT" "$ROUT"
  grep -q "RESOURCE_EXHAUSTED" "$ROUT" && { echo "⛔ 검수 사원 429 — 검수 생략" | tee -a "$LOG"; return 0; }
  python3 - "$ROUT" "$RJSON" <<'PY'
import sys,json,re
txt=open(sys.argv[1],encoding='utf-8',errors='replace').read(); dec=json.JSONDecoder(); obj=None
for m in re.finditer(r"\{", txt):
    try:
        o,_=dec.raw_decode(txt[m.start():])
        if isinstance(o,dict) and ('checks' in o or 'mutations' in o): obj=o; break
    except Exception: continue
json.dump(obj or {"checks":[],"mutations":[]}, open(sys.argv[2],'w'), ensure_ascii=False)
PY
  NCHK="$(python3 -c "import json;print(len(json.load(open('$RJSON')).get('checks') or []))")"; NMUT="$(python3 -c "import json;print(len(json.load(open('$RJSON')).get('mutations') or []))")"
  echo "🔎 검수 사원: 검사 $NCHK · 변이 $NMUT" | tee -a "$LOG"
  fails=0; bad=0; i=0
  while [ $i -lt "$NCHK" ]; do
    c="$(python3 -c "import json;print((json.load(open('$RJSON'))['checks'][$i].get('cmd') or ''))")"; w="$(python3 -c "import json;print((json.load(open('$RJSON'))['checks'][$i].get('why') or ''))")"
    out="$(sh -c "$c" 2>&1)"; rc=$?
    if [ $rc -eq 0 ]; then echo "   ✅ 검사: $w" | tee -a "$LOG"
    elif [ $rc -eq 127 ] || [ $rc -eq 2 ] || printf '%s' "$out" | grep -qiE "command not found|syntax error|unexpected token"; then bad=$((bad+1)); echo "   ⚠️ 검수자 오류(실행 불가, exit $rc): $c" | tee -a "$LOG"
    else fails=$((fails+1)); RFAILS="$RFAILS
[검수] $w
   $c
   → exit=$rc $(printf '%s' "$out" | head -5)"; echo "   🔴 검사 실패: $w — $c (exit $rc)" | tee -a "$LOG"; fi
    i=$((i+1))
  done
  i=0; green=0; TIPC="$(git rev-parse HEAD)"
  while [ $i -lt "$NMUT" ]; do
    m="$(python3 -c "import json;print((json.load(open('$RJSON'))['mutations'][$i].get('cmd') or ''))")"; r="$(python3 -c "import json;print((json.load(open('$RJSON'))['mutations'][$i].get('red_cmd') or ''))")"; w="$(python3 -c "import json;print((json.load(open('$RJSON'))['mutations'][$i].get('why') or ''))")"
    if [ -z "$m" ] || [ -z "$r" ]; then i=$((i+1)); continue; fi
    if ! sh -c "$m" >/dev/null 2>&1; then bad=$((bad+1)); echo "   ⚠️ 검수자 오류(변이 적용 실패): $m" | tee -a "$LOG"; git checkout -q -- .; git clean -qfd -e TASK.md; i=$((i+1)); continue; fi
    out="$(perl -e 'alarm 300; exec @ARGV' sh -c "set -o pipefail 2>/dev/null; $r" 2>&1)"; rc=$?
    git checkout -q -- .; git clean -qfd -e TASK.md
    if [ $rc -eq 0 ]; then green=$((green+1)); echo "   ⚠️ 변이 초록(반려 사유 아님 — 대리가 본다): $w · 변이: $m · 검사: $r" | tee -a "$LOG"
    else echo "   ✅ 변이 빨강(exit $rc): $w" | tee -a "$LOG"; fi
    i=$((i+1))
  done
  REVIEW_SUMMARY="검수 검사 $NCHK(실패 $fails, 검수자 오류 $bad) 변이 $NMUT(초록 $green)"
  [ $fails -eq 0 ]
}
try=1; PREV=""; LASTMODEL=""; USED_MODELS=""; EXHAUSTED=""
for MODEL in $LADDER; do
  case "$EXHAUSTED" in *" $MODEL "*) continue;; esac   # 429 로 소진된 모델은 건너뛴다
  [ "$MODEL" != "$LASTMODEL" ] && { [ -n "$LASTMODEL" ] && echo "⬆️ 승격: $LASTMODEL → $MODEL (같은 브리프·실패 출력을 이어 준다)" | tee -a "$LOG"; USED_MODELS="$USED_MODELS $MODEL"; }
  LASTMODEL="$MODEL"
  echo "=== 시도 $try/$TOTAL [$MODEL] ($(date '+%H:%M:%S'))" | tee -a "$LOG"
  PROMPT="워크스페이스 $WT 에서 아래 편집을 지금 바로 수행해라. 계획을 제안하거나 묻지 마라. 편집이 끝나면 아무 말 없이 멈춰라 — 커밋·보고는 다른 프로그램이 한다.
규칙: 파일 편집은 반드시 run_command 로 python3 스크립트(heredoc) 를 써서 한다(줄 단위 삽입 위치와 빈 줄을 정확히 맞춰라). replace_file_content·write_to_file 편집 도구는 쓰지 마라(인자 오류가 난다). git 명령(checkout/commit/push)은 실행하지 마라.
편집 대상 파일 외에는 아무것도 만들거나 고치지 마라. **검증(gradle·go test·npm·pytest 등)은 네가 돌리지 마라 — 이 프로그램이 돌리고 실패 출력을 되돌려 준다.** 편집을 마치면 즉시 멈춰라(실측: flash 가 스스로 gradle 을 돌리다 6분 타임아웃).

## 편집 지시
$EDIT
$( [ -n "$PREV" ] && printf '\n## 직전 시도의 검증 실패(이것을 고쳐라 — 파일의 현재 상태를 먼저 cat 으로 확인하라. 편집 지시의 텍스트가 이미 파일에 있으면 **다시 넣지 말고** 틀린 부분만 고쳐라 — 중복 삽입은 실패다)\n%s\n' "$PREV" )"
  TRYOUT="/tmp/staff-$NAME-try$try.out"
  waits=0
  while :; do
    run_agy "$MODEL" "$PROMPT" "$TRYOUT"
    # 서버 용량 없음(503 UNAVAILABLE)은 모델 잘못이 아니다 — 시도를 소모하지 않고 45초 기다렸다 다시(최대 3회). 실측 2026-09-14: gpt-oss 7회 중 2회가 503 으로 날아갔다
    if grep -q "UNAVAILABLE (code 503)\|No capacity available\|high traffic" "$TRYOUT" && [ $waits -lt 3 ]; then waits=$((waits+1)); echo "⏳ $MODEL 503(용량 없음) — 45초 뒤 같은 시도 재실행($waits/3)" | tee -a "$LOG"; sleep 45; continue; fi
    break
  done
  cat "$TRYOUT" >>"$LOG"
  # 할당량 소진 감지(실측 2026-09-13: flash 가 RESOURCE_EXHAUSTED 429 를 6분 재시도만 하다 끝났다) — 그 모델의 남은 시도를 건너뛴다
  if grep -q "RESOURCE_EXHAUSTED" "$TRYOUT"; then
    echo "⛔ $MODEL 할당량 소진(429) — 이 모델의 남은 시도를 건너뛴다" | tee -a "$LOG"; EXHAUSTED="$EXHAUSTED $MODEL "; notify "⛔ $MODEL 429 소진"
    try=$((try+1)); continue
  fi
  if check; then
    echo "✅ 완료 조건 전부 통과 (시도 $try)" | tee -a "$LOG"
    # 작업 파일·가드: 브리프/로그는 커밋에 넣지 않는다(워크트리 exclude 가 TASK.md 를 막지만 이름이 다를 수 있어 한 번 더)
    git add -A ':!TASK.md' ':!*.log' 2>/dev/null || git add -A
    git reset -q -- TASK.md 2>/dev/null
    if git diff --cached --quiet; then echo "🔴 변경이 없다(모델이 아무것도 안 고쳤는데 조건이 통과?) — 조건이 약하다" | tee -a "$LOG"; notify "🔴 변경 없음"; exit 1; fi
    git commit -q -m "$MSG"
    # 검수 사원(2인 1조): 임시 커밋 상태에서 실행 가능한 검사·변이만 받아 돌린다. 반려는 일감당 1회 — 두 번째 실패는 ⚠️ 로 남기고 통과시킨다(검수자도 gpt-oss 라 무한 반려를 막는다)
    if [ "$REVIEW" = 1 ] && [ "$try" -le "$TOTAL" ]; then
      if ! review; then
        if [ $REVIEW_REJECTS -lt 1 ]; then
          REVIEW_REJECTS=$((REVIEW_REJECTS+1)); echo "↩️ 검수 반려 → 작업 사원 재시도 ($REVIEW_SUMMARY)" | tee -a "$LOG"
          git reset -q --soft HEAD~1; git reset -q; PREV="$RFAILS"; try=$((try+1)); continue
        else echo "⚠️ 검수 두 번째 실패 — 반려하지 않고 ⚠️ 로 남긴다 ($REVIEW_SUMMARY)" | tee -a "$LOG"; fi
      fi
    fi
    echo "커밋 $(git rev-parse --short HEAD): $(git diff --stat "$BASE" | tail -1)$( [ -n "$REVIEW_SUMMARY" ] && printf ' · %s' "$REVIEW_SUMMARY" )" | tee -a "$LOG"
    if git remote get-url origin >/dev/null 2>&1 && [ -n "$TITLE" ]; then
      git push -q -u origin "$BR" 2>>"$LOG" && gh pr create --base main --head "$BR" --title "$TITLE" --body "$(printf '## 한 것(하네스 %s, %d회 시도)\n%s\n\n## 완료 조건(전부 exit 0)\n%s\n' "$MODEL" "$try" "$(printf '%s' "$EDIT" | head -20)" "$CONDS")" >>"$LOG" 2>&1 && PRN="$(gh pr view --json number -q .number 2>/dev/null)" && echo "PR #$PRN" | tee -a "$LOG"
    fi
    report; notify "✅ 통과(시도 $try, $MODEL)$( [ -n "${PRN:-}" ] && printf ' PR #%s' "$PRN" )"; echo "하네스: $try 회 시도 통과 — 모델 $MODEL (거친 모델:$USED_MODELS)$( [ -n "$REVIEW_SUMMARY" ] && printf ' · %s' "$REVIEW_SUMMARY" )" | tee -a "$LOG"; exit 0
  fi
  echo "🔴 시도 $try 실패:$FAILS" | tee -a "$LOG"
  PREV="$FAILS"; try=$((try+1))
done
echo "🔴 하네스 $TOTAL 회 실패(거친 모델:$USED_MODELS) → 과장에게 올려라. 마지막 실패:$FAILS" | tee -a "$LOG"
{ echo "--- 마지막 시도의 diff(새 파일 포함) ---"; git add -A -N . 2>/dev/null; git diff; git status --short; } >>"$LOG" 2>&1
git checkout -q -- . 2>/dev/null; git clean -qfd -e TASK.md 2>/dev/null
# 실패 보고는 orca 메일일 때만(제목을 바꿔서). 다른 보고 명령(파일 기록 등)은 실패 때 실행하지 않는다 — 실측: 성공 문구가 그대로 찍혔다
case "$REPORT" in *"orca orchestration send"*) ( cd "$WT" && sh -c "$(printf '%s' "$REPORT" | sed "s/--subject \"[^\"]*\"/--subject \"하네스 실패 → 과장 검토 — $NAME\"/")" ) >>"$LOG" 2>&1;; esac
notify "🔴 $TOTAL 회 실패(거친 모델:$USED_MODELS) → 과장에게"; exit 1
