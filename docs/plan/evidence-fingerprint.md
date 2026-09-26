# 증거 fingerprint 계획 (#63)

- 작성일: 2026-09-26
- 상태: `plugins/oh-my-teams/scripts/evidence.mjs`에 구현 완료. Windows 실기 검증은 하지 않았다. 아래 결정들은 코드와 테스트로만 고정했다.
- 관련 이슈: [#63](https://github.com/inho-team/oh-my-teams/issues/63)

## 문제

같은 커밋을 서로 다른 워크트리에서 체크아웃했을 때, `core.autocrlf`가 켜진 워크트리는 텍스트 파일을 CRLF로 바꿔서 디스크에 내려놓는다. 이전 `workspaceContents`(`evidence.mjs`)는 `git ls-files`로 얻은 파일 목록의 내용을 `fs.readFileSync`로 그대로 읽어 해시했으므로, 체크아웃이 만든 바이트 차이가 곧바로 증거 key의 차이가 되었다. 같은 커밋, 같은 검사 결과인데도 어느 워크트리에서 실행했는지에 따라 게이트가 `Stale evidence`로 되돌아가는 원인이었다.

## fingerprint의 필드

`fingerprint()`가 반환하는 객체는 다음 여덟 개 필드를 이 순서로 가진다. 이 순서는 `hash()`가 내부적으로 `JSON.stringify`를 쓰기 때문에 이미 저장된 모든 증거의 key에 그대로 묶여 있으며, 새 필드는 반드시 끝에만 추가해야 한다(`tests/workflow-runtime-gaps.test.mjs`의 키 순서 테스트가 이를 고정한다).

| 필드 | 의미 |
| --- | --- |
| `head` | 현재 워크트리의 `git rev-parse HEAD` |
| `base` | 신뢰하는 base ref의 커밋 (`git rev-parse --verify <baseRef>^{commit}`) |
| `tree` | 아래 「tree 계산 방식」 절 |
| `commands` | 수용 검사 argv 배열 |
| `environment` | 호출자가 넘긴 툴체인/픽스처 지문 문자열 |
| `timeoutMs` | (선택) 검사별 제한 시간. `#100` 이전 증거에는 이 키 자체가 없다 |
| `platform` | `process.platform` |
| `node` | `process.version` |

## tree 계산 방식 (수용 기준 1)

`workspaceContents(repo)`는 이제 두 부분을 조합한다.

1. `git rev-parse HEAD^{tree}`로 얻은 트리 객체 id. 이 값은 Git 객체 데이터베이스에서 직접 나오므로, 같은 커밋이면 워크트리가 그 파일을 디스크에 어떤 줄바꿈으로 내려놓았는지와 무관하게 항상 같다. `core.autocrlf`가 만드는 CRLF 변환은 체크아웃 시점의 변환일 뿐 객체 데이터베이스에는 닿지 않기 때문이다.
2. `git diff --name-only HEAD`로 얻은, HEAD와 실제로 다른 경로 목록(수정·삭제된 추적 파일)과 `git ls-files --others --exclude-standard`로 얻은 미추적 비무시 파일 목록을 합친 것. 이 목록에 오른 경로만 디스크에서 실제로 읽어 내용과 모드를 해시에 넣는다.

`git diff --name-only HEAD`가 핵심이다. 이 명령은 인덱스를 거치지 않고 워킹트리를 HEAD와 직접 비교하며, 비교할 때 체크아웃과 같은 clean/smudge 정규화를 적용한다. 그래서 `core.autocrlf`나 `.gitattributes`의 `text=auto`가 CRLF로 바꿔 놓은 파일은, 내용 자체가 그대로라면 "변경 없음"으로 보고된다 — Git 스스로 그 파일을 안 바뀐 것으로 취급하는 것과 정확히 같은 판정이다. 이전 구현은 이 판정을 거치지 않고 디스크 바이트를 곧바로 해시했기 때문에 문제가 생겼다.

이 방식은 부수 효과로 성능도 개선한다. 이전에는 검사할 때마다 저장소의 모든 추적 파일을 매번 새로 읽었지만, 지금은 변경되지 않은 파일은 `HEAD^{tree}` 하나의 문자열로만 대표되고, 실제로 diskio가 필요한 것은 정말 달라진 파일뿐이다.

**미추적 파일과 추적 파일 수정은 여전히 key를 바꾼다(수용 기준 2)**: 둘 다 `changedWorkspaceFiles`가 항상 담아내는 목록이고, 이 목록이 비어 있을 때만 `tree`가 `HEAD^{tree}`로만 결정된다. `role-launch.mjs`가 역할 지시문에 적어 두는 "미추적 파일도 증거를 바꾼다"는 계약과 `tests/review-format.test.mjs:66`의 검사는 코드를 건드리지 않았고 그대로 유지된다.

## 파일 모드 결정 (수용 기준 3)

파일 모드는 그대로 `tree`에 남긴다. 다만 위치가 바뀌었다.

- 바뀌지 않은 추적 파일의 모드는 더 이상 `fs.statSync`로 읽지 않는다. `HEAD^{tree}`가 이미 Git이 기록한 모드(100644/100755 등)를 담고 있으므로, 그 값이 그대로 fingerprint에 들어간다. 이 편이 오히려 더 안정적이다 — 실행 비트를 보존하지 않는 파일시스템에서도 Git이 기록한 값을 쓰기 때문이다.
- 변경되었거나 새로 생긴(미추적) 파일만 `fs.statSync(file).mode`를 실제로 읽는다. 실행 권한이 실제로 바뀌는 경우(셸 스크립트가 `+x`를 잃는 등)는 놓치면 안 되는 회귀이므로, 이 부분만은 지금 디스크 상태를 그대로 반영해야 한다.

모드를 완전히 빼는 방안도 검토했지만, 실행 권한이 의미 있는 파일(스크립트, 훅)에서 그 손실을 놓치는 편이 플랫폼 차이보다 더 나쁜 실패라고 판단해 유지했다.

## `Stale evidence` 거부가 필드를 밝힌다 (수용 기준 4)

`validateEvidence`는 이제 현재 fingerprint와 저장된 fingerprint를 필드 단위로 비교하는 `differingFingerprintFields`를 거쳐 어떤 필드가 달라졌는지 계산하고, 그 이름을 메시지에 넣는다. 예: `Stale evidence: tree changed`, `Stale evidence: head, environment changed`. 필드별로 값이 같은데도 전체 해시가 다른 극히 드문 경우(예: 저장된 JSON 자체가 손상된 경우)에는 `Stale evidence: recorded fingerprint no longer matches its key`로 대체한다. 메시지는 여전히 `Stale evidence`로 시작하므로 `tests/runtime.test.mjs`와 `tests/workflow-safety.test.mjs`의 기존 `/Stale evidence/` 검사와 호환된다.

## 이전 tree 알고리즘으로 기록된 증거의 처리 (수용 기준 5)

`timeoutMs`는 저장된 증거에 그 키가 있는지 없는지로 신·구 모양을 구분할 수 있어서, `validateEvidence`가 `includeTimeout` 옵션으로 옛 모양을 그대로 재현해 기존 증거를 계속 통과시킨다. `tree`는 이 방식을 그대로 가져올 수 없다: 옛 알고리즘과 새 알고리즘 둘 다 64자리 16진수 해시 문자열 하나를 `tree` 자리에 남기며, 그 값만 보고는 어느 알고리즘으로 만들었는지 구분할 표식이 전혀 없다.

그래서 이번 결정은 **이전 tree 알고리즘으로 기록된 증거는 호환 경로 없이 `Stale evidence: tree changed`로 거부하고 다시 검증한다**이다. 근거는 두 가지다.

1. 구분할 표식이 없는 상태에서 "호환"을 만들려면 옛 알고리즘(작업 트리 바이트를 그대로 해시하는, 지금 고치려는 바로 그 코드)을 영구히 남겨 두고 신·구 어느 쪽으로도 재계산해 봐야 한다. 이는 이번 작업이 없애려는 체크아웃 민감성을 코드 안에 그대로 보존하는 것과 같다.
2. 재검증 비용은 검사를 한 번 더 돌리는 것으로 끝나고, 이미 통과했던 작업이라면 대개 다시 통과한다. 반대로 옛 key를 계속 인정한다면, 바로 이 이슈가 보고한 체크아웃 의존적인 오탐을 옛 증거에 한해서는 계속 허용하는 셈이 되어 고치는 의미가 줄어든다.

`tests/evidence-line-endings.test.mjs`의 "pre-#63 tree 알고리즘" 테스트가 이 결정을 고정한다: 워크스페이스는 전혀 바뀌지 않았는데 tree 알고리즘만 옛 방식으로 계산된 증거를 넣으면, `tree` 필드 하나만 다르다고 정확히 지목하며 거부된다.

## 운영체제 간 한계 (수용 기준 6)

`tree` 계산을 고쳐도 fingerprint에는 `platform`(`process.platform`)과 `node`(`process.version`)가 남아 있다. 그러므로 **같은 커밋이라도 macOS 워크트리와 Windows 워크트리는 여전히 다른 증거 key를 갖는다.** `#63`이 보고한 상황은 같은 Windows 기기 안에서 워크트리만 옮긴 경우라 `platform`이 두 워크트리에서 동일했고, 이번 수정으로 그 증상은 해소된다. 하지만 플랫폼이나 Node 버전이 다른 두 환경 사이의 증거 재사용은 이번 범위가 아니며, 두 필드를 빼는 것도 이번 범위의 비목표다.

이 문서와 구현은 macOS(Darwin)에서만 실측했다. Windows에서 `git diff --name-only HEAD`가 CRLF 체크아웃을 실제로 "변경 없음"으로 판정하는지는 이번 작업에서 직접 실행해 확인하지 않았다; `tests/evidence-line-endings.test.mjs`는 `core.autocrlf`가 아니라 `.gitattributes`의 `text=auto`로 같은 상황을 만들어서, Git의 문서화된 정규화 동작에 기대어 세 플랫폼에서 같은 방식으로 실행되도록 했다. Windows 실기로 재현했다고 적지 않는다.

## 테스트 (수용 기준 7)

`tests/evidence-line-endings.test.mjs`가 다음을 확인한다.

- 같은 커밋을 복사한 두 디렉터리에서 한쪽 파일만 CRLF 바이트로 덮어써도 `fingerprint().tree`가 같다.
- 미추적 파일을 추가하면 `tree`가 달라진다.
- 추적 파일을 실제로 고치면 `tree`가 달라지고, `validateEvidence`는 `tree changed`라고 구체적으로 거부한다.
- 옛 tree 알고리즘으로 만든 증거는 워크스페이스가 그대로여도 `tree changed`로 거부된다.
