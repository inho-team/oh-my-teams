/** Composes repository documentation checks with filesystem and Markdown adapters. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeFiles } from "./adapters/node-files.mjs";
import { createDocumentSyntax } from "./adapters/document-syntax.mjs";
import { inspectRepositoryDocuments } from "./core/repository-documents.mjs";

/**
 * Checks repository README, docs and eval documentation links and anchors.
 * @param {string} [root] - Checkout root.
 * @param {object} [options] - Boundary adapters.
 * @param {import('./core/ports.mjs').FilesPort} [options.files] - Filesystem adapter.
 * @param {import('./core/ports.mjs').DocumentSyntaxPort} [options.syntax] - Markdown parsers.
 * @returns {{status: string, documents: number, findings: string[]}} Documentation report.
 */
export function validateRepositoryDocs(
  root = fileURLToPath(new URL("../", import.meta.url)),
  { files = createNodeFiles(), syntax = createDocumentSyntax() } = {},
) {
  return inspectRepositoryDocuments(root, files, syntax);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const report = validateRepositoryDocs();
  console.log(JSON.stringify(report, null, 2));
  if (report.findings.length) process.exitCode = 1;
}
