# 요구 원장과 감사 역할 설계 (#139)

- 작성일: 2026-09-27
- 관련 이슈: [#139](https://github.com/inho-team/oh-my-teams/issues/139)
- 관련 브리프: `.omt/briefs/139-auditor-2026-09-27.md`, 보충 계약 `t1-addendum-1.md`·`t1-addendum-2.md`·`t1-addendum-3.md`·`t1-addendum-4.md`
- 상태: 이사가 22:31판 초안을 반려(t1-addendum-3.md)한 뒤 8개 항목을 전부 반영해 개정했고(HEAD 68eb78d), 그 개정판을 검토한 이사가 남은 모순 5개를 보충 계약 4로 지적해 해당 절만 다시 고쳤다. 구현은 이 문서를 커밋한 뒤 진행한다.

## 문제

#139는 좁혀진 수용 기준이 게이트를 모두 통과하고도 사용자 원문을 충족하지 못한 채 `completed`로 닫힌 사고를 보고한다. 원인은 세 가지다.

1. 이사가 자신 있게 확정했다고 믿는 좁힘에는 사용자 확인 절차가 없다.
2. `kickoff-check-close-ready`·`deliverKickoff`·`kickoff-release --reason completed` 가운데 어느 것도 사용자 원문을 참조하지 않는다. `checkCloseReady`(`delivery.mjs:125-142`)는 close-ready 신호의 `head`와 요청된 `head`만 비교하고(신호가 없으면 경고만 하고 통과), `releaseKickoff` reason=completed(`kickoff-registry.mjs:649-656`)는 `entry.delivery?.mode !== "local-merge" || entry.delivered || force`만 검사한다. 수용 기준·원문·사용자 확인은 전혀 검사하지 않는다.
3. 화면 확인 증거가 워커의 워크트리에만 남고 사용자에게 도달했다는 기록이 없다.

이 설계는 두 과제를 하나로 묶는다. **A. 요구 원장**은 감사 실행 여부와 무관하게 항상 강제되는 런타임 게이트다. **B. 감사 역할**은 원장과 같은 기록·검증 경계를 재사용해 브리프 단계와 결과 단계에서 비판적으로 검토하는 선택적 역할이다.

## 반려 사유와 이번 개정의 대응

이사는 22:31판을 8개 항목에서 반려했다(`t1-addendum-3.md`). 이번 개정이 각 항목에 대응하는 절을 표로 남긴다.

| 반려 항목 | 대응 절 |
|---|---|
| 1. `--terminal` 인자 대조로는 신원 증명 불가 | B.6 (env var + launch ledger 대조로 교체) |
| 2. fidelity·presentation·exception이 계약에 안 묶임, `__legacy__` 포괄 면제, realpath 검증 없음 | A.3, A.6 |
| 3. draft→확인→claim 교착 | A.1, A.2 |
| 4. checked 완전성, evidenceKey null 생략 | B.3, B.4 |
| 5. accept·close-ready 발신 경로 미배선, 브리프 감사를 뒤로 미룰 수 있음 | A.5, B.5, B.7 |
| 6. "실제 실행은 작업물에 포함 안 됨" 문구가 보충 계약 1과 모순 | B.9, G |
| 7. `deliverKickoff` 본문 자체에 검사가 없음(선택적 gate 콜백 우회 가능) | A.5 |
| 8. 호환 영향 설명이 부정확함 | C |

이사는 이 개정판(68eb78d)에서 환경 신원+launch 기록, hash 연결, 빈 원장 거부, 실제 감사 실행 포함은 개선됐다고 확인했다(`t1-addendum-4.md`). 남은 모순 5개만 해당 절에서 다시 고쳤다.

| 보충 계약 4 항목 | 대응 절 |
|---|---|
| 1. 순서와 fingerprint 모순(제시가 결과 감사를 무효화) | A.5([경로 A]/[경로 B]) |
| 2. 응답 증거 재검증 누락 | B.3(evidenceFingerprint 확장), B.4(조건 6) |
| 3. 브리프 감사 강제 위치가 틀림(`requirements-fidelity`는 구현 이후) | A.5(구현 착수 지점), B.5 |
| 4. PM accept의 감사 요구가 교착을 만듦 | A.5, B.5(PM accept와 close-ready·최종 셋의 검토 대상 구분) |
| 5. 감사 대상 kickoff 결정 방식이 틀림(`args.worktree`는 감사 워크트리) | B.2(`--state`로 결정) |

## 조사로 확정한 기존 코드 근거

이번 개정을 쓰기 전에 다음을 실제 코드에서 확인했다(추측 아님).

- **`ORCA_TERMINAL_HANDLE` 관례**: `prompt-supervision.mjs:1024`(`authorizeLaunch`)와 `:1106`(`answerPrompt`)가 `env.ORCA_TERMINAL_HANDLE ?? null`로 호출자를 식별하고, 없으면 `"caller-unknown"`으로 거부한다(`:1028`). `role-terminal.mjs:612`도 같은 키를 `(supervision.env ?? process.env).ORCA_TERMINAL_HANDLE`로 읽는다. 이 파일의 한계 선언(25-31줄)이 명시하듯, 이 값 자체를 위조하는 공격은 막지 못하지만 "다른 역할의 handle을 CLI 인자로 복사해 넘기는" 결함은 막는다 — 이것이 이번 코드베이스가 이미 받아들인 신뢰 경계이며, 보충 계약 3 1번이 요구하는 개선의 정확한 기준선이다.
- **launch ledger가 실제로 무엇을 기록하는가**: `teams-org.mjs`의 `case "role-terminal"`(1612줄)은 `roleCommand(org, args.role, ...)` → `assertWorktreeUnshared(...)`(1634줄, 역할 무관 공용 검사) → `openRoleTerminal(...)`(1653줄) → `recordLaunchSafely(...)`(1691-1705줄)를 거친다. `recordLaunchSafely`는 `usage-ledger.mjs`의 `recordLaunch`(179-240줄)를 호출해 `{schemaVersion, at, via, role, profile, provider, modelRequested, modelResolved, effortRequested, worktreePath, worktreeSelector, terminal, workerId, callerCwd, workflowId, kickoffPmWorktreeId}` 한 줄을 `usage/launches.jsonl`에 append한다. `terminal`은 `openRoleTerminal`이 반환하는, Orca가 그 순간 새로 만든 터미널에 직접 부여한 handle(`role-terminal.mjs:698,942`)이다. `kickoffPmWorktreeId`는 `resolveLaunchKickoff`(`usage-ledger.mjs:130-147`)가 `stateDir`(entry.pm.stateDir과 대조) 또는 `callerCwd`(entry.pm.path 포함 여부)로 자동 계산한다. `role-terminal.mjs` 자체는 역할별 분기가 없고 `usage-ledger.mjs`를 아예 import하지 않는다 — 이 로직 전부가 `teams-org.mjs`의 CLI 진입점에 있다.
- **`role-terminal.mjs`에 이미 있는 것과 없는 것**: `assertDirectorAuthority`나 `assertWorktreeUnshared`를 이 파일 자신은 쓰지 않는다(호출자인 `teams-org.mjs`가 이미 검사했다고 가정한다). `roleTitle`(287-293줄)은 `ROLE_TITLE_TAGS`에 없는 역할이면 `assert`로 실패하므로, `auditor: "[Auditor]"` 항목을 반드시 추가해야 한다. director 전용 권한 검사와 "검토 대상 워크트리와 분리" 검사는 기존 역할 중 어느 것도 받지 않으므로, `teams-org.mjs`의 `case "role-terminal"` 안에 `command.role === "auditor"`일 때만 도는 새 코드로 추가해야 한다(재사용할 기존 호출이 없다).
- **`implementationExecutionId`는 이미 쓰이는 개념이지만 터미널 handle이 아니다**: `workflow.mjs`의 `reworkTask`(1531-1636줄)가 1559-1565줄에서 `const executionId = item.workerRunId ?? item.execution?.executionId;`를 계산해 `review.implementationExecutionId === executionId`를 대조한다. 이 `executionId`는 워크플로/디스패치 수준의 리시트 식별자(예: `` `headless:${input.receipt.executionId}` ``, `workflow.mjs:950`)이지 `ORCA_TERMINAL_HANDLE` 형식이 아니다. task-id로부터 터미널 handle을 직접 역산하는 함수는 `workflow.mjs`에 없다(이번 조사 범위 밖의 확인 못한 사실로 명시한다). 따라서 B.4의 독립성 검사는 "구현 실행 신원"과 "이의·응답 호출자 신원"을 하나의 값으로 섞지 않고 두 가지 서로 다른 사실로 나눠 증명한다(B.4 참조).
- **터미널 생존 조회**: 전용 export는 없고, `prompt-supervision.mjs:961-967`의 `assertRoleWorktree`가 쓰는 `runOrcaJson(orca, ["terminal", "show", "--terminal", terminal], {execute})` 범용 호출이 기존 관례다. `verifySupervisor`(336-389줄)의 `orchestration run-current` 방식은 auditor가 Run의 coordinator로 바인딩되지 않으므로 auditor 신원 증명에는 맞지 않지만, PM 신원 증명(브리프 감사가 아닌 결과 감사의 PM 응답 검증, B.6)에는 정확히 그대로 재사용된다: `kickoff.runId && bound.id === kickoff.runId`이면 그 호출자는 이 kickoff의 PM이다.
- **다섯 게이트 지점의 실제 배선**(delivery-gates-research 보고):
  - `deliverKickoff`(`delivery.mjs:165-293`)는 247줄 `await gate({source, base})` 하나만 검사를 호출하고, `gate`는 170줄에서 `async () => undefined`가 기본값이다 — **콜백을 생략하면 우회된다.**
  - `checkCloseReady`(`delivery.mjs:125-142`)는 close-ready 신호의 head 비교만 하고, gates.mjs·evidence.mjs 호출이 **애초에 없다.**
  - `releaseKickoff` completed 분기(`kickoff-registry.mjs:649-656`)는 `local-merge`+`delivered` 구조 확인만 하고, 리뷰·verify와 **무관하다.**
  - PM `accept`(`gates.mjs:444-493` `acceptOutcomeLocked`)는 469줄 `await gateCheck(...)`을 **무조건** 호출하고, `gateCheck`(321-365줄)도 `assertReportBinding`·`validateEvidence`를 무조건 호출한다 — 다섯 지점 중 유일하게 이미 생략 불가능한 지점이다.
  - close-ready 발신(`director.mjs:83-155` `sendSignal`)은 kind/text/중복pending만 검사하고, gates.mjs·evidence.mjs·delivery.mjs 어느 것도 **호출하지 않는다.**
- **evidence 경로의 realpath/symlink/traversal 방어는 이미 존재한다**: 별도 함수가 아니라 `core.mjs`의 `inside(repo, relative)`가 이 역할을 겸한다. `evidence.mjs:93` `workspaceContents`와 `:537` `checkCitations`가 이를 통해서만 파일을 열고, 주석(87-90줄)이 "symlink를 해석해서 저장소 밖을 가리키면 예외를 던진다"고 명시한다. 새 원장의 제시 증거 검증은 새 함수를 만들지 않고 `inside(ownerRoot, evidence.ownerPath)`를 그대로 재사용한다.
- **claim 스키마 확장이 필요함**: `kickoff-registry.mjs:43-54`의 `CLAIM_KEYS`는 고정 배열이라 `requirements` 필드를 claim에 넣어도 428줄 `writeJSON`에는 반영되지 않고 무시 경고만 남는다. `CLAIM_KEYS`와 `validateEntry`(173-223줄)를 확장해야 원장을 kickoff 엔트리 안에 실을 수 있다.
- **`taskHash`/`ledgerHash`는 같은 해시 함수를 공유한다**: `contracts.mjs:262-265`의 `taskHash`는 `hash(canonicalize(task))`이고 `canonicalize`(243-253줄)는 객체 키를 재귀 정렬한다. `core.mjs`의 이 `hash`를 `evidence.mjs`도 그대로 import해서 쓴다. `ledgerHash`도 이 함수를 그대로 재사용한다.
- **`validateReviewRequirements`(`contracts.mjs:170-203`)**는 183-185줄에서 `review.kind === "agent-review" && review.role === "senior"` 등호 비교로 하드코드돼 있다. `"auditor"`를 추가하려면 등호 비교를 배열 포함 검사로 바꿔야 한다(이번 범위에서 실제로 필요하면 C절에 영향으로 기록).

## A. 요구 원장

### A.1 저장 위치와 두 단계 파일

원장은 **claim 이전의 draft**와 **claim 이후의 확정 원장**, 두 단계로 나뉜다. 이렇게 나누는 이유는 A.2에서 설명하는 교착을 없애기 위해서다.

**draft 단계** (claim 이전, 인증 없음 — 아직 아무것도 등록되지 않았으므로 director 권한 검사 대상이 없다):

```
<organization.json이 있는 디렉터리>/requirements-drafts/<sha256(worktreeId)>.json
```

```jsonc
{
  "schemaVersion": 1,
  "worktreeId": "repo::/path/to/pm-worktree",
  "statements": [{ "id": "s1", "text": "카드 형태를 다 바꿔놔.", "source": "이슈 #139 사용자 원문" }],
  "criteria": [
    {
      "id": "c1", "text": "box-shadow가 사라진다.",
      "derivedFrom": ["s1"], "scope": "narrower", "userVisible": true,
      "confirmation": null
    }
  ],
  "confirmations": [
    {
      "criterionId": "c1",
      "textHash": "sha256(...)",
      "confirmedAt": "2026-09-27T00:10:00Z",
      "userQuote": "네, 카드 모양만 없애면 됩니다",
      "recordedFromCheckout": "/Users/jinsungkim/orca/oh-my-teams"
    }
  ]
}
```

**확정 원장** (claim 이후, `kickoff-registry.mjs`의 `CLAIM_KEYS`/`validateEntry`가 `entry.requirements`로 확장해 받는다):

```
<organization.json이 있는 디렉터리>/requirements/<sha256(worktreeId)>.json
```

이 파일은 draft를 그대로 복사해 시작하고, 이후 `presentations`·`fidelityChecks`·`exceptions`가 append된다. `statements`/`criteria`는 claim 이후 `requirements-amend`(director 전용, A.4)로만 바뀐다. 쓰기는 전부 `withFileLock`(kickoff-registry.mjs와 같은 lock-디렉터리-append 패턴) 안에서 일어난다.

```jsonc
{
  "schemaVersion": 1,
  "worktreeId": "...",
  "statements": [ /* draft와 동일, requirements-amend로만 변경 */ ],
  "criteria": [ /* 동일 */ ],
  "confirmations": [ /* claim 시점에 draft에서 복사됨 */ ],
  "presentations": [
    {
      "criterionId": "c1", "head": "abc123", "ledgerHash": "sha256(...)",
      "evidence": { "ownerPath": ".omt/requirements-evidence/c1-abc123.png", "sha256": "..." },
      "userQuote": "이제 카드가 없어졌네요", "outcome": "confirmed",
      "recordedAt": "2026-09-27T01:00:00Z"
    }
  ],
  "fidelityChecks": [
    {
      "head": "abc123", "ledgerHash": "sha256(...)",
      "recordedAt": "...", "recordedBy": "pm",
      "items": [
        { "type": "statement", "id": "s1", "status": "met", "evidence": "..." },
        { "type": "criterion", "id": "c1", "status": "met", "evidence": "..." }
      ],
      "directorConfirmedAt": null
    }
  ],
  "exceptions": [
    {
      "id": "e1",
      "scope": [{ "type": "criterion", "id": "c1" }],
      "ledgerHash": "sha256(...)", "head": "abc123",
      "reason": "...", "userQuote": "...", "unmetFacts": "...",
      "recordedAt": "..."
    }
  ]
}
```

### A.2 draft → 사용자 확인 → 검증된 claim (교착 없는 흐름, 보충 계약 3 3항)

22:31판의 결함: `requirements-confirm`이 `assertDirectorAuthority(entry, ...)`로 인증하려면 kickoff 엔트리(`entry.director.checkoutPath`)가 이미 등록돼 있어야 하는데, `kickoff-claim`은 이미 확인된 원장을 요구한다. `entry.director`는 claim 안에만 존재하는 선택 필드(`kickoff-registry.mjs:376-422`)이고, 조직 파일 어디에도 claim과 독립적인 "이 조직의 director 체크아웃"이라는 필드가 없다(`grep`으로 확인, 존재하지 않음). 그러므로 claim 이전에는 대조할 등록된 director가 없다.

**해결**: draft 단계의 확인 권한은 kickoff 레지스트리를 조회하지 않고, **같은 claim 제출 안에서 자체 정합성**으로 검사한다.

1. `requirements-draft`(director 또는 PM, 인증 없음) — draft 파일에 `statements`/`criteria`를 쓴다. `criteria`는 각각 `scope`(`"equal"`|`"narrower"`, 기본값 없음)를 명시해야 한다. **빈 `statements`나 빈 `criteria`는 이 명령이 즉시 거부한다**(보충 계약 3 3항 후단) — 의무 검사를 빈 배열로 무력화하는 경로를 원천 차단한다.
2. `requirements-confirm --draft`(director만, 아래 인증) — narrower criterion에 `confirmationTextHash(criterion, statements)`로 묶인 confirmation을 draft에 추가한다. **인증**: 이 명령은 `--checkout <path>`를 받아 `path.resolve(process.cwd()) === path.resolve(args.checkout)`를 검사하고(자기 위치 자기 선언, 등록 조회 없음), 통과하면 `confirmation.recordedFromCheckout = <그 resolved 경로>`를 기록한다. 이 시점에는 "누가 진짜 director인가"를 증명할 등록된 값이 없으므로, 이 확인이 증명하는 것은 "누군가 이 경로에서 이 명령을 실행했다"는 사실뿐이다 — 그 경로가 실제 director의 것인지는 3번에서 닫는다.
3. `kickoff-claim`(PM, `--from <claim.json>`) — claim은 `director: {terminalHandle, checkoutPath}`와 `requirements: <draft 파일 내용>`을 함께 담는다. `validateLedgerForClaim(claim.requirements, claim.director)`가 **같은 claim 제출 안에서** 다음을 검사한다.
   - 모든 narrower criterion의 `confirmation.textHash === confirmationTextHash(criterion, statements)`.
   - **`confirmation.recordedFromCheckout === path.resolve(claim.director.checkoutPath)`.** 이것이 교착을 닫는 지점이다: draft-confirm이 어느 경로에서 실행됐는지는 2번에서 이미 실제로 그 경로에 있던 프로세스가 남긴 사실이고, claim은 "그 kickoff의 director가 어느 경로인가"를 스스로 선언한다. 두 값이 다르면(예: PM이 자신의 경로에서 confirm을 실행하고 director의 checkoutPath를 사칭) claim이 거부된다. 같으면, 이후 이 kickoff의 모든 director 전용 명령이 `entry.director.checkoutPath`로 그 경로를 검증 기준으로 삼게 되므로, "그 경로에서 confirm을 실행한 프로세스"와 "그 이후 그 경로에서 오는 모든 director 호출"이 같은 신뢰 경계 안에 들어온다(이 코드베이스가 이미 받아들인 `assertDirectorAuthority`의 신뢰 모델과 동일한 수준).
   - `statements.length > 0 && criteria.length > 0`(재확인, draft에서 이미 막았어도 claim 시점에 다시 막는다 — draft를 거치지 않고 조작된 `--from` JSON을 직접 넣는 경로 방지).
4. claim이 통과하면 `requirements/<sha256(worktreeId)>.json`에 확정 원장을 쓰고 `entry.requirements = { ledgerHash }`를 기록한다. **이 시점 이후로는** `entry.director.checkoutPath`가 등록돼 있으므로, criterion 문구를 바꾸는 `requirements-amend`나 재확인은 A.4 표대로 `assertDirectorAuthority(entry, ...)`를 그대로 쓴다 — 더 이상 교착이 없다.

### A.3 ledgerHash, 계약 연결, 완전성(수용 기준 `narrowing-needs-confirmation`, `presented-evidence-gate`; 보충 계약 3 2항)

```
ledgerHash(ledger) = hash({ statements: ledger.statements, criteria: ledger.criteria.map(criterionWithoutConfirmation) })
confirmationTextHash(criterion, statements) = hash({
  criterionText: criterion.text,
  statementTexts: criterion.derivedFrom.map(id => statements.find(s => s.id === id).text),
})
```

`hash`는 `contracts.mjs`의 `taskHash`가 쓰는 것과 같은 `core.mjs`의 canonical-JSON sha256이다.

**모든 기록이 `ledgerHash`에 묶인다** — 22:31판은 narrower confirmation만 해시에 묶고 presentation/fidelityCheck/exception은 `head`에만 묶었는데, 이러면 같은 HEAD에서 `requirements-amend`로 `scope`나 `userVisible`을 바꿔도 이전 presentation이 유효한 채로 남는 결함이 생긴다. 이번 개정은 **presentations·fidelityChecks·exceptions 전부 `{head, ledgerHash}`를 함께 저장**하고, 소비하는 쪽(A.5의 게이트)은 두 값을 모두 현재 상태와 비교한다. `ledgerHash`가 하나라도 다르면(문구·scope·userVisible 중 무엇이 바뀌었든) 그 기록은 무효다 — 재사용 불가.

**종료 게이트가 검사하는 것**(`assertLedgerCloseReady({ledger, head, ownerRoot, registeredWorktreePaths})`):

1. **userVisible 기준의 제시 증거**: 각 `userVisible: true` criterion에 대해, 가장 최근 presentation이 `head`와 `ledgerHash`가 모두 현재 값과 같고, `evidence.ownerPath`가 `inside(ownerRoot, evidence.ownerPath)`(core.mjs, symlink 해석+저장소 밖 차단)로 열리며 어떤 등록된 kickoff의 pm/worker worktree 경로와도 겹치지 않고, `hash(fs.readFileSync(inside(ownerRoot, evidence.ownerPath)))`가 `evidence.sha256`과 일치하고, `outcome === "confirmed"`여야 한다.
2. **원문 대조 완전성**: 가장 최근 `fidelityChecks` 레코드가 `head`·`ledgerHash` 모두 현재 값과 같고 `directorConfirmedAt`이 있으며, `items`가 **현재 `statements`와 `criteria`의 모든 id를 scope 무관하게(equal 포함) 정확히 한 번씩** 담고 전부 `status === "met"`이어야 한다.
3. **예외**: `unmet`이 있으면, 그 id를 정확히 포함하는 exception이 있어야 한다. **예외는 항목별로만 존재한다** — `scope`는 `{type, id}` 객체의 배열이며 `"__legacy__"` 같은 포괄 값은 스키마에서 아예 허용하지 않는다(A.6). exception도 `ledgerHash`·`head`에 묶이고, `reason`·`userQuote`·`unmetFacts`가 비어 있지 않아야 한다.

**단순 `--force`로 통과 불가**: 이 함수는 `kickoff-check-close-ready`/`deliverKickoff`/`kickoff-release`의 `force` 매개변수를 받지 않는 별도 호출로 배선된다(A.5). 확인·제시·예외 기록을 만드는 것은 오직 다섯 개의 원장 명령(A.4)뿐이며 자동 실행되는 것은 없다.

### A.4 명령

`teams-org.mjs`의 기존 `switch (args.command)`에 새 `case`로 추가하고, 로직은 신규 모듈 `requirements.mjs`가 구현한다.

| 명령 | 실행 주체 | 인증 | 동작 |
| --- | --- | --- | --- |
| `requirements-draft` | 누구나(보통 director/PM) | 없음 | draft 파일 생성. 빈 statements/criteria 거부 |
| `requirements-confirm --draft` | 자기 위치 선언(A.2) | `process.cwd() === --checkout` | narrower criterion에 confirmation 기록 |
| `kickoff-claim`(기존 확장) | PM | 없음(기존과 동일) | `--from` JSON의 `requirements`를 `validateLedgerForClaim`으로 검증 후 확정 원장 생성, `entry.requirements.ledgerHash` 기록. 검증 실패 시 claim 자체를 거부 |
| `requirements-amend` | director | `assertDirectorAuthority(entry,...)` | statement/criterion 문구 변경. 연결된 confirmation은 자동 무효화(재확인 전까지 narrower 게이트가 다시 막는다) |
| `requirements-confirm`(claim 후, 재확인) | director | `assertDirectorAuthority(entry,...)` | `requirements-amend` 이후 narrower criterion 재확인 |
| `requirements-fidelity` | PM | (org.auditor 존재 시) 브리프 감사 수용 필요(B.5) | 현재 head·ledgerHash에 대한 met/unmet 목록 기록(director 미확인 상태) |
| `requirements-present` | director | `assertDirectorAuthority(entry,...)` | `--evidence <소스>`를 `.omt/requirements-evidence/`로 복사, `inside()`로 경로 검증, sha256 계산 후 presentation 기록 |
| `requirements-fidelity-confirm` | director | `assertDirectorAuthority(entry,...)` | 가장 최근 fidelity 레코드에 `directorConfirmedAt` 기록 |
| `requirements-exception` | director | `assertDirectorAuthority(entry,...)` | 항목별 예외 기록(scope는 `{type,id}` 배열, 포괄값 없음) |
| `requirements-retrofit` | director | `assertDirectorAuthority(entry,...)` | A.6 호환 경로 — 원장 없는 기존 kickoff에 실제 원장을 사후 구성(draft→confirm과 같은 검증을 거침, claim 후이므로 교착 없음) |
| `requirements-show` | 누구나 | 없음 | 조회 전용 |

### A.5 여섯 지점 전부에 하드코드(수용 기준 `compat-not-bypass`; 보충 계약 3 5·7항, 보충 계약 4 1·3·4항)

조사로 확인했듯 원래 다섯 지점(PM `accept`, close-ready 발신, `kickoff-check-close-ready`, `deliverKickoff`, `kickoff-release completed`) 중 검사가 이미 생략 불가능하게 박혀 있는 곳은 PM `accept`(`gates.mjs` `acceptOutcomeLocked`) 하나뿐이다. 이번 설계는 그 다섯 지점에 더해, **구현 착수 지점**(`startSupervisedWorker`, `teams-org.mjs:823`)에도 브리프 감사 강제를 건다 — 총 여섯 지점 모두에 `assertLedgerCompleteForKickoff`(또는 그 단계에 맞는 부분 검사)를 **함수 본문에 무조건 실행되는 호출**로 추가한다. 선택적 콜백이 아니다.

**보충 계약 4 3항의 지적을 반영해 브리프 감사 강제 위치를 옮겼다**: `requirements-fidelity`는 구현이 이미 끝난 뒤에 실행되는 명령이므로, 거기서 브리프 감사 수용을 검사해도 "기준 확정·구현 착수 전에 감사를 강제"하지 못한다(이미 끝난 구현을 되돌릴 수 없다). 실제로 구현 착수를 만드는 코드는 `teams-org.mjs`의 `startSupervisedWorker`(823-…줄, `worker-start` CLI가 호출)이며, `assertWorktreeUnshared` 직후(854-859줄 부근)에 검사를 추가한다: `org.auditor`가 있고 이 배정이 이 kickoff에 속한 구현 역할(director·auditor가 아닌 워커, `identity.workflowId`/`args.worktree`로 kickoff를 식별)이면, 브리프 감사 수용(`boundHash === hash({ledgerHash})`)이 없는 한 배정 자체를 거부한다. 이는 `requirements-retrofit`(A.6)으로 원장을 사후 구성하는 기존 kickoff 경로와는 다른 검사다 — retrofit 대상 kickoff는 이미 진행 중인 워커 배정을 재검증하지 않고, 이 검사는 **이 기능 배포 이후 새로 이뤄지는 배정**에만 적용된다.

원장·감사(있으면)가 요구하는 전체 순서는 다음과 같다(보충 계약 2 6항의 순서를 그대로 따르되, 제시 시점을 결과 감사 전후 두 경로로 명시한다 — 보충 계약 4 1항).

```
kickoff-claim(원장 확정, ledgerHash 고정)
  └─▶ 브리프 감사(있으면, ledgerHash에만 묶임 — B.7)  ← 기준 확정 단계에서 진행
        │
        ▼
  구현 착수: worker-start/role-terminal로 구현 역할(워커) 배정
     ※ 하드코드 위치: startSupervisedWorker 본문, assertWorktreeUnshared 직후.
       org.auditor가 있으면 브리프 감사 수용이 없는 배정을 거부한다(위 설명)
        │
        ▼
  구현 커밋들 (HEAD 전진)
        │
        ▼
  requirements-fidelity (PM 초안, {head, ledgerHash})
        │
        ├─▶ [경로 A] director: requirements-present + requirements-fidelity-confirm
        │     을 결과 감사보다 먼저 끝낸다. 이 경우 아래 evidenceFingerprint(B.3)가
        │     이미 그 제시를 포함한 값으로 고정된 채 결과 감사가 시작되므로,
        │     이후 재무효화가 없다.
        │
        ▼
  결과 감사(있으면, {ledgerHash, resultHead, evidenceFingerprint}에 묶임 — B.3/B.7)
        │
        ▼
  PM accept (gates.mjs acceptOutcomeLocked)
     ※ 하드코드 위치: gateCheck 호출 직후. **모든 task의 accept에 적용**: org.auditor가
       있으면 결과 감사에 미해결(ruling 없음 또는 not-persuaded) 이의가 있으면 거부
       (보충 계약 2 4항). 이 지점은 이의 유무만 보고 "결과 감사 acceptance 자체가
       존재하는가"는 요구하지 않는다 — kickoff에 아직 완료할 task가 남아 있으면
       결과 감사가 시작조차 안 됐을 수 있고, 여기서 acceptance 존재를 요구하면
       첫 task조차 넘어가지 못하는 교착이 생긴다(보충 계약 4 4항). acceptance
       존재 요구는 아래 close-ready 발신과 최종 세 게이트, 두 곳에만 건다.
        │
        ▼
  close-ready 신호 발신 (director.mjs sendSignal kind="close-ready")
     ※ 하드코드 위치: SIGNAL_KINDS/중복pending 검사 직후. org.auditor가 있으면
       **여기서 처음으로** 결과 감사 acceptance가 실제로 존재하고 유효한지
       (boundHash === hash(현재 {ledgerHash, resultHead, evidenceFingerprint}))
       확인한다. [경로 A]를 거쳤다면 이 값은 이미 제시를 포함해 안정적이다.
       [경로 A]를 거치지 않았다면(아직 제시가 없다면) 그 상태 그대로 발신은 허용한다
        │
        ▼
  [경로 B] (아직 제시가 없었다면) director: requirements-present(userVisible
  기준마다) + requirements-fidelity-confirm
     ※ 이 제시가 evidenceFingerprint를 바꾸면(B.3), 방금 위에서 유효했던 결과 감사
       acceptance가 즉시 무효가 된다(B.4 조건 5 — 생략하지 않는다). 이 경우
       결과 감사를 다시 받아 재수용하고 close-ready도 다시 보내야 다음 단계를
       통과한다. 재감사를 생략하는 지름길은 없다(보충 계약 4 1항)
        │
        ▼
  kickoff-check-close-ready / deliverKickoff / kickoff-release --reason completed
     ※ 세 곳 모두 하드코드 위치: 기존의 좁은 확인(head 비교, delivered 플래그 등)
       직후. assertLedgerCloseReady(A.3, 제시+원문대조+예외 전부)를 전부 확인하고,
       org.auditor가 있으면 브리프 감사 수용(boundHash={ledgerHash} 일치)과 결과
       감사 수용(boundHash={ledgerHash,resultHead,evidenceFingerprint} 일치 —
       [경로 B]로 무효화됐다면 재수용 필요)을 **여기서 다시** 확인한다.
       deliverKickoff는 247줄의 선택적 gate 콜백과 별개로, gate 호출 앞뒤 어디든
       함수 본문에 이 호출을 무조건 추가한다 — gate가 생략돼도 이 호출은 생략
       되지 않는다.
```

[경로 A]와 [경로 B] 어느 쪽을 택하든, 감사 acceptance의 binding 무효화 규칙(B.4 조건 5)을 생략하지 않는다는 점이 같다 — 다른 것은 오직 "제시가 언제 fingerprint에 반영되어 무효화를 촉발하는가"라는 시점뿐이다. 이 순서는 보충 계약 3 5항의 "결과 감사 전에 close-ready를 요구하지 않는다"도 그대로 지킨다.

### A.6 호환 정책(수용 기준 `compat-not-bypass`; 보충 계약 3 8항)

**실제 영향**(22:31판의 "영향 없음"이라는 설명은 부정확했다):

- **새 claim**: `requirements` 필드 검증 실패 또는 부재 시 `kickoff-claim` 자체가 거부된다. 이는 이 기능이 배포된 뒤 만들어지는 모든 새 kickoff에 적용되는, 의도된 필수화다.
- **이미 등록된(원장 없는) kickoff**: claim은 이미 끝났으므로 재검증되지 않는다. **영향은 종료 시점에 발생한다**: 이 기능이 배포된 뒤 `kickoff-check-close-ready`/`deliverKickoff`/`kickoff-release --reason completed`를 호출하면, `entry.requirements`가 없는 한 **셋 다 거부된다.** 배포 시점에 진행 중이던 kickoff는 이 세 명령이 갑자기 막히는 실제 동작 변화를 겪는다.
- **이전 절차**: 막힌 kickoff의 director는 두 가지 중 하나를 해야 완료할 수 있다.
  1. `requirements-retrofit`으로 실제 원장(statements/criteria/narrower confirmation 포함)을 사후 구성한다. claim 후이므로 `assertDirectorAuthority(entry,...)`로 인증되어 교착이 없다. 구성된 원장은 A.3의 검증(narrower 확인, 제시 증거, 원문 대조 완전성)을 새 kickoff와 동일하게 전부 통과해야 한다.
  2. 재구성이 불가능한 항목마다 `requirements-exception`으로 **항목별** 예외(정확한 `scope: [{type,id}]`, `reason`, `userQuote`, `unmetFacts`)를 남긴다. 포괄 면제는 없다 — 미충족 항목 수만큼 예외를 써야 한다.
- **보호 강화라는 이유**: 이 필수화가 없으면 #139가 보고한 결함(좁혀진 기준만 검사하고 원문과 대조하지 않는 종료)이 배포 이후에도 기존 kickoff 경로로 재발한다. 사유 없는 우회를 막는 것이 이번 작업의 핵심 목적이므로, 종료 시점 검사를 예외 없이 소급 적용하는 쪽을 선택했다.
- **auditor 없는 조직**: A.1~A.6은 `org.auditor`의 존재와 무관하게 항상 적용된다. `assertLedgerCompleteForKickoff`는 auditor 관련 검사(B.5)만 `org.auditor` 존재 조건으로 감싸고, 원장 자체의 검사는 절대 건너뛰지 않는다.
- **기존 공개 API·기록 형식을 추가로 깨는 변경은 없다.** `CLAIM_KEYS`/`validateEntry` 확장은 새 선택적 필드 추가이며 기존 claim 형식을 읽는 코드를 깨지 않는다. `validateReviewRequirements`에 `"auditor"`를 추가하는 것도 기존에 허용되던 `"senior"`를 그대로 허용하는 추가이지 파괴가 아니다. 구현 중 이 범위를 넘어서는 파괴적 변경이 필요하다고 판단되면 구현을 멈추고 `orchestration ask`로 PM에게 영향과 선택지를 보고하고, PM이 이사에게 decision으로 올린다(A.4/A.5는 이 판단이 필요 없다고 확인된 범위다).

## B. 감사 역할

### B.1 조직 스키마

`organization.schema.json`에 `roles`·`assistants`·`advisors`와 형제인 최상위 선택 필드를 추가한다.

```jsonc
"auditor": {
  "type": "object",
  "additionalProperties": false,
  "required": ["profile"],
  "properties": {
    "profile": { "type": "string", "minLength": 1 },
    "fallbacks": { "type": "array", "items": { "type": "string" }, "uniqueItems": true }
  }
}
```

`core.mjs`의 `validateOrg`는 `org.auditor`가 있으면 `org.auditor.profile`과 모든 `fallbacks`가 `org.profiles`에 실재하는지만 검사한다(advisors 검증과 같은 자리, 같은 형태). `ROLES`, `foldRole`, `resolveRole`는 건드리지 않는다 — `AUDITOR_ROLE = "auditor"` 상수만 `core.mjs`에 추가한다. 이는 기존 `DIRECTOR_ROLE`(서열 밖 특수 역할)과 같은 선례를 따른다.

### B.2 실행 경로 — role-launch.mjs / role-terminal.mjs / teams-org.mjs

`resolveRoleLaunch`와 `roleCommand`(role-launch.mjs)는 `requestedRole === AUDITOR_ROLE`을 맨 앞에서 분리해 `foldRole`/`activeRoles`/`assertHeldRole`을 거치지 않는 별도 분기로 처리하고, `org.auditor.profile`(또는 `handoffProfile`이 `org.auditor.fallbacks`에 있으면 그것)로 profile을 정한다. `readRoleCharter`는 `[...ROLES, AUDITOR_ROLE].includes(role)`로 넓혀 `skills/auditor/SKILL.md`를 읽는다. `DISPATCH_AUTHORITY`에는 auditor를 추가하지 않는다 — 감사는 Dispatch를 만들지 않는다.

`role-terminal.mjs`의 `ROLE_TITLE_TAGS`에 `auditor: "[Auditor]"`를 추가한다(없으면 `roleTitle`의 assert가 던진다는 것을 조사로 확인했다).

**`teams-org.mjs`의 `case "role-terminal"`(1612줄)에 auditor 전용 분기를 추가한다** — role-terminal.mjs 자신이 아니라 이 CLI 진입점에 추가하는 이유는, director 권한 검사와 worktree 분리 검사를 기존 어떤 역할도 거치지 않아 재사용할 기존 호출이 없기 때문이다.

**보충 계약 4 5항 반영**: `args.worktree`는 이 auditor 터미널이 **새로 열릴** 위치이지, 검토 대상 kickoff의 PM worktree가 아니다 — 그 값으로 kickoff registry를 조회할 수 없다. 그래서 감사 대상 kickoff는 `--state <kickoff의 entry.pm.stateDir>`(아래 문단에서 launch ledger 귀속에 이미 쓰던 바로 그 인자)로 **먼저** 결정하고, `args.worktree`는 오직 "감사 터미널을 열 위치"로만 쓰며 분리 검사의 비교 대상이 된다. 두 개념(감사 대상 kickoff / 감사가 실행되는 워크트리)을 하나의 인자로 섞지 않는다.

```js
if (command.role === AUDITOR_ROLE) {
  assert(
    command.state,
    "role-terminal --role auditor requires --state <kickoff stateDir> to identify the kickoff under review",
  );
  const kickoff = findKickoffByStateDir(args.org, command.state); // entry.pm.stateDir 대조, args.worktree와 무관
  assertDirectorAuthority(kickoff, process.cwd(), "role-terminal --role auditor", false); // force 인자 없음, 우회 불가
  assert(
    !pathWithin(args.worktree, kickoff.pm.path) &&
      !kickoff.workers?.some((w) => pathWithin(args.worktree, w.path)),
    "auditor terminal (--worktree) must not share a worktree with the kickoff under review (--state)",
  );
}
// 이하 roleCommand→assertWorktreeUnshared→openRoleTerminal→recordLaunchSafely는
// 기존 코드 그대로, 역할별 분기 없이 공유한다.
```

호출 시 `--state <kickoff의 entry.pm.stateDir>`을 넘기게 해서 `recordLaunch`의 `resolveLaunchKickoff`가 `kickoffPmWorktreeId`를 정확히 그 kickoff로 귀속시키도록 한다(usage-ledger.mjs:130-147, `stateDir` 일치 경로). 터미널이 열리면 `entry.auditor = { terminalHandle: opened.terminal, openedAt }`도 함께 kickoff-registry에 기록해 B.5/B.6이 참조한다.

### B.3 감사 기록 스키마

```
<organization.json이 있는 디렉터리>/audits/<sha256(worktreeId)>.json
```

```jsonc
{
  "schemaVersion": 1,
  "worktreeId": "...",
  "checkpoints": {
    "brief": {
      "binding": { "ledgerHash": "..." },
      "checked": [{ "type": "statement", "id": "s1" }, { "type": "criterion", "id": "c1" }],
      "objections": [
        {
          "id": "o1", "target": { "type": "criterion", "id": "c1" },
          "kind": "mismatch",
          "description": "...", "rebuttalRequested": "...",
          "raisedAt": "..."
        }
      ],
      "responses": [
        { "id": "r1", "objectionId": "o1", "argument": "...", "evidenceRefs": [{ "path": "...", "sha256": "..." }], "respondedAt": "..." }
      ],
      "rulings": [
        { "objectionId": "o1", "respondedAgainst": "r1", "verdict": "persuaded", "reason": "...", "ruledAt": "..." }
      ],
      "acceptance": null
    },
    "outcome": {
      "binding": { "ledgerHash": "...", "resultHead": "...", "evidenceFingerprint": "..." },
      "checked": [], "objections": [], "responses": [], "rulings": [], "acceptance": null
    }
  }
}
```

`checkpoints.brief.binding`은 원장 hash만 담는다(보충 계약 1: "브리프 감사는 계약(원장 hash)에만"). `checkpoints.outcome.binding`은 원장 hash·결과 HEAD·**항상 계산되는** `evidenceFingerprint`를 담는다 — 보충 계약 3 4항이 지적한 "`evidenceKey`를 null로 생략"하는 문제를 없애기 위해, `evidenceFingerprint`는 그 시점에 실제로 감사 대상인 증거 전체를 `hash()`(core.mjs, taskHash와 같은 함수)로 묶은 값이며 항상 계산된다. 묶는 대상은 세 가지다: fidelity 초안의 `items`, 그때까지의 `presentations`의 `evidence.sha256` 목록, 그리고 **`checkpoints.outcome`의 각 objection에 대한 가장 최근 response의 `evidenceRefs.sha256` 목록**(objectionId로 정렬) — 이 세 번째 항목이 보충 계약 4 2항이 지적한 결함(fingerprint가 응답 증거를 포함하지 않으면 `response.evidenceRefs`가 가리키는 실제 파일이 나중에 바뀌어도 감지되지 않는다)을 없앤다. 증거가 하나도 없는 상태에서는 빈 배열의 hash가 되므로, 이후 증거가 추가되거나 바뀌면 이 값이 반드시 바뀌어 재감사를 강제한다. `auditAccepted`(B.4)는 이 fingerprint를 **저장된 값과의 단순 비교로 신뢰하지 않고**, 저장된 각 `evidenceRefs.{path, sha256}`을 `inside()`로 다시 열어 파일의 현재 sha256을 재계산해 대조한 뒤에만 `evidenceFingerprint`를 유효한 것으로 취급한다(B.4 조건 6).

**resultHead의 그라운딩**(이전 조사가 "checkpoint·workflow·gates·evidence에 git HEAD 개념이 없다"고 잘못 결론지었던 부분의 정정): `evidence.mjs`는 이미 실제 저장소 HEAD를 확인하는 어댑터를 갖고 있다 — `fingerprint()`(142행)가 증거 검증에 쓰는 `git(repo, ["rev-parse", "HEAD"])`(23·156행)와, 이를 감싼 공개 함수 `workspaceBinding(repo)`(608행, `{repo, head}`를 반환하고 Git 워크스페이스가 아니면 `head: null`)다. `computeBinding(checkpoint, ledger, audit, resultHead, repo)`는 `checkpoint`가 `outcome`이면 이 `workspaceBinding(repo)`를 호출해 얻은 실제 HEAD와 호출자가 선언한 `resultHead`를 대조하고, 다르면(위조되었거나 오래된 값이면) binding 계산 자체를 거부한다 — 임의의 `resultHead` 문자열만으로 검증 대상 HEAD를 맞추는 경로는 없다. `auditObjection`·`auditAccepted`·`auditAccept`가 이 검증을 거치는 `computeBinding`을 그대로 쓰고, `hasValidAcceptance`는 같은 검증이 실패하면(선언된 HEAD가 실제 HEAD와 다르면) 예외를 던지지 않고 조용히 `false`를 반환한다(A.5 게이트가 요구하는 plain boolean 계약). `requirements.mjs`의 `requirementsPresent`·`requirementsFidelity`도 각각 선언된 `head`를 같은 방식으로 검증한다.

이 검증에는 **어느 저장소의 HEAD와 대조할지**가 필요하므로, 위 함수들은 모두 호출자가 명시하는 `repo` 인자(또는 request 필드)를 받는다 — `kickoff-registry.mjs`의 `entry.pm.path`(PM 워크트리)에서 자동으로 유도하지 않는다. PM이 브리프를 작성·조율하는 워크트리와 실제 구현이 이루어지는 워크트리(예: 이 문서를 담고 있는 `139-auditor-impl` 같은 작업 워크트리)가 서로 다를 수 있기 때문에, 자동 유도는 엉뚱한 저장소의 HEAD와 대조하는 결함으로 이어진다. `repo`를 채우는 방식(CLI의 `process.cwd()` 기본값 vs `--repo` 신규 인자)은 아직 CLI 배선 시점의 결정 사항으로 남아 있다.

`objections`·`responses`·`rulings`는 각각 `id`/`objectionId`/`respondedAgainst`로 연결된다. `raisedBy`/`respondedBy` 같은 자기선언 필드는 두지 않는다 — 신원은 **호출자의 `process.env.ORCA_TERMINAL_HANDLE`을 런타임이 매 호출마다 확인해서** 별도로 부여한다(B.6). 기록에는 신원 확인 결과만 요약해 남긴다(예: `verifiedCaller: "auditor"|"pm"|"director"`).

### B.4 이의·응답·판정 수용 규칙(수용 기준 `audit-persuasion`; 보충 계약 3 4항)

`auditAccepted(checkpoint, currentBinding, workflowContext)`가 아래를 전부 만족해야 `true`를 반환한다.

1. **checked 완전성**: `checkpoint.checked`가 **현재 `ledger.statements`의 모든 id와 `ledger.criteria`의 모든 id를 scope 무관하게 정확히 한 번씩** 포함해야 한다(임의 항목 1개만 있어도 통과하던 22:31판의 결함을 없앤다). 하나라도 빠지면 거부.
2. **미해결 이의 없음**: 모든 `objections`에 대해, `rulings`에서 그 `objectionId`를 가진 **가장 최근** ruling이 존재하고 `verdict !== "not-persuaded"`. 없거나 `not-persuaded`가 최신이면 거부.
3. **ruling이 최신 응답에 연결**: 각 ruling의 `respondedAgainst`가 그 `objectionId`에 대한 **가장 최근** response의 `id`와 같아야 한다(오래된 response를 근거로 한 판정을 새 response 이후에도 유효한 것으로 재사용하지 못하게 한다).
4. **역할 독립성, 두 가지 서로 다른 사실로 증명**(보충 계약 3 1항 — 22:31판은 response와 implementation만 비교하는 오류가 있었다):
   - **호출자 신원**: 이 checkpoint의 모든 objection은 B.6이 확인한 "실제 auditor 터미널"에서 왔어야 하고, response는 checkpoint가 `brief`면 "실제 director"(assertDirectorAuthority 방식), `outcome`이면 "실제 PM"(verifySupervisor 방식)에서 왔어야 한다. ruling은 감사 신원에서만 와야 한다. 넷 중 하나라도 신원 확인에 실패하면 그 기록 자체가 append되지 못한다(사후에 auditAccepted가 거부하는 것이 아니라, B.6의 명령 자체가 그 시점에 거부한다).
   - **구현 실행과의 독립성**: `workflowContext.implementationExecutionId`(호출자가 제출하는 문자열이 아니라 `readWorkflow(stateDir, workflowId).state.tasks[taskId]`에서 `item.workerRunId ?? item.execution?.executionId`로 직접 읽은 값, `workflow.mjs:1559`와 같은 방식)와 감사 실행(B.6이 확인한 auditor terminalHandle)이 **애초에 서로 다른 차원의 식별자**이므로 값이 같을 수 없다는 점을 이용해 형식적으로 비교하지 않는다. 대신, response가 인용하는 커밋/증거가 실제로 `implementationExecutionId`가 만든 HEAD·산출물과 일치하는지를 `evidenceRefs`의 `{path, sha256}`를 `readReference`(contracts.mjs, `inside()` 기반 안전한 열기)로 열어 대조한다 — "구현자가 자기 자신을 감사·응답하지 못한다"는 요구는 신원 검증(위 항목)이 이미 감사=auditor, 응답=PM/director로 못박으므로 자동으로 만족되고, 이 항목은 "인용된 증거가 실제로 그 구현에서 나온 것인가"만 추가로 확인한다.
5. **binding 무효화**: `checkpoint.acceptance`가 있으면 `acceptance.boundHash === hash(currentBinding)`이어야 유효하다. 원장(ledgerHash)·결과 HEAD·증거(evidenceFingerprint) 중 하나라도 바뀌면 `hash(currentBinding)`이 달라져 이전 수용이 즉시 무효가 된다.
6. **응답 증거 재검증**(보충 계약 4 2항): `checkpoint`가 `outcome`이면, 판정에 쓰인 각 objection의 **가장 최근** response가 인용하는 `evidenceRefs`(B.3의 `{path, sha256}`)를 `inside(ownerRoot, path)`로 다시 열어 실제 파일의 sha256을 재계산하고, 저장된 `sha256`과 일치해야 한다. 하나라도 불일치하면(같은 HEAD·같은 저장된 fingerprint라도 응답 증거 파일 내용만 사후에 바뀐 경우) 거부한다 — `evidenceFingerprint`가 이미 그 sha256 목록을 포함하므로(B.3) 파일이 바뀌면 이 재검증과 5번의 binding 무효화가 함께 걸린다.

`audit-accept`(감사 전용, B.6 인증)가 1~6을 확인한 뒤 `acceptance = { acceptedAt, boundHash: hash(currentBinding) }`을 기록한다.

### B.5 A의 여섯 지점에 추가(보충 계약 2, A.5의 순서 참조; 보충 계약 4 3·4항)

`org.auditor`가 선언된 조직에서만, A.5에 그린 순서의 해당 지점마다 다음을 추가로 확인한다. **`requirements-fidelity`는 이 목록에서 뺐다** — 구현이 끝난 뒤에 실행되는 명령이라 여기서 검사해도 착수 자체를 막지 못한다는 것이 보충 계약 4 3항의 지적이었다. 대신 구현 착수 지점(`startSupervisedWorker`)이 이 강제를 맡는다.

- **구현 착수(`startSupervisedWorker`, `worker-start`)**: 이 kickoff에 속한 구현 역할(워커) 배정이면 `checkpoints.brief.acceptance`가 존재하고 `boundHash === hash({ledgerHash})`여야 한다. 없으면 배정 자체가 거부된다 — 브리프 감사를 기준 확정·구현 착수 전에 강제하는 실질적 경계(보충 계약 3 5항, 보충 계약 4 3항).
- **PM `accept`(`gates.mjs acceptOutcomeLocked`)**: **모든 task의 accept에 적용.** `checkpoints.outcome`에 미해결 이의(ruling 없음 또는 최신 ruling이 not-persuaded)가 있으면 거부(보충 계약 2 4항). `gateCheck` 호출 직후 하드코드. **이 지점은 `checkpoints.outcome.acceptance`(감사 수용 자체)의 존재를 요구하지 않는다** — kickoff에 남은 task가 있는 동안에는 결과 감사가 아직 시작되지 않았을 수 있고, 여기서 수용 존재를 요구하면 첫 task조차 통과하지 못하는 교착이 생기기 때문이다(보충 계약 4 4항). 감사 수용 자체의 존재 요구는 아래 두 지점에만 건다.
- **close-ready 발신(`director.mjs sendSignal`)**: **여기서 처음으로** `checkpoints.outcome.acceptance`가 존재하고 `boundHash === hash({ledgerHash, resultHead: 현재 head, evidenceFingerprint: 현재 값})`이어야 한다. 없거나 무효면 close-ready 신호 자체를 보낼 수 없다.
- **`kickoff-check-close-ready`/`deliverKickoff`/`kickoff-release --reason completed`(최종 셋)**: `checkpoints.brief.acceptance`(`boundHash === hash({ledgerHash})`)와 `checkpoints.outcome.acceptance`(위와 동일 조건)를 **다시** 확인한다. close-ready 발신 이후 원장·결과·제시가 바뀌면(A.5의 [경로 B]처럼 제시로 evidenceFingerprint가 바뀐 경우 포함) 여기서 다시 막힌다.

이 네 지점(구현 착수·PM accept·close-ready 발신·최종 셋) 중 "감사 수용 자체의 존재"를 요구하는 것은 close-ready 발신과 최종 셋뿐이다 — PM accept는 진행 중인 이의만 막고, 구현 착수는 결과 감사가 아닌 브리프 감사만 요구한다. 이 구분이 보충 계약 4 4항이 요구한 "검토 대상을 분명히 하라"는 지적에 대한 답이다.

`org.auditor`가 없으면 이 절의 검사는 전부 건너뛰고 A의 검사만 적용된다.

### B.6 실행 신원 검증(보충 계약 3 1항 — 22:31판의 핵심 결함 수정)

**22:31판의 결함**: `audit-objection`/`audit-ruling`/`audit-accept`가 `--terminal <handle>` **인자**를 받아 `entry.auditor.terminalHandle`과 비교했다. 이 방식은 PM이나 이사가 감사의 handle 문자열을 그대로 복사해 `--terminal` 인자에 넣으면 통과한다 — 인자는 호출자가 마음대로 채우는 값이기 때문이다.

**수정**: 인자를 받지 않는다. 대신 `prompt-supervision.mjs:1024/1106`과 정확히 같은 방식으로 **호출 프로세스 자신의 환경변수** `process.env.ORCA_TERMINAL_HANDLE`을 읽는다. 이 값은 Orca가 그 터미널을 열 때 그 터미널 프로세스에만 주입하므로, PM·이사의 프로세스에는 애초에 감사의 handle이 들어 있지 않다 — 복사해서 넘길 CLI 인자 자체가 없다.

```js
function verifiedAuditor(orgFile, targetKickoffWorktreeId, env = process.env) {
  const callerHandle = env.ORCA_TERMINAL_HANDLE;
  assert(callerHandle, "ORCA_TERMINAL_HANDLE is not set, so the caller cannot be identified");
  const launch = readLaunches(orgFile).findLast(
    (l) => l.via === "role-terminal" && l.role === "auditor" &&
      l.terminal === callerHandle && l.kickoffPmWorktreeId === targetKickoffWorktreeId,
  );
  assert(launch, `Caller ${callerHandle} is not the auditor terminal launched for this kickoff`);
  return callerHandle;
}
```

`readLaunches`/`findLast`는 `usage-ledger.mjs`에 이미 있는 함수를 그대로 쓴다(새 함수를 만들지 않는다). `launch.terminal`은 `openRoleTerminal`이 auditor 역할로 새로 연 터미널에 Orca가 직접 부여한 handle이므로(B.2), PM이나 이사가 자신의 `ORCA_TERMINAL_HANDLE`을 그대로 두고 호출하면 `l.terminal === callerHandle`이 성립하지 않아 거부된다.

`audit-response`는 checkpoint가 `outcome`이면 PM 신원을, `brief`면 director 신원을 같은 원칙으로 확인한다.

- **PM 확인** (`verifiedPm`): `prompt-supervision.mjs:336-389`의 `verifySupervisor`가 이미 구현한 `kickoff.runId && bound.id === kickoff.runId`(호출자가 이 kickoff의 Run에 coordinator로 바인딩됨) 분기를 그대로 재사용한다. `bound`는 `runOrcaJson(orca, ["orchestration", "run-current", "--from", callerHandle])`로 얻는다.
- **director 확인** (`verifiedDirector`): `assertDirectorAuthority(entry, process.cwd(), "audit-response", false)`를 그대로 재사용한다(force 없음).

**한계**: 이 검증이 증명하는 것은 "호출 프로세스가 실제로 director 권한 아래 열린 auditor 터미널의 환경, 또는 이 kickoff의 Run에 coordinator로 바인딩된 PM의 환경, 또는 director의 등록된 체크아웃 경로에서 실행 중"이라는 사실이다. `ORCA_TERMINAL_HANDLE` 값 자체를 로컬 프로세스가 임의로 설정해 위조하는 공격(로컬 환경을 완전히 장악한 공격자)은 막지 못한다 — 이는 `prompt-supervision.mjs`가 이미 25-31줄에서 선언한 것과 정확히 같은 한계이며, 이 코드베이스가 이미 받아들인 신뢰 경계다. 이번 수정이 막는 것은 "정상 경로로 실행되는 PM·이사 세션이 감사 handle을 CLI 인자로 복사해 대리 판정하는 것"이며, 이것이 보충 계약 3 1항이 요구한 개선이다.

### B.7 순환 의존 부재(보충 계약 1·2)

A.5의 순서 그림이 곧 의존 그래프다. 브리프 감사는 `{ledgerHash}`에만 묶이고, `ledgerHash`는 `requirements-amend`(director 전용, 드묾)를 쓰지 않는 한 claim 이후 변하지 않으므로 구현이 진행되는 동안 유효하게 남는다. 결과 감사는 `{ledgerHash, resultHead, evidenceFingerprint}`에 묶이고 결과 HEAD가 있어야 시작하지만, **close-ready·PM acceptance·사용자 제시 기록을 전제로 요구하지 않는다** — 순서상 결과 감사가 그것들보다 먼저 온다(보충 계약 2 6항). close-ready는 결과 감사 수용을 요구하지만, 결과 감사는 close-ready를 요구하지 않는다. 따라서 "감사가 결과를 기다리고 결과가 감사를 기다리는" 순환은 없다.

`tests/auditor.test.mjs`의 끝에서 끝까지 흐름 테스트(F절)가 정확히 이 순서로 실행하고, 중간에 브리프 감사 수용이 구현 커밋만으로 깨지지 않음을 확인한다.

### B.8 스키마·form/adjust·role-terminal fallback·이사 보고 연결

- **조직 스키마 검증**: `core.mjs`의 `validateOrg`에 `org.auditor` 분기(B.1) — `tests/auditor.test.mjs`의 "auditor 프로필이 존재하지 않으면 조직 검증이 거부한다" 테스트.
- **form/adjust 저장 경로**: `org-draft.mjs`의 `draftOrganization`(직접 읽어 확인함, 132줄 전체)은 auditor를 만들지 않는다 — 이 범위는 신규 조직의 기본값 변경이 아니라 기존 `edit`/`preset`(`teams-org.mjs:1356,1361`) 경로로 `org.auditor`를 추가·제거하는 것이다. `adjust/SKILL.md`에 `edit` patch 예시를 문서화하고, `validateOrg`가 결과를 검증한다. `tests/auditor.test.mjs`의 "edit로 auditor를 추가·제거할 수 있다" 테스트.
- **role-terminal의 auditor 실행과 fallback**: B.2 — `tests/role-terminal.test.mjs`의 `fakeOrca` 패턴을 재사용해 "director가 auditor role-terminal을 열면 launch ledger와 entry.auditor가 함께 기록된다", "director가 아니면 거부된다", "검토 대상과 같은 worktree면 거부된다", "fallback 프로필로 열 수 있다" 테스트.
- **이사 보고**: `director.mjs`의 기존 `sendSignal(orgFile, {worktreeId, kind:"progress", text})`(변경 없음)를 `audit-accept` 성공 시 호출해 "감사 체크포인트 &lt;brief|outcome&gt; 수용: 이의 N건, 판정 완료"를 이사 받은함에 남긴다. `tests/auditor.test.mjs`의 "감사 수용이 director-signal progress로 이사 받은함에 남는다" 테스트.

### B.9 실제 실행 검증 절차(보충 계약 1·3 6항 — "이번 작업물에 포함되지 않는다"는 문구 삭제)

보충 계약 1이 "끝에서 끝까지 CLI 흐름이 실제로 동작"함을 요구하고 보충 계약 3 6항이 "실제 실행은 이번 kickoff 완료 전에 검증한다"고 명시했으므로, 이 kickoff는 실제 claude-opus auditor 터미널로 이번 원장을 감사하는 절차를 **문서만 남기고 끝내지 않는다.** 실행 순서는 다음과 같다.

1. (Senior, 구현 완료 후) PM에게 정확한 명령 목록을 준비해 전달한다 — 조직 파일 경로, 이 kickoff의 `worktreeId`, 실제 statement/criterion id를 전부 채운 형태로.
2. (PM) 이 명령들을 director에게 `orchestration ask`로 요청한다: "아래 명령을 이사 체크아웃에서 실행해 실제 auditor 터미널로 이번 kickoff을 감사해 주십시오."
3. (director, 이사 체크아웃) `role-terminal --role auditor --org <org> --worktree <감사 전용 worktree selector> --state <kickoff stateDir>`로 실제 claude-opus 터미널을 연다.
4. (그 터미널, auditor 프로필) `audit-objection --org <org> --worktree <kickoff worktreeId> --checkpoint brief --target criterion:c1 --kind mismatch --description "..." --rebuttal "..."`(터미널 인자 없음 — 환경변수로 신원 확인).
5. (director) `audit-response --org <org> --worktree <kickoff worktreeId> --checkpoint brief --objection o1 --argument "..." --evidence-ref <path>:<sha256>`.
6. (auditor 터미널) `audit-ruling ... --verdict persuaded --reason "..."`, 이어서 `audit-accept --checkpoint brief`.
7. 결과가 이 kickoff의 `audits/<...>.json`에 실제로 기록됐는지 PM이 `requirements-show`/`audit-show`로 확인하고, 그 결과를 close-ready 신호 본문에 포함한다.

문서만으로는 완료로 인정하지 않는다 — 7단계의 실제 기록 확인이 close-ready 신호의 필수 첨부다.

## C. 호환을 깨는 변경 여부(보충 계약 3 8항)

**실제 영향**은 A.6에 정확히 기술했다: 배포 이후 새 claim은 원장 없이 등록되지 않고, 배포 시점에 이미 등록된 kickoff는 세 종료 명령이 `requirements-retrofit` 또는 항목별 예외 없이는 더 이상 통과하지 못한다. 이것은 "영향 없음"이 아니라 **의도된, 소급 적용되는 보호 강화**다 — #139가 보고한 결함이 배포 이후에도 기존 kickoff 경로로 재발하는 것을 막기 위한 선택이며, 이 kickoff의 브리프와 이슈 #139 원문이 요구하는 "우회 불가능한 종료 게이트"의 직접적인 귀결이다.

files 목록 밖에서 실제로 필요한 수정은 다음과 같다 — 전부 **입력 픽스처를 새 필수 필드에 맞춰 갱신**하는 것이며, 함수의 공개 시그니처나 기존 기록의 필드를 바꾸거나 제거하지 않는다.

- `tests/kickoff-registry.test.mjs`, `tests/delivery.test.mjs`, `tests/director-role.test.mjs`: `registerKickoff` 호출에 `requirements` 필드가 없으면 거부되므로, 이 파일들의 claim 생성 헬퍼에 최소 원장(narrower 없이 `scope:"equal"`만 쓰는 draft, 또는 A.6의 호환 경로를 명시적으로 검증하는 새 테스트)을 추가한다. **우회 헬퍼(원장 검사를 끄는 특수 인자 등)는 만들지 않는다** — PM의 지시(msg_e6ec67959835)를 그대로 따른다.
- `kickoff-registry.mjs`의 `CLAIM_KEYS`/`validateEntry`: `requirements` 필드를 받도록 확장(A.1). 기존 키는 그대로 유지되므로 기존 claim을 읽는 코드는 깨지지 않는다.
- `contracts.mjs`의 `validateReviewRequirements`(170-203줄)에 `"auditor"`를 허용 목록에 추가하는 것이 실제로 필요해지면(현재 설계는 감사 검토를 review.json 경로가 아니라 별도의 audits 파일로 처리하므로 필요하지 않을 가능성이 높다) **추가**이지 파괴가 아니다.

이 범위를 넘어서는 호환 파괴가 구현 중 추가로 필요하다고 판단되면 구현을 멈추고 `orchestration ask`로 PM에게 영향과 선택지를 보고한다(PM이 이사에게 decision으로 올린다). 이 설계 문서 작성 시점까지는 그런 변경이 필요하다고 판단되지 않았다.

## D. 스킬·참조 문서 갱신

- `skills/auditor/SKILL.md`(신설): "## 권한·책임·한계" 절, B.6의 실행 신원 절차와 B.9의 실행 절차를 명령 단위로 담는다. 감사는 사용자에게 직접 묻지 않고 이사를 통해서만 소통한다는 한계를 명시한다.
- `skills/director/SKILL.md`: role-terminal로 auditor를 여는 절차(director만), `requirements-amend`/`requirements-confirm`/`requirements-present`/`requirements-fidelity-confirm`/`requirements-exception`/`requirements-retrofit`이 director 전용임을 추가.
- `skills/kickoff/SKILL.md`: 수용 기준 확정 절차에 A.2의 draft→확인→claim 흐름을 반영하고, narrower criterion은 confirm 없이 claim되지 않음을 명시.
- `skills/close/SKILL.md`: 확인 대상에 원장 완결성(A.3)과 (auditor가 있으면) 두 감사 수용(B.5)을 추가.
- `skills/pm/SKILL.md`: `requirements-fidelity` 작성 절차(브리프 감사 수용이 먼저 필요함을 명시), `audit-response`(결과 감사, PM 신원 검증) 절차, close-ready 발신 전 확인 사항 추가.
- `skills/help/SKILL.md`, `skills/form/SKILL.md`, `skills/adjust/SKILL.md`: 역할 목록에 auditor(서열 밖, 선택) 추가, `adjust`의 `org.auditor` 추가·제거 절차(B.8).
- `references/kickoff-registry.md`(신설 또는 갱신): `entry.requirements`, `entry.auditor` 필드 문서화.
- `references/user-choice.md`: 변경 없음 — narrower 기준의 사용자 확인은 이 문서의 "묻기 전에 확인한다"·"한 번에 묻는다" 원칙을 따라 director가 사용자에게 구조화된 선택 도구(AskUserQuestion 등)로 물은 뒤 `requirements-confirm --draft`로 기록하는 것이지, 새 질문 방식을 만드는 것이 아니다.

## E. 공통 규칙

인접 JSDoc, 실행문 180자 제한은 `npm run lint`(check-code-quality.mjs)가 강제한다. orca 실행은 전부 `orca-adapter.mjs`가 이미 노출하는 실행기(`runOrcaJson` 등)를 재사용하거나 같은 주입 패턴(`fakeOrca`로 테스트 가능한 형태)을 따른다. 사용자 설정 파일에는 쓰지 않는다. 버전은 `package.json`을 `2.8.12`로 올리고 `npm install`, `npm run sync`를 실행한다.

## F. 테스트 계획

`tests/requirements-ledger.test.mjs`:
- 빈 statements/criteria로는 `requirements-draft`도 `kickoff-claim`도 통과하지 못한다.
- narrower 기준은 confirmation 없이 draft가 claim되지 않는다.
- draft-confirm의 `--checkout`이 claim의 `director.checkoutPath`와 다르면 claim이 거부된다(A.2 교착 해소 검증).
- criterion 문구를 `requirements-amend`로 바꾸면 이전 confirmation·presentation·fidelityCheck·exception이 전부(ledgerHash 불일치로) 무효가 된다.
- equal 기준도 fidelity 완결성 검사에서 빠지지 않는다.
- userVisible 기준의 제시 기록이 없거나, 워크트리 경로를 가리키거나(부정 픽스처), symlink로 ownerRoot 밖을 가리키거나(`inside()` 거부), sha256/head/ledgerHash가 다르거나, `outcome:"rejected"`면 A.5의 원장 검사 지점(구현 착수 제외, 나머지 전부)이 거부한다.
- 단순 `--force`로는 통과하지 못하고, 범위가 정확히 맞는 항목별 director 예외만 통과한다. 포괄 `scope` 값은 스키마에서 거부된다.
- 원장 없는 새 claim은 거부된다.
- 원장 없는 기존 항목은 `requirements-retrofit`이나 항목별 예외 없이 completed로 닫히지 않는다(호환 영향 테스트).
- auditor 없는 조직에서도 위 모든 게이트가 그대로 동작한다.

`tests/auditor.test.mjs`:
- checked에 현재 statement/criterion 전체가 없으면 `audit-accept`가 거부된다(1개만 있어도 통과하던 결함의 회귀 방지).
- 미해결/`not-persuaded` 이의가 있으면 거부된다.
- ruling의 `respondedAgainst`가 최신 response가 아니면 거부된다.
- 원장·결과 HEAD·evidenceFingerprint 중 하나라도 바뀌면 이전 수용이 무효가 된다.
- **결과 감사 응답자 신원**: 하위 역할이나 이사가 `audit-response`(outcome)를 쓰면 거부된다. PM이 새 증거·논거로 다시 응답해 감사가 수용하면 통과한다. 약한 PM 응답(일반 완료 선언만)은 감사가 `not-persuaded`로 판정할 수 있고, 그 상태에서 accept·close-ready 발신·completed가 모두 차단된다.
- **브리프 감사 응답자 신원**: PM이나 하위 역할이 `audit-response`(brief)를 쓰면 거부된다. director만 응답할 수 있다.
- **ruling 위조 거부**: PM·director가 `audit-ruling`을 쓰면 거부된다.
- **신원 위조 거부(핵심 회귀)**: PM·director 세션이 `--terminal` 류의 인자로 감사 handle을 넘기려는 시도는 애초에 그런 인자가 없어 불가능함을 확인하고, PM·director의 실제 launch ledger 기록(role≠"auditor")으로는 `verifiedAuditor`가 통과하지 않음을 확인한다. 기록된 적 없는 임의 handle도 거부된다. (`ORCA_TERMINAL_HANDLE` 환경변수 자체를 조작하는 시나리오는 B.6의 한계로 문서화하고 테스트 대상에서 제외한다.)
- director가 아니면 `role-terminal --role auditor`가 거부되고, `--state`로 결정된 검토 대상 kickoff와 같은 worktree(`--worktree`)로는 열리지 않는다. auditor fallback 프로필로 열 수 있다.
- `org.auditor`가 없는 조직은 브리프/결과 감사 게이트가 적용되지 않는다.
- `audit-accept`가 director 받은함에 progress 신호를 남긴다.
- **`--state`(감사 대상 kickoff)와 `--worktree`(감사 터미널 위치)가 같은 값이면 `role-terminal --role auditor`가 거부된다**(보충 계약 4 5항 — 대상 식별과 실행 위치를 혼동하지 않는지 확인).
- **구현 착수(`worker-start`)는 브리프 감사 수용 없이 이 kickoff의 워커를 배정할 수 없다**(A.5/B.5의 강제 검증이 `requirements-fidelity`가 아니라 여기서 걸림을 확인 — 보충 계약 4 3항). `requirements-fidelity` 자체는 브리프 감사 상태와 무관하게 실행된다는 것도 함께 확인한다(더 이상 거기서 검사하지 않으므로).
- **PM accept는 결과 감사 미해결 이의로 차단된다**(보충 계약 2 4·7항)**, 그러나 감사 acceptance 자체가 아직 없다는 이유만으로는 차단되지 않는다**(여러 task가 있는 workflow에서 첫 task의 accept가 아직 시작되지 않은 결과 감사 때문에 교착되지 않음을 확인 — 보충 계약 4 4항).
- **close-ready 발신은 결과 감사 수용 없이 차단된다**(감사 acceptance 존재를 처음으로 요구하는 지점이 여기임을 확인).
- **응답 증거 재검증(회귀)**: 같은 HEAD·같은 저장된 `evidenceFingerprint` 상태에서 이전 response가 인용한 `evidenceRefs` 파일의 내용만 사후에 바꾸면, `audit-accept`(또는 이미 있던 `acceptance`를 소비하는 최종 게이트)가 거부한다(보충 계약 4 2항).
- **끝에서 끝까지 흐름, 경로 A(제시 먼저)**: `kickoff-claim` → 브리프 감사(objection→response(director)→ruling→accept) → `worker-start`(브리프 감사 수용 확인) → 구현 커밋 → `requirements-fidelity` → `requirements-present`/`requirements-fidelity-confirm`(director) → 결과 감사(objection→response(PM)→ruling→accept, evidenceFingerprint가 이미 제시를 포함) → PM `accept` → close-ready 발신 → `kickoff-check-close-ready`/`deliverKickoff`/`kickoff-release --reason completed` 성공.
- **끝에서 끝까지 흐름, 경로 B(제시 나중)**: 위와 같되 결과 감사·PM accept·close-ready 발신까지 제시 없이 마친 뒤, `requirements-present`로 제시를 추가하면 `evidenceFingerprint`가 바뀌어 기존 결과 감사 acceptance가 무효화되고(최종 셋이 거부), 결과 감사를 다시 받아 재수용한 뒤에야 최종 셋이 통과한다(보충 계약 4 1항).
- `deliverKickoff`에 빈 `gate`(또는 `gate` 생략)를 넘겨도 원장·감사 검사는 여전히 실행되어 거부됨을 확인한다(보충 계약 3 7항의 회귀 방지 — 이것이 22:31판에서 빠졌던 핵심 테스트다).

## G. 남은 사항

- `requirements-amend`가 이미 참조된 statement를 삭제하는 것은 다루지 않는다(criteria가 참조를 잃는 문제는 이번 범위 밖).
- `implementationExecutionId`를 터미널 handle과 직접 통합하는 것은 `workflow.mjs`에 그런 역산 경로가 없다는 것을 확인했으므로 이번 범위에서 하지 않는다 — B.4가 채택한 "두 가지 서로 다른 사실"(호출자 신원 + 인용 증거의 실제 출처)로 같은 목적을 달성한다.
- B.9의 실제 실행은 이 kickoff 완료 전에 수행한다(더 이상 범위 밖이 아니다) — PM이 3단계에서 director에게 구체적인 명령으로 요청한다.
