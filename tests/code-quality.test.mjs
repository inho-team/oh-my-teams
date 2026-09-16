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
import { removedSkillNames } from "./removed-skills.mjs";

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

test("the lifecycle skills hold the procedure themselves", () => {
  const skills = path.resolve("plugins/oh-my-teams/skills");
  // The hierarchy was inverted once: form, status and adjust were eight-line
  // wrappers sending the reader to an alias that carried the procedure and
  // called itself a compatibility entry point, so a reader following either
  // name bounced between two files. 2.0.0 removed every alias, which only
  // makes that inversion worse if it comes back: the wrapper would now point
  // at a name that is not installed at all.
  for (const name of ["form", "status", "adjust", "close", "disband"]) {
    const body = fs.readFileSync(path.join(skills, name, "SKILL.md"), "utf8");
    assert.match(body, new RegExp(`^name: ${name}$`, "m"));
    assert.ok(
      body.split(/\r?\n/).length > 15,
      `${name} must carry the procedure itself`,
    );
  }
});

test("the names 2.0.0 removed are gone and nothing tells the user to run them", () => {
  const skills = path.resolve("plugins/oh-my-teams/skills");
  // help states the mapping so a user arriving with an old name is redirected,
  // and it writes the removed names as plain text while every installed skill
  // is written in backticks. That spelling is what separates "this name is
  // gone" from "run this name", so the guard below reads backticks only.
  const removed = removedSkillNames();
  assert.ok(removed.length >= 7, "the help table must list the removed names");

  for (const name of removed) {
    assert.ok(
      !fs.existsSync(path.join(skills, name, "SKILL.md")),
      `${name} was removed in 2.0.0 but is still installed`,
    );
  }

  const roots = [skills, path.resolve("plugins/oh-my-teams/references")];
  for (const root of roots) {
    for (const entry of fs.readdirSync(root)) {
      const file = fs.statSync(path.join(root, entry)).isDirectory()
        ? path.join(root, entry, "SKILL.md")
        : path.join(root, entry);
      if (!file.endsWith(".md") || !fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const name of removed) {
        assert.ok(
          !text.includes(`\`${name}\``),
          `${path.basename(file)} names the removed ${name} as a skill to run`,
        );
      }
    }
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
      path.join(skills, action, "SKILL.md"),
      "utf8",
    );
    assert.match(skill, new RegExp(`^name: ${action}$`, "m"));
  }

  const kickoff = fs.readFileSync(
    path.join(skills, "kickoff", "SKILL.md"),
    "utf8",
  );
  assert.match(kickoff, /유일한 지속 실행 권한/);
  // The names are now ordinary words, so a bare match would pass on any
  // sentence that happens to contain them; only the backticked call counts.
  assert.match(kickoff, /`close`/);
  assert.match(kickoff, /`disband`/);
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

test("the help tables list exactly the installed skills", () => {
  const skills = path.resolve("plugins/oh-my-teams/skills");
  const installed = fs
    .readdirSync(skills)
    .filter((entry) => fs.existsSync(path.join(skills, entry, "SKILL.md")));
  const help = fs.readFileSync(path.join(skills, "help", "SKILL.md"), "utf8");
  const rendered = help.split("<!-- help:start -->")[1];
  assert.ok(rendered, "the help output must be delimited for the drift check");

  // The tables are precomputed so that answering help costs one already
  // loaded file instead of reading every skill. That trade is only safe while
  // something checks the tables against the skills that are actually there.
  const listed = new Set(
    [...rendered.matchAll(/`([a-z-]+)`/g)].map((match) => match[1]),
  );
  for (const skill of installed) {
    assert.ok(listed.has(skill), `help must list ${skill}`);
  }
  for (const name of listed) {
    if (!installed.includes(name)) continue;
    assert.ok(
      fs.existsSync(path.join(skills, name, "SKILL.md")),
      `help must not list a skill that is gone: ${name}`,
    );
  }

  // The removed-names table redirects an old call to the name that replaced
  // it, so a typo in its right column would send the reader to nothing. The
  // left column is checked elsewhere; here only the destinations matter.
  const mapping = rendered.split("## 2.0.0에서 삭제된 이름")[1] ?? "";
  const destinations = new Set(
    [...mapping.split("\n## ")[0].matchAll(/`([a-z-]+)`/g)].map(
      (match) => match[1],
    ),
  );
  assert.ok(destinations.size > 0, "the removed-names table must redirect");
  for (const name of destinations) {
    assert.ok(
      installed.includes(name),
      `the removed-names table sends the reader to ${name}, which is not installed`,
    );
  }
});

test("help does not ask the model to rebuild what it already states", () => {
  const help = fs.readFileSync(
    path.resolve("plugins/oh-my-teams/skills/help/SKILL.md"),
    "utf8",
  );
  const instructions = help.split("<!-- help:start -->")[0];
  // Reading every SKILL.md file cost about 48KB to produce 3KB of table,
  // and the wording of each row changed on every call.
  assert.ok(
    !/skills\/\*\/SKILL\.md|frontmatter를 읽/.test(instructions),
    "the instructions must not send the model back to every skill file",
  );
  assert.match(instructions, /그대로 출력한다/);
});
