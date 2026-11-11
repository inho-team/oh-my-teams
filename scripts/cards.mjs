/** Composes document card generation with the filesystem and YAML adapters and exposes its CLI. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeFiles } from "./adapters/node-files.mjs";
import { parseOmtYaml } from "./adapters/omt-documents.mjs";
import {
  renderDocumentCards,
  synchronizeCards as sync,
} from "./core/document-cards.mjs";

const defaultRoot = fileURLToPath(
  new URL("../plugins/oh-my-teams/", import.meta.url),
);

/**
 * Reports document cards that differ from the schema and usage rules, and optionally rewrites them.
 * @param {boolean} [write=false] - Whether to create missing cards and replace outdated ones.
 * @param {object} [options] - Explicit boundaries for isolated usage.
 * @param {string} [options.pluginRoot] - Plugin directory containing references/documents.
 * @param {import('./core/ports.mjs').FilesPort} [options.files] - Filesystem adapter.
 * @returns {{changed: string[], mismatches: string[]}} Written cards, or cards that differ when not writing.
 * @throws {Error} For invalid inputs, unsupported schema constructs, stale snapshots or failed writes.
 */
export function synchronizeCards(
  write = false,
  { pluginRoot = defaultRoot, files = createNodeFiles() } = {},
) {
  const documents = path.join(pluginRoot, "references", "documents");
  const schema = JSON.parse(
    files.readText(path.join(documents, "document.schema.json")),
  );
  const protocol = parseOmtYaml(
    files.readText(path.join(documents, "protocol.yaml")),
  );
  return sync(write, {
    directory: path.join(documents, "cards"),
    cards: renderDocumentCards(schema, protocol),
    files,
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = synchronizeCards(process.argv.includes("--write"));
  console.log(JSON.stringify(result, null, 2));
  if (result.mismatches.length) process.exitCode = 1;
}
