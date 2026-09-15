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

test("the lifecycle skills hold the procedure and the aliases only forward", () => {
  const skills = path.resolve("plugins/oh-my-teams/skills");
  const read = (name) =>
    fs.readFileSync(path.join(skills, name, "SKILL.md"), "utf8");

  // The hierarchy was inverted once: team-form, team-status and team-adjust
  // were eight-line wrappers sending the reader to team-setup, while team-setup
  // carried the procedure and called itself a compatibility entry point. A
  // reader following either name bounced between two files.
  const pairs = [
    ["team-form", ["team-setup", "org-setup"]],
    ["team-status", ["team-show", "org-show"]],
    ["team-adjust", ["team-edit", "org-edit"]],
  ];
  for (const [primary, aliases] of pairs) {
    const body = read(primary);
    assert.match(body, new RegExp(`^name: ${primary}$`, "m"));
    assert.ok(
      body.split(/\r?\n/).length > 15,
      `${primary} must carry the procedure itself`,
    );
    for (const alias of aliases) {
      const text = read(alias);
      assert.match(text, new RegExp(`^name: ${alias}$`, "m"));
      assert.match(text, new RegExp(`\\.\\./${primary}/SKILL\\.md`));
      assert.ok(
        text.split(/\r?\n/).length <= 12,
        `${alias} must stay a thin alias`,
      );
      // An alias repeating a command would drift from the primary unnoticed.
      assert.ok(
        !text.includes("node <runtime>"),
        `${alias} must not duplicate the procedure`,
      );
    }
  }
});

test("no skill sends a reader to a compatibility name for the procedure", () => {
  const skills = path.resolve("plugins/oh-my-teams/skills");
  const aliases = ["team-setup", "team-show", "team-edit"];
  // team-help lists the compatibility names on purpose: that table is what it
  // exists to show.
  const listsAliases = new Set(["team-help"]);
  for (const entry of fs.readdirSync(skills)) {
    if (aliases.includes(entry) || entry.startsWith("org-")) continue;
    if (listsAliases.has(entry)) continue;
    // A runtime state directory such as `.omc/` can sit beside the skills, so
    // only a directory that actually holds a SKILL.md is a skill.
    const file = path.join(skills, entry, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const alias of aliases) {
      assert.ok(
        !text.includes(`\`${alias}\``),
        `${entry} must name the primary skill, not ${alias}`,
      );
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

test("the help tables list exactly the installed skills", () => {
  const skills = path.resolve("plugins/oh-my-teams/skills");
  const installed = fs
    .readdirSync(skills)
    .filter((entry) => fs.existsSync(path.join(skills, entry, "SKILL.md")));
  const help = fs.readFileSync(
    path.join(skills, "team-help", "SKILL.md"),
    "utf8",
  );
  const rendered = help.split("<!-- team-help:start -->")[1];
  assert.ok(rendered, "the help output must be delimited for the drift check");

  // The tables are precomputed so that answering team-help costs one already
  // loaded file instead of reading every skill. That trade is only safe while
  // something checks the tables against the skills that are actually there.
  const listed = new Set(
    [...rendered.matchAll(/`([a-z-]+)`/g)].map((match) => match[1]),
  );
  for (const skill of installed) {
    assert.ok(listed.has(skill), `team-help must list ${skill}`);
  }
  for (const name of listed) {
    if (!installed.includes(name)) continue;
    assert.ok(
      fs.existsSync(path.join(skills, name, "SKILL.md")),
      `team-help must not list a skill that is gone: ${name}`,
    );
  }

  // A name that looks like a skill but is not installed would send the reader
  // to something that does not exist.
  const skillShaped = [...listed].filter((name) =>
    /^(team|org)-|^(pm|pl|senior|junior|intern|director|fluent-korean)$/.test(
      name,
    ),
  );
  for (const name of skillShaped) {
    assert.ok(
      installed.includes(name),
      `team-help names ${name}, which is not installed`,
    );
  }
});

test("team-help does not ask the model to rebuild what it already states", () => {
  const help = fs.readFileSync(
    path.resolve("plugins/oh-my-teams/skills/team-help/SKILL.md"),
    "utf8",
  );
  const instructions = help.split("<!-- team-help:start -->")[0];
  // Reading all twenty SKILL.md files cost about 48KB to produce 3KB of table,
  // and the wording of each row changed on every call.
  assert.ok(
    !/skills\/\*\/SKILL\.md|frontmatter를 읽/.test(instructions),
    "the instructions must not send the model back to every skill file",
  );
  assert.match(instructions, /그대로 출력한다/);
});
