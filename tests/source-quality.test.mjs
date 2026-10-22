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
    "const environment = process; const result = environment.cwd();",
    "const clock = Date; const result = clock.now();",
    "const root = globalThis; const result = root.process.cwd();",
    "const { env } = process;",
  ]) {
    const findings = inspectSources([
      module("scripts/core/example.mjs", `/** Module. */\n${body}`),
    ]);
    assert.ok(findings.length > 0, body);
  }
});

test("function aliases keep their lexical binding across chains and shadowed names", () => {
  const body = [
    "const original = (value) => value;",
    "const middle = original; const alias = middle;",
    "function nested() { const original = 1; return original; }",
    "/** Export. @returns {string} Result. */",
    "export { alias };",
  ].join("\n");
  assert.ok(
    inspectSources([
      module("scripts/core/example.mjs", `/** Module. */\n${body}`),
    ]).some((finding) => finding.includes("@param missing")),
  );
  const documented = body.replace(
    "/** Export.",
    "/** Export. @param {string} value - Input.",
  );
  assert.deepEqual(
    inspectSources([
      module("scripts/core/example.mjs", `/** Module. */\n${documented}`),
    ]),
    [],
  );
});

test("injected bindings and property names do not become forbidden global references", () => {
  const body = [
    "/** Module. */",
    "function check(process, Date) { const environment = process; return Date.now() + environment.cwd(); }",
    "const labels = { process: 1, Date: 2 };",
    "const value = labels.process;",
  ].join("\n");
  assert.deepEqual(
    inspectSources([module("scripts/core/example.mjs", body)]),
    [],
  );
});

test("destructured function exports resolve renamed, nested, default and assigned bindings", () => {
  for (const body of [
    "const { run } = { run: (value) => value };",
    "const source = { run: (value) => value }; const { run: alias } = source; const run = alias;",
    "const { nested: [run] } = { nested: [(value) => value] };",
    "const { run = (value) => value } = {};",
    "let run; ({ run } = { run: (value) => value });",
    "const { run } = { run(value) { return value; } };",
  ]) {
    const source = `/** Module. */\n${body}\n/** Export. */\nexport { run };`;
    const findings = inspectSources([
      module("scripts/core/example.mjs", source),
    ]);
    assert.ok(
      findings.some((item) => item.includes("@param missing")),
      body,
    );
    assert.ok(
      findings.some((item) => item.includes("@returns missing")),
      body,
    );
    const documented = source.replace(
      "/** Export. */",
      "/** Export. @param {string} value - Input. @returns {string} Result. */",
    );
    assert.deepEqual(
      inspectSources([module("scripts/core/example.mjs", documented)]),
      [],
      body,
    );
  }
  const numeric =
    "/** Module. */\nconst { run } = { run: 1, other: value => value };\n/** Export. */\nexport { run };";
  assert.deepEqual(
    inspectSources([module("scripts/core/example.mjs", numeric)]),
    [],
  );
});

test("destructured alias cycles terminate even when projection paths grow", () => {
  const source =
    "/** Module. */\nlet a; let b; ({ child: a } = b); b = a;\n/** Export. */\nexport { a };";
  assert.deepEqual(
    inspectSources([module("scripts/core/example.mjs", source)]),
    [],
  );
});

test("directly exported destructuring declarations retain function documentation requirements", () => {
  for (const declaration of [
    "const { run } = { run: value => value };",
    "const [run] = [value => value];",
    "let run; run = value => value;",
  ]) {
    const source = `/** Module. */\n/** Export. */\nexport ${declaration}`;
    const findings = inspectSources([
      module("scripts/core/example.mjs", source),
    ]);
    assert.ok(
      findings.some((item) => item.includes("@param missing")),
      declaration,
    );
    assert.ok(
      findings.some((item) => item.includes("@returns missing")),
      declaration,
    );
  }
});

test("cyclic alias bindings terminate without inventing a function signature", () => {
  const body =
    "/** Module. */\nlet first; let second; first = second; second = first;\n/** Export. */\nexport { first };";
  assert.deepEqual(
    inspectSources([module("scripts/core/example.mjs", body)]),
    [],
  );
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

test("test regexes reject fixed slash separators and accept portable path expectations", () => {
  for (const body of [
    String.raw`assert.match(spec, /로드맵 규칙: .*references\/roadmap\.md/);`,
    String.raw`assert.doesNotMatch(spec, /references[/]roadmap\.md/);`,
    String.raw`const expected = /references\/roadmap\.md/;`,
    String.raw`/references\/roadmap\.md/.test(spec);`,
    String.raw`const expected = /\[references\/subdir[\\/]roadmap\.md\]/;`,
  ]) {
    for (const file of [
      "tests/example.test.mjs",
      "examples/example.test.mjs",
    ]) {
      assert.ok(
        inspectSources([module(file, `/** Module. */\n${body}`)]).some(
          (finding) => finding.includes("fixed slash separator in test regex"),
        ),
        body,
      );
    }
  }
  for (const body of [
    'assert.ok(spec.includes(path.join(references, "roadmap.md")));',
    String.raw`assert.match(spec, /references[\\/]roadmap\.md/);`,
    String.raw`assert.match(spec, /references[/\\]roadmap\.md/);`,
    String.raw`assert.match(spec, /references[^\\/]roadmap\.md/);`,
    String.raw`assert.match(spec, /\[references[\\/]subdir[/\\]roadmap\.md\]/);`,
    "assert.match(message, /missing file/);",
  ]) {
    assert.deepEqual(
      inspectSources([
        module("tests/example.test.mjs", `/** Module. */\n${body}`),
      ]),
      [],
      body,
    );
  }
  assert.deepEqual(
    inspectSources([
      module(
        "scripts/core/example.mjs",
        String.raw`/** Module. */ const pattern = /references\/roadmap\.md/;`,
      ),
    ]),
    [],
  );
});

test("the repository entry point catches missing comments and invalid JavaScript in new modules", (t) => {
  const root = temporaryDirectory(t);
  const file = path.join(root, "tests/new.mjs");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "/** Module. */\nconst value = 1;\n");
  assert.equal(validateSources(root).status, "passed");
  fs.writeFileSync(file, "const value = 1;\n");
  assert.ok(
    validateSources(root).findings.some((finding) =>
      finding.includes("module JSDoc missing"),
    ),
  );
  fs.writeFileSync(
    file,
    String.raw`/** Module. */ const pattern = /\[references\/subdir[\\/]roadmap\.md\]/;`,
  );
  assert.ok(
    validateSources(root).findings.some((finding) =>
      finding.includes("fixed slash separator in test regex"),
    ),
  );
  fs.writeFileSync(file, "const = ;\n");
  assert.ok(
    validateSources(root).findings.some((finding) =>
      finding.includes("invalid JavaScript"),
    ),
  );
});
