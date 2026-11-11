/** Composes the skill reading measurement with production adapters and exposes its CLI. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeFiles } from "./adapters/node-files.mjs";
import { createDocumentSyntax } from "./adapters/document-syntax.mjs";
import { budgetFindings, measureReading } from "./core/reading-budget.mjs";

const root = fileURLToPath(new URL("../plugins/oh-my-teams/", import.meta.url));
const budgetFile = fileURLToPath(
  new URL("./reading-budget.json", import.meta.url),
);

function readCeilings(file, files) {
  const budget = JSON.parse(files.readText(file));
  const ceilings = budget?.skills;
  if (!ceilings || typeof ceilings !== "object" || Array.isArray(ceilings))
    throw new TypeError(`${file}: skills must map skill names to ceilings`);
  return ceilings;
}

/**
 * Measures each skill with its directly linked files and checks the repository ceilings.
 * @param {string} [pluginRoot] - Installed plugin directory.
 * @param {object} [options] - Boundary implementations and ceilings for isolated tests.
 * @param {import('./core/ports.mjs').FilesPort} [options.files] - Filesystem adapter.
 * @param {import('./core/ports.mjs').DocumentSyntaxPort} [options.syntax] - Document parsers.
 * @param {Object<string, number>} [options.ceilings] - Maximum characters per skill; defaults to reading-budget.json.
 * @returns {{status: 'passed'|'failed', unit: string, skills: object[], findings: string[]}} Measurements and findings.
 * @throws {Error} For unreadable plugin files or an invalid budget file.
 */
export function validateReading(
  pluginRoot = root,
  { files = createNodeFiles(), syntax = createDocumentSyntax(), ceilings } = {},
) {
  const limits = ceilings ?? readCeilings(budgetFile, files);
  const skills = measureReading(pluginRoot, files, syntax).map((item) => ({
    ...item,
    ceiling: limits[item.skill] ?? null,
  }));
  const findings = budgetFindings(skills, limits);
  return {
    status: findings.length ? "failed" : "passed",
    unit: "unicode-code-points",
    skills,
    findings,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const report = validateReading();
  // The per-file breakdown is long, so the default output keeps one line of numbers per skill.
  if (!process.argv.includes("--files")) {
    report.skills = report.skills.map(({ documents, ...summary }) => ({
      ...summary,
      files: documents.length,
    }));
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.findings.length) process.exitCode = 1;
}
