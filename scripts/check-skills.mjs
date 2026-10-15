/** Validates skills and documentation without relying on files outside the plugin. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markdownDestinations, skillMetadata } from "./plugin-syntax.mjs";

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

function pathProblem(pluginRoot, file) {
  if (!isWithin(pluginRoot, file)) return "outside plugin";
  try {
    fs.statSync(file);
    return isWithin(pluginRoot, fs.realpathSync(file))
      ? null
      : "outside plugin";
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return "missing";
    throw error;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.syscall) error.path ??= file;
    throw error;
  }
}

function checkManifests(pluginRoot, skillRoot, findings) {
  for (const host of ["claude", "codex"]) {
    const label = `.${host}-plugin/plugin.json`;
    try {
      const file = path.join(pluginRoot, label);
      const problem = pathProblem(pluginRoot, file);
      if (problem) throw new Error(`manifest ${problem}`);
      const manifest = JSON.parse(readText(file));
      if (manifest?.name !== "oh-my-teams")
        throw new Error("name must be oh-my-teams");
      if (typeof manifest.version !== "string" || !manifest.version.trim()) {
        throw new Error("version must be a nonempty string");
      }
      if (host === "claude" && manifest.skills === undefined) continue;
      const paths =
        host === "claude" && Array.isArray(manifest.skills)
          ? manifest.skills
          : [manifest.skills];
      for (const target of paths) {
        if (typeof target !== "string" || !target.startsWith("./")) {
          throw new Error(
            "skills must use plugin-relative directory paths starting with ./",
          );
        }
        const resolved = path.resolve(pluginRoot, target);
        const issue = pathProblem(pluginRoot, resolved);
        if (issue) throw new Error(`skills path ${issue}: ${target}`);
        if (!fs.statSync(resolved).isDirectory())
          throw new Error(`skills path is not a directory: ${target}`);
        if (fs.realpathSync(resolved) !== fs.realpathSync(skillRoot)) {
          throw new Error(
            "skills path must point to the bundled skills directory",
          );
        }
      }
    } catch (error) {
      findings.push(`${label}: ${error.message}`);
    }
  }
}

function checkLinks(pluginRoot, file, findings) {
  const label = path.relative(pluginRoot, file);
  const frontmatter =
    path.basename(file) === "SKILL.md" &&
    path.dirname(path.dirname(file)) === path.join(pluginRoot, "skills");
  for (const destination of markdownDestinations(readText(file), {
    frontmatter,
  })) {
    if (
      /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(destination) &&
      !/^file:|^[a-z]:[/\\]/i.test(destination)
    )
      continue;
    let target;
    try {
      target = decodeURIComponent(destination.split(/[?#]/)[0]);
    } catch {
      findings.push(`${label}: invalid link encoding ${destination}`);
      continue;
    }
    if (!target) continue;
    const resolved = path.resolve(path.dirname(file), target);
    const issue =
      /^file:/i.test(target) || path.win32.isAbsolute(target)
        ? "outside plugin"
        : pathProblem(pluginRoot, resolved);
    if (issue) {
      const kind = issue === "missing" ? "broken link" : "link outside plugin";
      findings.push(`${label}: ${kind} ${target}`);
    }
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
