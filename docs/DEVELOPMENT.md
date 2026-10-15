# 개발 도구와 공통 예제

플러그인은 스킬과 참조 문서만 배포한다. 아래 모듈과 예제는 저장소 개발 도구이며, 설치 패키지에 실행기를 추가하지 않는다. 새 검사를 작성할 때는 기존 책임에 맞는 모듈을 사용한다.

| 파일 | 책임 |
|---|---|
| `scripts/check-skills.mjs` | 검사 순서, 스킬 집합·메타데이터 검사, 최종 보고서와 CLI를 담당한다. |
| `scripts/plugin-files.mjs` | 경로의 실제 위치와 플러그인 경계, Markdown 파일 탐색, 읽기 오류의 파일 경로를 처리한다. |
| `scripts/plugin-documents.mjs` | 호스트 매니페스트의 진입점과 Markdown의 로컬 링크를 검사한다. |
| `scripts/plugin-syntax.mjs` | YAML과 Markdown 문법을 파싱한다. 파일에 직접 접근하지 않는다. |
| `scripts/metadata.mjs` | `package.json`을 기준으로 버전을 검사하거나 동기화한다. |
| `tests/helpers/plugin-fixture.mjs` | 정규화된 임시 경로, 설치 구조 복사, 매니페스트 수정을 제공한다. |

`validatePlugin(pluginRoot)`는 저장소와 독립적인 설치 경로를 받아 `{ status, skills, findings }`를 반환한다. 검사 규칙은 발견한 문제를 `findings`에 추가한다. 파일 시스템 오류는 최상위에서 경로·오류 코드와 함께 보고하고, 예상하지 못한 프로그래밍 오류는 호출자에게 전달한다. JSON 문법 오류와 패키지 계약 위반은 해당 매니페스트의 검사 실패로 보고한다.

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

이 상대 경로는 저장소의 `tests/`나 `examples/`에 예제를 둘 때 사용한다. `pluginFixture(t)`는 테스트가 끝나면 복사본을 자동으로 삭제한다. 반환 경로는 `realpath`로 정규화하므로 macOS의 임시 디렉터리 별칭과 Windows 디렉터리 링크에서도 같은 경로로 파일을 비교할 수 있다. 복사본 밖의 파일은 바꾸지 않는다. 잘못된 입력을 검사할 때에는 실패 상태와 구체적인 오류 내용도 함께 확인한다.

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

## 수정과 검증

새 공통 함수는 실제로 반복되는 책임이 있을 때 추가한다. 테스트에서 제품 코드의 기대값을 그대로 가져와 비교하지 않고, 입력과 관찰 가능한 결과를 확인한다. 코드 조각 전체를 문서마다 복사하지 않고 실행 가능한 예제로 연결한다. 공개 함수의 JSDoc과 기존 `validatePlugin`·`synchronize` 호출 계약을 유지한다.

```sh
npm run format
npm run sync
npm run lint
npm test
```

새 체크아웃에서는 먼저 `npm ci`를 실행한다. 버전을 바꾼 경우 `npm install`로 잠금 파일도 갱신한다. 병합 전에는 Jenkins의 Linux·macOS 결과를 확인한다. 검사 범위와 한계는 [코드와 스킬 검증](CODE_QUALITY.md)에 정리되어 있다.
