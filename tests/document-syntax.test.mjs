/** Covers known YAML conversion errors and preserves unexpected adapter failures. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Document } from "yaml";
import { skillMetadata } from "../scripts/adapters/document-syntax.mjs";
import { validatePlugin } from "../scripts/check-skills.mjs";
import { pluginFixture } from "./helpers/plugin-fixture.mjs";

test("unresolved, forward and excessive YAML aliases become structured plugin findings", async (t) => {
  for (const header of [
    "name: kickoff\ndescription: *missing",
    "name: kickoff\ndescription: *later\nextra: &later text",
    `name: kickoff\ndescription: &text value\nextra: [${Array(110).fill("*text").join(", ")}]`,
  ]) {
    await t.test(header.slice(0, 60), (context) => {
      const plugin = pluginFixture(context);
      fs.writeFileSync(
        path.join(plugin, "skills/kickoff/SKILL.md"),
        `---\n${header}\n---\n`,
      );
      const report = validatePlugin(plugin);
      assert.equal(report.status, "failed");
      assert.ok(
        report.findings.some((finding) =>
          finding.includes("kickoff: invalid YAML:"),
        ),
      );
    });
  }
});

test("valid anchors remain supported", () => {
  const metadata = skillMetadata(
    "---\nname: kickoff\nlabel: &text valid description\ndescription: *text\n---\n",
  );
  assert.equal(metadata.description, "valid description");
});

test("unexpected conversion errors are propagated unchanged", async (t) => {
  for (const error of [
    new TypeError("implementation bug"),
    new ReferenceError("unknown parser failure"),
  ]) {
    await t.test(error.name, (context) => {
      context.mock.method(Document.prototype, "toJS", () => {
        throw error;
      });
      assert.throws(
        () => skillMetadata("---\nname: kickoff\ndescription: text\n---\n"),
        (caught) => caught === error,
      );
    });
  }
});
