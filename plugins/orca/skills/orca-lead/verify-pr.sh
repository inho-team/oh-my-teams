#!/bin/sh
# orca-lead PR 검증 — 임시 워크트리에 main 을 들이고 프로젝트의 전체 검사를 돌리고, **guard 커밋만 main 위에 올려(구현 없이) 빨개지는지** 기계로 본다.
#
# 사용:  verify-pr.sh <PR번호> [--role pl|pm] [--guard-cmd '<빠른 테스트 명령>'] [--no-guard] [--mutate '<셸 명령>']... [--notify <터미널>] [검사 명령...]
#   예:  verify-pr.sh 116 --guard-cmd 'go test -count=1 ./internal/...' 'go build ./... && go vet ./...' \
#            'TEST_DB_URL=… go test -timeout 40m ./...' 'cd web && npm run check:contract'
#   검사 명령을 안 주면 빌드/테스트는 돌리지 않고 머지 준비(워크트리·충돌)와 가드 검사만 한다.
#   --role     워크트리 경로 접미사. 부장은 pl(기본), 이사 표본 검증은 pm — 같은 /tmp/v<PR> 을 둘이 쓰다 이사 검사가 중간에 사라진 사고(orca-top §6).
#   --guard-cmd main+guard 상태에서 돌릴 **빠른** 테스트 명령. 비우면 <저장소>/.orca/project.env 의 GUARD_CMD, 그것도 없으면 마지막 검사 명령.
#   --no-guard 가드 자동 검사를 건너뛴다(가드 커밋 규약 이전의 PR 에만).
#   --dsn      검사·가드 명령의 `<격리 DSN>` 자리표시자에 넣을 Postgres URL. 안 주면 이 스크립트가 wb_v<PR>_<role> DB 를 만들고
#              워크트리 바이너리로 migrate·seed 해서 채운다(관리 DSN: project.env VERIFY_PG_ADMIN, 기본 127.0.0.1:5432/postgres). 끝나면 지운다.
#   --mutate   변이 검사(2026-09-12 과장 검토 규약): PR tip 에 이 셸 명령(성질을 깨뜨리는 최소 변경, 예: 'mkdir -p core/application/src/main/kotlin/cc/midolog/common')
#              을 적용한 뒤 GUARD_CMD 를 돌려 **빨개야** 통과. 초록이면 가드가 그 성질을 안 지킨다. 여러 번 줄 수 있다. 되돌리기는 자동.
#              과장 검토 보고의 변이를 부장·이사가 그대로 재현하는 데 쓴다 — "빨갰다" 는 문장은 주장이고 이 출력이 증거다.
#   --notify   끝나면 이 터미널(부장)에 "[verify] PR <n> 끝 — 로그" 한 줄을 보낸다. 부장은 `verify-pr.sh … > /tmp/verify-<n>.log 2>&1 &` 로 띄우고
#              프롬프트로 돌아가면 된다(codex 가 2분 넘는 명령을 배경으로 돌리다 매달리는 것, tail 로 6번 찔러 보던 것을 없앤다).
#
# 끝나면 워크트리를 남긴다(/tmp/v<PR>-<role>) — 추가 실험은 거기서 손으로 한다.
# 🔴 이 스크립트는 머지하지 않는다.
set -u
PR="$1"; shift
ROLE="pl"; GUARD_CMD=""; NO_GUARD=0; NOTIFY=""; MUTATES=""; NM=0; DSN=""
while [ $# -gt 0 ]; do case "$1" in --role) ROLE="$2"; shift 2;; --dsn) DSN="$2"; shift 2;; --guard-cmd) GUARD_CMD="$2"; shift 2;; --no-guard) NO_GUARD=1; shift;; --notify) NOTIFY="$2"; shift 2;;
  --mutate) NM=$((NM+1)); eval "MUTATE_$NM=\$2"; shift 2;; *) break;; esac; done
LOGF="/tmp/verify-$PR-$ROLE.log"
notify() { [ -z "$NOTIFY" ] && return 0; orca terminal send --terminal "$NOTIFY" --text "[verify $(date '+%H:%M')] PR #$PR 검증 끝($1) — 결과 로그: $LOGF(네가 리다이렉트한 파일), 가드: /tmp/guard-$PR-$ROLE.out, 변이: /tmp/mutate-$PR-$ROLE-*.out. 읽고 반려/통과를 정해라." --enter --json >/dev/null 2>&1; return 0; }
# 로그: 이 스크립트는 stdout 에만 쓴다. 배경으로 띄울 때 부장이 `> /tmp/verify-<PR>-<role>.log 2>&1 &` 로 리다이렉트한다(notify 가 그 경로를 가리킨다).
REPO="$(git rev-parse --show-toplevel)" || exit 1
cd "$REPO" || exit 1
if [ -z "$GUARD_CMD" ] && [ -f "$REPO/.orca/project.env" ]; then GUARD_CMD="$(sh -c ". '$REPO/.orca/project.env'; printf '%s' \"\${GUARD_CMD:-}\"")"; fi
BR="$(gh pr view "$PR" --json headRefName -q .headRefName)" || { echo "🔴 PR $PR 조회 실패"; notify "PR 조회 실패"; exit 1; }
git fetch -q --prune origin
echo "=== PR #$PR  branch=$BR  main=$(git log --oneline -1 origin/main)  role=$ROLE"
# 작업 파일이 커밋에 섞였는지 먼저 본다 — 실측: TASK.md·PR.md·temp.go 가 세 번 들어왔다.
STRAY="$(gh pr view "$PR" --json files -q '.files[].path' | grep -E '^(TASK\.md|PR\.md|temp\.[a-z]+|patch.*\.diff|PIPELINE\.md|task-[0-9]+[a-z]?\.md|.*HANDOFF-.*\.md)$')"
[ -n "$STRAY" ] && echo "🔴 작업 파일이 PR 에 들어 있다: $STRAY"
# 사원 하네스(worker-run.sh)의 실패 로그가 문서로 둔갑해 머지된 실측(2026-09-13 PR #154 docs/HANDOFF-drain-property-b.md, 네 층이 다 놓침).
HARN="$(for f in $(gh pr view "$PR" --json files -q '.files[].path' | grep -E '\.md$'); do git show "origin/$BR:$f" 2>/dev/null | grep -lq "직전 시도의 검증 실패" && echo "$f"; done)"
[ -n "$HARN" ] && echo "🔴 사원 하네스 실패 로그가 문서로 들어 있다(본문에 '직전 시도의 검증 실패'): $HARN"
WT="/tmp/v$PR-$ROLE"
rm -rf "$WT"; git worktree prune   # 같은 이름으로 검증한 뒤 지운 흔적(prunable)이 남아 add 가 막힌다(실측)
# ⚠️ `git worktree add … && …` 로 묶지 않는다 — add 가 실패하면 뒤 명령이 메인 체크아웃에서 돈다.
git worktree add --detach "$WT" "origin/$BR" >/dev/null 2>&1
[ -d "$WT" ] || { echo "🔴 워크트리 실패(브랜치가 다른 워크트리에 잡혀 있으면 --detach 로도 안 된다)"; exit 1; }
cd "$WT" || exit 1
git merge --no-edit -q origin/main; MERGE=$?
if [ $MERGE -ne 0 ]; then
  U="$(git diff --name-only --diff-filter=U)"
  echo "⚠️ main 을 들이다 충돌: $(echo "$U" | tr '\n' ' ')"
  # 문서(.md)만 충돌했으면 양쪽을 다 살려 진행한다 — 진행 기록은 둘 다 덧붙인 것이라 늘 그렇게 푼다.
  # 코드가 섞여 있으면 멈춘다: 사람이 본다.
  if [ -n "$U" ] && [ -z "$(echo "$U" | grep -v '\.md$')" ]; then
    for f in $U; do python3 "$(dirname "$0")/keepboth.py" "$f"; git add "$f"; done
    git commit -q -m "main 을 들인다 — 문서 충돌은 양쪽을 다 살렸다" && echo "   문서 충돌 자동 해결(양쪽 보존) → 계속"
  else
    echo "   코드 충돌은 사람이 본다. 해결 후 이 워크트리에서 검사를 이어 돌려라."
    notify "코드 충돌 exit 2"; exit 2
  fi
fi
# `<격리 DSN>` 자리표시자(project.env 규약): 검사·가드 명령 어디든 있으면 실제 DSN 으로 바꾼다.
# 실측(PR #144 이사 검증): 안 바꾸고 그대로 돌리자 `sh: 격리: No such file` 로 exit 1 이 났고, 가드 검사가 그것을 "빨강 ✅" 로 셌다.
PLACE='<격리 DSN>'; MADE_DB=""
if printf '%s\n' "$GUARD_CMD" "$@" | grep -qF "$PLACE"; then
  if [ -z "$DSN" ]; then
    ADMIN="$(sh -c ". '$REPO/.orca/project.env' 2>/dev/null; printf '%s' \"\${VERIFY_PG_ADMIN:-postgres://workbench:workbench@127.0.0.1:5432/postgres?sslmode=disable}\"")"
    MADE_DB="wb_v${PR}_${ROLE}"
    psql "$ADMIN" -qc "drop database if exists \"$MADE_DB\"" >/dev/null 2>&1
    psql "$ADMIN" -qc "create database \"$MADE_DB\" template template0 encoding 'UTF8'" >/dev/null 2>&1 || { echo "🔴 격리 DB 생성 실패($ADMIN) — --dsn 으로 직접 줘라"; exit 1; }
    DSN="$(printf '%s' "$ADMIN" | sed "s#/postgres?#/$MADE_DB?#")"
    ( make -s build >/dev/null 2>&1 && DB_URL="$DSN" ./bin/workbench migrate up >/dev/null 2>&1 && DB_URL="$DSN" ./bin/workbench seed >/dev/null 2>&1 ) || { echo "🔴 격리 DB migrate/seed 실패($DSN)"; exit 1; }
    echo "=== 격리 DB: $MADE_DB (migrate·seed 됨, 끝나면 지운다)"
  fi
  GUARD_CMD="$(printf '%s' "$GUARD_CMD" | sed "s#$PLACE#$DSN#g")"
  n=$#; i=0; while [ $i -lt $n ]; do c="$1"; shift; set -- "$@" "$(printf '%s' "$c" | sed "s#$PLACE#$DSN#g")"; i=$((i+1)); done
fi
LAST=""
for c in "$@"; do
  echo "=== $c"
  sh -c "$c"; rc=$?
  [ $rc -ne 0 ] && echo "🔴 exit=$rc"
  LAST="$c"
done

# 가드 자동 검사(2026-09-12): 'guard:' 커밋(테스트)만 origin/main 위에 올려 — 즉 **구현 없이** — 테스트를 돌린다.
# 빨개야 정상이다(재현 테스트 원칙: 고치기 전에 빨강). 초록이면 그 가드는 아무것도 안 지킨다 → 반려.
# 왜 revert 가 아니라 cherry-pick 인가: 가드 커밋을 revert 하면 테스트 파일이 사라져 "파일 없음" 으로 빨개질 뿐이다(실측).
# 손으로 빼다 통째 치환한 사고, 상한 없는 대기(10분 매달림)를 cherry-pick + 10분 상한으로 같이 잡는다.
if [ "$NO_GUARD" != 1 ]; then
  echo "=== 가드 자동 검사 (main + guard 커밋만 → 빨개야 한다)"
  [ -n "$GUARD_CMD" ] || GUARD_CMD="$LAST"
  GUARDS="$(git log --reverse --format='%h' origin/main..origin/$BR | while read h; do git log -1 --format='%s' "$h" | grep -q '^guard:' && echo "$h"; done)"
  if [ -z "$GUARDS" ]; then
    echo "🔴 'guard:' 커밋이 없다 — 반려: 가드 테스트를 별도 커밋으로 나누게 한다(공통 규칙). 규약 이전 PR 이면 --no-guard."
  elif [ -z "$GUARD_CMD" ]; then
    echo "⚠️ 가드 커밋은 있으나 돌릴 명령이 없다(--guard-cmd 또는 project.env GUARD_CMD 또는 검사 명령) — 손으로 봐라: $(echo $GUARDS | tr '\n' ' ')"
  else
    TIP="$(git rev-parse HEAD)"
    git checkout -q --detach origin/main
    PICKED=""; for g in $GUARDS; do
      # 가드마다 **커밋**한다. --no-commit 으로 쌓다가 뒤 가드가 충돌해 `reset --hard` 하면 앞서 올린 가드까지 사라져
      # 맨 main 을 돌리고 "구현 없이도 초록 🔴" 로 오판했다(실측 2026-09-13 PR #158: 과장·이사 둘 다 거짓 반려).
      if git -c user.name=verify -c user.email=verify@local cherry-pick "$g" >/dev/null 2>&1; then PICKED="$PICKED $g"; else echo "⚠️ $g 를 main 위에 올리다 충돌(구현과 같은 파일을 고친 테스트) — 이 가드는 손으로 본다"; git cherry-pick --abort >/dev/null 2>&1 || git reset -q --hard HEAD; fi
    done
    if [ -n "$PICKED" ]; then
      echo "--- main + guard[$PICKED ] 로 실행: $GUARD_CMD"
      # macOS 에 timeout 이 없다 — perl alarm 으로 10분 상한
      # pipefail: GUARD_CMD 에 `| tail` 이 있어도 테스트의 종료코드가 살아남는다(실측 PR #38: tail 의 0 이 빨강을 가려 거짓 판정)
      perl -e 'alarm 600; exec @ARGV' sh -c "set -o pipefail 2>/dev/null; $GUARD_CMD" >"/tmp/guard-$PR-$ROLE.out" 2>&1; rc=$?
      if [ $rc -eq 0 ]; then echo "🔴 구현 없이도 초록(exit 0) — 가드가 아무것도 안 지킨다. 반려. 출력: /tmp/guard-$PR-$ROLE.out"
      elif [ $rc -eq 142 ] || [ $rc -eq 14 ]; then echo "🔴 구현 없이 돌리니 10분 매달린다(상한 없는 대기) — 반려."
      elif ! grep -qE "^(--- FAIL|FAIL|panic:)|✗|[0-9]+ (failed|failing)" "/tmp/guard-$PR-$ROLE.out"; then
        # 실측(PR #144): 명령 자체가 깨져도(No such file, command not found) exit 1 이라 "빨강" 으로 셌다. 테스트 실패 흔적이 없으면 판정 불가.
        echo "🔴 exit $rc 인데 테스트 실패 흔적(--- FAIL/FAIL/panic)이 없다 — 명령이 깨진 것이지 가드가 빨간 게 아니다. 판정 불가. 출력: /tmp/guard-$PR-$ROLE.out"; head -3 "/tmp/guard-$PR-$ROLE.out"
      else echo "✅ 구현 없이는 빨강(exit $rc) — 보고에 붙일 출력: /tmp/guard-$PR-$ROLE.out"; grep -E "^(--- FAIL|FAIL|panic:)|✗" "/tmp/guard-$PR-$ROLE.out" | head -6; fi
    fi
    git reset -q --hard; git checkout -q --detach "$TIP"
  fi
fi
# 변이 검사(2026-09-12): PR tip(+main) 에 성질을 깨뜨리는 최소 변경을 넣고 GUARD_CMD 가 빨개지는지 본다. 초록이면 가드가 그 성질을 안 지킨다.
if [ "$NM" -gt 0 ]; then
  echo "=== 변이 검사 (PR tip + 변이 → 빨개야 한다)"
  if [ -z "$GUARD_CMD" ]; then echo "🔴 변이 검사에는 --guard-cmd(또는 project.env GUARD_CMD)가 필요하다"; else
    TIP="$(git rev-parse HEAD)"; i=1
    while [ $i -le $NM ]; do
      eval "M=\$MUTATE_$i"
      echo "--- 변이 $i: $M"
      if ! sh -c "$M" >"/tmp/mutate-$PR-$ROLE-$i.out" 2>&1; then echo "⚠️ 변이 $i 적용 실패 — /tmp/mutate-$PR-$ROLE-$i.out"; git reset -q --hard "$TIP"; git clean -qfd -e build -e .gradle -e node_modules; i=$((i+1)); continue; fi
      perl -e 'alarm 600; exec @ARGV' sh -c "set -o pipefail 2>/dev/null; $GUARD_CMD" >>"/tmp/mutate-$PR-$ROLE-$i.out" 2>&1; rc=$?
      if [ $rc -eq 0 ]; then echo "🔴 변이 $i 를 넣어도 초록(exit 0) — 가드가 이 성질을 안 지킨다. 반려. 출력: /tmp/mutate-$PR-$ROLE-$i.out"
      elif [ $rc -eq 142 ] || [ $rc -eq 14 ]; then echo "🔴 변이 $i 에서 10분 매달린다 — 반려."
      elif grep -qE "compile(Test)?Kotlin FAILED|^e: |cannot find symbol|error\[E|SyntaxError|undefined:" "/tmp/mutate-$PR-$ROLE-$i.out" && ! grep -qE "^[^>]*(Test|Spec)[^ ]* > .* FAILED|--- FAIL|tests? completed, [1-9]+ failed" "/tmp/mutate-$PR-$ROLE-$i.out"; then
        echo "⚠️ 변이 $i 는 빨강이지만 **컴파일이 깨진 것**(exit $rc) — 가드가 성질을 잡은 게 아니다. 변이로 치지 않는다. 출력: /tmp/mutate-$PR-$ROLE-$i.out"
      else echo "✅ 변이 $i 는 빨강(exit $rc, 테스트 실패) — 출력: /tmp/mutate-$PR-$ROLE-$i.out"; grep -E "FAIL|panic|Error|error|✗|failed" "/tmp/mutate-$PR-$ROLE-$i.out" | head -3; fi
      git reset -q --hard "$TIP"; git clean -qfd -e build -e .gradle -e node_modules
      i=$((i+1))
    done
  fi
fi
[ -n "$MADE_DB" ] && psql "$ADMIN" -qc "drop database if exists \"$MADE_DB\"" >/dev/null 2>&1 && echo "=== 격리 DB $MADE_DB 삭제"
echo "=== 워크트리: $WT (추가 실험은 여기서. 끝나면 git worktree remove --force $WT)"
notify "정상 종료"
