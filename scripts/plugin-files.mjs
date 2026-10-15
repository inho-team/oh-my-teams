/** Provides filesystem operations shared by plugin validation rules. */
import fs from "node:fs";
import path from "node:path";

function isWithin(directory, file) {
  const relative = path.relative(directory, file);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Enumerates regular Markdown files without following directory links.
 * @param {string} directory - Directory to inspect recursively.
 * @returns {string[]} Absolute Markdown paths.
 */
export function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) return markdownFiles(file);
    return item.isFile() && item.name.endsWith(".md") ? [file] : [];
  });
}

/**
 * Checks lexical and resolved containment before accepting a plugin path.
 * @param {string} pluginRoot - Canonical plugin root.
 * @param {string} file - Absolute candidate path.
 * @returns {string|null} Missing or external path diagnosis, or null.
 */
export function pathProblem(pluginRoot, file) {
  if (!isWithin(pluginRoot, file)) return "outside plugin";
  try {
    return isWithin(pluginRoot, fs.realpathSync(file))
      ? null
      : "outside plugin";
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return "missing";
    throw error;
  }
}

/**
 * Reads UTF-8 text and preserves the affected path in filesystem errors.
 * @param {string} file - File to read.
 * @returns {string} File contents.
 */
export function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.syscall) error.path ??= file;
    throw error;
  }
}
