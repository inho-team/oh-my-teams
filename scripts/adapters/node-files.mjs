/** Implements the files port with Node, including recoverable batch writes. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function kind(entry) {
  if (entry.isDirectory()) return "directory";
  return entry.isFile() ? "file" : "other";
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.syscall) error.path ??= file;
    throw error;
  }
}

function assertSnapshot(file, expected) {
  if (readText(file) !== expected)
    throw new Error(`File changed since planning: ${file}`);
}

function replaceFile(file, expected, next, writeText) {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  let failure;
  let created = false;
  try {
    assertSnapshot(file, expected);
    // Stage on the same volume; a failed write never truncates the destination.
    const mode = fs.statSync(file).mode;
    fs.writeFileSync(temporary, "", {
      flag: "wx",
      mode,
    });
    created = true;
    writeText(temporary, next);
    fs.chmodSync(temporary, mode);
    assertSnapshot(file, expected);
    fs.renameSync(temporary, file);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      if (created) fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") {
        if (failure)
          throw new AggregateError(
            [failure, error],
            "Write and staging cleanup failed",
          );
        throw error;
      }
    }
  }
}

function writeBatch(changes, writeText) {
  // Check every snapshot before the first write so stale plans cannot overwrite edits.
  for (const { file, before } of changes) {
    assertSnapshot(file, before);
  }
  const attempted = [];
  try {
    for (const change of changes) {
      replaceFile(change.file, change.before, change.after, writeText);
      attempted.push(change);
    }
  } catch (error) {
    const failures = [error];
    for (const { file, before, after } of attempted.reverse()) {
      try {
        replaceFile(file, after, before, writeText);
      } catch (restoreError) {
        failures.push(restoreError);
      }
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "Batch write failed and restoration was incomplete",
      );
    }
    throw error;
  }
}

/**
 * Creates the production filesystem adapter without accessing user settings.
 * @param {object} [options] - Low-level writer for adapter fault tests.
 * @param {(file: string, text: string) => void} [options.writeText] - UTF-8 staging-file writer.
 * @returns {import('../core/ports.mjs').FilesPort} Synchronous filesystem capabilities.
 */
export function createNodeFiles({
  writeText = (file, text) => fs.writeFileSync(file, text),
} = {}) {
  return {
    realPath: (file) => fs.realpathSync(file),
    kind: (file) => kind(fs.statSync(file)),
    entries: (directory) =>
      fs
        .readdirSync(directory, { withFileTypes: true })
        .map((entry) => ({ name: entry.name, kind: kind(entry) })),
    readText,
    writeBatch: (changes) => writeBatch(changes, writeText),
  };
}
