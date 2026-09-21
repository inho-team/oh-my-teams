# OpenCodex plugin 설치 실측 증거

부분 완료: 격리된 host 홈에서 Claude plugin manifest 검증과 Codex local marketplace 설치를 수행했고, Codex cache에 package와 lockfile이 복사되었지만 lifecycle 표식과 `node_modules`는 생성되지 않았습니다.

## 범위와 격리

실험은 `/tmp/omt-host-probe-*` 전용 디렉터리에서 수행했습니다. `HOME`과 `CODEX_HOME`을 임시 경로로 지정했고, 기존 인증 파일을 읽거나 복사하지 않았으며, 전역 plugin 목록과 원래 설정을 변경하지 않았습니다. fixture의 lifecycle script는 `OMT_MARKER`가 가리키는 임시 파일에 시각과 `postinstall` 문자열만 기록합니다.

실험 fixture와 재현 명령은 [run_probe.py](../../experiments/opencodex-plugin-install/run_probe.py)에 있고, 원시 결과는 [result.json](../../experiments/opencodex-plugin-install/result.json)에 있습니다.

## host와 공식 근거

| 항목 | 실측값 |
| --- | --- |
| Claude Code | `2.1.278` |
| Codex CLI | `0.155.1` |
| npm | `11.19.0` |
| Bun | `1.2.19` |
| OpenCodex `ocx` 2.59.0 | 미실행. `ocx`가 PATH에 없었습니다. |

Claude CLI 도움말에서 `--plugin-dir`가 현재 세션에만 plugin을 로드하며, `plugin validate`가 manifest를 검증하는 것을 확인했습니다. Codex CLI 도움말에서 `plugin marketplace add`가 local marketplace를 등록하고 `plugin add`가 `PLUGIN@MARKETPLACE`를 설치하는 것을 확인했습니다.

Claude 공식 문서는 복사된 plugin의 루트에 `package.json`과 지원 lockfile이 모두 있을 때 npm은 `npm ci --ignore-scripts`로 설치하고, Bun은 `bun install --frozen-lockfile --ignore-scripts`로 설치한다고 설명합니다. 또한 이 자동 설치는 lifecycle script를 실행하지 않으며 60초 제한을 적용한다고 명시합니다. 근거는 [Claude Plugins reference의 Node.js package dependencies 절](https://code.claude.com/docs/en/plugins-reference#nodejs-package-dependencies)입니다. Codex plugin marketplace의 local source와 cache 설치 경로는 [OpenAI Plugins packaging 문서](https://developers.openai.com/plugins/build/plugins)에 설명되어 있습니다.

## 실행 결과

| 단계 | 명령 | 종료 코드 | 관측 결과 |
| --- | --- | ---: | --- |
| Claude 격리 검증 | `claude --bare plugin validate <isolated-plugin>` | 0 | manifest 검증 통과. version과 author 경고만 발생했습니다. |
| npm 의존성 설치 | `npm ci --ignore-scripts` | 0 | package-lock의 `is-odd`와 `is-number` 2개가 설치되었고 `node_modules`가 생성되었습니다. lifecycle 표식은 생성되지 않았습니다. |
| lifecycle 대조 | `npm install` | 0 | `postinstall`이 실행되었고 marker에 1줄이 기록되었습니다. 이 명령은 host 자동 설치 동작의 근거가 아니라 대조용 실행입니다. |
| 반복 설치 | `npm ci --ignore-scripts` | 0 | 의존성이 다시 설치되었고 기존 marker 1줄이 그대로 유지되었습니다. |
| Codex marketplace 등록 | `codex plugin marketplace add <isolated-marketplace> --json` | 0 | `omt-isolated-probe` marketplace가 임시 `CODEX_HOME`에 등록되었습니다. |
| Codex plugin 설치 | `codex plugin add install-probe@omt-isolated-probe --json` | 0 | `plugins/cache/omt-isolated-probe/install-probe/1.0.0`에 manifest, package.json, package-lock.json이 복사되었습니다. `node_modules`는 없었고 lifecycle marker도 추가되지 않았습니다. |
| Codex 반복 설치 | 같은 `codex plugin add` 명령 | 0 | 동일 cache 경로를 재사용했으며 `node_modules`와 lifecycle marker는 계속 없었습니다. |

Codex의 local plugin 설치는 fixture의 package와 lockfile을 cache에 복사했지만, 이 실측에서는 npm dependency install 또는 lifecycle 실행을 관측하지 못했습니다. 따라서 plugin 설치 완료를 OpenCodex 실행 가능성으로 해석하지 않습니다.

## 미실행 및 제한

- Claude의 첫 세션 prompt와 Codex의 첫 세션은 새 추론을 실행하므로 수행하지 않았습니다. Claude/Agy 추론과 로그인, GUI 조작도 수행하지 않았습니다.
- `ocx --version`, Bun 기반 OpenCodex 2.59.0 실행, proxy health/ready, provider/account binding은 `ocx` 실행 파일이 없어 미실행으로 남겼습니다. npm lifecycle 검증만으로 OpenCodex 실행 준비를 입증할 수 없습니다.
- Windows host와 Windows npm shim은 이 환경에서 측정하지 않았습니다.
- fixture는 무해한 local dependency만 사용하며, lifecycle 표식은 별도 임시 홈에만 기록됩니다.

## 재현

```sh
python3 experiments/opencodex-plugin-install/run_probe.py
npm ci
npm run format
npm run sync
npm run lint
npm test
```
