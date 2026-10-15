/** Checks repository guidance with the same parsed link rules as installed documentation. */
import path from "node:path";
import { markdownFiles, pathProblem } from "./plugin-paths.mjs";
import { checkLinks } from "./plugin-documents.mjs";

/**
 * Validates README and documentation trees without following external paths.
 * @param {string} root - Repository root.
 * @param {import('./ports.mjs').FilesPort} files - Filesystem capabilities.
 * @param {import('./ports.mjs').DocumentSyntaxPort} syntax - Markdown parsers.
 * @returns {{status: string, documents: number, findings: string[]}} Documentation findings.
 * @throws {Error} For unexpected implementation failures.
 */
export function inspectRepositoryDocuments(root, files, syntax) {
  const report = { status: "passed", documents: 0, findings: [] };
  try {
    root = files.realPath(root);
    const documents = [];
    for (const relative of ["README.md", "docs", "evals"]) {
      const file = path.join(root, relative);
      const issue = pathProblem(root, file, files, "repository");
      if (issue === "missing" && relative !== "README.md") continue;
      if (issue) {
        report.findings.push(`${relative}: ${issue}`);
        continue;
      }
      if (relative === "README.md") {
        if (files.kind(file) === "file") documents.push(file);
        else report.findings.push("README.md: not a regular file");
      } else if (files.kind(file) === "directory")
        documents.push(...markdownFiles(file, files));
      else report.findings.push(`${relative}: not a directory`);
    }
    report.documents = documents.length;
    const options = {
      boundary: "repository",
      skillRoot: path.join(root, "plugins/oh-my-teams/skills"),
    };
    for (const file of documents)
      checkLinks(root, file, report.findings, files, syntax, options);
  } catch (error) {
    if (typeof error.code !== "string" || typeof error.syscall !== "string")
      throw error;
    report.findings.push(
      `${error.path ?? root}: ${error.code}: ${error.message}`,
    );
  }
  report.status = report.findings.length ? "failed" : "passed";
  return report;
}
