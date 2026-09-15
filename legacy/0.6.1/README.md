# 0.6.1 historical implementation

이 폴더는 이전 macOS/Agy 중심 구현과 실측 기록의 보존본이다. 플러그인 `skills/` 밖에 있어 자동 발견되지 않으며 1.0 런타임에서는 호출하지 않는다. 한국식 직급, 고정 계정·모델, 폴러, 무조건 재검증 및 실패 후 통과 경로는 이전 동작을 기록한 것이며 현재 정책이 아니다.

필요한 회귀 근거를 확인할 때 해당 파일만 읽는다. 현재 실행 경로는 `plugins/oh-my-teams/scripts/`, 현재 역할은 `plugins/oh-my-teams/skills/`에 있다. `plugins/orca/scripts/`에는 이전 이름으로 호출하는 경우를 위한 forwarding 진입점 하나만 남아 있으며, `plugins/orca/skills/`는 존재하지 않는다.
