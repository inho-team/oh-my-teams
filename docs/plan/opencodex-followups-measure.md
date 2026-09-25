# OpenCodex followups w2 — runner-measure 마감 기록

## 결정

사용자가 2026-09-23에 Claude·Antigravity 귀속(F-1의 구독 실측)을 OMT 지원 범위 밖으로 확정했습니다. 이 결정에 따라 이 문서는 구독 로그인과 실측을 수행하지 않고, 그 결정과 현재 코드가 보장하는 동작만 기록합니다.

## 구독별 결과

| 구독 | 요청 모델 | 관측 모델 | provider | 계정 표식 해시 | 작업 결과 | 종료 코드 | 사용량 | 비고 |
|---|---|---|---|---|---|---|---|---|
| Claude (Anthropic OAuth) | 해당 없음 | 해당 없음 | claude | 해당 없음 | 미실측 | 해당 없음 | 해당 없음 | 사용자 결정(2026-09-23)으로 지원 범위 밖 확정 |
| Antigravity (Google Antigravity) | 해당 없음 | 해당 없음 | agy | 해당 없음 | 미실측 | 해당 없음 | 해당 없음 | 사용자 결정(2026-09-23)으로 지원 범위 밖 확정 |

이 task는 두 구독 가운데 어느 쪽도 실행하지 않았으므로, `OPENCODEX_RUNNER_PROVIDERS`(`plugins/oh-my-teams/scripts/opencodex.mjs:13`)는 `["codex"]`로 그대로 남아 있고, 이 표의 두 구독을 지원 목록에 추가하지 않습니다.

## 근거

- 실측 계획이 있던 위치: `docs/plan/opencodex-followups-design.md`의 A4(격리 로그인 절차와 사용자 확인 항목)와 A5(실측 계획과 지원 목록 편입 규칙)입니다. 두 절은 지우지 않았고, 이번 결정을 알리는 한 줄을 머리말에 덧붙였습니다.
- 코드가 실제로 보장하는 거부 동작: `validateOpenCodexRunner`(`opencodex.mjs:46-61`)와 조직 저장 경로(`core.mjs:691-694`)가 `OPENCODEX_RUNNER_PROVIDERS`에 없는 provider의 runner 블록을, 프로필 ID와 provider를 담은 메시지로 거부합니다. 회귀 테스트는 `tests/opencodex-runner-provider.test.mjs`에 있습니다.
- `actualRunner`(`role-launch.mjs:453`)는 실제 실행 파일 이름에서 계산하는 값이며, 이번 결정과 무관하게 그대로 남아 있습니다.
- Claude·Agy OAuth 계정 홈 검증 코드(`validateFixedOpenCodexOAuthHome`, `opencodex.mjs:234`)는 남아 있지만, 위 거부 때문에 `OPENCODEX_RUNNER_PROVIDERS`가 바뀌지 않는 한 실행 경로에 닿지 않습니다.

## 관련 결정

- 이사 결정(2026-09-23): Claude·Agy 귀속(F-1의 구독 실측)을 OMT 지원 범위 밖으로 확정합니다.
- PM 지시: 위 이사 결정에 따라 로그인과 실측 없이 `runner-measure` task를 마감합니다. 지원 목록과 거부 동작은 개정하지 않고, 결과를 미검증으로 기록합니다.
