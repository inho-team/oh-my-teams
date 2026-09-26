/** Evidence tree independence from line-ending checkout differences (#63). */
import { after } from "node:test";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hash, run } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  DEFAULT_VERIFY_TIMEOUT_MS,
  fingerprint,
  validateEvidence,
  verify,
} from "../plugins/oh-my-teams/scripts/evidence.mjs";
import { getTemplateRepo, cleanupTemplates } from "./template-factory.mjs";
after(() => cleanupTemplates());

const commands = [[process.execPath, "-e", "process.exit(0)"]];
const environment = "test";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-eol-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Seeds a fresh repository whose tracked file is declared `text=auto`, so
 * Git normalizes its stored blob to LF and, when diffing, renormalizes
 * whatever is on disk before comparing. That is the same mechanism
 * `core.autocrlf` relies on for a CRLF checkout, but declared in the
 * repository itself, so it behaves identically on macOS, Linux and Windows
 * CI instead of depending on a user-level Git setting (brief criterion 7).
 */
async function seededRepo(t) {
  const dir = fixture(t);
  fs.cpSync(await getTemplateRepo(), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".omt/\n");
  fs.writeFileSync(
    path.join(dir, ".gitattributes"),
    "line-ending.txt text=auto\n",
  );
  fs.writeFileSync(path.join(dir, "line-ending.txt"), "one\ntwo\nthree\n");
  assert.equal(
    (
      await run(
        ["git", "add", ".gitignore", ".gitattributes", "line-ending.txt"],
        { cwd: dir },
      )
    ).code,
    0,
  );
  assert.equal(
    (await run(["git", "commit", "-m", "seed"], { cwd: dir })).code,
    0,
  );
  return dir;
}

test("two independent worktrees on the same commit with LF vs CRLF tracked bytes get the same fingerprint tree", async (t) => {
  const base = await seededRepo(t);
  const lfDir = fixture(t);
  fs.cpSync(base, lfDir, { recursive: true });
  const crlfDir = fixture(t);
  fs.cpSync(base, crlfDir, { recursive: true });
  fs.writeFileSync(
    path.join(crlfDir, "line-ending.txt"),
    "one\r\ntwo\r\nthree\r\n",
  );

  // `text=auto` renormalizes the CRLF bytes back to LF for comparison, so
  // Git itself reports this worktree as clean against HEAD -- exactly what a
  // CRLF checkout of this same LF-committed content would report.
  assert.equal(
    (
      await run(["git", "diff", "--name-only", "HEAD"], { cwd: crlfDir })
    ).stdout.trim(),
    "",
  );

  const lf = await fingerprint(lfDir, "HEAD", commands, environment);
  const crlf = await fingerprint(crlfDir, "HEAD", commands, environment);
  assert.equal(crlf.head, lf.head);
  assert.equal(crlf.tree, lf.tree);
  assert.equal(hash(crlf), hash(lf));
});

test("an untracked non-ignored file still changes the fingerprint tree", async (t) => {
  const dir = await seededRepo(t);
  const before = await fingerprint(dir, "HEAD", commands, environment);

  fs.writeFileSync(path.join(dir, "scratch.txt"), "untracked\n");

  const after1 = await fingerprint(dir, "HEAD", commands, environment);
  assert.notEqual(after1.tree, before.tree);
});

test("editing a tracked file changes the fingerprint tree, and validateEvidence names tree as the stale field", async (t) => {
  const dir = await seededRepo(t);
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "omt-eol-store-"));
  t.after(() => fs.rmSync(store, { recursive: true, force: true }));

  const evidence = await verify(dir, {
    baseRef: "HEAD",
    commands,
    environment,
    store,
    timeoutMs: 60000,
  });
  assert.equal(evidence.status, "passed");

  fs.writeFileSync(path.join(dir, "line-ending.txt"), "changed content\n");
  const after1 = await fingerprint(dir, "HEAD", commands, environment, 60000);
  assert.notEqual(after1.tree, evidence.fingerprint.tree);

  await assert.rejects(
    () => validateEvidence(dir, evidence, "HEAD"),
    /Stale evidence: tree changed/,
  );
});

test("evidence recorded under the pre-#63 tree algorithm is rejected as stale, not silently reused", async (t) => {
  const dir = await seededRepo(t);
  const head = (
    await run(["git", "rev-parse", "HEAD"], { cwd: dir })
  ).stdout.trim();

  // Reconstructs the pre-#63 algorithm literally (hash every tracked file's
  // raw on-disk bytes and stat mode, ignoring `git diff`/`git status`
  // entirely) so this test does not depend on any code this task removed.
  const tracked = (await run(["git", "ls-files", "-z"], { cwd: dir })).stdout
    .split("\0")
    .filter(Boolean)
    .filter((file) => !/^\.(omt|orca)\//i.test(file))
    .sort();
  const oldTreeInput = tracked.map((relative) => {
    const file = path.join(dir, relative);
    return [
      relative,
      hash(fs.readFileSync(file).toString("base64")),
      fs.statSync(file).mode,
    ];
  });
  const oldFingerprint = {
    head,
    base: head,
    tree: hash(oldTreeInput),
    commands,
    environment,
    timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
    platform: process.platform,
    node: process.version,
  };

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "omt-eol-legacy-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const logPath = path.join(scratch, "old-check-0.log");
  fs.writeFileSync(logPath, "ok\n");
  const oldEvidence = {
    schemaVersion: 1,
    key: hash(oldFingerprint),
    fingerprint: oldFingerprint,
    status: "passed",
    unchanged: true,
    checks: [
      {
        argv: commands[0],
        code: 0,
        timedOut: false,
        overflow: false,
        pid: 1,
        elapsedMs: 1,
        log: logPath,
        logHash: hash("ok\n"),
        tail: "ok\n",
      },
    ],
    createdAt: new Date().toISOString(),
  };

  // Nothing in the actual workspace changed; only the tree algorithm did.
  // Decision 5 treats that as stale rather than special-casing it the way
  // `timeoutMs` is, so the rejection must still name `tree` specifically.
  await assert.rejects(
    () => validateEvidence(dir, oldEvidence, "HEAD"),
    /Stale evidence: tree changed/,
  );
});
