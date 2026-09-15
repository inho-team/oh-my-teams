/** Regression tests for manifest metadata that must stay synchronized. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditDirectory } from "../scripts/check-code-quality.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Read a JSON manifest from the repository root.
 * @param {string} relative manifest path relative to the repository root
 * @returns {object} parsed manifest
 */
function manifest(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
}

/** Strip build metadata so distribution variants compare by base version.
 * @param {string} version declared semantic version
 * @returns {string} version without its build metadata suffix
 */
function baseVersion(version) {
  return version.split("+")[0];
}

test("every manifest declares the same base version", () => {
  const declared = manifest("package.json").version;
  assert.match(declared, /^\d+\.\d+\.\d+$/);

  const sources = {
    ".claude-plugin/marketplace.json": manifest(
      ".claude-plugin/marketplace.json",
    ).metadata.version,
    "plugins/oh-my-teams/.claude-plugin/plugin.json": manifest(
      "plugins/oh-my-teams/.claude-plugin/plugin.json",
    ).version,
    "plugins/oh-my-teams/.codex-plugin/plugin.json": manifest(
      "plugins/oh-my-teams/.codex-plugin/plugin.json",
    ).version,
  };

  const mismatches = Object.entries(sources)
    .filter(([, version]) => baseVersion(version) !== declared)
    .map(
      ([file, version]) => `${file} declares ${version}, expected ${declared}`,
    );
  assert.deepEqual(mismatches, []);
});

test("the codex manifest keeps its build metadata suffix", () => {
  const codex = manifest("plugins/oh-my-teams/.codex-plugin/plugin.json");
  assert.match(codex.version, /^\d+\.\d+\.\d+\+codex\.\d+$/);
});

test("documented audit numbers match what the audit actually reports", () => {
  const audit = auditDirectory(root);
  const totals = audit.totals;
  const documents = {
    "docs/PLAN_STATUS.md": fs.readFileSync(
      path.join(root, "docs/PLAN_STATUS.md"),
      "utf8",
    ),
    "docs/SAFETY_AUDIT.md": fs.readFileSync(
      path.join(root, "docs/SAFETY_AUDIT.md"),
      "utf8",
    ),
    "docs/CODE_QUALITY.md": fs.readFileSync(
      path.join(root, "docs/CODE_QUALITY.md"),
      "utf8",
    ),
  };

  // These three documents each repeated the same counts, so all three aged
  // together and none of them said so. Every number a document claims is
  // checked against the audit that produced it.
  const claims = [
    ["docs/PLAN_STATUS.md", `활성 \`.mjs\` ${totals.files}개`],
    ["docs/PLAN_STATUS.md", `공개 export ${totals.publicExports}개`],
    ["docs/SAFETY_AUDIT.md", `${totals.files}개 활성 모듈`],
    ["docs/SAFETY_AUDIT.md", `${totals.publicExports}개 공개 export`],
    [
      "docs/CODE_QUALITY.md",
      `| 활성 \`.mjs\` 파일 | ${totals.files}/${totals.files} 모듈 문서화 |`,
    ],
    [
      "docs/CODE_QUALITY.md",
      `| 공개 export | ${totals.publicExports}/${totals.publicExports} JSDoc |`,
    ],
    ["docs/CODE_QUALITY.md", `${totals.parameterTags}개 (의미적 정확성`],
    [
      "docs/CODE_QUALITY.md",
      `| 공개 함수 | ${totals.returnTags}/${totals.returnTags} \`@returns\` |`,
    ],
    ["docs/CODE_QUALITY.md", `${totals.throwsTags}개 \`@throws\` 명시`],
  ];
  for (const [file, claim] of claims) {
    assert.ok(
      documents[file].includes(claim),
      `${file} must state the audited value: ${claim}`,
    );
  }
  assert.equal(totals.findings, 0);
});

test("the eval manifest and the documents agree on how many scenarios exist", () => {
  const manifestScenarios = JSON.parse(
    fs.readFileSync(
      path.join(root, "evals/organization/scenarios.json"),
      "utf8",
    ),
  ).scenarios.length;
  for (const relative of ["docs/PLAN_STATUS.md", "docs/SAFETY_AUDIT.md"]) {
    const text = fs.readFileSync(path.join(root, relative), "utf8");
    assert.ok(
      text.includes(`${manifestScenarios}개`),
      `${relative} must state ${manifestScenarios} scenarios`,
    );
  }
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
