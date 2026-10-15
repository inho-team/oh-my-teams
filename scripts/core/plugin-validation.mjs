/** Validates skills and documentation without relying on files outside the plugin. */
import path from "node:path";
import { markdownFiles, pathProblem } from "./plugin-paths.mjs";
import { checkLinks, checkManifests } from "./plugin-documents.mjs";

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

function checkSkill(file, skill, findings, files, syntax) {
  const source = files.readText(file);
  try {
    const metadata = syntax.skillMetadata(source);
    if (metadata.name !== skill)
      findings.push(`${skill}: frontmatter name mismatch`);
    if (
      typeof metadata.description !== "string" ||
      !metadata.description.trim()
    ) {
      findings.push(`${skill}: description must be a nonempty string`);
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    findings.push(`${skill}: invalid YAML: ${error.message}`);
  }
}

function inspectPlugin(pluginRoot, report, files, syntax) {
  pluginRoot = files.realPath(pluginRoot);
  const { findings } = report;
  if (files.kind(pluginRoot) !== "directory") {
    findings.push(`${pluginRoot}: plugin root is not a directory`);
    return;
  }
  const skillRoot = path.join(pluginRoot, "skills");
  if (
    pathProblem(pluginRoot, skillRoot, files) ||
    files.kind(skillRoot) !== "directory"
  ) {
    findings.push(
      `${skillRoot}: bundled skills directory missing, outside plugin, or not a directory`,
    );
    return;
  }
  checkManifests(pluginRoot, skillRoot, findings, files);
  const installed = files
    .entries(skillRoot)
    .filter((item) => item.kind === "directory" && !item.name.startsWith("."))
    .map((item) => item.name)
    .sort();
  report.skills = installed.length;

  if (JSON.stringify(installed) !== JSON.stringify([...expected].sort())) {
    findings.push(`Skill set differs: ${installed.join(", ")}`);
  }

  for (const skill of installed) {
    const file = path.join(skillRoot, skill, "SKILL.md");
    const issue = pathProblem(pluginRoot, file, files);
    if (issue) {
      findings.push(`${skill}: SKILL.md ${issue}`);
      continue;
    }
    if (files.kind(file) !== "file") {
      findings.push(`${file}: SKILL.md is not a regular file`);
      continue;
    }
    checkSkill(file, skill, findings, files, syntax);
  }

  for (const file of markdownFiles(pluginRoot, files)) {
    if (forbidden.test(files.readText(file))) {
      findings.push(
        `${path.relative(pluginRoot, file)}: removed runtime command referenced`,
      );
    }
    checkLinks(pluginRoot, file, findings, files, syntax);
  }
}

/**
 * Checks an installable plugin and reports filesystem failures with their paths.
 *
 * @param {string} pluginRoot - Plugin directory, independent of a repository checkout.
 * @param {import('./ports.mjs').FilesPort} files - Filesystem capabilities.
 * @param {import('./ports.mjs').DocumentSyntaxPort} syntax - Document parsers.
 * @returns {import('./ports.mjs').ValidationReport} Validation report.
 * @throws {Error} For unexpected errors unrelated to filesystem operations.
 */
export function validatePlugin(pluginRoot, files, syntax) {
  const report = { status: "passed", skills: 0, findings: [] };
  try {
    inspectPlugin(pluginRoot, report, files, syntax);
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
