/** Exercises source-bound completion evidence, explicit CI requirements and delivery correlation. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { stringify } from "yaml";
import { parse } from "parse5";
import { parseOmtDocument, convertDocument } from "../scripts/documents.mjs";
import { temporaryDirectory } from "./helpers/plugin-fixture.mjs";

const directory = new URL(
  "../plugins/oh-my-teams/references/documents/",
  import.meta.url,
);
const source = (name) =>
  fs.readFileSync(new URL(`${name}.example.yaml`, directory), "utf8");
const task = () => parseOmtDocument(source("verified-task"));
const completion = () => parseOmtDocument(source("verified-completion"));
const verify = (report, request = task()) =>
  parseOmtDocument(stringify(report), { taskSource: stringify(request) });

test("verified and legacy task/report pairs retain their original fields without defaults", () => {
  for (const [request, report] of [
    ["verified-task", "verified-completion"],
    ["task-request", "completion-report"],
  ]) {
    const expected = parseOmtDocument(source(report));
    assert.deepEqual(
      verify(expected, parseOmtDocument(source(request))),
      expected,
    );
  }
});

for (const [name, change, expected] of [
  [
    "missing check source",
    (r) => {
      delete r.payload.checks[0].source_commit;
    },
    /check source_commit/,
  ],
  [
    "stale check source",
    (r) => {
      r.payload.checks[0].source_commit = "a".repeat(40);
    },
    /passed check must match/,
  ],
  [
    "missing CI",
    (r) => {
      r.payload.ci = [];
    },
    /each required CI/,
  ],
  [
    "duplicate CI",
    (r) => {
      r.payload.ci.push(structuredClone(r.payload.ci[0]));
    },
    /each required CI/,
  ],
  [
    "different CI name",
    (r) => {
      r.payload.ci[0].name = "unrelated";
    },
    /each required CI/,
  ],
  [
    "different CI branch",
    (r) => {
      r.payload.ci[0].target_branch = "other";
    },
    /requested target branch/,
  ],
  [
    "stale CI",
    (r) => {
      r.payload.ci[0].source_commit = "a".repeat(40);
    },
    /observed Git HEAD/,
  ],
  [
    "running CI",
    (r) => {
      r.payload.ci[0].status = "running";
    },
    /CI approvals/,
  ],
  [
    "missing review",
    (r) => {
      delete r.payload.reviews;
    },
    /independent review evidence/,
  ],
  [
    "self review",
    (r) => {
      r.payload.reviews[0].reviewer_session_id =
        r.subject.implementation_session_id;
    },
    /cannot independently review/,
  ],
  [
    "nonindependent review",
    (r) => {
      r.payload.reviews[0].independent = false;
    },
    /independent review evidence/,
  ],
  [
    "stale review",
    (r) => {
      r.payload.reviews[0].source_commit = "a".repeat(40);
    },
    /review must match final source/,
  ],
  [
    "different implementer",
    (r) => {
      r.payload.reviews[0].implementation_session_id = "other";
    },
    /match implementation session/,
  ],
  [
    "missing implementer",
    (r) => {
      delete r.subject.implementation_session_id;
    },
    /match implementation session/,
  ],
  [
    "unresolved review",
    (r) => {
      r.payload.reviews[0].conclusion = "changes_requested";
    },
    /unresolved or inconclusive/,
  ],
  [
    "inconclusive review",
    (r) => {
      r.payload.reviews[0].conclusion = "inconclusive";
    },
    /unresolved or inconclusive/,
  ],
  [
    "duplicate review",
    (r) => {
      r.payload.reviews.push(structuredClone(r.payload.reviews[0]));
    },
    /result IDs must be unique/,
  ],
  [
    "missing delivery receipt",
    (r) => {
      delete r.payload.delivery.receipt;
    },
    /requires delivery receipt/,
  ],
  [
    "different delivery target",
    (r) => {
      r.payload.delivery.receipt.target = "other/main";
    },
    /requested target/,
  ],
  [
    "different delivery mode",
    (r) => {
      r.payload.delivery.receipt.mode = "artifact";
    },
    /requested mode/,
  ],
  [
    "stale delivered source",
    (r) => {
      r.payload.delivery.receipt.source_commit = "a".repeat(40);
    },
    /receipt must match final source/,
  ],
  [
    "empty receipt evidence",
    (r) => {
      r.payload.delivery.receipt.evidence = [];
    },
    /fewer than 1/,
  ],
  [
    "pending delivery with receipt",
    (r) => {
      r.payload.delivery.state = "pending";
    },
    /receipt requires delivered/,
  ],
]) {
  test(`verified completion rejects ${name}`, () => {
    const report = completion();
    change(report);
    assert.throws(() => verify(report), expected);
  });
}

test("verification requirements reject duplicate CI names and impossible delivery requests", () => {
  const request = task();
  request.payload.verification.required_ci.push(
    structuredClone(request.payload.verification.required_ci[0]),
  );
  assert.throws(
    () => parseOmtDocument(stringify(request)),
    /required CI names must be unique/,
  );
  request.payload.verification.required_ci = [];
  request.payload.delivery = {
    mode: "none",
    target: null,
    authorization: null,
  };
  assert.throws(() => parseOmtDocument(stringify(request)), /without delivery/);
  request.payload.verification.delivery_receipt = false;
  assert.doesNotThrow(() => parseOmtDocument(stringify(request)));
});

test("merge receipts preserve both implementation and resulting merge commit identities", () => {
  const request = task();
  request.payload.delivery.mode = "merge";
  const report = completion();
  const receipt = report.payload.delivery.receipt;
  receipt.mode = "merge";
  assert.throws(() => verify(report, request), /require delivered_commit/);
  receipt.delivered_commit = "b".repeat(40);
  assert.doesNotThrow(() => verify(report, request));
  request.payload.delivery.mode = "commit";
  receipt.mode = "commit";
  assert.throws(() => verify(report, request), /preserve final source/);
  receipt.delivered_commit = report.subject.commit;
  assert.doesNotThrow(() => verify(report, request));
});

test("an incomplete report can preserve missing evidence without reducing the requested gates", () => {
  const report = completion();
  report.payload.outcome = "incomplete";
  report.payload.remaining = [
    "최종 커밋의 검사와 독립 검토, 전달을 확인해야 합니다.",
  ];
  report.payload.ci = [];
  report.payload.reviews = [];
  report.payload.checks[0].status = "unknown";
  delete report.payload.checks[0].source_commit;
  report.payload.delivery = { state: "unknown", reference: null };
  assert.equal(verify(report).payload.outcome, "incomplete");
  report.payload.outcome = "completed";
  report.payload.remaining = [];
  assert.throws(() => verify(report), /mandatory checks/);
});

test("review and delivery evidence cannot be discarded by correlating to a legacy task", () => {
  const request = parseOmtDocument(source("task-request"));
  const report = completion();
  report.in_reply_to = request.id;
  report.payload.delivery.receipt.target = "other/main";
  assert.throws(() => verify(report, request), /requested target/);
  report.payload.delivery.receipt.target = request.payload.delivery.target;
  report.payload.reviews[0].conclusion = "changes_requested";
  assert.throws(() => verify(report, request), /unresolved or inconclusive/);
});

test("verification receipts remain inert text and retain every evidence field in HTML", () => {
  const report = completion();
  report.payload.reviews[0].evidence[0].excerpt =
    '<script>alert("review")</script>';
  const html = convertDocument(stringify(report), "html", {
    taskSource: source("verified-task"),
  });
  const nodes = [];
  const walk = (node) => {
    nodes.push(node);
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(parse(html));
  assert.ok(!nodes.some((node) => node.tagName === "script"));
  const text = nodes
    .filter((node) => node.nodeName === "#text")
    .map((node) => node.value)
    .join("\n");
  const leaves = (item) =>
    item && typeof item === "object"
      ? Object.values(item).flatMap(leaves)
      : [item];
  for (const value of leaves(report).filter(
    (value) => typeof value === "string",
  ))
    assert.ok(text.includes(value), value);
});

test("CLI correlates verified reports and reports a mismatched delivery target", (t) => {
  const root = temporaryDirectory(t);
  const request = path.join(root, "task.yaml");
  const response = path.join(root, "completion.yaml");
  fs.writeFileSync(request, source("verified-task"));
  fs.writeFileSync(response, source("verified-completion"));
  const run = () =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/documents.mjs", import.meta.url)),
        "check",
        response,
        "--task",
        request,
      ],
      { encoding: "utf8" },
    );
  assert.equal(run().status, 0);
  const report = completion();
  report.payload.delivery.receipt.target = "other/main";
  fs.writeFileSync(response, stringify(report));
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requested target/);
  assert.equal(result.stdout, "");
});
