/** The subagent rule, the removed assist feature, and legacy `assistants` files. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  chart,
  definedRoles,
  readJSON,
  saveOrg,
  validateOrg,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import { REQUIRED_OPTIONS } from "../plugins/oh-my-teams/scripts/teams-org.mjs";
import * as worker from "../plugins/oh-my-teams/scripts/worker.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = path.join(root, "plugins/oh-my-teams");
const cli = path.join(plugin, "scripts/teams-org.mjs");
const read = (...parts) => fs.readFileSync(path.join(plugin, ...parts), "utf8");
const example = () =>
  readJSON(path.join(plugin, "examples", "organization.json"));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-subagents-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An organization file as 2.10.x saved it: with an `assistants` allowlist. */
function legacyFile(t, assistants) {
  const dir = tempDir(t);
  const file = path.join(dir, "organization.json");
  const org = { ...example(), assistants };
  fs.writeFileSync(file, `${JSON.stringify(org, null, 2)}\n`);
  return { dir, file, org };
}

test("the assist command, export and reference are gone", () => {
  assert.equal(worker.assist, undefined);
  assert.equal(REQUIRED_OPTIONS.assist, undefined);
  assert.equal(fs.existsSync(path.join(plugin, "references/assist.md")), false);
  const run = spawnSync(process.execPath, [cli, "assist"], {
    encoding: "utf8",
  });
  assert.notEqual(run.status, 0);
});

test("advise and draft still exist", () => {
  assert.equal(typeof worker.advise, "function");
  assert.equal(typeof worker.draft, "function");
  assert.ok(REQUIRED_OPTIONS.advise);
});

test("no active file advertises assist or the assistants setting", () => {
  const skills = fs.readdirSync(path.join(plugin, "skills"));
  const files = [
    path.join(root, "README.md"),
    ...skills.map((name) => path.join(plugin, "skills", name, "SKILL.md")),
    ...fs
      .readdirSync(path.join(plugin, "references"))
      .filter((name) => name !== "subagents.md")
      .map((name) => path.join(plugin, "references", name)),
    ...fs
      .readdirSync(path.join(plugin, "examples"))
      .map((name) => path.join(plugin, "examples", name)),
  ].filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      text,
      /\bassistants\b|`assist`|\bassist\s+--|assist\.md|teams-org\.mjs assist|보조 도구(?! 명령)/,
      `${path.relative(root, file)} still advertises assist`,
    );
  }
  for (const name of fs.readdirSync(path.join(plugin, "examples"))) {
    if (!name.startsWith("organization")) continue;
    const org = readJSON(path.join(plugin, "examples", name));
    assert.equal(Object.hasOwn(org, "assistants"), false, name);
  }
});

test("an organization file that still has assistants stays valid and the key changes nothing", () => {
  const plain = validateOrg(example());
  for (const assistants of [
    { pm: ["agy-oss"], junior: ["agy-oss"] },
    // Contents the removed validation refused now go unread instead.
    { pm: ["missing-profile"], nobody: [] },
  ]) {
    const legacy = validateOrg({ ...example(), assistants });
    assert.deepEqual(definedRoles(legacy), definedRoles(plain));
    assert.equal(chart(legacy), chart(plain));
    const { assistants: kept, ...rest } = legacy;
    assert.deepEqual(kept, assistants);
    assert.deepEqual(rest, plain);
  }
});

test("reading an organization does not rewrite a file that has assistants", (t) => {
  const { dir, file } = legacyFile(t, { pm: ["agy-oss"] });
  const before = fs.readFileSync(file);
  const stat = fs.statSync(file);

  const shown = spawnSync(process.execPath, [cli, "validate", "--org", file], {
    encoding: "utf8",
  });
  assert.equal(shown.status, 0, shown.stderr);
  // Saving without `update` reads and returns the file as it is.
  const existing = saveOrg(file, example());
  assert.equal(existing.created, false);

  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs);
  assert.equal(fs.existsSync(path.join(dir, "history")), false);
});

test("the next saved revision drops assistants and keeps the old one in history", (t) => {
  const { dir, file, org } = legacyFile(t, { pm: ["agy-oss"] });
  const original = fs.readFileSync(file, "utf8");

  // adjust reads the file, edits it and saves the whole document back, so the
  // proposed document still carries the key it read.
  const saved = saveOrg(file, org, {
    update: true,
    expectedRevision: org.revision,
  });
  assert.equal(saved.organization.revision, org.revision + 1);
  assert.equal(Object.hasOwn(saved.organization, "assistants"), false);
  assert.equal(Object.hasOwn(readJSON(file), "assistants"), false);
  assert.deepEqual(readJSON(file), saved.organization);

  const archived = path.join(dir, "history", `org-${org.revision}.json`);
  assert.equal(fs.readFileSync(archived, "utf8").trim(), original.trim());
  assert.deepEqual(readJSON(archived).assistants, { pm: ["agy-oss"] });
});

test("the schema and the reference document how legacy assistants behave", () => {
  const schema = readJSON(
    path.join(plugin, "schemas/organization.schema.json"),
  );
  const comment = schema.properties.assistants.$comment;
  assert.match(comment, /stays valid/);
  assert.match(comment, /no effect/);
  assert.match(comment, /never rewrites the file on read/);
  assert.match(comment, /drops it/);
  const reference = read("references/subagents.md");
  for (const point of [
    /계속 유효하며/,
    /어떤 동작도 바꾸지 않는다/,
    /파일을 읽을 때 그 파일을 다시 쓰지 않는다/,
    /다음에 저장되는 revision에서는 `assistants` 키가 빠진다/,
  ]) {
    assert.match(reference, point);
  }
});

test("the subagent reference states the rule, ownership and prohibitions", () => {
  const rule = read("references/subagents.md");
  for (const point of [
    /## 서브에이전트와 Worker/,
    /병렬 편집/,
    /자기 작업 계약과 커밋·보고가 필요한 일/,
    /정식 독립 검토/,
    /OMT 역할이나 승인자가 아니다/,
    /호출한 역할이 소유한다/,
    /한 번에 하나만 허용한다/,
    /워크트리, 브랜치, 커밋을 만들지 않는다/,
    /다시 위임하지 않는다/,
    /사용자에게 직접 보고하거나 질문하지 않고/,
    /대신할 실행기를 만들지 않으며/,
  ]) {
    assert.match(rule, point);
  }
});

test("the reference and the pm and worker skills state the worktree order", () => {
  const rule = read("references/subagents.md");
  assert.match(rule, /## 워크트리 순서/);
  assert.match(rule, /`role-worktree-create --worktree <id>`/);
  assert.match(rule, /수정과 재시도는 원래 작업한 워크트리에서 한다/);
  assert.match(rule, /재사용이 불가능하고 독립 실행이 필요할 때에만/);
  assert.match(rule, /다시 구현하지 않으며/);

  const pm = read("skills/pm/SKILL.md");
  assert.match(pm, /기존 워크트리를 안전하게 재사용할 수 있는지를 먼저 확인/);
  assert.match(pm, /수정과 재시도는 원래 워크트리에서 하며/);
  assert.match(pm, /재사용이 불가능하고 독립 실행이 필요할 때에만 새 워크트리/);
  assert.match(pm, /Orca의 기능을 쓰며 다시 구현하지 않습니다/);

  const workerSkill = read("skills/worker/SKILL.md");
  assert.match(workerSkill, /수정과 재시도에 그대로 쓰고/);
  assert.match(workerSkill, /「워크트리 순서」/);
});

test("pm, worker and the legacy role skills link to the rule", () => {
  for (const name of ["pm", "worker", "pl", "senior", "junior"]) {
    assert.match(
      read("skills", name, "SKILL.md"),
      /\(\.\.\/\.\.\/references\/subagents\.md\)/,
      `${name} must link the subagent rule`,
    );
  }
  // Runtime-enforced values are not restated in the reference.
  assert.doesNotMatch(
    read("references/subagents.md"),
    /gpt-oss-120b|maxCalls|MAX_PROMPT_BYTES|concurrency|timeoutMs/,
  );
});
