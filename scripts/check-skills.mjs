/** Validates skills and documentation without relying on files outside the plugin. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { skillMetadata } from "./plugin-syntax.mjs";
import { markdownFiles, pathProblem, readText } from "./plugin-files.mjs";
import { checkLinks, checkManifests } from "./plugin-documents.mjs";

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

function checkSkill(file, skill, findings) {
  const source = readText(file);
  try {
    const metadata = skillMetadata(source);
    if (metadata.name !== skill)
      findings.push(`${skill}: frontmatter name mismatch`);
    if (
      typeof metadata.description !== "string" ||
      !metadata.description.trim()
    ) {
      findings.push(`${skill}: description must be a nonempty string`);
    }
  } catch (error) {
    findings.push(`${skill}: invalid YAML: ${error.message}`);
  }
  if (forbidden.test(source)) {
    findings.push(`${skill}: removed runtime command referenced`);
  }
}

function inspectPlugin(pluginRoot, report) {
  pluginRoot = fs.realpathSync(pluginRoot);
  const { findings } = report;
  if (!fs.statSync(pluginRoot).isDirectory()) {
    findings.push(`${pluginRoot}: plugin root is not a directory`);
    return;
  }
  const skillRoot = path.join(pluginRoot, "skills");
  if (
    pathProblem(pluginRoot, skillRoot) ||
    !fs.statSync(skillRoot).isDirectory()
  ) {
    findings.push(
      `${skillRoot}: bundled skills directory missing, outside plugin, or not a directory`,
    );
    return;
  }
  checkManifests(pluginRoot, skillRoot, findings);
  const installed = fs
    .readdirSync(skillRoot, { withFileTypes: true })
    .filter((item) => item.isDirectory() && !item.name.startsWith("."))
    .map((item) => item.name)
    .sort();
  report.skills = installed.length;

  if (JSON.stringify(installed) !== JSON.stringify([...expected].sort())) {
    findings.push(`Skill set differs: ${installed.join(", ")}`);
  }

  for (const skill of installed) {
    const file = path.join(skillRoot, skill, "SKILL.md");
    const issue = pathProblem(pluginRoot, file);
    if (issue) {
      findings.push(`${skill}: SKILL.md ${issue}`);
      continue;
    }
    if (!fs.statSync(file).isFile()) {
      findings.push(`${file}: SKILL.md is not a regular file`);
      continue;
    }
    checkSkill(file, skill, findings);
  }

  for (const file of markdownFiles(pluginRoot)) {
    checkLinks(pluginRoot, file, findings);
  }
}

/**
 * Checks an installable plugin and reports filesystem failures with their paths.
 *
 * @param {string} [pluginRoot] - Plugin directory, independent of a repository checkout.
 * @returns {{status: string, skills: number, findings: string[]}} Validation report.
 * @throws {Error} For unexpected errors unrelated to filesystem operations.
 */
export function validatePlugin(
  pluginRoot = path.join(root, "plugins/oh-my-teams"),
) {
  const report = { status: "passed", skills: 0, findings: [] };
  try {
    inspectPlugin(pluginRoot, report);
  } catch (error) {
    if (typeof error.code !== "string" || typeof error.syscall !== "string")
      throw error;
    report.findings.push(
      `${error.path ?? pluginRoot}: ${error.code}: ${error.message}`,
    );
  }
  report.status = report.findings.length ? "failed" : "passed";
  return report;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const report = validatePlugin();
  console.log(JSON.stringify(report, null, 2));
  if (report.findings.length) process.exitCode = 1;
}
