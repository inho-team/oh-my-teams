/** Fixed prompts and deterministic evaluators for model-routing experiments. */
import fs from "node:fs";
import path from "node:path";
import { run } from "../plugins/oh-my-teams/scripts/core.mjs";

const GENERAL_IMPLEMENTATION_PROMPT = [
  'Return {"code":"complete ES module"} exporting parseRetries(value).',
  "Accept integer strings 0..5 and return the number; all other values return null.",
  "No imports or side effects.",
].join(" ");
const MULTI_FILE_PROMPT = [
  'Return {"files":{"api.mjs":"...","consumer.mjs":"..."}}.',
  "api.mjs exports normalizeName(value), returning trimmed lowercase strings or null.",
  "consumer.mjs imports it and exports greeting(value),",
  'returning "hello <name>" or "hello guest". No other files.',
].join(" ");
const REGRESSION_REVIEW_PROMPT = [
  "Review this diff: `return now > expiresAt` replaced",
  "an existing `return now >= expiresAt`. Equality must remain expired.",
  'Return {"findings":[{"severity":"high","issue":"..."}]}.',
  "Do not approve a regression.",
].join(" ");
const CONTRACT_CONFLICT_PROMPT = [
  "Task A requires parse(id): string|null.",
  "Task B changed it to throw on null. Existing callers rely on null.",
  'Return {"decision":{"signature":"parse(id): string|null",',
  '"compatibility":"..."}} preserving the shared contract.',
].join(" ");

/** Fixed six-category task suite used by E1 and routing-mode comparisons. */
export const routingFixtures = [
  {
    id: "narrow-edit",
    kind: "narrow",
    prompt:
      'Return {"answer":"..."}. State the exact boolean expiry rule when equality must count as expired.',
    expected: "now >= expiresAt",
  },
  {
    id: "source-citations",
    kind: "citation",
    prompt:
      'Given numbered lines [1 alpha, 2 beta contract, 3 gamma], return {"citations":[{"line":2,"quote":"beta contract"}]}. Use exact source text.',
  },
  {
    id: "general-implementation",
    kind: "implementation",
    prompt: GENERAL_IMPLEMENTATION_PROMPT,
  },
  {
    id: "multi-file-contract",
    kind: "multi-file",
    prompt: MULTI_FILE_PROMPT,
  },
  {
    id: "regression-review",
    kind: "review",
    prompt: REGRESSION_REVIEW_PROMPT,
  },
  {
    id: "contract-conflict",
    kind: "conflict",
    prompt: CONTRACT_CONFLICT_PROMPT,
  },
];

/** Current deterministic grader contract stored with every evaluation. */
export const routingGraderVersion = 3;

/**
 * Evaluates one model payload without consulting model-authored success claims.
 *
 * @param {object} fixture - Entry from {@link routingFixtures}.
 * @param {object} payload - Parsed provider JSON response.
 * @param {string} dir - Isolated directory for generated-code acceptance tests.
 * @returns {Promise<{passed: boolean, evidence: unknown}>} Fixed-grader result.
 * @throws {Error} When local fixture setup or its command runner fails.
 */
export async function evaluateRoutingFixture(fixture, payload, dir) {
  if (fixture.id === "narrow-edit") {
    const answer = String(payload?.answer ?? "");
    const equivalent =
      />=|≤|greater\s+than\s+or\s+equal|같거나|크거나|같을\s*때[^.]*만료/i.test(
        answer,
      );
    return { passed: equivalent, evidence: payload?.answer ?? null };
  }
  if (fixture.id === "source-citations")
    return {
      passed:
        Array.isArray(payload?.citations) &&
        payload.citations.length === 1 &&
        payload.citations[0].line === 2 &&
        payload.citations[0].quote === "beta contract",
      evidence: payload?.citations ?? null,
    };
  if (fixture.id === "regression-review")
    return {
      passed:
        Array.isArray(payload?.findings) &&
        payload.findings.some(
          (item) =>
            item.severity === "high" && /equal|equality|>=/.test(item.issue),
        ),
      evidence: payload?.findings ?? null,
    };
  if (fixture.id === "contract-conflict")
    return {
      passed:
        payload?.decision?.signature === "parse(id): string|null" &&
        /null|compatib/i.test(payload?.decision?.compatibility ?? ""),
      evidence: payload?.decision ?? null,
    };
  dir = fs.realpathSync(dir);
  if (fixture.id === "general-implementation") {
    if (typeof payload?.code !== "string")
      return { passed: false, evidence: "missing code" };
    fs.writeFileSync(path.join(dir, "solution.mjs"), payload.code);
    fs.writeFileSync(
      path.join(dir, "acceptance.mjs"),
      `import assert from "node:assert/strict";
import { parseRetries as parse } from "./solution.mjs";

for (const value of [0, 1, 5]) assert.equal(parse(String(value)), value);
for (const invalid of ["-1", "6", "1.2", "x", "", null, undefined, 1]) {
  assert.equal(parse(invalid), null);
}
`,
    );
  } else {
    if (
      !payload?.files ||
      Object.keys(payload.files).sort().join(",") !== "api.mjs,consumer.mjs"
    )
      return { passed: false, evidence: "wrong files" };
    for (const [file, content] of Object.entries(payload.files))
      fs.writeFileSync(path.join(dir, file), content);
    fs.writeFileSync(
      path.join(dir, "acceptance.mjs"),
      `import assert from "node:assert/strict";
import { normalizeName } from "./api.mjs";
import { greeting } from "./consumer.mjs";

assert.equal(normalizeName(" Alice "), "alice");
assert.equal(normalizeName(null), null);
assert.equal(greeting(" Bob "), "hello bob");
assert.equal(greeting(null), "hello guest");
`,
    );
  }
  const result = await run(
    [
      process.execPath,
      "--permission",
      `--allow-fs-read=${dir}`,
      path.join(dir, "acceptance.mjs"),
    ],
    { cwd: dir, timeoutMs: 10000 },
  );
  return {
    passed: result.code === 0 && !result.timedOut,
    evidence: {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    },
  };
}

/** Requested model assignment for each operational comparison mode. */
export const routingModes = {
  "opus-first": Object.fromEntries(
    routingFixtures.map((item) => [item.id, "claude-opus-4-6-thinking"]),
  ),
  balanced: {
    "narrow-edit": "gpt-oss-120b-medium",
    "source-citations": "gpt-oss-120b-medium",
    "general-implementation": "claude-sonnet-4-6",
    "multi-file-contract": "claude-opus-4-6-thinking",
    "regression-review": "claude-opus-4-6-thinking",
    "contract-conflict": "claude-opus-4-6-thinking",
  },
  control: Object.fromEntries(
    routingFixtures.map((item) => [item.id, "gpt-oss-120b-medium"]),
  ),
};
