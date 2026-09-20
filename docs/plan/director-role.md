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
