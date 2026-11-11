/** Measures how much text each skill asks a host to read and compares it with fixed ceilings. */
import path from "node:path";
import { pathProblem } from "./plugin-paths.mjs";

/**
 * Counts Unicode code points after removing a byte order mark and Windows line endings.
 * The unit is characters, not model tokens, and is identical on every checkout platform.
 * @param {string} source - Document text.
 * @returns {number} Code point count.
 */
export function countCharacters(source) {
  return [...source.replace(/^﻿/, "").replaceAll("\r\n", "\n")].length;
}

function linkedFiles(pluginRoot, file, files, syntax) {
  const targets = [];
  for (const destination of syntax.markdownDestinations(files.readText(file), {
    frontmatter: true,
  })) {
    if (
      /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(destination) ||
      path.win32.isAbsolute(destination)
    )
      continue;
    let target;
    try {
      target = decodeURIComponent(destination.split(/[?#]/)[0]);
    } catch {
      continue;
    }
    if (!target) continue;
    const resolved = path.resolve(path.dirname(file), target);
    if (pathProblem(pluginRoot, resolved, files)) continue;
    if (files.kind(resolved) === "file") targets.push(resolved);
  }
  return targets;
}

function measureSkill(pluginRoot, skill, file, files, syntax) {
  const seen = new Set([files.realPath(file)]);
  const documents = [
    {
      file: "SKILL.md",
      characters: countCharacters(files.readText(file)),
    },
  ];
  for (const target of linkedFiles(pluginRoot, file, files, syntax)) {
    const identity = files.realPath(target);
    if (seen.has(identity)) continue;
    seen.add(identity);
    documents.push({
      file: path.relative(pluginRoot, target).split(path.sep).join("/"),
      characters: countCharacters(files.readText(target)),
    });
  }
  return {
    skill,
    body: documents[0].characters,
    characters: documents.reduce((sum, item) => sum + item.characters, 0),
    documents,
  };
}

/**
 * Measures every bundled skill together with the files its SKILL.md links directly.
 * External URLs, fragment-only links, repeated targets and paths outside the plugin are not counted.
 * @param {string} pluginRoot - Installed plugin directory.
 * @param {import("./ports.mjs").FilesPort} files - Filesystem capabilities.
 * @param {import("./ports.mjs").DocumentSyntaxPort} syntax - Document parsers.
 * @returns {{skill: string, body: number, characters: number, documents: {file: string, characters: number}[]}[]} Skill sizes by name.
 */
export function measureReading(pluginRoot, files, syntax) {
  const root = files.realPath(pluginRoot);
  const skillRoot = path.join(root, "skills");
  return files
    .entries(skillRoot)
    .filter((item) => item.kind === "directory" && !item.name.startsWith("."))
    .map((item) => item.name)
    .sort()
    .flatMap((skill) => {
      const file = path.join(skillRoot, skill, "SKILL.md");
      if (pathProblem(root, file, files) || files.kind(file) !== "file")
        return [];
      return [measureSkill(root, skill, file, files, syntax)];
    });
}

function isCeiling(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Compares measured skill sizes with their ceilings without changing either input.
 * @param {{skill: string, characters: number, documents: {file: string, characters: number}[]}[]} measurements - Measured skills.
 * @param {Object<string, number>} ceilings - Maximum characters per skill name.
 * @returns {string[]} One finding per exceeded, missing, invalid or unused ceiling.
 */
export function budgetFindings(measurements, ceilings) {
  const findings = [];
  const measured = new Set();
  for (const item of measurements) {
    measured.add(item.skill);
    if (!Object.hasOwn(ceilings, item.skill)) {
      findings.push(`${item.skill}: reading ceiling missing`);
      continue;
    }
    const ceiling = ceilings[item.skill];
    if (!isCeiling(ceiling)) {
      findings.push(
        `${item.skill}: reading ceiling must be a nonnegative integer`,
      );
      continue;
    }
    if (item.characters > ceiling) {
      const largest = [...item.documents]
        .sort((left, right) => right.characters - left.characters)
        .slice(0, 3)
        .map((entry) => `${entry.file} ${entry.characters}`)
        .join(", ");
      findings.push(
        `${item.skill}: reads ${item.characters} characters, ceiling ${ceiling}; largest: ${largest}`,
      );
    }
  }
  for (const skill of Object.keys(ceilings).sort()) {
    if (!measured.has(skill))
      findings.push(`${skill}: reading ceiling names a skill not installed`);
  }
  return findings;
}
