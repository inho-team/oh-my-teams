/** Exercises README, docs and eval links through the shared Markdown boundary rules. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validateRepositoryDocs } from "../scripts/check-docs.mjs";
import { createNodeFiles } from "../scripts/adapters/node-files.mjs";
import { temporaryDirectory } from "./helpers/plugin-fixture.mjs";

function repository(t) {
  const root = path.join(temporaryDirectory(t), "repo");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.mkdirSync(path.join(root, "evals"));
  fs.writeFileSync(
    path.join(root, "README.md"),
    "# Start\n\n[Guide](docs/guide.md#설정)\n",
  );
  fs.writeFileSync(
    path.join(root, "docs/guide.md"),
    "# 설정\n\n[Home](../README.md#start)\n",
  );
  fs.writeFileSync(
    path.join(root, "evals/README.md"),
    "[Guide](../docs/guide.md#설정)\n",
  );
  return root;
}

test("repository validation covers README, docs and evals without scanning installed skills", (t) => {
  const root = repository(t);
  const skill = path.join(root, "plugins/oh-my-teams/skills/start/SKILL.md");
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, "---\nname: start\n---\n# 시작\n");
  fs.appendFileSync(
    path.join(root, "README.md"),
    "[Skill](plugins/oh-my-teams/skills/start/SKILL.md#시작)\n",
  );
  assert.deepEqual(validateRepositoryDocs(root), {
    status: "passed",
    documents: 3,
    findings: [],
  });
  fs.appendFileSync(
    path.join(root, "evals/README.md"),
    "[Missing](missing.md)\n",
  );
  fs.appendFileSync(
    path.join(root, "docs/guide.md"),
    "[Missing](../README.md#absent)\n",
  );
  fs.appendFileSync(
    path.join(root, "README.md"),
    "[YAML is not a heading](plugins/oh-my-teams/skills/start/SKILL.md#name-start)\n",
  );
  const report = validateRepositoryDocs(root);
  assert.equal(report.status, "failed");
  assert.equal(report.findings.length, 3);
  assert.ok(
    report.findings.some((item) => item.includes("broken link missing.md")),
  );
  assert.ok(
    report.findings.some((item) =>
      item.includes("broken anchor ../README.md#absent"),
    ),
  );
  assert.ok(
    report.findings.some((item) =>
      item.includes(
        "broken anchor plugins/oh-my-teams/skills/start/SKILL.md#name-start",
      ),
    ),
  );
});

test("repository links and directory aliases cannot escape the checkout", (t) => {
  const root = repository(t);
  const outside = path.join(path.dirname(root), "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "guide.md"), "# Guide\n");
  fs.appendFileSync(
    path.join(root, "README.md"),
    "[External](../outside/guide.md)\n",
  );
  assert.ok(
    validateRepositoryDocs(root).findings.some((item) =>
      item.includes("link outside repository"),
    ),
  );
  const alias = path.join(root, "evals");
  fs.unlinkSync(path.join(alias, "README.md"));
  fs.rmdirSync(alias);
  fs.symlinkSync(
    outside,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.ok(
    validateRepositoryDocs(root).findings.some((item) =>
      item.includes("evals: outside repository"),
    ),
  );
});

test("repository documentation reports read errors and propagates programming failures", (t) => {
  const root = repository(t);
  for (const failure of [
    Object.assign(new Error("denied"), { code: "EACCES", syscall: "read" }),
    new TypeError("implementation bug"),
  ]) {
    const files = {
      ...createNodeFiles(),
      readText() {
        throw failure;
      },
    };
    if (failure instanceof TypeError)
      assert.throws(
        () => validateRepositoryDocs(root, { files }),
        (error) => error === failure,
      );
    else
      assert.match(
        validateRepositoryDocs(root, { files }).findings[0],
        /EACCES/,
      );
  }
});
