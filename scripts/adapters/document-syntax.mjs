/** Parses plugin document syntax using the development-only YAML and Markdown parsers. */
import { parseDocument } from "yaml";
import { fromMarkdown } from "mdast-util-from-markdown";

function normalize(source) {
  return source.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
}

function metadataValue(document) {
  try {
    return document.toJS();
  } catch (error) {
    // yaml 2.9.x reports these input failures during alias conversion, not parsing.
    const aliasInputFailure =
      error instanceof ReferenceError &&
      (error.message.startsWith(
        "Unresolved alias (the anchor must be set before the alias): ",
      ) ||
        error.message ===
          "Excessive alias count indicates a resource exhaustion attack");
    if (aliasInputFailure)
      throw new SyntaxError(error.message, { cause: error });
    throw error;
  }
}

/**
 * Reads YAML frontmatter without treating invalid syntax as plain text.
 *
 * @param {string} source - Skill document text.
 * @returns {object} Parsed metadata mapping.
 * @throws {SyntaxError} For invalid frontmatter; other parser failures propagate.
 */
export function skillMetadata(source) {
  const header = normalize(source).match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!header) throw new SyntaxError("frontmatter missing");
  const document = parseDocument(header[1], { prettyErrors: false });
  const problems = [...document.errors, ...document.warnings];
  if (problems.length)
    throw new SyntaxError(problems.map((item) => item.message).join("; "));
  const metadata = metadataValue(document);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new SyntaxError("frontmatter must be a mapping");
  }
  return metadata;
}

/**
 * Collects actual Markdown destinations, including reference definitions and images.
 *
 * @param {string} source - Document text.
 * @param {object} [options] - Document context provided by the package validator.
 * @param {boolean} [options.frontmatter=false] - Whether this is an actual skill document.
 * @returns {string[]} Link destinations, excluding code and escaped link examples.
 */
export function markdownDestinations(source, { frontmatter = false } = {}) {
  const normalized = normalize(source);
  const body = frontmatter
    ? normalized.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, "")
    : normalized;
  const destinations = [];
  function visit(node) {
    if (["link", "image", "definition"].includes(node.type)) {
      destinations.push(node.url);
    }
    for (const child of node.children ?? []) visit(child);
  }
  visit(fromMarkdown(body));
  return destinations;
}

/**
 * Provides document parsing capabilities to the validator.
 * @returns {import('../core/ports.mjs').DocumentSyntaxPort} YAML and Markdown adapter.
 */
export function createDocumentSyntax() {
  return { skillMetadata, markdownDestinations };
}
