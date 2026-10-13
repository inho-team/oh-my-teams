/** Regression checks for the skill-only 3.x package boundary. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { synchronize } from "../scripts/metadata.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = path.join(root, "plugins/oh-my-teams");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("the public plugin has no mandatory role runtime or bundled provider", () => {
  for (const directory of ["scripts", "schemas", "resources", "examples"]) {
    assert.equal(fs.existsSync(path.join(plugin, directory)), false, directory);
  }
  const skills = fs
    .readdirSync(path.join(plugin, "skills"))
    .filter((name) => !name.startsWith("."))
    .sort();
  assert.deepEqual(skills, [
    "close",
    "consult",
    "disband",
    "fluent-korean",
    "help",
    "kickoff",
    "status",
  ]);
  const pkg = JSON.parse(read("package.json"));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
});

test("plugin manifests follow the package version", () => {
  assert.deepEqual(synchronize(), { changed: [], mismatches: [] });
  const pkg = JSON.parse(read("package.json"));
  const claude = JSON.parse(
    read("plugins/oh-my-teams/.claude-plugin/plugin.json"),
  );
  const codex = JSON.parse(
    read("plugins/oh-my-teams/.codex-plugin/plugin.json"),
  );
  assert.equal(claude.version, pkg.version);
  assert.match(
    codex.version,
    new RegExp(`^${pkg.version.replaceAll(".", "\\.")}\\+codex\\.\\d{14}$`),
  );
});

test("the owner keeps one writer per worktree and specialist calls stay read-only", () => {
  const architecture = read("docs/ARCHITECTURE.md");
  assert.match(architecture, /편집을 책임지는 소유 세션은 한 번에 하나/);
  assert.match(
    architecture,
    /호출만을 위해 워크트리나 터미널을 추가하지 않는다/,
  );
  assert.match(architecture, /다른 실행 ID로 고정된 커밋을 검토/);
  assert.match(
    architecture,
    /현재 세션이 서 있는 워크트리는 스스로 삭제하지 않는다/,
  );
});
