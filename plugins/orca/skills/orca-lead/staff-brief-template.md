# 사원#<N>(<기능>) 일감 — <한 줄 제목>   <!-- worker-run.sh 하네스용(사다리 gpt-oss→flash) -->

<!-- worker-run.sh(구 worker-run.sh) 가 이 파일의 절을 읽는다. 절 제목(## …)을 바꾸지 마라. 모델에게 가는 것은 「편집 지시」 뿐이고
     브랜치·검증·재시도(3회)·커밋·PR·보고는 스크립트가 한다. 완료 조건은 **순서·빈 줄·형식까지** 잡히게 쓴다(grep -c 만으로는 순서 오류를 못 잡는다 — 실측). -->

## 편집 지시
<모델에게 주는 문장. 파일 경로(절대 또는 워크트리 기준), 정확한 위치("`## 4` 목록의 `2. …` 줄 **바로 뒤**"), 넣을 텍스트 전문(코드 블록), 앞뒤 빈 줄 규칙. 판단이 필요한 표현("적절히", "비슷하게")은 쓰지 않는다.>

## 완료 조건
- `test "$(grep -c '### 시간' docs/X.md)" = 1`
- `grep -A1 '^2\. \*\*BetaTest' docs/X.md | tail -1 | grep -q '^3\. \*\*GammaTest'`   <!-- 순서 -->
- `awk '/^### 시간/{f=1} f&&/^---$/{print prev; exit} {prev=$0}' docs/X.md | grep -q '^$'`   <!-- 소절 뒤 빈 줄 -->
- `git diff --check`

## 브랜치
`docs/<이름>`

## 커밋 메시지
`docs: <무엇을>`

## PR 제목
`docs: <무엇을>`

## 보고
`orca orchestration send --run <RUN_ID> --type status --subject "사원 완료 — <이름>" --body "worker-run.sh 통과. 로그 /tmp/staff-<워크트리>.log"`
