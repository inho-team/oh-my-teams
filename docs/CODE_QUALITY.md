# 코드와 스킬 검증

3.x는 실행기를 직접 구현하지 않는 스킬 패키지다. `npm run quality`는 활성 스킬의 이름, 설명, 로컬 링크와 제거된 런타임 명령 참조를 검사한다. `npm run sync:check`는 매니페스트의 버전이 `package.json`과 같은지 검사한다. `npm test`는 필수 역할 런타임과 번들 provider가 다시 들어오지 않았는지 확인한다.

활성 `.mjs` 파일은 모듈 JSDoc을 작성하고 공개 export에 `@param`과 `@returns`를 붙인다. 포맷은 Prettier가 결정한다. 새 클론에서는 `npm ci`를 실행한 뒤 `npm run format`, `npm run sync`, `npm run lint`, `npm test`를 차례로 실행한다. Jenkins의 Linux와 macOS 단계가 같은 검사를 수행한다.

검증하지 않은 Orca 세션이나 워크트리를 종료됐다고 가정하지 않는다. 삭제 전에 정확한 Orca ID, 소유 세션의 종료, Git 상태와 결과 전달을 다시 확인한다. 이 규칙의 정본은 [세션 소유권 구조](ARCHITECTURE.md)다.
