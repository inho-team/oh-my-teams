/** Converts OMT YAML messages into validated JSON or standalone HTML. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseOmtYaml,
  documentSchemaErrors,
  readDocument,
  writeDocument,
} from "./adapters/omt-documents.mjs";
import {
  assertOmtDocument,
  assertReviewResponse,
  assertTaskResponse,
  renderOmtHtml,
} from "./core/omt-documents.mjs";

/**
 * Parses one OMT message into the validated object used by application code.
 * @param {string} source - OMT YAML document.
 * @param {object} [options] - Optional correlation context.
 * @param {string} [options.requestSource] - Original request YAML for a review result.
 * @param {string} [options.taskSource] - Original task YAML for a lifecycle report.
 * @returns {object} Validated JSON-compatible data without a serialization round trip.
 */
export function parseOmtDocument(source, { requestSource, taskSource } = {}) {
  if (requestSource !== undefined && taskSource !== undefined)
    throw new SyntaxError("choose either requestSource or taskSource");
  const value = assertOmtDocument(parseOmtYaml(source), documentSchemaErrors);
  if (requestSource !== undefined) {
    const request = assertOmtDocument(
      parseOmtYaml(requestSource),
      documentSchemaErrors,
    );
    assertReviewResponse(request, value);
  }
  if (taskSource !== undefined) {
    const task = assertOmtDocument(
      parseOmtYaml(taskSource),
      documentSchemaErrors,
    );
    assertTaskResponse(task, value);
  }
  return value;
}

/**
 * Converts one restricted YAML message after structural and semantic validation.
 * @param {string} source - OMT YAML document.
 * @param {'json'|'html'|'check'} format - Output representation; check emits only a validation receipt.
 * @param {object} [options] - Optional requestSource or taskSource correlation context.
 * @returns {string} Generated representation with a trailing newline.
 */
export function convertDocument(source, format = "json", options = {}) {
  if (!["json", "html", "check"].includes(format))
    throw new SyntaxError("format must be json, html, or check");
  const value = parseOmtDocument(source, options);
  if (format === "html") return renderOmtHtml(value);
  if (format === "check")
    return `${JSON.stringify({ status: "passed", kind: value.kind, id: value.id })}\n`;
  return `${JSON.stringify(value, null, 2)}\n`;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [format, input, ...args] = process.argv.slice(2);
    const output =
      args.length && !args[0].startsWith("--") ? args.shift() : undefined;
    const contextFile =
      args.length === 2 && ["--request", "--task"].includes(args[0])
        ? args[1]
        : undefined;
    if (
      !format ||
      !input ||
      (args.length && !contextFile) ||
      (format === "check" && output) ||
      contextFile === "-"
    ) {
      throw new SyntaxError(
        "usage: node scripts/documents.mjs <check|json|html> <input.yaml|-> [new-output-file] [--request request.yaml | --task task.yaml]",
      );
    }
    const options = contextFile
      ? {
          [args[0] === "--task" ? "taskSource" : "requestSource"]:
            readDocument(contextFile),
        }
      : {};
    writeDocument(
      output,
      convertDocument(readDocument(input), format, options),
    );
  } catch (error) {
    console.error(`OMT document: ${error.message}`);
    process.exitCode = 1;
  }
}
