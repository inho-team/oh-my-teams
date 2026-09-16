# oh my teams

Claude Code·Codex용 **에이전트 조직 플러그인**. PM / PL / Senior / Junior / Worker의 역할과 모델·구독을 분리하고 Orca 위에서 작업을 실행한다. 런타임의 `intern` 역할 ID는 이전 조직과의 호환성을 위해 유지한다. 내부 실행기는 **Claude, Codex, Agy**이며, 독립 편집 작업과 통합에는 **Orca worktree**를 사용한다.

## 시작

| 스킬 | 동작 |
|---|---|
| `help` | 설치된 생애주기·역할·지원 스킬과 사용 시점을 표로 안내 |
| `form` | 상설 조직의 이름·구조와 직급별 구독/계정·모델·인원·대체 순서를 한 번 선택 |
| `kickoff` | 하나의 개발 Goal을 시작하거나 재개하고 완료 조건까지 지속 감독 |
| `status` | 상설 조직과 현재 Goal·실행 팀·워크트리·검증 상태를 구분하여 표시 |
| `adjust` | 요청한 상설 조직 설정만 수정하고 이전 설정 보존 |
| `close` | 성공한 Goal의 PR/MR·병합·워크트리 정리와 완료 기록 처리 |
| `disband` | 실패·취소된 실행 팀을 해체하고 복구 가능한 결과와 기록 보존 |

Claude에서는 `/oh-my-teams:form`, `/oh-my-teams:kickoff` 등으로 호출한다. Codex에서는 플러그인의 해당 스킬을 호출하거나 같은 뜻으로 요청한다. `pm`은 kickoff 내부의 지휘 역할로 유지한다. 조직 구성 후 구독을 다시 묻지 않는다. 실행 중 작업은 시작 당시 조직 스냅샷을 유지한다.

구독·모델·승인처럼 사용자가 정해야 하는 항목은 [사용자 선택 질문 계약](plugins/oh-my-teams/references/user-choice.md)을 따른다. 호스트가 구조화된 선택 도구를 제공하면 그것으로 묻고(Claude Code에서는 `AskUserQuestion`), 제공하지 않으면 번호를 매긴 선택지를 한 번에 제시한다. Codex CLI 0.154.0에는 이 용도로 확인된 도구가 없으므로 후자를 쓴다.

**2.0.0 비호환 변경:** 생애주기 스킬 이름에서 `team-` 접두어를 제거했다. `team-form`은 `form`, `team-kickoff`는 `kickoff`가 되었으며 `status`, `adjust`, `close`, `disband`, `help`도 같다. 이전 호환 별칭 `team-setup`, `team-show`, `team-edit`, `org-setup`, `org-show`, `org-edit`과 `director`는 모두 삭제했으므로 그 이름으로는 스킬을 찾을 수 없다. 조직 파일 형식과 런타임 명령은 바뀌지 않았으므로 기존 `.omt/` 설정은 그대로 쓴다.

`kickoff`는 호스트의 네이티브 Goal을 유일한 지속 실행 권한으로 사용한다. 같은 세션에서 Ralph, autopilot 또는 다른 Goal 루프를 함께 실행하지 않는다. 매 실행 주기에는 확인 가능한 진전을 남기며, 완료 조건과 최신 검증이 모두 충족된 뒤 `close`로 전달과 자원 정리를 마쳐야 Goal을 완료한다.

```text
PM       분석·중장기 계획·최종 결과
└─ PL    분석·중단기 계획·분할·통합
   └─ Senior  구체적인 구현 방법·중요 변경 검토
      └─ Junior  기능 구현·Worker 통합
         └─ Worker  제한된 편집·테스트·반복 실무
```

작은 작업에 다섯 세션을 모두 만들지 않는다. 실제 감독에는 Orca `orchestration`, 워크트리·터미널·회수에는 `orca-cli`, 웹 검증에는 `orca-browser-use`, 외부 앱에는 `computer-use` 스킬을 필요할 때 사용한다.

## 설치

Node.js 22+, Git, Orca와 사용할 실행기를 설치·로그인한다. PR 작업에는 `gh`가 필요하다. 새 런타임은 Python·macOS sandbox-exec에 의존하지 않는다.

```powershell
./install.ps1 -HostName both
```

```sh
sh install.sh both   # claude | codex | both
```

설치기는 현재 저장소를 호스트별 로컬 마켓으로 등록한다. 설치 후 **새 대화**에서 스킬을 사용한다. Claude 세션 전용 시험은 `claude --plugin-dir ./plugins/oh-my-teams`로 가능하다. 개발 변경 자체는 전역 설치나 사용자의 조직 설정을 자동 변경하지 않는다.

새 설치 식별자는 `oh-my-teams@oh-my-teams`다. 기존 `/orca:director` 호출에 대응하던 `director` 별칭은 2.0.0에서 삭제했으므로 지휘 역할은 `pm`으로 직접 부른다. 조직 설정과 실행 기록은 `.omt/`에 저장한다. `~/.orca-skills` 고정 링크는 사용하지 않는다. 이전 구현·실측은 [legacy/0.6.1](legacy/0.6.1/README.md)에 보존했고 자동 스킬 발견에서 제외했다.

## 모델과 구독

`agy models`가 반환한 ID(agy 1.2.3, 2026-09-15): `gemini-3.8-flash-{high,medium,low}`, `gemini-3.7-flash-{high,medium,low}`, `gemini-3.6-flash-{high,medium,low}`, `gemini-3.1-pro-{high,low}`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`.

Codex 계정의 모델 카탈로그(codex-cli 0.154.0, 2026-09-15)에는 `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.6-terra`가 선택 가능한 모델로 들어 있다. 설치 때 `agy models`와 Codex 카탈로그로 다시 확인한다. Claude·Codex의 미지정 모델은 `null`로 저장해 호스트 기본값을 쓴다.

기본 예제는 PM=Claude 호스트 기본 모델, PL=`gpt-5.6-sol`, Senior=`gemini-3.8-flash-high`, Junior=`claude-opus-4-6-thinking`, Worker=`claude-sonnet-4-6`으로 배정한다. 여기에 더해 `gpt-5.6-luna`와 `gpt-5.6-terra` 프로필을 미리 정의해 두므로, 역할의 `profile`만 바꾸면 다른 Codex 모델로 옮길 수 있다. 역할이 실제로 참조하는 프로필에는 강도를 적지 않았다. 강도 표기 예시는 어떤 역할도 참조하지 않는 `codex-terra`에만 두었으므로, 이 예제로 실행하는 호출의 추론 깊이는 이전과 같다. 공유 풀 소진 이후 모든 역할의 동시 실행 슬롯은 1로 고정했다. 조직의 `assistants`에 허용된 역할은 저장된 GPT-OSS 프로필을 보조 도구로 호출할 수 있다. 기본 예제에서는 Worker를 포함한 모든 역할이 허용되어 있으며, 호출한 역할이 결과를 검증하고 최종 판단을 책임진다.

Agy 프로필의 GPT-OSS·Sonnet·Opus는 모두 정확한 모델 ID를 `--model` 인자로 전달한다. 요청 모델이 적용됐다는 증거가 없으면 기본 모델로 조용히 전환하지 않는다.

### 추론 강도

프로필의 선택적 `effort` 필드가 추론 강도를 지정한다. 생략하면 어떤 강도 인자도 전달하지 않으므로 해당 CLI의 기본값을 그대로 쓴다. 실행기마다 전달 방식과 허용값이 다르며, 각 값은 설치된 CLI에서 확인한 것이다.

| 실행기 | 허용값 | 전달 방식 | 근거 |
|---|---|---|---|
| Agy | `low`, `medium`, `high` | `--effort <값>` | `agy --help`가 이 세 값을 명시한다. |
| Codex | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | `--config model_reasoning_effort=<값>` | `codex exec`에 전용 플래그가 없고, 값 목록은 계정의 모델 카탈로그에서 가져왔다. |
| Claude | 없음 | 해당 없음 | CLI가 강도 선택 수단을 제공하지 않으므로 `effort`를 지정하면 설정 오류로 거부한다. |

`effort`를 생략했을 때 실제로 적용되는 깊이는 런타임이 정하지 않고 각 CLI와 계정 설정이 정한다. Codex는 `~/.codex/config.toml`의 `model_reasoning_effort`가 있으면 그것을, 없으면 모델 카탈로그의 `default_reasoning_level`을 쓴다(확인 시점 기준 `gpt-5.6-sol`은 `low`, `gpt-5.6-luna`와 `gpt-5.6-terra`는 `medium`). Agy는 서버가 모델별로 내려주는 선택지에서 결정한다. 따라서 보고서의 `requestedEffort`가 `null`이라는 것은 기본 깊이를 뜻하지 않고 **런타임이 깊이를 지정하지 않았다**는 사실만 뜻한다. 실제 적용된 깊이는 측정하지 않았다.

지원 범위는 모델마다 다르다. Codex 카탈로그에서 `gpt-5.6-luna`는 `ultra`를 제공하지 않으며, Codex CLI는 알 수 없는 값을 거부하지 않고 그대로 전달하므로 런타임이 저장 시점과 호출 시점에 값을 검증한다. Agy는 `--effort is not supported for model`이라는 오류를 가지고 있어 모델에 따라 이 플래그를 거부한다. `agy models`의 표시 이름을 보면 Gemini 계열만 High/Medium/Low로 나뉘고 `claude-sonnet-4-6`과 `claude-opus-4-6-thinking`은 Thinking, `gpt-oss-120b-medium`은 Medium으로 고정되어 있는데, 이 세 모델이 `--effort`를 받아들이는지는 확인하지 않았다. 런타임은 모델별 지원 표를 내장하지 않으므로, 모델이 거부한 강도는 일반적인 실행기 실패로 드러난다.

Agy는 `gemini-3.8-flash-high`처럼 모델 ID 자체에 강도를 담는다. 이때 `effort`를 함께 적으면 같은 값이어야 하며, 서로 어긋나면 저장을 거부한다. 어느 쪽이 실제 호출에 적용되는지 확인하지 않은 채 보고서에 쓰이지 않은 강도를 기록하지 않기 위해서다. `claude-sonnet-4-6`과 `claude-opus-4-6-thinking`은 ID에 강도 접미사가 없으므로 이 제약을 받지 않는다.

[조직 예제](plugins/oh-my-teams/examples/organization.json)는 구조 참고이며 실제 구독 선택을 대신하지 않는다. 프로필에는 실행기·명령 argv·계정 참조·구독 표시 이름·모델과 선택적 추론 강도를 저장한다. 구독 공유가 가능하다. 별도 계정은 실제 CLI 프로필 인수 또는 환경변수 이름 참조로 연결한다. 계정 이름만 붙여 전환됐다고 처리하지 않으며, 비밀값을 JSON에 넣지 않는다.

`opus-first`는 Agy 역할을 Opus로 시작하는 평가 기준선이고, `balanced`는 Senior=Opus, Junior=Sonnet, Intern=GPT-OSS로 나눈다. [6유형 실측](experiments/ROUTING_REPORT.md)에서는 balanced가 6/6을 통과하며 Opus-first보다 토큰 9.7%, 모델 시간 16.0%를 줄여 잠정 권고가 됐다. 1회 배치이므로 기존 조직에는 자동 적용하지 않으며 `preset` 명령은 변경되는 역할만 먼저 보여준다. GPT-OSS 권고는 좁은 편집·인용으로 제한한다. 같은 공유 풀의 소진이 구조적으로 확인되면 그 풀의 다른 모델을 연쇄 호출하지 않는다. 구독의 실제 할당량 차감·가격은 토큰 수와 구분한다.

## 실행과 검증

```text
node plugins/oh-my-teams/scripts/teams-org.mjs --help
node plugins/oh-my-teams/scripts/teams-org.mjs validate --org plugins/oh-my-teams/examples/organization.json
node plugins/oh-my-teams/scripts/teams-org.mjs show --org plugins/oh-my-teams/examples/organization.json
node plugins/oh-my-teams/scripts/teams-org.mjs assist --org .omt/organization.json --task <task.json> --repo <worktree> --state .omt --role junior --kind research
node plugins/oh-my-teams/scripts/teams-org.mjs preset --org <project>/.omt/organization.json --name balanced --revision <revision>
node plugins/oh-my-teams/scripts/teams-org.mjs gate-check --task <task-v2.json> --report <report.json> --repo <worktree> --state <coordinator>/.omt
node plugins/oh-my-teams/scripts/teams-org.mjs workflow-status --id <workflow-id> --state <coordinator>/.omt
node plugins/oh-my-teams/scripts/teams-org.mjs incident-status --state <coordinator>/.omt
node --test tests/runtime.test.mjs
npm run eval:organization
node experiments/run-routing.mjs --mode e1 --max-calls 18 --dry-run
npm ci
npm run sync
npm run lint
```

버전과 감사 수치처럼 여러 파일이 되풀이하는 값은 `scripts/metadata.mjs`가 정본에서 파생한다. 파일마다 직접 고치지 않고 정본만 바꾼 뒤 `npm run sync`를 실행하며, `npm run sync:check`는 고치지 않고 어긋난 곳만 보고한다. 정본과 따라가는 파일의 대응은 [AGENTS.md](AGENTS.md)에 표로 정리했다.

제한된 편집은 기존 [task v1 예제](plugins/oh-my-teams/examples/task.json) 또는 목표·수용 기준·검토 요구를 고정하는 [task v2 예제](plugins/oh-my-teams/examples/task.v2.json)를 채워 `prepare` → `work`로 수행한다. `prepare`가 반환한 worktree·조직 스냅샷·작업 파일·공유 state를 그대로 전달한다. 여러 워커는 같은 coordinator state를 써야 동시 인원 제한이 적용된다. 복잡한 작업의 감독 실행은 PL 스킬을 따른다.

`assist`는 조직의 `assistants.<role>` 허용 목록에서 GPT-OSS-120B 프로필을 선택한다. `research`와 `checklist`는 파일을 수정하지 않고 검증된 인용과 감사 기록을 남긴다. `edit`는 호출자의 기본 모델을 바꾸지 않은 채 GPT-OSS를 한 번 호출하고, 기존 `work`와 동일한 파일 해시·허용 범위·검사·보고 관문을 적용한다. 비서 결과의 판단과 통합 책임은 호출한 역할에 남는다.

- 파일과 직전 실패만 모델에 전달하고, JSON 편집을 경로·원본 해시 대조 후 하네스가 적용한다.
- 검사 명령은 argv 배열이다. 호출과 재시도에 한도가 있고 실패를 통과로 바꾸지 않는다. 실패 편집은 보존한다.
- `.omt/runs/`에 조직 스냅샷·보고·사용량, `.omt/evidence/`에 검사 증거를 저장한다. `.omt/`는 Git에서 제외한다.
- `aggregate`는 누락·중복·실패를 확인하고 짧은 결과를 만든다. 모델 호출은 없다. `ready-for-verification`은 머지 승인이 아니다.
- task v2는 검사 통과 후 `submitted`가 되며, 다른 실행 ID의 필수 `review-record`와 PM의 `accept`가 같은 task/source에 고정되어야 최종 수용된다.
- workflow는 dependency revision, 역할별 동시 실행, review 대기, 전체 attempt/call 예산을 고정한다. 실행 receipt와 event를 append-only로 보존하며 상태가 불명확한 running attempt는 재배정하지 않는다.
- 실패는 requirement/scope/implementation/environment/contract/review/quota/process-unknown으로 분류해 담당자에게 돌리고, 재작업은 이전 attempt와 전체 예산을 보존한다. 해결 경험은 검증 전까지 lesson 후보일 뿐 skill을 자동 수정하지 않는다.
- 이슈·알림 입력은 기본 kill switch, dedupe key, 제안 한도, 관찰 기간과 무진전 중단을 적용한다. 생성 범위는 진단·수정 제안이며 배포 권한은 포함하지 않는다.
- `verify`는 HEAD·base·파일 내용·검사 argv·환경 지문·원본 로그가 모두 일치하는 성공만 재사용한다. 실패·소스 변경은 재검증한다. 외부 DB·도구 변화는 environment 지문에 반영해야 한다.
- 최종 통합 후 `merge-check`, 실제 PR HEAD·최신 remote base 대조, 프로젝트 필수 CI와 필요한 Senior 검토를 거친다. 해시는 무결성 검사이며 로컬 보고 작성자의 서명 인증은 아니다.
- 하네스는 push·PR·머지·배포를 자동 수행하지 않는다. PM/PL이 사용자 요청 범위에 따라 처리한다. 감독된 워커의 회수는 Orca accepted settlement와 실제 프로세스 종료 근거를 따른다.

테스트는 조직 저장·변경, 순환, 계정 연결, 편집 범위, 검증 캐시, 보고 누락, 승격·할당량·동시 실행을 확인한다. `experiments/`의 실험은 실제 Orca worktree와 구독을 사용하므로 명시적으로 실행한다.

활성 코드의 JSDoc·모듈 설명·장문 실행문 기준과 전수조사 결과는 [코드 품질 문서](docs/CODE_QUALITY.md)에 정리했다.

세 구현 계획의 완료 범위, 검증 근거와 의도적으로 남긴 후속 운영 검증은 [계획 완료 상태](docs/PLAN_STATUS.md)에 정리했다. 계획 문서의 초기 기준선과 미래형 문장은 당시 설계를 설명하며, 현재 지원 여부는 구현 기록과 계획 완료 상태를 우선한다.

확대 모델 실험은 `--dry-run`으로 6개 fixture와 호출 수를 먼저 확인한다. 실제 실행은 `--confirm-subscription-use`가 있어야 하며 E1은 18회, `opus-first`와 `balanced`는 각각 6회의 초기 호출을 사용한다. 실행 중 manifest를 계속 저장하고, 결과는 `summarize-routing.mjs`, 정확한 worktree 정리는 `finish-routing.mjs --confirm-close`로 처리한다.

## 라이선스

이 저장소는 [MIT 라이선스](LICENSE)로 배포한다. 출처 표시를 유지하면 사용, 수정, 재배포, 상업적 이용을 모두 허용한다.
