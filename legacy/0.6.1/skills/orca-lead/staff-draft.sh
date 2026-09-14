#!/bin/sh
# 사원 초안 도구 — 상위 자리가 쓰는 구조화된 문서의 **초안**을 사원(gpt-oss)이 만들고, 인용은 cite-check.py 로 대조해 통과분만 남긴다. (2026-09-13)
#   판단(통과/반려·성질 정의·분할 경계)은 초안에 없다 — 상위 자리가 초안의 행마다 정한다. 사원은 "어디에 무엇이 있나" 만 채운다.
#
# 사용:  staff-draft.sh checklist <저장소> <PR번호> [--model …]      # 검토 점검표 초안: 항목별 파일:행·인용·관찰
#        staff-draft.sh mutations <저장소> <PR번호> [--max 4]          # 변이 후보: diff 안의 줄만(국소성 대조), 명령(sed/perl 한 줄)
#   출력: stdout 에 마크다운 표(검증된 인용만 ✅, 탈락은 ❌ 로 남겨 상위 자리가 안다). 원문 JSON 은 /tmp/staff-draft-<PR>-<종류>.json
set -u
KIND="${1:-}"; REPO="$(cd "${2:-.}" 2>/dev/null && pwd)"; PR="${3:-}"; shift 3 2>/dev/null || { echo "사용: staff-draft.sh checklist|mutations <저장소> <PR> [--model M] [--max N]"; exit 2; }
MODEL="gpt-oss-120b-medium"; MAX=4
while [ $# -gt 0 ]; do case "$1" in --model) MODEL="$2"; shift 2;; --max) MAX="$2"; shift 2;; *) shift;; esac; done
HERE="$(cd "$(dirname "$0")" && pwd)"; DIFF="/tmp/staff-draft-$PR-$KIND-$$.diff"; OUT="/tmp/staff-draft-$PR-$KIND.out"; JSON="/tmp/staff-draft-$PR-$KIND.json"
cd "$REPO" || exit 2
gh pr diff "$PR" > "$DIFF" 2>/dev/null || { echo "🔴 gh pr diff $PR 실패"; exit 1; }
BR="$(gh pr view "$PR" --json headRefName -q .headRefName)"; git fetch -q origin "$BR" 2>/dev/null
# 대조는 PR 브랜치 기준 파일로 한다(머지 뒤라도 그 브랜치 tip 의 내용)
# 실행마다 유일한 임시 워크트리(실측: 과장이 checklist·mutations 를 겹쳐 돌리자 한쪽 정리가 다른 쪽 파일을 지워 인용이 전부 "파일 없음" 으로 탈락했다)
WT="/tmp/staff-draft-$PR-$KIND-$$.wt"; git worktree prune; git worktree add -q --detach "$WT" "origin/$BR" 2>/dev/null || git worktree add -q --detach "$WT" HEAD
case "$KIND" in
  checklist)
    ITEMS="1 값 검사인가 모양 검사인가(타입·컴파일·존재 확인으로 값 검사를 대신했나) | 2 판정에 쓴 값이 실제로 채워지는 값인가(항상 비어 오는 필드로 만든 판정이 아닌가) | 3 비동기 경계: 함수 반환=완료 로 착각한 곳 | 4 새 검사를 기존 관문 앞에 넣어 기존 경로를 막았나 | 5 시드/픽스처 not-null 위반·flaky 단언 | 6 작업 파일·생성물 혼입 | 7 범위 밖 변경"
    PROMPT="아래는 PR #$PR 의 diff 다(저장소 $WT 에 PR 브랜치가 체크아웃되어 있다 — 필요하면 run_command 로 cat/grep 해서 파일 전체를 봐라. 파일을 고치지 마라). 검토 점검표 **초안**을 만들어라. 판정(통과/반려)은 하지 마라 — 항목마다 diff 나 파일에서 **관련 줄을 인용**하고 관찰만 적어라. 항목 1·2·5 는 **테스트 파일의 assert/assertEquals/assertThrows 줄**을 인용해라(무엇을 어떤 값과 비교하는지가 근거다 — 구현 줄이 아니라). 항목 4 는 구현에서 새로 추가된 분기·검사 줄. 관찰은 「무엇이 무엇과 비교된다/무엇이 어디로 전달된다」 처럼 사실만. 답은 JSON 배열 하나만: [{\"item\":<1~7 정수>,\"file\":\"<저장소 기준 상대 경로>\",\"line\":<줄 번호>,\"quote\":\"<그 줄 원문 그대로>\",\"observation\":\"<이 줄에서 보이는 사실 한 문장. 판정 아님>\"}]. 항목마다 1~2개, 해당 없으면 그 항목은 file 을 \"-\" 로 두고 observation 에 '해당 없음: 이유'. 줄 번호·원문은 실제 파일에서 확인한 것만 — 대조기가 버린다.
점검 항목: $ITEMS

$(cat "$DIFF" | head -400)"
    ;;
  mutations)
    PROMPT="아래는 PR #$PR 의 diff 다(저장소 $WT 에 PR 브랜치가 체크아웃되어 있다. 파일을 고치지 마라). 이 PR 이 지키려는 성질을 **깨뜨리는 최소 변경(변이)** 후보를 $MAX 개 제안해라. 각 변이는 diff 에 **추가된 줄(+)** 하나를 원래대로 되돌리거나 지우는 것이어야 한다(무관한 변경은 안 된다). 답은 JSON 배열 하나만: [{\"file\":\"<상대 경로>\",\"line\":<변이할 줄 번호>,\"quote\":\"<그 줄 원문 그대로>\",\"cmd\":\"<그 줄만 바꾸는 sed -i '' 또는 perl -pi -e 한 줄>\",\"breaks\":\"<어떤 성질이 깨지나 한 문장>\"}]. 줄 번호·원문은 실제 파일에서 확인한 것만.

$(cat "$DIFF" | head -400)"
    ;;
  *) echo "🔴 종류: checklist | mutations"; exit 2;;
esac
agy --model "$MODEL" --dangerously-skip-permissions --add-dir "$WT" --print-timeout 5m -p "$PROMPT" > "$OUT" 2>&1
grep -q "RESOURCE_EXHAUSTED" "$OUT" && { echo "⛔ $MODEL 429"; exit 3; }
python3 "$HERE/cite-check.py" "$WT" "$OUT" > "$JSON" 2>"/tmp/staff-draft-$PR-$KIND.rejected"
python3 - "$KIND" "$JSON" "/tmp/staff-draft-$PR-$KIND.rejected" "$DIFF" <<'PY'
import sys, json, re
kind, jf, rf, df = sys.argv[1:5]
ok = json.load(open(jf)) if open(jf).read().strip() else []
rej = [l for l in open(rf, encoding="utf-8").read().split("\n") if l.startswith("❌")]
if kind == "checklist":
    print("| 항목 | 파일:행 | 인용 | 관찰(사원, 판정 아님) |"); print("|---|---|---|---|")
    for it in sorted(ok, key=lambda x: (x.get("item") or 0)):
        if it.get("verified"): print("| %s | ✅ `%s:%s` | `%s` | %s |" % (it.get("item"), it.get("file"), it.get("line"), (it.get("quote") or "")[:70].replace("\n"," "), it.get("observation")))
        else: print("| %s | — | — | %s |" % (it.get("item"), it.get("observation")))
else:
    # 국소성: 변이 줄이 diff 의 + 줄에 있어야 한다
    added = set(re.sub(r"\s+"," ",l[1:]).strip() for l in open(df, encoding="utf-8") if l.startswith("+") and not l.startswith("+++"))
    print("| # | 파일:행 | 국소성 | 변이 명령 | 깨는 성질 |"); print("|---|---|---|---|---|")
    for i, it in enumerate(ok, 1):
        loc = "✅ diff 안" if re.sub(r"\s+"," ",it.get("quote") or "").strip() in added else "❌ diff 밖"
        print("| %d | ✅ `%s:%s` | %s | `%s` | %s |" % (i, it.get("file"), it.get("line"), loc, (it.get("cmd") or "")[:90], it.get("breaks")))
for l in rej: print("| ❌ 탈락 | %s |" % l[2:80])
print("\n검증 %d · 탈락 %d · 원문 %s" % (len(ok), len(rej), jf))
PY
git worktree remove --force "$WT" 2>/dev/null; git worktree prune
