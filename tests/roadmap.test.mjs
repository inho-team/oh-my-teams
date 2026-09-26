/** Enforces the roadmap canon's structural contract against `docs/ROADMAP.md`
 * and `plugins/oh-my-teams/references/roadmap.md`, and reproduces each
 * failure the contract must catch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  brokenLinks,
  duplicatePhaseIds,
  implementationLeaks,
  malformedPhaseIds,
  missingPhaseFields,
  phaseBodies,
} from "./roadmap-format.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roadmapFile = "docs/ROADMAP.md";
const rulesFile = "plugins/oh-my-teams/references/roadmap.md";
const roadmap = fs.readFileSync(path.join(root, roadmapFile), "utf8");
const rules = fs.readFileSync(path.join(root, rulesFile), "utf8");

test("the roadmap and its rules reference link only to files that exist", () => {
  assert.deepEqual(brokenLinks(roadmap, roadmapFile, root), []);
  assert.deepEqual(brokenLinks(rules, rulesFile, root), []);
});

test("every phase identifier in the roadmap follows PH-two-digits without repeating", () => {
  assert.deepEqual(malformedPhaseIds(roadmap), []);
  assert.deepEqual(duplicatePhaseIds(roadmap), []);
});

test("every phase in the roadmap declares all six required fields", () => {
  const phases = phaseBodies(roadmap);
  assert.ok(phases.length >= 2, "the roadmap must declare PH-01 and PH-02");
  for (const phase of phases) {
    assert.deepEqual(
      missingPhaseFields(phase.body),
      [],
      `${phase.id} is missing a required field`,
    );
  }
});

test("the roadmap itself carries no implementation", () => {
  assert.deepEqual(implementationLeaks(roadmap), []);
});

test("a link to a file that does not exist is reported as broken", () => {
  const fixture = "이 문서를 본다: [없는 파일](does-not-exist-xyz.md).";
  assert.deepEqual(brokenLinks(fixture, roadmapFile, root), [
    "does-not-exist-xyz.md",
  ]);
});

test("a phase identifier that is not two digits is reported as malformed", () => {
  const fixture = "## PH-1 — 제목\n\n본문.\n";
  assert.deepEqual(malformedPhaseIds(fixture), ["PH-1"]);
});

test("a phase identifier used twice is reported as a duplicate", () => {
  const fixture = "## PH-01 — 하나\n\n본문.\n\n## PH-01 — 둘\n\n본문.\n";
  assert.deepEqual(duplicatePhaseIds(fixture), ["PH-01"]);
});

test("a phase missing a required field is reported by name", () => {
  const fixture = `**목표.** 있다.

**수용 기준.** 있다.

**검증 방법.** 있다.

**주의사항.** 있다.

**비목표.** 있다.
`;
  assert.deepEqual(missingPhaseFields(fixture), ["가이드"]);
});

test("a fenced code block in the roadmap is reported as a leak", () => {
  const fixture = "설명.\n\n```js\nfoo();\n```\n";
  assert.deepEqual(implementationLeaks(fixture), ["code-block"]);
});

test("text that reads like a function signature is reported as a leak", () => {
  const fixture = "이 함수는 `foo(bar)`처럼 동작한다.";
  assert.deepEqual(implementationLeaks(fixture), ["signature"]);
});

test("an arrow function in the roadmap is reported as a signature leak", () => {
  const fixture = "handler = () => {}";
  assert.deepEqual(implementationLeaks(fixture), ["signature"]);
});

test("a path in backticks without a markdown link is reported as a leak", () => {
  const fixture = "새 파일 `scripts/newthing.mjs`를 만든다.";
  assert.deepEqual(implementationLeaks(fixture), ["unlinked-path"]);
});

test("a path in backticks inside a markdown link is not reported as a leak", () => {
  const fixture = "[`scripts/metadata.mjs`](../scripts/metadata.mjs)를 본다.";
  assert.deepEqual(implementationLeaks(fixture), []);
});
