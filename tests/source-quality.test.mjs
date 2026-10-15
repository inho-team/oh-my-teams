/** Regression checks for documentation and architecture enforcement on actual parsed modules. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { inspectSources } from "../scripts/core/source-quality.mjs";
import { parseModule } from "../scripts/adapters/javascript-syntax.mjs";
import { validateSources } from "../scripts/check-source.mjs";
import { temporaryDirectory } from "./helpers/plugin-fixture.mjs";

function module(file, source) {
  return { file, source, ...parseModule(source) };
}

test("source checks distinguish module, export, parameter and return documentation", () => {
  const file = "scripts/core/example.mjs";
  for (const [source, expected] of [
    ["const value = 1;", "module JSDoc missing"],
    [
      "/** Module. */\nexport function check(value) {}",
      "public export JSDoc missing",
    ],
    [
      "/** Module. */\n/** Export. @returns {void} Nothing. */\nexport function check(value) {}",
      "@param missing",
    ],
    [
      "/** Module. */\n/** Export. @param {string} value - Input. */\nexport function check(value) {}",
      "@returns missing",
    ],
    [
      "/** Module. */\n/** Export. @param {string} wrong - Input. @returns {void} Nothing. */\nexport function check(value) {}",
      "@param missing",
    ],
  ]) {
    assert.ok(
      inspectSources([module(file, source)]).some((finding) =>
        finding.includes(expected),
      ),
      expected,
    );
  }
});

test("named exports and exported arrow functions retain function documentation requirements", () => {
  for (const body of [
    "function check(value) {}\n/** Export. @returns {void} Nothing. */\nexport { check };",
    "/** Export. @returns {void} Nothing. */\nexport const check = (value) => {};",
  ]) {
    assert.ok(
      inspectSources([
        module("scripts/core/example.mjs", `/** Module. */\n${body}`),
      ]).some((finding) => finding.includes("@param missing")),
    );
  }
});

test("nested JSDoc types and long comments are accepted while long executable lines fail", () => {
  const valid = [
    `/** ${"Documentation ".repeat(20)} */`,
    "/** Check.",
    " * @param {{name: string}} value - Input.",
    " * @returns {string} Name.",
    " */",
    "export function check(value) { return value.name; }",
  ].join("\n");
  assert.deepEqual(
    inspectSources([module("scripts/core/example.mjs", valid)]),
    [],
  );
  const inline =
    "/** Module. */\n/** Check. @param {string} value - Input. @returns {string} Result. */\nexport function check(value) { return value; }";
  assert.deepEqual(
    inspectSources([module("scripts/core/example.mjs", inline)]),
    [],
  );
  const long = `/** Module. */\nconst value = "${"x".repeat(181)}";`;
  assert.ok(
    inspectSources([module("scripts/core/example.mjs", long)]).some((finding) =>
      finding.includes("exceeds 180"),
    ),
  );
});

test("core rejects native IO, concrete adapters and implicit runtime clocks", () => {
  for (const body of [
    'import fs from "node:fs";',
    'import "../adapters/node-files.mjs";',
    'import "yaml";',
    "const result = process.cwd();",
    "const result = new Date();",
    "const result = Date.now();",
    "const result = import(process.env.MODULE);",
  ]) {
    const findings = inspectSources([
      module("scripts/core/example.mjs", `/** Module. */\n${body}`),
    ]);
    assert.ok(findings.length > 0, body);
  }
});

test("dependency direction, cycles and unresolved imports are diagnosed", () => {
  const entry = module(
    "scripts/check.mjs",
    '/** Entry. */\nimport "./core/a.mjs";',
  );
  const a = module("scripts/core/a.mjs", '/** A. */\nimport "./b.mjs";');
  const b = module("scripts/core/b.mjs", '/** B. */\nimport "./a.mjs";');
  assert.ok(
    inspectSources([entry, a, b]).some((finding) =>
      finding.includes("Dependency cycle"),
    ),
  );
  assert.ok(
    inspectSources([a]).some((finding) =>
      finding.includes("unresolved source import"),
    ),
  );
  const adapter = module(
    "scripts/adapters/example.mjs",
    '/** Adapter. */\nimport "../check.mjs";',
  );
  assert.ok(
    inspectSources([adapter, entry, a, b]).some((finding) =>
      finding.includes("adapter to entry"),
    ),
  );
});

test("the repository entry point catches missing comments and invalid JavaScript in new modules", (t) => {
  const root = temporaryDirectory(t);
  const file = path.join(root, "scripts/core/new.mjs");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "/** Module. */\nconst value = 1;\n");
  assert.equal(validateSources(root).status, "passed");
  fs.writeFileSync(file, "const value = 1;\n");
  assert.ok(
    validateSources(root).findings.some((finding) =>
      finding.includes("module JSDoc missing"),
    ),
  );
  fs.writeFileSync(file, "const = ;\n");
  assert.ok(
    validateSources(root).findings.some((finding) =>
      finding.includes("invalid JavaScript"),
    ),
  );
});
