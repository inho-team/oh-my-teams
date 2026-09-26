/** Checks the roadmap canon and its rules reference against the structural
 * contract `plugins/oh-my-teams/references/roadmap.md` declares: resolved
 * links, well-formed phase identifiers, complete phase sections, and no
 * implementation leaking into the roadmap.
 */
import fs from "node:fs";
import path from "node:path";

/** Phase identifier format the roadmap requires. */
export const PHASE_ID_PATTERN = /^PH-\d{2}$/;

/** The six items every phase section must declare. */
export const PHASE_FIELDS = [
  "목표",
  "수용 기준",
  "검증 방법",
  "주의사항",
  "가이드",
  "비목표",
];

/** Extract every markdown link target a document declares.
 * @param {string} markdown document text
 * @returns {string[]} link targets in document order, `http(s)` targets excluded
 */
export function markdownLinkTargets(markdown) {
  return [...markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^https?:\/\//.test(target));
}

/** Find the links a document declares that do not resolve to a real file.
 *
 * A link's target is resolved relative to the directory the linking document
 * lives in, matching how a markdown renderer or an editor's "go to file"
 * would follow it. A trailing `#fragment` is dropped before resolving,
 * because it names a position inside the target, not a second file.
 *
 * @param {string} markdown document text
 * @param {string} fromFile document path, relative to `root`
 * @param {string} root repository root directory
 * @returns {string[]} link targets that resolve to nothing on disk
 */
export function brokenLinks(markdown, fromFile, root) {
  const fromDir = path.dirname(path.join(root, fromFile));
  return markdownLinkTargets(markdown).filter((target) => {
    const clean = target.split("#")[0];
    return clean !== "" && !fs.existsSync(path.join(fromDir, clean));
  });
}

/** Find the phase headings a roadmap declares.
 *
 * A heading is read even when its identifier is malformed, so a caller can
 * still report which malformed identifier was found.
 *
 * @param {string} markdown roadmap document text
 * @returns {Array<{id: string, title: string}>} headings in document order
 */
export function phaseHeadings(markdown) {
  return [...markdown.matchAll(/^## (\S+) — (.+)$/gm)].map((match) => ({
    id: match[1],
    title: match[2],
  }));
}

/** Find phase identifiers that do not follow the `PH-` two-digit format.
 * @param {string} markdown roadmap document text
 * @returns {string[]} malformed identifiers, in document order
 */
export function malformedPhaseIds(markdown) {
  return phaseHeadings(markdown)
    .map((heading) => heading.id)
    .filter((id) => !PHASE_ID_PATTERN.test(id));
}

/** Find phase identifiers that appear more than once.
 * @param {string} markdown roadmap document text
 * @returns {string[]} repeated identifiers, without duplicates in the result
 */
export function duplicatePhaseIds(markdown) {
  const seen = new Set();
  const repeated = new Set();
  for (const heading of phaseHeadings(markdown)) {
    if (seen.has(heading.id)) repeated.add(heading.id);
    seen.add(heading.id);
  }
  return [...repeated];
}

/** Split a roadmap into the text belonging to each phase heading.
 * @param {string} markdown roadmap document text
 * @returns {Array<{id: string, body: string}>} each phase's id and the text up to the next `## ` heading
 */
export function phaseBodies(markdown) {
  const matches = [...markdown.matchAll(/^## (\S+) — .+$/gm)];
  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? markdown.length;
    return { id: match[1], body: markdown.slice(start, end) };
  });
}

/** Find the required fields a phase's body does not declare.
 * @param {string} body phase text, as returned by {@link phaseBodies}
 * @returns {string[]} field names missing from the body, in `PHASE_FIELDS` order
 */
export function missingPhaseFields(body) {
  return PHASE_FIELDS.filter(
    (field) => !new RegExp(`\\*\\*${field}\\.\\*\\*`).test(body),
  );
}

/** Find implementation leaking into a roadmap document.
 *
 * Three shapes count as a leak: a fenced code block, text that reads like a
 * function or method signature, and a backtick-wrapped path that is not
 * inside a markdown link. Every markdown link is stripped before the other
 * two checks run, so a link's own brackets and target text never count as a
 * signature or an unlinked path; the backtick checks also stay within a
 * single line, so a fence's paired triple backticks cannot be mistaken for
 * an inline code span that happens to contain parentheses.
 *
 * @param {string} markdown roadmap document text
 * @returns {string[]} one label per kind of leak found, without duplicates
 */
export function implementationLeaks(markdown) {
  const leaks = [];
  if (/```/.test(markdown)) leaks.push("code-block");
  const withoutLinks = markdown.replace(/\[[^\]]*\]\([^)]+\)/g, "");
  if (
    /`[^`\n]*\([^`\n]*\)[^`\n]*`/.test(withoutLinks) ||
    /=>/.test(withoutLinks) ||
    /\bfunction\s+\w+\s*\(/.test(withoutLinks) ||
    /\bclass\s+[A-Z]\w*/.test(withoutLinks)
  ) {
    leaks.push("signature");
  }
  const hasUnlinkedPath = [...withoutLinks.matchAll(/`([^`\n]*)`/g)].some(
    (match) => match[1].includes("/"),
  );
  if (hasUnlinkedPath) leaks.push("unlinked-path");
  return leaks;
}
