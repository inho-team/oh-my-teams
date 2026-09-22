/** Regression tests for manifest metadata that must stay synchronized. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  codexVersion,
  declaredTestCount,
  metadataMismatches,
  metadataTargets,
  repositoryFacts,
  syncMetadata,
} from "../scripts/metadata.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Read a JSON manifest from the repository root.
 * @param {string} relative manifest path relative to the repository root
 * @returns {object} parsed manifest
 */
function manifest(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
}

test("every file that repeats a fact states the one its source produces", () => {
  // Four manifests carry the version and three documents carry the audit
  // counts. They used to be edited by hand, one release at a time, and the
  // only thing that noticed a missed file was this test failing afterwards.
  // `npm run sync` now rewrites them from the same definition this reads.
  assert.deepEqual(metadataMismatches(root), []);
});

test("the version is a plain semantic version the other manifests can follow", () => {
  const declared = manifest("package.json").version;
  assert.match(declared, /^\d+\.\d+\.\d+$/);
  assert.equal(repositoryFacts(root).version, declared);

  // Every manifest but package.json is a sync target, so the source itself
  // must not be one: a version that could be rewritten from another file
  // would leave no file holding the decision.
  const targets = metadataTargets(repositoryFacts(root)).map((t) => t.file);
  assert.ok(!targets.includes("package.json"));
  assert.equal(
    targets.filter((file) => file.endsWith(".json")).length,
    3,
    "the three following manifests must all be sync targets",
  );
});

test("the codex manifest keeps its build metadata suffix", () => {
  const codex = manifest("plugins/oh-my-teams/.codex-plugin/plugin.json");
  assert.match(codex.version, /^\d+\.\d+\.\d+\+codex\.\d+$/);
});

test("a sync target can be found, and rewriting it moves only the number", () => {
  const facts = repositoryFacts(root);
  assert.equal(facts.findings, 0);

  // Every pattern must match the text its replacement produces. A pattern
  // that matched something wider would let the rewrite swallow the sentence
  // around the number, and the check would still report the file as correct.
  for (const target of metadataTargets(facts, "0.0.0+codex.1")) {
    const source = fs.readFileSync(path.join(root, target.file), "utf8");
    const match = source.match(target.pattern);
    assert.ok(match, `${target.file} no longer states ${target.pattern}`);

    const rewritten = source.replace(target.pattern, target.text);
    const expected = match[0].replace(target.pattern, target.text);
    assert.equal(
      rewritten.length - source.length,
      expected.length - match[0].length,
      `${target.file} would change more than the value at ${target.pattern}`,
    );
  }
});

test("a repeated fact that vanishes is reported, not silently accepted", () => {
  // A document that stopped stating a number would otherwise pass by saying
  // nothing, which is how a count goes missing without anyone noticing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-metadata-"));
  try {
    for (const relative of [
      "package.json",
      "evals/organization/scenarios.json",
      "docs/PLAN_STATUS.md",
      "docs/SAFETY_AUDIT.md",
      "docs/CODE_QUALITY.md",
      "plugins/oh-my-teams/.claude-plugin/plugin.json",
      "plugins/oh-my-teams/.codex-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
    ]) {
      const target = path.join(dir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, relative), target);
    }
    fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });

    const planStatus = path.join(dir, "docs/PLAN_STATUS.md");
    const stripped = fs
      .readFileSync(planStatus, "utf8")
      .replace(/결정적 로컬 시나리오 \d+개/, "결정적 로컬 시나리오");
    fs.writeFileSync(planStatus, stripped);

    // The copy has no sources to audit, so its other counts differ too. Only
    // the vanished sentence is under test here.
    const vanished = /결정적 로컬 시나리오/;
    const reported = metadataMismatches(dir).filter((line) =>
      vanished.test(line),
    );
    assert.equal(
      reported.length,
      1,
      `a vanished fact must be reported: ${JSON.stringify(reported)}`,
    );
    assert.match(reported[0], /no longer states/);

    // A fact it cannot find is a fact it must not invent, so the rewrite
    // reports it and leaves that file's sentence alone.
    const missing = syncMetadata(dir).missing.filter((line) =>
      vanished.test(line),
    );
    assert.equal(missing.length, 1);
    const after = fs.readFileSync(planStatus, "utf8");
    assert.ok(!/결정적 로컬 시나리오 \d+개/.test(after));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the test count is read from declarations, so it needs no test run", () => {
  // The documents state how many tests pass, and running `node --test` to
  // rewrite a document would cost minutes. Counting `test(` at column zero is
  // only equal to the real total while no case is nested or indented.
  assert.equal(declaredTestCount(root), repositoryFacts(root).tests);
  for (const name of fs.readdirSync(path.join(root, "tests"))) {
    if (!name.endsWith(".test.mjs")) continue;
    const text = fs.readFileSync(path.join(root, "tests", name), "utf8");
    assert.ok(
      !/^[ \t]+test\(/m.test(text),
      `${name} nests a test case, which the static count cannot see`,
    );
  }
});

test("the codex build suffix survives a no-op and is renewed on a bump", () => {
  const clock = new Date("2026-09-16T10:00:00Z");
  // Regenerating the suffix on every sync would make an unchanged repository
  // report a change, so it only moves when the base version does.
  assert.equal(
    codexVersion("2.0.0", "2.0.0+codex.20260101000000", clock),
    "2.0.0+codex.20260101000000",
  );
  assert.equal(
    codexVersion("2.1.0", "2.0.0+codex.20260101000000", clock),
    "2.1.0+codex.20260916100000",
  );
  assert.equal(
    codexVersion("2.0.0", "2.0.0", clock),
    "2.0.0+codex.20260916100000",
  );
});

test("the legacy note points at paths that exist", () => {
  const note = fs.readFileSync(
    path.join(root, "legacy/0.6.1/README.md"),
    "utf8",
  );
  for (const referenced of note.match(/`(plugins\/[^`]+)`/g) ?? []) {
    const relative = referenced.slice(1, -1).replace(/\/$/, "");
    const exists = fs.existsSync(path.join(root, relative));
    // The note previously sent readers to plugins/orca/skills/, which has never
    // existed under that name.
    assert.equal(
      exists,
      !note.includes(`\`${relative}/\`는 존재하지 않는다`),
      `${relative} is described incorrectly`,
    );
  }
});

test("the version policy does not hardcode a specific major version", () => {
  const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  const section = agents.match(/# 버전 정책\r?\n\r?\n([^#]+)/);
  assert.ok(section, "AGENTS.md must have a version policy section");
  assert.ok(
    !/\d+\.x\.x/.test(section[1]),
    "the version policy should not specify a major version like 1.x.x",
  );
});
