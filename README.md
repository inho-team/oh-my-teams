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

작업 소유권, 독립 검토와 회수 기준은 [세션 소유권 구조](docs/ARCHITECTURE.md)에 정리했다. Orca 명령은 설치된 버전의 `orca-cli` 가이드를 확인한 뒤 실행한다.

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

`npm run quality`는 활성 스킬의 이름과 링크, 이전 런타임 명령 참조를 검사한다. `npm run sync`는 `package.json`의 버전을 마켓플레이스와 플러그인 매니페스트에 반영한다. Linux와 macOS의 Jenkins 검사에서도 린트와 테스트를 실행한다.

## 라이선스

MIT 라이선스를 따른다. 자세한 내용은 [LICENSE](LICENSE)에 있다.
