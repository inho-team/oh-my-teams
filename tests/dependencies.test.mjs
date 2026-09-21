/** Deterministic OpenCodex runtime identity and dry-run diagnostics. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  doctor,
  installRuntime,
  runtimeIdentity,
  runtimePaths,
  supportedNode,
} from "../plugins/oh-my-teams/scripts/dependencies.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omt-dependencies-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("the exact package lock produces a stable owned runtime fingerprint", () => {
  const identity = runtimeIdentity();
  assert.equal(identity.version, "2.59.0");
  assert.match(identity.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(
    runtimePaths("/tmp/omt-runtime").runtime.includes(
      identity.fingerprint.slice(7),
    ),
    true,
  );
});

test("runtime diagnosis rejects Node versions below the accepted catalog floor", () => {
  assert.equal(supportedNode("v22.12.9"), false);
  assert.equal(supportedNode("v22.13.0"), true);
  assert.equal(supportedNode("v23.0.0"), true);
  assert.equal(supportedNode("invalid"), false);
});

test("missing and dry-run runtime checks do not write an active pointer", async (t) => {
  const root = fixture(t);
  const missing = await doctor(root);
  assert.equal(missing.status, "needs-install");
  const dryRun = await installRuntime(root, { dryRun: true });
  assert.equal(dryRun.dryRun, true);
  assert.equal(fs.existsSync(runtimePaths(root).active), false);
});
