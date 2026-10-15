/** Implements the files port with Node, including recoverable batch writes. */
import fs from "node:fs";

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

function writeBatch(changes, writeText) {
  // Check every snapshot before the first write so stale plans cannot overwrite edits.
  for (const { file, before } of changes) {
    if (readText(file) !== before)
      throw new Error(`File changed since planning: ${file}`);
  }
  const attempted = [];
  try {
    for (const change of changes) {
      // Include this file in recovery even if its write fails after truncation.
      attempted.push(change);
      writeText(change.file, change.after);
    }
  } catch (error) {
    const failures = [error];
    for (const { file, before } of attempted.reverse()) {
      try {
        writeText(file, before);
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
 * @param {(file: string, text: string) => void} [options.writeText] - UTF-8 writer.
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
