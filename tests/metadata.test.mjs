/** Exercises metadata synchronization against disposable repositories. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { synchronize } from "../scripts/metadata.mjs";
import { temporaryDirectory } from "./helpers/plugin-fixture.mjs";

function repositoryFixture(t, current) {
  const root = temporaryDirectory(t);
  const documents = {
    "package.json": { version: "3.0.4" },
    ".claude-plugin/marketplace.json": { metadata: { version: "3.0.0" } },
    "plugins/oh-my-teams/.claude-plugin/plugin.json": { version: "3.0.0" },
    "plugins/oh-my-teams/.codex-plugin/plugin.json": { version: current },
  };
  for (const [relative, value] of Object.entries(documents)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(value));
  }
  const file = path.join(root, "plugins/oh-my-teams/.codex-plugin/plugin.json");
  return { root, file, now: new Date("2026-10-15T01:02:03Z") };
}

test("check mode detects drift without modifying manifests; write mode converges", (t) => {
  const options = repositoryFixture(t, "3.0.0+codex.20261001000000");
  const before = fs.readFileSync(options.file, "utf8");
  const check = synchronize(false, options);
  assert.equal(check.mismatches.length, 3);
  assert.deepEqual(check.changed, []);
  assert.equal(fs.readFileSync(options.file, "utf8"), before);
  assert.equal(synchronize(true, options).changed.length, 3);
  assert.deepEqual(synchronize(false, options), {
    changed: [],
    mismatches: [],
  });
  assert.deepEqual(synchronize(true, options), { changed: [], mismatches: [] });
  assert.equal(
    JSON.parse(fs.readFileSync(options.file, "utf8")).version,
    "3.0.4+codex.20261015010203",
  );
});

test("invalid canonical releases are rejected in check and write modes without changing manifests", async (t) => {
  for (const version of [
    undefined,
    null,
    42,
    "",
    "invalid version",
    "1.2",
    "01.2.3",
    "v1.2.3",
    " 1.2.3",
    "1.2.3 ",
    "1.2.3-01",
    "1.2.3+build",
  ]) {
    await t.test(String(version), (context) => {
      const options = repositoryFixture(context, "3.0.0+codex.20261001000000");
      fs.writeFileSync(
        path.join(options.root, "package.json"),
        JSON.stringify({ version }),
      );
      const manifests = [
        ".claude-plugin/marketplace.json",
        "plugins/oh-my-teams/.claude-plugin/plugin.json",
        "plugins/oh-my-teams/.codex-plugin/plugin.json",
      ];
      const snapshot = manifests.map((file) =>
        fs.readFileSync(path.join(options.root, file), "utf8"),
      );
      for (const write of [false, true])
        assert.throws(
          () => synchronize(write, options),
          /strict SemVer without build metadata/,
        );
      assert.deepEqual(
        manifests.map((file) =>
          fs.readFileSync(path.join(options.root, file), "utf8"),
        ),
        snapshot,
      );
    });
  }
});

test("valid prereleases synchronize and keep a single Codex build suffix", (t) => {
  const options = repositoryFixture(t, "3.0.0+codex.20261001000000");
  fs.writeFileSync(
    path.join(options.root, "package.json"),
    JSON.stringify({ version: "3.0.6-rc.1" }),
  );
  synchronize(true, options);
  assert.equal(
    JSON.parse(fs.readFileSync(options.file, "utf8")).version,
    "3.0.6-rc.1+codex.20261015010203",
  );
  assert.deepEqual(synchronize(false, options), {
    changed: [],
    mismatches: [],
  });
});

test("an invalid final manifest leaves all earlier inputs byte-for-byte unchanged", (t) => {
  const options = repositoryFixture(t, "3.0.0+codex.20261001000000");
  const paths = [
    ".claude-plugin/marketplace.json",
    "plugins/oh-my-teams/.claude-plugin/plugin.json",
  ].map((file) => path.join(options.root, file));
  const before = paths.map((file) => fs.readFileSync(file, "utf8"));
  fs.writeFileSync(options.file, "{");
  assert.throws(
    () => synchronize(true, options),
    (error) =>
      error instanceof SyntaxError && error.message.includes(options.file),
  );
  assert.deepEqual(
    paths.map((file) => fs.readFileSync(file, "utf8")),
    before,
  );
  assert.equal(fs.readFileSync(options.file, "utf8"), "{");
});

test("an invalid version target is rejected before writing any manifest", (t) => {
  const options = repositoryFixture(t, "3.0.0+codex.20261001000000");
  const file = path.join(options.root, ".claude-plugin/marketplace.json");
  fs.writeFileSync(file, JSON.stringify({ metadata: null }));
  const before = fs.readFileSync(options.file, "utf8");
  assert.throws(
    () => synchronize(true, options),
    /version target must be an object/,
  );
  assert.equal(fs.readFileSync(options.file, "utf8"), before);
});

test("a valid Codex build timestamp is preserved while other versions synchronize", (t) => {
  const current = "3.0.4+codex.20261001000000";
  const options = repositoryFixture(t, current);
  synchronize(true, options);
  assert.equal(
    JSON.parse(fs.readFileSync(options.file, "utf8")).version,
    current,
  );
});

test("invalid Codex versions are reported and repaired instead of crashing", async (t) => {
  for (const current of [
    undefined,
    null,
    42,
    "3.0.4+codex.",
    "3.0.4+codex.invalid",
    "3.0.4+codex.20261001000000.extra",
    "3.0.4+codex.99999999999999",
    "3.0.4+codex.20260229000000",
    "3.0.4+codex.19000229000000",
    "3.0.4+codex.20261301000000",
    "3.0.4+codex.20260132000000",
    "3.0.4+codex.20260101240000",
    "3.0.4+codex.20260101006000",
    "3.0.4+codex.20260101000060",
    "3.0.4+codex.00000101000000",
  ]) {
    await t.test(String(current), (context) => {
      const options = repositoryFixture(context, current);
      assert.ok(
        synchronize(false, options).mismatches.includes(
          "plugins/oh-my-teams/.codex-plugin/plugin.json",
        ),
      );
      synchronize(true, options);
      assert.equal(
        JSON.parse(fs.readFileSync(options.file, "utf8")).version,
        "3.0.4+codex.20261015010203",
      );
    });
  }
});

test("valid UTC calendar dates including leap centuries and boundary years are preserved", (t) => {
  for (const stamp of [
    "00010101000000",
    "20000229010203",
    "20240229235959",
    "99991231235959",
  ]) {
    const current = `3.0.4+codex.${stamp}`;
    const options = repositoryFixture(t, current);
    synchronize(true, options);
    assert.equal(
      JSON.parse(fs.readFileSync(options.file, "utf8")).version,
      current,
    );
  }
});

test("an unrepresentable build clock cannot modify any manifest", (t) => {
  const options = repositoryFixture(t, "3.0.0+codex.20261001000000");
  options.now = new Date("+010000-01-01T00:00:00.000Z");
  const paths = [
    ".claude-plugin/marketplace.json",
    "plugins/oh-my-teams/.claude-plugin/plugin.json",
    "plugins/oh-my-teams/.codex-plugin/plugin.json",
  ];
  const before = paths.map((file) =>
    fs.readFileSync(path.join(options.root, file), "utf8"),
  );
  for (const write of [false, true])
    assert.throws(() => synchronize(write, options), /valid UTC calendar date/);
  assert.deepEqual(
    paths.map((file) => fs.readFileSync(path.join(options.root, file), "utf8")),
    before,
  );
});

test("a fresh sync repairs manifests after a writer exits between replacements", (t) => {
  for (const completed of [1, 2]) {
    const options = repositoryFixture(t, "3.0.0+codex.20261001000000");
    const entry = new URL("../scripts/metadata.mjs", import.meta.url).href;
    const adapter = new URL(
      "../scripts/adapters/node-files.mjs",
      import.meta.url,
    ).href;
    const source = `
      import fs from "node:fs";
      import { synchronize } from ${JSON.stringify(entry)};
      import { createNodeFiles } from ${JSON.stringify(adapter)};
      let writes = 0;
      const files = createNodeFiles({ writeText(file, text) {
        if (++writes > ${completed}) process.exit(86);
        fs.writeFileSync(file, text);
      }});
      synchronize(true, {
        root: ${JSON.stringify(options.root)}, files,
        now: new Date("2026-10-15T01:02:03Z")
      });
    `;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", source],
      {
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    assert.ifError(child.error);
    assert.equal(child.status, 86, child.stderr);
    const marketplace = path.join(
      options.root,
      ".claude-plugin/marketplace.json",
    );
    const claude = path.join(
      options.root,
      "plugins/oh-my-teams/.claude-plugin/plugin.json",
    );
    assert.equal(
      JSON.parse(fs.readFileSync(marketplace, "utf8")).metadata.version,
      "3.0.4",
    );
    assert.equal(
      JSON.parse(fs.readFileSync(claude, "utf8")).version,
      completed === 2 ? "3.0.4" : "3.0.0",
    );
    assert.equal(
      JSON.parse(fs.readFileSync(options.file, "utf8")).version,
      "3.0.0+codex.20261001000000",
    );
    const before = fs.readFileSync(options.file, "utf8");
    assert.equal(synchronize(false, options).mismatches.length, 3 - completed);
    assert.equal(fs.readFileSync(options.file, "utf8"), before);
    const codex = JSON.parse(before);
    codex.description = "edit preserved during recovery";
    fs.writeFileSync(options.file, JSON.stringify(codex));
    assert.equal(synchronize(true, options).changed.length, 3 - completed);
    assert.equal(
      JSON.parse(fs.readFileSync(options.file, "utf8")).description,
      codex.description,
    );
    assert.deepEqual(synchronize(false, options), {
      changed: [],
      mismatches: [],
    });
    assert.deepEqual(synchronize(true, options), {
      changed: [],
      mismatches: [],
    });
  }
});
