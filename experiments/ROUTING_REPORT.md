# 모델 라우팅 E1/E2 결과

- 실행일: 2026-09-14
- 실행 환경: Agy, Orca CLI/runtime 1.4.200
- 기준 커밋: `4fbb185146c536b00b1911186722ce82384816e9`
- 호출 수: E1 18회 + Opus-first 6회 + balanced 6회 = 30회
- 자동 재시도: 없음
- 할당량 차감: 전후 지원 스냅샷이 없어 판정 불가

## 결론

이번 1회 배치에서는 **balanced를 잠정 기본 권고**로 채택한다. balanced는 6/6을 통과했고, Opus-first의 5/6보다 높았다. 총 토큰은 95,449 대 105,658로 9.7% 적었고 모델 호출 시간 합계는 60.8초 대 72.3초로 16.0% 짧았다. 반복 실험이 아니므로 통계적 우위나 영구 기본값을 뜻하지 않는다.

GPT-OSS 운영 배정은 **좁고 결정적으로 검증 가능한 편집과 정확한 인용**으로 제한한다. E1에서 다중 파일·검토·충돌 fixture도 한 번 통과했지만, 표본 하나만으로 중요한 판단 업무까지 확대하지 않는다. 일반 구현 fixture에서는 숫자 `1` 입력을 문자열과 구분하지 못해 실패했다.

## 결과

| 경로 | 통과 | 전체 토큰 | 모델 시간 합계 |
|---|---:|---:|---:|
| E1 전체 | 17/18 | 286,621 | 192.2초 |
| Opus-first | 5/6 | 105,658 | 72.3초 |
| balanced | 6/6 | 95,449 | 60.8초 |

E1 모델별 결과:

| 모델 | 통과 | 전체 토큰 | 모델 시간 합계 |
|---|---:|---:|---:|
| GPT-OSS 120B | 5/6 | 75,624 | 55.2초 |
| Sonnet 4.6 | 6/6 | 105,259 | 61.9초 |
| Opus 4.6 | 6/6 | 105,738 | 75.1초 |

Opus-first의 일반 구현 실패는 모델이 숫자 `1`도 허용한 결과다. 같은 모델은 E1의 동일 fixture에서는 통과했으므로 단일 호출의 변동성을 보여준다. balanced에서는 해당 작업을 Sonnet에 배정해 통과했다.

## 재채점 기록

초기 narrow-edit grader는 정확한 정답 문장도 고정 문자열과 완전히 같지 않으면 실패 처리했다. 원본 evaluation evidence를 보존한 채 의미상 동등한 `>=`, `≤`, “같거나/크거나”, “greater than or equal”을 받는 grader v3로 재채점했다. 이 변경으로 새 모델 호출은 발생하지 않았다. 일반 구현 실패는 고정 acceptance test의 실제 실패이므로 유지했다.

## 증거와 정리 상태

- 배포용 집계: [`routing-summary.json`](routing-summary.json)
- 로컬 원본: `experiments/results/routing-*/manifest.json` 및 호출별 결과
- 세 Orca worktree는 정확한 ID로 terminal close를 완료하고 `completed` 상태로 보존했다.
- 각 manifest의 `cleanup.status`는 `completed`다.
- requested model은 기록했지만 Agy 응답에서 effective model ID가 제공되지 않아 지어내지 않고 `null`로 유지했다.
- 토큰은 공급자 보고값이며 금액이나 구독 할당량 퍼센트가 아니다.

## 적용

- `balanced`: 잠정 권고. Senior=Opus, Junior=Sonnet, Intern=GPT-OSS 구조를 유지한다.
- `opus-first`: 중요한 작업의 fallback 및 후속 반복 비교 기준선으로 유지한다.
- GPT-OSS: 좁은 편집·인용에 우선 사용하고, 일반 구현 실패 시 저장된 Sonnet/Opus 경로로 승격한다.
- 모델이 필요 없는 집계·상태·검사는 계속 결정적 스크립트로 처리한다.
