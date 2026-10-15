/** Exercises installed document contracts, YAML boundaries, report invariants, and CLI output. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { stringify } from "yaml";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { parse } from "parse5";
import { convertDocument, parseOmtDocument } from "../scripts/documents.mjs";
import { parseOmtYaml } from "../scripts/adapters/omt-documents.mjs";
import {
  pluginFixture,
  temporaryDirectory,
} from "./helpers/plugin-fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const documents = path.join(root, "plugins/oh-my-teams/references/documents");
const cli = path.join(root, "scripts/documents.mjs");
const example = (name) =>
  fs.readFileSync(path.join(documents, `${name}.example.yaml`), "utf8");
const data = (name) => JSON.parse(convertDocument(example(name), "json"));
const convert = (value, format = "json", options) =>
  convertDocument(stringify(value), format, options);

test("all bundled examples validate in an isolated skill installation", (t) => {
  const plugin = pluginFixture(t);
  const directory = path.join(plugin, "references/documents");
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(
    JSON.parse(
      fs.readFileSync(path.join(directory, "document.schema.json"), "utf8"),
    ),
  );
  const examples = fs
    .readdirSync(directory)
    .filter((file) => file.endsWith(".example.yaml"));
  assert.equal(examples.length, 3);
  for (const file of examples) {
    const source = fs.readFileSync(path.join(directory, file), "utf8");
    assert.equal(
      validate(parseOmtYaml(source)),
      true,
      `${file}: ${ajv.errorsText(validate.errors)}`,
    );
    assert.equal(JSON.parse(convertDocument(source, "check")).status, "passed");
  }
  const protocol = parseOmtYaml(
    fs.readFileSync(path.join(directory, "protocol.yaml"), "utf8"),
  );
  assert.equal(fs.existsSync(path.join(directory, protocol.schema)), true);
});

test("YAML conversion preserves multiline prose, booleans, nulls, and quoted identifiers", () => {
  const value = data("status-report");
  value.payload.summary = "첫 번째 문장입니다.\n두 번째 문장입니다.\n";
  value.id = "001";
  const actual = JSON.parse(convert(value));
  assert.equal(actual.id, "001");
  assert.equal(actual.payload.summary, value.payload.summary);
  assert.equal(actual.payload.git.dirty, false);
  assert.equal(actual.payload.delivery.reference, null);
  assert.deepEqual(parseOmtDocument(stringify(value)), actual);
});

for (const [name, source] of Object.entries({
  duplicate: "key: first\nkey: second\n",
  anchor: "key: &value hello\n",
  alias: "key: *missing\n",
  merge: "<<: {}\n",
  tag: "key: !!str hello\n",
  custom_tag: "key: !custom hello\n",
  numeric_key: "12: hello\n",
  complex_key: "? [one, two]\n: hello\n",
  infinity: "key: .inf\n",
  nan: "key: .nan\n",
  unsafe_integer: "key: 9007199254740993\n",
  old_version: "%YAML 1.1\n---\nkey: yes\n",
  stream: "key: first\n---\nkey: second\n",
  scalar: "plain text\n",
  sequence: "- item\n",
  empty: "",
  nesting: `key: ${"[".repeat(45)}null${"]".repeat(45)}\n`,
  size: `key: ${"x".repeat(1_000_000)}\n`,
})) {
  test(`restricted YAML rejects ${name}`, () => {
    assert.throws(() => parseOmtYaml(source), SyntaxError);
  });
}

for (const [name, change] of [
  [
    "unknown version",
    (value) => {
      value.schema_version = 2;
    },
  ],
  [
    "unknown kind",
    (value) => {
      value.kind = "unknown";
    },
  ],
  [
    "unknown envelope key",
    (value) => {
      value.extra = true;
    },
  ],
  [
    "unknown payload key",
    (value) => {
      value.payload.extra = true;
    },
  ],
  [
    "missing summary",
    (value) => {
      delete value.payload.summary;
    },
  ],
  [
    "coerced boolean",
    (value) => {
      value.payload.git.dirty = "false";
    },
  ],
  [
    "invalid calendar date",
    (value) => {
      value.issued_at = "2026-02-30T09:00:00Z";
    },
  ],
  [
    "abbreviated commit",
    (value) => {
      value.payload.git.head = "1234567";
    },
  ],
  [
    "blank summary",
    (value) => {
      value.payload.summary = "   ";
    },
  ],
]) {
  test(`schema rejects ${name}`, () => {
    const value = data("status-report");
    change(value);
    assert.throws(() => convert(value), SyntaxError);
  });
}

test("audit result cannot claim independent review from the implementation session", () => {
  const value = data("review-result");
  value.issuer.session_id = value.subject.implementation_session_id;
  assert.throws(() => convert(value), /cannot claim independent/);
  value.payload.independent = false;
  assert.doesNotThrow(() => convert(value));
});

test("auditor request requires a fixed full commit and implementation session", () => {
  for (const field of ["commit", "implementation_session_id"]) {
    const value = data("review-request");
    delete value.subject[field];
    assert.throws(() => convert(value), /auditor documents require/);
  }
});

test("review conclusions and per-finding evidence cannot contradict the report", () => {
  const value = data("review-result");
  value.payload.conclusion = "no_findings";
  assert.throws(() => convert(value), /cannot contain findings/);
  value.payload.findings = [];
  assert.doesNotThrow(() => convert(value));
  value.payload.conclusion = "changes_requested";
  assert.throws(() => convert(value), /requires findings/);
  value.payload.conclusion = "inconclusive";
  value.payload.uncertainties = [];
  assert.throws(() => convert(value), /requires uncertainties/);
  const finding = data("review-result");
  finding.payload.findings[0].evidence = [];
  assert.throws(() => convert(finding), /fewer than 1/);
});

test("review result is correlated with request identity, purpose, and exact subject", () => {
  const requestSource = example("review-request");
  assert.doesNotThrow(() =>
    convertDocument(example("review-result"), "json", { requestSource }),
  );
  for (const change of [
    (value) => {
      value.in_reply_to = "another-request";
    },
    (value) => {
      value.payload.purpose = "advisor";
    },
    (value) => {
      value.subject.commit = "2".repeat(40);
    },
    (value) => {
      value.subject.worktree_id = "another-worktree";
    },
    (value) => {
      value.subject.implementation_session_id = "another-implementation";
    },
  ]) {
    const value = data("review-result");
    change(value);
    assert.throws(
      () => convert(value, "json", { requestSource }),
      /must match|differs/,
    );
  }
});

test("failed observation keeps known build IDs but cannot assert success", () => {
  const value = data("status-report");
  value.payload.observation = "failed";
  value.payload.uncertainties = ["Orca와 CI 조회에 실패했습니다."];
  assert.throws(() => convert(value), /unknown execution/);
  value.payload.execution = "unknown";
  value.payload.git = null;
  assert.throws(() => convert(value), /cannot assert current CI/);
  value.payload.ci[0].status = "unknown";
  const actual = JSON.parse(convert(value));
  assert.equal(actual.payload.ci[0].build_id, "example-build-001");
  assert.equal(actual.payload.execution, "unknown");
});

for (const [name, change, expected] of [
  [
    "worktree mismatch",
    (p) => {
      p.worktree.id = "different";
    },
    /IDs must match/,
  ],
  [
    "partial without uncertainty",
    (p) => {
      p.observation = "partial";
    },
    /requires uncertainties/,
  ],
  [
    "CI without build",
    (p) => {
      p.ci[0].build_id = null;
    },
    /requires build_id/,
  ],
  [
    "unregistered with build",
    (p) => {
      p.ci[0].status = "unregistered";
    },
    /cannot have build_id/,
  ],
  [
    "CI without target",
    (p) => {
      p.ci[0].target_branch = null;
    },
    /requires source_commit and target_branch/,
  ],
  [
    "stale CI success",
    (p) => {
      p.ci[0].source_commit = "2".repeat(40);
    },
    /observed Git HEAD/,
  ],
  [
    "delivery without location",
    (p) => {
      p.delivery.state = "delivered";
    },
    /require a reference/,
  ],
  [
    "cleanup still remaining",
    (p) => {
      p.cleanup.state = "completed";
    },
    /cannot have remaining/,
  ],
  [
    "preserved without reason",
    (p) => {
      p.cleanup.remaining = [];
    },
    /requires remaining/,
  ],
]) {
  test(`status rejects ${name}`, () => {
    const value = data("status-report");
    change(value.payload);
    assert.throws(() => convert(value), expected);
  });
}

test("empty CI is represented as empty data, independently of delivery and cleanup", () => {
  const value = data("status-report");
  value.payload.ci = [];
  value.payload.delivery = {
    state: "delivered",
    reference: "https://example.com/pr/1",
  };
  const actual = JSON.parse(convert(value));
  assert.deepEqual(actual.payload.ci, []);
  assert.equal(actual.payload.delivery.state, "delivered");
  assert.equal(actual.payload.cleanup.state, "preserved");
});

test("HTML retains every value and renders attacker strings as inert text", () => {
  const value = data("review-result");
  const attack =
    '<script>alert("x")</script><img src=x onerror=alert(1)>& javascript:alert(1)';
  value.payload.summary = attack;
  value.payload.findings[0].evidence[0].locator = "javascript:alert(1)";
  const html = convert(value, "html");
  assert.ok(html.startsWith("<!doctype html>"));
  assert.match(html, /default-src 'none'/);
  const nodes = [];
  const walk = (node) => {
    nodes.push(node);
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(parse(html));
  assert.equal(
    nodes.some((node) =>
      ["script", "img", "a", "iframe", "object", "link"].includes(node.tagName),
    ),
    false,
  );
  assert.equal(
    nodes.some((node) =>
      (node.attrs ?? []).some((attr) => /^on/.test(attr.name)),
    ),
    false,
  );
  const text = nodes
    .filter((node) => node.nodeName === "#text")
    .map((node) => node.value)
    .join("\n");
  const leaves = (item) =>
    item && typeof item === "object"
      ? Object.values(item).flatMap(leaves)
      : [item];
  for (const leaf of leaves(value).filter((item) => typeof item === "string"))
    assert.ok(text.includes(leaf), leaf);
  assert.ok(text.includes(attack));
});

test("CLI converts files and stdin, correlates replies, and refuses destructive output", (t) => {
  const directory = temporaryDirectory(t);
  const output = path.join(directory, "review.html");
  const request = path.join(documents, "review-request.example.yaml");
  const result = path.join(documents, "review-result.example.yaml");
  const run = (args, input) =>
    spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      input,
      cwd: directory,
    });
  let receipt = run(["html", result, output, "--request", request]);
  assert.equal(receipt.status, 0, receipt.stderr);
  assert.match(fs.readFileSync(output, "utf8"), /검토 결과/);
  const before = fs.readFileSync(output, "utf8");
  receipt = run(["json", result, output]);
  assert.notEqual(receipt.status, 0);
  assert.equal(fs.readFileSync(output, "utf8"), before);
  receipt = run(["json", "-"], example("status-report"));
  assert.equal(receipt.status, 0, receipt.stderr);
  assert.equal(JSON.parse(receipt.stdout).kind, "status_report");
  receipt = run(["check", result, "--request", request]);
  assert.equal(receipt.status, 0, receipt.stderr);
  assert.equal(JSON.parse(receipt.stdout).status, "passed");
  receipt = run(
    ["html", "-", path.join(directory, "invalid.html")],
    "kind: unknown\n",
  );
  assert.notEqual(receipt.status, 0);
  assert.equal(receipt.stdout, "");
  assert.equal(fs.existsSync(path.join(directory, "invalid.html")), false);
  for (const args of [
    [],
    ["xml", result],
    ["check", result, output],
    ["json", result, "--bad"],
    ["json", result, "--request", "-"],
  ]) {
    assert.notEqual(run(args).status, 0, args.join(" "));
  }
});
