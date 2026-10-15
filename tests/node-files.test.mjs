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

test(
  "successful replacements preserve file modes and leave no staging files",
  { skip: process.platform === "win32" },
  (t) => {
    const changes = changesIn(t);
    fs.chmodSync(changes[0].file, 0o660);
    createNodeFiles().writeBatch(changes);
    assert.equal(fs.statSync(changes[0].file).mode & 0o777, 0o660);
    assert.equal(fs.readFileSync(changes[0].file, "utf8"), changes[0].after);
    assert.equal(fs.readdirSync(path.dirname(changes[0].file)).length, 2);
  },
);

test("a failed staging write preserves its destination and restores earlier files", (t) => {
  const changes = changesIn(t);
  const denied = Object.assign(new Error("simulated disk failure"), {
    code: "ENOSPC",
  });
  const files = createNodeFiles({
    writeText: (file, text) => {
      if (text === changes[1].after) {
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
  assert.equal(fs.readdirSync(path.dirname(changes[0].file)).length, 2);
});

test("a staging flush failure preserves its destination and flushes restored files", (t) => {
  const changes = changesIn(t);
  const denied = Object.assign(new Error("simulated flush failure"), {
    code: "EIO",
  });
  const flushed = [];
  const files = createNodeFiles({
    flush(file) {
      const text = fs.readFileSync(file, "utf8");
      flushed.push(text);
      if (text === changes[1].after) throw denied;
    },
  });
  assert.throws(
    () => files.writeBatch(changes),
    (error) => error === denied,
  );
  assert.deepEqual(flushed, [
    changes[0].after,
    changes[1].after,
    changes[0].before,
  ]);
  for (const { file, before } of changes)
    assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(fs.readdirSync(path.dirname(changes[0].file)).length, 2);
});

test("restoration failure reports both errors rather than claiming recovery", (t) => {
  const changes = changesIn(t);
  const files = createNodeFiles({
    writeText: (file, text) => {
      if (text === changes[1].after || text === changes[0].before)
        throw new Error("disk unavailable");
      fs.writeFileSync(file, text);
    },
  });
  assert.throws(
    () => files.writeBatch(changes),
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
  assert.equal(fs.readFileSync(changes[0].file, "utf8"), changes[0].after);
});

test("an external edit after the first replacement survives rollback", (t) => {
  const changes = changesIn(t);
  const files = createNodeFiles({
    writeText(file, text) {
      if (text === changes[1].after) {
        fs.writeFileSync(changes[0].file, "concurrent edit\n");
        throw new Error("disk failure");
      }
      fs.writeFileSync(file, text);
    },
  });
  assert.throws(
    () => files.writeBatch(changes),
    (error) =>
      error instanceof AggregateError &&
      error.errors.some((item) => item.message.includes(changes[0].file)),
  );
  assert.equal(fs.readFileSync(changes[0].file, "utf8"), "concurrent edit\n");
  assert.equal(fs.readFileSync(changes[1].file, "utf8"), changes[1].before);
  assert.equal(fs.readdirSync(path.dirname(changes[0].file)).length, 2);
});

test("changes while staging a forward write or a restoration are preserved", async (t) => {
  for (const restoring of [false, true])
    await t.test(String(restoring), (context) => {
      const changes = changesIn(context);
      const files = createNodeFiles({
        writeText(file, text) {
          if (restoring && text === changes[1].after)
            throw new Error("disk failure");
          fs.writeFileSync(file, text);
          if (text === (restoring ? changes[0].before : changes[0].after))
            fs.writeFileSync(changes[0].file, "concurrent edit\n");
        },
      });
      assert.throws(
        () => files.writeBatch(changes),
        restoring ? AggregateError : /File changed since planning/,
      );
      assert.equal(
        fs.readFileSync(changes[0].file, "utf8"),
        "concurrent edit\n",
      );
      assert.equal(fs.readFileSync(changes[1].file, "utf8"), changes[1].before);
      assert.equal(fs.readdirSync(path.dirname(changes[0].file)).length, 2);
    });
});
