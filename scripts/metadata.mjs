/** Composes version synchronization with the Node filesystem and wall clock. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeFiles } from "./adapters/node-files.mjs";
import { createVersionSyntax } from "./adapters/version-syntax.mjs";
import { synchronize as sync } from "./core/version-sync.mjs";

const defaultRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Reports version mismatches and optionally writes the canonical values.
 * @param {boolean} [write=false] - Whether to update mismatched manifests.
 * @param {object} [options] - Explicit boundaries for isolated usage.
 * @param {string} [options.root] - Checkout containing package.json and manifests.
 * @param {Date} [options.now] - Timestamp used only for a new Codex build value.
 * @param {import('./core/ports.mjs').FilesPort} [options.files] - Filesystem adapter.
 * @param {import('./core/ports.mjs').VersionSyntaxPort} [options.versions] - Release syntax validator.
 * @returns {{changed: string[], mismatches: string[]}} Sync result.
 * @throws {Error} For invalid inputs, stale plans or failed writes.
 */
export function synchronize(
  write = false,
  {
    root = defaultRoot,
    now = new Date(),
    files = createNodeFiles(),
    versions = createVersionSyntax(),
  } = {},
) {
  return sync(write, { root, now, files, versions });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = synchronize(process.argv.includes("--write"));
  console.log(JSON.stringify(result, null, 2));
  if (result.mismatches.length) process.exitCode = 1;
}
