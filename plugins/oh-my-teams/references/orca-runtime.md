# Orca runtime discovery

oh my teams는 역할·작업 계약·검증 gate를 소유하고, worktree·터미널·Task/Dispatch·settlement는 Orca에 맡긴다. 저장소에 복사된 명령 옵션을 최신 사양으로 간주하지 않는다.

감독 실행을 시작할 때 한 번 다음 절차를 따른다.

1. 현재 세션의 공식 `orca-cli` skill이 정한 discovery 규칙으로 실행 파일을 하나 선택한다. 조용히 다른 실행 파일로 전환하지 않는다.
2. 선택한 실행 파일에서 `skills get orca-cli`를 읽는다.
3. Task/Dispatch 감독이 필요할 때 같은 실행 파일에서 `skills get orchestration`을 읽는다.
4. 필요한 참조만 추가로 읽고, 그 가이드가 실제로 제공한 명령·인자·응답 필드를 사용한다.
5. run 기록에 실행 파일 경로, 확인 가능한 버전, 조회한 skill ID와 내용 hash를 남긴다. 조회 성공은 바이너리가 전 세계 최신 버전이라는 증거가 아니다.

가이드 조회 실패, 실행 파일 불일치, 필수 기능 부재, 응답 필드 변경은 서로 다른 오류로 보존한다. 쓰기 작업은 기억한 명령으로 계속하지 않는다. 타임아웃 뒤 생성 여부가 불명확하면 현재 상태를 조회해 receipt를 복구하고 생성부터 반복하지 않는다. 실행 중 바이너리가 바뀌면 살아 있는 작업은 유지하고 다음 실행 경계에서 discovery를 다시 수행한다.

같은 세션과 실행 파일에서 동일 가이드를 매 호출마다 다시 읽지 않는다. 자식에게는 전체 가이드가 아니라 실행 파일 식별자와 필요한 참조를 전달한다. oh my teams는 Orca polling, lifecycle, 프로세스 회수 또는 업데이트 관리자를 재구현하지 않는다.

## Agy 모델 선택

Agy 프로필의 `model`은 프롬프트 설명이 아니라 실제 CLI 인자로 전달한다. GPT-OSS, Sonnet, Opus는 같은 `--model <model-id>` 형식을 사용한다.

```text
agy --model gpt-oss-120b-medium ...
agy --model claude-sonnet-4-6 ...
agy --model claude-opus-4-6-thinking ...
```

모델 ID는 실행 직전에 `agy models`에서 확인한다. `gpt-oss-120b-medium`처럼 모델 ID 자체에 추론 수준이 포함되거나 Agy가 별도 effort를 지원하지 않는 모델에는 `--effort`를 추가하지 않는다. 모델 선택 오류가 호출 전에 반환되면 사용량 0인 구성 오류로 기록하고, 기본 모델로 조용히 다시 실행하지 않는다.

제한 편집 하네스는 `scripts/providers.mjs`가 프로필의 모델 ID를 인자 배열에 추가한다. 일반 감독 작업에서 Orca의 등록된 agent launcher가 Agy를 지원하면 requested/effective 모델을 대조한다. 지원하지 않으면 현재 orchestration 가이드의 custom argv 경로를 사용하되, 모델을 감지할 수 없거나 대화형 화면의 현재 모델이 요청과 다르면 Dispatch를 시작하지 않는다. 계정·모델을 다른 실행기로 임의 대체하지 않는다.
