/** Parses plugin document syntax using the development-only YAML and Markdown parsers. */
import { parseDocument } from "yaml";
import { fromMarkdown } from "mdast-util-from-markdown";

function normalize(source) {
  return source.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
}

/**
 * Reads YAML frontmatter without treating invalid syntax as plain text.
 *
 * @param {string} source - Skill document text.
 * @returns {object} Parsed metadata mapping.
 */
export function skillMetadata(source) {
  const header = normalize(source).match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!header) throw new Error("frontmatter missing");
  const document = parseDocument(header[1], { prettyErrors: false });
  const problems = [...document.errors, ...document.warnings];
  if (problems.length)
    throw new Error(problems.map((item) => item.message).join("; "));
  const metadata = document.toJS();
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("frontmatter must be a mapping");
  }
  return metadata;
}

/**
 * Collects actual Markdown destinations, including reference definitions and images.
 *
 * @param {string} source - Document text, optionally with skill frontmatter.
 * @returns {string[]} Link destinations, excluding code and escaped link examples.
 */
export function markdownDestinations(source) {
  const body = normalize(source).replace(/^---\n[\s\S]*?\n---(?:\n|$)/, "");
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
