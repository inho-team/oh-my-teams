/** Validates host entry points and local Markdown links. */
import path from "node:path";
import { pathProblem } from "./plugin-paths.mjs";

function isSkillDocument(file, skillRoot) {
  return (
    path.basename(file) === "SKILL.md" &&
    path.dirname(path.dirname(file)) === skillRoot
  );
}

function manifestProblem(manifest, host, pluginRoot, skillRoot, files) {
  if (manifest?.name !== "oh-my-teams") return "name must be oh-my-teams";
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    return "version must be a nonempty string";
  }
  if (host === "claude" && manifest.skills === undefined) return null;
  const paths =
    host === "claude" && Array.isArray(manifest.skills)
      ? manifest.skills
      : [manifest.skills];
  if (!paths.length) return "skills must include the bundled skills directory";
  for (const target of paths) {
    if (typeof target !== "string" || !target.startsWith("./")) {
      return "skills must use plugin-relative directory paths starting with ./";
    }
    const resolved = path.resolve(pluginRoot, target);
    const issue = pathProblem(pluginRoot, resolved, files);
    if (issue) return `skills path ${issue}: ${target}`;
    if (files.kind(resolved) !== "directory")
      return `skills path is not a directory: ${target}`;
    if (files.realPath(resolved) !== files.realPath(skillRoot)) {
      return "skills path must point to the bundled skills directory";
    }
  }
  return null;
}

/**
 * Checks manifest syntax and entry points without hiding programming errors.
 * @param {string} pluginRoot - Canonical plugin root.
 * @param {string} skillRoot - Bundled skills directory.
 * @param {string[]} findings - Accumulated validation failures.
 * @param {import("./ports.mjs").FilesPort} files - Filesystem capabilities.
 * @returns {void} Appends manifest failures.
 */
export function checkManifests(pluginRoot, skillRoot, findings, files) {
  for (const host of ["claude", "codex"]) {
    const label = `.${host}-plugin/plugin.json`;
    const file = path.join(pluginRoot, label);
    const problem = pathProblem(pluginRoot, file, files);
    if (problem) {
      findings.push(`${label}: manifest ${problem}`);
      continue;
    }
    const source = files.readText(file);
    let manifest;
    try {
      manifest = JSON.parse(source);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      findings.push(`${label}: ${error.message}`);
      continue;
    }
    const issue = manifestProblem(manifest, host, pluginRoot, skillRoot, files);
    if (issue) findings.push(`${label}: ${issue}`);
  }
}

/**
 * Reports missing and external local Markdown destinations.
 * @param {string} pluginRoot - Canonical plugin root.
 * @param {string} file - Markdown file inside the plugin.
 * @param {string[]} findings - Accumulated validation failures.
 * @param {import("./ports.mjs").FilesPort} files - Filesystem capabilities.
 * @param {import("./ports.mjs").DocumentSyntaxPort} syntax - Document parsers.
 * @param {object} [options] - Containment and skill document context.
 * @param {string} [options.boundary='plugin'] - Containing root label for diagnostics.
 * @param {string} [options.skillRoot] - Exact skill directory whose YAML is excluded.
 * @returns {void} Appends link failures.
 */
export function checkLinks(
  pluginRoot,
  file,
  findings,
  files,
  syntax,
  { boundary = "plugin", skillRoot = path.join(pluginRoot, "skills") } = {},
) {
  const label = path.relative(pluginRoot, file);
  // A leading horizontal rule in an ordinary reference must not hide its links.
  const frontmatter = isSkillDocument(file, skillRoot);
  for (const destination of syntax.markdownDestinations(files.readText(file), {
    frontmatter,
  })) {
    if (
      /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(destination) &&
      !/^file:|^[a-z]:[/\\]/i.test(destination)
    )
      continue;
    let target;
    let anchor;
    try {
      target = decodeURIComponent(destination.split(/[?#]/)[0]);
      anchor = decodeURIComponent(
        destination.includes("#")
          ? destination.slice(destination.indexOf("#") + 1)
          : "",
      );
    } catch {
      findings.push(`${label}: invalid link encoding ${destination}`);
      continue;
    }
    const resolved = target ? path.resolve(path.dirname(file), target) : file;
    const issue =
      /^file:/i.test(target) || path.win32.isAbsolute(target)
        ? `outside ${boundary}`
        : pathProblem(pluginRoot, resolved, files, boundary);
    if (issue) {
      const kind =
        issue === "missing" ? "broken link" : `link outside ${boundary}`;
      findings.push(`${label}: ${kind} ${target}`);
    } else if (
      anchor &&
      /\.md$/i.test(resolved) &&
      files.kind(resolved) === "file"
    ) {
      const anchors = syntax.markdownAnchors(files.readText(resolved), {
        frontmatter: isSkillDocument(resolved, skillRoot),
      });
      if (!anchors.includes(anchor))
        findings.push(`${label}: broken anchor ${destination}`);
    }
  }
}
