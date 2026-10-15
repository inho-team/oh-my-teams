/** Parses restricted YAML, validates JSON Schema, and handles document CLI I/O. */
import fs from "node:fs";
import { parseDocument, visit, isAlias, isMap, isScalar } from "yaml";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const schemaUrl = new URL(
  "../../plugins/oh-my-teams/references/documents/document.schema.json",
  import.meta.url,
);
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(fs.readFileSync(schemaUrl, "utf8")));

function checkValue(value, depth = 0) {
  if (depth > 40) throw new SyntaxError("document nesting exceeds 40 levels");
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value)))
  ) {
    throw new SyntaxError(
      "numbers must be finite and integers must be safe JSON numbers",
    );
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) checkValue(child, depth + 1);
  }
}

/**
 * Parses one YAML 1.2 document restricted to JSON-compatible values.
 * @param {string} source - YAML message text, up to one million UTF-16 code units.
 * @returns {object} Parsed mapping without aliases, explicit tags, or lossy numeric values.
 */
export function parseOmtYaml(source) {
  if (source.length > 1_000_000)
    throw new SyntaxError("document exceeds one million characters");
  const document = parseDocument(source, {
    version: "1.2",
    uniqueKeys: true,
    prettyErrors: true,
  });
  const problems = [...document.errors, ...document.warnings];
  if (problems.length)
    throw new SyntaxError(problems.map((item) => item.message).join("; "));
  if (document.directives.yaml.version !== "1.2")
    throw new SyntaxError("only YAML 1.2 is supported");
  visit(document, {
    Node(key, node, ancestors) {
      if (ancestors.length > 80)
        throw new SyntaxError("document nesting exceeds 40 levels");
      if (isAlias(node) || node.anchor || node.tag)
        throw new SyntaxError(
          "anchors, aliases, and explicit tags are not supported",
        );
      if (isMap(node)) {
        for (const pair of node.items) {
          if (
            !isScalar(pair.key) ||
            typeof pair.key.value !== "string" ||
            pair.key.value === "<<"
          ) {
            throw new SyntaxError(
              "mapping keys must be strings; merge keys are not supported",
            );
          }
        }
      }
    },
  });
  const value = document.toJS({ maxAliasCount: 0 });
  checkValue(value);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SyntaxError("document must be a mapping");
  return value;
}

/**
 * Checks document structure without coercing values or adding defaults.
 * @param {object} value - JSON-compatible document object.
 * @returns {string[]} Schema diagnostics with JSON Pointer paths.
 */
export function documentSchemaErrors(value) {
  if (validate(value)) return [];
  return validate.errors.map(
    (error) =>
      `${error.instancePath || "/"}: ${error.message} ${JSON.stringify(error.params)}`,
  );
}

/**
 * Reads YAML from a named file or standard input.
 * @param {string} file - Input path, or a dash for standard input.
 * @returns {string} UTF-8 source text.
 */
export function readDocument(file) {
  return fs.readFileSync(file === "-" ? 0 : file, "utf8");
}

/**
 * Writes a derived document without overwriting existing files.
 * @param {string|undefined} file - New output path, or undefined for standard output.
 * @param {string} source - Complete generated document.
 * @returns {void} Writes UTF-8 output; existing destinations cause an error.
 */
export function writeDocument(file, source) {
  if (file) fs.writeFileSync(file, source, { encoding: "utf8", flag: "wx" });
  else process.stdout.write(source);
}
