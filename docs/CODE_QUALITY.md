# 코드와 스킬 검증

3.x는 실행기를 직접 구현하지 않는 스킬 패키지다. `npm run quality`는 활성 스킬의 이름, 설명, 제거된 런타임 명령 참조와 플러그인 안의 모든 Markdown 문서에 있는 로컬 링크를 검사한다. 링크 대상은 플러그인 내부에 존재해야 하며, 저장소에만 있는 파일이나 플러그인 밖으로 연결되는 심볼릭 링크에 의존하면 실패한다. 공통 규칙은 설치에 포함되는 `plugins/oh-my-teams/references/`에 둔다.

`npm run sync:check`는 매니페스트의 버전이 `package.json`과 같은지 검사한다. `npm test`는 플러그인 폴더만 OS 임시 디렉터리에 복사해 설치 구조를 검사하며, 외부 파일 참조와 누락된 참조 문서를 거부하는지 확인한다. Windows 줄바꿈에서도 스킬 메타데이터를 읽을 수 있는지 검사하고, 필수 역할 런타임과 번들 provider가 다시 들어오지 않았는지도 확인한다. 이 검사는 실제 Orca 실행이나 에이전트의 지침 준수를 보증하지 않는다.

활성 `.mjs` 파일은 모듈 JSDoc을 작성하고 공개 export에 `@param`과 `@returns`를 붙인다. 포맷은 Prettier가 결정한다. 새 클론에서는 `npm ci`를 실행한 뒤 `npm run format`, `npm run sync`, `npm run lint`, `npm test`를 차례로 실행한다. Jenkins의 Linux와 macOS 단계가 같은 검사를 수행한다.

검증하지 않은 Orca 세션이나 워크트리를 종료됐다고 가정하지 않는다. 삭제 전에 정확한 Orca ID, 소유 세션의 종료, Git 상태와 결과 전달을 다시 확인한다. 이 규칙의 정본은 [세션 소유권 구조](ARCHITECTURE.md)다.
