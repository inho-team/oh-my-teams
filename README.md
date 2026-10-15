# oh my teams

Claude Code와 Codex에서 사용하는 Orca 중심 팀 작업 스킬이다. **워크트리마다 소유 세션 하나**가 목표, 편집, 검증과 전달을 책임진다. advisor·lawyer·auditor는 필요할 때 소유 세션이 호출하는 읽기 전용 전문 서브에이전트다. OMT는 별도의 이사·PM·Worker 조직이나 실행 등록부를 운영하지 않는다.

## 사용

| 스킬 | 동작 |
|---|---|
| `kickoff` | 현재 Orca 워크트리의 소유 세션에서 팀 작업을 시작하거나 재개한다. |
| `consult` | advisor·lawyer·auditor 목적의 전문 서브에이전트에게 좁은 검토를 맡긴다. |
| `status` | Orca 세션과 워크트리, Git 상태를 함께 확인한다. |
| `close` | 결과를 검증·전달하고 안전한 자식 워크트리를 회수한다. |
| `disband` | 실패하거나 취소된 작업의 복구 가능한 결과를 보존한다. |
| `help` | 스킬의 사용 시점을 안내한다. |
| `fluent-korean` | 한국어 문서와 보고서의 문체를 점검한다. |

일반적인 수정·조사·QA는 현재 세션에서 직접 처리한다. 여러 세션의 협업이나 지속 감독을 사용자가 요청한 경우에만 `kickoff`를 사용한다. 읽기 전용 검토에는 새 워크트리를 만들지 않는다. 독립적인 동시 편집에만 Orca 자식 워크트리를 만든다. 각 워크트리의 소유 세션은 Orca에서 확인할 수 있어야 한다.

작업 소유권, 독립 검토와 회수 기준은 플러그인에 포함된 [세션 소유권 구조](plugins/oh-my-teams/references/architecture.md)에 정리했다. PR/MR 생성 요청만으로 병합 권한을 추정하지 않으며, 결과 전달과 워크트리 정리 상태도 각각 보고한다. Orca 명령은 설치된 버전의 `orca-cli` 가이드를 확인한 뒤 실행한다.

`consult`의 요청·결과와 `status`의 보고 본문은 [YAML 문서 규칙](plugins/oh-my-teams/references/documents/protocol.yaml)을 따른다. 설치 패키지에는 JSON Schema와 YAML 예제를 포함한다. 코드는 검증한 JSON 호환 객체를 처리하며 사용자에게 보여주는 문서는 같은 데이터에서 HTML로 생성한다. 호스트의 `SKILL.md` 진입점과 도구 인자 형식은 유지한다.

## 설치

이 저장소를 로컬 마켓플레이스로 추가하고 플러그인을 설치한다. Claude Code 또는 Codex 중 사용하는 호스트에 해당하는 명령만 실행한다.

```sh
claude plugin marketplace add /absolute/path/to/oh-my-teams
claude plugin install oh-my-teams@oh-my-teams
```

```sh
codex plugin marketplace add /absolute/path/to/oh-my-teams
codex plugin add oh-my-teams@oh-my-teams
```

Orca와 Git을 사용할 수 있어야 한다. 플러그인은 사용자 설정 파일에 직접 쓰지 않으며 별도의 Node 런타임, 모델 라우터 또는 OpenCodex 설치가 필요하지 않다. 설치한 스킬은 새 에이전트 대화에서 사용한다.

## 2.x에서 변경된 점

3.0.0은 의도적인 비호환 변경이다. 기존 `form`, `adjust`, `director`, `pm`, `worker`, `auditor` 역할 스킬과 `teams-org.mjs` CLI를 제거했다. 새 실행은 `.omt` 조직·kickoff·workflow 기록을 읽거나 자동 변환하지 않는다. 과거 기록은 지우지 않으며, 진행 중인 2.x kickoff는 2.x 플러그인으로 종료해야 한다. 이전 구현과 문서는 Git 커밋 `bfd1e8b`에서 확인할 수 있다.

## 개발

```sh
npm ci
npm run format
npm run sync
npm run lint
npm test
```

`npm run quality`는 활성 스킬의 이름과 링크, 이전 런타임 명령 참조를 검사한다. 공통 문서를 포함한 모든 로컬 링크는 플러그인 안에서 해결돼야 한다. `npm test`는 저장소 없이 플러그인 폴더만 복사한 설치 구조에서도 이를 확인한다. `npm run sync`는 `package.json`의 버전을 마켓플레이스와 플러그인 매니페스트에 반영한다. Linux와 macOS의 Jenkins 검사에서도 린트와 테스트를 실행한다.

개발 모듈의 책임과 공통 함수 사용법은 [개발 도구와 공통 예제](docs/DEVELOPMENT.md)에 정리했다. 실행 가능한 예제도 `npm test`에서 함께 검사한다.

전체 문서는 [개발 문서 안내](docs/README.md)에서 찾을 수 있다. 복잡도와 검증 공백의 근거, 재현 결과와 개선 우선순위는 [프로젝트 분석과 개선 계획](docs/PROJECT_ANALYSIS.md)에 정리했다.

저장소의 문서 변환 도구는 `npm ci` 후 사용할 수 있다. 이 명령은 설치 플러그인의 필수 실행 의존성이 아니다. 출력 경로를 생략하면 표준 출력으로 내보내며, 경로를 지정하면 기존 파일을 덮어쓰지 않는다.

```sh
npm run documents -- check plugins/oh-my-teams/references/documents/status-report.example.yaml
npm run documents -- json plugins/oh-my-teams/references/documents/status-report.example.yaml
npm run documents -- html plugins/oh-my-teams/references/documents/status-report.example.yaml /new/path/status.html
```

검토 결과에는 `--request /path/request.yaml`을 붙여 요청 식별자, 검토 목적과 대상 커밋도 대조할 수 있다. 구조 검사만으로 실제 근거의 진위나 실행 성공이 입증되지는 않는다. 자세한 처리 범위는 [개발 도구 안내](docs/DEVELOPMENT.md#내부-문서의-변환과-표시)에 정리했다.

## 라이선스

MIT 라이선스를 따른다. 자세한 내용은 [LICENSE](LICENSE)에 있다.
