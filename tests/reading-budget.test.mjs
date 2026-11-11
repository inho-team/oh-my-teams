/** Covers the skill reading measurement and its ceilings with isolated plugin copies. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateReading } from "../scripts/check-reading.mjs";
import {
  budgetFindings,
  countCharacters,
} from "../scripts/core/reading-budget.mjs";
import { pluginFixture } from "./helpers/plugin-fixture.mjs";

const sizes = (report) =>
  Object.fromEntries(
    report.skills.map((item) => [item.skill, item.characters]),
  );
const skillFile = (plugin, skill) =>
  path.join(plugin, "skills", skill, "SKILL.md");

test("the bundled plugin stays within the repository ceilings", () => {
  const report = validateReading();
  assert.deepEqual(report.findings, []);
  assert.equal(report.status, "passed");
  assert.equal(report.unit, "unicode-code-points");
  assert.equal(report.skills.length, 7);
  for (const item of report.skills) {
    assert.equal(item.documents[0].file, "SKILL.md");
    assert.equal(item.body, item.documents[0].characters);
    assert.equal(
      item.characters,
      item.documents.reduce((sum, entry) => sum + entry.characters, 0),
    );
    assert.ok(item.characters <= item.ceiling, item.skill);
  }
});

test("a new direct link raises only the linking skill and exceeds its ceiling", (t) => {
  const plugin = pluginFixture(t);
  const before = validateReading(plugin, { ceilings: {} });
  const ceilings = sizes(before);
  fs.writeFileSync(path.join(plugin, "references/large.md"), "가".repeat(500));
  fs.appendFileSync(
    skillFile(plugin, "status"),
    "\n[Large reference](../../references/large.md)\n",
  );
  const added = countCharacters(
    "\n[Large reference](../../references/large.md)\n",
  );
  const after = validateReading(plugin, { ceilings });
  const expected = { ...ceilings, status: ceilings.status + 500 + added };
  assert.deepEqual(sizes(after), expected);
  assert.equal(after.status, "failed");
  assert.equal(after.findings.length, 1);
  assert.match(after.findings[0], /^status: reads \d+ characters, ceiling \d+/);
  assert.ok(after.findings[0].includes("document.schema.json"));
});

test("repeated, external, fragment-only and missing links add no linked file", (t) => {
  const plugin = pluginFixture(t);
  const file = skillFile(plugin, "help");
  const linked = (report) =>
    report.skills.find((item) => item.skill === "help").documents.length;
  const before = linked(validateReading(plugin, { ceilings: {} }));
  fs.appendFileSync(
    file,
    [
      "",
      "[again](../../references/architecture.md)",
      "[fragment](../../references/architecture.md#소유권)",
      "[query](../../references/architecture.md?view=1)",
      "[self](#oh-my-teams-도움말)",
      "[itself](SKILL.md)",
      "[external](https://example.invalid/document.md)",
      "[missing](../../references/missing.md)",
      "[directory](../../references/)",
      "```md",
      "[code](../../references/failure-handling.md)",
      "```",
      "",
    ].join("\n\n"),
  );
  assert.equal(linked(validateReading(plugin, { ceilings: {} })), before);
});

test("a link that leaves the plugin is not measured", (t) => {
  const plugin = pluginFixture(t);
  fs.writeFileSync(path.join(plugin, "..", "outside.md"), "x".repeat(900));
  const before = sizes(validateReading(plugin, { ceilings: {} })).help;
  const link = "\n[outside](../../../outside.md)\n";
  fs.appendFileSync(skillFile(plugin, "help"), link);
  const after = sizes(validateReading(plugin, { ceilings: {} })).help;
  assert.equal(after, before + countCharacters(link));
});

test("line endings and a byte order mark do not change the measurement", (t) => {
  const plugin = pluginFixture(t);
  const before = sizes(validateReading(plugin, { ceilings: {} }));
  for (const skill of ["kickoff", "status"]) {
    const file = skillFile(plugin, skill);
    const source = fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
    fs.writeFileSync(file, `﻿${source.replaceAll("\n", "\r\n")}`);
  }
  assert.deepEqual(sizes(validateReading(plugin, { ceilings: {} })), before);
});

test("characters are counted as code points", () => {
  assert.equal(countCharacters("가나다"), 3);
  assert.equal(countCharacters("a😀b"), 3);
  assert.equal(countCharacters("﻿a\r\nb"), 3);
  assert.equal(countCharacters(""), 0);
});

test("ceilings must cover exactly the installed skills with valid numbers", () => {
  const documents = [{ file: "SKILL.md", characters: 10 }];
  const measured = [
    { skill: "alpha", characters: 10, documents },
    { skill: "beta", characters: 10, documents },
  ];
  assert.deepEqual(budgetFindings(measured, { alpha: 10, beta: 10 }), []);
  assert.deepEqual(budgetFindings(measured, { alpha: 10 }), [
    "beta: reading ceiling missing",
  ]);
  assert.deepEqual(budgetFindings(measured, { alpha: 10, beta: 10, old: 5 }), [
    "old: reading ceiling names a skill not installed",
  ]);
  assert.deepEqual(budgetFindings(measured, { alpha: 10, beta: "10" }), [
    "beta: reading ceiling must be a nonnegative integer",
  ]);
  assert.deepEqual(budgetFindings(measured, { alpha: 9, beta: 10 }), [
    "alpha: reads 10 characters, ceiling 9; largest: SKILL.md 10",
  ]);
});

test("lowering one ceiling fails only that skill and reports the applied ceiling", (t) => {
  const plugin = pluginFixture(t);
  const ceilings = sizes(validateReading(plugin, { ceilings: {} }));
  const lowered = { ...ceilings, kickoff: ceilings.kickoff - 1 };
  const report = validateReading(plugin, { ceilings: lowered });
  assert.equal(report.status, "failed");
  assert.equal(report.findings.length, 1);
  assert.ok(report.findings[0].startsWith("kickoff: reads "));
  assert.equal(
    report.skills.find((item) => item.skill === "kickoff").ceiling,
    lowered.kickoff,
  );
});

test("the command line prints the report and succeeds for the bundled plugin", () => {
  const script = fileURLToPath(
    new URL("../scripts/check-reading.mjs", import.meta.url),
  );
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "passed");
  assert.deepEqual(report.findings, []);
  assert.equal(report.skills.length, 7);
});
