/** Regression checks for the skill-only 3.x package boundary. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { synchronize } from "../scripts/metadata.mjs";
import { validatePlugin } from "../scripts/check-skills.mjs";
import { pluginFixture } from "./helpers/plugin-fixture.mjs";

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
  const architecture = read("plugins/oh-my-teams/references/architecture.md");
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

test("an isolated installation has all documents needed by its skills", (t) => {
  const installed = pluginFixture(t);
  assert.deepEqual(validatePlugin(installed), {
    status: "passed",
    skills: 7,
    findings: [],
  });
});

test("validation rejects links to existing files outside the plugin", (t) => {
  const installed = pluginFixture(t);
  fs.writeFileSync(
    path.join(installed, "..", "outside.md"),
    "Repository-only document\n",
  );
  fs.appendFileSync(
    path.join(installed, "skills/kickoff/SKILL.md"),
    "\n[External file](../../../outside.md)\n",
  );
  const report = validatePlugin(installed);
  assert.equal(report.status, "failed");
  assert.ok(
    report.findings.some((item) =>
      item.includes("link outside plugin ../../../outside.md"),
    ),
  );
});

test("validation follows bundled references and reports missing documents", (t) => {
  const installed = pluginFixture(t);
  fs.appendFileSync(
    path.join(installed, "references/architecture.md"),
    "\n[Missing reference](missing.md)\n",
  );
  const report = validatePlugin(installed);
  assert.equal(report.status, "failed");
  assert.ok(
    report.findings.some((item) => item.includes("broken link missing.md")),
  );
});

test("validation rejects links through directories outside the plugin", (t) => {
  const installed = pluginFixture(t);
  const outside = path.join(installed, "..", "external");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "document.md"), "External document\n");
  fs.symlinkSync(
    outside,
    path.join(installed, "references/external"),
    "junction",
  );
  fs.appendFileSync(
    path.join(installed, "references/architecture.md"),
    "\n[External reference](external/document.md)\n",
  );
  const report = validatePlugin(installed);
  assert.equal(report.status, "failed");
  assert.ok(
    report.findings.some((item) =>
      item.includes("link outside plugin external/document.md"),
    ),
  );
});

test("Windows line endings preserve valid skill metadata", (t) => {
  const installed = pluginFixture(t);
  const skill = path.join(installed, "skills/kickoff/SKILL.md");
  const source = fs.readFileSync(skill, "utf8").replaceAll("\r\n", "\n");
  fs.writeFileSync(skill, source.replaceAll("\n", "\r\n"));
  assert.equal(validatePlugin(installed).status, "passed");
});
