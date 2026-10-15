/** Verifies lifecycle reports preserve the full task and distinguish observation from termination. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { stringify } from "yaml";
import { parse } from "parse5";
import { convertDocument, parseOmtDocument } from "../scripts/documents.mjs";

const directory = fileURLToPath(
  new URL("../plugins/oh-my-teams/references/documents/", import.meta.url),
);
const cli = fileURLToPath(new URL("../scripts/documents.mjs", import.meta.url));
const example = (name) =>
  fs.readFileSync(path.join(directory, `${name}.example.yaml`), "utf8");
const data = (name) => parseOmtDocument(example(name));
const taskSource = example("task-request");
const convert = (value, options) =>
  convertDocument(stringify(value), "json", options);

test("completion and interruption reports correlate with the task while the final commit can change", () => {
  for (const name of ["completion-report", "interruption-report"]) {
    assert.doesNotThrow(() =>
      convertDocument(example(name), "check", { taskSource }),
    );
  }
  assert.notEqual(
    data("task-request").subject.commit,
    data("completion-report").subject.commit,
  );
});

for (const [name, change, expected] of [
  [
    "missing base commit",
    (value) => {
      delete value.subject.commit;
    },
    /fixed subject.commit/,
  ],
  [
    "merge without authorization",
    (value) => {
      value.payload.delivery.mode = "merge";
      value.payload.delivery.authorization = null;
    },
    /recorded authorization/,
  ],
  [
    "delivery without target",
    (value) => {
      value.payload.delivery.target = null;
    },
    /requires a target/,
  ],
  [
    "duplicate criteria",
    (value) => {
      value.payload.acceptance_criteria.push(
        value.payload.acceptance_criteria[0],
      );
    },
    /criteria must be unique/,
  ],
  [
    "duplicate check names",
    (value) => {
      value.payload.required_checks.push({
        ...value.payload.required_checks[0],
        command: "different",
      });
    },
    /names must be unique/,
  ],
]) {
  test(`task rejects ${name}`, () => {
    const value = data("task-request");
    change(value);
    assert.throws(() => convert(value), expected);
  });
}

for (const [name, change, expected] of [
  [
    "unmet criterion",
    (p) => {
      p.acceptance_results[0].result = "unmet";
    },
    /all acceptance criteria/,
  ],
  [
    "unsupported criterion",
    (p) => {
      p.acceptance_results[0].evidence = [];
    },
    /require evidence/,
  ],
  [
    "failed mandatory check",
    (p) => {
      p.checks[0].status = "failed";
    },
    /mandatory checks/,
  ],
  [
    "skipped mandatory check",
    (p) => {
      p.checks[0].status = "skipped";
    },
    /mandatory checks/,
  ],
  [
    "unsupported passed check",
    (p) => {
      p.checks[0].evidence = [];
    },
    /require evidence/,
  ],
  [
    "remaining work",
    (p) => {
      p.remaining = ["필수 작업이 남아 있습니다."];
    },
    /remaining required work/,
  ],
  [
    "incomplete without remaining work",
    (p) => {
      p.outcome = "incomplete";
    },
    /requires remaining work/,
  ],
]) {
  test(`completion rejects ${name}`, () => {
    const value = data("completion-report");
    change(value.payload);
    assert.throws(() => convert(value), expected);
  });
}

test("completion cannot reduce original criteria, checks, delivery, or required cleanup", () => {
  for (const [change, expected] of [
    [
      (v) => {
        v.in_reply_to = "different-task";
      },
      /must match task/,
    ],
    [
      (v) => {
        v.subject.worktree_id = "different-worktree";
      },
      /must match task/,
    ],
    [
      (v) => {
        v.payload.acceptance_results[0].criterion = "축소한 기준입니다.";
      },
      /preserve every requested/,
    ],
    [
      (v) => {
        v.payload.checks = [];
      },
      /preserve required check/,
    ],
    [
      (v) => {
        v.payload.checks[0].required = false;
      },
      /preserve required check/,
    ],
    [
      (v) => {
        v.payload.checks[0].command = "npm run lint";
      },
      /preserve required check/,
    ],
    [
      (v) => {
        v.payload.delivery.state = "pending";
      },
      /requested delivery/,
    ],
    [
      (v) => {
        v.payload.cleanup = {
          state: "preserved",
          remaining: ["보존한 워크트리입니다."],
        };
      },
      /requested cleanup/,
    ],
  ]) {
    const value = data("completion-report");
    change(value);
    assert.throws(() => convert(value, { taskSource }), expected);
  }
});

test("incomplete reports preserve unmet criteria and required work without claiming completion", () => {
  const value = data("completion-report");
  value.payload.outcome = "incomplete";
  value.payload.acceptance_results[0].result = "unknown";
  value.payload.acceptance_results[0].evidence = [];
  value.payload.checks[0].status = "unregistered";
  value.payload.checks[0].evidence = [];
  value.payload.delivery.state = "pending";
  value.payload.cleanup = {
    state: "preserved",
    remaining: ["세션을 다시 확인해야 합니다."],
  };
  value.payload.remaining = ["검사 등록과 필수 정리를 완료해야 합니다."];
  const actual = JSON.parse(convert(value, { taskSource }));
  assert.equal(actual.payload.outcome, "incomplete");
  assert.equal(actual.payload.checks[0].status, "unregistered");
});

test("completion rejects stale or incomplete CI approvals", () => {
  const value = data("completion-report");
  const check = data("status-report").payload.ci[0];
  value.payload.ci = [check];
  assert.throws(() => convert(value), /observed Git HEAD/);
  check.source_commit = value.subject.commit;
  assert.doesNotThrow(() => convert(value));
  check.status = "cancelled";
  assert.throws(() => convert(value), /CI approvals/);
});

test("termination requires permission and confirmed exit; unknown sessions stay preserved", () => {
  const value = data("interruption-report");
  const session = value.payload.sessions[0];
  session.action = "stopped";
  assert.throws(() => convert(value), /recorded authorization/);
  session.stop_authorization =
    "사용자가 이 세션의 중단을 요청한 가상의 예제입니다.";
  assert.throws(() => convert(value), /confirmed exit/);
  session.liveness = "exited";
  assert.doesNotThrow(() => convert(value));
  const unknown = data("interruption-report");
  unknown.payload.uncertainties = [];
  assert.throws(() => convert(unknown), /requires uncertainties/);
});

test("every lifecycle field survives HTML rendering as text", () => {
  for (const name of [
    "task-request",
    "completion-report",
    "interruption-report",
  ]) {
    const value = data(name);
    const nodes = [];
    const walk = (node) => {
      nodes.push(node);
      for (const child of node.childNodes ?? []) walk(child);
    };
    walk(parse(convertDocument(example(name), "html")));
    const text = nodes
      .filter((node) => node.nodeName === "#text")
      .map((node) => node.value)
      .join("\n");
    const leaves = (item) =>
      item && typeof item === "object"
        ? Object.values(item).flatMap(leaves)
        : [item];
    for (const leaf of leaves(value).filter((item) => typeof item === "string"))
      assert.ok(text.includes(leaf), `${name}: ${leaf}`);
  }
});

test("CLI supports task correlation and rejects mixed or unrelated context", () => {
  const task = path.join(directory, "task-request.example.yaml");
  const completion = path.join(directory, "completion-report.example.yaml");
  const interruption = path.join(directory, "interruption-report.example.yaml");
  const review = path.join(directory, "review-request.example.yaml");
  const run = (args) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  for (const report of [completion, interruption]) {
    const receipt = run(["check", report, "--task", task]);
    assert.equal(receipt.status, 0, receipt.stderr);
    assert.equal(JSON.parse(receipt.stdout).status, "passed");
  }
  assert.notEqual(
    run(["check", completion, "--task", task, "--request", review]).status,
    0,
  );
  assert.notEqual(run(["check", review, "--task", task]).status, 0);
  assert.notEqual(run(["check", completion, "--task", review]).status, 0);
  assert.throws(
    () =>
      parseOmtDocument(example("completion-report"), {
        taskSource,
        requestSource: example("review-request"),
      }),
    /choose either/,
  );
});
