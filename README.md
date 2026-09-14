# oh my teams

Claude Code·Codex용 **에이전트 조직 플러그인**. PM / PL / Senior / Junior / Worker의 역할과 모델·구독을 분리하고 Orca 위에서 작업을 실행한다. 런타임의 `intern` 역할 ID는 이전 조직과의 호환성을 위해 유지한다. 내부 실행기는 **Claude, Codex, Agy**이며, 독립 편집 작업과 통합에는 **Orca worktree**를 사용한다.

## 시작

| 스킬 | 동작 |
|---|---|
| `team-setup` | 조직 이름·구조와 각 직급의 구독/계정·모델·인원·대체 순서를 한 번 선택 |
| `team-show` | 조직도, 구독·모델, 작업 상태 표시 |
| `team-edit` | 요청한 설정만 수정, 이전 설정 보존 |
| `pm` | 저장된 조직으로 개발 요청 계획·배정·검증·통합 |

Claude에서는 `/oh-my-teams:team-setup`, `/oh-my-teams:pm` 등으로 호출한다. Codex에서는 플러그인의 해당 스킬을 호출하거나 같은 뜻으로 요청한다. 기존 `org-setup`, `org-show`, `org-edit`은 호환 별칭으로 유지한다. 조직 구성 후 구독을 다시 묻지 않는다. 실행 중 작업은 시작 당시 조직 스냅샷을 유지한다.

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

새 설치 식별자는 `oh-my-teams@oh-my-teams`다. 기존 `/orca:director` 호출은 이전 설치에서만 유지되며 새 namespace에서는 `pm`을 사용한다. 조직 설정과 실행 기록은 `.omt/`에 저장한다. `~/.orca-skills` 고정 링크는 사용하지 않는다. 이전 구현·실측은 [legacy/0.6.1](legacy/0.6.1/README.md)에 보존했고 자동 스킬 발견에서 제외했다.

## 모델과 구독

Agy에서 확인한 ID(2026-09-15): `gpt-oss-120b-medium`, `gemini-3.1-pro-high`, `gemini-3.8-flash-high`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`. 설치 때 `agy models`로 다시 확인한다. Claude·Codex의 미지정 모델은 `null`로 저장해 호스트 기본값을 쓴다.

기본 예제는 PM=Claude 호스트 기본 모델, PL=`gpt-5.6-sol`, Senior=`gemini-3.8-flash-high`, Junior=`claude-opus-4-6-thinking`, Worker=`claude-sonnet-4-6`으로 배정한다. 동시 인원은 `1 → 1 → 1 → 2 → 4`로 늘어난다. Junior 이상은 저장된 GPT-OSS 프로필을 보조 도구로 호출할 수 있지만, 호출한 역할이 결과를 검증하고 최종 판단을 책임진다.

Agy 프로필의 GPT-OSS·Sonnet·Opus는 모두 정확한 모델 ID를 `--model` 인자로 전달한다. 모델이 지원한다고 확인되지 않은 `--effort`는 추측해 추가하지 않으며, 요청 모델이 적용됐다는 증거가 없으면 기본 모델로 조용히 전환하지 않는다.

[조직 예제](plugins/oh-my-teams/examples/organization.json)는 구조 참고이며 실제 구독 선택을 대신하지 않는다. 프로필에는 실행기·명령 argv·계정 참조·구독 표시 이름·모델을 저장한다. 구독 공유가 가능하다. 별도 계정은 실제 CLI 프로필 인수 또는 환경변수 이름 참조로 연결한다. 계정 이름만 붙여 전환됐다고 처리하지 않으며, 비밀값을 JSON에 넣지 않는다.

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
npm run quality
```

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
