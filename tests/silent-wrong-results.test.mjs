/** Covers defects that produced a wrong answer instead of an error. */
import { after } from "node:test";
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
import { validateTask } from "../plugins/oh-my-teams/scripts/contracts.mjs";
import { classifyProviderFailure } from "../plugins/oh-my-teams/scripts/providers.mjs";
import { work } from "../plugins/oh-my-teams/scripts/worker.mjs";
import { verify } from "../plugins/oh-my-teams/scripts/evidence.mjs";
import { getTemplateRepo, cleanupTemplates } from "./template-factory.mjs";
after(() => cleanupTemplates());
import {
  attachExecution,
  createWorkflow,
  readWorkflow,
  recordSettlement,
  retryTask,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";

const organization = readJSON(
  new URL("../plugins/oh-my-teams/examples/organization.json", import.meta.url),
);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-silent-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function repo(t) {
  const dir = fixture(t);
  fs.cpSync(await getTemplateRepo(), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".omt/\n");
  fs.writeFileSync(path.join(dir, "value.txt"), "wrong\n");
  assert.equal(
    (await run(["git", "add", ".gitignore", "value.txt"], { cwd: dir })).code,
    0,
  );
  assert.equal(
    (await run(["git", "commit", "-m", "seed"], { cwd: dir })).code,
    0,
  );
  return dir;
}

const task = (id = "silent", files = [`${id}.txt`]) => ({
  schemaVersion: 2,
  revision: 1,
  kind: "edit",
  id,
  goal: "Silent wrong results",
  instruction: "Make the change",
  nonGoals: [],
  constraints: [],
  files,
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

test("a task cannot spell one file two ways and own it twice", () => {
  assert.equal(validateTask(task("ok", ["src/a.js"])).id, "ok");
  assert.equal(validateTask(task("ok", ["a.js", "src/b.js"])).id, "ok");

  // Every spelling below names src/a.js. Ownership is decided by comparing
  // these strings, so accepting more than one form let two tasks edit the same
  // file in parallel and collide at integration.
  for (const spelling of [
    "./src/a.js",
    "src\\a.js",
    "src/./a.js",
    "src/../src/a.js",
    "src//a.js",
    "../outside.js",
  ]) {
    assert.throws(
      () => validateTask(task("ok", [spelling])),
      /normalized POSIX relative path|relative path/,
      spelling,
    );
  }
  assert.throws(
    () => validateTask(task("ok", ["/abs/a.js"])),
    /must be a relative path/,
  );

  const withRef = {
    ...task("ok", ["src/a.js"]),
    contractRefs: [{ path: "./docs/api.md", sha256: "a".repeat(64) }],
  };
  assert.throws(
    () => validateTask(withRef),
    /contractRefs path must be a normalized POSIX relative path/,
  );
});

test("a model answer about rate limits is not read as exhausted capacity", () => {
  const answer = JSON.stringify({
    summary: "Explains the 429 rate limit and quota exhausted handling",
  });

  // The model's own words arrive on stdout. Treating them as transport signals
  // classified a plain model error as capacity loss, and the caller then
  // abandoned every remaining fallback profile.
  assert.equal(
    classifyProviderFailure(
      { code: 1, stdout: answer, stderr: "" },
      { providerError: false },
    ),
    "model-error",
  );
  assert.equal(
    classifyProviderFailure(
      { code: 1, stdout: "", stderr: "RESOURCE_EXHAUSTED for this account" },
      { providerError: false },
    ),
    "quota-unknown",
  );
  assert.equal(
    classifyProviderFailure(
      {
        code: 1,
        stdout: JSON.stringify({ error: { status: "429" } }),
        stderr: "",
      },
      { providerError: true },
    ),
    "quota-unknown",
  );
  assert.equal(
    classifyProviderFailure(
      { code: 1, stdout: "", stderr: "too many requests" },
      { providerError: false },
    ),
    "rate-limit",
  );
  // A structured pool scope is still the only proof of shared-pool exhaustion.
  assert.equal(
    classifyProviderFailure(
      {
        code: 1,
        stdout: JSON.stringify({
          error: { code: "pool_exhausted", scope: "pool" },
        }),
        stderr: "",
      },
      { providerError: true },
    ),
    "pool-exhausted",
  );
  assert.equal(
    classifyProviderFailure({ code: 0, stdout: "", stderr: "" }, {}),
    null,
  );
});

test("a missing environment reference fails as configuration, not as budget", async (t) => {
  const dir = await repo(t);
  const org = structuredClone(organization);
  org.profiles[org.roles.junior.profile].env = {
    AUTH_TOKEN: "OMT_ABSENT_TEST_TOKEN",
  };
  const stateDir = path.join(dir, ".omt");
  let called = false;

  // profileEnv used to throw only after claimWorkflowCall had counted the call,
  // so settlement reported a budget overrun and hid the real cause.
  await assert.rejects(
    () =>
      work(dir, org, task("silent", ["value.txt"]), {
        stateDir,
        call: async () => {
          called = true;
          return {
            code: 0,
            stdout: "{}",
            stderr: "",
            text: "{}",
            elapsedMs: 1,
          };
        },
      }),
    /Missing environment reference: OMT_ABSENT_TEST_TOKEN/,
  );
  assert.equal(called, false, "no provider call is made or charged");
  assert.equal(
    fs.existsSync(path.join(stateDir, "slots", "junior-0.lock")),
    false,
    "the slot is released again",
  );
});

test("one uncontainable tracked entry does not abort evidence collection", async (t) => {
  const dir = await repo(t);

  // PM state spelled with different case is the reachable form of this
  // hazard: the exclusion filter matched only ".omt/", so ".OMT/state.json" was
  // handed to inside(), rejected as a forbidden segment, and took verify,
  // gateCheck and validateEvidence down with it.
  fs.mkdirSync(path.join(dir, ".OMT"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".OMT", "state.json"), "{}\n");
  assert.equal(
    (await run(["git", "add", "-f", ".OMT/state.json"], { cwd: dir })).code,
    0,
  );

  const outside = fixture(t);
  fs.writeFileSync(path.join(outside, "target.txt"), "outside\n");
  try {
    fs.symlinkSync(
      path.join(outside, "target.txt"),
      path.join(dir, "link.txt"),
    );
    assert.equal((await run(["git", "add", "link.txt"], { cwd: dir })).code, 0);
  } catch {
    t.diagnostic("symlink creation not permitted; the linked case is skipped");
  }

  const options = {
    baseRef: "HEAD",
    commands: [[process.execPath, "-e", "process.exit(0)"]],
    environment: "test",
    store: path.join(dir, ".omt", "evidence"),
    timeoutMs: 60000,
  };
  const evidence = await verify(dir, options);
  assert.equal(evidence.status, "passed");
  assert.ok(evidence.fingerprint.tree);

  // PM state is never part of the source fingerprint, so rewriting it
  // must not invalidate evidence that is otherwise unchanged.
  fs.writeFileSync(path.join(dir, ".OMT", "state.json"), '{"changed":true}\n');
  assert.equal((await verify(dir, options)).cached, true);
});

test("a retired attempt id cannot be reused to overwrite a settled attempt", async (t) => {
  const dir = await repo(t);
  const stateDir = path.join(dir, ".omt");
  writeJSON(path.join(dir, "alpha.json"), task("alpha"));
  const request = {
    schemaVersion: 1,
    id: "attempt-reuse",
    goal: "Reject a retired attempt id",
    repo: ".",
    tasks: [{ file: "alpha.json", role: "junior" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 3, maxCalls: 3 },
  };
  await createWorkflow(stateDir, request, structuredClone(organization), dir);
  const revision = () => readWorkflow(stateDir, request.id).state.revision;

  const attach = (eventId, attemptId, executionId) =>
    attachExecution(stateDir, request.id, revision(), {
      schemaVersion: 1,
      eventId,
      attemptId,
      taskId: "alpha",
      callAllowance: 1,
      receipt: {
        executionId,
        runId: executionId,
        taskId: "alpha",
        dispatchId: executionId,
        worktreeId: executionId,
      },
    });

  attach("attach-one", "attempt-one", "exec-one");
  recordSettlement(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "settle-one",
    attemptId: "attempt-one",
    taskId: "alpha",
    executionId: "exec-one",
    outcome: "failed",
    callsUsed: 1,
    failure: {
      schemaVersion: 1,
      message: "check failed",
      evidence: "runs/alpha",
    },
  });
  retryTask(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "retry-one",
    taskId: "alpha",
    resolvedBy: "junior",
    resolution: "fixed the check",
    evidence: "runs/alpha-fix",
  });

  // Retry clears attemptId but keeps the attempt in history. Comparing only the
  // current id let the retired one back in, appending a second record with the
  // same id; every later lookup then found the settled one first.
  assert.throws(
    () => attach("attach-again", "attempt-one", "exec-two"),
    /Duplicate attempt or execution receipt/,
  );
  const settled = readWorkflow(stateDir, request.id).state.tasks.alpha;
  assert.equal(settled.attempts.length, 1);
  assert.equal(settled.attempts[0].status, "failed");

  attach("attach-two", "attempt-two", "exec-two");
  const next = readWorkflow(stateDir, request.id).state.tasks.alpha;
  assert.equal(next.attempts.length, 2);
  assert.deepEqual(
    next.attempts.map((entry) => entry.id),
    ["attempt-one", "attempt-two"],
  );
});
