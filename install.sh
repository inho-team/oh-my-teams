#!/bin/sh
# orca-skills 설치 — 이 머신에서 한 번. (1) 마켓 등록·플러그인 설치 (2) non-Claude 에이전트(codex·agy)가 쓰는 고정 경로 ~/.orca-skills 링크
set -eu
MK="$HOME/.claude/plugins/marketplaces/orca-skills"
claude plugin marketplace add inho-team/orca-skills 2>/dev/null || claude plugin marketplace update orca-skills
claude plugin install orca@orca-skills 2>/dev/null || claude plugin update orca@orca-skills
[ -d "$MK/plugins/orca/skills" ] || { echo "🔴 마켓 클론이 없다: $MK"; exit 1; }
ln -sfn "$MK/plugins/orca/skills" "$HOME/.orca-skills"
chmod +x "$MK"/plugins/orca/skills/orca-lead/*.sh "$MK"/plugins/orca/skills/orca-worker/*.sh 2>/dev/null || true
echo "✅ ~/.orca-skills -> $MK/plugins/orca/skills"; ls "$HOME/.orca-skills"
for t in orca gh agy codex python3; do command -v $t >/dev/null || echo "⚠️ $t 없음"; done
