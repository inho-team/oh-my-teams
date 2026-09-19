# kickoff 브리프: 이사(Director)를 OMT의 공식 역할로 만들고 런타임으로 강제하기

> 상태: 진행. 기준 커밋은 main의 bb38d62(2026-09-18)이며, minimal-change-discipline·form-model-choices·graphify·agy-terminal-path kickoff가 모두 병합된 상태다. `supervised-prompt-answers` 브리프는 이 kickoff가 병합된 뒤에 시작한다.

> 이관 메모(2026-09-20): 아직 시작하지 않았다.

## 목표

kickoff를 선언한 세션을 **이사(Director)**라는 OMT의 공식 역할로 정의한다. 이사는 사용자와 대화하는 유일한 창구이고, 여러 kickoff의 PM을 관리하며, 원본 프로젝트의 `main`(또는 `master`)에 병합할지 결정하고 `close`·`disband`를 수행하는 최종 책임자다. 이 구조를 지시문이 아니라 조직 스키마, 등록부, 역할 지시문 머리글, 런타임 명령의 검사로 강제한다. 지금 이사가 즉흥적으로 쓰는 화면 문자열 신호(`MAIN-DECISION:`·`CLOSE-READY:`)와 공유 잠금(`.omt/heavy.lock`)을 구조화된 런타임 기능으로 바꾼다.

## 수용 기준

1. **역할 정의:** `director`가 역할 목록과 서열의 최상위(PM의 상위)로 정의된다(`scripts/core.mjs`의 `ROLES`와 관련 표). 이사는 PM으로 접히지 않고 PM도 이사로 접히지 않는다. 이사는 `worker-start`·`role-terminal`로 띄우는 대상이 아니며(사용자가 대화하는 호스트 세션 자체), 이 차이를 런타임이 거부로 강제한다. 조직 파일에 이사 프로필을 저장할지(호스트 세션 모델 기록 등)는 근거와 함께 정하고, 기존 조직 파일(이사 항목 없음)은 그대로 읽히며 마이그레이션 경로가 있다.
2. **이사 스킬:** `plugins/oh-my-teams/skills/director/SKILL.md`에 권한·책임·한계 절이 있다.
   - 권한: 사용자와 목표·수용 기준·전달 방식 확정, 브리프 작성과 PM 인계, 여러 kickoff 감독, PM 결정 요청에 대한 결정, 자원(메모리·동시 무거운 작업) 조율, `close`·`disband`, 주인 브랜치 병합 결정.
   - 한계: Goal을 만들거나 Run을 바인딩하거나 `worker-start`를 호출하지 않는다(PM을 대신 맡지 않는다), 산출물을 직접 만들지 않는다, 사용자가 확정한 전달 방식 밖으로 넓히지 않는다.
   - `kickoff`·`close`·`disband`·`status`·`help` 스킬과 `references/kickoff-registry.md`의 "선언 세션" 서술을 이사로 정리한다.
3. **사용자 창구 강제:**
   - `roleSpec`이 만드는 PM 지시문 머리글의 `보고 대상`이 `사용자`가 아니라 `이사`다. PM 이하 모든 역할의 머리글에 "사용자에게 직접 묻거나 보고하지 않는다" 고정 문장이 들어간다.
   - `pm` 스킬의 "사용자 결정을 요청한다", "kickoff를 선언한 사용자에게 보고한다", "사용자에게 보고한다" 등을 이사로 고친다. 사용자 승인을 요구하던 경로(`--inject-fallback`의 승인 문장, `accepted-risk`의 `authority: user`)는 이사 결정으로 받을 수 있게 하되, 이사가 사용자에게 확인해야 하는 경우를 스킬에 적는다.
4. **PM → 이사 신호를 구조화한다:** 화면 문자열 대신 런타임 명령으로 주고받는다.
   - PM: `director-signal --org <org> --worktree <pm-worktree-id> --kind decision|close-ready|blocked|progress --text ... [--head <sha> --source <통합 워크트리>]` → 주인 프로젝트 `.omt/director/inbox/`에 kickoff별 구조화 레코드를 원자적으로 쓴다. 가능하면 등록부에 기록된 이사 터미널에 짧은 알림도 보낸다.
   - 이사: `director-inbox`(미처리 신호 조회), `director-reply --signal <id> --text ...`(결정 기록 + PM 터미널 전달), `director-ack`.
   - `close-ready` 신호는 `close`의 입력(통합 워크트리·HEAD)과 연결되고, `close`는 그 신호가 없거나 HEAD가 다르면 경고·거부한다.
   - 잘못된 kind, 등록되지 않은 워크트리, 같은 신호 중복은 거부된다.
5. **등록부에 이사를 기록한다:** `kickoff-claim` 요청에 이사 식별자(Orca 터미널 핸들과 주인 체크아웃 경로)를 받아 항목에 남긴다. PM 인계 지시문과 `roleSpec` 머리글에 이사 식별자가 들어가 PM이 신호를 보낼 대상을 안다. 이사 기록이 없는 기존 항목도 조회·종료할 수 있다.
6. **종료·병합 권한을 이사로 제한한다:** `deliver`, `kickoff-release`, `close`·`disband`가 쓰는 회수 명령은 호출자가 등록부에 기록된 이사(주인 체크아웃에서, 기록된 이사 터미널 또는 이를 확인할 수 있는 방법)일 때만 동작하고, PM 워크트리나 역할 터미널에서 호출하면 거부한다. 확인 수단이 없는 환경의 동작(경고 후 허용 또는 거부)을 근거와 함께 정한다.
7. **자원 조율을 런타임 기능으로 만든다:** 여러 kickoff가 공유하는 무거운 작업 슬롯을 `resource-acquire --org <org> --worktree <pm> --kind test|worker|build --note ...` / `resource-release`로 제공한다. 주인 프로젝트 `.omt/resources/`에 원자적으로 기록하고, 최소 여유 메모리(기본값과 조직 `policy`로 조정 가능)를 확인하며, 소유 프로세스가 죽은 잠금은 회수한다. 이사는 `director-watch`(또는 `status`의 이사 보기)로 kickoff별 신호·슬롯 점유·여유 메모리·PM liveness를 한 번에 본다. PM 스킬은 무거운 작업 전에 슬롯을 얻도록 적는다.
8. **결정적 테스트:** 역할 서열·접힘에서 이사의 위치, 이사를 `worker-start`·`role-terminal`로 띄우는 요청 거부, PM 머리글의 보고 대상, 신호 쓰기·조회·응답·중복 거부, `close-ready`와 `close` 입력의 HEAD 대조, 이사가 아닌 위치에서 `deliver`·`kickoff-release` 거부, 자원 슬롯 획득·해제·죽은 소유자 회수·메모리 하한 거부, 이사 항목 없는 기존 조직·등록부의 호환. 기존 eval 시나리오 체계에 이사 시나리오를 연결한다.
9. `npm run sync`, `npm run lint`, `npm test`가 통과하고, PR의 GitHub Actions `CI`가 통과한다. `docs/PLAN_STATUS.md` 등 공통 수치는 `npm run sync`로 맞춘다.

## 비목표

- 역할 터미널의 질문에 대리 응답하는 기능은 `supervised-prompt-answers` 브리프의 범위다. 이 kickoff는 그 브리프가 쓸 이사 역할과 신호 통로까지 만든다.
- 이사를 Orca 감독 worker나 headless worker로 실행하는 기능은 만들지 않는다.
- 버전 올리기와 릴리스는 이번 범위가 아니다. 역할 추가가 조직 파일 계약을 비호환으로 바꾸면 구현하지 말고 이사에게 결정을 요청한다(`AGENTS.md`의 버전 정책).

## 제약

- 저장소 규칙은 `AGENTS.md`를 따른다. 불필요한 변경 규율(`minimal-change-discipline` 병합분)을 지킨다.
- 이 kickoff 안에서 PM은 사용자에게 묻지 않고 이사에게 결정을 요청한다(지금은 한 줄 신호 `MAIN-DECISION:`·`CLOSE-READY:`와 공유 잠금 `.omt/heavy.lock` 규칙을 쓴다).
- 브랜치는 `feat/director-role`을 사용한다.

## 전달 방식

- `delivery`: `pull-request`, base 브랜치 `main`. 사용자는 kickoff가 완료되는 대로 이사가 `main`에 병합하도록 승인했다(2026-09-17).

## 근거 위치

- 역할과 접힘: `plugins/oh-my-teams/scripts/core.mjs`(`ROLES` 27행, `DEPTH_ROLES` 41행, `foldRole` 111행), `scripts/role-launch.mjs`(`DISPATCH_AUTHORITY` 62행, `roleSpec`의 `보고 대상`).
- 등록부: `scripts/kickoff-registry.mjs`(`selfPm`, claim 검증), `references/kickoff-registry.md`(「두 세션의 역할」, 「주인 체크아웃과 병합」).
- 스킬에서 "선언 세션"을 쓰는 곳은 14곳이다(`grep -rn "선언 세션" plugins/oh-my-teams/skills plugins/oh-my-teams/references`).
- 이사가 지금 쓰는 즉흥 방식: 이사 세션의 PM 공지(한 줄 신호), 공유 잠금 `C:\Users\kjsun\orca\oh-my-teams\.omt\heavy.lock`, 화면을 긁는 감시 스크립트. 감시 스크립트는 PM이 공지를 확인하는 문장 안의 `MAIN-DECISION:`을 신호로 잘못 읽었다. 구조화가 필요한 근거다.
- 사용자 요청 원문: "main 브랜치나, master 브랜치를 앞으로 '이사'라고 부를게. … 너가 최종 책임자야. main에 병합할지 아닐지 PM들을 관리하는거지. … 사용자는 이사랑만 말하고 PM은 이사가 관리하도록 하자." / "OMT가 구조적으로 강제하도록 해야하지 않나?? OMT의 공식 Role로 되어야 좋을 것 같긴한데."
