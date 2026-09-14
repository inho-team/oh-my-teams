/** Regression tests for the source quality audit rules. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  auditDirectory,
  functionSignature,
  longExecutableLines,
  signatureHasParameters,
} from "../scripts/check-code-quality.mjs";

function fixture(source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quality-audit-"));
  fs.writeFileSync(path.join(directory, "fixture.mjs"), source);
  return { directory, file: path.join(directory, "fixture.mjs") };
}

test("multiline and destructured exported functions require both tags", (t) => {
  const item = fixture(`/** Fixture module. */
/** Deliberately incomplete documentation. */
export function combine(
  { left, right },
) {
  return left + right;
}
`);
  t.after(() => fs.rmSync(item.directory, { recursive: true, force: true }));

  const report = auditDirectory(item.directory).files[0];
  assert.ok(
    report.findings.some((finding) => finding.includes("combine lacks @param")),
  );
  assert.ok(
    report.findings.some((finding) =>
      finding.includes("combine lacks @returns"),
    ),
  );
});

test("multiline exported arrows are audited like function declarations", (t) => {
  const item = fixture(`/** Fixture module. */
/** Incomplete arrow documentation. */
export const pick = (
  { value },
) => value;
`);
  t.after(() => fs.rmSync(item.directory, { recursive: true, force: true }));

  const report = auditDirectory(item.directory).files[0];
  assert.equal(report.publicExports, 1);
  assert.ok(
    report.findings.some((finding) => finding.includes("pick lacks @param")),
  );
  assert.ok(
    report.findings.some((finding) => finding.includes("pick lacks @returns")),
  );
});

test("a long executable statement containing a template is not exempt", () => {
  const line = `const value = \`${"x".repeat(190)}\`;`;
  assert.deepEqual(longExecutableLines([line]), [
    { line: 1, length: line.length },
  ]);
});

test("signature helpers handle multiline parameters and single arrow parameters", () => {
  const signature = functionSignature(
    ["export const read = (", "  { id },", ") => value;"],
    0,
  );
  assert.equal(signatureHasParameters(signature), true);
  assert.equal(
    signatureHasParameters("export const read = item => value;"),
    true,
  );
});
