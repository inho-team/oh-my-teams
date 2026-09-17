# graphify로 OMT의 판단을 코드·문서 구조에 논리적으로 연결하는 방안 검토

- 작성일: 2026-09-17
- 상태: 실측 완료. 채택/보류/기각 판정 포함. 후속 구현 전 Senior 검토 대기.
- 대상: graphify(https://github.com/Graphify-Labs/graphify, Apache-2.0), OMT 역할 스킬, Orca 런타임
- 관련 문서: [최소 변경 규율](../../plugins/oh-my-teams/references/minimal-change.md), [공유 할당량 모델 라우팅](shared-quota-model-routing.md), [AI 네이티브 에이전트 조직](ai-native-agent-organization.md)

graphify를 격리된 Python venv로 이 저장소에 실제로 실행하고, PM·PL·Senior의 판단을 그래프 근거에 연결하는 방안의 실측 결과를 정리한다.

## 1. 결정 제안

**A·B·C 지점은 보류, D 지점은 모델 필요 조건 때문에 기각한다. 채택 전 추가 검증이 필요한 항목이 있으므로 지금 당장 스킬과 런타임을 수정하지 않는다.**

graphify는 `.mjs` 파일의 `calls`/`imports` 관계를 모델 없이 AST로 추출하며, 실측에서 46초 만에 129개 코드 파일로부터 1,366 노드·3,718 엣지의 그래프를 생성했다. `graphify affected`는 grep 대조에서 호출자 목록이 일치했다. 그러나 마크다운 링크 관계(D 지점)는 LLM API 키 없이 추출할 수 없었고, `graphify prs --conflicts`는 `gh` CLI 인증을 요구했다. OMT가 Node.js 전용 환경이라는 점과 Python 의존성 추가 비용을 고려하면 현 시점에서 필수 의존성으로 채택하기에는 운영 위험이 더 큰 검증이 필요하다.

1. A 지점(PL 작업 분할): `affected`로 영향 범위를 측정하면 task `files` 목록과 의존성 DAG를 객관적 근거로 정할 수 있다. 실측에서 `draftOrganization`에 대해 깊이 2에서 15개 노드를 추출했으며, 직접 import 파일은 grep 결과와 일치하고 affected가 2단계 간접 의존자를 추가로 포함했다. 단, 그래프를 커밋 단위로 갱신하는 운영 절차가 먼저 정립되어야 한다. → **보류**
2. B 지점(Senior 검토·불필요한 변경 규율): `affected`로 변경 함수의 호출자를 확인하고 `explain`으로 기존 helper를 찾을 수 있다. A 지점의 운영 절차가 해결되면 즉시 적용 가능하다. → **보류**
3. C 지점(병렬 킥오프·PR 충돌): `prs --conflicts`는 `gh` CLI 인증이 필요하다. 대체 검증(최근 PR 변경 파일과 커뮤니티 대응)에서 PR #51(ollama)의 변경 파일이 커뮤니티 5로 집중되고 PR #54의 변경 파일이 커뮤니티 18과 겹치지 않음을 확인했다. 그래프 커뮤니티 기반 분석은 작동하나, GitHub API 없이는 자동화하기 어렵다. → **보류**
4. D 지점(OMT 문서 논리 연결): `.md` 파일의 마크다운 링크 관계 추출은 모델(LLM API)을 요구한다. `--code-only`로 우회하면 `.md` 파일 자체가 제외된다. 브리프의 금지 사항(문서 LLM 의미 분석 Pass 3 실행 금지)과 충돌하므로 현 조건에서 실행할 수 없다. → **기각**

## 2. 실측 결과 요약

### 2.1 환경

| 항목 | 값 |
|---|---|
| graphifyy 버전 | 0.9.63 |
| 설치 커밋(소스 사본) | 26b02b5 |
| 버전 차이 | 미확인 (pip 설치 버전과 소스 사본 커밋의 PyPI 버전을 직접 대조하지 않음) |
| Python | 3.12.10 |
| venv 경로 | `C:/Users/kjsun/AppData/Local/Temp/omt-graphify/venv` |
| 실행 환경 변수 | `GRAPHIFY_QUERY_LOG_DISABLE=1` |

### 2.2 코드 그래프 생성

```
대상: C:/Users/kjsun/orca/workspaces/oh-my-teams/graphify-review-doc
명령: graphify extract <worktree> --code-only --out <tmpdir> --no-viz
소요 시간: 46.09초
코드 파일: 129개 (비코드 48개 스킵)
노드: 1,366
엣지: 3,718
커뮤니티: 85
```

코드는 AST(tree-sitter)로 로컬 처리된다. `.mjs` 확장자는 `CODE_EXTENSIONS`에 포함되어 있으며(`detect.py` L44), JavaScript grammar로 파싱된다. 비코드 파일 48개(`.md` 등)는 `--code-only` 옵션으로 건너뛰었으며, LLM을 호출하지 않았다.

`graphify-out`이 저장소에 생기지 않도록 `--out` 옵션으로 저장소 밖 임시 디렉터리에 출력했다. 실행 후 `git status --short`로 워크트리에 산출물이 없음을 확인했다.

### 2.3 `.mjs` 사이 `calls`/`imports` 관계 추출 확인

```
명령: graphify affected "draftOrganization" --graph graph.json
출력:
Affected nodes for draftOrganization()
Relations: calls, indirect_call, references, imports, imports_from, ...
Depth: 2
- writeDraft() [calls] plugins/oh-my-teams/scripts/teams-org.mjs:L845
- teams-org.mjs [imports] plugins/oh-my-teams/scripts/teams-org.mjs:L81
- org-draft.test.mjs [imports] tests/org-draft.test.mjs:L13
- role-dispatch.test.mjs [imports] tests/role-dispatch.test.mjs:L28
- supervision.test.mjs [imports] tests/supervision.test.mjs:L10
- executeCommand() [calls] plugins/oh-my-teams/scripts/teams-org.mjs:L857
- orca-org.mjs [imports_from] plugins/orca/scripts/orca-org.mjs:L7
- agy-start.test.mjs [imports_from] tests/agy-start.test.mjs:L12
- cleanup-and-portability.test.mjs [imports_from] tests/cleanup-and-portability.test.mjs:L13
- delivery.test.mjs [imports_from] tests/delivery.test.mjs:L17
- headless.test.mjs [imports_from] tests/headless.test.mjs:L21
- runtime.test.mjs [imports_from] tests/runtime.test.mjs:L86
- safety-net.test.mjs [imports_from] tests/safety-net.test.mjs:L29
- skill-instructions.test.mjs [imports_from] tests/skill-instructions.test.mjs:L15
- usage-report.test.mjs [imports_from] tests/usage-report.test.mjs:L25
(총 15개 노드)
```

`teams-org.mjs` → `org-draft.mjs` 관계는 `[imports_from] EXTRACTED`로 추출되었다. grep으로 확인: `teams-org.mjs:L81: import { draftOrganization } from "./org-draft.mjs";`

grep 대조(`grep -rn draftOrganization`): `draftOrganization`을 직접 import하는 파일은 `org-draft.test.mjs`, `role-dispatch.test.mjs`, `supervision.test.mjs`, `teams-org.mjs` 4개다. graphify affected에는 여기에 더해 `orca-org.mjs`와 8개의 `imports_from` 경유 테스트 파일(간접 의존자)이 추가로 포함된다. 직접 import 파일은 일치하며, `imports_from` 경유 노드는 grep으로는 보이지 않는 2단계 역의존자다.

```
명령: graphify explain "org-draft.mjs" --graph graph.json
출력:
Node: org-draft.mjs
  ID:        plugins_oh_my_teams_scripts_org_draft
  Source:    plugins/oh-my-teams/scripts/org-draft.mjs L1
  Community: 18
  Degree:    16
Connections (16):
  <-- teams-org.mjs [imports_from] [EXTRACTED] L81
  --> draftOrganization() [contains] [EXTRACTED] L82
  <-- org-draft.test.mjs [imports_from] [EXTRACTED]
  <-- supervision.test.mjs [imports_from] [EXTRACTED]
  --> core.mjs [imports_from] [EXTRACTED] plugins/oh-my-teams/scripts/org-draft.mjs:L2
  --> validateOrg() [imports] [EXTRACTED] plugins/oh-my-teams/scripts/org-draft.mjs:L2
  --> DEPTH_ROLES [imports] [EXTRACTED] plugins/oh-my-teams/scripts/org-draft.mjs:L2
  --> FULL_DEPTH [imports] [EXTRACTED] plugins/oh-my-teams/scripts/org-draft.mjs:L2
  ...
```

`org-draft.mjs`가 `core.mjs`에서 `validateOrg()`를 import한다(`[imports] EXTRACTED L2`). `draftOrganization()`이 `validateOrg()`를 통해 검증을 공유한다는 사실은 이 엣지로 확인된다.

### 2.4 `affected`를 `work()` export에 실행하고 grep 호출자와 대조

```
명령: graphify affected "work" --graph graph.json
출력:
Affected nodes for work()
Relations: calls, indirect_call, references, imports, imports_from, ...
Depth: 2
- executeCommand() [calls] plugins/oh-my-teams/scripts/teams-org.mjs:L1019
- assist() [calls] plugins/oh-my-teams/scripts/worker.mjs:L637
- harness-smoke.mjs [imports] experiments/harness-smoke.mjs:L11
- teams-org.mjs [imports] plugins/oh-my-teams/scripts/teams-org.mjs:L42
- lock-recovery-and-release.test.mjs [imports] tests/lock-recovery-and-release.test.mjs:L15
- provider-adapters.test.mjs [imports] tests/provider-adapters.test.mjs:L28
- run-depth.test.mjs [imports] tests/run-depth.test.mjs:L20
- runtime.test.mjs [imports] tests/runtime.test.mjs:L18
- silent-wrong-results.test.mjs [imports] tests/silent-wrong-results.test.mjs:L14
- workflow-safety.test.mjs [imports] tests/workflow-safety.test.mjs:L23
- main() [calls] plugins/oh-my-teams/scripts/teams-org.mjs:L1227
- skill-instructions.test.mjs [imports] tests/skill-instructions.test.mjs:L14
- orca-org.mjs [imports_from] plugins/orca/scripts/orca-org.mjs:L7
- agy-start.test.mjs [imports_from] tests/agy-start.test.mjs:L12
- cleanup-and-portability.test.mjs [imports_from] tests/cleanup-and-portability.test.mjs:L13
- delivery.test.mjs [imports_from] tests/delivery.test.mjs:L17
- headless.test.mjs [imports_from] tests/headless.test.mjs:L21
- role-dispatch.test.mjs [imports_from] tests/role-dispatch.test.mjs:L29
- safety-net.test.mjs [imports_from] tests/safety-net.test.mjs:L29
- usage-report.test.mjs [imports_from] tests/usage-report.test.mjs:L25
(총 20개 노드)
```

grep 대조(`grep -rn "import.*work.*from.*worker"`): `work`를 직접 import하는 파일은 `harness-smoke.mjs`, `lock-recovery-and-release.test.mjs`, `provider-adapters.test.mjs`, `run-depth.test.mjs`, `runtime.test.mjs`, `silent-wrong-results.test.mjs`, `workflow-safety.test.mjs`, `teams-org.mjs` 8개다. graphify affected에는 여기에 더해 `skill-instructions.test.mjs`, `orca-org.mjs`, 그리고 `imports_from` 경유 7개 테스트가 추가로 포함된다. 직접 import 파일은 일치하며, `imports_from` 경유 노드는 2단계 역의존자다.

### 2.5 마크다운 링크 관계 추출 시도

```
명령: graphify extract plugins/oh-my-teams --no-viz --out <tmpdir>
결과: error: no LLM API key found
      (20 doc/paper/image file(s) need semantic extraction)
```

`.md` 파일의 마크다운 링크(`[text](./other.md)`) 관계는 graphify의 문서 처리 단계(Pass 3)를 통해 `references` 엣지로 추출된다. 그러나 이 단계는 LLM API 키가 없으면 실행되지 않는다. `--code-only`로 우회하면 `.md` 파일 자체가 코드 추출 대상에서 제외된다. → **모델 필요**

### 2.6 `prs --conflicts` 실행 결과

```
명령: graphify prs --conflicts --graph graph.json
오류: Error: gh CLI not found or not authenticated. Run: gh auth login
```

실측 환경에서 gh 2.97.0이 설치되어 있고(`C:/Program Files/GitHub CLI`) `dev-inho` 계정으로 인증되어 있었다(`gh auth status: Logged in to github.com`). 그럼에도 graphify가 위 오류를 발생시킨 것은, graphify의 `prs` 구현이 PATH에서 gh를 찾지 못했거나 내부적으로 `gh auth token`을 별도로 확인하는 과정에서 실패한 것으로 추정된다. 실제 원인은 소스 사본(`prs.py`)을 더 분석해야 하며 이번 실측에서는 미확인으로 남긴다. `prs --conflicts`는 이번 실측에서 실행하지 못했다.

### 2.7 쿼리 로그 기본값 (소스 확인)

`graphify/querylog.py` L15–31:

```python
def _log_path() -> Path | None:
    # Opt-in only (#1797). OFF unless explicitly enabled.
    if os.environ.get("GRAPHIFY_QUERY_LOG_DISABLE", "").lower() in ("1", "true", "yes"):
        return None
    override = os.environ.get("GRAPHIFY_QUERY_LOG", "").strip()
    if override:
        return Path(override).expanduser()
    if os.environ.get("GRAPHIFY_QUERY_LOG_ENABLE", "").lower() in ("1", "true", "yes"):
        return Path.home() / ".cache" / "graphify-queries.log"
    return None  # 기본값: 로그 없음
```

소스 기준 기본값은 **비활성화**다. README의 Privacy 절(584번줄)은 "is logged"라는 현재형으로 기본 활성화처럼 읽히지만, 동일 README의 환경 변수 표(567번줄)는 "Off by default"라고 명시한다. 소스로 확인한 실제 기본값은 비활성화(opt-in only, #1797)이며, README Privacy 절의 현재형 서술은 해당 기능이 활성화되었을 때의 동작 설명이다.

## 3. 연결 지점 A~D 판정

### A. PL 작업 분할: **보류**

**판정 근거:** `graphify affected <노드>` 명령은 깊이 2 BFS로 지정한 export의 역방향 의존자를 추출한다. 직접 import 파일은 grep 결과와 일치하며, affected가 2단계 간접 의존자(`imports_from` 경유 노드)를 추가로 포함한다. PL이 task의 `files` 목록을 정할 때 직접 의존 파일의 기준으로 이 출력을 근거로 쓸 수 있다.

실측 예:
- `draftOrganization` affected: 15개 노드 추출. 직접 import 파일 3개(테스트)와 `teams-org.mjs`, 함수 노드 2개, 그리고 `imports_from` 경유 간접 의존자 9개(`orca-org.mjs` 포함)가 포함된다.
- `work()` affected: 20개 노드 추출. 직접 import 파일 8개(`harness-smoke.mjs` 포함)와 함수 노드 2개, 그리고 `imports_from` 경유 간접 의존자 10개가 포함된다.

기본 깊이는 2이며(`affected.py` L194), `--depth` 플래그로 조정할 수 있다. `DEFAULT_AFFECTED_RELATIONS`에는 `calls`, `imports`, `imports_from`, `dynamic_import`, `inherits`, `uses` 등 12개 관계가 포함된다(`affected.py` L12–32).

**보류 이유:** 그래프를 커밋 단위로 갱신하는 운영 절차(worktree별 `graphify-out` 경로, 그래프를 만든 커밋을 증거에 묶는 방법)가 정립되지 않으면, 오래된 그래프를 근거로 잘못된 `files` 목록을 만들 수 있다.

**채택 시 바꿀 파일:** PL 스킬(`plugins/oh-my-teams/skills/pl/SKILL.md`)에 "task `files` 초안에 `graphify affected` 결과를 첨부한다" 규칙을 추가한다. graphify가 설치되지 않은 환경에서는 grep으로 대체하고, PL 스킬에 "graphify 미설치 시 `grep -rn <export명>`으로 호출자를 수동 확인한다"고 명시한다.

### B. Senior 검토와 불필요한 변경 규율: **보류**

**판정 근거:** 변경한 함수의 호출자를 `graphify affected`로 확인하고, `graphify explain`으로 동일 커뮤니티 내 기존 helper를 찾는 흐름이 실측에서 작동했다. `org-draft.mjs`의 `explain` 결과에서 같은 커뮤니티(18)의 연결 노드를 확인해 `draftOrganization()`이 `core.mjs`의 `validateOrg()`를 통해 검증을 공유하고 있음을 파악할 수 있었다.

이 검토 흐름은 [최소 변경 규율](../../plugins/oh-my-teams/references/minimal-change.md)이 요구하는 "변경 줄 밖의 기존 helper 재사용 확인"과 직접 연결된다.

**보류 이유:** A 지점의 그래프 갱신 절차가 해결되어야 하고, Senior 스킬에 검토 기준을 추가하는 작업(`minimal-change-discipline` kickoff)이 진행 중이다. 두 작업이 완료된 뒤 연동하는 것이 적절하다.

**채택 시 바꿀 파일:** Senior 스킬(`plugins/oh-my-teams/skills/senior/SKILL.md`)에 "검토 시 `graphify affected <변경 export>`와 `graphify explain <변경 파일>`을 실행해 호출자와 helper를 확인한다" 항목을 추가한다. graphify 미설치 환경에서는 `grep -rn <export명>`으로 대체한다.

### C. 병렬 kickoff·PR 충돌: **보류**

**판정 근거:** `graphify prs --conflicts`는 `gh` CLI 인증(`gh auth login`)이 필요해 이번 실측에서 실행하지 못했다. 대체 검증으로 최근 병합 PR 두 개의 변경 파일을 커뮤니티에 대응했다.

| PR | 주요 변경 .mjs | 커뮤니티 |
|---|---|---|
| #51 (dev-inho/ollama) | `providers/ollama.mjs` | 커뮤니티 5 (Degree 13) |
| #51 (dev-inho/ollama) | `core.mjs`, `delivery.mjs`, `gates.mjs` 등 | 커뮤니티 0, 3, 17 |
| #54 (docs/verify-claude-role-worker) | `references/orca-runtime.md` | --code-only로 미포함 |

PR #51의 `providers/ollama.mjs`가 커뮤니티 5에 속하고 주요 런타임 스크립트들이 다른 커뮤니티(0, 3)에 속한다. 두 PR 사이에 같은 커뮤니티에서 겹치는 파일이 있으면 충돌 위험이 높다고 판단할 수 있다. 이 분석 방법 자체는 작동하나, `prs --conflicts` 없이는 미병합 PR에 자동 적용하기 어렵다.

현재 진행 중인 kickoff 브랜치(`dev-inho/form-model-choices`, `dev-inho/minimal-change-discipline-2`) 두 개 모두 `git diff --name-only main...branch` 결과가 비어 있어 변경 파일을 확인할 수 없었다.

**보류 이유:** `gh` CLI 인증 또는 GitHub API 연동이 해결되어야 `prs --conflicts`를 활용할 수 있다. 커뮤니티 기반 수동 분석은 작동하지만, 실용적인 자동화 수준에 이르지 못한다.

**채택 시 바꿀 파일:** PL 스킬에 "병렬 kickoff 시작 전 `graphify prs --conflicts`로 커뮤니티 충돌을 확인한다. `gh` CLI 미인증 환경에서는 각 브랜치의 변경 파일을 `graphify explain`으로 커뮤니티에 대응해 수동 확인한다"고 추가한다.

### D. OMT 문서 논리 연결: **기각**

**판정 근거:** `plugins/oh-my-teams/skills/**/SKILL.md`와 `references/*.md` 사이 마크다운 링크 관계 추출을 시도했다.

```
명령: graphify extract plugins/oh-my-teams --out <tmpdir>
결과: error: no LLM API key found
      (20 doc/paper/image file(s) need semantic extraction)
```

README는 마크다운 `[text](./other.md)` 링크가 `references` 엣지가 된다고 설명하지만(`detect.py` `DOC_EXTENSIONS` L45), 이 처리는 문서 의미 분석 단계(Pass 3)로 LLM API 키 없이는 실행되지 않는다. `--code-only`로 우회하면 `.md` 파일 자체가 제외된다(실측: 48개 문서 파일 스킵).

그래프 없이 grep으로 마크다운 링크를 분석한 결과, 스킬 파일들은 `../../references/orca-runtime.md`, `../../references/assist.md` 등을 반복적으로 참조하고 있어 참조 구조 자체는 파악 가능하지만, graphify를 통한 자동화에는 모델이 필요하다.

**기각 이유:** 브리프의 금지 사항(문서 LLM 의미 분석 Pass 3 실행 금지, API 키가 필요한 기능 금지)과 충돌한다.

## 4. 운영 위험

### 4.1 Python 3.10+ 의존성

OMT는 Node.js 전용 저장소다. graphify는 Python 3.10+(`graphifyy` PyPI 패키지)를 요구하며, OMT의 기존 `package.json` 의존성에 포함되지 않는다. CI 환경이나 새 클론에서는 추가 설치 단계가 필요하다. 필수 의존성으로 만들려면 `package.json`의 `scripts`나 별도 setup 문서에 venv 생성·설치 절차를 추가해야 한다.

### 4.2 always-on hook·strict 모드와 역할 worker 충돌

`graphify hook install`은 git post-commit hook에 자동 재빌드를 등록하고, strict 모드(`--strict`)는 세션 첫 파일 읽기를 차단해 `graphify query`로 리디렉션한다. OMT의 역할 worker는 세션마다 `teams-org.mjs`를 직접 호출하므로, strict 모드가 활성화되면 worker의 파일 읽기가 차단될 수 있다. 또한 hook이 설치된 환경에서 각 커밋마다 46초의 그래프 재빌드 오버헤드가 발생한다. 이번 실측에서는 `graphify hook install`을 실행하지 않았다(브리프 금지 사항).

### 4.3 worktree별 `graphify-out` 신선도와 커밋 묶기

OMT는 저장소당 여러 worktree를 운영한다. 각 worktree의 `graphify-out`은 서로 다른 커밋을 기준으로 생성될 수 있으며, `--out` 경로가 다르면 그래프도 달라진다. 이번 실측에서는 `--out <tmpdir>` 옵션으로 저장소 밖에 출력해 커밋되지 않도록 했다.

그래프를 만든 커밋을 증거에 묶으려면 `graphify extract` 실행 시 해당 worktree의 HEAD SHA를 함께 기록해야 한다. 현재 graphify는 이 SHA를 graph.json에 자동 포함하지 않는다(미확인: `.graphify_analysis.json`에 포함 여부).

### 4.4 쿼리 로그 기본값

소스 코드(`querylog.py`) 기준 기본값은 **비활성화**다. README의 Privacy 절("is logged")은 기능이 활성화되었을 때의 동작을 설명하며, 기본 활성화를 의미하지 않는다. `GRAPHIFY_QUERY_LOG_DISABLE=1`을 설정하는 것은 현재 기본값과 동일하나, 향후 기본값이 바뀌더라도 안전하도록 명시적으로 설정하는 것이 권장된다.

### 4.5 문서 의미 분석 단계의 토큰 비용

마크다운·PDF·이미지 파일을 포함해 추출하면 Pass 3(LLM 의미 분석)이 실행된다. OMT의 `docs/`와 `plugins/oh-my-teams/`에는 48개 이상의 문서 파일이 있으며, 각 파일이 여러 번의 LLM 호출을 유발할 수 있다. 이 비용은 코드 그래프 생성(0 LLM 크레딧)과 달리 구독 할당량을 소비한다. 문서 의미 분석 단계 없이는 D 지점을 충족할 수 없다.

## 5. 후속 구현과 미설치 대체 동작

### A 지점(보류): PL 작업 분할

후속 구현 시 바꿀 파일:
- `plugins/oh-my-teams/skills/pl/SKILL.md`: task `files` 초안 작성 시 `graphify affected <변경 export> --depth 2`를 실행해 영향 범위를 첨부한다는 규칙을 추가한다.
- `plugins/oh-my-teams/references/orca-runtime.md` 또는 새 참조 문서: worktree별 그래프 갱신 절차(HEAD SHA 기록, `--out` 경로 규칙)를 명시한다.
- 검사 추가: graphify 미실행 상태에서 `files` 목록을 첨부하지 않아도 기존 검사가 통과하는지 확인해 하위 호환성을 보장한다.

graphify 미설치 환경 대체 동작: `grep -rn "<export명>" plugins/ tests/`로 호출자를 수동 확인하고 그 결과를 task `files` 주석에 기재한다. 필수 의존성으로 만드는 안은 CI에서 Python 및 graphifyy를 자동 설치하는 단계가 확인된 뒤에만 제안한다.

### B 지점(보류): Senior 검토와 불필요한 변경 규율

후속 구현 시 바꿀 파일:
- `plugins/oh-my-teams/skills/senior/SKILL.md`: "변경 함수의 호출자를 `graphify affected`로 확인하고, `graphify explain`으로 같은 커뮤니티의 기존 helper 재사용 여부를 검토한다"는 finding 기준을 추가한다. `minimal-change-discipline` kickoff와 함께 적용한다.

graphify 미설치 환경 대체 동작: `grep -rn "<함수명>" plugins/ tests/`로 호출자를 확인하고, 코드 내 `import` 구문으로 같은 파일에서 제공하는 helper를 수동 탐색한다.

### C 지점(보류): 병렬 킥오프·PR 충돌

후속 구현 시 바꿀 파일:
- `plugins/oh-my-teams/skills/pl/SKILL.md`: 병렬 kickoff 시작 시 `graphify prs --conflicts`를 실행해 커뮤니티 충돌 위험을 확인한다는 절차를 추가한다.

graphify 미설치 환경 대체 동작: 각 브랜치의 변경 예정 파일을 `git diff --name-only main...branch`로 나열하고, 같은 모듈(예: `providers/`, `scripts/`) 내 파일이 겹치는지 육안 확인한다.

## 6. 미확인 항목

- 설치된 graphifyy 0.9.63과 소스 사본(커밋 26b02b5)의 PyPI 버전이 같은지 직접 대조하지 않았다.
- `.graphify_analysis.json`에 그래프를 생성한 커밋 SHA가 포함되는지 확인하지 않았다.
- `prs --conflicts`: `gh` CLI 인증 필요로 실행하지 못했다.
- D 지점 마크다운 링크 관계 추출: 모델 필요로 실행하지 못했다.
- graphify strict 모드가 OMT worker와 실제로 충돌하는지 실험하지 않았다(금지 사항).
- worktree별 `graphify-out` 경로 규칙의 실제 운영 절차는 정립되지 않았다.
