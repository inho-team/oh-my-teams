# 개발 도구와 공통 예제

플러그인은 스킬과 참조 문서만 배포한다. 아래 모듈과 예제는 저장소 개발 도구이며, 설치 패키지에 실행기를 추가하지 않는다. 새 검사를 작성할 때는 기존 책임에 맞는 모듈을 사용한다.

| 파일 | 책임 |
|---|---|
| `scripts/check-skills.mjs`, `metadata.mjs`, `check-source.mjs` | 기본 경로·시간·어댑터를 조합하고 기존 공개 함수와 CLI를 제공한다. |
| `scripts/core/plugin-validation.mjs` | 검사 순서와 스킬 집합·메타데이터 규칙, 최종 보고서를 담당한다. |
| `scripts/core/plugin-paths.mjs`, `plugin-documents.mjs` | 경로의 경계와 탐색 정책, 매니페스트 진입점, 로컬 링크를 검사한다. |
| `scripts/core/version-sync.mjs` | 모든 입력을 읽고 검증한 뒤 버전 변경 계획을 만들고 적용한다. |
| `scripts/core/source-quality.mjs` | 파싱된 소스에서 JSDoc, 줄 길이, 의존성 방향과 순환 참조를 검사한다. |
| `scripts/core/ports.mjs` | 파일 접근·문서 파서·JavaScript 파서·보고서의 구조적 계약을 정의한다. |
| `scripts/adapters/node-files.mjs` | 실제 파일 접근, 읽기 오류의 경로 보존, 일괄 쓰기와 실패 복구를 구현한다. |
| `scripts/adapters/document-syntax.mjs`, `javascript-syntax.mjs` | YAML·Markdown·JavaScript 파서를 구현한다. |
| `tests/helpers/plugin-fixture.mjs` | 정규화된 임시 경로, 설치 구조 복사, 매니페스트 수정을 제공한다. |

`validatePlugin(pluginRoot)`는 저장소와 독립적인 설치 경로를 받아 `{ status, skills, findings }`를 반환한다. 검사 규칙은 발견한 문제를 `findings`에 추가한다. 파일 시스템 오류는 최상위에서 경로·오류 코드와 함께 보고한다. 파일 포트는 읽기 오류의 `code`, `syscall`, `path`를 보존한다. 문서 파서는 잘못된 입력에 `SyntaxError`를 사용하고, `TypeError` 같은 예상하지 못한 구현 오류는 호출자에게 전달한다. JSON 문법 오류와 패키지 계약 위반은 해당 매니페스트의 검사 실패로 보고한다.

## 의존성 방향과 포트

```mermaid
flowchart LR
  Entry["CLI와 공개 함수"] --> Core["core: 검사·동기화 규칙"]
  Entry --> Adapter["adapters: Node·파서 구현"]
  Core --> Port["포트 계약"]
  Adapter -. "계약 구현" .-> Port
```

`core`는 `node:path`와 다른 core 모듈에만 의존한다. 파일·프로세스 접근, 구체 어댑터와 외부 라이브러리 import, 암묵적인 시간 조회를 넣지 않는다. 어댑터는 core와 같은 계층의 어댑터에 의존할 수 있으며, CLI나 테스트를 가져오지 않는다. 공개 함수가 기본 어댑터와 시간을 제공하므로 기존 호출 방식은 유지된다. 테스트는 포트를 교체하거나 실제 어댑터를 사용하는 통합 검사 중 필요한 방식을 선택한다.

`FilesPort`의 `realPath`, `kind`, `entries`, `readText`는 검사에 필요한 읽기 기능이며, `writeBatch`는 동기화가 사용하는 쓰기 기능이다. `DocumentSyntaxPort`는 메타데이터와 링크를 파싱한다. JavaScript 파서 경계는 ESTree 형식의 구문 트리와 주석 위치를 반환한다. 포트는 JSDoc으로 정의하며 클래스 상속이나 별도 서비스 컨테이너를 요구하지 않는다.

## 공통 함수를 사용하는 예제

[실행 가능한 예제](../examples/plugin-validation.test.mjs)는 설치 패키지를 임시 디렉터리에 복사한 뒤 한 가지 조건만 바꾸고 결과를 확인한다. 다음 패턴으로 회귀 검사를 추가한다.

```js
import test from "node:test";
import assert from "node:assert/strict";
import { validatePlugin } from "../scripts/check-skills.mjs";
import { pluginFixture, editManifest } from "../tests/helpers/plugin-fixture.mjs";

test("bundled entry point", (t) => {
  const plugin = pluginFixture(t);
  editManifest(plugin, "claude", { skills: ["./skills/"] });
  assert.equal(validatePlugin(plugin).status, "passed");
});
```

이 상대 경로는 저장소의 `tests/`나 `examples/`에 예제를 둘 때 사용한다. `pluginFixture(t)`는 테스트가 끝나면 복사본을 자동으로 삭제한다. 반환 경로는 `realpath`로 정규화하므로 macOS의 임시 디렉터리 별칭과 Windows 디렉터리 링크에서도 같은 경로로 파일을 비교할 수 있다. 복사본 밖의 파일은 바꾸지 않는다. 잘못된 입력을 검사할 때에는 실패 상태와 구체적인 오류 내용도 함께 확인한다. 같은 예제 파일에는 `validatePlugin(plugin, { syntax })`로 파서 포트를 교체하는 사례도 있다. 파일 오류 검사는 `{ files }`를 전달하며 전역 `fs`를 바꾸지 않는다.

예제만 실행하려면 다음 명령을 사용한다. `npm test`에도 같은 파일이 포함되어 있으므로 코드가 바뀌면 예제도 함께 검증한다.

```sh
node --test examples/plugin-validation.test.mjs
```

버전 동기화는 기존 `synchronize(write)` 호출을 유지한다. 격리된 저장소와 고정된 시간을 사용하는 검사는 다음처럼 작성한다. 실제 사용 예는 [동기화 회귀 검사](../tests/metadata.test.mjs)에 있다.

```js
const options = { root: temporaryRepository, now: new Date("2026-10-15T01:02:03Z") };
const result = synchronize(false, options);
```

검사 모드는 파일을 변경하지 않는다. 쓰기 모드에서는 기본 버전과 14자리 빌드 값이 유효한 Codex 버전을 보존하며, 기본 버전이 달라졌거나 빌드 값이 잘못되었을 때만 새 값을 만든다. 테스트는 정상 값 보존, 누락·타입 오류 복구, 반복 실행 시 변경이 없어지는지를 확인한다.

동기화는 모든 JSON과 버전 대상의 형식을 먼저 검증하므로 뒤쪽 입력이 잘못되어도 앞 파일을 수정하지 않는다. Node 어댑터는 쓰기 직전에 원본 내용을 다시 확인하고, 쓰기 오류가 나면 시도한 파일을 원래 내용으로 복구한다. 복구도 실패하면 원래 오류와 복구 오류를 `AggregateError`로 전달한다. 이는 프로세스가 살아 있는 동안의 실패 복구 계약이며, 여러 파일의 변경을 전원 장애까지 원자적으로 보장하는 기능은 아니다.

## 자동 품질 검사와 CI

`npm run quality`는 먼저 JavaScript 소스를 검사한 뒤 설치 패키지를 검사한다. 소스 검사는 상태 디렉터리와 `node_modules`·`.git`을 제외한 `.mjs`를 수집하고, 파싱된 구문 트리와 주석 위치로 모듈 JSDoc, 공개 함수의 인자·반환 설명, 실행문 줄 길이와 의존성을 확인한다. 허용되지 않은 계층의 모듈, 계산된 import, 누락된 로컬 import와 순환 참조도 실패로 보고한다. 새 파일도 커밋 전부터 검사한다. 이 검사는 정적 규칙이며 주석의 의미나 모든 동적 실행을 검증하는 보안 격리 장치는 아니다.

Jenkins의 Linux 단계는 OMT 전용 Colima 프로필을 사용한다. 시작·이미지 빌드·컨테이너 실행·종료를 모두 같은 전역 자원 잠금 안에서 처리하여 PR별 작업이 공유 프로필을 동시에 조작하지 않게 한다. 잠금에는 Jenkins의 [Lockable Resources 플러그인](https://www.jenkins.io/doc/pipeline/steps/lockable-resources/)이 필요하다. 잠금의 실제 가용성과 Linux·macOS 실행 결과는 PR 검사에서 확인한다. 다른 프로젝트의 Colima 프로필을 종료하지 않는다.

## 수정과 검증

새 공통 함수는 실제로 반복되는 책임이 있을 때 추가한다. 테스트에서 제품 코드의 기대값을 그대로 가져와 비교하지 않고, 입력과 관찰 가능한 결과를 확인한다. 코드 조각 전체를 문서마다 복사하지 않고 실행 가능한 예제로 연결한다. 공개 함수의 JSDoc과 기존 `validatePlugin`·`synchronize` 호출 계약을 유지한다.

```sh
npm run format
npm run sync
npm run lint
npm test
```

새 체크아웃에서는 먼저 `npm ci`를 실행한다. 버전을 바꾼 경우 `npm install`로 잠금 파일도 갱신한다. 병합 전에는 Jenkins의 Linux·macOS 결과를 확인한다. 검사 범위와 한계는 [코드와 스킬 검증](CODE_QUALITY.md)에 정리되어 있다.
