# director-signal 중복 판정 기준과 설계 결정

## 목적

PM과 이사가 화면 문자열 신호(`MAIN-DECISION:`, `CLOSE-READY:`)와 공유 잠금(`.omt/heavy.lock`)으로 주고받던 임시 방식을 구조화된 런타임 명령으로 대체한다. 이 문서는 두 모듈(`director.mjs`, `resources.mjs`)의 설계 결정과 그 근거를 기록한다.

---

## 1. 신호 레코드 형식 (`director.mjs`)

### 1.1 레코드 구조

신호 레코드는 `.omt/director/inbox/<uuid>.json` 경로에 원자적으로 저장된다.

```json
{
  "schemaVersion": 1,
  "id": "<uuid>",
  "worktreeId": "<pm-worktree-id>",
  "kind": "decision | close-ready | blocked | progress",
  "text": "...",
  "status": "pending | replied | acknowledged",
  "sentAt": "<ISO-8601>",
  "head": "<sha>",    // close-ready 신호에만 존재
  "source": "<path>"  // close-ready 신호에만 존재
}
```

### 1.2 중복 판정 기준

**중복 정의**: 같은 `worktreeId`, 같은 `kind`, 같은 `text`를 가진 신호가 `status === "pending"` 상태로 이미 inbox에 존재하는 경우.

**근거**:
- PM이 같은 결정 요청을 실수로 두 번 보내는 상황을 막기 위해 중복을 거부한다.
- `replied`나 `acknowledged`가 된 신호는 중복 판정에서 제외한다. 같은 내용이라도 새로 처리할 수 있는 상황이 생길 수 있기 때문이다(예: 이전 결정이 번복된 경우).
- `head` 값은 중복 판정에 포함하지 않는다. `close-ready` 신호에서 HEAD가 바뀌어도 본문(`text`)이 같으면 중복으로 간주해 PM에게 먼저 기존 신호를 처리하도록 요구한다. HEAD가 다른 새 `close-ready` 신호가 필요하면 기존 신호를 `director-ack`으로 처리 완료로 표시한 뒤 다시 보낸다.
- 중복 판정은 inbox 잠금 안에서 수행되어 동시성 경쟁이 없다.

### 1.3 잘못된 kind 거부

`SIGNAL_KINDS`(`decision`, `close-ready`, `blocked`, `progress`)에 없는 kind는 레코드를 쓰기 전에 즉시 거부한다. 잘못된 kind가 영구 레코드로 남으면 조회와 close 입력 검증이 오작동한다.

### 1.4 미등록 워크트리 거부

`sendSignal`은 kickoff 등록부에서 `worktreeId`를 조회하고 없으면 거부한다. 등록부에 없는 워크트리가 신호를 보낼 수 있으면 이사가 어떤 kickoff의 신호인지 알 수 없고, 알림 대상 이사 터미널도 찾을 수 없다.

### 1.5 Orca 터미널 알림 실패 시 처리

레코드 쓰기는 Orca 알림과 독립적으로 성공한다. Orca 알림이 실패해도 레코드는 inbox에 남아 `director-inbox`로 조회할 수 있다. 알림 실패 여부와 오류 메시지는 결과 JSON에 `notified: false, notifyError: "..."` 형태로 전달된다. 알림은 `terminal send --wait-submit --json`으로 보내며, Orca가 입력만 수락하고 턴 시작을 증명하지 못한 경우는 `notified: true`가 아니다. `delivery`에 결과 분류(`outcome`)와 영수증 단계(`stages`), 요청 ID(`requestId`)가 남고, Orca의 오류 원문은 그대로 `notifyError`에 보존된다. 자세한 판정은 `references/orca-runtime.md`의 「프롬프트 전달과 제출 확인」에 있다.

### 1.6 close-ready 레코드와 close 입력

`close-ready` 신호는 `head`(통합 워크트리의 HEAD SHA)와 `source`(통합 워크트리 경로)를 담는다. `findCloseReadySignal` 함수가 해당 워크트리의 가장 최근 `close-ready` 레코드를 반환한다. `close` 스킬은 이 레코드의 `head`와 실제 HEAD를 비교해 불일치하면 경고하고 거부해야 한다(close 스킬 문서 수정은 다른 작업의 범위).

---

## 2. 자원 슬롯 관리 (`resources.mjs`)

### 2.1 슬롯 레코드 형식

슬롯 레코드는 `.omt/resources/<uuid>.json`에 저장된다. `pid`는 `--owner-pid`로 받은 소유 프로세스이며, 생략하면 `null`(소유자 미상)이다.

```json
{
  "schemaVersion": 1,
  "id": "<uuid>",
  "worktreeId": "<pm-worktree-id>",
  "kind": "test | worker | build",
  "note": "...",
  "pid": 12345,
  "hostname": "<hostname>",
  "acquiredAt": "<ISO-8601>"
}
```

### 2.2 메모리 하한 확인

`resource-acquire`는 `os.freemem()`으로 여유 메모리를 확인한다. 여유 메모리가 임계값 미만이면 즉시 거부한다. 임계값 기본값은 512 MiB이며, 조직 파일의 `policy.minFreeMemoryBytes`로 조정할 수 있다. 잠금을 획득한 뒤 회수하기 전에 먼저 확인하여 메모리가 부족한 상태에서 회수만 하는 부작용을 피한다.

### 2.3 죽은 소유자 회수

슬롯 획득 시 기존 슬롯의 `pid`와 `hostname`을 검사한다. 같은 호스트의 죽은 프로세스가 소유한 슬롯은 `fs.unlinkSync`로 회수한다. 다른 호스트이거나 liveness를 확인할 수 없으면 `"unverifiable"`로 보존하고 회수하지 않는다. `pid`가 `null`인 슬롯은 소유자가 죽었는지 판단할 수 없으므로 검사하지 않고 회수하지 않으며, `resource-release`로만 해제된다(선택 근거는 `director-role.md` 8.3). 이 규칙은 core.mjs의 `ownerHasExited`와 같은 원칙이며, 외부에서 주입할 수 있는 `liveness` 함수로 테스트 격리를 지원한다.

### 2.4 PM liveness 판정

`queryPmLiveness`는 Orca의 `worker-list`로 PM liveness를 조회하고 Orca의 값 `"live"`·`"exited"`·`"unverifiable"`을 그대로 반환한다. Orca 조회가 실패하거나 알 수 없는 값이거나 worker 목록에서 PM을 특정할 수 없으면 `"unverifiable"`을 반환하며, 목록에 있다는 사실만으로 `"live"`로 단정하지 않는다(상세는 `director-role.md` 8.2). 이는 저장소 기존 규율(`unverifiable`로 보존)과 동일한 원칙이다.

---

## 3. 공통 설계 원칙

- **원자적 쓰기**: 모든 레코드는 `core.mjs`의 `writeJSON`(UUID 임시 파일 → rename)으로 저장한다. 새로 구현하지 않는다.
- **파일 잠금**: 동시성 보호는 `core.mjs`의 `withFileLock`을 사용한다. 신호 inbox와 슬롯 디렉터리는 각자의 잠금 파일을 가진다.
- **재사용**: 기존 `core.mjs`의 유틸리티(`readJSON`, `readJsonDirectory`, `writeJSON`, `withFileLock`, `run`)를 그대로 쓰고 재구현하지 않는다.
