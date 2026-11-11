# AI 작업 안내

이 문서는 이 저장소를 수정하는 AI가 필요한 코드와 검사를 찾는 진입점이다. `4d423a9`의 분석과 3.3.0의 작업 흐름 개선을 반영했다. 현재 HEAD와 도구 버전은 작업 때 다시 확인한다. 상세 판단과 근거는 [프로젝트 분석](PROJECT_ANALYSIS.md)에 있으며, 작업 지침은 루트 [AGENTS.md](../AGENTS.md)를 따른다.

## 처음 읽을 때

1. `AGENTS.md`와 실제 사용자 요청에서 작업 범위·전달 권한을 확인한다. 현재 Orca 워크트리와 소유 세션을 확인하고 기존 변경을 보존한다. Orca 명령은 해당 실행 파일의 `orca-cli` 가이드를 먼저 읽는다.
2. [README](../README.md)에서 제품 경계를 확인한다. OMT는 스킬 패키지이며 별도의 스케줄러·역할 실행기를 제공하지 않는다. 일반 개발 요청은 현재 소유 세션이 직접 처리한다.
3. 아래 변경 영향 표에서 관련 파일과 테스트를 찾는다. 전체 과거 분석과 평가 원본을 매번 읽을 필요는 없다.
4. 새 체크아웃은 `npm ci`로 의존성을 복원한다. 이미 작업 중인 체크아웃은 현재 Git 상태와 필요한 기준 검사를 먼저 확인한다. 개발용 Node 버전 요구는 [package.json](../package.json)을 읽는다.
5. 요청 종류에 맞는 `feat/`, `fix/`, `refactor/`, `docs/` 브랜치를 사용한다. `main`에서 직접 개발 커밋을 만들지 않는다. 독립적인 동시 편집이 필요한 경우에만 Orca의 별도 작업 공간으로 분리하며, 읽기 전용 검토를 위해 새 워크트리를 만들지 않는다.

다음 명령은 저장소에서 실행하는 읽기 전용 시작 점검이다. 원격과의 최신 비교가 필요하면 `git fetch origin` 후 `origin/main`과 대조한다. Git 결과만으로 Orca의 소유 세션을 추정하지 않는다.

```sh
git status --short --branch
git rev-parse HEAD
git diff --stat
git log -5 --oneline
node --version
npm run sync:check
```

## 무엇이 어디의 정본인가

| 확인할 내용 | 먼저 읽을 정본 | 사용 원칙 |
|---|---|---|
| 사용자 목표와 허가 | 현재 사용자 요청과 해당 작업에서 이미 확인한 결정이다. | 분석 문서의 제안이나 예제 값을 실행 권한으로 바꾸지 않는다. |
| 편집 소유권·전달·회수 | [설치 정책](../plugins/oh-my-teams/references/architecture.md)과 관련 스킬이다. | 새 등록부를 만들어 Orca 상태를 복제하지 않는다. |
| 실행 환경 점검 | [환경 진단](../plugins/oh-my-teams/references/diagnostics.md)의 점검 ID와 판정이다. | `unknown`을 `pass`로 채우지 않으며 진단 중에 상태를 바꾸지 않는다. |
| 실행·세션·인스턴스 | 현재 호스트의 Orca 관측이다. | 불완전한 목록과 응답 유실을 종료·삭제 성공으로 해석하지 않는다. |
| 소스·전달·검사 | 실제 Git SHA, PR·CI와 해당 로그다. | 이전 HEAD의 검사와 자기 검토를 최신 독립 검토의 승인으로 사용하지 않는다. |
| 버전 | [package.json](../package.json)이다. | 잠금 파일은 npm으로, 세 매니페스트는 `sync`로 갱신한다. |
| 통신 문서 | [JSON Schema](../plugins/oh-my-teams/references/documents/document.schema.json)와 [YAML 사용 규칙](../plugins/oh-my-teams/references/documents/protocol.yaml)이다. | JSON·HTML은 검증한 같은 객체의 파생 결과다. |
| 개발 API·검사 한계 | [DEVELOPMENT.md](DEVELOPMENT.md)와 [CODE_QUALITY.md](CODE_QUALITY.md)다. | 문서 검사 통과와 실제 호스트 동작의 성공을 구분한다. |
| 분석·과거 평가 | [현재 분석](PROJECT_ANALYSIS.md), [이슈 분류](ISSUE_TRIAGE.md), [평가 기록](../evals/README.md)이다. | 기준 커밋·환경·정책 해시가 다른 결과를 현재에 소급하지 않는다. |

## 요청별 수정 위치와 검증

표의 검사는 작업 중 원인을 좁힐 때 사용하는 경로다. 최종 공통 검증은 아래의 전체 명령을 따른다.

| 요청·증상 | 먼저 읽고 수정할 위치 | 함께 확인할 테스트·문서 |
|---|---|---|
| 스킬 선택·소유권·종료 지침을 바꾼다. | 해당 [skills](../plugins/oh-my-teams/skills/)와 [architecture.md](../plugins/oh-my-teams/references/architecture.md), [failure-handling.md](../plugins/oh-my-teams/references/failure-handling.md)를 읽는다. | [package-contract](../tests/package-contract.test.mjs), [SCENARIO_CHECKS](SCENARIO_CHECKS.md), 필요 시 실제 호스트 평가를 확인한다. 문구 고정 테스트를 무조건 추가하지 않는다. |
| 새 스킬을 추가하거나 설치 경로가 실패한다. | [plugin-validation](../scripts/core/plugin-validation.mjs), [plugin-documents](../scripts/core/plugin-documents.mjs), [plugin-paths](../scripts/core/plugin-paths.mjs)와 호스트 매니페스트를 읽는다. | [plugin-validation 테스트](../tests/plugin-validation.test.mjs), [설치 경계 테스트](../tests/package-contract.test.mjs)를 실행한다. 고정된 7개 집합과 설치 복사본을 함께 확인한다. |
| frontmatter나 Markdown 링크·앵커가 실패한다. | [document-syntax 어댑터](../scripts/adapters/document-syntax.mjs)와 [공통 링크 검사](../scripts/core/plugin-documents.mjs)를 읽는다. | [document-syntax 테스트](../tests/document-syntax.test.mjs), [document-links 테스트](../tests/document-links.test.mjs)를 실행한다. |
| 저장소 README·AGENTS·개발 문서를 수정한다. | [repository-documents](../scripts/core/repository-documents.mjs)와 해당 문서를 읽는다. | [repository-documents 테스트](../tests/repository-documents.test.mjs)와 `npm run docs:check`로 확인한다. |
| 버전이 다르거나 Codex 날짜 값이 잘못됐다. | [metadata 진입점](../scripts/metadata.mjs), [version-sync](../scripts/core/version-sync.mjs), [version-syntax](../scripts/adapters/version-syntax.mjs)를 읽는다. | [metadata 테스트](../tests/metadata.test.mjs), [복구 계약](METADATA_RECOVERY.md)을 확인한다. 매니페스트를 수동으로 맞추지 않는다. |
| 쓰기·교체·복구 중 충돌이나 오류가 발생한다. | [node-files 어댑터](../scripts/adapters/node-files.mjs)와 [FilesPort](../scripts/core/ports.mjs)를 읽는다. | [node-files 테스트](../tests/node-files.test.mjs)와 실제 자식 프로세스 중단을 다루는 metadata 테스트를 확인한다. |
| 스킬의 읽기 분량 검사가 실패하거나 측정 범위를 바꾼다. | [reading-budget](../scripts/core/reading-budget.mjs), [진입점](../scripts/check-reading.mjs)과 [스킬별 상한](../scripts/reading-budget.json)을 읽는다. `npm run reading:check -- --files`로 스킬별 파일과 문자 수를 확인한다. | [reading-budget 테스트](../tests/reading-budget.test.mjs)와 [검사 범위](CODE_QUALITY.md#검사-범위와-한계)를 확인한다. 링크를 줄이거나 문서를 나누어 해결하고, 상한을 올릴 때에는 이유를 기록한다. |
| JSDoc·import·전역 변수·경로 정규식 진단이 잘못됐다. | [source-quality](../scripts/core/source-quality.mjs)와 [javascript-syntax](../scripts/adapters/javascript-syntax.mjs)를 읽는다. | [source-quality 테스트](../tests/source-quality.test.mjs)와 [검사 범위](CODE_QUALITY.md#검사-범위와-한계)를 확인한다. |
| 진단 항목·목표 재대조·검토 기준을 바꾼다. | [diagnostics.md](../plugins/oh-my-teams/references/diagnostics.md), [작업 흐름](../plugins/oh-my-teams/references/task-workflow.md#목표를-다시-대조한다), [consult](../plugins/oh-my-teams/skills/consult/SKILL.md)를 읽는다. | [SCENARIO_CHECKS](SCENARIO_CHECKS.md)와 [호스트 평가 기준](../evals/TASK_WORKFLOW.md)의 해당 사례를 대조한다. 스키마의 `severity` 값은 바꾸지 않는다. |
| 통신 문서에 필드나 상태를 추가한다. | 스키마·protocol·해당 [YAML 예제](../plugins/oh-my-teams/references/documents/)와 [문서 core](../scripts/core/omt-documents.mjs)를 함께 읽는다. | [omt-documents 테스트](../tests/omt-documents.test.mjs), [lifecycle-documents 테스트](../tests/lifecycle-documents.test.mjs)와 HTML의 필드 보존을 확인한다. |
| 완료 근거와 원래 작업의 검증 조건을 대조한다. | [task-verification](../scripts/core/task-verification.mjs)과 [작업 흐름](../plugins/oh-my-teams/references/task-workflow.md)을 읽는다. | [검증 조건 테스트](../tests/task-verification.test.mjs)와 [호스트 평가 기준](../evals/TASK_WORKFLOW.md)을 확인한다. |
| YAML 파싱·변환 CLI·출력 문제가 발생한다. | [documents 진입점](../scripts/documents.mjs)과 [문서 어댑터](../scripts/adapters/omt-documents.mjs)를 읽는다. | 파일·표준 입력·기존 출력 보존과 요청 대응의 CLI 테스트를 확인한다. |
| Linux·macOS CI가 실패한다. | [Jenkinsfile](../Jenkinsfile), [.ci](../.ci/), [CI 설명](DEVELOPMENT.md#자동-품질-검사와-ci)을 읽고 실제 실패 로그를 확인한다. | [Git 환경 변수 검사](../tests/ci-git-config.test.mjs)를 확인한다. 환경 실패와 코드 실패, 건너뛴 단계를 구분한다. |

## 구현할 때 유지할 계약

`core`에는 실제 파일·프로세스 접근과 외부 파서 import를 추가하지 않는다. `node:path`를 제외한 Node 기능과 외부 라이브러리는 어댑터에 두며 진입점이 조합한다. 시간도 진입점에서 주입한다. 포트는 [ports.mjs](../scripts/core/ports.mjs)의 구조를 사용하며 새 추상 계층은 실제로 반복되는 필요가 있을 때만 추가한다.

활성 `.mjs`에는 모듈 JSDoc을, 공개 export에는 인접 JSDoc을 작성한다. 공개 함수의 `@param`·`@returns`와 주석을 제외한 180자 줄 제한을 확인하고 형식은 Prettier에 맡긴다. 새 `.mjs`도 커밋 전에 검사되므로 임시 실험 스크립트는 저장소 밖 OS 임시 디렉터리에 둔다.

공개 진입점의 기존 호출을 보존한다. 특히 `validatePlugin(pluginRoot, options)`, `synchronize(write, options)`의 반환값·예외 계약을 바꿀 때에는 CLI·테스트·실행 가능한 예제를 함께 확인한다. 대체 JavaScript 파서는 `ast`, `comments`, `bindings`, `globals` 네 필드를 반환해야 한다. 자세한 타입과 예제는 [개발 안내](DEVELOPMENT.md#의존성-방향과-포트)를 따른다.

설치되는 Markdown의 로컬 링크는 반드시 플러그인 안에서 해결돼야 한다. 저장소의 `docs/`, `scripts/`, `tests/`로 연결해 설치 의존성을 만들지 않는다. 상대 경로의 문법뿐 아니라 실제 경로도 검사하므로 심볼릭 링크로 경계를 우회할 수 없다. 저장소 개발 문서는 저장소 안의 코드로 연결할 수 있다.

통신 문서 파서는 스킬 frontmatter 파서와 다르다. 통신 YAML의 앵커·별칭·태그를 허용하도록 완화하거나, frontmatter의 정상 앵커까지 일괄 금지하는 변경을 서로의 오류 수정으로 처리하지 않는다. 보고서가 단독으로 유효한 것과 원래 요청에 대응하는 것도 다르다. 검토 결과에는 `--request`, 완료·중단 보고에는 `--task`를 연결한다.

## 테스트와 최종 검증

기존 fixture는 실제 체크아웃을 바꾸지 않고 OS 임시 디렉터리에 설치 복사본을 만든다. [temporaryDirectory·pluginFixture·editManifest](../tests/helpers/plugin-fixture.mjs)를 사용하고, 한 조건을 바꾼 입력과 관찰 가능한 결과를 검사한다. 파일 오류는 파일 포트로, 파서 실패는 파서 포트로 주입한다. 전역 라이브러리를 바꾸거나 제품의 기대값을 그대로 가져와 비교하지 않는다.

네이티브 경로의 기대값은 `path.join()` 또는 양쪽 구분자를 허용하는 정규식으로 만든다. 경로 정규식 검사는 일부 형태만 진단하므로 통과만으로 Windows 호환성을 주장하지 않는다. 정적 스킬 문구의 위치를 고정하는 테스트보다 설치 경계·오류 처리·관찰 가능한 행동을 우선한다.

```sh
# 작업 중에는 관련 테스트를 실행한다.
node --test tests/source-quality.test.mjs
node --test tests/omt-documents.test.mjs tests/lifecycle-documents.test.mjs

# 작업이 끝나면 공통 검증을 실행한다.
npm run format
npm run sync
npm run lint
npm test
git diff --check
```

`npm run verify`는 `lint`와 `test`를 순서대로 묶는다. 앞 검사가 실패하면 뒤 검사는 실행되지 않으므로 로그에서 실제 수행 범위를 확인한다. Markdown은 Prettier 대상이 아니며, `docs:check`도 문장의 의미와 최신성을 확인하지 않는다.

루트 `AGENTS.md`는 존재할 때 `docs:check`에서 링크·앵커와 경계를 검사한다. 문장의 의미·지침의 충돌까지 검사하지는 않는다. 테스트 파일의 새 하위 디렉터리는 `npm test`의 두 glob에 자동 포함된다고 가정하지 말고 실행 경로를 확인한다.

## 문서 변환을 확인하는 방법

다음 명령은 번들 예제를 검증한다. 예제의 가상 세션·커밋·허가 근거를 실제 작업 보고로 그대로 제출하지 않는다.

```sh
node scripts/documents.mjs check plugins/oh-my-teams/references/documents/review-result.example.yaml --request plugins/oh-my-teams/references/documents/review-request.example.yaml
node scripts/documents.mjs check plugins/oh-my-teams/references/documents/completion-report.example.yaml --task plugins/oh-my-teams/references/documents/task-request.example.yaml
node scripts/documents.mjs check plugins/oh-my-teams/references/documents/verified-completion.example.yaml --task plugins/oh-my-teams/references/documents/verified-task.example.yaml
```

HTML 출력 경로는 저장소 밖 OS 임시 디렉터리에서 아직 없는 파일로 지정한다. 출력 경로가 있으면 CLI는 덮어쓰지 않고 실패한다. JSON을 다른 프로그램에 연결할 때에는 npm의 실행 로그가 섞이지 않도록 `node scripts/documents.mjs`를 직접 호출한다. 설치 패키지에 저장소 변환 명령이 포함돼 있다고 안내하지 않는다.

## 버전·전달과 작업 재개

설치 정책·배포 파일·공개 동작을 바꾸면 `AGENTS.md`의 호환성 규칙에 맞춰 정본 버전부터 정한다. 버전 변경 후 `npm install`, `npm run sync`를 실행한다. 저장소 분석 문서만 수정하고 설치 내용이나 공개 계약을 바꾸지 않는 작업은 불필요한 릴리스를 만들지 않는다. 유효한 기존 Codex 날짜는 보존되므로 sync 이후 날짜가 그대로라는 이유만으로 오류로 판단하지 않는다.

병합을 수행할 때에는 그 작업의 허가, 대상 브랜치와 포함 커밋을 확인하고 최종 HEAD에 대응하는 Jenkins Linux·macOS 결과를 확보한다. CI 목록이 비어 있으면 미등록 여부와 실행 경로를 조사한다. 이미 빌드 ID가 있으면 같은 빌드를 확인하고, 관측 실패를 이유로 중복 실행하지 않는다. 로컬 단위 테스트와 과거 CI 결과로 최신 검사의 성공을 대신하지 않는다.

사용자에게 작업 결과를 전달할 때에는 변경한 파일·이유, 실제 수행한 검사와 결과, 수행하지 못한 검사, 남은 변경과 전달 위치를 구분한다. 새 요청의 `verification`으로 필수 CI·독립 검토·전달 관측 기록을 정한다. 검증기는 기록된 소스 SHA와 전달 방식·대상을 대조하지만, `delivery.reference`의 실제 대상과 근거의 진위는 소유 세션이 Git·PR·CI에서 확인한다. 문서 양식의 허가 문자열도 실제 사용자 허가를 증명하지 않는다.

작업을 재개하면 Orca의 실제 세션·전체 워크트리 ID·인스턴스와 Git HEAD·미전달 변경을 다시 확인한다. Goal 차단 해소, 앱·CLI 연결 문제와 응답 유실은 [실패 판단](../plugins/oh-my-teams/references/failure-handling.md)을 따른다. 과거 `.omt` 기록이나 분석 문서에 적힌 ID를 현재 실행으로 재사용하지 않는다.

## 문서 유지와 후속 작업

| 변경한 대상 | 함께 확인할 문서 |
|---|---|
| 제품의 소유권·실패 판단·스킬 선택이다. | 설치 스킬·참조 문서를 정본으로 바꾸고 README와 시나리오의 설명을 대조한다. |
| 공개 API·포트·검증 흐름이다. | [개발 안내](DEVELOPMENT.md), 실행 가능한 예제와 이 안내의 수정 위치 표를 확인한다. |
| 검사 범위·제한이다. | [코드 품질 안내](CODE_QUALITY.md)와 [현재 분석](PROJECT_ANALYSIS.md)의 해당 한계를 확인한다. |
| 통신 문서의 필드·불변 조건이다. | 스키마·protocol·여덟 예제·문서 core·검증 조건·HTML 표시·테스트를 함께 대조한다. |
| 실제 호스트·장애 실험의 결과다. | [평가 기록](../evals/README.md)과 해당 [후속 작업](todo/README.md)에 새 환경·정책 해시·관측 근거를 연결한다. |

후속 개발은 [현재 분석의 우선순위](PROJECT_ANALYSIS.md#8-현재의-한계와-개선-우선순위)에서 선택한다. 실제 호스트 검증과 외부 전달 증거의 확인을 우선하며, 진단 통일·분석 모듈 분리·복구 보장 확대는 구체적인 요구가 생겼을 때 설계한다. 과거 이슈를 닫거나 장애 실험을 실행하는 권한은 이 문서에 포함되지 않는다.
