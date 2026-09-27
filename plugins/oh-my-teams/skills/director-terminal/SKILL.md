---
name: director-terminal
description: 새 이사 세션을 사용자가 보는 Orca 탭에 열고, 기존 이사의 kickoff를 그 세션에 넘긴다. 이사를 다른 실행기로 바꾸거나 이사 터미널을 잃었을 때 사용한다.
---

# 이사 터미널 열기

이사는 kickoff를 선언하는 호스트 세션이며 조직의 역할이 아니므로 `role-terminal`로는 열 수 없다. 이 스킬은 이사 세션을 여는 유일한 절차이며, 다음 세 경우에 사용한다.

- 사용자가 이사를 다른 실행기나 모델로 바꾸라고 지시했을 때 (예: Claude 이사를 Codex 이사로 교체)
- 이사 터미널이 Orca 탭에서 사라졌거나 고아 상태여서 사용자가 대화할 수 없을 때
- 이미 kickoff를 감독하는 이사가 없는 프로젝트에 새 이사를 앉힐 때

`<orca> terminal create`나 `terminal split`을 직접 호출해 이사를 띄우지 않는다. 그 이유와 런타임이 수행하는 확인은 [`../../references/orca-runtime.md`](../../references/orca-runtime.md)의 「이사 실행」 절에 있다.

## 절차

1. **브리프를 쓴다.** 새 이사가 읽을 인수 브리프를 주인 체크아웃의 `.omt/` 아래에 파일로 쓴다. 사용자 지시 원문, 새 이사가 먼저 읽을 문서, 지금 등록된 kickoff와 PM의 상태, 남은 결정, 앞선 이사가 겪은 함정을 담는다. 브리프에 자유 문장을 명령 인자로 싣지 않으며, 런타임은 브리프 경로만 고정된 문구의 첫 프롬프트로 만든다.
2. **사용자가 보는 터미널에서 연다.** 이사를 열려는 세션 자신이 Orca 탭에 보이는 터미널이면 그대로 실행한다. 명령은 환경 변수 `ORCA_TERMINAL_HANDLE`의 터미널을 세로로 분할해 새 이사를 그 탭 안에 둔다. 다른 터미널을 분할하려면 `--from-terminal <handle>`로 지정한다. 분할할 터미널이 없으면 `--from-terminal`을 비운 채 실행하되, 주인 체크아웃에 새로 만든 탭은 Orca가 채택하지 않을 수 있으므로 결과의 `visible`을 반드시 확인한다.

   ```text
   node <runtime> director-terminal --org <project>/.omt/organization.json --profile <프로필 ID> --brief <브리프 경로> [--title <설명>]
   node <runtime> director-terminal --org <project>/.omt/organization.json --provider claude|codex|agy --model <모델> --effort <강도> --brief <브리프 경로> [--title <설명>]
   ```

   조직에 원하는 실행기의 프로필이 있으면 `--profile`로, 없으면 `--provider`·`--model`·`--effort`로 지정한다. 두 방식을 함께 쓰면 거부된다. 명령만 미리 보려면 같은 인자로 `director-command`를 실행한다.

3. **결과를 확인한다.** `ready: true`이고 `visible: true`이며 `screen`에 표시된 모델이 `modelRequested`와 같을 때에만 이사가 열린 것이다. `ready: false`(`status: "blocked"`)이면 화면을 증거로 붙여 사용자에게 보고하고, 다른 실행기나 모델로 대신 열지 않는다. 런타임은 Orca 화면에 붙지 않은 터미널을 닫고 거부하므로, 그 오류가 나오면 오류 문구가 안내하는 대로 보이는 터미널에서 다시 실행한다.
4. **kickoff를 넘긴다.** 옛 이사가 감독하던 kickoff가 있으면 `--replace <옛 이사 터미널 핸들>`을 함께 주어, 등록부에서 그 핸들을 적은 모든 kickoff의 `director.terminalHandle`을 새 터미널로 바꾼다. PM의 `director-signal`은 등록부의 이 값으로 알림 대상을 찾으므로, 이 단계를 빠뜨리면 PM의 신호가 닫힌 터미널로 간다. 결과의 `reassigned.reassigned`에 넘긴 PM 워크트리 ID가, `unchanged`에 다른 이사의 kickoff가 적힌다. 등록부는 이사가 `ready`일 때에만 바뀐다.

   ```text
   node <runtime> director-terminal --org <project>/.omt/organization.json --provider codex --model <모델> --effort high --brief <브리프 경로> --replace <옛 이사 터미널 핸들>
   ```

5. **옛 이사를 정리한다.** 새 이사가 첫 답변으로 등록 상태와 받은함을 보고한 것을 확인한 뒤, 옛 이사 터미널을 `<orca> terminal close --terminal <핸들>`로 닫는다. 옛 이사가 아직 작업 중이면 그 작업이 끝나기를 기다리거나 사용자에게 확인한 뒤 닫는다.

## 새 이사에게 넘어가는 것

- 첫 프롬프트: `당신은 이 저장소의 이사입니다. 인수 브리프 <경로>를 전체 읽고 그 지시를 따르십시오.`
- 탭 제목: `[Director] <체크아웃 이름>` 또는 `--title`로 준 설명. agent가 뜬 뒤 `terminal rename`으로 다시 지정한다.
- 자기 식별자: 새 이사는 자기 터미널 핸들을 환경 변수 `ORCA_TERMINAL_HANDLE`에서 읽고, `kickoff-show`로 등록부의 `director.terminalHandle`이 그 값과 같은지 확인한 뒤 감독을 이어 간다.

## 하지 않는 것

- 브리프 없이 이사를 열지 않는다. 사용자 지시 원문과 현재 상태가 없는 이사는 같은 kickoff를 중복으로 시작할 수 있다.
- 새 이사가 PM을 대신 맡거나 Goal을 만들게 하지 않는다. 이사의 권한과 한계는 [director](../director/SKILL.md)의 「권한·책임·한계」 절을 따른다.
- 옛 이사 터미널에 어떤 입력도 보내지 않는다. 등록부를 넘긴 뒤에는 그 터미널의 화면만 읽는다.
