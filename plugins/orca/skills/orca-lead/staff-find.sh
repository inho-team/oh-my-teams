#!/bin/sh
# 사원 찾기 도구 — 상위 자리(과장·대리·부장)가 "어디에 무엇이 있나" 를 사원(gpt-oss)에게 시키고 **인용 대조를 통과한 것만** 받는다. (2026-09-13)
#
# 사용:  staff-find.sh <저장소> "<질문>" [--paths "<경로 힌트, 쉼표>"] [--model gpt-oss-120b-medium] [--max 8]
#   출력: 검증된 인용 JSON [{file, line, quote, why}] (stdout). 탈락은 stderr. 아무것도 검증 못 하면 exit 1.
# 왜: 상위 자리 턴의 절반이 "찾아 인용하기" 다(실측: 과장 48~65턴). 결론은 위에 남기고 읽기·인용만 내린다. 사원의 인용은 cite-check.py 가 실제 파일과 대조한다.
set -u
REPO="$(cd "${1:-.}" 2>/dev/null && pwd)"; Q="${2:-}"; shift 2 2>/dev/null || { echo "사용: staff-find.sh <저장소> \"<질문>\" [--paths ...] [--max N]"; exit 2; }
PATHS=""; MODEL="gpt-oss-120b-medium"; MAX=8
while [ $# -gt 0 ]; do case "$1" in --paths) PATHS="$2"; shift 2;; --model) MODEL="$2"; shift 2;; --max) MAX="$2"; shift 2;; *) shift;; esac; done
HERE="$(cd "$(dirname "$0")" && pwd)"; OUT="/tmp/staff-find-$$.out"
PROMPT="저장소 $REPO 에서 아래 질문에 답할 **근거 위치**를 찾아라. run_command 로 grep/rg/cat/sed 만 써라(파일을 고치지 마라). 답은 **JSON 배열 하나만** 출력한다(설명 문장 금지): [{\"file\":\"<저장소 기준 상대 경로>\",\"line\":<줄 번호 정수>,\"quote\":\"<그 줄의 원문 그대로(한 줄)>\",\"why\":\"<이 줄이 질문에 답하는 이유 한 문장>\"}]. 최대 $MAX 개. 줄 번호와 원문은 반드시 실제 파일에서 확인한 것만 적어라 — 대조기가 파일과 비교해 틀린 인용을 버린다.
${PATHS:+경로 힌트: $PATHS}
질문: $Q"
agy --model "$MODEL" --dangerously-skip-permissions --add-dir "$REPO" --print-timeout 4m -p "$PROMPT" > "$OUT" 2>&1
if grep -q "RESOURCE_EXHAUSTED" "$OUT"; then echo "⛔ $MODEL 429" >&2; exit 3; fi
python3 "$HERE/cite-check.py" "$REPO" "$OUT"; rc=$?
[ $rc -ne 0 ] && { echo "원문: $OUT" >&2; grep -E "print timeout|API error|Model produced" "$OUT" >&2 | head -3; } || rm -f "$OUT"; exit $rc
