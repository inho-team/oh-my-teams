# 프롬프트 화면 캡처 결과

2026-09-22에 설치된 Claude Code, Codex, Agy CLI의 대화형 질문 화면들을 캡처한 기록입니다.

## 캡처 절차

### 준비 단계
- 신뢰 기록이 없는 임시 디렉터리(`mktemp -d`)를 git 저장소로 초기화
- 각 CLI의 버전 확인:
  - Claude Code: 2.1.278
  - Codex: 0.155.1
  - Agy: 1.2.7

### 캡처 방법
Orca 터미널을 통해 각 CLI를 실행하고, `orca terminal read --screen --json`으로 화면을 읽었습니다.

- **폴더 신뢰 질문**: 기본 선택 상태와 아래 화살표로 선택을 변경한 상태를 각각 저장
  - Enter 키는 전송하지 않음 (신뢰 기록 저장 방지)
- **미제출 입력줄 화면**: 명령이 입력되었으나 제출되지 않은 상태를 저장
- **AskUserQuestion 화면** (Claude만): 기본 선택 상태와 선택 변경 상태를 저장
  - Escape로 취소하여 프롬프트로 복귀

### Fixture 형식
```json
{
  "cli": "claude|codex|agy",
  "version": "버전 문자열",
  "kind": "화면 종류",
  "selected": 1,
  "capturedAt": "2026-09-22T00:00:00Z",
  "command": "실행한 명령",
  "lines": ["화면 내용 배열"]
}
```

## 캡처 결과표

| 화면 종류 | Claude 2.1.278 | Codex 0.155.1 | Agy 1.2.7 |
|---|---|---|---|
| **폴더 신뢰 질문** (기본 선택) | 캡처됨 | 캡처됨 | 캡처됨 |
| **폴더 신뢰 질문** (선택 변경) | 캡처됨 | 캡처됨 | 캡처됨 |
| **업데이트 안내** | 관측되지 않음 | 관측되지 않음 | 관측되지 않음 |
| **명령 승인 질문** | 관측되지 않음 | 관측되지 않음 | 관측되지 않음 |
| **AskUserQuestion** (기본 선택) | 캡처됨 | 해당 없음 | 해당 없음 |
| **AskUserQuestion** (선택 변경) | 캡처됨 | 해당 없음 | 해당 없음 |
| **입력줄 미제출** | 캡처됨 | 캡처됨 | 캡처됨 |

## 캡처된 파일 목록

### Codex
- `codex-0.155.1-unsubmitted-input.json`: 명령 입력줄 미제출 상태
- `codex-0.155.1-folder-trust-default.json`: 폴더 신뢰 질문 기본 선택 (Yes, continue)
- `codex-0.155.1-folder-trust-changed.json`: 폴더 신뢰 질문 선택 변경 (No, quit)

### Agy
- `agy-1.2.7-unsubmitted-input.json`: 명령 입력줄 미제출 상태
- `agy-1.2.7-folder-trust-default.json`: 폴더 신뢰 질문 기본 선택 (Yes, I trust this folder)
- `agy-1.2.7-folder-trust-changed.json`: 폴더 신뢰 질문 선택 변경 (No, exit)

### Claude
- `claude-2.1.278-unsubmitted-input.json`: 명령 입력줄 미제출 상태
- `claude-2.1.278-folder-trust-default.json`: 폴더 신뢰 질문 기본 선택 (No, exit)
- `claude-2.1.278-folder-trust-changed.json`: 폴더 신뢰 질문 선택 변경 (Yes, I trust this folder)
- `claude-2.1.278-askuser-default.json`: AskUserQuestion 선택 화면 기본 선택 (A)
- `claude-2.1.278-askuser-changed.json`: AskUserQuestion 선택 화면 선택 변경 (B)

## 기술 특이사항

### Claude 신뢰 질문 기본값
Claude는 Codex, Agy와 달리 폴더 신뢰 질문의 기본 선택이 **"No, exit"**입니다. Codex와 Agy는 **"Yes"**가 기본입니다.

### AskUserQuestion
Claude Code에서만 AskUserQuestion 도구를 사용한 대화형 선택 화면이 구현되어 있습니다. 이 화면은 다음 요소를 포함합니다:
- 선택지 목록 (번호 매김)
- 각 선택지의 설명
- 기본 선택 표시 (❯)
- 네비게이션 안내 (↑/↓, Enter, Esc)

### Codex 한도
작업 계약에서 Codex 주간 한도가 2026-09-26 06:11 KST까지 소진 가능성을 언급했습니다. 이번 캡처 시점에서는 한도 초과 메시지가 나타나지 않았으므로, 폴더 신뢰 질문까지 진입 가능했습니다.

## 미검증 항목

없음. 모든 캡처 대상 화면을 성공적으로 수집했습니다.

## 환경 정리

임시 디렉터리(`/private/var/folders/hp/nqxfzfgs7xz_fw2k8lh4gn7c0000gn/T/tmp.6Kiqw25mrE`)를 삭제하여 신뢰 기록을 남기지 않았습니다. 모든 터미널(Codex, Agy, Claude 임시 + Claude AskUserQuestion 캡처용)을 정상 종료했습니다.
