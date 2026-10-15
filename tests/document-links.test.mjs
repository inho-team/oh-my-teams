/** Covers installed guidance and Markdown anchor checks with isolated plugin copies. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validatePlugin } from "../scripts/check-skills.mjs";
import { pluginFixture } from "./helpers/plugin-fixture.mjs";

test("removed runtime commands are rejected in every installed Markdown document", async (t) => {
  for (const file of [
    "references/architecture.md",
    "references/failure-handling.md",
    "skills/kickoff/SKILL.md",
    "GUIDE.md",
  ]) {
    await t.test(file, (context) => {
      const plugin = pluginFixture(context);
      fs.appendFileSync(path.join(plugin, file), "\nRun teams-org.mjs\n");
      const report = validatePlugin(plugin);
      assert.equal(report.status, "failed");
      assert.ok(
        report.findings.some(
          (item) =>
            item.includes("removed runtime command referenced") &&
            item.includes(path.basename(file)),
        ),
      );
    });
  }
});

test("local fragments cover Korean, duplicates, inline formatting, HTML IDs and reference links", (t) => {
  const plugin = pluginFixture(t);
  const file = path.join(plugin, "references/anchors.md");
  fs.writeFileSync(
    file,
    [
      "# 설정 API",
      "# 설정 API",
      "## **Bold** `Code` & punctuation!",
      '<a name="custom"></a><span id="named&amp;anchor"></span>',
      "Setext heading\n---",
      "[local](#설정-api)",
      "[duplicate](#설정-api-1)",
      "[encoded](#%EC%84%A4%EC%A0%95-api)",
      "[format](#bold-code--punctuation)",
      "[html](#custom)",
      "[entity](#named%26anchor)",
      "[setext][target]",
      "[target]: #setext-heading",
      "```md",
      "[ignored](#does-not-exist)",
      "```",
      "\\[escaped](#does-not-exist)",
    ].join("\n\n"),
  );
  fs.appendFileSync(
    path.join(plugin, "references/architecture.md"),
    "\n[cross file](anchors.md?view=1#설정-api-1)\n",
  );
  assert.deepEqual(validatePlugin(plugin).findings, []);
  fs.appendFileSync(
    file,
    "\n[missing](#absent)\n[bad](#%ZZ)\n[missing cross file](failure-handling.md#absent)\n",
  );
  const report = validatePlugin(plugin);
  assert.equal(report.status, "failed");
  assert.ok(
    report.findings.some((item) => item.includes("broken anchor #absent")),
  );
  assert.ok(
    report.findings.some((item) => item.includes("invalid link encoding #%ZZ")),
  );
  assert.ok(
    report.findings.some((item) =>
      item.includes("broken anchor failure-handling.md#absent"),
    ),
  );
});

test("only real headings and HTML anchors count; skill YAML is excluded", (t) => {
  const plugin = pluginFixture(t);
  fs.appendFileSync(
    path.join(plugin, "skills/kickoff/SKILL.md"),
    "\n[false YAML heading](#name-kickoff)\n",
  );
  const file = path.join(plugin, "references/anchors.md");
  fs.writeFileSync(
    file,
    '```md\n# fake\n<a id="fake-html"></a>\n```\n\n[bad](#fake)\n[bad](#fake-html)\n',
  );
  const report = validatePlugin(plugin);
  assert.equal(
    report.findings.filter((item) => item.includes("broken anchor")).length,
    3,
  );
});
