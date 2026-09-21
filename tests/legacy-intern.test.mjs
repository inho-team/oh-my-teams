/** Intern was removed in 2.6.0: what still reads it, and what refuses it. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEPTH_ROLES,
  ROLES,
  definedRoles,
  depthRoles,
  foldRole,
  hash,
  migrateLegacyOrg,
  readJSON,
  run,
  saveOrg,
  validateOrg,
  writeJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  attachExecution,
  createWorkflow,
  readWorkflow,
  setWorkflowDepth,
  validateWorkflowRequest,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";
import { workflowStateFile } from "../plugins/oh-my-teams/scripts/workflow-store.mjs";
import { work } from "../plugins/oh-my-teams/scripts/worker.mjs";

const example = () =>
  readJSON(
    new URL(
      "../plugins/oh-my-teams/examples/organization.json",
      import.meta.url,
    ),
  );

// The shape an organization saved before 2.6.0 had: Intern under Junior, with
// its own assistant allowlist.
function withIntern(org = example()) {
  org.roles.intern = {
    parent: "junior",
    profile: "agy-sonnet",
    concurrency: 1,
    attempts: 1,
    fallbacks: [],
  };
  if (org.assistants) org.assistants.intern = ["agy-oss"];
  return org;
}

const task = (id) => ({
  schemaVersion: 2,
  revision: 1,
  kind: "edit",
  id,
  goal: "Read a legacy workflow",
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

async function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-legacy-intern-"));
  // Exact test-owned directory, created above; no user paths are removed.
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
  return dir;
}

test("an organization file that declares intern is refused with the way to migrate", () => {
  assert.throws(
    () => validateOrg(withIntern()),
    /Role intern was removed in 2\.6\.0; move its profile to junior and delete intern with the adjust skill/,
  );
  // Even a team that dropped Junior cannot keep Intern in its place.
  const noJunior = withIntern();
  delete noJunior.roles.junior;
  noJunior.roles.intern.parent = "senior";
  assert.throws(() => validateOrg(noJunior), /Role intern was removed/);
});

test("work addressed to intern resolves as Junior's", () => {
  assert.deepEqual(ROLES, ["pm", "pl", "senior", "junior"]);
  assert.equal(foldRole(["pm", "junior"], "intern"), "junior");
  // A saved role list that still names intern counts as declaring Junior.
  assert.equal(foldRole(["pm", "intern"], "junior"), "junior");
  // Without Junior, Intern's work folds upward like Junior's would.
  assert.equal(foldRole(["pm", "senior"], "intern"), "senior");
  assert.throws(() => foldRole(["pm"], "cto"), /Unknown role: cto/);
});

test("a saved depth 5 reads as the full ladder; a new depth 5 is refused", () => {
  assert.deepEqual(depthRoles(ROLES, 5), depthRoles(ROLES, 4));
  assert.deepEqual(depthRoles(ROLES, 5), [...DEPTH_ROLES[4]]);
  assert.throws(() => depthRoles(ROLES, 6), /Depth must be 1\.\.4/);
  assert.throws(() => depthRoles(ROLES, 0), /Depth must be 1\.\.4/);

  const request = {
    schemaVersion: 1,
    id: "new-run",
    goal: "Start a run",
    repo: ".",
    tasks: [{ file: "a.json", role: "junior" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 1, maxCalls: 1 },
  };
  assert.equal(validateWorkflowRequest(request).id, "new-run");
  assert.throws(
    () => validateWorkflowRequest({ ...request, depth: 5 }),
    /Workflow depth must be 1\.\.4 when given/,
  );
  assert.throws(
    () =>
      validateWorkflowRequest({
        ...request,
        tasks: [{ file: "a.json", role: "intern" }],
      }),
    /a role from pm\/pl\/senior\/junior/,
  );
});

test("a snapshot that binds intern beside junior drops the intern binding", () => {
  const legacy = withIntern();
  legacy.advisors = { intern: ["agy-opus"] };
  const migrated = migrateLegacyOrg(legacy);
  assert.notEqual(migrated, legacy);
  assert.deepEqual(Object.keys(migrated.roles), [
    "pm",
    "pl",
    "senior",
    "junior",
  ]);
  // Junior keeps its own profile and allowlist; Intern's are not merged in.
  assert.equal(migrated.roles.junior.profile, "agy-opus");
  assert.deepEqual(migrated.assistants.junior, ["agy-oss"]);
  assert.equal(migrated.assistants.intern, undefined);
  // An allowlist only Intern had moves to Junior.
  assert.deepEqual(migrated.advisors, { junior: ["agy-opus"] });
  assert.equal(validateOrg(migrated), migrated);
  // The input snapshot is left as it was frozen.
  assert.ok(Object.hasOwn(legacy.roles, "intern"));
  assert.deepEqual(legacy.advisors, { intern: ["agy-opus"] });
});

test("a snapshot that binds intern without junior renames it to junior", () => {
  const legacy = withIntern();
  delete legacy.roles.junior;
  delete legacy.assistants.junior;
  legacy.roles.intern.profile = "agy-oss";
  // A parent that named intern follows the rename: PM → Intern → PL here.
  legacy.roles.intern.parent = "pm";
  legacy.roles.pl.parent = "intern";
  legacy.roles.senior.parent = "pm";
  const migrated = migrateLegacyOrg(legacy);
  assert.equal(migrated.roles.intern, undefined);
  assert.deepEqual(migrated.roles.junior, {
    parent: "pm",
    profile: "agy-oss",
    concurrency: 1,
    attempts: 1,
    fallbacks: [],
  });
  assert.equal(migrated.roles.pl.parent, "junior");
  assert.deepEqual(migrated.assistants.junior, ["agy-oss"]);
  assert.equal(migrated.assistants.intern, undefined);
  assert.equal(validateOrg(migrated), migrated);
});

test("a snapshot with nothing to migrate is returned as the same object", () => {
  const org = example();
  assert.equal(migrateLegacyOrg(org), org);
  assert.equal(migrateLegacyOrg(undefined), undefined);
});

// Rewrites a workflow snapshot into what 2.5.0 froze: an organization with
// Intern, the full ladder at depth 5, and the given tasks addressed to Intern.
function freezeAsLegacy(stateDir, id, internTasks) {
  const legacy = withIntern();
  const { dir: workflowDir } = readWorkflow(stateDir, id);
  writeJSON(path.join(workflowDir, "organization.json"), legacy);
  const stateFile = workflowStateFile(stateDir, id);
  const saved = readJSON(stateFile);
  saved.organizationHash = hash(legacy);
  saved.depth = 5;
  saved.roles = ["pm", "pl", "senior", "junior", "intern"];
  for (const taskId of internTasks) saved.tasks[taskId].role = "intern";
  writeJSON(stateFile, saved);
  return { legacy, workflowDir };
}

const receipt = (taskId) => ({
  executionId: `exec-${taskId}`,
  runId: `run-${taskId}`,
  taskId: `orca-${taskId}`,
  dispatchId: `dispatch-${taskId}`,
  worktreeId: `wt-${taskId}`,
});

test("a workflow frozen with intern and depth 5 is still read on the current ladder", async (t) => {
  const dir = await repo(t);
  const stateDir = path.join(dir, ".omt");
  const request = {
    schemaVersion: 1,
    id: "legacy-run",
    goal: "A run started before 2.6.0",
    repo: ".",
    tasks: [{ file: "a.json", role: "junior" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 2, maxCalls: 2 },
  };
  await createWorkflow(stateDir, request, example(), dir);
  const { legacy, workflowDir } = freezeAsLegacy(stateDir, request.id, ["a"]);

  const snapshot = readWorkflow(stateDir, request.id);
  assert.equal(snapshot.organization.roles.intern, undefined);
  assert.equal(validateOrg(snapshot.organization), snapshot.organization);
  assert.equal(snapshot.state.depth, 5);
  assert.equal(snapshot.state.organizationHash, hash(legacy));
  assert.deepEqual(
    depthRoles(definedRoles(snapshot.organization), snapshot.state.depth),
    [...DEPTH_ROLES[4]],
  );
  // The frozen file itself is never rewritten by reading it.
  assert.ok(
    Object.hasOwn(
      readJSON(path.join(workflowDir, "organization.json")).roles,
      "intern",
    ),
  );

  // Work bound to that run still claims its call: the task addressed to intern
  // runs as Junior on the migrated ladder, and the report carries the hash the
  // workflow froze, not the hash of the migrated copy.
  attachExecution(stateDir, request.id, snapshot.state.revision, {
    schemaVersion: 1,
    eventId: "attach-a",
    attemptId: "attempt-a",
    taskId: "a",
    callAllowance: 1,
    receipt: receipt("a"),
  });
  const frozen = readWorkflow(stateDir, request.id);
  const report = await work(
    dir,
    readJSON(path.join(workflowDir, "organization.json")),
    frozen.tasks.a,
    {
      role: "intern",
      stateDir,
      workflowId: request.id,
      attemptId: "attempt-a",
      call: async () => ({
        code: 0,
        stdout: "{}",
        stderr: "",
        text: '{"edits":[]}',
        elapsedMs: 1,
      }),
    },
  );
  assert.equal(report.role, "junior");
  assert.equal(report.organizationHash, hash(legacy));
  assert.equal(report.calls.length, 1);

  // The PM can still lower the depth of that run while the intern-addressed
  // task runs: its work is Junior's, and Junior stays at depth 3.
  const { state: lowered } = setWorkflowDepth(
    stateDir,
    request.id,
    readWorkflow(stateDir, request.id).state.revision,
    {
      schemaVersion: 1,
      eventId: "legacy-lower",
      depth: 3,
      reason: "no parallel waves remain",
      evidence: "plan.md#scope",
    },
  );
  assert.equal(lowered.depth, 3);
  assert.deepEqual(lowered.roles, [...DEPTH_ROLES[3]]);
  assert.deepEqual(lowered.depthHistory.at(-1).from, 5);
});

test("an intern-addressed task and a junior task of one legacy run share Junior's slots", async (t) => {
  const dir = await repo(t);
  writeJSON(path.join(dir, "b.json"), task("b"));
  const stateDir = path.join(dir, ".omt");
  const request = {
    schemaVersion: 1,
    id: "legacy-slots",
    goal: "Two implementation tasks started before 2.6.0",
    repo: ".",
    tasks: [
      { file: "a.json", role: "junior" },
      { file: "b.json", role: "junior" },
    ],
    policy: { maxRunning: 2, maxReviewPending: 2 },
    budget: { maxAttempts: 4, maxCalls: 4 },
  };
  await createWorkflow(stateDir, request, example(), dir);
  freezeAsLegacy(stateDir, request.id, ["a"]);
  const attach = (taskId) =>
    attachExecution(
      stateDir,
      request.id,
      readWorkflow(stateDir, request.id).state.revision,
      {
        schemaVersion: 1,
        eventId: `attach-${taskId}`,
        attemptId: `attempt-${taskId}`,
        taskId,
        callAllowance: 1,
        receipt: receipt(taskId),
      },
    );
  attach("a");
  // Junior has one slot. Counting intern apart from junior would start a
  // second Junior worker that the runtime's slot lease then refuses.
  assert.throws(() => attach("b"), /No junior concurrency slot available/);
});

test("an organization file that still declares intern can be repaired with edit", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-legacy-edit-"));
  // Exact test-owned directory, verified at creation; no user paths are removed.
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "organization.json");
  const legacy = example();
  legacy.roles.intern = {
    parent: "junior",
    profile: legacy.roles.junior.profile,
    concurrency: 1,
    attempts: 1,
    fallbacks: [],
  };
  fs.writeFileSync(file, JSON.stringify(legacy));
  assert.throws(() => saveOrg(file, legacy), /intern was removed in 2\.6\.0/);
  const repaired = structuredClone(legacy);
  delete repaired.roles.intern;
  const saved = saveOrg(file, repaired, {
    update: true,
    expectedRevision: legacy.revision,
  });
  assert.equal(saved.organization.revision, legacy.revision + 1);
  assert.ok(!Object.hasOwn(saved.organization.roles, "intern"));
  const archived = JSON.parse(
    fs.readFileSync(
      path.join(dir, "history", `org-${legacy.revision}.json`),
      "utf8",
    ),
  );
  assert.ok(Object.hasOwn(archived.roles, "intern"), "original is archived");
});
