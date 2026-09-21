/** The review record format reaches the reviewer, so nobody rewrites a review. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import { validateReviewInput } from "../plugins/oh-my-teams/scripts/gates.mjs";
import { roleSpec } from "../plugins/oh-my-teams/scripts/role-launch.mjs";

const example = (file) =>
  readJSON(path.resolve("plugins/oh-my-teams/examples", file));

test("both review examples are records review-record accepts", () => {
  // #40: examples/review.json had an empty findings array, so no reviewer
  // could see what a finding looks like.
  const task = example("task.v2.json");
  const approved = validateReviewInput(example("review.json"), task);
  assert.deepEqual(
    approved.findings.map((finding) => finding.status),
    ["resolved", "accepted-risk"],
  );
  const rejected = validateReviewInput(
    example("review.changes-requested.json"),
    task,
  );
  assert.equal(rejected.conclusion, "changes-requested");
  assert.equal(rejected.findings[0].status, "open");
});

test("a finding in another shape is refused with the expected format", () => {
  const task = example("task.v2.json");
  const review = example("review.changes-requested.json");
  // The shape the literacy-test reviewer wrote before PM rewrote it.
  review.findings = [
    {
      line: 42,
      claim: "test takes 20 minutes",
      url: "https://example.invalid",
      verdict: "unsupported",
      note: "page says 15 minutes",
    },
  ];
  assert.throws(
    () => validateReviewInput(review, task),
    /Finding id required \(finding 1\)\. Each finding is \{id: .*status: open\|resolved\|accepted-risk.*examples\/review\.changes-requested\.json/,
  );
  review.findings = [
    { id: "sample-1", status: "resolved", description: "fixed" },
  ];
  assert.throws(
    () => validateReviewInput(review, task),
    /Resolved finding needs evidence: sample-1\. Each finding is/,
  );
});

test("the reviewer's own instructions carry the record format", () => {
  // The format lives in Senior's charter, which role-spec puts at the head of
  // every task a Senior receives.
  const org = example("organization.json");
  const spec = roleSpec(org, "senior", "출처 표본을 대조해 검토한다.");
  assert.match(spec, /`review-record`의 입력 형식으로 직접 작성한다/);
  assert.match(spec, /`status`\(`open`·`resolved`·`accepted-risk`\)/);
  assert.match(spec, /review\.changes-requested\.json/);
});

test("every role's instructions keep scratch files out of the worktree", () => {
  // #38: Junior and Senior left node_modules, package.json and scratch scripts
  // in the report worktree, and untracked files change verify's fingerprint.
  const org = example("organization.json");
  for (const role of ["pl", "senior", "junior"]) {
    assert.match(
      roleSpec(org, role, "작업"),
      /워크트리 밖의 임시 디렉터리에서 만든다/,
    );
  }
});

test("the PM skill runs a rejected review through workflow-rework", () => {
  const read = (file) =>
    fs.readFileSync(path.resolve("plugins/oh-my-teams/skills", file), "utf8");
  const pm = read("pm/SKILL.md");
  assert.match(pm, /node <runtime> workflow-rework --id/);
  assert.match(pm, /retry`가 아니라 검토 반려 루프/);
  assert.match(read("pl/SKILL.md"), /workflow-rework/);
});
