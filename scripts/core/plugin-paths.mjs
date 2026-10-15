/** Applies plugin containment and traversal policies through filesystem capabilities. */
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
 * @param {import("./ports.mjs").FilesPort} files - Filesystem capabilities.
 * @returns {string[]} Absolute Markdown paths.
 */
export function markdownFiles(directory, files) {
  return files.entries(directory).flatMap((item) => {
    const file = path.join(directory, item.name);
    if (item.kind === "directory") return markdownFiles(file, files);
    return item.kind === "file" && item.name.endsWith(".md") ? [file] : [];
  });
}

/**
 * Checks lexical and resolved containment before accepting a plugin path.
 * @param {string} pluginRoot - Canonical plugin root.
 * @param {string} file - Absolute candidate path.
 * @param {import("./ports.mjs").FilesPort} files - Filesystem capabilities.
 * @param {string} [boundary='plugin'] - Diagnostic name for the containing root.
 * @returns {string|null} Missing or external path diagnosis, or null.
 */
export function pathProblem(pluginRoot, file, files, boundary = "plugin") {
  if (!isWithin(pluginRoot, file)) return `outside ${boundary}`;
  try {
    return isWithin(pluginRoot, files.realPath(file))
      ? null
      : `outside ${boundary}`;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return "missing";
    throw error;
  }
}
