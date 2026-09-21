# Intern 우선 배정 경제성: 후속 구현·검증 브리프

## 목표

새 workflow의 실제 역할 선택을 Intern 우선 정책에 연결하고, 경제성 평가는 수용된 provenance 보존 집계와 동일한 완료 조건에서 수행한다. 목적은 Intern 호출 수를 늘리는 것이 아니라, 닫힌 저위험 실무를 적절히 위임하면서 품질·권한 경계·독립 검토·완료 시간을 보존하는 것이다.

## 변경 범위

| 범주 | 파일 또는 산출물 | 변경 또는 확인 내용 |
| --- | --- | --- |
| 역할 선택 | `plugins/oh-my-teams/scripts/delegation.mjs` | 명시 역할이 없을 때 구조화된 risk·delegation 메타데이터로 Intern·Junior·Senior를 보수적으로 선택한다. |
| 계약 검증 | task·workflow·organization schema와 예시 | delegation의 `scope`, `verification`, `authority`, `design`을 검증하고, 신규 조직의 `intern-first` 기본 정책과 role 생략 예시를 제공한다. |
| 실행 provenance | workflow state, 실행 report, usage 집계 | `selection.source`, `reason`, `requestedRole`, `selectedRole`을 보존하고, depth 접힘·Intern 부재·상위 승격을 재현할 수 있게 한다. |
| 역할 지침 | PM·PL·Junior·Senior·Intern·kickoff·form 지침 | 닫힌 실무의 묶음 배정, 파일 소유권, 결정적 검사, 차분 보고, 상위 승격과 독립 검토의 책임을 일관되게 안내한다. |
| 경제성 보고 | `docs/plan/delegation-economics.md`와 수용된 익명 집계 | 실제 Intern 실무 비중과 상위 검토·반려·재작업·지연을 분리하고, provider 단위와 미측정 비용을 보존한다. |

## 수용 기준

1. 명시 역할이 없고 `risk=low`, `scope=closed`, `verification=deterministic`, `authority=standard`, `design=routine`인 task는 Intern을 요청한다.
2. high risk, elevated authority, significant design 또는 independent review task는 Senior로 승격하며 그 이유가 저장된다. 메타데이터가 없거나 보수적 조합이면 Junior가 선택된다.
3. 사용자가 명시한 역할은 자동 선택보다 우선한다. workflow 생성 뒤 실행 role이 저장된 계약과 다르면 실행을 거부한다.
4. Intern이 없는 조직, depth로 Intern을 제외한 workflow, 이전 snapshot은 호환되게 상위 역할로 접히며, 실제 선택과 이유를 확인할 수 있다.
5. 결정적 회귀 검사는 Intern 우선, 상위 승격, 사용자 역할 우선, 축소 조직 호환, 선택 provenance와 실행 receipt를 함께 검증한다.
6. 동일한 완료 조건에서 현재 배치와 이사 Astra·PM Sol·PL Terra 평가안을 비교한다. 품질, 완료 시간, 검토·재작업, 상태 조회, 컨텍스트 재전송, 세션 재개와 미측정 비용을 함께 기록한다.
7. provider별 calls·turns·캐시 의미를 분리하고, `costUsd=null`은 미측정으로 보존한다. API 환산이나 비캐시 합계를 구독 차감 또는 실제 청구로 주장하지 않는다.
8. 독립 검토와 실제 완료 확인을 없애지 않는다. 수용된 support workflow 집계가 없으면 경제성 수치·절감률 결론을 보류한다.

## 비목표

- 현재 조직 revision 3, 모델, 구독 또는 실행 중 workflow snapshot을 변경하지 않습니다.
- 수용되지 않은 집계 산출물로 비용·역할 귀속·절감률을 확정하지 않습니다.
- 새 장기 벤치마크, 공급자 호출, 가격 조회를 시작하지 않습니다.
- 호출 수 증가만을 성공 지표로 삼지 않습니다.

## 검증 계획과 배포 판단

1. 구현 변경은 repository의 format, sync, lint, test와 공식 workflow verify를 통과해야 합니다.
2. support workflow가 수용한 집계 HEAD와 provenance 검증 결과를 읽기 전용으로 재사용합니다. 보고서 담당자는 원본 집계를 수정하거나 재집계하지 않습니다.
3. 수용 집계에서 PM 연결이 여전히 `unattributed`이면 이를 0으로 치환하지 않고, 수동 연결 근거와 집계 한계를 병기합니다. 현재 Astra record는 PM 실행과 연결되지만 작업 용도는 미분류 1/1이며 token 배분은 `null`이므로, 이를 역할별 업무량이나 비용으로 환산하지 않습니다.
4. Senior 독립 검토는 역할 선택, provenance, 단위 구분, 수치 해석, 개인정보 배제를 확인합니다.
5. 제안 모델 배치는 별도 확정 지시가 있을 때만 변경합니다. 그 전에는 평가안으로만 보고하고, Sol의 품질·시간 우월성은 실측 없이 주장하지 않습니다.

## 운영 중단 조건

다음 상황에서는 rollout 확대를 멈추고 계약·선택 reason·검사 결과를 검토합니다: Intern task의 결정적 검사 실패 또는 반려가 증가하는 경우, 재작업·대기 때문에 완료 시간이 악화되는 경우, 상위 역할의 재독이 Intern 위임 이득을 상쇄하는 경우, provider 제한이 반복되는 경우, 또는 비용이 미측정인데 절감률을 확정하려는 경우입니다.
