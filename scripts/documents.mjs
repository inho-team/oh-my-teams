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
  renderOmtHtml,
} from "./core/omt-documents.mjs";

/**
 * Parses one OMT message into the validated object used by application code.
 * @param {string} source - OMT YAML document.
 * @param {object} [options] - Optional correlation context.
 * @param {string} [options.requestSource] - Original request YAML for a review result.
 * @returns {object} Validated JSON-compatible data without a serialization round trip.
 */
export function parseOmtDocument(source, { requestSource } = {}) {
  const value = assertOmtDocument(parseOmtYaml(source), documentSchemaErrors);
  if (requestSource !== undefined) {
    const request = assertOmtDocument(
      parseOmtYaml(requestSource),
      documentSchemaErrors,
    );
    assertReviewResponse(request, value);
  }
  return value;
}

/**
 * Converts one restricted YAML message after structural and semantic validation.
 * @param {string} source - OMT YAML document.
 * @param {'json'|'html'|'check'} format - Output representation; check emits only a validation receipt.
 * @param {object} [options] - Optional requestSource correlation context.
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
    const requestFile =
      args.length === 2 && args[0] === "--request" ? args[1] : undefined;
    if (
      !format ||
      !input ||
      (args.length && !requestFile) ||
      (format === "check" && output) ||
      requestFile === "-"
    ) {
      throw new SyntaxError(
        "usage: node scripts/documents.mjs <check|json|html> <input.yaml|-> [new-output-file] [--request request.yaml]",
      );
    }
    const requestSource = requestFile ? readDocument(requestFile) : undefined;
    writeDocument(
      output,
      convertDocument(readDocument(input), format, { requestSource }),
    );
  } catch (error) {
    console.error(`OMT document: ${error.message}`);
    process.exitCode = 1;
  }
}
