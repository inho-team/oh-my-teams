#!/bin/sh
# 워커가 **보고 전에** 돌리는 사전 점검 — 오늘 반려 사유의 절반을 기계적으로 없앤다.
#   preflight.sh [검사 명령...]      (워크트리 루트에서)
#   예:  preflight.sh 'make test' 'make web-check'
# 출력은 그대로 PR 본문 「검증」 절에 붙인다. 🔴 가 하나라도 있으면 보고하지 않는다.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 1
BR="$(git rev-parse --abbrev-ref HEAD)"; RED=0
echo "## preflight ($BR @ $(git rev-parse --short HEAD), $(date '+%Y-%m-%d %H:%M'))"
echo
echo "### 커밋·push 상태"
git fetch -q origin 2>/dev/null
if [ -n "$(git status --short | grep -v '^??')" ]; then echo "🔴 커밋 안 된 변경이 있다:"; git status --short | grep -v '^??' | head -10; RED=1; fi
UN="$(git status --short | grep '^??' | grep -vE 'node_modules|\.next' | head -5)"; [ -n "$UN" ] && echo "⚠️ 추적 안 되는 파일(커밋 대상이 아니면 무시): $(echo "$UN" | tr '\n' ' ')"
if git rev-parse --verify -q "origin/$BR" >/dev/null; then
  A="$(git rev-list --count "origin/$BR..HEAD")"; [ "$A" != "0" ] && { echo "🔴 push 안 된 커밋 ${A}개 — push 뒤 보고해라"; RED=1; }
else echo "🔴 origin 에 브랜치 $BR 이 없다 — push 안 됐다"; RED=1; fi
echo
echo "### 작업 파일 혼입 (main 대비 추가된 파일)"
STRAY="$(git diff --name-only --diff-filter=A origin/main...HEAD | grep -E '^(TASK\.md|PR\.md|pr_body\.md|report\.md|patch.*|temp\.[a-z]+|setup\.sh|inbox.*|orchestrator|workbench|.*\.(log|patch|orig|diff|rej))$')"
if [ -n "$STRAY" ]; then echo "🔴 작업 파일이 커밋에 들어 있다: $(echo "$STRAY" | tr '\n' ' ')  → git rm --cached <파일> && commit"; RED=1; else echo "없음"; fi
GEN="$(git diff --name-only origin/main...HEAD | grep -E 'package\.json|next-env\.d\.ts')"; [ -n "$GEN" ] && echo "⚠️ next dev 가 고치는 파일이 diff 에 있다: $GEN — 의도한 변경인지 확인(아니면 되돌려라)"
echo
echo "### 가드 커밋 (제목이 'guard:' 로 시작하는 별도 커밋 — PL 이 revert 해서 빨개지는지 기계로 본다)"
GUARDS="$(git log --format='%h %s' origin/main..HEAD | grep -E '^[0-9a-f]+ guard:')"
if [ -n "$GUARDS" ]; then echo "$GUARDS"; else echo "🔴 가드 커밋이 없다 — 가드 테스트를 'guard: <무엇을 지키나>' 제목의 별도 커밋으로 나눠라(구현 커밋과 섞지 마라)"; RED=1; fi
for g in $(git log --format='%h' origin/main..HEAD | while read h; do git log -1 --format='%s' $h | grep -q '^guard:' && echo $h; done); do
  # --stat 은 긴 경로를 `...` 로 줄여 /test/ 가 사라진다(실측 오탐, PR #38) — 이름 목록으로 본다
  NT="$(git diff-tree --no-commit-id --name-only -r $g | grep -cE '_test\.(go|ts|tsx|py|js)$|\.spec\.|\.test\.|/tests?/|Tests?\.(kt|java|scala|cs)$')"
  [ "$NT" = 0 ] && echo "⚠️ $g 가드 커밋에 테스트 파일이 안 보인다 — 가드가 맞나?"
done
echo
echo "### git diff origin/main...HEAD --stat"
git diff --stat origin/main...HEAD | tail -15
echo
for c in "$@"; do
  echo "### $c"
  OUT="$(sh -c "$c" 2>&1)"; rc=$?
  echo "$OUT" | grep -E "^(ok|FAIL|--- FAIL|panic|types\.gen|error TS|Error|🟢|🔴)" | head -40
  if [ $rc -ne 0 ]; then echo "🔴 exit=$rc — 빨갛다. \"통과\" 라고 적지 마라."; RED=1; else echo "exit=0"; fi
  echo
done
[ $RED -eq 0 ] && echo "✅ preflight 통과 — 이 출력을 PR 본문에 붙이고 보고해라" || echo "🔴 preflight 실패 — 위 항목을 고친 뒤 다시 돌려라. 보고하지 마라."
exit $RED
