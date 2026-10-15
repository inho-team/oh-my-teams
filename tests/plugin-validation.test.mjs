/** Regression checks for malformed plugin entry points and document syntax. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validatePlugin } from "../scripts/check-skills.mjs";
import { createNodeFiles } from "../scripts/adapters/node-files.mjs";
import { createDocumentSyntax } from "../scripts/adapters/document-syntax.mjs";
import {
  pluginFixture as fixture,
  editManifest,
} from "./helpers/plugin-fixture.mjs";

test("Codex cannot point to a missing skills directory", (t) => {
  const plugin = fixture(t);
  editManifest(plugin, "codex", { skills: "./missing-skills/" });
  const report = validatePlugin(plugin);
  assert.equal(report.status, "failed");
  assert.ok(
    report.findings.some((item) => item.includes(".codex-plugin/plugin.json")),
  );
});

test("an unterminated YAML description is rejected", (t) => {
  const plugin = fixture(t);
  const file = path.join(plugin, "skills/kickoff/SKILL.md");
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, "utf8")
      .replace(/^description:.*$/m, 'description: "unterminated'),
  );
  const report = validatePlugin(plugin);
  assert.equal(report.status, "failed");
  assert.ok(report.findings.some((item) => item.includes("invalid YAML")));
});

test("missing reference-style Markdown destinations are rejected", (t) => {
  const plugin = fixture(t);
  fs.appendFileSync(
    path.join(plugin, "skills/kickoff/SKILL.md"),
    "\n[Required document][required]\n\n[required]: missing.md\n",
  );
  const report = validatePlugin(plugin);
  assert.equal(report.status, "failed");
  assert.ok(
    report.findings.some((item) => item.includes("broken link missing.md")),
  );
});

test("both host manifests reject malformed metadata and skill entry points", async (t) => {
  for (const host of ["claude", "codex"]) {
    const cases = [
      ["wrong name", { name: "other-plugin" }],
      ["missing version", { version: null }],
      ["wrong path type", { skills: 42 }],
      ["missing directory", { skills: "./absent/" }],
      ["file instead of directory", { skills: "./skills/kickoff/SKILL.md" }],
      ["different scan directory", { skills: "./references/" }],
    ];
    if (host === "codex") cases.push(["missing skills", { skills: undefined }]);
    else cases.push(["empty skills", { skills: [] }]);
    for (const [label, update] of cases) {
      await t.test(`${host}: ${label}`, (context) => {
        const plugin = fixture(context);
        editManifest(plugin, host, update);
        const report = validatePlugin(plugin);
        assert.equal(report.status, "failed");
        assert.ok(
          report.findings.some((item) =>
            item.startsWith(`.${host}-plugin/plugin.json:`),
          ),
        );
      });
    }
    for (const [label, contents] of [
      ["invalid JSON", "{"],
      ["non-object JSON", "null"],
    ]) {
      await t.test(`${host}: ${label}`, (context) => {
        const plugin = fixture(context);
        fs.writeFileSync(
          path.join(plugin, `.${host}-plugin/plugin.json`),
          contents,
        );
        const report = validatePlugin(plugin);
        assert.equal(report.status, "failed");
        assert.ok(
          report.findings.some((item) =>
            item.startsWith(`.${host}-plugin/plugin.json:`),
          ),
        );
      });
    }
    await t.test(`${host}: missing manifest`, (context) => {
      const plugin = fixture(context);
      fs.unlinkSync(path.join(plugin, `.${host}-plugin/plugin.json`));
      assert.equal(validatePlugin(plugin).status, "failed");
    });
  }
});

test("manifest entry points cannot escape through an existing sibling directory", (t) => {
  const plugin = fixture(t);
  fs.mkdirSync(path.join(plugin, "..", "external-skills"));
  editManifest(plugin, "codex", { skills: "./../external-skills/" });
  const report = validatePlugin(plugin);
  assert.equal(report.status, "failed");
  assert.ok(
    report.findings.some((item) => item.includes("skills path outside plugin")),
  );
});

test("manifest entry points cannot escape through a directory link", (t) => {
  const plugin = fixture(t);
  const external = path.join(plugin, "..", "external-skills");
  fs.mkdirSync(external);
  fs.symlinkSync(external, path.join(plugin, "linked-skills"), "junction");
  editManifest(plugin, "codex", { skills: "./linked-skills/" });
  const report = validatePlugin(plugin);
  assert.equal(report.status, "failed");
  assert.ok(
    report.findings.some((item) => item.includes("skills path outside plugin")),
  );
});

test("Claude can declare the bundled skills using a path or an array", (t) => {
  const plugin = fixture(t);
  for (const skills of ["./skills/", ["./skills/"]]) {
    editManifest(plugin, "claude", { skills });
    assert.equal(validatePlugin(plugin).status, "passed");
  }
});

test("quoted names and folded descriptions remain valid YAML metadata", (t) => {
  const plugin = fixture(t);
  const file = path.join(plugin, "skills/kickoff/SKILL.md");
  fs.writeFileSync(
    file,
    '\uFEFF---\r\nname: "kickoff"\r\ndescription: >-\r\n  First line\r\n  second line\r\n---\r\n# Kickoff\r\n',
  );
  assert.equal(validatePlugin(plugin).status, "passed");
});

test("invalid YAML mappings and non-string descriptions are rejected", async (t) => {
  const cases = [
    [
      "duplicate keys",
      "name: kickoff\ndescription: first\ndescription: second",
    ],
    ["non-mapping header", "- kickoff\n- description"],
    ["non-string description", "name: kickoff\ndescription: [one, two]"],
    ["empty description", 'name: kickoff\ndescription: "  "'],
    ["unknown YAML tag", "name: kickoff\ndescription: !unknown text"],
  ];
  for (const [label, header] of cases) {
    await t.test(label, (context) => {
      const plugin = fixture(context);
      fs.writeFileSync(
        path.join(plugin, "skills/kickoff/SKILL.md"),
        `---\n${header}\n---\n# Kickoff\n`,
      );
      assert.equal(validatePlugin(plugin).status, "failed");
    });
  }
});

test("Markdown references and percent-encoded destinations resolve inside the plugin", (t) => {
  const plugin = fixture(t);
  fs.writeFileSync(path.join(plugin, "references/guide (1).md"), "# Guide\n");
  fs.appendFileSync(
    path.join(plugin, "references/architecture.md"),
    '\n[Guide][guide]\n![Guide][guide]\n[guide][]\n\n[guide]: <guide (1).md> "Guide title"\n\n[Encoded](guide%20%281%29.md#guide)\n',
  );
  assert.equal(validatePlugin(plugin).status, "passed");
});

test("code examples, escaped brackets and frontmatter are not Markdown links", (t) => {
  const plugin = fixture(t);
  const file = path.join(plugin, "skills/kickoff/SKILL.md");
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, "utf8")
      .replace(/^description:.*$/m, 'description: "[example](absent.md)"'),
  );
  fs.appendFileSync(
    file,
    "\n`[example](absent.md)`\n\n```md\n[example][example]\n[example]: absent.md\n```\n\n\\[example](absent.md)\n",
  );
  assert.equal(validatePlugin(plugin).status, "passed");
});

test("reference definitions and encoded links cannot escape the plugin", async (t) => {
  for (const [label, contents] of [
    ["reference", "[Outside][outside]\n\n[outside]: ../../../outside.md"],
    ["encoded path", "[Outside](%2e%2e/%2e%2e/%2e%2e/outside.md)"],
    ["file URL", "[Outside](file:///outside.md)"],
  ]) {
    await t.test(label, (context) => {
      const plugin = fixture(context);
      fs.appendFileSync(
        path.join(plugin, "skills/kickoff/SKILL.md"),
        `\n${contents}\n`,
      );
      const report = validatePlugin(plugin);
      assert.equal(report.status, "failed");
      assert.ok(
        report.findings.some((item) => item.includes("link outside plugin")),
      );
    });
  }
});

test("a missing plugin directory produces a failed report with its path", (t) => {
  const plugin = fixture(t);
  const absent = path.join(plugin, "absent-plugin");
  const report = validatePlugin(absent);
  assert.equal(report.status, "failed");
  assert.equal(report.skills, 0);
  assert.ok(
    report.findings.some(
      (item) => item.includes(absent) && item.includes("ENOENT"),
    ),
  );
});

test("a directory replacing SKILL.md is a reported validation failure", (t) => {
  const plugin = fixture(t);
  const file = path.join(plugin, "skills/kickoff/SKILL.md");
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  const report = validatePlugin(plugin);
  assert.equal(report.status, "failed");
  assert.ok(
    report.findings.some(
      (item) => item.includes("kickoff") && item.includes("not a regular file"),
    ),
  );
});

test("reference documents retain links between leading horizontal rules", async (t) => {
  for (const name of ["example.md", "SKILL.md"]) {
    await t.test(name, (context) => {
      const plugin = fixture(context);
      fs.writeFileSync(
        path.join(plugin, "references", name),
        "---\n[Missing](missing.md)\n---\n",
      );
      const report = validatePlugin(plugin);
      assert.equal(report.status, "failed");
      assert.ok(
        report.findings.some(
          (item) =>
            item.includes(name) && item.includes("broken link missing.md"),
        ),
      );
    });
  }
});

test("a regular file cannot be used as the plugin root", (t) => {
  const plugin = fixture(t);
  const file = path.join(plugin, "root-file");
  fs.writeFileSync(file, "not a directory\n");
  const report = validatePlugin(file);
  assert.equal(report.status, "failed");
  assert.equal(report.skills, 0);
  assert.ok(
    report.findings.some(
      (item) => item.includes(file) && item.includes("not a directory"),
    ),
  );
});

test("filesystem read errors report their code and the affected file", (t) => {
  const plugin = fixture(t);
  const file = path.join(plugin, "skills/kickoff/SKILL.md");
  const files = createNodeFiles();
  const readText = (target) => {
    if (target === file) {
      throw Object.assign(new Error("access denied"), {
        code: "EACCES",
        syscall: "open",
        path: file,
      });
    }
    return files.readText(target);
  };
  const report = validatePlugin(plugin, { files: { ...files, readText } });
  assert.equal(report.status, "failed");
  assert.equal(report.skills, 7);
  assert.ok(
    report.findings.some(
      (item) => item.includes(file) && item.includes("EACCES"),
    ),
  );
});

test("unexpected programming errors are not mislabeled as filesystem failures", (t) => {
  const plugin = fixture(t);
  const file = path.join(plugin, "skills/kickoff/SKILL.md");
  const files = createNodeFiles();
  const unexpected = new TypeError("unexpected validation bug");
  const readText = (target) => {
    if (target === file) throw unexpected;
    return files.readText(target);
  };
  assert.throws(
    () => validatePlugin(plugin, { files: { ...files, readText } }),
    (error) => error === unexpected,
  );
});

test("filesystem diagnostics remain testable through an aliased temporary root", (t) => {
  const outer = fixture(t);
  const temporaryRoot = path.join(outer, "temporary-root");
  const alias = path.join(outer, "temporary-alias");
  fs.mkdirSync(temporaryRoot);
  fs.symlinkSync(temporaryRoot, alias, "junction");
  const plugin = fixture(t, alias);
  const file = path.join(plugin, "skills/kickoff/SKILL.md");
  const files = createNodeFiles();
  const readText = (target) => {
    if (target === file) {
      throw Object.assign(new Error("access denied"), {
        code: "EACCES",
        syscall: "open",
        path: file,
      });
    }
    return files.readText(target);
  };
  const report = validatePlugin(plugin, { files: { ...files, readText } });
  assert.equal(report.status, "failed");
  assert.ok(
    report.findings.some(
      (item) => item.includes(file) && item.includes("EACCES"),
    ),
  );
});

test("manifest reads preserve filesystem diagnostics and propagate programming errors", async (t) => {
  const denied = Object.assign(new Error("access denied"), {
    code: "EACCES",
    syscall: "open",
  });
  const unexpected = new TypeError("unexpected manifest bug");
  for (const error of [denied, unexpected]) {
    await t.test(error.name, (context) => {
      const plugin = fixture(context);
      const file = path.join(plugin, ".claude-plugin/plugin.json");
      const files = createNodeFiles();
      const readText = (target) => {
        if (target === file) {
          if (error.syscall) error.path = file;
          throw error;
        }
        return files.readText(target);
      };
      if (error === unexpected) {
        assert.throws(
          () => validatePlugin(plugin, { files: { ...files, readText } }),
          (caught) => caught === error,
        );
      } else {
        const report = validatePlugin(plugin, {
          files: { ...files, readText },
        });
        assert.equal(report.status, "failed");
        assert.ok(
          report.findings.some(
            (finding) => finding.includes(file) && finding.includes("EACCES"),
          ),
        );
      }
    });
  }
});

test("parser implementation errors propagate while syntax errors become findings", (t) => {
  const plugin = fixture(t);
  const syntax = createDocumentSyntax();
  const unexpected = new TypeError("unexpected parser bug");
  assert.throws(
    () =>
      validatePlugin(plugin, {
        syntax: {
          ...syntax,
          skillMetadata: () => {
            throw unexpected;
          },
        },
      }),
    (error) => error === unexpected,
  );
  const report = validatePlugin(plugin, {
    syntax: {
      ...syntax,
      skillMetadata: () => {
        throw new SyntaxError("invalid header");
      },
    },
  });
  assert.equal(report.status, "failed");
  assert.ok(
    report.findings.some((finding) =>
      finding.includes("invalid YAML: invalid header"),
    ),
  );
});
