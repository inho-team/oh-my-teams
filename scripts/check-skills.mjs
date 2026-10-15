/** Composes the plugin validator with production adapters and exposes its CLI. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeFiles } from "./adapters/node-files.mjs";
import { createDocumentSyntax } from "./adapters/document-syntax.mjs";
import { validatePlugin as validate } from "./core/plugin-validation.mjs";

const root = fileURLToPath(new URL("../plugins/oh-my-teams/", import.meta.url));

/**
 * Validates a standalone installation with optional boundary adapters.
 * @param {string} [pluginRoot] - Installed plugin directory.
 * @param {object} [options] - Boundary implementations for isolated tests.
 * @param {import('./core/ports.mjs').FilesPort} [options.files] - Filesystem adapter.
 * @param {import('./core/ports.mjs').DocumentSyntaxPort} [options.syntax] - Document parsers.
 * @returns {import('./core/ports.mjs').ValidationReport} Package findings.
 * @throws {Error} For unexpected programming errors.
 */
export function validatePlugin(
  pluginRoot = root,
  { files = createNodeFiles(), syntax = createDocumentSyntax() } = {},
) {
  return validate(pluginRoot, files, syntax);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const report = validatePlugin();
  console.log(JSON.stringify(report, null, 2));
  if (report.findings.length) process.exitCode = 1;
}
