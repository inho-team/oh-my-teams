# Intern 우선 배정의 경제성 분석

## 결론

현재 제품은 새 workflow에서 명시 역할이 없을 때, 저위험·닫힌 범위·결정적 검증·표준 권한·일상 설계의 조합을 Intern에 우선 배정하도록 구현되어 있다. 이 정책은 역할 이름만 바꾸는 방식이 아니라 task 메타데이터, 역할 선택 사유, 실행 report와 workflow state의 `selection`을 연결하므로, Intern 미사용과 상위 승격을 사후에 확인할 수 있게 한다.

그러나 이 사실만으로 비용 절감이나 50% 절감을 주장할 수는 없다. 지원 workflow의 집계 `19382fb`은 수용되었지만, 역할별 비용은 여전히 미측정이다. 호출 횟수 증가도 절감의 증거가 아니다. 총량에는 상위의 계획·계약 작성·컨텍스트 전달, 하위 실행, 결정적 검사, 독립 검토, 반려 후 수정, 대기와 세션 재개가 함께 들어간다.

권고하는 운영 구조는 좁고 동질적인 저위험 작업을 Intern에게 묶어 배정하고 Junior가 통합하며, Senior가 중요한 설계·권한 경계를 독립 검토하는 방식이다. 이사 Astra, PM Sol, PL Terra 배치안은 이 구조와 같은 완료 조건에서만 평가할 후보이며, 현재 조직 revision 3 또는 실행 모델을 바꾸는 승인으로 해석하지 않는다.

## 확인된 구조적 문제와 이번 실행의 상태

이전 구조에서는 조직에 Intern이 있어도 depth 또는 역할 접기에 따라 Intern 책임이 상위 역할로 접힐 수 있었다. 특히 역할 접기는 선언된 역할 중 가장 가까운 상위 역할로 책임을 옮기므로, 조직도에 Intern이 있다는 사실만으로 실제 Intern 실행을 보장하지 않는다. 수용 runtime `57519bb`는 정책 적격성·승격 근거를 `selection.reason`에, 실제 접힘의 원인을 `selection.foldReason`에 분리하여 남긴다. 후자는 `run-depth-excluded` 또는 `organization-role-unavailable`이며, 역할이 실제로 바뀔 때만 기록된다.

이번 kickoff에서는 Intern Luna가 역할 지침의 좁은 편집을 수행했고, Junior Terra가 런타임과 이 보고서를 맡았으며, Senior Terra가 독립 검토를 맡았다. runtime은 두 차례 반려되어 CLI 역할 우회·회귀 누락과 접힘 사유 기록을 수정한 뒤 수용되었다. guidance는 한 차례 반려 후 수용되었고, 이 보고서는 첫 Senior 검토에서 반려되어 현재 수정·재검토 전이다.

### 실제 task 기준 Intern 비중

기준 시각은 2026-09-21T06:17:37Z의 r3 rework 기록이다. r3와 support-r3의 서로 다른 산출물 5개만 분모로 삼았고, r2의 `collect-code-map`과 `aggregate-usage`은 Agy 할당량·검증 계약 실패 뒤 r3/support-r3로 이관된 같은 논리 산출물이므로 중복 제외했다. 제출은 receipt가 붙어 settled 또는 running인 상태, 완료는 `acceptedResult`가 있는 상태로 정의한다.

| workflow | task | 역할 | 제출 상태 | 수용 상태 | 반려·수정·독립 검토 |
| --- | --- | --- | --- | --- | --- |
| intern-first-r3 | intern-first-runtime | Junior | 제출됨 | 수용 | 반려 2회, 수정 2회, Senior 승인 1회 |
| intern-first-r3 | intern-first-guidance | Intern | 제출됨 | 수용 | 반려 1회, 수정 1회, Senior 승인 1회 |
| intern-first-r3 | intern-first-report | Junior | 제출됨 | 미수용 | 반려 1회, 현재 수정본 재검토 전 |
| intern-first-support-r3 | intern-first-schema | Intern | 제출됨 | 수용 | 반려 1회, 수정 1회, Senior 승인 1회 |
| intern-first-support-r3 | intern-first-evidence | Intern | 제출됨 | 수용 | 반려 2회, 수정 2회, Senior 승인 1회 |

따라서 제출 기준 Intern 비중은 3/5(60%)이고, 수용 완료 task 기준 Intern 비중은 3/4(75%)이다. 이 보고서와 최종 integration task가 아직 수용 전이므로 전체 kickoff 완료율이나 최종 Intern 비중으로 확대하지 않는다. 이 비중은 task 개수 기준일 뿐 sessions·calls·tokens·금전 비용과 결합하지 않는다.

## 근거: 규칙과 실제 실행의 구분

### 기준과 구현 범위

기존 코드 맵의 23개 인용은 기준 커밋 `184c2de08e175a50e05ac3c93ccf41f63e93ccc4`에서 대조되어 수용되었다. 그 문서의 줄 번호는 과거 기준의 증거이며 현재 HEAD의 줄 번호로 사용하지 않는다. 현재 구현 동작은 `8e47414`의 런타임 API 요약과 해당 커밋의 코드를 확인했다.

| 구분 | 규칙 또는 구현 | Intern으로 내려가는 조건 | 상위로 돌아가거나 남는 조건 | 확인 방법 |
| --- | --- | --- | --- | --- |
| 역할 책임 | 역할 지침은 제한된 실무를 Intern에, 구현과 통합을 Junior에, 독립 검토·중요 경계 판단을 Senior에 둔다. | 파일·심볼 조사, 근거 수집, 집계, 정해진 반복 편집, 작은 독립 구현처럼 범위가 닫힌 일이다. | Intern은 재위임하지 않으며, 설계·권한·고위험 판단은 상위 역할이 맡는다. | `docs/plan/delegation-economics/code-map.md`의 항목 1~4 |
| 역할 해석 | `core.mjs`의 `foldRole`과 `resolveRole`은 선언되지 않은 역할 책임을 가장 가까운 상위 선언 역할로 접는다. | 조직과 depth가 Intern을 실제로 선언하면 요청 역할을 보존한다. | Intern이 없거나 depth가 Intern을 제외하면 상위 역할이 실제 책임을 갖는다. | 코드 맵 항목 5~10, 생성 state의 `selection` |
| 자동 선택 | `delegation.mjs`는 명시 `role`이 없을 때만 구조화 메타데이터를 평가한다. | `risk=low`, `scope=closed`, `verification=deterministic`, `authority=standard`, `design=routine`이다. | high risk, elevated authority, significant design, independent review는 Senior로 승격한다. 메타데이터가 없거나 보수적 조합이면 Junior를 선택한다. | `8e47414`의 `plugins/oh-my-teams/scripts/delegation.mjs`와 task 검증 |
| 명시 지시와 실행 계약 | workflow task의 명시 `role`은 자동 선택보다 우선한다. 생성 뒤 저장된 선택 역할은 실행 계약이다. | 사용자가 Intern을 명시하거나 자동 선택이 Intern을 요청한다. | 실행 시 다른 `--role`을 주면 거부한다. 이전 snapshot은 `legacy-role`로 호환 처리한다. | 런타임 API 요약, workflow state와 실행 report |
| 예산·검토·실패 | 호출 한도, attempts, concurrency, review gate와 failure routing은 역할 선택과 별개로 유지된다. | 결정적 검사를 통과하는 좁은 산출물만 다음 단계로 전달한다. | 검토 반려는 Junior의 수정 책임으로 돌아가며, 범위 과대는 PL의 분할 판단으로 돌아간다. | 코드 맵 항목 15~21 |

이 구현은 신규 workflow에 적용되는 제품 정책이며, 역할 스킬에 권장 문구만 더한 변경이 아니다. 기존 organization에 정책 필드가 없어도 Intern 우선 기본값을 적용하지만, 이미 저장한 workflow snapshot의 역할 의미는 바꾸지 않는다.

### 과거 snapshot의 Intern 부재와 실행 경로

두 과거 usage snapshot의 `byRole`에는 Intern 키와 session이 없다. 이는 관측 사실이다. 당시 기록은 PM·Junior·Senior 중심이며, audit-wave1의 실제 state와 기본 depth 선택이 Intern을 실행 역할에 넣지 않은 경우에는 `foldRole`이 책임을 상위 선언 역할로 접을 수 있다는 코드 경로와 일치한다. 다만 snapshot만으로 모든 미배정 원인을 확정할 수는 없으므로, 닫힌 작은 task 부족이나 상위의 준비·검토 비용은 추정으로 남긴다.

r1에서는 Agy Intern 두 건이 `RESOURCE_EXHAUSTED` 429로 도구 단계 전 종료했고, 이 오류는 gpt-oss 경로에 한정된 보존 사실이다. r2는 Intern 산출물을 재시도했지만 기존 null 검증 계약 결함으로 aggregate가 실패했고, r3은 Codex 전용 revision 3과 depth 4로 이관했다. `headless-start`·`role-terminal`·`worker-start`는 역할 실행을 여는 경로이고, fallback·`onExhaustion` 순회는 `work` 하네스에만 있다. 따라서 r1의 fallback 연결 부재와 r2/r3의 전환을 비용 절감 또는 모든 provider의 할당량 소진으로 일반화하지 않는다.

### OpenCodex 공통 실행 전환의 경계

현재 수용 runtime은 고정 OMT 경로의 headless, work, role-terminal, worker-start와 workflow selection을 검증한 제품 구현이다. OpenCodex 공통 실행 전환은 별도 kickoff의 미래 통합 후보이므로 이 PR의 완료 기능이나 배포 완료로 쓰지 않는다. 전환이 실제로 수용되면 provider 실행 경로·설치·liveness 기록의 중복을 줄일 가능성은 있으나, 계정 귀속, 취소, Windows 실측, 실제 비용·지연 효과는 아직 미측정이다.

### 사용량 단위와 측정 한계

provider별 `calls`, `turns`, 캐시 토큰은 같은 측정 단위가 아니다. CLI 호출 한도의 `callsUsed`는 provider 모델의 turn 또는 사용량과 다르며, 기존 Luna 실행에서 호출 한도상 `callsUsed=0`이어도 실제 모델 turn·usage가 존재할 수 있다. provider마다 prompt token에 캐시 입력을 포함하는지, 캐시 생성 토큰을 별도 제공하는지, source가 headless·Codex rollout·Claude transcript인지도 다르다.

`costUsd=null`은 비용이 0이라는 뜻이 아니라 비용을 측정하지 않았다는 뜻이다. API 환산이나 비캐시 합계는 구독 차감량이나 실제 청구액으로 사용할 수 없다. 여러 역할이 같은 실행·구독 자원을 공유할 수 있으므로, 역할별 token 수만으로 독립적인 금전 비용을 배분할 수도 없다.

수용된 집계 `19382fb`의 현재 kickoff checkpoint는 9개 측정 session을 역할별로 연결했다. Intern은 5 sessions, 5 turns, 24 calls이며 Junior는 1 session, 1 turn, 18 calls, Senior는 1 session, 1 turn, 5 calls이다. PM Claude 기록은 1 session, 5 turns, 80 calls이고, PM 실행과 수동으로 연결한 Astra record는 집계 정본에서는 여전히 unattributed 1 session, 1 turn, 37 calls로 남는다. 이 수치는 서로 다른 provider source와 시간창의 사용량 기록이므로 역할별 작업 비중이나 비용 비율이 아니다.

수동 연결 근거는 launch ledger, run-use binding, terminal과 thread metadata를 함께 대조하여 Astra record가 PM OMT 실행에 연결된다는 사실까지 확인한다. 그러나 그 record의 작업 용도는 분류하지 못했다. 따라서 작업 용도 분모는 1이고 미분류도 1이며, 각 용도별 token 배분은 모두 `null`이다. 역할 귀속이 확인되었다는 사실을 계획·배정·취합, 상태 조회, 이사 판단, 직접 구현 또는 실패 복구의 비중으로 바꾸어 쓰지 않는다.

과거 usage snapshot, 현재 읽은 director-role state, 사용자 제공 Mac 집계, 이번 kickoff checkpoint는 생성 시각과 시간창이 서로 다르다. 따라서 이 자료들을 합쳐 전후 비용 절감률이나 업무 완료율을 계산하지 않는다. 사용자가 제공한 Mac 전체 부분 집계는 2026-09-21 00:00:00부터 14:23:45(KST)까지의 로컬 Codex 사용이며, OMT 전용도 아니고 다른 기기·실행기를 포함하지 않는다. 다음 표의 `총계-캐시 입력`은 제공 자료의 파생 열일 뿐 공식 과금 가중치나 구독 차감량이 아니다.

| 모델 | 총 토큰 | 캐시 입력 | 출력 | 총계-캐시 입력 |
| --- | ---: | ---: | ---: | ---: |
| Astra | 387,066,523 | 378,583,936 | 742,736 | 8,482,587 |
| Luna | 50,838,667 | 48,991,872 | 244,605 | 1,846,795 |
| Terra | 19,311,805 | 17,950,592 | 105,330 | 1,361,213 |
| Sol | 3,960,843 | 3,773,184 | 39,620 | 187,659 |

이 표는 시간창과 범위가 제한된 사용자 제공 근거이므로 역할별 낭비, 실제 청구, 품질, 시간 우월성을 입증하지 않는다. 특히 Sol의 품질 또는 시간 우월성은 실측 없이 단정하지 않는다.

## 작업 적합성과 세 구조 비교

| 구조 | 유리한 상황 | 총량에서 반드시 더할 항목 | 주요 위험과 통제 | 이 사례에서의 판정 |
| --- | --- | --- | --- | --- |
| 상위 역할 중심 | 권한 판단, 열린 설계, 여러 파일의 강한 의존성이 즉시 결합된 일 | 상위 모델의 긴 컨텍스트와 직접 실행 시간 | 병목과 고비용 재독이다. 결정적 검사를 먼저 두고 필요한 판단만 상위에 올린다. | 중요 경계에는 필요하지만, 닫힌 조사·집계까지 일괄 처리하면 Intern 활용 근거가 없다. |
| PM→Junior 평평한 배정 | 통합 책임이 강하고 Intern task로 분할하기 어려운 중간 규모 구현 | PM 계약, Junior 구현, 검토, 재작업, 대기 | Junior가 모든 근거와 파일을 다시 읽는 비용이다. 파일 소유권과 요약을 제한한다. | 메타데이터가 보수적이거나 부족한 task의 안전한 기본값이다. |
| Intern 묶음→Junior 통합→Senior 경계 검토 | 동질적인 닫힌 작업을 여러 개 묶고 결정적 검증을 할 수 있을 때 | 계약 전달, batch fan-out/fan-in, Junior 통합, 독립 검토, 반려·재개 | 너무 작은 task의 준비 비용, 형식 오류, provider 제한, 상위 재독이다. 묶음 단위·검사·종료 조건을 계약에 고정한다. | 현재 정책과 가장 부합한다. 문서 반려와 코드 반려 비용까지 포함해 수용 집계로 평가해야 한다. |

세 비교는 반사실적 분석이다. 이번 실행에서 세 구조를 같은 입력과 완료 조건으로 반복 실험하지 않았으므로, 우열이나 절감률을 실측 결과로 주장하지 않는다. 50% 절감은 검증되지 않은 목표 가설로 유지한다.

## 권고하는 배정·감독 설계

1. PM은 task를 작은 완료 조건으로 나누되, 같은 종류의 닫힌 작업은 한 Intern 배정으로 묶습니다. 각 계약에는 파일 소유권, 입력, 출력, 결정적 검사, 종료 조건과 Intern을 쓰지 않은 이유를 적습니다.
2. 자동 선택은 구조화된 delegation 메타데이터를 사용합니다. 명시 사용자 역할은 우선하며, 적격성·승격은 `selection.reason`, Intern 부재·depth 접힘은 `selection.foldReason`으로 남깁니다.
3. Junior는 Intern 산출물을 기계적으로 재독하지 않고, 결정적 검사와 차분 요약을 먼저 확인합니다. 실패한 좁은 범위만 수정·재실행하고 통합 책임을 유지합니다.
4. Senior는 설계, 권한, 고위험 변경과 독립 검토에 집중합니다. 비용을 줄이기 위해 독립 검토나 실제 완료 확인을 제거하지 않습니다.
5. 상태 조회는 이벤트 중심으로 바꿉니다. 완료·검토 요청·실패·예산 임계치 이벤트만 상위에 올리고, 반복 polling은 결정적 상태 집계로 대체합니다.
6. 짧은 계약, 변경분 보고, 산출물과 세션의 분리는 컨텍스트 재전송을 줄일 가능성이 있습니다. 다만 새 세션의 재개 비용과 근거 재확인 비용도 측정해, 압축이 항상 이득이라고 가정하지 않습니다.
7. 기존 maxCalls, attempts, concurrency, review gate와 자원 제한을 유지합니다. 중단 조건을 먼저 적용하고, 공급자 호출을 늘려 실패를 덮지 않습니다.

## 제안 배치의 채택 조건

현재 revision 3은 PM=Codex current, PL/Senior/Junior=Terra, Intern=Luna인 Codex 전용 배치이다. 이사 Astra, PM Sol, PL Terra 안은 평가안일 뿐 현재 실행 모델 변경을 승인하지 않는다. 제안 배치를 채택하려면 다음을 같은 완료 조건 아래에서 확인해야 한다.

- 동일한 task 집합, 결정적 검사, 독립 검토와 완료 정의를 유지한다.
- PM의 일상 배정·취합과 이사에게 올릴 권한·설계·중단 판단을 분리한다. 이사는 중요한 경계와 예외만 판단하고, PM은 일상 계획·취합을 담당한다.
- Intern Luna의 닫힌 실무, PL Terra의 조율, Junior 통합, Senior 검토가 실제 실행 기록에서 구분된다. 호출·세션·모델·역할을 서로 대체 지표로 쓰지 않는다.
- 완료 시간, 실패·재작업, 상위 재검토, 상태 조회, 컨텍스트 재전송, 세션 재개와 미측정 비용을 전부 기록한다.
- 품질 저하, 검토 누락, 지연 증가, 예산 한도 초과가 없고, 미리 정한 지표에서 재현 가능한 개선이 확인된다.

## 후속 변경, 지표와 도입·중단 기준

후속 변경의 세부 파일과 수용 기준은 [후속 구현 브리프](delegation-economics-followup.md)에 정리한다. 수용 runtime `57519bb`는 역할 자동 선택과 `reason`·`foldReason` provenance를 제공하며, evidence `19382fb`은 수용된 집계이다. 둘은 제품 구현과 근거 산출물의 수용 상태일 뿐, 이 PR의 최종 integration 또는 제품 배포 완료를 뜻하지 않는다.

도입 전후에는 다음 지표를 같은 시간창과 정의로 기록한다.

- 닫힌 저위험 task 중 실제 Intern이 완료한 비중과 Intern 미배정 사유 분포
- 역할·provider·source별 sessions, turns, calls, prompt·cached input·cache creation·output tokens와 null 비용 비율
- 최초 완료까지 걸린 시간, 대기 시간, 검토 반려율, 재작업 횟수, 결정적 검사 실패율
- PM·Junior·Senior의 재독 시간에 대한 대리 지표, 상태 조회 횟수, 컨텍스트 재전송과 세션 재개 횟수
- 독립 검토 누락, 권한 경계 오류, 데이터 손실 또는 보안 문제의 건수

도입은 정해진 기간에 품질·검토·권한 경계를 유지하면서 닫힌 실무의 Intern 비중과 완료 시간이 개선되는 경우에만 확대한다. 다음 중 하나가 나타나면 확장을 중단하고 원인을 분리한다: 결정적 검사 또는 독립 검토 실패 증가, 재작업·대기 증가로 총 완료 시간이 악화, 역할 선택 사유 누락, provider 제한으로 반복 실패, 또는 비용을 측정하지 못한 상태에서 절감률을 단정하려는 경우이다.
