# 이사(Director) 역할 설계 결정

작성일: 2026-09-20  
작업 계약: `.omt/workflows/director-role/tasks/director-core-role/revisions/1.json`

---

## 1. 역할 배치 방식

### 결정: DIRECTOR_ROLE 상수 + ROLE_LADDER, ROLES는 감독 역할 목록 유지

**선택지**

A. `ROLES` 배열에 `"director"`를 맨 앞에 삽입한다.  
B. `DIRECTOR_ROLE` 상수와 별도 `ROLE_LADDER`(director 포함)를 두고, `ROLES`는 감독 worker 목록으로 유지한다.  
C. `director`를 `ROOT_ROLE` 위치에 놓고 `ROOT_ROLE`을 `"director"`로 바꾼다.

**채택: B**

`ROLES`는 `foldRole`, `resolveRole`, `depthRoles`, `definedRoles`, `validateOrg`의 `roles` 키 검사에서 "띄울 수 있는 감독 역할의 목록"으로 사용된다.
이사는 사용자가 대화하는 호스트 세션 자체이며, 감독 worker나 역할 터미널로 띄우는 대상이 아니다.
director를 `ROLES`에 추가하면 `foldRole`이 director를 역할 서열로 인식하여 기존 접힘 동작이 바뀌고, `validateOrg`가 조직 파일의 `roles`에 director 바인딩을 요구하거나 허용하게 된다.

버린 안과 이유:
- A: `ROLES` 기반 접힘 로직이 director → pm 방향으로 접히거나 pm → director로 올라가는 동작을 유발할 수 있다. 기존 테스트(role-dispatch, reduced-organization, run-depth)가 `ROLES[0] === "pm"` 가정에 의존하므로 비호환 변경이다.
- C: `ROOT_ROLE` 변경은 `validateOrg`의 `"PM must be the only root"` 검사, `depthRoles`, `activeRoles`, `roleSpec` 내부에서 `ROOT_ROLE`을 직접 참조하는 모든 경로에 영향을 주어 비호환 범위가 크다.

**구현**: `core.mjs`에 `DIRECTOR_ROLE = "director"` 상수와 `ROLE_LADDER = ["director", ...ROLES]` 상수를 추가한다. 기존 `ROLES`, `ROOT_ROLE`, `foldRole`, `resolveRole`, `depthRoles`는 변경하지 않는다.

---

## 2. 조직 파일에 이사 프로필을 저장할지 여부

### 결정: 조직 파일에 이사 프로필을 저장하지 않는다

**선택지**

A. 조직 파일의 `roles`에 `"director"` 바인딩을 선택 필드로 추가한다.  
B. 이사 프로필은 등록부(`kickoff-claim`) 항목에만 기록하고, 조직 파일은 변경하지 않는다.  
C. 별도 `director.json` 파일을 `.omt/` 안에 둔다.

**채택: B**

이사는 kickoff를 선언한 세션 자체이며, 여러 kickoff(따라서 여러 PM)에 걸쳐 하나의 이사가 있다. 조직 파일은 팀 구성을 정의하는 불변 계약이며, 이사 식별자는 kickoff마다 달라질 수 있는 실행 시점 정보다.

조직 파일에 `"director"` 바인딩을 추가하면 다음 문제가 생긴다:
- 현재 `validateOrg`는 `Object.keys(org.roles).every(role => ROLES.includes(role))`를 검사한다. director를 이 목록에 넣지 않으면 기존 조직 파일의 `"director"` 키를 거부하게 된다.
- ROLES에 director를 추가하지 않으면서 조직 파일의 roles 키로 허용하려면 `validateOrg` 검사를 이원화해야 하고 이는 비호환 위험이 있다.

버린 안과 이유:
- A: `validateOrg`의 역할 이름 허용 목록 변경이 필요하며, 비호환 스키마 변경 없이는 director 바인딩을 검증할 수 없다. 기존 조직 파일(director 없음)은 계속 유효하나, 이사가 있는 조직 파일은 자동으로 마이그레이션이 필요하다.
- C: 별도 파일 체계를 도입하면 기존 도구들이 이를 인식하도록 수정해야 하고, `kickoff-registry`와 이중화된다.

**마이그레이션 경로**: 이사 식별자는 `kickoff-claim` 요청의 선택 필드(`director`)로 전달되며 등록부 항목에 저장된다. 기존 이사 기록이 없는 항목은 그대로 조회·종료 가능하다(`validateEntry`가 `director`를 선택 필드로 본다).

---

## 3. 종료·병합 권한: 확인 수단이 없는 환경의 동작

### 결정: 이사 기록이 없는 기존 항목은 경고 후 허용, 이사 기록이 있는데 확인 불가인 경우는 거부

**선택지**

A. 이사 확인이 불가능한 모든 경우를 거부한다.  
B. 이사 확인이 불가능한 모든 경우를 경고 후 허용한다.  
C. 이사 기록 없는 기존 항목은 경고 후 허용, 이사 기록이 있는데 확인 불가인 경우는 거부한다.

**채택: C**

- 이사 기록이 없는 기존 항목(director 필드 없음): 이사 도입 이전에 등록된 kickoff다. 이 항목을 거부하면 기존 kickoff가 종료 불가능해지므로 계약 제약("기존 항목이 종료 불가능해지면 안 된다")을 위반한다. 따라서 경고 후 허용한다.

- 이사 기록이 있는데 확인 불가인 경우: 항목에 이사 식별자가 기록되어 있으나 호출자가 이사 체크아웃 경로에 있지 않거나 Orca 터미널 정보를 얻을 수 없는 경우. 이 경우 거부가 적절하다. 이사가 의도하지 않은 위치에서 종료·병합이 실행되는 것을 런타임이 방지해야 하기 때문이다. `--force`로 우회할 수 있으며, 이는 이미 `releaseKickoff`에 있는 takeover 패턴과 동일하다.

**확인 수단**: `deliver`와 `kickoff-release`는 호출자의 현재 작업 디렉터리(`process.cwd()`)가 등록부에 기록된 이사 체크아웃 경로(`director.checkoutPath`)와 동일한지 비교한다. Orca 터미널 핸들은 현재 환경에서 얻을 수 없으므로, 체크아웃 경로 비교만으로 확인한다.

---

## 4. force 플래그의 이중 역할(takeover 우회 + director 확인 우회)

### 결정: force 하나로 두 관심사를 모두 우회하고, 설계 문서에 근거를 명시한다

`releaseKickoff`의 `force` 파라미터는 (1) taken-over 인가 확인 우회와 (2) 이사 체크아웃 경로 확인 우회 두 가지를 동시에 수행한다. `delivery.mjs`의 `assertDirectorAuthority`도 동일한 형태다.

**겹침이 허용되는 이유**

- force는 "사용자가 직접 승인한 비상 출구"로 설계된 플래그다. taken-over 우회도, 이사 경로 우회도 모두 사용자의 명시적 지시가 있어야 한다는 동일한 전제 위에 있다. 이미 force를 사용하는 호출자는 사용자와의 별도 대화를 통해 권한을 확인받은 상태이므로, 두 확인을 별도 플래그로 분리해도 실질적인 보안 개선이 없다.
- 두 플래그로 나누면(예: `--director-force`) 사용자가 두 번 명시적으로 동의해야 하는 번거로움이 생기고, 기존 스크립트·문서와의 호환이 깨진다. 비상 출구의 마찰을 의도적으로 높이는 경우에만 이 비용이 정당화된다.
- 현재 수용 기준 6은 "PM 워크트리나 역할 터미널에서 호출하면 거부한다"이며, force 우회는 이미 기존 takeover 패턴에서 허용되어 있었다. 이사 확인도 동일한 force 조건으로 우회함으로써 일관성을 유지한다.

**버린 안**

- 분리 (`--director-force` 도입): API 변경 범위가 넓고(CLI, 테스트, 문서 일체 수정 필요), 실질적 보안 개선보다 사용 마찰 증가 효과가 더 크다. 비상 출구의 복잡도를 높여 정작 필요한 상황에서 쓰기 어렵게 만든다.

**결론**: force 겹침은 의도된 설계이며, 이 결정을 이 문서에 명시한다.

---

## 5. eval 시나리오 근거 연결 방식

### 결정: runtime.test.mjs에 이사 전용 테스트를 추가하고 scenarios.json이 그 이름을 가리킨다 (선택지 B 변형)

**선택지**

A. runtime.test.mjs에 전용 검사를 두고 이름만 바꾼다. 실행기 변경은 작지만 이미 director-role.test.mjs에 있는 검사를 복제하고 파일별 책임을 흐린다.  
B. 근거를 파일+테스트 이름으로 명시하거나 여러 허용 테스트 파일에서 이름을 해석하도록 실행기를 고친다. 기존 검사를 재사용할 수 있지만 manifest 호환과 중복 이름·0개 일치·복수 일치 거부 검사가 필요하다.

**채택: B 변형** (선택지 A와 B의 절충)

run.mjs의 실행기는 현재 `tests/runtime.test.mjs` 한 파일만 봄. director-role.test.mjs:132,152,163의 기존 테스트를 복제하는 대신, `runtime.test.mjs`에 이사 스킬 존재·필수 절·PM 이하 보고 체계를 함께 검사하는 독립 테스트를 추가했다. 이 방식이 채택된 이유:

- `evals/organization/run.mjs`의 실행기 파일 경로를 하드코딩 변경하지 않아도 된다. 실행기가 `runtime.test.mjs`만 보도록 설계된 것은 현재 범위에서 바꿀 경우 manifest 호환과 중복 이름 처리 등 부가 복잡도가 생긴다.
- 새 테스트는 director-role.test.mjs의 검사와 동일한 내용이지만, eval 시나리오의 근거 역할을 하는 단일 진입점으로 기능한다.
- `# pass 0` 거짓 통과 문제(항목 11)를 함께 수정해, 이름 불일치시 failed를 반환하도록 run.mjs를 수정했다.

**테스트 이름**: `"director skill exists, has authority-responsibility-limits section, and PM-and-below report to 이사"` (`tests/runtime.test.mjs` 끝에 추가)

---

## 6. pull-request 전달에서의 종료 검사 제공 방식

### 결정: 별도 `kickoff-check-close-ready` 명령을 제공한다

작업 계약: `.omt/workflows/director-role-w3/tasks/director-close-path/revisions/1.json`

**배경**

`deliverKickoff`는 `delivery.mode === "pull-request"`이면 139~143행에서 즉시 거부한다. close-ready 신호와 HEAD를 대조하는 검사(162행)는 그보다 아래에 있어 `pull-request` 전달에서는 실행되지 않는다. 브리프 수용 기준 4의 마지막 항목("close-ready 신호가 없거나 HEAD가 다르면 경고·거부한다")이 실제로는 동작하지 않는 결함이다.

**선택지**

A. `deliverKickoff` 내부 로직을 재구성해 `pull-request` 모드에서도 신호 검사만 실행하고 실제 병합은 건너뛴다.

B. `delivery.mjs`에 `checkCloseReady(orgFile, worktreeId, head)` 함수를 추가하고, `teams-org.mjs`에 `kickoff-check-close-ready` 명령으로 배선한다.

C. `director-signal`의 `close-ready` 조회를 지시하는 문서만 수정하고 런타임 강제를 만들지 않는다.

**채택: B**

- A: `deliverKickoff`의 인터페이스를 변경하면 기존 `local-merge` 동작과 기존 테스트가 영향을 받는다. 함수가 조건에 따라 두 가지 의미를 갖게 되어 호출 계약이 불명확해진다.
- C: 문서만으로는 런타임 강제가 없으므로 브리프 수용 기준 4를 충족하지 못한다.
- B: `delivery.mjs`에 집중된 독립 함수로 제공하면 기존 `deliverKickoff`를 건드리지 않고 `pull-request` 경로에서도 신호 검사를 수행할 수 있다. 이사는 PR을 병합하기 전에 `kickoff-check-close-ready`를 실행해 신호 유무와 HEAD 일치를 확인한다. 이 명령은 상태를 변경하지 않는 조회·검사 명령이므로 반복 실행이 안전하다.

**신호가 없는 기존 kickoff 처리**

이사 도입 전에 등록된 kickoff는 신호 통로 자체가 없었다. 이런 항목에 대해 신호 검사를 거부하면 기존 kickoff가 종료 불가능해지므로, 계약 제약을 위반한다. 따라서 기존 `deliverKickoff`와 동일한 정책을 적용한다: 신호가 없으면 경고 후 진행 허용(warning), 신호가 있는데 HEAD가 다르면 오류로 거부한다.

**구현 위치**: `delivery.mjs`에 `checkCloseReady` 함수 추가, `teams-org.mjs`에 `kickoff-check-close-ready` 명령 배선.

---

## 7. PR 병합 기록 명령

### 결정: `kickoff-merge-record` 명령을 추가하고 이사 권한 검사를 `assertDirectorAuthority`로 적용한다

**배경**

`kickoff-registry.mjs`의 `recordDelivery`는 export되어 있지만 `teams-org.mjs`에 CLI 명령으로 배선되지 않았다. PR 방식으로 병합한 사실을 등록부에 남길 공식 경로가 없고, `entry.delivered.mergeCommit`을 요구하는 `kickoff-branch-cleanup`을 `pull-request` kickoff에서는 쓸 수 없었다.

**선택지**

A. `deliver` 명령의 `pull-request` 거부를 완화해 직접 `recordDelivery`를 호출하게 한다.

B. 새 `kickoff-merge-record` 명령을 추가하고 `recordDelivery`를 호출하며 이사 권한 검사를 `assertDirectorAuthority`로 적용한다.

**채택: B**

- A: `deliver`는 `local-merge` 전용이다. 이 의미를 바꾸면 문서·테스트 전체와의 호환이 깨진다.
- B: 별도 명령으로 분리하면 역할이 명확하다. `deliver`는 실제 git 병합을 수행하고, `kickoff-merge-record`는 외부(PR)에서 병합된 사실만 기록한다. 이사 권한 검사는 `delivery.mjs`의 `assertDirectorAuthority`를 그대로 재사용한다.

**이사 기록이 없는 기존 항목**: `assertDirectorAuthority`와 동일한 정책을 따른다. 이사 기록이 없으면 경고 후 허용, 이사 기록이 있으면 체크아웃 경로를 확인한다.

**인자**: `--org FILE --worktree ID --head SHA --merge-commit SHA`
`--head`는 전달한 kickoff HEAD, `--merge-commit`은 PR 병합 커밋이다.

**구현 위치**: `teams-org.mjs`에 `kickoff-merge-record` 케이스 추가, `ALLOWED_OPTIONS`와 `REQUIRED_OPTIONS`에 등록. `assertDirectorAuthority`를 `delivery.mjs`에서 export하여 재사용한다.

---

## 8. 남은 결함 네 가지의 수정 (2026-09-21, 최신 origin/main 2.6.1 위에서)

작업 계약: `.omt/workflows/director-role-w4/tasks/director-mainline/revisions/1.json`

각 항목의 결정적 테스트는 `tests/director-role.test.mjs`와 `tests/director-signal.test.mjs`에 있다.

### 8.1 accepted-risk authority의 스키마와 런타임 일치

**결정: 스키마에 `director`를 추가하고, 허용 목록의 정본을 `gates.mjs`의 `ACCEPTED_RISK_AUTHORITIES` 하나로 둔다.**

브리프 수용 기준 3은 사용자 승인을 요구하던 경로(`accepted-risk`의 `authority: user`)를 이사 결정으로 받을 수 있게 하라고 정한다. 런타임(`gates.mjs`)은 이미 `pm`·`user`·`director`를 받았지만 `schemas/review.schema.json`이 `pm`·`user`만 열거해서, 이사가 결정한 위험을 담은 review 입력은 스키마를 따르는 소비자에게 거부되었다.

**선택지**

A. 스키마만 `["pm", "user", "director"]`로 고친다.
B. A에 더해 런타임이 쓰는 목록을 `ACCEPTED_RISK_AUTHORITIES`로 내보내고, 오류 문구도 그 목록에서 만든다.
C. 런타임을 `pm`·`user`로 줄인다.

**채택: B.** C는 이사 결정을 담는 경로를 없애 수용 기준 3에 어긋난다. A만으로는 두 목록이 다시 어긋날 수 있으므로, 목록을 한 곳에 두고 테스트가 스키마의 열거와 그 목록을 직접 비교하게 한다. 테스트는 각 authority가 `validateReviewInput`을 통과하고 `senior`·`junior`·누락은 거부되는지도 확인한다. Senior 스킬의 서술(`pm`·`user`)은 Senior가 스스로 위험을 수용하지 않는다는 한계를 말하는 것이어서 바꾸지 않았다.

### 8.2 PM liveness는 Orca의 값을 그대로 쓴다

**결정: `queryPmLiveness`는 `live`·`exited`·`unverifiable`을 반환하고, 조회 실패와 알 수 없는 값은 `unverifiable`로 보존한다.**

이전 구현은 `alive`·`dead`만 인식하고 나머지를 `unverifiable`로 돌렸는데, Orca는 그 두 값을 보고하지 않는다. 실제 `worker-list`는 각 항목의 `projection.liveness`에 다음 모양을 담는다.

```json
{"verdict": "live", "observedAt": 1789958205199, "source": "agent_status"}
{"verdict": "unverifiable", "reason": "stale_status", "observedAt": 1789895814805}
```

그래서 살아 있는 PM도 항상 `unverifiable`로 보였다. `orca-runtime.md`의 「worker-list와 liveness」 절이 정한 세 값과 반환 값을 맞추었다. 프로세스 PID를 검사하는 `processLiveness`(`alive`·`dead`·`unverifiable`)는 자원 슬롯 회수용이며 관측 대상이 달라 그대로 두었다. 두 어휘를 섞지 않도록 반환 타입을 JSDoc에 명시했다.

Orca가 실제로 쓰는 값을 인식하면서 함께 정한 규율은 다음과 같다.

- 목록에 PM 워크트리가 있다는 사실만으로 살아 있다고 판단하지 않는다. `verdict`가 `live`일 때에만 `live`다.
- 알 수 없는 값(옛 구현이 만들어 낸 `alive`·`dead` 포함), 조회 실패, 응답 파싱 실패, PM 워크트리 항목 부재는 모두 `unverifiable`이다.
- 같은 워크트리에 dispatch가 여러 개면 첫 항목이 아니라 전부를 본다. 하나라도 `live`이면 `live`이고, 모두 `exited`일 때에만 `exited`이며, 그 밖에는 `unverifiable`이다. 실제 응답에는 이미 끝난 dispatch가 앞에 오는 일이 있어서 첫 항목만 보면 살아 있는 PM을 놓친다. 종료는 확인되지 않은 항목이 하나라도 남으면 단정하지 않는다.
- 워크트리 대조는 `<uuid>::<path>` 식별자나 경로 전체의 일치로 한다. 부분 문자열로 비교하면 `<path>-2` 같은 형제 워크트리의 `live`가 PM의 것으로 읽힌다. 이전에는 `alive`가 나오지 않아 드러나지 않았으나, `live`를 인식하면 오판이 곧바로 보고된다.

테스트는 위 실제 응답 모양을 fixture로 고정한다. 명령 실행기를 `execute` 인자로 주입할 수 있게 해서(`deliverKickoff`와 같은 방식) Orca 없이 결정적으로 검사한다.

### 8.3 자원 슬롯 소유자의 기본값

**결정: `--owner-pid`를 생략하면 소유자를 알 수 없는 슬롯(`pid: null`)으로 기록하고, 자동 회수 대상에서 뺀다. 결과에 경고를 싣는다. 값이 있으면 양의 정수여야 한다.**

이전에는 생략하면 소유자가 acquire를 실행한 CLI 자신의 PID가 되었다. CLI는 곧 종료하므로 슬롯이 곧바로 죽은 소유자의 것이 되어 다음 획득에서 회수되었고, 슬롯이 무거운 작업을 보호하지 못했다.

**선택지**

A. `--owner-pid`가 없으면 거부한다.
B. 소유자 미상으로 기록하고 회수 대상에서 뺀다.
C. 부모 프로세스(`process.ppid`)를 소유자로 추정한다.

**채택: B.**
- A: 슬롯을 얻는 쪽은 대개 셸을 통해 CLI를 실행하는 세션이라 오래 사는 자기 PID를 알기 어렵다. 거부하면 자원 조율 자체를 우회하게 만든다.
- C: 추정한 PID는 셸 하나만 가리켜 작업보다 먼저 끝날 수 있다. 저장소는 소유자를 확인하지 못하면 죽었다고 단정하지 않는다(`ownerHasExited`, `processLiveness`의 `unverifiable`). 추측으로 소유자를 정하는 것은 그 원칙에 어긋난다.
- B: 회수가 늦어지는 쪽(슬롯이 남는 오류)이 회수가 이르는 쪽(작업 중인 슬롯이 사라져 동시 점유를 허용하는 오류)보다 안전하고 눈에 보인다. 남은 슬롯은 `director-watch`에 나타나며 `resource-release`로 해제한다. 비용은 소유자가 죽어도 자동 회수가 없다는 점이므로, 결과의 `warning`과 이사 스킬이 `--owner-pid`를 넘기도록 안내한다.

`--owner-pid abc` 같은 값은 이전에는 `NaN`으로 기록되어 JSON에서 `null`이 되었다. 이제는 양의 정수가 아니면 거부한다. 슬롯 회수 순회는 `pid`가 `null`인 슬롯을 명시적으로 건너뛰므로, 주입된 `liveness` 함수가 모두 죽었다고 답해도 회수하지 않는다.

### 8.4 close-ready 신호가 없을 때의 문서와 동작

**결정: 동작을 유지하고 문서를 동작에 맞춘다.** 신호가 있는데 HEAD가 다르면 거부하고, 신호가 없으면 경고한 뒤 진행한다.

director 스킬과 close 스킬의 도입부는 신호가 없어도 거부한다고 적었으나, `checkCloseReady`는 신호가 없으면 경고 후 `legacy: true`로 진행한다. 이 동작은 6절이 근거를 둔 기존 kickoff 호환이다. 신호 통로가 생기기 전에 등록된 항목은 신호를 보낼 수 없으므로, 신호가 없다고 거부하면 종료할 수 없게 된다. 브리프 수용 기준 4의 "경고·거부"는 두 경우에 각각 대응한다(없으면 경고, HEAD가 다르면 거부).

**선택지**

A. 문서를 동작에 맞춘다.
B. 동작을 문서에 맞춰, 신호가 없으면 거부한다.
C. 이사 기록이 있는 새 항목만 신호를 요구하고 없는 옛 항목은 경고한다.

**채택: A.** B는 기존 kickoff 호환을 깨서 제약을 어긴다. C는 새 항목의 강제를 높이지만 등록 시점이 아니라 `director` 필드 유무로 신구를 가르게 되어, 이사가 PM 무응답 상황에서 종료해야 할 때 우회 수단이 필요해진다. 이번 범위는 문서와 동작의 불일치를 없애는 것이므로 C는 이후 결정으로 남긴다. close 스킬에는 신호 없이 종료했다면 PM의 완료 준비 확인이 없었다는 사실을 보고에 적도록 했다. 테스트는 두 스킬이 실제 동작과 같은 문장을 쓰고 "신호가 없거나 … 거부" 문구를 다시 쓰지 않는지 검사하며, 동작 자체는 7절의 `checkCloseReady` 테스트가 검사한다.
