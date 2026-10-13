/** Validates the active skill package and its local documentation links. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = path.join(root, "plugins/oh-my-teams/skills");
const expected = [
  "kickoff",
  "consult",
  "status",
  "close",
  "disband",
  "help",
  "fluent-korean",
];
const forbidden =
  /teams-org\.mjs|role-worktree-create|worker-start|kickoff-claim|\.omt\/organization\.json/;
const findings = [];
const installed = fs
  .readdirSync(skillRoot, { withFileTypes: true })
  .filter((item) => item.isDirectory() && !item.name.startsWith("."))
  .map((item) => item.name)
  .sort();

if (JSON.stringify(installed) !== JSON.stringify([...expected].sort())) {
  findings.push(`Skill set differs: ${installed.join(", ")}`);
}

for (const skill of installed) {
  const file = path.join(skillRoot, skill, "SKILL.md");
  if (!fs.existsSync(file)) {
    findings.push(`${skill}: SKILL.md missing`);
    continue;
  }
  const source = fs.readFileSync(file, "utf8");
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatter) findings.push(`${skill}: frontmatter missing`);
  if (!frontmatter?.[1].split("\n").includes(`name: ${skill}`)) {
    findings.push(`${skill}: frontmatter name mismatch`);
  }
  if (!/^description: .+/m.test(frontmatter?.[1] ?? "")) {
    findings.push(`${skill}: description missing`);
  }
  if (forbidden.test(source))
    findings.push(`${skill}: removed runtime command referenced`);
  for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    if (!fs.existsSync(path.resolve(path.dirname(file), target))) {
      findings.push(`${skill}: broken link ${target}`);
    }
  }
}

console.log(
  JSON.stringify(
    {
      status: findings.length ? "failed" : "passed",
      skills: installed.length,
      findings,
    },
    null,
    2,
  ),
);
if (findings.length) process.exitCode = 1;
