/** Runnable examples for extending package validation with isolated fixtures. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validatePlugin } from "../scripts/check-skills.mjs";
import {
  pluginFixture,
  editManifest,
} from "../tests/helpers/plugin-fixture.mjs";

test("example: configure a bundled manifest entry point", (t) => {
  const plugin = pluginFixture(t);
  editManifest(plugin, "claude", { skills: ["./skills/"] });
  assert.deepEqual(validatePlugin(plugin), {
    status: "passed",
    skills: 7,
    findings: [],
  });
});

test("example: assert a specific failure after changing one document", (t) => {
  const plugin = pluginFixture(t);
  fs.appendFileSync(
    path.join(plugin, "references/architecture.md"),
    "\n[Guide](missing-guide.md)\n",
  );
  const report = validatePlugin(plugin);
  assert.equal(report.status, "failed");
  assert.ok(
    report.findings.some((finding) =>
      finding.includes("broken link missing-guide.md"),
    ),
  );
});
