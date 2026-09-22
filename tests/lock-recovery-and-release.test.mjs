/** Covers reclaiming abandoned leases and giving back an unlaunched reservation. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ownerHasExited,
  readJSON,
  run,
  withAsyncFileLock,
  withFileLock,
  writeJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import { work } from "../plugins/oh-my-teams/scripts/worker.mjs";
import {
  createWorkflow,
  readWorkflow,
  releaseReservation,
  reserveExecution,
  resumeWorkflow,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";

const organization = readJSON(
  new URL("../plugins/oh-my-teams/examples/organization.json", import.meta.url),
);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-lease-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let templateRepoDir = null;
async function getTemplateRepo() {
  if (templateRepoDir) return templateRepoDir;
  const dir = fs.realpathSync(
    fs.mkdtempSync(
      require("node:path").join(
        require("node:os").tmpdir(),
        "omt-repo-template-",
      ),
    ),
  );
  for (const args of [
    ["init"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"],
  ]) {
    const result = await require("../plugins/oh-my-teams/scripts/core.mjs").run(
      ["git", ...args],
      { cwd: dir },
    );
    if (result.code !== 0) throw new Error("Git failed: " + result.stderr);
  }
  templateRepoDir = dir;
  return templateRepoDir;
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

const task = {
  schemaVersion: 2,
  revision: 1,
  kind: "edit",
  id: "lease",
  goal: "Lease handling",
  instruction: "Set the value",
  nonGoals: [],
  constraints: [],
  files: ["value.txt"],
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
};

// A pid that is certain not to name a live process on this host.
function exitedPid() {
  for (let candidate = 60000; candidate < 65000; candidate += 1) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if (error.code === "ESRCH") return candidate;
    }
  }
  throw new Error("no exited pid available");
}

test("an owner record is only trusted when it names a dead local process", (t) => {
  const dir = fixture(t);
  const file = path.join(dir, "owner.lock");
  const write = (value) => fs.writeFileSync(file, value);

  write("not json");
  assert.equal(ownerHasExited(file), false, "unparseable owners stay locked");
  write(JSON.stringify({ pid: exitedPid(), hostname: "another-host" }));
  assert.equal(ownerHasExited(file), false, "foreign hosts stay locked");
  write(JSON.stringify({ hostname: os.hostname() }));
  assert.equal(ownerHasExited(file), false, "a missing pid stays locked");
  write(JSON.stringify({ pid: 0, hostname: os.hostname() }));
  assert.equal(ownerHasExited(file), false, "pid 0 stays locked");
  write(JSON.stringify({ pid: process.pid, hostname: os.hostname() }));
  assert.equal(ownerHasExited(file), false, "live owners stay locked");
  write(JSON.stringify({ pid: exitedPid(), hostname: os.hostname() }));
  assert.equal(ownerHasExited(file), true);
});

test("a recovery marker left by a killed process does not strand the lock", async (t) => {
  const dir = fixture(t);
  const lockFile = path.join(dir, "state.lock");
  const recoveryFile = `${lockFile}.recovery`;
  const dead = JSON.stringify({ pid: exitedPid(), hostname: os.hostname() });

  // The state a process killed between creating the marker and finishing
  // recovery leaves behind. Every later attempt used to fail here forever,
  // because the marker carried no owner to judge.
  fs.writeFileSync(lockFile, dead);
  fs.writeFileSync(recoveryFile, dead);
  assert.equal(
    withFileLock(lockFile, () => "recovered"),
    "recovered",
  );
  assert.equal(fs.existsSync(lockFile), false);
  assert.equal(fs.existsSync(recoveryFile), false);

  // The asynchronous form holds the same lock and reclaims it the same way.
  fs.writeFileSync(lockFile, dead);
  fs.writeFileSync(recoveryFile, dead);
  assert.equal(
    await withAsyncFileLock(lockFile, async () => "recovered"),
    "recovered",
  );
  assert.equal(fs.existsSync(lockFile), false);

  // An empty marker names no owner, so it is still refused rather than guessed.
  fs.writeFileSync(lockFile, dead);
  fs.writeFileSync(recoveryFile, "");
  assert.throws(
    () => withFileLock(lockFile, () => "recovered"),
    /Update in progress/,
  );

  fs.rmSync(recoveryFile);
  fs.writeFileSync(
    lockFile,
    JSON.stringify({ pid: process.pid, hostname: os.hostname() }),
  );
  assert.throws(
    () => withFileLock(lockFile, () => "recovered"),
    /Update in progress/,
  );
  await assert.rejects(
    () => withAsyncFileLock(lockFile, async () => "recovered"),
    /Update in progress/,
  );
});

test("releasing a lock never replaces the error the caller raised", (t) => {
  const lockFile = path.join(fixture(t), "state.lock");
  assert.throws(
    () =>
      withFileLock(lockFile, () => {
        // A callback that removes the lock itself used to make the finally
        // block throw ENOENT over the real failure.
        fs.rmSync(lockFile);
        throw new Error("the real failure");
      }),
    /the real failure/,
  );
});

test("a slot held by an exited worker is reclaimed and the reclaim is recorded", async (t) => {
  const dir = await repo(t);
  const org = structuredClone(organization);
  org.roles.junior.concurrency = 1;
  const stateDir = path.join(dir, ".omt");
  const lockFile = path.join(stateDir, "slots", "junior-0.lock");
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  const edit = async () => ({
    code: 0,
    stdout: "{}",
    stderr: "",
    text: JSON.stringify({
      edits: [{ file: "value.txt", beforeHash: null, content: "right\n" }],
    }),
    elapsedMs: 1,
    usage: null,
  });

  // An unparseable lease is left alone: the operator is told not to delete it.
  fs.writeFileSync(lockFile, "owned");
  await assert.rejects(
    () => work(dir, org, task, { stateDir, call: edit }),
    /occupied/,
  );

  // A live owner is left alone too.
  fs.writeFileSync(
    lockFile,
    JSON.stringify({ pid: process.pid, hostname: os.hostname() }),
  );
  await assert.rejects(
    () => work(dir, org, task, { stateDir, call: edit }),
    /occupied/,
  );

  fs.writeFileSync(
    lockFile,
    JSON.stringify({
      pid: exitedPid(),
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
    }),
  );
  const report = await work(dir, org, task, { stateDir, call: edit });
  assert.deepEqual(report.slot, { id: "junior-0", reclaimed: true });
  assert.ok(report.issues.some((issue) => /Reclaimed junior-0/.test(issue)));
  assert.equal(fs.existsSync(lockFile), false, "the lease is released again");
});

test("an unlaunched reservation returns its slot and calls but not its attempt", async (t) => {
  const dir = await repo(t);
  const stateDir = path.join(dir, ".omt");
  writeJSON(path.join(dir, "lease.json"), task);
  const request = {
    schemaVersion: 1,
    id: "release-reservation",
    goal: "Release an unlaunched reservation",
    repo: ".",
    tasks: [{ file: "lease.json", role: "junior" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 3, maxCalls: 3 },
  };
  await createWorkflow(stateDir, request, structuredClone(organization), dir);
  const revision = () => readWorkflow(stateDir, request.id).state.revision;

  reserveExecution(stateDir, request.id, revision(), {
    schemaVersion: 1,
    eventId: "reserve-one",
    attemptId: "attempt-one",
    taskId: "lease",
    callAllowance: 2,
    reserveOnly: true,
  });
  const reserved = readWorkflow(stateDir, request.id).state;
  assert.equal(reserved.tasks.lease.state, "reserved");
  assert.equal(reserved.budget.attemptsUsed, 1);
  // Before this command the only answer to a failed launch was the same action,
  // repeated forever, with the slot and the attempt never coming back.
  assert.deepEqual(
    resumeWorkflow(stateDir, request.id, revision()).actions.map((a) => a.type),
    ["launch-reconcile-required"],
  );

  const release = (patch = {}) => ({
    schemaVersion: 1,
    eventId: "release-one",
    taskId: "lease",
    attemptId: "attempt-one",
    resolution: "launcher exited before starting a worker",
    evidence: "runs/launch-failure",
    ...patch,
  });
  assert.throws(
    () => releaseReservation(stateDir, request.id, revision() - 1, release()),
    /Workflow changed; read state again/,
  );
  assert.throws(
    () =>
      releaseReservation(
        stateDir,
        request.id,
        revision(),
        release({ evidence: " " }),
      ),
    /resolution and evidence/,
  );
  assert.throws(
    () =>
      releaseReservation(
        stateDir,
        request.id,
        revision(),
        release({ attemptId: "attempt-other" }),
      ),
    /does not match the reserved attempt/,
  );

  const released = releaseReservation(
    stateDir,
    request.id,
    revision(),
    release(),
  ).state;
  assert.equal(released.tasks.lease.state, "pending");
  assert.equal(released.tasks.lease.attemptId, null);
  assert.equal(released.status, "ready");
  // The attempt stays spent so a failing launch loop is never free work.
  assert.equal(released.budget.attemptsUsed, 1);
  assert.equal(released.tasks.lease.attempts[0].status, "released");

  // Replaying the same event is a no-op, and the task is dispatchable again.
  assert.equal(
    releaseReservation(stateDir, request.id, revision(), release()).duplicate,
    true,
  );
  assert.deepEqual(
    resumeWorkflow(stateDir, request.id, revision()).actions.map((a) => a.type),
    ["dispatch-ready"],
  );
  assert.throws(
    () =>
      releaseReservation(
        stateDir,
        request.id,
        revision(),
        release({ eventId: "release-two" }),
      ),
    /holds no reservation to release/,
  );
});

test("a launch refused before it started returns its attempt with the reservation", async (t) => {
  const dir = await repo(t);
  const stateDir = path.join(dir, ".omt");
  writeJSON(path.join(dir, "lease.json"), task);
  const request = {
    schemaVersion: 1,
    id: "refused-launch",
    goal: "Return the attempt of a refused launch",
    repo: ".",
    tasks: [{ file: "lease.json", role: "junior" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 1, maxCalls: 3 },
  };
  await createWorkflow(stateDir, request, structuredClone(organization), dir);
  const revision = () => readWorkflow(stateDir, request.id).state.revision;
  const reserve = (suffix) =>
    reserveExecution(stateDir, request.id, revision(), {
      schemaVersion: 1,
      eventId: `reserve-${suffix}`,
      attemptId: `attempt-${suffix}`,
      taskId: "lease",
      callAllowance: 2,
      reserveOnly: true,
    });
  const release = (suffix, patch = {}) => ({
    schemaVersion: 1,
    eventId: `release-${suffix}`,
    taskId: "lease",
    attemptId: `attempt-${suffix}`,
    resolution: "Orca refused the injection before typing anything",
    evidence: "failure-junior-inject.json",
    ...patch,
  });
  const notStarted = {
    kind: "not-started",
    code: "inject_rejected",
    message: "no recognized agent detected",
  };

  reserve("one");
  // Only a signal proving nothing started returns the attempt.
  assert.throws(
    () =>
      releaseReservation(
        stateDir,
        request.id,
        revision(),
        release("one", {
          refusal: { processState: "unknown", code: "failed", message: "x" },
        }),
      ),
    /Only a launch refused before any work started/,
  );

  // #46: with maxAttempts 1 a refused injection used to exhaust the workflow,
  // which then had to be recreated although no work had been attempted.
  const released = releaseReservation(
    stateDir,
    request.id,
    revision(),
    release("one", { refusal: notStarted }),
  ).state;
  assert.equal(released.budget.attemptsUsed, 0);
  assert.equal(released.tasks.lease.attempts[0].status, "refused");
  assert.equal(
    released.tasks.lease.attempts[0].refusal.code,
    "inject_rejected",
  );

  // The returned attempt is usable, and an ordinary release still spends it.
  reserve("two");
  const spent = releaseReservation(
    stateDir,
    request.id,
    revision(),
    release("two"),
  ).state;
  assert.equal(spent.budget.attemptsUsed, 1);
});
