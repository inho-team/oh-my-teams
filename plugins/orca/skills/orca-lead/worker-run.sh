#!/bin/sh
# 하네스 워커 실행기(사원→대리 승격 사다리) — 모델에게는 "편집" 하나만 시키고, 브랜치·검증·재시도·승격·커밋·PR·보고는 이 스크립트가 한다. (2026-09-13)
#   사용자 배치: 사원 = gpt-oss-120b(기본 구현·문서), 대리 = gemini flash(승격·탐색이 필요한 구현), 과장 = gemini pro(운영·검토, 코드 안 씀).
#   실측: gpt-oss 가 문서 2건(2~3회), Kotlin 가드 테스트 1건(4회, 컴파일 오류를 25줄 되돌려 주니 고침)을 통과했다. 그래서 기본 구현 자리를 사원에게 준다.
#
# 사용:  worker-run.sh <워크트리> <브리프.md> [--run <RUN_ID>] [--notify <터미널>] [--models "gpt-oss-120b-medium:4,gemini-3.8-flash-high:2"]
#   --models  모델:시도수 를 쉼표로. 앞에서부터 쓰고, 시도를 다 쓰면 다음 모델로 **승격**한다(같은 브리프·같은 실패 출력을 이어 준다). 기본은 사원 4회 → 대리 2회.
#   (구 worker-run.sh. --max-tries N 은 첫 모델의 시도수로 취급한다)
#   브리프(staff-assistant-solo-brief-template.md)의 절을 읽는다:
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
RUN_ID=""; NOTIFY=""; MAX=""; MODELS="gpt-oss-120b-medium:4,gemini-3.8-flash-high:2"
while [ $# -gt 0 ]; do case "$1" in --run) RUN_ID="$2"; shift 2;; --notify) NOTIFY="$2"; shift 2;; --max-tries) MAX="$2"; shift 2;; --models) MODELS="$2"; shift 2;; --model) MODELS="$2:${MAX:-3}"; shift 2;; *) shift;; esac; done
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
$( [ -n "$PREV" ] && printf '\n## 직전 시도의 검증 실패(이것을 고쳐라 — 파일의 현재 상태를 먼저 cat 으로 확인하라)\n%s\n' "$PREV" )"
  TRYOUT="/tmp/staff-$NAME-try$try.out"
  if [ -n "${STAFF_SANDBOX_PROFILE:-}" ]; then sandbox-exec -p "$STAFF_SANDBOX_PROFILE" agy --model "$MODEL" --dangerously-skip-permissions --add-dir "$WT" --print-timeout 5m -p "$PROMPT" >"$TRYOUT" 2>&1
  else agy --model "$MODEL" --dangerously-skip-permissions --add-dir "$WT" --print-timeout 5m -p "$PROMPT" >"$TRYOUT" 2>&1; fi
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
    git commit -q -m "$MSG" && echo "커밋 $(git rev-parse --short HEAD): $(git diff --stat "$BASE" | tail -1)" | tee -a "$LOG"
    if git remote get-url origin >/dev/null 2>&1 && [ -n "$TITLE" ]; then
      git push -q -u origin "$BR" 2>>"$LOG" && gh pr create --base main --head "$BR" --title "$TITLE" --body "$(printf '## 한 것(하네스 %s, %d회 시도)\n%s\n\n## 완료 조건(전부 exit 0)\n%s\n' "$MODEL" "$try" "$(printf '%s' "$EDIT" | head -20)" "$CONDS")" >>"$LOG" 2>&1 && PRN="$(gh pr view --json number -q .number 2>/dev/null)" && echo "PR #$PRN" | tee -a "$LOG"
    fi
    report; notify "✅ 통과(시도 $try, $MODEL)$( [ -n "${PRN:-}" ] && printf ' PR #%s' "$PRN" )"; echo "하네스: $try 회 시도 통과 — 모델 $MODEL (거친 모델:$USED_MODELS)" | tee -a "$LOG"; exit 0
  fi
  echo "🔴 시도 $try 실패:$FAILS" | tee -a "$LOG"
  PREV="$FAILS"; try=$((try+1))
done
echo "🔴 하네스 $TOTAL 회 실패(거친 모델:$USED_MODELS) → 과장(과장)에게 올려라. 마지막 실패:$FAILS" | tee -a "$LOG"
{ echo "--- 마지막 시도의 diff(새 파일 포함) ---"; git add -A -N . 2>/dev/null; git diff; git status --short; } >>"$LOG" 2>&1
git checkout -q -- . 2>/dev/null; git clean -qfd -e TASK.md 2>/dev/null
# 실패 보고는 orca 메일일 때만(제목을 바꿔서). 다른 보고 명령(파일 기록 등)은 실패 때 실행하지 않는다 — 실측: 성공 문구가 그대로 찍혔다
case "$REPORT" in *"orca orchestration send"*) ( cd "$WT" && sh -c "$(printf '%s' "$REPORT" | sed "s/--subject \"[^\"]*\"/--subject \"하네스 실패 → 과장 검토 — $NAME\"/")" ) >>"$LOG" 2>&1;; esac
notify "🔴 $TOTAL 회 실패(거친 모델:$USED_MODELS) → 과장에게"; exit 1
