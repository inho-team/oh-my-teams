/** Verifies the Jenkins Git override against a temporary global configuration. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { temporaryDirectory } from "./helpers/plugin-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Jenkins overrides Git only in the build process without changing global files", (t) => {
  const temporary = temporaryDirectory(t);
  const globalFile = path.join(temporary, "global.gitconfig");
  const original = "[core]\n\tautocrlf = true\n";
  fs.writeFileSync(globalFile, original);
  const pipeline = fs.readFileSync(path.join(root, "Jenkinsfile"), "utf8");
  assert.doesNotMatch(pipeline, /git\s+config\s+--global/);
  const overrides = Object.fromEntries(
    [
      ...pipeline.matchAll(
        /(GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+))\s*=\s*"([^"]+)"/g,
      ),
    ].map((match) => [match[1], match[2]]),
  );
  const baseline = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalFile,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
  };
  delete baseline.GIT_CONFIG;
  delete baseline.GIT_DIR;
  delete baseline.GIT_WORK_TREE;
  delete baseline.GIT_CONFIG_PARAMETERS;
  function readValue(env) {
    const result = spawnSync("git", ["config", "--get", "core.autocrlf"], {
      cwd: temporary,
      env,
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  assert.equal(readValue(baseline), "true");
  assert.equal(readValue({ ...baseline, ...overrides }), "false");
  assert.equal(readValue(baseline), "true");
  assert.equal(fs.readFileSync(globalFile, "utf8"), original);
});
