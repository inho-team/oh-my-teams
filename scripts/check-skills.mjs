/** Validates skills and documentation without relying on files outside the plugin. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

function isWithin(directory, file) {
  const relative = path.relative(directory, file);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) return markdownFiles(file);
    return item.isFile() && item.name.endsWith(".md") ? [file] : [];
  });
}

/**
 * Checks the installable plugin, including links in bundled reference documents.
 *
 * @param {string} [pluginRoot] - Plugin directory, independent of a repository checkout.
 * @returns {{status: string, skills: number, findings: string[]}} Validation report.
 */
export function validatePlugin(
  pluginRoot = path.join(root, "plugins/oh-my-teams"),
) {
  pluginRoot = fs.realpathSync(pluginRoot);
  const findings = [];
  const skillRoot = path.join(pluginRoot, "skills");
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
    const source = fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/);
    if (!frontmatter) findings.push(`${skill}: frontmatter missing`);
    if (!frontmatter?.[1].split("\n").includes(`name: ${skill}`)) {
      findings.push(`${skill}: frontmatter name mismatch`);
    }
    if (!/^description: .+/m.test(frontmatter?.[1] ?? "")) {
      findings.push(`${skill}: description missing`);
    }
    if (forbidden.test(source)) {
      findings.push(`${skill}: removed runtime command referenced`);
    }
  }

  for (const file of markdownFiles(pluginRoot)) {
    const label = path.relative(pluginRoot, file);
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      const resolved = path.resolve(path.dirname(file), target);
      if (!isWithin(pluginRoot, resolved)) {
        findings.push(`${label}: link outside plugin ${target}`);
      } else if (!fs.existsSync(resolved)) {
        findings.push(`${label}: broken link ${target}`);
      } else if (!isWithin(pluginRoot, fs.realpathSync(resolved))) {
        findings.push(`${label}: link outside plugin ${target}`);
      }
    }
  }

  return {
    status: findings.length ? "failed" : "passed",
    skills: installed.length,
    findings,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const report = validatePlugin();
  console.log(JSON.stringify(report, null, 2));
  if (report.findings.length) process.exitCode = 1;
}
