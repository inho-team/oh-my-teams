#!/usr/bin/env node
/** Audits active source documentation and readability conventions. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([
  ".git",
  ".omc",
  ".orca",
  ".omt",
  "legacy",
  "node_modules",
  "results",
]);

/** Find active JavaScript module files below a directory.
 * @param {string} directory root to scan
 * @returns {string[]} module paths
 */
export function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name)
        ? []
        : sourceFiles(path.join(directory, entry.name));
    }
    return entry.name.endsWith(".mjs")
      ? [path.join(directory, entry.name)]
      : [];
  });
}

/** Check whether a module starts with documentation.
 * @param {string[]} lines source lines
 * @returns {boolean} whether module documentation exists
 */
export function moduleHasDocumentation(lines) {
  const firstCode = lines.findIndex(
    (line, index) => line.trim() && !(index === 0 && line.startsWith("#!")),
  );
  return firstCode >= 0 && lines[firstCode].trim().startsWith("/**");
}

/** Read the JSDoc immediately preceding an export.
 * @param {string[]} lines source lines
 * @param {number} exportLine zero-based export line
 * @returns {string|null} documentation text when present
 */
export function precedingJsdoc(lines, exportLine) {
  let cursor = exportLine - 1;
  while (cursor >= 0 && !lines[cursor].trim()) cursor -= 1;
  if (cursor < 0 || !lines[cursor].trim().endsWith("*/")) return null;
  const end = cursor;
  while (cursor >= 0 && !lines[cursor].includes("/**")) cursor -= 1;
  return cursor >= 0 ? lines.slice(cursor, end + 1).join("\n") : null;
}

/** Collect an exported function declaration through its parameter list.
 * @param {string[]} lines source lines
 * @param {number} start zero-based declaration line
 * @returns {string} declaration text
 */
export function functionSignature(lines, start) {
  let signature = "";
  let depth = 0;
  let sawOpen = false;
  const mayBeArrow = /^\s*export\s+(?:async\s+)?const\b/.test(lines[start]);
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    signature += `${line}\n`;
    for (const character of line) {
      if (character === "(") {
        depth += 1;
        sawOpen = true;
      } else if (character === ")" && depth > 0) depth -= 1;
    }
    if (signature.includes("=>")) break;
    if (mayBeArrow && line.includes(";") && !signature.includes("=>")) break;
    if (sawOpen && depth === 0 && (!mayBeArrow || signature.includes("=>")))
      break;
  }
  return signature;
}

/** Determine whether a declaration has a non-empty parameter list.
 * @param {string} signature declaration text
 * @returns {boolean} whether parameters are declared
 */
export function signatureHasParameters(signature) {
  const open = signature.indexOf("(");
  const close = signature.lastIndexOf(")");
  if (open >= 0 && close > open)
    return Boolean(signature.slice(open + 1, close).trim());
  // Arrow functions may omit parentheses (including destructuring).
  const arrow = signature.indexOf("=>");
  if (arrow < 0) return false;
  const before = signature
    .slice(0, arrow)
    .replace(/^[\s\S]*?=/, "")
    .trim();
  return Boolean(before.replace(/^async\s+/, "").trim());
}

const REGEX_CAN_FOLLOW = /[A-Za-z0-9_$)\]]/;

/** Mark which lines begin inside template text rather than in code.
 *
 * Counting backtick parity cannot answer this: backticks also occur in regular
 * expressions, comments and quoted strings, and one such backtick inverts the
 * parity for the rest of the file, silently exempting everything after it. This
 * scanner tracks the lexical mode instead, and treats a `${...}` substitution as
 * code so that a long expression inside a template is still audited.
 *
 * @param {string[]} lines source lines
 * @returns {boolean[]} whether each line begins inside template text
 */
export function templateLineStarts(lines) {
  const starts = new Array(lines.length);
  const suspended = [];
  let mode = "code";
  let previous = "";

  for (let index = 0; index < lines.length; index += 1) {
    starts[index] = mode === "template";
    const line = lines[index];
    for (let at = 0; at < line.length; at += 1) {
      const char = line[at];
      const next = line[at + 1];
      if (mode === "block-comment") {
        if (char === "*" && next === "/") {
          mode = "code";
          at += 1;
        }
      } else if (mode !== "code" && char === "\\") {
        at += 1;
      } else if (mode === "single") {
        if (char === "'") mode = "code";
      } else if (mode === "double") {
        if (char === '"') mode = "code";
      } else if (mode === "class") {
        if (char === "]") mode = "regex";
      } else if (mode === "regex") {
        if (char === "[") mode = "class";
        else if (char === "/") mode = "code";
      } else if (mode === "template") {
        if (char === "`") mode = "code";
        else if (char === "$" && next === "{") {
          suspended.push("template");
          mode = "code";
          at += 1;
        }
      } else if (char === "/" && next === "/") {
        break;
      } else if (char === "/" && next === "*") {
        mode = "block-comment";
        at += 1;
      } else if (char === "'") mode = "single";
      else if (char === '"') mode = "double";
      else if (char === "`") mode = "template";
      else if (char === "}" && suspended.length > 0) mode = suspended.pop();
      else if (char === "/" && !REGEX_CAN_FOLLOW.test(previous)) mode = "regex";
      else if (char.trim()) previous = char;
    }
  }
  return starts;
}

/** Find executable lines exceeding the readability limit.
 * @param {string[]} lines source lines
 * @returns {{line:number,length:number}[]} long line locations
 */
export function longExecutableLines(lines) {
  const templateStarts = templateLineStarts(lines);
  return lines.flatMap((line, index) => {
    const startsInsideTemplate = templateStarts[index];
    if (line.length <= 180) return [];
    const trimmed = line.trim();
    // Long prompt/test literals are task data; long executable statements are not.
    // Only continuation lines wholly inside a template are data. A long
    // executable statement that opens/closes a template must still be found.
    const closing = startsInsideTemplate && line.search(/(?<!\\)`/);
    if (
      startsInsideTemplate &&
      (closing < 0 || !line.slice(closing + 1).trim())
    ) {
      return [];
    }
    return [{ line: index + 1, length: line.length }];
  });
}

/** Audit one module for documentation and readability findings.
 * @param {string} file module path
 * @param {string} auditRoot report path base
 * @returns {object} audit report
 */
export function auditFile(file, auditRoot = root) {
  const relative = path.relative(auditRoot, file);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const findings = [];
  const moduleDocumented = moduleHasDocumentation(lines);
  if (!moduleDocumented) findings.push("missing module JSDoc");

  let publicExports = 0;
  let documentedExports = 0;
  let parameterTags = 0;
  let returnTags = 0;
  let throwsTags = 0;
  const templateStarts = templateLineStarts(lines);
  for (let index = 0; index < lines.length; index += 1) {
    // Export-looking text in a prompt/template fixture is not a declaration.
    if (templateStarts[index]) continue;
    const match = lines[index].match(
      /^export\s+(?:async\s+)?(function|const|class)\s+([A-Za-z0-9_]+)/,
    );
    if (!match) continue;
    publicExports += 1;
    const documentation = precedingJsdoc(lines, index);
    if (!documentation) {
      findings.push(`line ${index + 1}: undocumented export ${match[2]}`);
      continue;
    }
    documentedExports += 1;
    if (documentation.includes("@throws")) throwsTags += 1;
    const signature = functionSignature(lines, index);
    // An arrow nested inside an exported object/map is not the export's API.
    const isArrow =
      match[1] === "const" &&
      /^export\s+const\s+\w+\s*=\s*(?:async\s+)?(?:\([^]*?\)|[A-Za-z_$][\w$]*)\s*=>/.test(
        signature,
      );
    if (match[1] !== "function" && !isArrow) continue;
    if (signatureHasParameters(signature)) {
      if (documentation.includes("@param")) parameterTags += 1;
      else findings.push(`line ${index + 1}: ${match[2]} lacks @param`);
    }
    if (documentation.includes("@returns")) returnTags += 1;
    else findings.push(`line ${index + 1}: ${match[2]} lacks @returns`);
  }

  for (const longLine of longExecutableLines(lines)) {
    findings.push(
      `line ${longLine.line}: executable line is ${longLine.length} characters`,
    );
  }
  return {
    file: relative,
    moduleDocumented,
    publicExports,
    documentedExports,
    parameterTags,
    returnTags,
    throwsTags,
    findings,
  };
}

/** Audit all active modules under a directory.
 * @param {string} auditRoot directory to scan
 * @returns {object} aggregate audit output
 */
export function auditDirectory(auditRoot = root) {
  const reports = sourceFiles(auditRoot)
    .sort()
    .map((file) => auditFile(file, auditRoot));
  const totals = reports.reduce(
    (summary, report) => {
      summary.files += 1;
      summary.moduleDocumented += Number(report.moduleDocumented);
      summary.publicExports += report.publicExports;
      summary.documentedExports += report.documentedExports;
      summary.parameterTags += report.parameterTags;
      summary.returnTags += report.returnTags;
      summary.throwsTags += report.throwsTags;
      summary.findings += report.findings.length;
      return summary;
    },
    {
      files: 0,
      moduleDocumented: 0,
      publicExports: 0,
      documentedExports: 0,
      parameterTags: 0,
      returnTags: 0,
      throwsTags: 0,
      findings: 0,
    },
  );
  return {
    status: totals.findings === 0 ? "passed" : "failed",
    scope: "active .mjs files excluding legacy and generated/local state",
    totals,
    files: reports,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const output = auditDirectory();
  console.log(JSON.stringify(output, null, 2));
  if (output.status !== "passed") process.exitCode = 1;
}
