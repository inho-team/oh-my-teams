/** Handoff checkpoints: section validation, storage, CLI, and the brief rule. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readJSON,
  run,
  writeJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import { createWorkflow } from "../plugins/oh-my-teams/scripts/workflow.mjs";
import {
  HANDOFF_SECTIONS,
  recordCheckpoint,
  validateCheckpoint,
} from "../plugins/oh-my-teams/scripts/handoff.mjs";
import { roleSpec } from "../plugins/oh-my-teams/scripts/role-launch.mjs";

const cli = path.resolve("plugins/oh-my-teams/scripts/teams-org.mjs");
const org = () =>
  readJSON(
    new URL(
      "../plugins/oh-my-teams/examples/organization.json",
      import.meta.url,
    ),
  );

const checkpoint = (sections = HANDOFF_SECTIONS) =>
  sections.map((name) => `## ${name}\n${name} 내용\n`).join("\n");

const task = (id) => ({
  schemaVersion: 2,
  revision: 1,
  kind: "edit",
  id,
  goal: "Test handoff",
  instruction: "Make the change",
  nonGoals: [],
  constraints: [],
  files: [`${id}.txt`],
  checks: [[process.execPath, "-e", "process.exit(0)"]],
  acceptance: [
    { id: "check", description: "check", method: "check", checkIndexes: [0] },
  ],
  dependencies: [],
  contractRefs: [],
  contextRefs: [],
  openQuestions: [],
  reviewRequirements: [],
  environment: "test",
  baseRef: "HEAD",
  risk: "low",
});

async function workflow(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const args of [
    ["init"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"],
  ]) {
    assert.equal((await run(["git", ...args], { cwd: dir })).code, 0);
  }
  fs.writeFileSync(path.join(dir, ".gitignore"), ".omt/\n");
  fs.writeFileSync(path.join(dir, "a.txt"), "unchanged");
  writeJSON(path.join(dir, "a.json"), task("a"));
  await run(["git", "add", "."], { cwd: dir });
  assert.equal(
    (await run(["git", "commit", "-m", "seed"], { cwd: dir })).code,
    0,
  );
  const request = {
    schemaVersion: 1,
    id: "handoff-run",
    goal: "Keep a checkpoint",
    repo: ".",
    tasks: [{ file: "a.json", role: "pl" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 2, maxCalls: 2 },
  };
  const stateDir = path.join(dir, ".omt");
  await createWorkflow(stateDir, request, org(), dir);
  return { dir, stateDir, id: request.id };
}

test("a checkpoint needs every section once and non-empty", () => {
  assert.deepEqual(
    Object.keys(validateCheckpoint(checkpoint())),
    HANDOFF_SECTIONS,
  );
  assert.throws(
    () => validateCheckpoint(checkpoint(HANDOFF_SECTIONS.slice(1))),
    /Missing checkpoint section: 목표/,
  );
  assert.throws(
    () => validateCheckpoint(`${checkpoint()}\n## 목표\n다시\n`),
    /Duplicate checkpoint section: 목표/,
  );
  assert.throws(
    () => validateCheckpoint(checkpoint().replace("남은 일 내용", " ")),
    /Empty checkpoint section: 남은 일/,
  );
  assert.throws(
    () => validateCheckpoint(`${checkpoint()}\n## 잡담\n내용\n`),
    /Unknown checkpoint section: 잡담/,
  );
});

test("recordCheckpoint stores the document with HEAD and a rising sequence", async (t) => {
  const { dir, stateDir, id } = await workflow(t);
  const head = (
    await run(["git", "rev-parse", "HEAD"], { cwd: dir })
  ).stdout.trim();
  const first = recordCheckpoint(stateDir, id, "a", {
    text: checkpoint(),
    repo: dir,
  });
  assert.equal(first.head, head);
  assert.equal(first.role, "pl");
  assert.equal(first.sequence, 1);
  assert.equal(fs.readFileSync(first.checkpoint, "utf8"), checkpoint());
  assert.equal(
    first.checkpoint,
    path.join(
      stateDir,
      "workflows",
      id,
      "tasks",
      "a",
      "handoff",
      "checkpoint.md",
    ),
  );
  const second = recordCheckpoint(stateDir, id, "a", {
    text: checkpoint(),
    repo: dir,
  });
  assert.equal(second.sequence, 2);
  assert.equal(readJSON(second.meta).sequence, 2);
  assert.throws(
    () =>
      recordCheckpoint(stateDir, id, "missing", {
        text: checkpoint(),
        repo: dir,
      }),
    /Unknown workflow task: missing/,
  );
});

test("an invalid checkpoint leaves the previous one in place", async (t) => {
  const { dir, stateDir, id } = await workflow(t);
  const kept = recordCheckpoint(stateDir, id, "a", {
    text: checkpoint(),
    repo: dir,
  });
  assert.throws(() =>
    recordCheckpoint(stateDir, id, "a", { text: "## 목표\n일부\n", repo: dir }),
  );
  assert.equal(fs.readFileSync(kept.checkpoint, "utf8"), checkpoint());
  assert.equal(readJSON(kept.meta).sequence, 1);
});

test("handoff-checkpoint records through the CLI from the worker's worktree", async (t) => {
  const { dir, stateDir, id } = await workflow(t);
  const file = path.join(stateDir, "draft-checkpoint.md");
  fs.writeFileSync(file, checkpoint());
  const result = await run(
    [
      process.execPath,
      cli,
      "handoff-checkpoint",
      "--state",
      stateDir,
      "--workflow-id",
      id,
      "--workflow-task",
      "a",
      "--file",
      file,
    ],
    { cwd: dir },
  );
  assert.equal(result.code, 0, result.stderr);
  const record = JSON.parse(result.stdout);
  assert.equal(record.taskId, "a");
  assert.equal(record.repo, fs.realpathSync(dir));
  assert.equal(record.sequence, 1);
});

test("the brief carries the checkpoint rule only for a workflow task", async (t) => {
  const { stateDir, id } = await workflow(t);
  const plain = roleSpec(org(), "pl", "일을 한다", {
    workflowId: id,
    stateDir,
  });
  assert.doesNotMatch(plain, /handoff checkpoint/);
  const brief = roleSpec(org(), "pl", "일을 한다", {
    workflowId: id,
    stateDir,
    workflowTask: "a",
  });
  assert.match(brief, /handoff checkpoint: 커밋할 때마다/);
  assert.match(
    brief,
    new RegExp(
      `handoff-checkpoint --state ${stateDir} --workflow-id ${id} --workflow-task a`,
    ),
  );
  for (const name of HANDOFF_SECTIONS)
    assert.match(brief, new RegExp(`## ${name}`));
});
