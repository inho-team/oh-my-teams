/** Synchronizes plugin and marketplace versions from package.json. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sources = [
  ".claude-plugin/marketplace.json",
  "plugins/oh-my-teams/.claude-plugin/plugin.json",
  "plugins/oh-my-teams/.codex-plugin/plugin.json",
];

function read(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function codexVersion(version, current) {
  if (current.startsWith(`${version}+codex.`)) return current;
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "")
    .replace(/\.\d{3}Z$/, "");
  return `${version}+codex.${stamp}`;
}

/**
 * Reports version mismatches and optionally writes the canonical values.
 *
 * @param {boolean} write - Whether to update mismatched manifests.
 * @returns {{changed: string[], mismatches: string[]}} Sync result.
 */
export function synchronize(write = false) {
  const version = read("package.json").version;
  const changed = [];
  const mismatches = [];
  for (const file of sources) {
    const value = read(file);
    const target = file === sources[0] ? value.metadata : value;
    const expected = file.includes(".codex-plugin")
      ? codexVersion(version, target.version)
      : version;
    if (target.version === expected) continue;
    mismatches.push(file);
    if (!write) continue;
    target.version = expected;
    fs.writeFileSync(
      path.join(root, file),
      `${JSON.stringify(value, null, 2)}\n`,
    );
    changed.push(file);
  }
  return { changed, mismatches: write ? [] : mismatches };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const write = process.argv.includes("--write");
  const result = synchronize(write);
  console.log(JSON.stringify(result, null, 2));
  if (result.mismatches.length) process.exitCode = 1;
}
