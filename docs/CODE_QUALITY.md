# 코드 품질·문서화 기준

`legacy/` 역사 보존 영역과 생성·로컬 상태를 제외한 활성 코드를 대상으로 한다.

## 자동 관문

```sh
npm ci
npm run lint
npm test
```

`npm run lint`는 `npm run quality`의 문서화 검사와 `npm run format:check`의
포맷 검사를 함께 실행한다. 포맷 검사는 devDependency로 설치한 Prettier를
사용하기 때문에, 새로 클론한 작업 트리에서는 `npm ci`를 먼저 실행해야 한다.

GitHub Actions의 `CI` 워크플로는 `main` 대상 push와 모든 pull request에서
문서화 검사와 포맷 검사, 테스트를 각각 별도 단계로 실행한다. 다만 워크플로가
존재한다는 사실만으로 병합이 차단되지는 않는다. 병합을 실제로 막으려면 GitHub
저장소 설정에서 `verify` 체크를 required status check로 지정해야 한다.

`npm run eval:organization`은 CI에 포함하지 않은 수동 관문이다. 조직 구성이나
라우팅에 영향을 주는 변경에서는 직접 실행해서 결과를 확인한다.

`npm run quality`는 다음을 검사한다.

- 모든 활성 `.mjs` 파일의 모듈 JSDoc
- 모든 공개 `function`, `const`, `class` export의 인접 JSDoc
- 매개변수가 있는 공개 함수의 `@param`
- 모든 공개 함수의 `@returns`
- 180자를 넘는 실행문
- fixture의 prompt/test template처럼 의도적인 장문 데이터와 실행 코드를 구분

`npm run format:check`는 Prettier 3.9.6이 활성 `.mjs`와 `.json` 파일의
들여쓰기, 따옴표, 후행 쉼표, 줄바꿈을 규정한 형태와 일치하는지 확인한다.
포맷은 사람이 맞추는 대상이 아니므로, 어긋난 파일이 보고되면 `npm run format`을
실행해 일괄로 정렬한다. `legacy/`와 생성물은 `.prettierignore`에서 제외한다.

`tests/code-quality.test.mjs`는 검사 규칙 자체의 회귀 테스트와 더불어
저장소의 활성 모듈 전체를 감사한다. `tests/repository-metadata.test.mjs`는
`package.json`, marketplace, Claude·Codex plugin manifest가 같은 기본 버전을
선언하는지 확인한다. 따라서 `npm test`만 통과해도 두 기준이 함께 지켜진다.

## 현재 검사 결과와 보강 범위

아래 수치는 2026-09-15에 `chore/enforce-lint-and-formatting` 브랜치의 작업
트리에서 `npm run quality`를 실행한 결과다. 모든 매개변수 설명의 의미적 정확성이나 JavaScript 문법
전체를 검증한 수치로 해석하면 안 된다. 멀티라인·구조분해 인자와 export
arrow 함수, template이 섞인 긴 실행문에 대한 회귀 테스트가 포함돼 있다.

| 항목 | 결과 |
|---|---:|
| 활성 `.mjs` 파일 | 89/89 모듈 문서화 |
| 공개 export | 275/275 JSDoc |
| 인식한 매개변수 태그 | 235개 (의미적 정확성은 별도 검토 대상) |
| 공개 함수 | 237/237 `@returns` |
| 오류 계약을 가진 공개 API | 134개 `@throws` 명시 |
| 장문 실행문·문서 누락 | 0건 |

`@throws`는 실제 오류 계약이 있는 API에만 쓴다. 순수 집계 함수처럼 예외를 의도적으로 만들지 않는 함수에 허위 `@throws`를 추가하지 않는다.

## 공통화한 코드

- `core.mjs`: 원자적 JSON, 경로 containment, 명령 실행, 단기 file lock
- `usage.mjs`: usage·비용·누락값 집계
- `workflow-store.mjs`: workflow 경로, 잠금, event append, snapshot 읽기
- `status.mjs`: 실행·gate·quota 상태의 읽기 전용 projection
- `orca-adapter.mjs`: 실행 파일 선택, runtime discovery, JSON 호출, worktree 생성

주석은 코드 동작을 그대로 번역하지 않는다. 권한 경계, 캐시 무효화, 프로세스 생존 불명, append-only 기록처럼 잘못 단순화하기 쉬운 이유를 설명한다.
