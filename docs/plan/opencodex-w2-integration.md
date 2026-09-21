# OpenCodex 런타임 W3 통합 기록

수용된 네 task(w3-mainline, w3-platform-proof, w3-guide, w3-review)를 최신 `origin/main` 위의 통합 브랜치 하나로 모았고, 병합 HEAD `0f4e29d`에서 필수 검사 5종을 모두 통과했습니다. 수용은 PM의 권한이므로 이 기록은 통합 증거만 담으며, 통합 HEAD의 수용 여부와 PR 생성은 PM이 결정합니다.

이 문서는 통합 브랜치 `dev-inho/opencodex-w3-integration`에서 작성했습니다. 수용 기록과 검토 파일에 없는 사실은 적지 않았고, 인용한 문장은 해당 파일을 출처로 표시했습니다.

## origin/main 기준

| 항목 | 값 |
|---|---|
| 기준 커밋 | `fbf2d63859e5d779564a375d3657aef4d2924b8a` (PR #75, 2.7.0) |
| `git fetch origin` 시점의 `origin/main` | 기준 커밋과 같은 `fbf2d63`이며 더 앞선 커밋은 없었습니다. |
| 시작 HEAD | `6db7efcb990ff58fbaf137ed67806bf23416325c` (w3-mainline 수용 결과, `fbf2d63`을 이미 포함) |
| 병합 HEAD | `0f4e29df5cf69debf33d66c338e2841decf4b290` |

`origin/main`이 기준 커밋보다 앞서 있지 않았으므로 추가로 병합한 `origin/main` 커밋은 없습니다. 충돌은 발생하지 않았습니다.

## 병합한 브랜치와 커밋

세 브랜치의 tip이 수용된 커밋과 일치함을 병합 전에 확인했고, 수용 커밋 뒤에 추가된 커밋은 없었습니다. 병합은 모두 `git merge --no-ff`로 수행했습니다.

| task | 브랜치 | 수용된 커밋 | 병합 커밋 | 들어온 파일 |
|---|---|---|---|---|
| w3-mainline | 통합 시작점 | `6db7efc` | 해당 없음(시작 HEAD) | 해당 없음 |
| w3-platform-proof | `dev-inho/opencodex-w3-platform-senior` | `b9b5e7c90bf8117091d7bf02863049a66ab8da24` | `3465206` | `docs/plan/opencodex-w2-platform-proof.md`, `experiments/opencodex-w2-platform/run_platform_proof.py`, `experiments/opencodex-w2-platform/runtime-test-results.json` |
| w3-guide | `dev-inho/opencodex-w3-guide-senior` | `8e006b5dcd614af176e6c391f300ea301e6e5fa9` | `a8fe64d` | `README.md`, `docs/OPENCODEX_RUNTIME.md` |
| w3-review | `dev-inho/opencodex-w3-review` | `ce041d24f62150054544aa276d4a7c041c7fd4d7` | `0f4e29d` | `docs/plan/opencodex-w2-review.md` |

`git diff --stat 6db7efc 0f4e29d`가 보여 준 변경 파일은 위 표의 여섯 개와 정확히 같았습니다. `plugins/`, `scripts/`, `tests/` 아래 파일은 시작 HEAD와 차이가 없습니다. 병합 뒤 `plugins/oh-my-teams` 트리 해시는 `d9ba65eaea0e9cbb4a9e14d1e48b2acb25613cab`이며, 플랫폼 실측 JSON의 `repository.plugin_tree`와 일치합니다. 따라서 실측은 통합 HEAD의 실행 코드에 대한 측정이라고 볼 수 있습니다.

## 수용 기록과 독립 검토

수용 기록은 `/Users/jinsungkim/orca/workspaces/oh-my-teams/feat-opencodex-runtime/.omt/w3-requests/` 아래에 있고, 독립 검토 파일은 같은 경로의 `reviews/` 아래에 있습니다. 모두 결정자는 PM이며 기준은 `checks`와 `contract`입니다.

| task | 수용 기록 | 최종 독립 검토(approved) | 이전 검토 |
|---|---|---|---|
| w3-mainline | `accept-w3-mainline.json` | `reviews/w3-mainline-independent-review-3.json` | `reviews/w3-mainline-independent-review-1.json`, `reviews/w3-mainline-independent-review-2.json` |
| w3-platform-proof | `accept-w3-platform-proof.json` | `reviews/w3-platform-proof-independent-review-4.json` | `reviews/w3-platform-proof-independent-review-1.json`부터 `reviews/w3-platform-proof-independent-review-3.json`까지 |
| w3-guide | `accept-w3-guide.json` | `reviews/w3-guide-independent-review-4.json` | `reviews/w3-guide-independent-review-1.json`부터 `reviews/w3-guide-independent-review-3.json`까지 |
| w3-review | `accept-w3-review.json` | `reviews/w3-review-independent-review-2.json` | `reviews/w3-review-independent-review-1.json` |

수용 기록이 적은 근거의 요지는 다음과 같습니다.

- w3-mainline: 최종 HEAD `6db7efc`가 `origin/main` `fbf2d63`(2.7.0)의 후손이고 W1 `9cdc8e9`와 W2 `30309d1`을 Intern과 깊이 5 없이 병합했습니다. PM verify `c86b5ac`가 format, sync, lint, test(526개)를 통과했고, 구현자 `ctx_d87556b6ea9e`와 분리된 Senior 검토(`ctx_b2f0d3853df4`)가 세 차례 검토 끝에 finding 9건이 모두 해소되었다고 승인했습니다.
- w3-platform-proof: 최종 HEAD `b9b5e7c`는 Junior 두 차례 반려 뒤 Senior로 승격되어 완성되었습니다. macOS 한 대에서 설치, 멱등성, 손상 복구, 실패 스테이징 보존, doctor와 dry-run 전후 파일 목록, 실제 사용자 상태 16개 항목 비교를 측정했습니다. PM verify `c76028f`가 526개 테스트를 통과했고, Senior 검토(`ctx_ce028d9e5b93`)가 네 차례 끝에 finding 6건 해소를 승인했습니다.
- w3-guide: 최종 HEAD `8e006b5`도 Junior 두 차례 반려 뒤 Senior로 승격되었습니다. `README.md`와 `docs/OPENCODEX_RUNTIME.md`를 코드와 실측 출력에 맞춰 다시 썼고, PM verify `620ae31`이 526개 테스트를 통과했습니다. Senior 검토(`ctx_fdab78952277`)가 네 차례 끝에 finding 6건 해소를 승인했습니다.
- w3-review: 최종 HEAD `ce041d2`는 수용 기준 1부터 8까지를 판정한 문서입니다(1~7 부분 충족, 8 미충족). PM verify `fcf577d`가 526개 테스트를 통과했고, Senior 검토(`ctx_bc00cab1cc81`)가 review-1의 finding 8건 해소를 승인했습니다.

## 통합 HEAD에서 실행한 검사

병합 HEAD `0f4e29d`에서 Node v26.7.0, npm 11.19.0으로 실행했습니다. 로컬 Node 버전이 CI의 Node 22와 다르다는 점은 아래 "PR CI에서 확인할 사항"에 적었습니다.

| 순서 | 명령 | 결과 |
|---|---|---|
| 1 | `npm ci` | 성공, 취약점 0건 |
| 2 | `npm run format` | 성공, 변경된 파일 없음 |
| 3 | `npm run sync` | `changed`와 `missing`이 모두 빈 목록 |
| 4 | `npm run lint` | 종료 코드 0, `quality` 감사 finding 0건(공개 export 331개), `format:check` 통과 |
| 5-1 | `npm test` 1회차 | 526개 중 526개 통과, 실패 0, 취소 0, 건너뜀 0(15.9초) |
| 5-2 | `npm test` 2회차 | 526개 중 526개 통과, 실패 0, 취소 0, 건너뜀 0(16.0초) |
| 5-3 | `npm test` 3회차 | 526개 중 526개 통과, 실패 0, 취소 0, 건너뜀 0(15.9초) |
| 6 | `npm run eval:organization` | 종료 코드 0, 상태 `passed`, 시나리오 9개 모두 `passed` |

이 기록을 담은 커밋 이후의 최종 HEAD에서 같은 순서로 검사를 다시 실행했으며, 그 결과는 작업 보고에 적었습니다. 이 문서는 `.md` 파일 하나만 추가하므로 위 표의 병합 HEAD 결과와 달라질 이유가 없다고 판단했지만, 판단에 그치지 않고 재실행으로 확인했습니다.

## 남은 한계와 후속 항목

### w3-review 문서의 finding

`docs/plan/opencodex-w2-review.md`가 기록한 finding입니다. 구현 파일을 고치지 않는 범위였으므로 어느 것도 수정되지 않았고, 이 통합에서도 고치지 않았습니다.

| finding | 심각도 | 내용 |
|---|---|---|
| F-1 | 중간 | runner는 OpenAI 고정 계정만 지원합니다. Claude와 Agy 구독은 OMT runner로 전환되지 않았고, 프로필 검증은 provider를 제한하지 않습니다. |
| F-2 | 중간 | 수용 기준 6이 요구한 중복 코드 제거와 코드 감소 보고가 없습니다. |
| F-3 | 낮음 | W1은 전면 전환 보류로 판정했는데 OpenCodex가 카탈로그에 선언되어 있습니다. runner 블록이 있는 프로필로만 실행되므로 강제 전환은 아닙니다. |
| F-4 | 낮음 | 설치 중 상태 확인이 `HOME`을 격리하지 않습니다. 가짜 HOME에서는 `.npm`, `Library/Caches/bun`, `.codex/tmp/arg0`, `.local/state/gh/device-id`만 생겼습니다. 사용자의 실제 HOME에서 실행한 결과는 없습니다. |
| F-5 | 낮음 | 요청 이력 행을 허용 목록 없이 `opencodex.json`에 그대로 남깁니다. |
| F-6 | 중간 | `role-command`와 `worker-start`가 runner 프로필을 runner 없이 실행할 수 있고, 그 사실이 기록되지 않습니다. 릴리스 차단급은 아니며, `role-command`와 `worker-start`에 runner 단언 또는 명시적 거부를 추가하는 후속 수정이 필요합니다. |
| F-7 | 낮음 | runner 헤드리스 실행은 항상 승인 우회 플래그를 씁니다. |
| F-8 | 낮음 | Linux가 카탈로그의 macOS 항목으로 조용히 매핑됩니다. |
| F-9 | 중간 | Windows 실측이 없고 프록시 시작이 거부됩니다. |
| F-10 | 낮음 | 플랫폼 실측이 밝힌 한계(Node v26.7.0, 커널 거부 로그 신뢰 불가, `~/.codex`와 `~/.claude` 전체 비교 없음)가 해소되지 않았습니다. |
| F-11 | 해소 | 가이드가 독립 검토 4차에서 승인되어 판정에 영향이 없습니다. |
| F-12 | 확인 필요 | W1의 Claude 키체인 메타데이터 변경 원인이 확인되지 않았습니다. |
| F-13 | 낮음 | 설치 후 상태 확인이 만든 `health-home`과 `health-codex-home`가 활성 런타임 트리에 남고 정리 명령이 없습니다. |

`accept-w3-review.json`은 F-6, F-4, F-1, F-13, Claude 귀속의 사람 로그인 확인, PR CI와 최신 `origin/main` 통합을 후속 항목으로 적었고, "고쳐졌다고 주장하지 않는다"고 명시했습니다. 또한 `reviews/w3-review-independent-review-2.json`이 남긴 비차단 참고로, F-4가 인용한 `response.ok`의 위치는 345행이 아니라 346행입니다.

w3-review 문서가 "통합 단계에서 확인할 사항"으로 넘긴 다섯 항목 가운데 이 통합이 처리한 것은 다음과 같습니다.

- 통합 HEAD에서의 `npm ci`, `npm run sync`, `npm run lint`, `npm test` 실행은 위 검사 표에 있습니다.
- 플랫폼 실측의 `plugin_tree` 일치는 확인했습니다(위 "병합한 브랜치와 커밋").
- 가이드 `8e006b5`의 `README.md`와 `docs/OPENCODEX_RUNTIME.md`가 통합 HEAD에 포함되었음을 확인했습니다.
- F-6은 후속 수정 항목으로만 남겼으며 수정하지 않았습니다.
- PR CI는 이 통합에서 실행할 수 없으므로 아래 절로 넘깁니다.

### w3-mainline 수용 기록이 적은 한계

`accept-w3-mainline.json`은 다음을 알려진 한계로 적었습니다. 죽은 reclaimer mutex는 fail-closed로 막히고, 프로세스 그룹 하위 범위에는 한계가 있으며, 실제 `ocx`와 구독 실행은 없었고, Windows는 측정하지 않았습니다. 이 항목들은 막혀 있거나 문서화되었을 뿐 지원한다고 주장하지 않습니다.

### w3-platform-proof 수용 기록이 적은 한계

`accept-w3-platform-proof.json`은 커널 sandbox 로그가 신뢰할 수 없고(`reliable=false`), `~/.codex`와 `~/.claude`의 나머지는 귀속할 수 없으며, Windows는 측정하지 않았고, 프로세스 목록 비교가 없다고 적었습니다. 실측은 macOS 15.7.4, arm64, Node v26.7.0 한 환경에서 수행되었습니다(`docs/plan/opencodex-w2-review.md`의 남은 한계 5번).

### guide 검토 4차의 비차단 참고

`reviews/w3-guide-independent-review-4.json`은 승인하면서 finding이 아닌 비차단 참고를 남겼고, `accept-w3-guide.json`은 그중 두 건을 통합 단계에서 다루도록 남겼습니다. 이 통합에서는 문서를 고치지 않았습니다.

1. `README.md:48-49`는 Claude Code와 Codex CLI를 필수 의존성 표의 별도 행으로 적었는데 `README.md:112`는 "Codex CLI 또는 Claude Code"라고 적었습니다. 설치 인자 없이 `install.sh`를 실행하면 host가 `both`이고 `runtime-doctor`가 `ready`에 Codex를 요구하기 때문에 방어할 수 있는 표현이지만, 한쪽 호스트만 설치하는 독자는 이를 AND 조건으로 읽을 수 있습니다.
2. `README.md:60`은 PowerShell 명령을 Windows 미측정 단서 없이 보여 줍니다. 그 단서는 `docs/OPENCODEX_RUNTIME.md:298`에 있고, README는 102행과 117행에서 이 안내서를 링크합니다.

같은 검토 파일은 이 밖에도 `docs/OPENCODEX_RUNTIME.md:84`가 지문이 환경마다 다르다고 적었지만 실제로는 `package.json`과 `package-lock.json`의 해시라는 점, 246행이 `API_KEY or API-KEY`만 나열하지만 코드는 `APIKEY`도 막는다는 점을 비차단 참고로 적었습니다.

### npm test 간헐 실패 보고와 재현 결과

- 보고: `reviews/w3-platform-proof-independent-review-3.json`에 따르면 구현자가 `npm test`를 5회 실행하는 동안 1회 실패했다고 보고했습니다. 실패한 테스트 이름은 검토 파일에 없습니다.
- 검토자의 재현: 같은 검토자가 이 워크트리에서 `npm test`를 순차로 8회, 4개 동시 실행으로 2회(8회분) 실행했고 16회 모두 통과했습니다(526개, 실패 0, 회당 약 16초). 그 diff는 테스트나 구현 파일을 건드리지 않아서 원인은 그 task의 파일로 귀속되지 않고, 원인은 알 수 없다고 적었습니다. `accept-w3-platform-proof.json`도 이를 "재현되지 않은 npm test 실패 1건(검토자 재실행 0/16)"으로 남겼습니다.
- 이 통합의 결과: 병합 HEAD에서 `npm test`를 3회 실행했고 3회 모두 526개 중 526개가 통과했습니다. 실패는 재현되지 않았으며 원인은 여전히 알 수 없습니다.

## PR CI에서 확인할 사항

`.github/workflows/ci.yml`의 `CI` 워크플로는 `push`(`main`)와 `pull_request`에서 실행되며, `verify` job이 `matrix.os`로 `ubuntu-latest`, `macos-latest`, `windows-latest` 세 환경을 `fail-fast: false`로 실행합니다(22행). 각 환경의 단계는 다음과 같습니다.

1. `git config --global core.autocrlf false`
2. `actions/checkout@v4`
3. `actions/setup-node@v4`(`node-version: "22"`, `cache: npm`)
4. `npm ci`
5. `npm run quality`(문서 감사)
6. `npm run format:check`
7. `npm test`

이 통합에서 확인하지 못했고 PR CI에서 확인해야 하는 사항은 다음과 같습니다.

- 세 운영체제의 `CI` 워크플로가 모두 통과하는지 확인합니다. 로컬 검사는 macOS 한 대에서만 수행했습니다.
- 로컬 검사는 Node v26.7.0에서 실행했고 CI는 Node 22입니다. 패키지의 `engines`는 `>=22.13`이며, `docs/plan/opencodex-w2-review.md` 기준 7은 Node 22.13.0 하한과 CI의 Node 22에서의 실측이 없다고 적었습니다.
- Windows 환경에서는 `posixOnly` 테스트가 건너뛰어집니다. 건너뛰는 개수는 `docs/plan/opencodex-w2-review.md`가 23개라고 적었으며, 이 통합에서는 세지 않았습니다. Windows의 프록시 시작 거부(F-9)도 실측되지 않았습니다.
- `ci.yml`에는 `npm run eval:organization` 단계가 없으므로, 이 eval은 로컬 결과(위 검사 표)로만 확인되었습니다. w3-review 문서는 "관련 eval의 PR 단계 통과"를 통합 단계의 확인 사항으로 적었습니다.
- `npm test` 간헐 실패가 CI에서 재현되는지 지켜봅니다. 재현되면 실패한 테스트 이름을 기록해야 합니다.

## 이 통합이 하지 않은 일

push, PR 생성, 병합, 버전 변경, 플러그인 재설치는 하지 않았습니다. `package.json`과 manifest의 버전은 2.7.0 그대로입니다. 전역 Codex·Claude·Orca·OpenCodex 설정과 인증을 바꾸지 않았고, OpenCodex를 통한 구독 모델 호출도 하지 않았습니다. Intern 역할, 깊이 5, Intern 우선 배정은 추가하지 않았습니다. 원본 체크아웃 `/Users/jinsungkim/orca/oh-my-teams`에는 커밋하지 않았습니다.
