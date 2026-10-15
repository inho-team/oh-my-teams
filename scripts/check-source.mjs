/** Composes source documentation and architecture checks with parsing and filesystem adapters. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeFiles } from "./adapters/node-files.mjs";
import { parseModule } from "./adapters/javascript-syntax.mjs";
import { inspectSources } from "./core/source-quality.mjs";

const ignored = new Set([".git", "node_modules", ".omt", ".omc", ".orca"]);

function modulesIn(directory, files) {
  return files.entries(directory).flatMap((entry) => {
    if (ignored.has(entry.name)) return [];
    const file = path.join(directory, entry.name);
    if (entry.kind === "directory") return modulesIn(file, files);
    return entry.kind === "file" && file.endsWith(".mjs") ? [file] : [];
  });
}

/**
 * Checks active source files, including newly added modules before a commit.
 * @param {string} [root] - Repository root.
 * @param {object} [options] - Filesystem and JavaScript parser boundaries.
 * @param {import('./core/ports.mjs').FilesPort} [options.files] - Filesystem adapter.
 * @param {import('./core/ports.mjs').JavaScriptParser} [options.parse] - JavaScript parser.
 * @returns {{status: string, modules: number, findings: string[]}} Source check report.
 */
export function validateSources(
  root = fileURLToPath(new URL("../", import.meta.url)),
  { files = createNodeFiles(), parse = parseModule } = {},
) {
  const findings = [];
  const modules = [];
  for (const file of modulesIn(root, files)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const source = files.readText(file);
    try {
      modules.push({ file: relative, source, ...parse(source) });
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      findings.push(`${relative}: invalid JavaScript: ${error.message}`);
    }
  }
  findings.push(...inspectSources(modules));
  return {
    status: findings.length ? "failed" : "passed",
    modules: modules.length,
    findings,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const report = validateSources();
  console.log(JSON.stringify(report, null, 2));
  if (report.findings.length) process.exitCode = 1;
}
