/** Regression tests for path containment, settled state, and failure routing. */
import { after } from "node:test";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  inside,
  readJSON,
  run,
  writeJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import { validateQuotaSnapshot } from "../plugins/oh-my-teams/scripts/quota.mjs";
import {
  ingestIncident,
  observeIncident,
} from "../plugins/oh-my-teams/scripts/incidents.mjs";
import { classifyFailure } from "../plugins/oh-my-teams/scripts/failures.mjs";
import {
  createWorkflow,
  attachExecution,
  recordSettlement,
  readWorkflow,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";
import { getTemplateRepo, cleanupTemplates } from "./template-factory.mjs";
after(() => cleanupTemplates());
import {
  longExecutableLines,
  templateLineStarts,
} from "../scripts/check-code-quality.mjs";

const organization = readJSON(
  new URL("../plugins/oh-my-teams/examples/organization.json", import.meta.url),
);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-boundary-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function repo(t) {
  const dir = fixture(t);
  fs.cpSync(await getTemplateRepo(), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".omt/\n");
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  assert.equal(
    (await run(["git", "add", ".gitignore", "seed.txt"], { cwd: dir })).code,
    0,
  );
  assert.equal(
    (await run(["git", "commit", "-m", "seed"], { cwd: dir })).code,
    0,
  );
  return dir;
}

const task = (id) => ({
  schemaVersion: 2,
  revision: 1,
  kind: "edit",
  id,
  goal: "Boundary regression",
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

test("a case-insensitive or trailing-dot spelling cannot reach protected state", (t) => {
  const root = fixture(t);
  for (const relative of [
    ".git/config",
    ".GIT/config",
    ".Git/config",
    ".git./config",
    ".GIT.  /config",
    ".omt/state.json",
    ".OMT/state.json",
    ".orca/worktree",
    ".ORCA/worktree",
    "..",
    "A/..",
    "nested/.Git/HEAD",
  ]) {
    assert.throws(
      () => inside(root, relative),
      /Forbidden path/,
      `must reject ${relative}`,
    );
  }
  // inside() answers with the real path. The temporary directory is reached
  // through a link on macOS (/var -> /private/var) and may be a short 8.3 name
  // on Windows, so the expectation is resolved the same way.
  const real = fs.realpathSync(root);
  for (const relative of [".gitignore", ".gitkeep", "src/ok.txt", "omt.txt"]) {
    assert.equal(inside(root, relative), path.resolve(real, relative));
  }
});

test("a quota snapshot cannot name a pool that escapes the state directory", () => {
  const snapshot = {
    schemaVersion: 1,
    poolId: "shared-pool",
    accountProfile: "primary",
    source: "manual",
    observedAt: "2026-09-14T00:00:00Z",
    windows: [{ kind: "five-hour", remainingPercent: 50, resetAt: null }],
    otherActivity: "none",
  };
  assert.equal(validateQuotaSnapshot(snapshot).poolId, "shared-pool");
  for (const poolId of ["../../evil", "a/b", "Shared", "-lead", "", "  "]) {
    assert.throws(
      () => validateQuotaSnapshot({ ...snapshot, poolId }),
      /pool id|poolId required/,
      `must reject ${JSON.stringify(poolId)}`,
    );
  }
});

test("a settled incident is not revived by a single progress observation", (t) => {
  const stateDir = path.join(fixture(t), ".omt");
  const now = Date.parse("2026-09-14T00:00:00Z");
  const config = {
    schemaVersion: 1,
    enabled: true,
    maxOpen: 2,
    maxProposalsPerWindow: 2,
    windowMs: 3600000,
    observationMs: 60000,
    noProgressLimit: 2,
  };
  const incident = ingestIncident(
    stateDir,
    {
      schemaVersion: 1,
      source: "alert",
      externalId: "alert-1",
      dedupeKey: "service:stuck",
      summary: "Stuck loop",
      evidence: "alerts/1",
      observedAt: "2026-09-14T00:00:00Z",
    },
    config,
    now,
  ).incident;

  const observe = (eventId, outcome, observedAt) =>
    observeIncident(
      stateDir,
      {
        incidentId: incident.id,
        eventId,
        outcome,
        evidence: `checks/${eventId}`,
        observedAt,
      },
      config,
    ).incident;

  assert.equal(
    observe("a", "no-progress", "2026-09-14T00:01:10Z").status,
    "observing",
  );
  const stopped = observe("b", "no-progress", "2026-09-14T00:02:10Z");
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.holdReason, "no-progress-limit");

  // The defect: one "progress" observation cleared the counter and returned the
  // incident to "observing", disarming the limit that had just stopped it.
  const afterProgress = observe("c", "progress", "2026-09-14T00:03:10Z");
  assert.equal(afterProgress.status, "stopped");
  assert.equal(afterProgress.noProgressCount, 2);
  assert.equal(
    observe("d", "resolved", "2026-09-14T00:04:10Z").status,
    "stopped",
  );

  const reopened = observe("e", "regressed", "2026-09-14T00:05:10Z");
  assert.equal(reopened.status, "proposed");
  assert.equal(reopened.noProgressCount, 0);
  assert.equal(reopened.holdReason, null);
});

test("a settled task never lets another task report the workflow as ready", async (t) => {
  const dir = await repo(t);
  const stateDir = path.join(dir, ".omt");
  for (const id of ["alpha", "beta"]) {
    writeJSON(path.join(dir, `${id}.json`), task(id));
  }
  const request = {
    schemaVersion: 1,
    id: "boundary-status",
    goal: "Derived status",
    repo: ".",
    tasks: [
      { file: "alpha.json", role: "junior" },
      { file: "beta.json", role: "junior" },
    ],
    policy: { maxRunning: 2, maxReviewPending: 2 },
    budget: { maxAttempts: 4, maxCalls: 4 },
  };
  await createWorkflow(stateDir, request, structuredClone(organization), dir);

  const settle = (id, outcome) => {
    attachExecution(
      stateDir,
      request.id,
      readWorkflow(stateDir, request.id).state.revision,
      {
        schemaVersion: 1,
        eventId: `attach-${id}`,
        attemptId: `attempt-${id}`,
        taskId: id,
        callAllowance: 1,
        receipt: {
          executionId: id,
          runId: id,
          taskId: id,
          dispatchId: id,
          worktreeId: id,
        },
      },
    );
    return recordSettlement(
      stateDir,
      request.id,
      readWorkflow(stateDir, request.id).state.revision,
      {
        schemaVersion: 1,
        eventId: `settle-${id}`,
        attemptId: `attempt-${id}`,
        taskId: id,
        executionId: id,
        outcome,
        callsUsed: 0,
        ...(outcome === "failed"
          ? {
              failure: {
                schemaVersion: 1,
                message: "check failed",
                evidence: "runs/alpha",
              },
            }
          : {}),
      },
    ).state;
  };

  assert.equal(settle("alpha", "failed").status, "blocked");
  // The defect: settling beta successfully overwrote the workflow status with a
  // local "ready", hiding that alpha had already failed.
  assert.equal(settle("beta", "settled").status, "blocked");
  assert.equal(
    readWorkflow(stateDir, request.id).state.tasks.alpha.state,
    "failed",
  );
});

test("a model that answered from another model is a profile fault, not a workspace fault", () => {
  const mismatch = {
    category: "model-binding-mismatch",
    nextOwner: "pm",
    action: "rebind-profile-model",
    retryable: false,
  };
  for (const input of [
    { kind: "model-binding" },
    { modelProof: "mismatched" },
    {
      message:
        "Provider answered from gemini-flash-3-8 while gpt-oss-120b-medium was requested",
    },
    { message: "routing evidence is invalid" },
  ]) {
    assert.deepEqual(classifyFailure(input), mismatch);
  }

  const workspace = {
    category: "environment-context",
    nextOwner: "pl",
    action: "rebind-workspace",
    retryable: true,
  };
  for (const input of [
    { kind: "workspace-context" },
    { grounded: false },
    { message: "cited 2 of 3 lines that do not exist in this workspace" },
  ]) {
    assert.deepEqual(classifyFailure(input), workspace);
  }
});

test("quality auditing is not disabled by a backtick inside a regular expression", () => {
  const lines = [
    "/** Module. */",
    "const marker = /(?<!\\\\)`/g;",
    "// a comment holding a ` backtick",
    'const quoted = "a ` backtick";',
    `const long = ${"x".repeat(200)};`,
    "export function afterAll() {",
    "  return 1;",
    "}",
  ];
  const starts = templateLineStarts(lines);
  assert.ok(
    starts.every((value) => value === false),
    "no line begins inside template text",
  );
  assert.deepEqual(
    longExecutableLines(lines).map((entry) => entry.line),
    [5],
  );

  const template = [
    "const fixture = `",
    `  ${"y".repeat(200)}`,
    "  export function inTemplate() {}",
    "`;",
    `const executable = ${"z".repeat(200)};`,
  ];
  const templateStarts = templateLineStarts(template);
  assert.deepEqual(templateStarts, [false, true, true, true, false]);
  assert.deepEqual(
    longExecutableLines(template).map((entry) => entry.line),
    [5],
  );
});
