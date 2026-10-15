/** Creates isolated development fixtures without writing into the checkout. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(
  new URL("../../plugins/oh-my-teams/", import.meta.url),
);

/**
 * Creates a canonical temporary directory and registers automatic cleanup.
 * @param {import('node:test').TestContext} t - Owning test context.
 * @param {string} [base] - Parent directory, including aliases when testing them.
 * @returns {string} Canonical temporary directory path.
 */
export function temporaryDirectory(t, base = os.tmpdir()) {
  const directory = fs.mkdtempSync(path.join(base, "omt-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return fs.realpathSync(directory);
}

/**
 * Copies only the installable plugin into a disposable directory.
 * @param {import('node:test').TestContext} t - Owning test context.
 * @param {string} [base] - Parent for the temporary installation.
 * @returns {string} Canonical path to the copied plugin.
 */
export function pluginFixture(t, base) {
  const plugin = path.join(temporaryDirectory(t, base), "plugin");
  fs.cpSync(source, plugin, { recursive: true });
  return plugin;
}

/**
 * Changes selected manifest fields in an isolated plugin fixture.
 * @param {string} plugin - Fixture directory.
 * @param {'claude'|'codex'} host - Manifest host.
 * @param {object} update - Fields to replace; undefined removes a field.
 * @returns {void} Writes the fixture manifest.
 */
export function editManifest(plugin, host, update) {
  const file = path.join(plugin, `.${host}-plugin/plugin.json`);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(
    file,
    `${JSON.stringify({ ...manifest, ...update }, null, 2)}\n`,
  );
}
