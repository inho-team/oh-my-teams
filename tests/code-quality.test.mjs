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

test("team skills are primary and org names remain compatibility aliases", () => {
  const skills = path.resolve("plugins/oh-my-teams/skills");
  for (const action of ["setup", "show", "edit"]) {
    const primary = fs.readFileSync(
      path.join(skills, `team-${action}`, "SKILL.md"),
      "utf8",
    );
    const alias = fs.readFileSync(
      path.join(skills, `org-${action}`, "SKILL.md"),
      "utf8",
    );
    assert.match(primary, new RegExp(`^name: team-${action}$`, "m"));
    assert.match(alias, new RegExp(`^name: org-${action}$`, "m"));
    assert.match(alias, new RegExp(`\\.\\./team-${action}/SKILL\\.md`));
  }
});

test("team lifecycle skills expose one kickoff loop and explicit outcomes", () => {
  const skills = path.resolve("plugins/oh-my-teams/skills");
  for (const action of [
    "help",
    "form",
    "kickoff",
    "status",
    "adjust",
    "close",
    "disband",
  ]) {
    const skill = fs.readFileSync(
      path.join(skills, `team-${action}`, "SKILL.md"),
      "utf8",
    );
    assert.match(skill, new RegExp(`name: team-${action}`));
  }

  const kickoff = fs.readFileSync(
    path.join(skills, "team-kickoff", "SKILL.md"),
    "utf8",
  );
  assert.match(kickoff, /유일한 지속 실행 권한/);
  assert.match(kickoff, /team-close/);
  assert.match(kickoff, /team-disband/);
});

test("the repository's own modules satisfy the audit rules", () => {
  const report = auditDirectory();
  const offenders = report.files
    .filter((file) => file.findings.length)
    .map((file) => `${file.file}: ${file.findings.join("; ")}`);
  assert.deepEqual(offenders, []);
  assert.equal(report.status, "passed");
  assert.ok(report.totals.files > 0, "the audit must inspect real modules");
});
