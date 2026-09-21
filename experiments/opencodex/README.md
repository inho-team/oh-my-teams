# OpenCodex 격리 비교 실험

이 디렉터리는 런타임 구현이 아니라 수동 검증용 픽스처와 기록 도구입니다. 실험 설치물, 로그인 저장소, 실행 작업 디렉터리는 워크트리 밖에 둡니다. 실제 판정과 출처는 [조사 보고서](../../docs/plan/opencodex-runtime.md)에 기록합니다.

`fixture/sum.js`에는 의도적인 결함이 있습니다. 재현 스크립트는 임시 디렉터리에 복사하고 `node --test sum.test.js`가 실패하는 것을 먼저 기록합니다. 저장소의 정상 테스트에는 이 결함 픽스처가 포함되지 않습니다.

```sh
python3 experiments/opencodex/snapshot.py --output /tmp/omt-opencodex-probe.dAKX3U/before-login.json
python3 experiments/opencodex/probe.py --subscription claude \
  --model anthropic/claude-sonnet-4-6 --lab /tmp/omt-opencodex-probe.dAKX3U
```

기본 실행은 사전 점검만 수행합니다. 사람의 격리 로그인을 완료한 뒤 프록시 모델 목록과 단일 계정 라우팅을 확인하고, 정확한 모델 이름을 지정하여 `--execute --routing-reviewed`를 추가해야 Codex를 실행합니다. Claude와 Antigravity의 같은 모델은 각각 `anthropic/…`와 `google-antigravity/…`로 구분합니다. 이 접두사만으로 실제 청구 계정을 입증할 수는 없습니다. API 키, combo, 자동 계정 전환을 설정하지 않습니다. ChatGPT 모델은 현재 조직에 명시되어 있지 않으므로 임의로 대체하지 않고 확인한 뒤 지정합니다.

프로세스 종료 코드와 `turn.completed`, 수정한 파일의 해시, 테스트 결과를 함께 확인합니다. `task-completed-attribution-unverified`는 작업 수행만 확인한 상태이며 구독 지원 성공 판정이 아닙니다. 모델 관측값이 비어 있으면 미확인으로 남습니다. 사용량 숫자만으로 구독 귀속을 입증하지 않습니다. 계정별 프록시 기록과 구독 사용량 근거는 별도로 검토해야 합니다.

표준 출력의 이벤트와 오류는 메모리에서 제한된 필드만 추출하며 원문을 저장하지 않습니다. stderr는 존재 여부만 기록합니다. 토큰, 계정 이메일, 명령 원문, 모델의 자유 텍스트를 결과 JSON에 넣지 않습니다. 이 방식에서는 특정 오류의 원문이 보존되지 않으므로, 할당량 오류가 발생하면 재시도하지 말고 비밀값을 제거한 원문을 사람이 별도로 확인해야 합니다.

Antigravity는 2026-09-21T06:04Z 이전에 실행하지 않습니다. 이후에도 `antigravity-attempt.lock`으로 이 실험 디렉터리에서 한 번만 실행합니다. Codex 전송 재시도는 0으로 설정하지만 프록시 내부의 모든 제공자 재시도까지 검증한 것은 아닙니다. 180초 제한은 Codex 프로세스 종료를 위한 것이며 자손 프로세스 전체의 취소를 입증하지 않습니다.

```sh
python3 experiments/opencodex/snapshot.py \
  --output /tmp/omt-opencodex-probe.dAKX3U/after-login.json \
  --compare /tmp/omt-opencodex-probe.dAKX3U/before-login.json
```

스냅샷은 파일의 SHA-256과 수정 시각, 관련 키체인 항목의 메타데이터 해시만 기록합니다. `security find-generic-password`에는 `-w`와 `-g`를 사용하지 않습니다. 이 검사는 모든 키체인 항목의 무변경이나 디렉터리 내부 전체의 무변경을 입증하지 않습니다.
