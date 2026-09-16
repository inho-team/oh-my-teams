# oh my teams 이름 변경과 Orca 연동 최소화 계획

- 작성일: 2026-09-14
- 최종 점검일: 2026-09-15
- 상태: R0–R4 구현·연동 검증 완료
- 사용자 결정: 제품 이름을 `orca-skills`에서 **oh my teams**로 변경한다.
- 사용자 방향: Orca 관련 CLI는 최신 버전에 맞는 공식 가이드를 가져와 사용하고, 이 저장소에서 따라 수정해야 하는 부분을 최소화한다.
- 관련 계획: [AI-native 에이전트 조직 계획](./ai-native-agent-organization.md)
- 문서 범위: 이름 변경, 설치 호환성, 런타임 연동 경계, 단계별 이전과 검증. 이 문서 작성으로 실제 이름 변경·설치·업데이트를 실행하지 않는다.

구현 기록(2026-09-14): 활성 plugin/package/marketplace를 `oh-my-teams`와 `plugins/oh-my-teams`로 이전했고 `teams-org.mjs`를 기본 런타임으로 지정했다. 기존 `plugins/orca/scripts/orca-org.mjs`는 forwarding 진입점만 유지한다. 공통 Orca discovery 참조와 분리된 `prepare-input`/Orca adapter/`attach-workspace` 경로를 추가했다. 호환 `prepare`는 이 세 단계를 감싼다. 선택된 Orca CLI/runtime 1.4.200과 version-matched guide hash를 실제 조회했다. 상세 주석·공통 모듈 리팩터링을 포함한 plugin 1.4.0을 Claude에, cachebuster가 적용된 1.4.0을 Codex에 설치·발견 확인했다. Claude의 구 0.6.1은 rollback용 설치를 보존한 채 비활성화했다. 기존 `.orca` 데이터는 이동·삭제하지 않았다.

호출명 갱신(2026-09-15): 제품 이름과 맞도록 `team-setup`, `team-show`, `team-edit`을 기본 스킬로 추가했다. 기존 `org-setup`, `org-show`, `org-edit`은 새 스킬을 읽는 호환 별칭으로 유지했으며 plugin 1.4.1에 반영했다.

상태 경로 갱신(2026-09-15): 기존 사용자가 없는 상태에서 oh my teams 소유 데이터를 `.omt/`로 분리했다. `.orca/` 호환 읽기나 자동 이전은 추가하지 않았으며 plugin 1.5.0부터 새 경로만 사용한다. 편집 범위 보호와 Git 제외 설정에서는 실제 Orca 상태를 위해 `.orca/` 차단을 유지한다.

모델 선택 보강(2026-09-15): plugin 1.5.1부터 Agy의 GPT-OSS·Sonnet·Opus 모델 ID를 동일한 `--model` 인자로 전달하며, 지원되지 않는 `--effort`를 자동으로 붙이지 않는다. 실제 세 모델 호출과 GPT-OSS의 일반 인용 과제로 경로를 확인했다.

추론 강도와 Codex 모델 확대(2026-09-15): 설치된 CLI에서 강도 전달 수단을 직접 확인했다. `agy --help`(1.2.3)에 `--effort low|medium|high`가 존재하므로 이전 기록의 "지원되지 않는다"는 판단을 **확인 결과 지원됨**으로 정정한다. `codex exec --help`(0.154.0)에는 전용 플래그가 없고 `--config model_reasoning_effort=<값>` 설정 오버라이드만 가능하며, Codex CLI가 알 수 없는 값을 거부하지 않고 그대로 전달하는 것을 확인했으므로 런타임이 값을 검증한다. Claude CLI에는 강도 선택 수단이 없다. 프로필의 선택적 `effort` 필드로만 강도를 전달하며, 생략하면 이전과 똑같이 어떤 강도 인자도 붙이지 않는다. Agy 모델 ID가 이미 강도를 담는 경우(`gemini-3.8-flash-high`) 어느 쪽이 우선하는지 확인하지 않았으므로, 두 값이 어긋나는 프로필은 저장을 거부한다. 같은 날 Codex 모델 카탈로그에서 `gpt-5.6-luna`와 `gpt-5.6-terra`를 확인해 예제 조직에 프로필로 추가했다. 예제 조직에서 역할이 참조하는 프로필에는 강도를 넣지 않아 이 예제의 호출 깊이는 변경 전과 같다. 생략 시 적용되는 깊이는 Codex의 경우 `config.toml` 설정이 없으면 카탈로그의 `default_reasoning_level`이고, Agy는 서버가 모델별로 정한다. Agy 바이너리에 `--effort is not supported for model` 오류가 있어 모델에 따라 플래그가 거부되는데, Agy의 Claude 두 모델과 GPT-OSS가 이를 받아들이는지는 호출 검증을 하지 않아 미확인으로 남는다. 강도 변경이 결과나 할당량 차감에 미치는 영향도 측정하지 않았다.

실행 기반 port 추상화(2026-09-16): 실행 기반을 바꿀 수 있는 경계를 만들되 Orca를 대체하지는 않았다. `scripts/execution.mjs`가 receipt 계약(확인된 식별자, 3값 liveness, 구조화된 실패 신호)을 정의하고, 구현체를 둘 두었다. `scripts/orca-adapter.mjs`에 `startWorker`, `stopWorker`, `abandonWorker`, `releaseWorker`를 추가했고, `scripts/local-adapter.mjs`는 `git worktree add`와 기존 `providers.mjs`의 비대화형 호출을 감싼다. 로컬 어댑터는 관측할 수 없는 생존을 주장하지 않도록 항상 `exited`만 반환한다. 실패 어휘는 각 어댑터가 중립 신호로 번역하며, `failures.mjs`에는 `execution-unconfigured` 범주 하나만 추가하고 실행 기반 고유 문자열은 넣지 않았다. 이 경계는 `tests/execution-port.test.mjs`의 테스트가 검사한다.

port 연결(2026-09-16): 정의만으로는 증상이 해소되지 않으므로 실행 경로에 연결했다. `scripts/adapters.mjs`가 실행 기반 이름을 번역기로 해석하는 유일한 지점이고, `failure-classify`는 failure 기록이 `runtime`과 `code`를 담고 있으면 분류 전에 중립 신호로 번역한다. 따라서 `agent_unconfigured`를 그대로 기록해도 PM의 프로필 재바인딩으로 라우팅되며, 재시도가 통째로 막히던 증상이 실제 경로에서 사라진다. `runtime`을 적지 않은 기록은 이전과 완전히 동일하게 분류된다. 새 `worker-start` CLI 명령이 Orca 어댑터의 래퍼를 노출하고, `prepare`는 port가 정의한 workspace receipt 필드를 사용한다.

Orca 1.4.201 계약을 실제로 조회해 확인한 사실도 함께 기록한다. `worker-start`는 `ready`에서만 0으로 종료하고 `failed`/`outcome_unknown`에서는 1로 종료하면서 `dispatchId`, `failedStage`, `residualResources`를 담은 receipt를 반환하므로, 이슈 #4가 요구한 "구조화된 시작 실패 반환"은 이미 충족되어 있다. 반면 `agy`는 Orca의 `TuiAgent` 목록에 없어 `--agent agy`가 항상 `agent_unconfigured`로 거부되며, `--model`이 지원하는 범위도 Claude, Codex, Cursor로 한정된다. 이슈 #2의 Agy launcher 연결은 이 저장소에서 해결할 수 없음이 추정이 아니라 확인된 사실이 되었다. 조회 결과는 `.omc/research/orca-worker-start-contract.md`에 보존했다.

## 1. 제품 정체성과 책임 경계

**oh my teams는 에이전트로 조직을 구성하고 목표를 수행하는 제품이다.** Orca는 그 조직의 작업 공간과 실행을 제공하는 기반이다.

| 영역 | oh my teams의 책임 | Orca의 책임 |
|---|---|---|
| 조직 | 역할, 모델·계정 배정, 위임과 업무 정책 | 실행 가능한 호스트 기능 |
| 작업 | 목표, 수용 기준, 의존성, 검토·수용 | 실제 Task/Dispatch 실행과 감독 |
| 작업 공간 | 필요한 격리 범위와 작업 소유권 결정 | worktree 생성·조회·회수 |
| 실행 | 어떤 작업을 누구에게 맡길지 판단 | 터미널, 실행 상태, 이벤트, settlement |
| 검증 | 증거 연결, gate, 실패 라우팅, 조직 eval | 실행 도구와 상태 조회 |
| 가이드 | 업무 원칙과 작은 discovery 진입점 | 현재 바이너리에 맞는 명령·인자·응답 설명 |

이름을 바꿔도 Orca 의존성을 숨기지 않는다. 설명 문구는 “Orca 위에서 실행되는 에이전트 조직”을 기본으로 사용한다. 실제 Orca API, 환경변수, worktree, Dispatch 등의 고유명은 그대로 유지한다.

다른 실행 플랫폼 지원은 이번 범위에 넣지 않는다. 미래 플랫폼을 위해 범용 어댑터 프레임워크를 먼저 만들지도 않는다.

## 2. 이름 매핑

사용자가 결정한 표시명은 `oh my teams`다. 아래 기계 식별자는 구현을 위한 기본안이며 호스트의 허용 형식을 확인한 후 확정한다.

| 항목 | 현재 | 목표 기본안 |
|---|---|---|
| 제품 표시명 | Orca Skills / Orca Organization | oh my teams |
| 저장소·package 이름 | orca-skills | oh-my-teams |
| marketplace ID | orca-skills | oh-my-teams |
| plugin ID | orca | oh-my-teams |
| 설치 식별자 | orca@orca-skills | oh-my-teams@oh-my-teams |
| Claude skill 호출 예시 | /orca:pm | /oh-my-teams:pm |
| plugin 소스 디렉터리 | plugins/orca | plugins/oh-my-teams |
| 조직 런타임 파일 | orca-org.mjs | teams-org.mjs |
| npm 실행 스크립트 | npm run org | 유지 |
| 역할 이름 | PM / PL / Senior / Junior / Intern | 유지 |
| Orca 명령·환경변수 | orca 계열 / ORCA_* | 유지 |
| 로컬 실행 기록 | .orca/ | 첫 이전에서는 유지했고, 1.5.0부터 제품 상태는 `.omt/`를 사용 |

호출명과 설치 명령은 목표 예시다. 현재 호스트가 이미 이 이름을 지원하거나 설치되어 있다는 의미가 아니다. 약칭 `omt`는 새 바이너리나 namespace로 추가하지 않는다. 이름이 늘어나는 비용을 피한다.

로컬 checkout 폴더와 원격 저장소 URL 변경은 package 이름 변경과 별개다. 현재 경로를 자동 이동하지 않고, 원격 저장소 rename이 필요하면 소유권과 링크 영향을 확인하는 별도 작업으로 수행한다.

## 3. 현재 저장소에서 변경할 위치

| 파일·영역 | 계획 |
|---|---|
| `README.md` | 제품 소개, 시작 명령, 설치 식별자, Orca 의존성 설명 갱신 |
| `package.json` | package 이름과 런타임 경로 갱신, `org` 명령 유지 |
| `.claude-plugin/marketplace.json` | marketplace ID, plugin ID, source 경로와 설명 갱신 |
| `.agents/plugins/marketplace.json` | Codex marketplace 이름·표시명·plugin ID·source 갱신 |
| `plugins/orca/.claude-plugin/plugin.json` | plugin 이름·설명·릴리스 버전 갱신 |
| `plugins/orca/.codex-plugin/plugin.json` | plugin 이름, 표시명, 설명, 기본 prompt 갱신 |
| `scripts/install.mjs` | import 경로, 호스트별 설치 대상, 이전 설치 감지·안내 |
| `install.ps1`, `install.sh` | 공통 설치기 호출 유지, 필요한 이름 안내만 수정 |
| 역할별 `SKILL.md` | 제품명과 런타임 경로 변경, Orca 명령 레시피 대신 discovery 참조 |
| `scripts/orca-org.mjs` | teams-org로 이전, Orca 직접 호출 경계 축소 |
| `tests/`, `experiments/` | 실행에 사용되는 import·경로 갱신 |
| `docs/plan/` | 신규 경로 매핑과 계획 간 참조 갱신 |
| `legacy/0.6.1` | 역사 기록으로 유지, 기존 제품명 일괄 치환 금지 |

과거 실험 보고서의 제품명·실행 경로는 당시 결과의 일부다. 역사적 기록은 유지하고, 재실행할 스크립트의 현재 경로만 갱신한다. 본문 전체에서 `orca`를 일괄 치환하지 않는다.

## 4. 최신 Orca 사용의 의미

### 4.1 공식 discovery 방식을 따른다

현재 로컬 `orca-cli` skill은 명령 사용법 전체를 저장하지 않는 discovery stub이다. 선택한 Orca 바이너리가 제공하는 `skills get orca-cli`로 버전에 맞는 가이드를 읽도록 한다. 이 구조를 연동의 기준으로 삼는다.

실행 시작 시:

1. 공식 discovery 규칙으로 현재 세션의 Orca 실행 파일을 선택한다.
2. 같은 실행 파일에서 `skills get orca-cli`를 읽는다.
3. 실제 감독이 필요할 때 해당 바이너리에서 `skills get orchestration`을 읽는다.
4. 필요한 작업의 가이드와 참조 문서만 추가로 확인한다.
5. 그 가이드에 있는 명령과 응답 형식을 사용한다.
6. 실행 파일, 확인 가능한 버전, 조회한 가이드 식별자/hash를 run 기록에 남긴다.

위 `skills get` 표기는 discovery 절차이며, 실제 실행에서는 선택된 실행 파일을 사용한다. 제품 skill마다 실행 파일 선택 규칙을 복사하지 않고 공식 stub으로 연결한다.

### 4.2 가이드 갱신과 바이너리 업데이트를 구분한다

“최신을 가져온다”는 다음 두 작업을 구분해야 한다.

- **가이드:** 매 실행 세션의 최초 사용 시 현재 선택된 바이너리에서 조회한다. 오래된 레포 복사본을 명령 사전으로 사용하지 않는다.
- **바이너리:** Orca 공식 업데이트 경로를 사용해 최신 안정 버전을 유지한다. 제품 자체의 다운로드·설치·자가 업데이트 로직을 만들지 않는다.

가이드 조회 성공만으로 설치된 Orca가 전 세계 최신 릴리스라고 표시하지 않는다. 자동 업데이트가 필요한 배포 환경에서는 기존 업데이트 정책과 권한 아래에서 공식 업데이트 경로를 사용한다. 검증하지 않은 update 명령을 계획에 고정하지 않는다.

진행 중인 작업에서는 실행 파일과 실행 계약을 유지한다. 바이너리가 바뀌면 다음 실행 경계에서 가이드를 다시 조회하고 기능을 확인한다. 살아 있는 워커를 임의로 교체하거나 재시작하지 않는다.

### 4.3 비용과 문맥 사용

- 같은 세션·바이너리의 동일 가이드를 매 도구 호출마다 다시 읽지 않는다.
- 자식 에이전트에 전체 가이드를 반복 전달하지 않고 사용한 바이너리 식별자와 필요한 참조를 전달한다.
- 새 호스트·다른 바이너리·버전 변경이면 새로 조회한다.
- 가이드 전문을 역할 skill이나 실행 prompt에 영구 복사하지 않는다.
- 실제 실행 증거용 hash와 “나중에 다시 실행할 명령 템플릿”을 구분한다.

## 5. 직접 연동 코드를 줄이는 방법

현재 `orca-org.mjs`의 `prepare`는 직접 `worktree create`의 argv를 구성하고 `result.worktree.path/id`를 파싱한다. PM/PL skill에도 감독 실행과 회수 명령 예시가 있다. 이 부분이 Orca 변경에 따라 유지보수해야 하는 접점이다.

### 5.1 목표 구조

```text
oh my teams
  작업 계약·역할 배정·검증 정책 결정
       ↓
  실행 에이전트가 공식 Orca 가이드 조회
       ↓
  현재 가이드에 따라 worktree / 감독 실행
       ↓
  실제 receipt와 실행 ID 수집
       ↓
oh my teams
  입력 스냅샷 고정·증거 확인·업무 gate 판정
```

skill에는 “격리된 작업 공간을 만들고 실제 ID를 기록한다” 같은 업무 요구를 둔다. 명령의 옵션 목록, 상세 응답 경로, 복잡한 회수 절차는 Orca 공식 가이드에 둔다.

### 5.2 `prepare` 분리 제안

1. **입력 준비:** 작업 계약·조직 설정 검증, base 확정.
2. **Orca 실행:** 공식 가이드에 따라 작업 공간 생성. 감독 경로는 Orca Run/Task/Dispatch를 사용.
3. **입력 연결:** 반환된 실제 worktree ID·경로·receipt를 받아 스냅샷을 저장.

가칭 `attach-workspace` 명령을 추가해 3번을 담당하게 한다. 현재 `prepare`는 한 번에 제거하지 않고 호환 진입점으로 유지한 뒤 이전한다.

입력 연결에서는 경로 존재, Git 저장소, 요청한 base와 실제 상태, task 연결, receipt의 필수 식별자를 확인한다. 임의로 적은 ID를 실제 Orca 실행 증거로 취급하지 않는다. Orca 조회가 필요하면 같은 바이너리의 현재 가이드를 사용한다.

동적 가이드를 읽는 에이전트는 명령 변경에 적응할 수 있지만 결정적 Node 프로그램이 자연어 가이드만으로 자동 적응한다고 가정하지 않는다. 무인 실행에 직접 CLI 호출이 꼭 필요한 접점은 작은 모듈 하나에 모으고, 지원 범위를 계약 테스트로 확인한다.

**첫 이름 변경 릴리스에서는 prepare의 동작을 유지한다.** 입력 준비/연결 분리는 별도 변경으로 수행해 경로 이전과 실행 방식 변경의 실패 원인을 구분한다.

### 5.3 남길 코드와 제거할 중복

남길 것:

- 조직·작업 schema와 스냅샷 관리.
- 허용 파일과 편집 해시 검증.
- 실행 결과·검사 증거·검토·수용 gate.
- workflow 전체 예산과 업무 실패 분류.
- Orca가 반환한 식별자와 결과를 연결하는 최소 기록.

복제하지 않을 것:

- Orca 터미널 관리와 자체 polling 프레임워크.
- worktree lifecycle 및 프로세스 회수 구현.
- Task/Dispatch/settlement의 별도 대체 구현.
- Orca CLI 옵션 전체와 대규모 응답 schema.
- Orca 바이너리 업데이트 관리자.

## 6. 오류·호환성 정책

| 상황 | 처리 |
|---|---|
| 선택한 실행 파일을 실행할 수 없음 | 정확한 오류 보고. 다른 Orca 실행 파일로 조용히 전환하지 않음 |
| 가이드 조회 실패 | 오류를 보존. 기억한 명령으로 쓰기 작업을 계속하지 않음 |
| 구버전이 `skills get`을 명시적으로 모름 | 공식 stub의 제한된 읽기 전용 fallback만 사용하고 업데이트 필요 표시 |
| 필요한 기능이 현재 가이드에 없음 | 해당 기능을 지원 불가로 표시. 대체 실행 경로는 확인된 경우에만 사용 |
| CLI 응답 필드 변경 | 새 필수 정보가 실제 조회로 확인될 때까지 결과 연결 차단 |
| 타임아웃 뒤 리소스 생성 여부 불명 | 현재 상태 조회 후 receipt 복구. 생성 명령부터 재실행하지 않음 |
| 실행 중 바이너리 버전 변경 | 기존 실행 상태 보존, 다음 동작 전 가이드·기능 재확인 |

“최신 버전을 사용한다”는 이유로 오류를 성공 처리하거나 미확인 상태를 추정하지 않는다. 공식 가이드 조회 방식은 유지보수 비용을 줄이지만 호환성 검사를 없애지는 않는다.

## 7. 설치와 기존 사용자 이전

### 7.1 설치 ID 변경

새 marketplace/plugin 이름은 호스트에서 별도 설치로 인식될 수 있다. 표시명 변경만으로 기존 설치가 갱신된다고 가정하지 않는다.

- 새 설치: 새 ID를 설치하고 새 skill 호출명을 안내한다.
- 기존 설치: 이전 ID 존재를 확인하고 설정·조직 파일 위치를 보존한다.
- 호스트가 지원하는 이전·제거 절차를 확인한 뒤 중복 활성화를 방지한다.
- 기존 plugin 제거 전에 새 plugin 발견과 설정 재사용을 확인한다.
- 이번 계획은 실제 전역 재설치나 기존 plugin 삭제를 실행하지 않는다.

호스트 명령은 구현 시 현재 공식 절차로 확인한다. Orca 가이드가 Claude/Codex의 plugin 설치 명령까지 정의한다고 가정하지 않는다.

### 7.2 호환 경로

- 파일 경로 이전 후 필요하면 이전 런타임 경로에 짧은 forwarding 진입점만 유지한다. 구현을 복제하지 않는다.
- `/orca:pm` 같은 namespace alias는 호스트 지원 여부를 확인한다. 지원하지 않으면 문서로 새 호출명을 안내하고 동작한다고 약속하지 않는다.
- 전체 구 plugin을 복제해 무기한 두 벌로 유지하지 않는다.
- 기존 조직 revision, 모델·계정·구독, fallback을 그대로 재사용한다.
- 초기 이름 변경 단계에서는 기존 `.orca` 기록을 자동 이동하거나 삭제하지 않는 것으로 계획했다. 이후 기존 사용자가 없음을 확인했으므로 1.5.0에서는 migration 없이 제품 상태 경로를 `.omt/`로 변경했다.
- 기존 worktree와 실행 중인 worker는 이름 변경 때문에 종료하거나 다시 만들지 않는다.

### 7.3 되돌리기

이전 릴리스의 manifest와 설치 경로를 기록한다. 새 설치 발견에 실패하면 기존 설치를 사용할 수 있도록 유지한다. 코드 rollback과 사용자 설정 rollback을 구분하고, 이름 변경 때문에 새로 만든 정상 조직 설정을 덮어쓰지 않는다.

## 8. 단계별 구현

### R0 — 식별자와 영향 범위 확정

- 이 문서의 이름 매핑을 확정한다.
- 양쪽 marketplace와 manifest, 설치기, import, 예제, 문서의 현재 참조를 조사한다.
- 새 plugin ID와 호출 namespace의 호스트 지원을 확인한다.
- 기존 테스트를 기준선으로 기록한다.

완료 기준: 바꿀 제품 식별자와 유지할 Orca 고유명 목록이 분명하다.

### R1 — 이름과 경로 변경

- plugin 디렉터리·런타임 파일·package·manifest·marketplace·설치 참조를 함께 이전한다.
- README와 활성 skill의 제품명을 갱신한다.
- tests/experiments의 실행 참조를 갱신하고 역사 기록은 보존한다.
- 필요한 최소 forwarding 경로와 이전 안내를 추가한다.
- 실제 로컬 폴더와 원격 저장소 rename은 별도 범위로 유지한다.

완료 기준: 새 이름으로 로컬 검증이 통과하고 manifest의 source·skills 경로가 유효하다.

### R2 — Orca discovery 안내 통합

- 짧은 공통 참조 문서 `references/orca-runtime.md`를 추가한다.
- 역할 skill에서 공식 orca-cli/orchestration 조회로 연결한다.
- 현재 skill에 복사된 변동성 높은 CLI 레시피를 줄인다.
- 실행 바이너리·버전·가이드 식별자 기록 형식을 정한다.

완료 기준: 새 세션이 저장소에 복사된 오래된 옵션 없이 현재 가이드를 통해 실행 경로를 찾는다.

### R3 — prepare와 Orca 호출 경계 축소

- 작업 입력 준비와 workspace 연결을 분리한다.
- 명시적 receipt 입력과 실제 상태 대조를 구현한다.
- 직접 호출이 필요한 접점은 작은 모듈로 제한한다.
- 기존 prepare 경로의 폐기 조건과 이전 기간을 문서화한다.

완료 기준: Orca 명령 변화가 조직·검증 코드 전체의 변경으로 번지지 않는다.

### R4 — 설치 이전과 연동 검증

- 새 설치와 기존 설치 이전을 각각 검증한다.
- 양쪽 호스트에서 skill 발견과 기존 조직 설정 재사용을 확인한다.
- 허용된 실제 환경에서 가이드 조회, worktree receipt 연결, 감독 결과 인계의 smoke 검증을 수행한다.
- 설치·리소스 변경은 실제 구현 단계의 권한 범위 안에서 수행한다.

완료 기준: 새 이름으로 실행하면서 구독을 재설정하지 않고 기존 기록을 읽을 수 있다.

## 9. AI-native 조직 계획과 연결

| 기존 계획 | 이번 계획에서 반영할 점 |
|---|---|
| P0 기준선 | R0와 같이 조사해 중복 작업 줄임 |
| P1 작업 계약 | 브랜드 문자열 대신 안정적인 task/workflow ID 사용 |
| P2 검토 gate | Orca 버전과 무관한 업무 규칙으로 유지 |
| P3 역할 연결 | R2 discovery 공통 참조 사용 |
| P4 workflow 복구 | Orca 감독 기능을 재구현하지 않고 실제 ID·receipt와 업무 상태를 연결 |
| P5 조직 eval | 선택된 바이너리와 가이드 정보도 재현 조건에 포함 |

권장 순서: R0 → R1 → R2 후 AI-native P1–P3를 진행한다. R3는 P4 설계 전에 완료해 직접 CLI 의존 코드가 늘어나지 않게 한다. 이름 변경과 행동 변경은 별도 PR로 나눌 수 있게 유지한다.

## 10. 검증과 완료 조건

- [x] 활성 제품 표시명이 `oh my teams`로 일관된다.
- [x] 두 marketplace·manifest·설치기의 ID와 경로가 일치한다.
- [x] 기존 조직 설정과 실행 기록이 보존된다.
- [x] 역할명과 모델·계정 선택이 이름 변경 때문에 바뀌지 않는다.
- [x] 실제 Orca 명령과 ORCA_* 환경변수는 제품명 치환 대상에서 제외된다.
- [x] 레거시 기록과 과거 실험 결과를 잘못 고쳐 쓰지 않는다.
- [x] 로컬 import, CLI help, schema 예제, 기존 런타임 테스트가 통과한다.
- [x] 최신 가이드는 선택된 바이너리에서 조회하며 repo에 전문을 복제하지 않는다.
- [x] 가이드 조회 실패·구버전·다른 실행 파일·변경된 응답을 구분한다.
- [x] 가이드 조회만으로 “최신 바이너리 설치 완료”라고 표시하지 않는다.
- [x] 실행 중 업데이트와 중복 리소스 생성 시나리오를 검증한다.
- [x] 설치 이전은 새 plugin 발견을 확인한 뒤 기존 plugin 처리로 진행한다.
- [x] 제품 문서에 지원되는 경로와 아직 계획인 CLI를 구분한다.

이 계획의 성과는 제품 이름이 명확해지는 것과 함께, Orca가 업데이트될 때 oh my teams의 업무 규칙·검증 코드·역할 지침을 광범위하게 수정할 필요가 줄어드는 것이다.
