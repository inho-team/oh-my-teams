/** Covers document card generation and synchronization with isolated plugin copies. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { synchronizeCards } from "../scripts/cards.mjs";
import { validatePlugin } from "../scripts/check-skills.mjs";
import { createNodeFiles } from "../scripts/adapters/node-files.mjs";
import { renderDocumentCards } from "../scripts/core/document-cards.mjs";
import { parseOmtYaml } from "../scripts/adapters/omt-documents.mjs";
import {
  pluginFixture,
  temporaryDirectory,
} from "./helpers/plugin-fixture.mjs";

const documents = (plugin) => path.join(plugin, "references", "documents");
const cardFile = (plugin, name) => path.join(documents(plugin), "cards", name);
const schemaFile = (plugin) =>
  path.join(documents(plugin), "document.schema.json");
const readSchema = (plugin) =>
  JSON.parse(fs.readFileSync(schemaFile(plugin), "utf8"));
const writeSchema = (plugin, schema) =>
  fs.writeFileSync(schemaFile(plugin), `${JSON.stringify(schema, null, 2)}\n`);
const readProtocol = (plugin) =>
  parseOmtYaml(
    fs.readFileSync(path.join(documents(plugin), "protocol.yaml"), "utf8"),
  );
const names = [
  "common.md",
  "completion-report.md",
  "interruption-report.md",
  "review-request.md",
  "review-result.md",
  "status-report.md",
  "task-request.md",
];

function collect(schema, node, found) {
  const reference = /^#\/definitions\/(.+)$/.exec(node.$ref ?? "")?.[1];
  if (reference) {
    collect(schema, schema.definitions[reference], found);
    return;
  }
  for (const value of node.enum ?? []) found.values.add(value);
  for (const option of node.anyOf ?? []) collect(schema, option, found);
  if (node.items) collect(schema, node.items, found);
  const required = new Set(node.required ?? []);
  for (const [name, property] of Object.entries(node.properties ?? {})) {
    found.fields.add(required.has(name) ? `${name}:` : `${name}?:`);
    collect(schema, property, found);
  }
}

test("the bundled cards match the schema and usage rules", () => {
  assert.deepEqual(synchronizeCards(), { changed: [], mismatches: [] });
});

test("each card states every payload field, its optionality and every allowed value", (t) => {
  const plugin = pluginFixture(t);
  const schema = readSchema(plugin);
  const cards = renderDocumentCards(schema, readProtocol(plugin));
  assert.deepEqual(cards.map((card) => card.name).sort(), names);
  for (const branch of schema.allOf) {
    const kind = branch.if.properties.kind.const;
    const card = cards.find(
      (item) => item.name === `${kind.replaceAll("_", "-")}.md`,
    );
    const lines = card.text.split("\n").map((line) => line.trim());
    const words = new Set(card.text.split(/[\s|]+/));
    const found = { fields: new Set(), values: new Set() };
    collect(schema, branch.then.properties.payload, found);
    assert.ok(found.fields.size > 5, kind);
    for (const field of found.fields)
      assert.ok(
        lines.some((line) => line.startsWith(field)),
        `${kind}: ${field}`,
      );
    for (const value of found.values)
      assert.ok(words.has(value), `${kind}: ${value}`);
    assert.ok(lines.includes(`kind: ${kind}`));
    const reply = (branch.then.required ?? []).includes("in_reply_to");
    assert.ok(
      lines.some((line) =>
        line.startsWith(reply ? "in_reply_to:" : "in_reply_to?:"),
      ),
      kind,
    );
  }
});

test("a schema change is reported until the cards are regenerated", (t) => {
  const plugin = pluginFixture(t);
  const options = { pluginRoot: plugin };
  const schema = readSchema(plugin);
  schema.definitions.statusReport.properties.note = {
    $ref: "#/definitions/text",
  };
  schema.definitions.statusReport.properties.execution.enum.push("paused");
  writeSchema(plugin, schema);
  assert.deepEqual(synchronizeCards(false, options), {
    changed: [],
    mismatches: ["status-report.md"],
  });
  assert.deepEqual(synchronizeCards(true, options), {
    changed: ["status-report.md"],
    mismatches: [],
  });
  const lines = fs
    .readFileSync(cardFile(plugin, "status-report.md"), "utf8")
    .split("\n");
  assert.ok(lines.includes("  note?: 문자열"));
  assert.ok(lines.some((line) => line.endsWith("| stopped | paused")));
  assert.deepEqual(synchronizeCards(false, options), {
    changed: [],
    mismatches: [],
  });
  assert.deepEqual(synchronizeCards(true, options), {
    changed: [],
    mismatches: [],
  });
});

test("a usage rule change reaches only the cards that restate it", (t) => {
  const plugin = pluginFixture(t);
  const file = path.join(documents(plugin), "protocol.yaml");
  const source = fs.readFileSync(file, "utf8");
  const rule = "stopped는 실제 종료가 확인된 exited 세션에만 사용합니다.";
  assert.ok(source.includes(rule));
  fs.writeFileSync(file, source.replace(rule, `${rule} 추가한 문장입니다.`));
  assert.deepEqual(synchronizeCards(false, { pluginRoot: plugin }).mismatches, [
    "interruption-report.md",
  ]);
});

test("hand edits, Windows line endings and stray files are told apart", (t) => {
  const plugin = pluginFixture(t);
  const options = { pluginRoot: plugin };
  const edited = cardFile(plugin, "task-request.md");
  const original = fs.readFileSync(edited, "utf8").replaceAll("\r\n", "\n");
  fs.writeFileSync(edited, original.replaceAll("\n", "\r\n"));
  assert.deepEqual(synchronizeCards(false, options).mismatches, []);
  fs.writeFileSync(edited, `${original}\n직접 추가한 문장입니다.\n`);
  const stray = cardFile(plugin, "notes.md");
  fs.writeFileSync(stray, "생성하지 않은 파일입니다.\n");
  assert.deepEqual(synchronizeCards(false, options).mismatches, [
    "task-request.md",
    "notes.md: not generated",
  ]);
  assert.deepEqual(synchronizeCards(true, options), {
    changed: ["task-request.md"],
    mismatches: ["notes.md: not generated"],
  });
  assert.equal(fs.readFileSync(edited, "utf8"), original);
  assert.equal(fs.readFileSync(stray, "utf8"), "생성하지 않은 파일입니다.\n");
});

test("missing cards are created without touching the other documents", (t) => {
  const plugin = pluginFixture(t);
  const options = { pluginRoot: plugin };
  const before = fs.readdirSync(documents(plugin)).sort();
  fs.rmSync(path.join(documents(plugin), "cards"), { recursive: true });
  assert.deepEqual(synchronizeCards(false, options).mismatches, names);
  assert.deepEqual(synchronizeCards(true, options), {
    changed: names,
    mismatches: [],
  });
  assert.deepEqual(fs.readdirSync(documents(plugin)).sort(), before);
  assert.deepEqual(validatePlugin(plugin).findings, []);
});

test("schema constructs the cards cannot express stop generation", (t) => {
  const plugin = pluginFixture(t);
  const protocol = readProtocol(plugin);
  const cases = [
    (schema) => {
      schema.definitions.statusReport.properties.count = { type: "integer" };
    },
    (schema) => {
      schema.definitions.statusReport.properties.other = {
        $ref: "other.json#/definitions/text",
      };
    },
    (schema) => {
      schema.properties.kind.enum.push("extra_report");
    },
    (schema) => {
      schema.allOf[2].then.properties.payload = {
        $ref: "#/definitions/reviewRequest",
      };
    },
  ];
  for (const change of cases) {
    const schema = readSchema(plugin);
    change(schema);
    assert.throws(() => renderDocumentCards(schema, protocol), TypeError);
  }
  const incomplete = { ...protocol, status_rules: undefined };
  assert.throws(() => renderDocumentCards(readSchema(plugin), incomplete), {
    name: "TypeError",
    message: "usage rules missing: status_rules",
  });
});

test("new files are created with their directories and never overwrite", (t) => {
  const files = createNodeFiles();
  const file = path.join(temporaryDirectory(t), "nested", "deeper", "card.md");
  files.createText(file, "첫 내용\n");
  assert.equal(fs.readFileSync(file, "utf8"), "첫 내용\n");
  assert.throws(() => files.createText(file, "다른 내용\n"), {
    code: "EEXIST",
  });
  assert.equal(fs.readFileSync(file, "utf8"), "첫 내용\n");
});
