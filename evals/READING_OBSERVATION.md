# 스킬 읽기 행동의 관측

이 문서는 호스트가 OMT 스킬을 사용할 때 설치 패키지의 어느 파일을 실제로 읽는지, 그리고 그 상태에서 작성한 문서가 저장소의 검사를 통과하는지를 관측한 기록이다. 2026-11-11에 Windows 11에서 Claude Code 2.1.317과 Codex CLI 0.162.1로 실행했다. 모델과 추론 설정은 각 호스트의 기본값을 사용했다. 수치의 원본은 [결과 기록](reading-results.json)에 있다.

정적 검사인 `npm run reading:check`는 스킬이 직접 링크한 파일의 분량을 계산한다. 이 관측은 호스트가 그 링크를 실제로 따라가는지를 확인하므로 두 측정은 서로를 대신하지 않는다.

## 관측 방법

[프롬프트](reading-prompt.txt)는 플러그인의 위치와 스킬 이름만 알려 주고 읽을 파일을 지정하지 않는다. 기존 [판단 평가](README.md)의 프롬프트는 정책 파일 다섯 개를 직접 지정하므로 이 목적에 사용할 수 없다. [사례](reading-cases.json)는 다섯 개이며 관측값은 모두 가상의 값이다.

| 사례 | 요청 | 판정 |
|---|---|---|
| `status-report-partial` | 일부 CI 조회가 실패한 상태에서 상태 보고를 작성한다. | `documents.mjs check`의 결과다. |
| `review-request-auditor` | auditor에게 보낼 검토 요청을 작성한다. | 같다. |
| `task-request-child` | 사용자 요청 원문에서 자식 워크트리용 작업 요청을 작성한다. | 같다. |
| `completion-report-verified` | [원래 작업 요청](reading-task.yaml)에 대한 완료 보고를 작성한다. | `--task`로 원래 요청과 대조한 결과다. |
| `resume-after-timeout` | 관측이 타임아웃된 뒤 새 세션을 시작할지 판단한다. | `create_session`이 `false`인지 확인한다. |

두 가지 플러그인 상태를 같은 사례와 같은 프롬프트로 실행했다. 사례마다 호스트를 새로 시작했으며 실행 횟수는 상태마다 호스트당 다섯 번이다.

| 실행 이름 | 플러그인 상태 |
|---|---|
| `baseline-3.5.0` | 커밋 `a2d4c20`의 3.5.0이다. 문서 카드는 설치돼 있지만 스킬은 스키마와 `protocol.yaml`을 링크한다. |
| `cards-3.6.0` | 다섯 스킬의 링크를 해당 종류의 카드와 공통 규칙 카드로 바꾼 3.6.0이다. |

읽은 파일은 도구 기록에서 추출했다. Claude는 `Read` 호출의 경로를, Codex는 셸 명령에 포함된 플러그인 파일 경로를 사용했다. 읽은 분량은 서로 다른 파일의 문자 수를 합한 값이며 `reading:check`와 같은 단위다. 같은 파일을 여러 번 읽어도 한 번으로 센다.

## 결과

두 실행 모두에서 문서 여덟 개가 검사를 통과했고 판단 두 개가 기대와 일치했다. 완료 보고는 원래 작업 요청과의 대조까지 통과했다.

| 호스트 | 사례 | 읽은 분량 (변경 전 → 후) | 읽기 호출 수 | 입력 토큰 | 검사 |
|---|---|---:|---:|---:|---|
| Claude | `status-report-partial` | 32,551 → 8,989 | 5 → 5 | 49,392 → 38,836 | 통과 → 통과 |
| Claude | `review-request-auditor` | 31,226 → 6,404 | 4 → 4 | 51,519 → 40,236 | 통과 → 통과 |
| Claude | `task-request-child` | 9,653 → 12,423 | 6 → 6 | 84,761 → 62,147 | 통과 → 통과 |
| Claude | `completion-report-verified` | 10,307 → 12,693 | 5 → 4 | 61,117 → 79,198 | 통과 → 통과 |
| Claude | `resume-after-timeout` | 2,483 → 2,483 | 1 → 1 | 33,083 → 33,130 | 일치 → 일치 |
| Codex | `status-report-partial` | 32,551 → 8,989 | 12 → 15 | 190,628 → 138,149 | 통과 → 통과 |
| Codex | `review-request-auditor` | 35,898 → 11,076 | 12 → 9 | 147,213 → 113,412 | 통과 → 통과 |
| Codex | `task-request-child` | 38,460 → 14,061 | 16 → 10 | 160,189 → 113,699 | 통과 → 통과 |
| Codex | `completion-report-verified` | 40,843 → 14,981 | 16 → 11 | 250,556 → 103,018 | 통과 → 통과 |
| Codex | `resume-after-timeout` | 7,414 → 7,411 | 10 → 8 | 154,182 → 139,493 | 일치 → 일치 |

입력 토큰은 한 번의 실행에서 발생한 모든 모델 호출의 입력을 합한 값이며 캐시에서 읽은 토큰을 포함한다. 호출 횟수가 많을수록 같은 문맥이 반복해서 합산되므로, 읽은 분량보다 호출 횟수의 영향을 더 크게 받는다. 호스트마다 집계 방식이 다르므로 두 호스트의 값을 서로 비교하지 않는다.

## 관측한 사실

- 스킬이 스키마를 링크하면 호스트는 스키마 전체를 읽는다. 변경 전 실행에서 문서를 작성한 여덟 번 가운데 여섯 번이 `document.schema.json`과 `protocol.yaml`을 모두 읽었다. Codex는 네 번 모두 읽었다.
- 나머지 두 번은 Claude의 `task-request-child`와 `completion-report-verified`다. Claude는 플러그인 디렉터리를 먼저 나열한 뒤, 스킬이 링크하지 않은 카드를 스스로 찾아 읽고 스키마는 읽지 않았다. 이 두 사례는 변경 전부터 카드를 사용했으므로 변경 후에 읽은 분량이 줄지 않았다.
- 링크를 카드로 바꾼 뒤에는 어느 실행도 스키마를 읽지 않았다. Claude의 `completion-report-verified`만 카드 마지막의 링크를 따라 `protocol.yaml`을 추가로 읽었다.
- 문서를 작성한 실행에서 읽은 분량은 Codex에서 63%에서 72% 줄었다. Claude는 스키마를 읽었던 두 사례에서 72%와 79% 줄었다.
- 사례 다섯 개의 입력 토큰 합계는 Claude가 279,872에서 253,547로, Codex가 902,768에서 607,771로 줄었다. Claude의 `completion-report-verified`는 61,117에서 79,198로 늘었다.
- Codex는 같은 파일을 평균 두 번 안팎으로 읽었다. Windows PowerShell의 기본 인코딩으로 읽은 한국어 문서가 깨져서, UTF-8을 지정한 명령으로 다시 읽었기 때문이다. 이 재읽기는 카드 도입과 무관하게 두 실행에서 모두 나타났다.
- Codex는 일부 실행에서 작성한 문서를 Python의 `jsonschema`로 직접 검사했다. 변경 전의 `status-report-partial`에서는 이 검사를 위해 스키마를 한 번 더 읽은 것을 확인했다.
- `resume-after-timeout`에서는 두 호스트 모두 문서 양식을 읽지 않았다. Claude는 `failure-handling.md` 하나만 읽고 판단했다.

## 해석의 한계

- 상태마다 사례를 한 번씩만 실행했다. 같은 조건에서도 호스트의 읽기 순서와 호출 횟수가 달라질 수 있으므로, 토큰의 증감을 카드의 효과로 단정할 수 없다. 읽은 파일의 종류가 바뀐 것은 도구 기록으로 확인한 사실이다.
- 사례 다섯 개가 모든 문서 종류와 상황을 대표하지 않는다. `review_result`와 `interruption_report`는 작성 사례가 없다.
- 가상의 관측값을 프롬프트로 제공했다. 실제 Orca·Git·CI를 조회하는 작업에서 발생하는 도구 출력과 그 비용은 포함되지 않는다.
- 호스트의 스킬 자동 선택을 거치지 않고 플러그인 경로를 직접 알려 주었다. 설치된 플러그인의 스킬 설명이 문맥에 적재되는 비용과 선택 과정은 관측하지 않았다.
- Codex가 읽은 파일은 셸 명령의 문자열에서 추출했다. 와일드카드나 스크립트 내부에서 읽은 파일은 누락될 수 있다.
- 검사 통과는 구조와 의미 규칙, 원래 요청과의 대응을 뜻한다. 문서의 내용이 관측값을 정확하게 옮겼는지는 사람이 검토하지 않았다.
- Windows 한 대의 결과다. Codex의 재읽기는 운영체제에 따른 현상으로 보이며 macOS와 Linux에서는 확인하지 않았다.

## 재현 방법

1. 관측할 플러그인 디렉터리를 저장소 밖 임시 디렉터리에 복사한다.
2. [사례](reading-cases.json)마다 [프롬프트](reading-prompt.txt)의 자리표시자를 채운다. `<PLUGIN>`에는 복사한 경로를, `<TASK>`에는 사례의 `task`를, `<OBSERVATIONS>`에는 `observations`를 목록으로, `<OUTPUT>`에는 `outputs`에서 사례의 `output`에 해당하는 문장을 넣는다. `taskFile`이 있는 사례는 그 YAML을 `<TASK>` 뒤에 코드 블록으로 붙인다.
3. 저장소 밖 임시 디렉터리에서 프롬프트를 UTF-8 표준 입력으로 전달한다. `<plugin>`은 복사한 경로, `<temp>`는 작업 디렉터리다.

   ```text
   claude -p --output-format stream-json --verbose --tools Read,Glob,Grep --allowedTools Read,Glob,Grep --strict-mcp-config --no-session-persistence --permission-mode dontAsk --disable-slash-commands --add-dir <plugin>
   codex exec --sandbox read-only --ephemeral --skip-git-repo-check --json --cd <temp> --output-last-message <temp>/last.txt -
   ```

4. 도구 기록에서 읽은 파일을 추출하고 서로 다른 파일의 문자 수를 합한다. 입력·출력 토큰은 Claude의 `result` 이벤트와 Codex의 `turn.completed` 이벤트에서 읽는다.
5. 응답의 YAML 블록을 파일로 저장해 `node scripts/documents.mjs check <파일>`로 검사한다. 완료 보고에는 `--task evals/reading-task.yaml`을 붙인다.
6. 원본 이벤트에는 로컬 경로가 있으므로 저장소에 넣지 않고 SHA-256만 기록한다.

Windows에서 Codex 명령 래퍼의 경로 인용 문제가 생기면 설치된 `@openai/codex/bin/codex.js`를 Node로 실행한다. 이번 실행에는 이 진입점을 사용했다. 실제 모델 호출 비용이 발생하므로 실행 전에 범위와 허가를 확인한다.
