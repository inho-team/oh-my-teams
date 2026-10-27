/** Checks deterministic standalone generation and its closed runtime dependency boundary. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import {
  buildRuntime,
  localizeRuntime,
} from "../scripts/adapters/runtime-build.mjs";
import { temporaryDirectory } from "./helpers/plugin-fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const documents = "plugins/oh-my-teams/references/documents";
const generated = "plugins/oh-my-teams/scripts/generated";
const core = "scripts/core/omt-documents.mjs";
const installedCore = "plugins/oh-my-teams/scripts/core/omt-documents.mjs";
const outputs = [
  `${generated}/document-validator.cjs`,
  `${generated}/ucs2length.cjs`,
  `${generated}/formats.cjs`,
  `${generated}/THIRD_PARTY_NOTICES.md`,
  installedCore,
];

function fixture(t) {
  const directory = temporaryDirectory(t);
  for (const file of [`${documents}/document.schema.json`, core]) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(directory, file));
  }
  return directory;
}

test("runtime generation is deterministic, checked, and derived from the pure core", (t) => {
  const directory = fixture(t);
  assert.deepEqual(
    buildRuntime({ root: directory }).mismatches.sort(),
    [...outputs].sort(),
  );
  assert.deepEqual(
    buildRuntime({ root: directory, write: true }).changed.sort(),
    [...outputs].sort(),
  );
  const before = outputs.map((file) =>
    fs.readFileSync(path.join(directory, file), "utf8"),
  );
  assert.deepEqual(buildRuntime({ root: directory, write: true }), {
    changed: [],
    mismatches: [],
  });
  assert.deepEqual(
    outputs.map((file) => fs.readFileSync(path.join(directory, file), "utf8")),
    before,
  );
  assert.equal(
    fs.readFileSync(path.join(directory, installedCore), "utf8"),
    fs.readFileSync(path.join(root, core), "utf8"),
  );
  const require = createRequire(path.join(directory, "installed.cjs"));
  assert.equal(
    typeof require(`./${generated}/document-validator.cjs`),
    "function",
  );
  for (const file of outputs.filter((name) => name.endsWith(".cjs"))) {
    assert.equal(
      localizeRuntime(fs.readFileSync(path.join(directory, file), "utf8")),
      fs.readFileSync(path.join(directory, file), "utf8"),
    );
  }
  const notices = fs.readFileSync(path.join(directory, outputs[3]), "utf8");
  for (const name of ["ajv", "ajv-formats"]) {
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(root, "node_modules", name, "package.json"),

        "utf8",
      ),
    );
    const repository =
      typeof pkg.repository === "string" ? pkg.repository : pkg.repository.url;
    assert.ok(notices.includes(repository), name);
    const license = fs
      .readFileSync(path.join(root, "node_modules", name, "LICENSE"), "utf8")
      .trim();
    const section = notices
      .split(`## ${name} ${pkg.version}`)[1]
      .split("\n## ")[0]
      .trim();
    assert.equal(section.slice(-license.length), license, name);
  }
});

test("six examples and malformed documents agree with development Ajv", (t) => {
  const directory = fixture(t);
  buildRuntime({ root: directory, write: true });
  const validate = createRequire(path.join(directory, "test.cjs"))(
    `./${generated}/document-validator.cjs`,
  );
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  const development = ajv.compile(
    JSON.parse(
      fs.readFileSync(
        path.join(root, documents, "document.schema.json"),
        "utf8",
      ),
    ),
  );
  const examples = fs
    .readdirSync(path.join(root, documents))
    .filter((name) => name.endsWith(".example.yaml"));
  assert.equal(examples.length, 6);
  for (const name of examples) {
    const value = parse(
      fs.readFileSync(path.join(root, documents, name), "utf8"),
    );
    assert.equal(development(value), true, name);
    assert.equal(validate(value), true, name);
    for (const change of [
      (item) => {
        item.issued_at = "2026-02-30T09:00:00Z";
      },
      (item) => {
        item.kind = "unknown";
      },
      (item) => {
        item.extra = true;
      },
      (item) => {
        delete item.payload;
      },
    ]) {
      const invalid = structuredClone(value);
      change(invalid);
      assert.equal(development(invalid), false, name);
      assert.equal(validate(invalid), false, name);
      assert.deepEqual(validate.errors, development.errors, name);
    }
  }
});

test("AST localization rejects executable dependencies but ignores code strings", () => {
  assert.equal(
    localizeRuntime(
      'const a = require("ajv/dist/runtime/ucs2length").default;',
    ),
    'const a = require("./ucs2length.cjs").default;',
  );
  const source = `const a = { code: 'require("unapproved")' }; // require("unapproved")
const b = "import('unapproved')";`;
  assert.equal(localizeRuntime(source), source);
  for (const source of [
    'require("unapproved")',
    'require("./unapproved.cjs")',
    "require(name)",

    'import("unapproved")',
    'import name from "unapproved"',
    'export { name } from "unapproved"',
  ]) {
    assert.throws(() => localizeRuntime(source), /dependency/);
  }
});

test("check CLI fails for missing support, tampering, and injected runtime imports", (t) => {
  const directory = fixture(t);
  buildRuntime({ root: directory, write: true });
  const run = () =>
    spawnSync(
      process.execPath,
      [path.join(root, "scripts/runtime-build.mjs"), "--root", directory],
      { encoding: "utf8", timeout: 15_000 },
    );
  assert.equal(run().status, 0);
  for (const file of outputs) {
    const target = path.join(directory, file);
    const source = fs.readFileSync(target, "utf8");
    fs.rmSync(target);
    const missing = run();
    assert.equal(missing.status, 1, missing.stderr);
    assert.ok(JSON.parse(missing.stdout).mismatches.includes(file));
    fs.writeFileSync(target, `${source}\n// tampered\n`);
    assert.equal(run().status, 1);
    fs.writeFileSync(target, source);
  }
  const validator = path.join(directory, outputs[0]);
  fs.appendFileSync(validator, '\nrequire("unapproved");\n');
  assert.equal(run().status, 1);
  buildRuntime({ root: directory, write: true });
  assert.equal(run().status, 0);
});
