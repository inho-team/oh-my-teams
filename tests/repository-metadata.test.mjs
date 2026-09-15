/** Regression tests for manifest metadata that must stay synchronized. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Read a JSON manifest from the repository root.
 * @param {string} relative manifest path relative to the repository root
 * @returns {object} parsed manifest
 */
function manifest(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
}

/** Strip build metadata so distribution variants compare by base version.
 * @param {string} version declared semantic version
 * @returns {string} version without its build metadata suffix
 */
function baseVersion(version) {
  return version.split("+")[0];
}

test("every manifest declares the same base version", () => {
  const declared = manifest("package.json").version;
  assert.match(declared, /^\d+\.\d+\.\d+$/);

  const sources = {
    ".claude-plugin/marketplace.json": manifest(
      ".claude-plugin/marketplace.json",
    ).metadata.version,
    "plugins/oh-my-teams/.claude-plugin/plugin.json": manifest(
      "plugins/oh-my-teams/.claude-plugin/plugin.json",
    ).version,
    "plugins/oh-my-teams/.codex-plugin/plugin.json": manifest(
      "plugins/oh-my-teams/.codex-plugin/plugin.json",
    ).version,
  };

  const mismatches = Object.entries(sources)
    .filter(([, version]) => baseVersion(version) !== declared)
    .map(
      ([file, version]) => `${file} declares ${version}, expected ${declared}`,
    );
  assert.deepEqual(mismatches, []);
});

test("the codex manifest keeps its build metadata suffix", () => {
  const codex = manifest("plugins/oh-my-teams/.codex-plugin/plugin.json");
  assert.match(codex.version, /^\d+\.\d+\.\d+\+codex\.\d+$/);
});
