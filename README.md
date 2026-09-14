# orca-skills

Claude Code·Codex용 **Orca 조직 플러그인**. PM / PL / Senior / Junior / Intern의 역할과 모델·구독을 분리한다. 내부 실행기는 **Claude, Codex, Agy**이며, 독립 편집 작업과 통합에는 **Orca worktree**를 사용한다.

## 시작

| 스킬 | 동작 |
|---|---|
| `org-setup` | 조직 이름·구조와 각 직급의 구독/계정·모델·인원·대체 순서를 한 번 선택 |
| `org-show` | 조직도, 구독·모델, 작업 상태 표시 |
| `org-edit` | 요청한 설정만 수정, 이전 설정 보존 |
| `pm` | 저장된 조직으로 개발 요청 계획·배정·검증·통합 |

Claude에서는 `/orca:org-setup`, `/orca:pm` 등으로 호출한다. Codex에서는 플러그인의 해당 스킬을 호출하거나 같은 뜻으로 요청한다. 조직 구성 후 구독을 다시 묻지 않는다. 실행 중 작업은 시작 당시 조직 스냅샷을 유지한다.

```text
PM       요구·계획·최종 결과
└─ PL    분할·배정·통합
   ├─ Senior  설계·중요 변경 검토·어려운 실패
   └─ Junior  구현·Intern 통합
      └─ Intern  제한된 편집·인용·초안
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

설치기는 현재 저장소를 호스트별 로컬 마켓으로 등록한다. 설치 후 **새 대화**에서 스킬을 사용한다. Claude 세션 전용 시험은 `claude --plugin-dir ./plugins/orca`로 가능하다. 개발 변경 자체는 전역 설치나 사용자의 조직 설정을 자동 변경하지 않는다.

기존 `/orca:director`는 `pm` 호환 별칭이다. `~/.orca-skills` 고정 링크는 사용하지 않는다. 이전 구현·실측은 [legacy/0.6.1](legacy/0.6.1/README.md)에 보존했고 자동 스킬 발견에서 제외했다.

## 모델과 구독

Agy에서 확인한 ID(2026-09-14): `gpt-oss-120b-medium`, `gemini-3.1-pro-high`, `gemini-3.8-flash-high`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`. 설치 때 `agy models`로 다시 확인한다. Claude·Codex의 미지정 모델은 `null`로 저장해 호스트 기본값을 쓴다.

[조직 예제](plugins/orca/examples/organization.json)는 구조 참고이며 실제 구독 선택을 대신하지 않는다. 프로필에는 실행기·명령 argv·계정 참조·구독 표시 이름·모델을 저장한다. 구독 공유가 가능하다. 별도 계정은 실제 CLI 프로필 인수 또는 환경변수 이름 참조로 연결한다. 계정 이름만 붙여 전환됐다고 처리하지 않으며, 비밀값을 JSON에 넣지 않는다.

GPT-OSS는 작은 편집·인용·초안에 우선 사용한다. 예제는 **한 번 시도 후 지정된 Sonnet으로 승격**한다. [실측 비교](experiments/REPORT.md)처럼 재시도까지 포함하면 GPT-OSS가 더 많은 토큰을 쓸 수 있다. 구독의 실제 할당량 차감·가격은 토큰 수와 구분한다.

## 실행과 검증

```text
node plugins/orca/scripts/orca-org.mjs --help
node plugins/orca/scripts/orca-org.mjs validate --org plugins/orca/examples/organization.json
node plugins/orca/scripts/orca-org.mjs show --org plugins/orca/examples/organization.json
node --test tests/runtime.test.mjs
```

제한된 편집은 [작업 예제](plugins/orca/examples/task.json)를 채워 `prepare` → `work`로 수행한다. `prepare`가 반환한 worktree·조직 스냅샷·작업 파일·공유 state를 그대로 전달한다. 여러 워커는 같은 coordinator state를 써야 동시 인원 제한이 적용된다. 복잡한 작업의 감독 실행은 PL 스킬을 따른다.

- 파일과 직전 실패만 모델에 전달하고, JSON 편집을 경로·원본 해시 대조 후 하네스가 적용한다.
- 검사 명령은 argv 배열이다. 호출과 재시도에 한도가 있고 실패를 통과로 바꾸지 않는다. 실패 편집은 보존한다.
- `.orca/runs/`에 조직 스냅샷·보고·사용량, `.orca/evidence/`에 검사 증거를 저장한다. `.orca/`는 Git에서 제외한다.
- `aggregate`는 누락·중복·실패를 확인하고 짧은 결과를 만든다. 모델 호출은 없다. `ready-for-verification`은 머지 승인이 아니다.
- `verify`는 HEAD·base·파일 내용·검사 argv·환경 지문·원본 로그가 모두 일치하는 성공만 재사용한다. 실패·소스 변경은 재검증한다. 외부 DB·도구 변화는 environment 지문에 반영해야 한다.
- 최종 통합 후 `merge-check`, 실제 PR HEAD·최신 remote base 대조, 프로젝트 필수 CI와 필요한 Senior 검토를 거친다. 해시는 무결성 검사이며 로컬 보고 작성자의 서명 인증은 아니다.
- 하네스는 push·PR·머지·배포를 자동 수행하지 않는다. PM/PL이 사용자 요청 범위에 따라 처리한다. 감독된 워커의 회수는 Orca accepted settlement와 실제 프로세스 종료 근거를 따른다.

테스트는 조직 저장·변경, 순환, 계정 연결, 편집 범위, 검증 캐시, 보고 누락, 승격·할당량·동시 실행을 확인한다. `experiments/`의 실험은 실제 Orca worktree와 구독을 사용하므로 명시적으로 실행한다.
