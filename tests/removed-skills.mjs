/** Reads the skill names 2.0.0 removed from the table that states them.
 *
 * The mapping lives in the help skill because that table is what a user
 * arriving with an old name actually sees. Keeping a second copy here would
 * let the two drift apart silently, so the tests read the same table instead.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helpSkill = path.join(root, "plugins/oh-my-teams/skills/help/SKILL.md");
const heading = "## 2.0.0에서 삭제된 이름";

/** Collect the removed names listed in the help skill's mapping table.
 *
 * The left column holds the removed names as plain text and the right column
 * holds the installed names in backticks, so a name is only treated as removed
 * when it carries no backticks.
 *
 * @returns {string[]} Removed skill names in table order, without duplicates.
 */
export function removedSkillNames() {
  const text = fs.readFileSync(helpSkill, "utf8");
  const section = text.split(heading)[1];
  if (!section) throw new Error(`${heading} is missing from the help skill`);

  const names = section
    .split(/\r?\n/)
    .slice(0, indexOfNextHeading(section))
    .filter((line) => line.startsWith("|") && !line.includes("---"))
    .map((line) => line.split("|")[1] ?? "")
    .flatMap((cell) => cell.split(","))
    .map((name) => name.trim())
    .filter((name) => /^[a-z][a-z-]*$/.test(name));

  return [...new Set(names)];
}

/** Find where the removed-names section ends.
 * @param {string} section Text following the heading.
 * @returns {number} Line index of the next heading, or the line count.
 */
function indexOfNextHeading(section) {
  const lines = section.split(/\r?\n/);
  const next = lines.findIndex((line) => line.startsWith("## "));
  return next === -1 ? lines.length : next;
}
