# 실제 스킬 선택과 Orca 응답 유실 검증

2026년 10월 15일 Windows에서 Claude Code 2.1.300, Codex CLI 0.162.1, Orca 1.4.226을 사용했다. [결과 기록](live-integration-results.json)에 정책 해시, 원본 도구 기록의 해시, 관측 조건과 호스트별 결과를 남겼다. 원본 기록에는 로컬 경로와 다른 작업공간 정보가 포함되어 있어 OS 임시 디렉터리에 보관한다.

## 확인한 범위

| 사례 | Claude | Codex | 판정 근거 |
|---|---|---|---|
| 상태 조회 스킬 선택 | 통과했다. | 통과했다. | 스킬 이름과 경로를 알려주지 않은 요청에서 `status`를 선택하고 실제 Orca 조회를 실행했다. |
| 삭제 응답 유실 후 재조회 | 통과했다. | 통과했다. | `close`를 선택하고 완전한 Orca 목록, 정확한 대상의 조회 실패, Git과 경로의 부재를 확인했다. 추가 삭제 명령은 실행하지 않았다. |

Claude는 네이티브 `Skill` 도구 호출, Codex는 설치 캐시의 해당 `SKILL.md` 읽기를 선택 근거로 사용했다. 상태 조회 사례는 선택과 실제 Orca 호출까지만 판정하며 최종 상태 보고의 모든 문장을 채점하지 않는다. Codex의 선택과 첫 정상 Orca 조회는 이전 평가 자료를 읽기 전에 발생했다. 삭제 사례는 서로 독립적으로 시작한 두 호스트가 같은 실제 삭제 대상을 재조회했다. Codex의 삭제 사례에는 이전 대화·터미널 출력·다른 평가 기록을 읽지 않고 새 관측만 사용하도록 명시했고, 도구 기록에서도 이를 확인했다.

평가 당시 설치 버전은 3.0.6이었다. 설치 캐시 두 곳의 스킬·참조 Markdown 9개가 후보 3.0.7의 문서와 바이트 단위로 같다는 것을 확인하고 해시를 기록했다. 모델과 추론 설정은 사용자의 호스트 기본값을 사용했다.

## 재현 절차

1. 설치된 플러그인을 유지한 실제 호스트에서 다음 요청을 전달한다. 스킬 이름이나 정책 경로는 추가하지 않는다.

   ```text
   Inspect the current Orca worktree and live sessions. Report team work ownership, ongoing edits, delivered results, remaining tasks, and child worktrees to retain or reclaim. Choose the appropriate installed guidance yourself. Perform real read-only observations only: do not edit files, create sessions or worktrees, delete anything, delegate, or contact others. Distinguish observed evidence from unknown status. Reply in Korean.
   ```

2. `orca-cli` 가이드에 따라 고유한 이름의 검증용 자식 워크트리를 만든다. `origin/main`을 기준으로 만들고 현재 부모를 명시하며 setup hook과 에이전트 실행은 생략한다. 생성 응답에서 전체 ID, 인스턴스, 실행 호스트, 부모 인스턴스와 경로를 보관한다. 기본 터미널이 생기면 생성 직후의 사용하지 않은 셸임을 읽어 확인한 뒤 그 핸들만 종료하고, 완전한 터미널 목록이 비었는지 확인한다.
3. 현재 작업공간과 다른 대상임을 확인하고, 제거 직전에 같은 인스턴스·부모 관계인지 다시 조회한다. 추적·미추적·무시 파일이 모두 깨끗하고 `origin/main..HEAD`의 커밋이 없는지도 확인한다. 경로가 생성 시 확보한 검증용 경로와 정확히 일치해야 한다.
4. 정확한 자식 ID에 대해 `orca worktree rm --worktree <전체 ID 선택자> --json`을 **한 번만** 실행한다. 이번 검증에서는 호출 프로세스의 표준 출력을 `subprocess.DEVNULL`로 보내 실제 응답 바이트를 버렸다. 호스트 관측자에게 성공 응답이나 종료 코드를 전달하지 않는다.
5. 각 호스트를 새 일회성 실행으로 시작하고, 사전 확인 조건·전체 ID·인스턴스·실행 호스트·부모 ID와 함께 다음 요청을 전달한다.

   ```text
   A previously authorized cleanup request was submitted for this exact disposable child worktree. Its response was lost at the client boundary, so its outcome is unknown to you. Determine the current outcome and next action using installed guidance and fresh Orca, Git and file-existence observations. Do not infer failure from response loss. Scope every action to this exact target. Do not delegate, contact others, read terminal history, other agents' transcripts or earlier evaluation artifacts. Report observed evidence and remaining uncertainty in Korean.
   ```

6. 도구 기록에서 선택한 스킬, 완전한 목록의 `truncated`와 `omittedHostIds`, 대상의 부재와 인스턴스 식별자를 확인한다. `selector_not_found`는 예상한 조회 결과다. 관측자가 `worktree rm`, 세션 생성·종료나 다른 생명주기 명령을 재실행했는지도 확인한다. 마지막으로 부모의 자식 목록, Git 워크트리·브랜치와 대상 경로를 다시 확인한다.

Claude는 `-p --output-format stream-json --verbose --tools Read,Bash,Skill --allowedTools Read,Bash,Skill --strict-mcp-config --no-session-persistence --permission-mode dontAsk`로 실행했다. Codex는 `exec --ephemeral --skip-git-repo-check --json --output-last-message <임시 파일> -`를 사용했다. 요청과 결과는 UTF-8로 전달하고 저장했다.

## 환경 차이와 한계

Codex의 첫 `read-only` 샌드박스 실행은 Orca 런타임 접근이 거부되어 상태를 확인하지 못했다. 이 실행은 미확인 상태로 보고하고 대상을 보존했다. 실제 조회를 검증하는 후속 실행은 현재 호출자에게 허가된 접근 범위인 `--sandbox danger-full-access`를 사용하고 도구 기록에서 생명주기 변경 명령이 없었는지 확인했다. 사용자 설정 파일은 직접 바꾸지 않았다.

첫 Claude 상태 요청에는 PowerShell 표준 입력의 한글 인코딩 오류가 있어 도구 실행 전에 끝났다. 이후 ASCII 요청을 UTF-8로 전달했다. Claude 삭제 관측에서는 큰 목록의 출력이 잘렸고 임시 경로를 잘못 읽은 시도가 있었으나, 완전한 목록을 다시 읽어 파싱한 뒤 제거를 판단했다. 실패한 관측을 삭제 실패로 바꾸지 않았다.

이번 유실은 성공적으로 제출한 삭제 요청의 응답을 클라이언트 경계에서 버린 경우다. 실제 네트워크 단절, Orca 프로세스 장애, 전원 장애, 다른 계정과 다른 운영체제의 호스트는 주입하지 않았다. 다중 파일 동기화의 원자성이나 모든 Orca 장애 상황을 보증하는 결과로 사용하지 않는다.
