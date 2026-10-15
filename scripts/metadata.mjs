/** Synchronizes plugin and marketplace versions from package.json. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sources = [
  ".claude-plugin/marketplace.json",
  "plugins/oh-my-teams/.claude-plugin/plugin.json",
  "plugins/oh-my-teams/.codex-plugin/plugin.json",
];

function read(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function codexVersion(version, current, now) {
  const prefix = `${version}+codex.`;
  if (
    typeof current === "string" &&
    current.startsWith(prefix) &&
    /^\d{14}$/.test(current.slice(prefix.length))
  )
    return current;
  const stamp = now
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
 * @param {object} [options] - Explicit repository and clock for isolated usage.
 * @param {string} [options.root] - Checkout containing package.json and manifests.
 * @param {Date} [options.now] - Timestamp used only when a Codex version needs repair.
 * @returns {{changed: string[], mismatches: string[]}} Sync result.
 */
export function synchronize(
  write = false,
  { root = defaultRoot, now = new Date() } = {},
) {
  const version = read(root, "package.json").version;
  const changed = [];
  const mismatches = [];
  for (const file of sources) {
    const value = read(root, file);
    const target = file === sources[0] ? value.metadata : value;
    const expected = file.includes(".codex-plugin")
      ? codexVersion(version, target.version, now)
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
