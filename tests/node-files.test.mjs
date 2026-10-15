/** Verifies batch write recovery using a local writer instead of global filesystem mocks. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createNodeFiles } from "../scripts/adapters/node-files.mjs";
import { temporaryDirectory } from "./helpers/plugin-fixture.mjs";

function changesIn(t) {
  const root = temporaryDirectory(t);
  return ["first", "second"].map((name) => {
    const file = path.join(root, name);
    const before = `original ${name}\n`;
    fs.writeFileSync(file, before);
    return { file, before, after: `updated ${name}\n` };
  });
}

test("batch writes detect a stale snapshot before modifying any file", (t) => {
  const changes = changesIn(t);
  fs.writeFileSync(changes[1].file, "concurrent edit\n");
  assert.throws(
    () => createNodeFiles().writeBatch(changes),
    /File changed since planning/,
  );
  assert.equal(fs.readFileSync(changes[0].file, "utf8"), changes[0].before);
  assert.equal(fs.readFileSync(changes[1].file, "utf8"), "concurrent edit\n");
});

test("a later write failure restores earlier files and the partially written file", (t) => {
  const changes = changesIn(t);
  const denied = Object.assign(new Error("simulated disk failure"), {
    code: "ENOSPC",
  });
  const files = createNodeFiles({
    writeText: (file, text) => {
      if (file === changes[1].file && text === changes[1].after) {
        fs.writeFileSync(file, "partial");
        throw denied;
      }
      fs.writeFileSync(file, text);
    },
  });
  assert.throws(
    () => files.writeBatch(changes),
    (error) => error === denied,
  );
  for (const { file, before } of changes)
    assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("restoration failure reports both errors rather than claiming recovery", (t) => {
  const changes = changesIn(t);
  const files = createNodeFiles({
    writeText: (file, text) => {
      if (file === changes[1].file) throw new Error("disk unavailable");
      fs.writeFileSync(file, text);
    },
  });
  assert.throws(
    () => files.writeBatch(changes),
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
  assert.equal(fs.readFileSync(changes[0].file, "utf8"), changes[0].before);
});
