# orca-skills

orca 3층 오케스트레이션의 스킬·스크립트. Claude Code 플러그인 마켓(`orca-skills`)이자, codex·agy 가 읽는 고정 경로(`~/.orca-skills`)의 원본.

- 설치: `sh install.sh` (마켓 등록 + `orca` 플러그인 설치 + `~/.orca-skills` 링크)
- 갱신: `claude plugin marketplace update orca-skills && claude plugin update orca@orca-skills` (링크는 마켓 클론을 가리키므로 그대로)
- 구성: `plugins/orca/skills/{orca-top,orca-lead,orca-worker,pm}` — 규칙은 각 SKILL.md, 스크립트는 orca-lead/(launch-worker·finish-worker·verify-pr·poll·intern-run·agent-stats), orca-worker/preflight.sh
- 프로젝트별 상태(`~/.<프로젝트>/coord/`, `<저장소>/.orca/project.env`)는 여기 두지 않는다.

## 갱신 규칙
- 푸시할 때마다 `plugins/orca/.claude-plugin/plugin.json` 과 `.claude-plugin/marketplace.json` 의 `version` 을 올린다(patch). Claude 플러그인 캐시는 버전이 같으면 갱신하지 않는다(실측). `~/.orca-skills` 링크는 마켓 클론이라 `marketplace update` 만으로 최신이다.
