/** Capability selection for success-only journal tests; refusal tests run on every host. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { assertDirectorySync } from "../plugins/oh-my-teams/scripts/core.mjs";

/**
 * Selects a durable-success fixture using a real directory sync, never an OS guess.
 * @param {object} t - Node test context.
 * @returns {boolean} Whether this host can execute the durable-success assertions.
 */
export function durableSuccessSupported(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "omt-sync-capability-"),
  );
  try {
    assertDirectorySync(directory);
    return true;
  } catch (error) {
    assert.equal(error.code, "worktree-durability-unavailable");
    t.skip(
      "Durable-success fixture requires directory fsync; mutation-zero and legacy tests still run",
    );
    return false;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Injects only directory fsync failure; file fsync and native directory-open errors remain real.
 * @param {object} t - Node test context with automatic mock restoration.
 * @returns {void} No return value.
 */
export function denyDirectorySync(t) {
  const original = fs.fsyncSync;
  t.mock.method(fs, "fsyncSync", (fd) => {
    if (fs.fstatSync(fd).isDirectory())
      throw Object.assign(new Error("Directory sync unsupported"), {
        code: "EINVAL",
      });
    return original(fd);
  });
}
