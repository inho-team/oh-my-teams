#!/usr/bin/env node
/** Single source for the repository facts that several files must repeat.
 *
 * Four manifests declare the version and three documents restate the audit
 * counts, so every release used to mean editing eight files by hand and
 * finding out from a failing test which one was missed. Each fact is derived
 * here from the one place that actually produces it, and both the check and
 * the rewrite read the same definition, so a target cannot be verified
 * against one spelling and written with another.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditDirectory } from "./check-code-quality.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Read a JSON file below the repository root.
 * @param {string} repoRoot repository root directory
 * @param {string} relative path relative to the repository root
 * @returns {object} parsed JSON
 */
function readJson(repoRoot, relative) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relative), "utf8"));
}

/** Count the top-level test cases the suite declares.
 *
 * Counted statically rather than by running the suite, because the documents
 * state this number and running `node --test` to rewrite a document would
 * cost minutes. Only `test(` at column zero counts, so a nested subtest does
 * not inflate the total.
 *
 * @param {string} repoRoot repository root directory
 * @returns {number} declared top-level test cases
 */
export function declaredTestCount(repoRoot = root) {
  const dir = path.join(repoRoot, "tests");
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".test.mjs"))
    .reduce((total, name) => {
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      return total + (text.match(/^test\(/gm) ?? []).length;
    }, 0);
}

/** Collect every fact the manifests and documents must agree on.
 * @param {string} repoRoot repository root directory
 * @returns {object} version, counts, and audit totals
 */
export function repositoryFacts(repoRoot = root) {
  const audit = auditDirectory(repoRoot);
  return {
    version: readJson(repoRoot, "package.json").version,
    tests: declaredTestCount(repoRoot),
    scenarios: readJson(repoRoot, "evals/organization/scenarios.json").scenarios
      .length,
    totals: audit.totals,
    findings: audit.totals.findings,
  };
}

/** Build the codex manifest's version, preserving its build metadata.
 *
 * The suffix identifies the build, so it is regenerated only when the base
 * version actually changes; a re-run that changes nothing must not rewrite it.
 *
 * @param {string} version base semantic version
 * @param {string} current version currently declared by the codex manifest
 * @param {Date} [now] clock, injectable so a test is not time-dependent
 * @returns {string} version with a `+codex.<timestamp>` suffix
 */
export function codexVersion(version, current, now = new Date()) {
  const [base, suffix] = current.split("+");
  if (base === version && suffix) return current;
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${version}+codex.${stamp}`;
}

/** List every file that must repeat a fact, with how to find and rewrite it.
 *
 * `pattern` must match exactly what `text` replaces, so a target checked as
 * present is also a target that can be rewritten in place.
 *
 * @param {object} facts output of {@link repositoryFacts}
 * @param {string} [codexCurrent] version the codex manifest declares now
 * @returns {Array<object>} targets with `file`, `pattern`, and `text`
 */
export function metadataTargets(facts, codexCurrent = "") {
  const { version, totals, tests, scenarios } = facts;
  const version_ = (file, value) => ({
    file,
    pattern: /("version":\s*)"[^"]+"/,
    text: `$1"${value}"`,
  });

  return [
    version_(".claude-plugin/marketplace.json", version),
    version_("plugins/oh-my-teams/.claude-plugin/plugin.json", version),
    version_(
      "plugins/oh-my-teams/.codex-plugin/plugin.json",
      codexVersion(version, codexCurrent),
    ),
    {
      file: "docs/PLAN_STATUS.md",
      pattern: /\| \d+개 테스트가 모두 통과했다\./,
      text: `| ${tests}개 테스트가 모두 통과했다.`,
    },
    {
      file: "docs/PLAN_STATUS.md",
      pattern: /활성 `\.mjs` \d+개와 공개 export \d+개/,
      text: `활성 \`.mjs\` ${totals.files}개와 공개 export ${totals.publicExports}개`,
    },
    {
      file: "docs/PLAN_STATUS.md",
      pattern: /결정적 로컬 시나리오 \d+개/,
      text: `결정적 로컬 시나리오 ${scenarios}개`,
    },
    {
      file: "docs/SAFETY_AUDIT.md",
      pattern: /`npm test`의 \d+개 테스트/,
      text: `\`npm test\`의 ${tests}개 테스트`,
    },
    {
      file: "docs/SAFETY_AUDIT.md",
      pattern: /\d+개 활성 모듈·\d+개 공개 export/,
      text: `${totals.files}개 활성 모듈·${totals.publicExports}개 공개 export`,
    },
    {
      file: "docs/SAFETY_AUDIT.md",
      pattern: /의 \d+개 결정적 시나리오/,
      text: `의 ${scenarios}개 결정적 시나리오`,
    },
    {
      file: "docs/CODE_QUALITY.md",
      pattern: /\| 활성 `\.mjs` 파일 \| \d+\/\d+ 모듈 문서화 \|/,
      text: `| 활성 \`.mjs\` 파일 | ${totals.files}/${totals.files} 모듈 문서화 |`,
    },
    {
      file: "docs/CODE_QUALITY.md",
      pattern: /\| 공개 export \| \d+\/\d+ JSDoc \|/,
      text: `| 공개 export | ${totals.publicExports}/${totals.publicExports} JSDoc |`,
    },
    {
      file: "docs/CODE_QUALITY.md",
      pattern: /\| 인식한 매개변수 태그 \| \d+개/,
      text: `| 인식한 매개변수 태그 | ${totals.parameterTags}개`,
    },
    {
      file: "docs/CODE_QUALITY.md",
      pattern: /\| 공개 함수 \| \d+\/\d+ `@returns` \|/,
      text: `| 공개 함수 | ${totals.returnTags}/${totals.returnTags} \`@returns\` |`,
    },
    {
      file: "docs/CODE_QUALITY.md",
      pattern: /\d+개 `@throws` 명시/,
      text: `${totals.throwsTags}개 \`@throws\` 명시`,
    },
  ];
}

/** Resolve the targets against the repository's current state.
 *
 * The resolved fields are deliberately not named `text`: a `text` key here
 * once shadowed the target's replacement string with the whole file, and the
 * rewrite then substituted the entire document for the matched number.
 *
 * @param {string} repoRoot repository root directory
 * @returns {Array<object>} targets with `path`, `source`, `match`, `expected`
 */
function resolveTargets(repoRoot) {
  const facts = repositoryFacts(repoRoot);
  const codexFile = "plugins/oh-my-teams/.codex-plugin/plugin.json";
  const codexCurrent = readJson(repoRoot, codexFile).version;

  return metadataTargets(facts, codexCurrent).map((target) => {
    const file = path.join(repoRoot, target.file);
    const source = fs.readFileSync(file, "utf8");
    const match = source.match(target.pattern);
    const expected = match
      ? match[0].replace(target.pattern, target.text)
      : null;
    return {
      ...target,
      path: file,
      source,
      match: match?.[0] ?? null,
      expected,
    };
  });
}

/** Report every fact a file states differently from its source.
 *
 * A pattern that matches nothing is reported too: a document that stopped
 * stating a number would otherwise pass by saying nothing at all.
 *
 * @param {string} repoRoot repository root directory
 * @returns {string[]} one message per mismatch, empty when synchronized
 */
export function metadataMismatches(repoRoot = root) {
  return resolveTargets(repoRoot).flatMap((target) => {
    if (target.match === null) {
      return [`${target.file} no longer states: ${target.pattern}`];
    }
    return target.match === target.expected
      ? []
      : [
          `${target.file} states "${target.match}", expected "${target.expected}"`,
        ];
  });
}

/** Rewrite every file that states a fact differently from its source.
 * @param {string} repoRoot repository root directory
 * @returns {object} `changed` paths and any `missing` patterns
 */
export function syncMetadata(repoRoot = root) {
  const changed = new Set();
  const missing = [];
  const contents = new Map();

  for (const target of resolveTargets(repoRoot)) {
    if (target.match === null) {
      missing.push(`${target.file} no longer states: ${target.pattern}`);
      continue;
    }
    if (target.match === target.expected) continue;
    const current = contents.get(target.path) ?? target.source;
    const next = current.replace(target.pattern, target.text);
    // Replacing one number may only change the file by the difference between
    // the old and new spelling. A rewrite that moves more than that is not the
    // substitution it claims to be, and writing it would destroy the document.
    const moved = next.length - current.length;
    const allowed = target.expected.length - target.match.length;
    if (moved !== allowed) {
      missing.push(
        `${target.file} would change by ${moved} characters, expected ${allowed}`,
      );
      continue;
    }
    contents.set(target.path, next);
    changed.add(target.file);
  }

  for (const [file, text] of contents) fs.writeFileSync(file, text);
  return { changed: [...changed], missing };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.includes("--write")) {
    const result = syncMetadata();
    console.log(JSON.stringify(result, null, 2));
    if (result.changed.includes("package.json")) {
      console.log("Run `npm install` to carry the version into the lockfile.");
    }
    if (result.missing.length) process.exitCode = 1;
  } else {
    const mismatches = metadataMismatches();
    console.log(JSON.stringify({ mismatches }, null, 2));
    if (mismatches.length) process.exitCode = 1;
  }
}
