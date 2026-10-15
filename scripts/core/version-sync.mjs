/** Plans version synchronization completely before applying any filesystem writes. */
import path from "node:path";

const sources = [
  ".claude-plugin/marketplace.json",
  "plugins/oh-my-teams/.claude-plugin/plugin.json",
  "plugins/oh-my-teams/.codex-plugin/plugin.json",
];

function codexVersion(version, current, now) {
  const prefix = `${version}+codex.`;
  if (
    typeof current === "string" &&
    current.startsWith(prefix) &&
    /^\d{14}$/.test(current.slice(prefix.length))
  )
    return current;
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "")
    .replace(/\.\d{3}Z$/, "");
  return `${version}+codex.${stamp}`;
}

function readJson(files, file) {
  const source = files.readText(file);
  try {
    return { source, value: JSON.parse(source) };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new SyntaxError(`${file}: ${error.message}`, { cause: error });
  }
}

function plan(root, files, now) {
  const canonical = readJson(files, path.join(root, "package.json")).value;
  const version = canonical?.version;
  if (typeof version !== "string" || !version.trim()) {
    throw new SyntaxError("package.json: version must be a nonempty string");
  }
  // Parse and validate every input before exposing the plan to a writer.
  return sources.flatMap((relative) => {
    const file = path.join(root, relative);
    const { source, value } = readJson(files, file);
    const target = relative === sources[0] ? value?.metadata : value;
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new SyntaxError(`${file}: version target must be an object`);
    }
    const expected = relative.includes(".codex-plugin")
      ? codexVersion(version, target.version, now)
      : version;
    if (target.version === expected) return [];
    target.version = expected;
    return [
      {
        file,
        relative,
        before: source,
        after: `${JSON.stringify(value, null, 2)}\n`,
      },
    ];
  });
}

/**
 * Checks a complete version plan, then applies it through the files port.
 * @param {boolean} write - Whether to apply the plan.
 * @param {object} options - Repository, files port and explicit clock value.
 * @param {string} options.root - Repository path.
 * @param {import('./ports.mjs').FilesPort} options.files - Filesystem capabilities.
 * @param {Date} options.now - Timestamp used for a new Codex build value.
 * @returns {{changed: string[], mismatches: string[]}} Synchronization result.
 * @throws {Error} For invalid inputs, stale snapshots or failed writes.
 */
export function synchronize(write, { root, files, now }) {
  const changes = plan(root, files, now);
  const names = changes.map((change) => change.relative);
  if (!write) return { changed: [], mismatches: names };
  files.writeBatch(changes);
  return { changed: names, mismatches: [] };
}
