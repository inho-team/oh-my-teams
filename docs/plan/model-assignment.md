# 조직 모델 배정 정책

자원형 조직은 `modelAssignment`에 이사·PM·Worker의 허용 모델과 자원을 저장합니다. 이사는 역할 그래프 밖의 호스트 세션이므로 기본값도 `roles`가 아니라 이 정책에서 읽어 실행합니다.

정책이 있는 조직은 저장 시 모든 고정 모델을 현재 Codex catalog로 다시 확인합니다. PM bootstrap, workflow staffing, 이후 staffing 변경, 그리고 role launch는 동결된 조직 스냅샷의 정책과 대조하므로, 잘못된 모델·자원·추론 강도는 거부됩니다.

Worker의 `models` 목록은 사용량 한도 소진 시의 fallback 순서가 아닙니다. PM은 개별 task의 근거에 따라 목록에서 하나를 명시적으로 선택하며, 진행 중 kickoff는 저장된 organization과 staffing 스냅샷을 계속 사용합니다.
