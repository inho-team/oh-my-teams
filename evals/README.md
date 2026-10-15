# 실제 호스트의 판단 평가

`host-decisions.json`은 기존 수동 시나리오 11개와 정상 동작 대조군 3개를 고정한 입력이다. `host-results.json`에는 실제 Claude Code와 Codex CLI가 정책 파일을 읽고 반환한 응답, 도구 사용 증거 요약, 정책 및 원본 이벤트 기록의 SHA-256을 보관한다. 원본 이벤트에는 개인 경로와 세션 정보가 있으므로 저장소에 넣지 않는다.

## 평가 범위와 결과

2026년 10월 15일에 Claude Code 2.1.300과 Codex CLI 0.162.1에서 실행했다. Claude는 기대 분류와 14개 모두 일치했고, Codex는 13개가 일치했다. Codex는 `session-incomplete-observation`에서 `cleanup`을 `preserve` 대신 `not_applicable`로 표시했다. 해당 응답의 설명과 다음 행동은 기존 세션을 보존하고 다시 조회하도록 요구한다. 이를 분류 차이로 기록하며 전체 일치로 계산하지 않는다. 두 호스트 모두 병합·세션 생성·삭제 허용 여부는 14개 사례에서 기대값과 일치했다.

이 평가는 실제 호스트가 제공된 관측을 정책에 따라 판단하는지 확인한다. Orca 1.4.226의 현재 워크트리 조회도 읽기 전용으로 확인했으나, 실제 병합·세션 생성·삭제, 연결 단절 주입, 플러그인 자동 선택은 이 평가에서 실행하지 않았다. 따라서 결과를 Orca 생명주기 전체의 통합 테스트로 해석하지 않는다.

## 재현 방법

1. `host-prompt.txt`의 정책 경로를 평가할 체크아웃의 절대 경로로 바꾼다.
2. `host-decisions.json`에서 각 사례의 `id`와 `observations`만 추출하여 프롬프트의 사례 자리표시자에 넣는다. `expected`와 기존 응답은 호스트에 제공하지 않는다.
3. 저장소 밖 임시 디렉터리에서 같은 프롬프트를 UTF-8 표준 입력으로 전달한다. 아래 명령의 `<temp>`에는 그 디렉터리, `<plugin>`에는 체크아웃의 `plugins/oh-my-teams` 경로를 사용한다. CLI가 선택하는 기본 모델을 유지한다.

```text
claude -p --output-format stream-json --verbose --tools Read --allowedTools Read --strict-mcp-config --no-session-persistence --permission-mode dontAsk --add-dir <plugin>
codex exec --sandbox read-only --ephemeral --skip-git-repo-check --json --cd <temp> --output-last-message <temp>/codex-final.txt -
```

Windows에서 Codex 명령 래퍼의 경로 인용 문제가 생기면 설치된 공식 `@openai/codex/bin/codex.js`를 Node로 실행하고 같은 인수를 전달할 수 있다. 이번 실행에는 이 진입점을 사용했다. PowerShell의 기본 출력 인코딩으로 한글이 깨지면 UTF-8 또는 JSON Unicode 이스케이프를 사용하여 정책 파일을 다시 읽는다. 이번 Codex 도구 기록에는 이 재조회 과정이 포함되어 있다.

4. 도구 기록에서 정책 파일 5개를 모두 읽었는지, 생명주기 작업이나 파일 변경이 실행되지 않았는지 확인한다. 최종 JSON의 사례 ID가 중복이나 누락 없이 일치하는지도 확인한다.
5. `ci`, `merge`, `create_session`, `delete`, `cleanup`을 기대값과 비교한다. 설명과 증거 ID는 별도로 검토하고, 차이는 원문 그대로 남긴다. `casePayloadSha256`은 입력 사례 배열을 키 정렬, 공백 없는 JSON 및 UTF-8로 직렬화한 값의 해시이다.

## 이번 입력 검증 수정의 계약

정본 버전은 빌드 메타데이터가 없는 엄격한 SemVer를 사용한다. 유효한 사전 릴리스는 허용하며, Codex 빌드 접미사는 동기화 어댑터가 한 번만 붙인다. 잘못된 버전은 매니페스트를 쓰기 전에 거부한다.

YAML의 미정의 별칭, 앞서 선언되지 않은 앵커 참조와 별칭 확장 한도 초과는 입력 오류로 보고한다. 알려지지 않은 파서 내부 예외는 숨기지 않는다. 소스 검사는 어휘적 바인딩을 사용하여 전역 런타임 접근과 공개 함수의 별칭을 추적하며, 같은 이름의 주입 매개변수는 전역 접근으로 처리하지 않는다.
