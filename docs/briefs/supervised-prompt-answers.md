# kickoff 브리프: 역할 터미널의 질문에 감독자가 대신 답하고, 사용자 창구를 이사(Director) 하나로 유지하기

> 상태: 대기. `director-role` kickoff가 `main`에 병합된 뒤 최신 `main`에서 시작한다(이사 역할·신호 통로를 그 kickoff가 만든다). 시작 시점에 이 브리프의 기준 커밋과 전달 방식을 이사가 다시 확인한다.

> 이관 메모(2026-09-20): 아직 시작하지 않았다. director-role이 병합된 뒤에 시작한다.

## 목표

역할 터미널(Claude·Codex·Agy)이 폴더 신뢰·업데이트·명령 승인 같은 질문에 멈추면, 그 역할을 감독하는 역할(PL 또는 PM)이 화면을 읽고 정해진 규칙에 맞는 질문에만 키를 보내 대신 답하게 한다. 규칙에 맞지 않는 질문은 PM에게 올리고, PM이 판단할 수 없는 것은 **이사(Director)**에게 올린다.

**이사(Director)**는 kickoff를 선언한 main 세션의 역할 이름이다. 사용자와 대화하는 주체는 이사 하나뿐이다. 이사는 모든 kickoff의 최종 책임자로서 PM을 관리하고, 원본 프로젝트의 `main`(또는 `master`)에 병합할지를 결정하며, `close`·`disband`를 수행한다. 사용자는 PM 터미널에 직접 가서 지시하지 않고, PM도 사용자에게 직접 묻거나 보고하지 않는다.

## 수용 기준

1. **감독 관계를 따른다.** 질문에 답하는 주체는 멈춘 역할의 감독자(Run에 바인딩된 PM, 또는 자기 Run을 바인딩한 PL)뿐이다. 같은 서열의 다른 역할이나 감독 관계가 없는 실행기가 서로의 질문에 답하지 않는다. 역할이 자기 질문에 스스로 답하지도 않는다.
2. **질문 분류기가 결정적이다.** 화면 줄을 받아 질문 종류와 보낼 키를 돌려주는 함수가 런타임에 있다(예: `scripts/prompt-answers.mjs` 또는 `role-terminal.mjs` 확장). 기존 `trustQuestion`처럼 문구와 **현재 선택 상태**를 함께 대조하고, 일치하지 않으면 답하지 않는다. 최소한 다음 종류를 다룬다.
   - 폴더 신뢰: Agy(기존 동작 유지), **Codex**(`Do you trust the contents of this directory?`), Claude(질문이 나오면). kickoff가 주인 프로젝트에서 만든 Orca 워크트리일 때만 답한다.
   - 업데이트 안내: 설치나 업그레이드가 아니라 건너뛰기·나중에 선택지일 때만 답한다.
   - 명령 승인: 아래 3의 범위 판정을 통과할 때만 허용 키를 보낸다.
   - 그 밖의 질문: `unknown`으로 분류해 답하지 않는다.
   실제 문구와 키는 설치된 CLI 버전에서 화면을 캡처해 확인하고, 확인한 버전과 캡처를 테스트 fixture로 남긴다. 확인하지 못한 CLI·질문은 분류기에 넣지 않는다.
3. **명령 승인은 범위를 확인한 뒤에만 허용한다.** 권한 우회 플래그로 실행했는데도 승인 질문이 나온 경우, 감독자는 화면에 표시된 명령·경로를 읽고 다음을 모두 만족할 때만 허용한다. 하나라도 판정할 수 없으면 거절하지 않고 답하지 않은 채 PM에게 올린다.
   - 대상 경로가 그 역할의 워크트리 안이고, task 계약의 허용 파일·검사 명령 범위다.
   - 주인 체크아웃, 다른 역할의 워크트리, 사용자 설정 파일(`~/.claude`, `~/.codex`, Agy 설정 등)을 쓰지 않는다.
   - `git push`, 병합, PR 생성·병합, 원격 쓰기, `reset --hard`·`clean -fd`·강제 삭제 같은 되돌릴 수 없는 명령, 패키지 전역 설치, 자격 증명 접근이 아니다.
   - "이번 세션 동안 항상 허용"처럼 범위를 넓히는 선택지는 고르지 않고 한 번만 허용한다.
4. **모든 대리 응답을 기록한다.** 답할 때마다 역할·터미널·워크트리·질문 종류·화면 발췌·보낸 키·판정 근거·답한 감독자를 PM state 아래에 남기고, `status` 또는 진행 보고에서 볼 수 있다. 답한 뒤 화면을 다시 읽어 질문이 사라졌는지 확인하고, 그대로면 다시 보내지 않고 PM에게 올린다(같은 질문에 한 번만 답한다).
5. **기존 차단 경로와 연결한다.** `terminal-idle-check`·`worker-start` 사전 점검이 `agent-trust-workspace`·`agent-approval-prompt` 등 `blockedReason`으로 거부했을 때, 감독자가 분류기를 거쳐 답하고 사전 점검부터 다시 진행하는 절차가 `references/orca-runtime.md`에 있다. 실행 중 worker가 질문에 멈춘 경우도 「무응답 worker 감독」 절에서 같은 절차를 따른다. 신뢰에 답한 터미널을 닫고 다시 여는 기존 규칙(질문 문구가 버퍼에 남는 문제)은 Codex에도 적용한다.
6. **worker가 사용자에게 묻는 화면을 런타임에서 막는다.** 이사 역할, PM → 이사 신호 통로, 머리글의 "사용자에게 직접 묻지 않는다" 문장은 `director-role` kickoff가 만든 것을 사용하고 여기서 다시 정의하지 않는다.
   - worker 터미널이 사용자 질문 UI(예: Claude의 `AskUserQuestion` 선택 화면, Codex·Agy의 사용자 입력 요청)에 멈추면, 감독자의 사전 점검·무응답 감독이 이를 `unknown` 질문과 구별되는 "사용자에게 묻는 질문"으로 분류한다. 감독자는 답하지 않고 질문 내용을 발췌해 그 worker에게 "감독자에게 `orchestration ask`로 다시 물으라"는 지시를 보내거나 PM에게 올린다. 이 분류와 재지시에 대한 결정적 테스트가 있다.
   - 런타임 문서의 "사람이 그 터미널에서 답한다"는 서술(`orca-runtime.md` 101·147·149·181행 등)을 감독자 경로로 바꾼다. 사람이 필요한 경우가 남으면 그 이유와 함께 PM이 이사에게 신호로 요청하는 경로만 적는다.
7. **안전 경계를 유지한다.** OMT는 Codex·Claude·Agy 사용자 설정 파일에 신뢰 항목을 직접 쓰지 않는다(키 입력 방식만 쓴다). 브리프에 기록된 전달 방식 밖의 외부 변경은 여전히 이사의 결정으로 남는다.
8. 분류기와 범위 판정에 대한 결정적 테스트가 있다: 확인된 각 질문 fixture의 분류·키, 선택 상태가 다를 때 답하지 않음, 금지 명령(push·병합·reset --hard·워크트리 밖 경로·설정 파일)이 허용되지 않음, "항상 허용" 선택지를 고르지 않음, unknown 질문에 답하지 않음, 같은 질문에 두 번 답하지 않음. `npm run sync`, `npm run lint`, `npm test`와 PR의 `CI`가 통과한다.

## 비목표

- 권한 우회 플래그를 제거하거나 역할의 샌드박스 정책을 바꾸지 않는다.
- 사용자의 전역 키바인딩(`~/.claude/keybindings.json` 등)이나 OS 수준 입력 자동화를 쓰지 않는다. 키는 Orca `terminal send`로만 보낸다.
- 역할 사이의 동료 승인(예: Codex worker가 Claude worker의 질문에 답함)은 만들지 않는다.
- close·disband의 주인 체크아웃 병합·PR 권한은 바꾸지 않는다.
- 버전 올리기와 릴리스는 이번 범위가 아니다.

## 제약

- 저장소 규칙은 `AGENTS.md`를 따른다. 활성 `.mjs`의 JSDoc 규칙, `npm run format`, fluent-korean 기준을 지킨다.
- `minimal-change-discipline` kickoff가 병합한 불필요한 변경 규율을 따른다.
- 브랜치는 `feat/supervised-prompt-answers`를 사용한다.

## 전달 방식

- 예정 값: `pull-request`, base 브랜치 `main` (앞선 kickoff들과 같음). 사용자는 kickoff가 완료되는 대로 이사가 `main`에 병합하도록 승인했다(2026-09-17).

## 근거 위치

- Agy 신뢰 자동 응답: `plugins/oh-my-teams/scripts/role-terminal.mjs`의 `TRUST_QUESTION`, `TRUST_SELECTED`, `trustQuestion`, `launchOnce`(answerTrust), 신뢰 뒤 터미널 재시작 로직.
- 차단 신호: `plugins/oh-my-teams/scripts/orca-adapter.mjs`의 `wait.blockedReason` 처리(현재 "The prompt needs someone at the terminal"로 경로 없음).
- 문서: `plugins/oh-my-teams/references/orca-runtime.md` 101행(Codex 신뢰는 사람이 답함), 147행(`blockedReason`에 경로를 정하지 않음), 155행(`--inject-fallback`의 사용자 승인), 171행(신뢰 뒤 재시작).
- 권한 우회 플래그: `plugins/oh-my-teams/scripts/role-launch.mjs`.
- 사용자 요청 원문: "omt는 Claude, Codex, Agy가 서로 사용자의 허용을 보내는걸 대신 허용해줄 수 있나?? Keybinding 이런걸로 해도 괜찮을텐데. 사용자에게 명시적으로 요청하는건 main/master, PM이 유일했으면 하거든."
- 사용자 결정(2026-09-17): 자동 응답 범위는 명령 승인까지 포함, Codex 신뢰는 화면 키 입력 방식, 시작은 첫 kickoff 종료 후.
