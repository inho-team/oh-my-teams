/** Exercises metadata synchronization against disposable repositories. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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
