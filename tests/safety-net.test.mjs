/** Covers the guards that protect concurrent state, reviews, and the Orca edge. */
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
import {
  acceptWorkflowIntegration,
  attachExecution,
  createWorkflow,
  readWorkflow,
  recordSettlement,
  reserveExecution,
  resumeWorkflow,
  retryTask,
  validateWorkflowRequest,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";
import { validateReviewInput } from "../plugins/oh-my-teams/scripts/gates.mjs";
import {
  discoverOrcaRuntime,
  runOrcaJson,
  selectOrcaExecutable,
} from "../plugins/oh-my-teams/scripts/orca-adapter.mjs";
import {
  ALLOWED_OPTIONS,
  REQUIRED_OPTIONS,
  main,
} from "../plugins/oh-my-teams/scripts/teams-org.mjs";

const organization = readJSON(
  new URL("../plugins/oh-my-teams/examples/organization.json", import.meta.url),
);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-safety-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function repo(t) {
  const dir = fixture(t);
  for (const args of [
    ["init"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"],
  ]) {
    assert.equal((await run(["git", ...args], { cwd: dir })).code, 0);
  }
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
  goal: "Safety net",
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

const validRequest = () => ({
  schemaVersion: 1,
  id: "safety-request",
  goal: "Ship it",
  repo: ".",
  tasks: [{ file: "alpha.json", role: "intern" }],
  policy: { maxRunning: 1, maxReviewPending: 1 },
  budget: { maxAttempts: 1, maxCalls: 1 },
});

test("every workflow mutation refuses a revision it did not read", async (t) => {
  const dir = await repo(t);
  const stateDir = path.join(dir, ".omt");
  writeJSON(path.join(dir, "alpha.json"), task("alpha"));
  const request = { ...validRequest(), id: "safety-revision" };
  await createWorkflow(stateDir, request, structuredClone(organization), dir);

  const current = () => readWorkflow(stateDir, request.id).state.revision;
  const stale = () => current() - 1;
  const receipt = {
    executionId: "alpha",
    runId: "alpha",
    taskId: "alpha",
    dispatchId: "alpha",
    worktreeId: "alpha",
  };

  // Each entry point takes the revision the caller believes is current. A stale
  // value means someone else advanced the workflow in between, so the write must
  // be refused rather than applied to state the caller never saw.
  const mutations = [
    ["resumeWorkflow", () => resumeWorkflow(stateDir, request.id, stale())],
    [
      "attachExecution",
      () =>
        attachExecution(stateDir, request.id, stale(), {
          schemaVersion: 1,
          eventId: "attach-stale",
          attemptId: "attempt-stale",
          taskId: "alpha",
          receipt,
        }),
    ],
    [
      "reserveExecution",
      () =>
        reserveExecution(stateDir, request.id, stale(), {
          schemaVersion: 1,
          eventId: "reserve-stale",
          attemptId: "attempt-stale",
          taskId: "alpha",
        }),
    ],
    [
      "recordSettlement",
      () =>
        recordSettlement(stateDir, request.id, stale(), {
          schemaVersion: 1,
          eventId: "settle-stale",
          attemptId: "attempt-stale",
          taskId: "alpha",
          executionId: "alpha",
          outcome: "settled",
          callsUsed: 0,
        }),
    ],
    [
      "retryTask",
      () =>
        retryTask(stateDir, request.id, stale(), {
          schemaVersion: 1,
          eventId: "retry-stale",
          taskId: "alpha",
          resolution: "fixed",
          evidence: "runs/alpha",
        }),
    ],
  ];

  const before = current();
  for (const [label, mutate] of mutations) {
    assert.throws(mutate, /Workflow changed; read state again/, label);
    assert.equal(current(), before, `${label} must not advance the revision`);
  }

  await assert.rejects(
    () =>
      acceptWorkflowIntegration(stateDir, request.id, stale(), {
        repo: dir,
        report: {},
      }),
    /Workflow changed; read state again/,
  );
  assert.equal(current(), before);
});

test("a workflow request is rejected field by field before any file is read", () => {
  assert.equal(validateWorkflowRequest(validRequest()).id, "safety-request");

  const invalid = [
    [{ schemaVersion: 2 }, /schemaVersion=1 and id required/],
    [{ id: "Bad Id" }, /schemaVersion=1 and id required/],
    [{ goal: "" }, /goal required/],
    [{ repo: "   " }, /repository required/],
    [{ tasks: [] }, /tasks required/],
    [{ tasks: [{ file: "a.json", role: "director" }] }, /file and role/],
    [{ tasks: [{ file: "", role: "intern" }] }, /file and role/],
    [{ policy: { maxRunning: 0, maxReviewPending: 1 } }, /maxRunning required/],
    [
      { policy: { maxRunning: 1, maxReviewPending: 0 } },
      /maxReviewPending required/,
    ],
    [{ budget: { maxAttempts: 0, maxCalls: 1 } }, /maxAttempts required/],
    [{ budget: { maxAttempts: 1, maxCalls: 0 } }, /maxCalls required/],
  ];
  for (const [patch, expected] of invalid) {
    assert.throws(
      () => validateWorkflowRequest({ ...validRequest(), ...patch }),
      expected,
      JSON.stringify(patch),
    );
  }
});

test("a review cannot approve itself, skip a criterion, or carry an open finding", () => {
  const reviewed = {
    ...task("reviewed"),
    acceptance: [
      { id: "correctness", description: "correct", method: "review" },
      { id: "scope", description: "in scope", method: "review" },
    ],
    checks: [[process.execPath, "-e", "process.exit(0)"]],
    reviewRequirements: [
      {
        id: "senior-review",
        kind: "agent-review",
        role: "senior",
        criteria: ["correctness", "scope"],
      },
    ],
  };
  const valid = () => ({
    schemaVersion: 1,
    id: "review-1",
    requirementId: "senior-review",
    reviewer: {
      kind: "agent-review",
      role: "senior",
      executionId: "review-exec",
    },
    implementationExecutionId: "impl-exec",
    conclusion: "approved",
    criteria: [
      { id: "correctness", conclusion: "approved", evidence: "read the diff" },
      { id: "scope", conclusion: "approved", evidence: "matches contract" },
    ],
    findings: [],
  });
  assert.equal(validateReviewInput(valid(), reviewed).id, "review-1");

  const invalid = [
    [{ schemaVersion: 2 }, /schemaVersion=1 and id required/],
    [
      { reviewer: { kind: "human", role: "senior", executionId: "x" } },
      /required kind\/role\/execution identity/,
    ],
    [
      { reviewer: { kind: "agent-review", role: "junior", executionId: "x" } },
      /required kind\/role\/execution identity/,
    ],
    [
      { reviewer: { kind: "agent-review", role: "senior", executionId: "  " } },
      /required kind\/role\/execution identity/,
    ],
    // The reviewer must not be the execution that produced the work.
    [
      { implementationExecutionId: "review-exec" },
      /different execution identity/,
    ],
    [{ conclusion: "maybe" }, /Invalid review conclusion/],
    [
      { criteria: [valid().criteria[0]] },
      /every required criterion exactly once/,
    ],
    [
      { criteria: [valid().criteria[0], valid().criteria[0]] },
      /criteria do not match the requirement/,
    ],
    [
      {
        criteria: [
          { id: "correctness", conclusion: "approved", evidence: "" },
          valid().criteria[1],
        ],
      },
      /needs a conclusion and evidence/,
    ],
    [{ findings: "none" }, /findings array required/],
    [
      {
        conclusion: "changes-requested",
        criteria: valid().criteria.map((item) => ({
          ...item,
          conclusion: "changes-requested",
        })),
        findings: [{ id: "f1", status: "bad", description: "x" }],
      },
      /Invalid finding status/,
    ],
    [
      {
        conclusion: "changes-requested",
        criteria: valid().criteria.map((item) => ({
          ...item,
          conclusion: "changes-requested",
        })),
        findings: [{ id: "f1", status: "resolved", description: "x" }],
      },
      /Resolved finding needs evidence/,
    ],
    [
      {
        conclusion: "changes-requested",
        criteria: valid().criteria.map((item) => ({
          ...item,
          conclusion: "changes-requested",
        })),
        findings: [
          {
            id: "f1",
            status: "accepted-risk",
            description: "x",
            authority: "junior",
            reason: "ok",
          },
        ],
      },
      /Accepted risk needs PM\/user authority/,
    ],
    [
      {
        criteria: [
          { id: "correctness", conclusion: "changes-requested", evidence: "e" },
          valid().criteria[1],
        ],
      },
      /Approved review requires every criterion approved/,
    ],
    // The defect this guards: an approved review that still carries open work.
    [
      {
        findings: [{ id: "f1", status: "open", description: "leaks a handle" }],
      },
      /Approved review cannot contain open findings/,
    ],
  ];
  for (const [patch, expected] of invalid) {
    assert.throws(
      () => validateReviewInput({ ...valid(), ...patch }, reviewed),
      expected,
      JSON.stringify(patch),
    );
  }
});

test("the Orca adapter refuses every unusable response instead of guessing", async () => {
  const reply =
    (stdout, extra = {}) =>
    async () => ({
      code: 0,
      stdout,
      stderr: "",
      timedOut: false,
      ...extra,
    });
  const ready = JSON.stringify({
    ok: true,
    result: {
      runtime: { reachable: true, state: "ready", appVersion: "1.4.200" },
    },
  });

  await assert.rejects(
    () =>
      runOrcaJson("orca", ["status"], {
        execute: reply("", { code: 1, stderr: "boom" }),
      }),
    /boom/,
  );
  await assert.rejects(
    () =>
      runOrcaJson("orca", ["status"], {
        execute: reply(ready, { timedOut: true }),
      }),
    /Orca command failed|ready/,
  );
  await assert.rejects(
    () => runOrcaJson("orca", ["status"], { execute: reply("not json") }),
    /not valid JSON/,
  );
  await assert.rejects(
    () =>
      runOrcaJson("orca", ["status"], {
        execute: reply(JSON.stringify({ ok: false, error: "denied" })),
      }),
    /denied/,
  );

  const stage = (failing, payload) => {
    let call = 0;
    return async () => {
      call += 1;
      if (call === failing)
        return { code: 1, stdout: "", stderr: "stage fail", timedOut: false };
      return {
        code: 0,
        stdout: call === 3 ? payload : "1.4.200",
        stderr: "",
        timedOut: false,
      };
    };
  };
  await assert.rejects(
    () => discoverOrcaRuntime("orca", stage(1, ready)),
    /Selected Orca executable failed/,
  );
  await assert.rejects(
    () => discoverOrcaRuntime("orca", stage(2, ready)),
    /guide discovery failed/,
  );
  await assert.rejects(
    () => discoverOrcaRuntime("orca", stage(3, ready)),
    /status failed/,
  );
  await assert.rejects(
    () => discoverOrcaRuntime("orca", stage(0, "not json")),
    /status response is not valid JSON/,
  );
  for (const runtime of [
    { reachable: false, state: "ready" },
    { reachable: true, state: "starting" },
  ]) {
    await assert.rejects(
      () =>
        discoverOrcaRuntime(
          "orca",
          stage(0, JSON.stringify({ ok: true, result: { runtime } })),
        ),
      /runtime is not ready/,
    );
  }
  assert.equal(
    (await discoverOrcaRuntime("orca", stage(0, ready))).executable,
    "orca",
  );
});

test("executable selection is explicit and never silently falls back", () => {
  assert.equal(selectOrcaExecutable("custom-orca", {}), "custom-orca");
  assert.equal(
    selectOrcaExecutable("custom-orca", { ORCA_CLI_COMMAND: "x" }),
    "custom-orca",
  );
  assert.equal(
    selectOrcaExecutable(undefined, { ORCA_CLI_COMMAND: "from-env" }),
    "from-env",
  );
  assert.equal(
    selectOrcaExecutable(undefined, { ORCA_DEV_REPO_ROOT: "/repo" }),
    "orca-dev",
  );
  assert.equal(
    selectOrcaExecutable(undefined, {}),
    process.platform === "linux" ? "orca-ide" : "orca",
  );
  assert.equal(
    selectOrcaExecutable(undefined, { TERM_PROGRAM: "Orca" }),
    "orca",
  );
});

test("every CLI subcommand enforces its declared required options", async () => {
  const commands = Object.keys(REQUIRED_OPTIONS);
  assert.ok(commands.length >= 30, "the command table must stay complete");

  for (const command of commands) {
    // The two tables drift apart silently: a required option that is not also
    // allowed can never be supplied, and the command becomes unusable.
    const allowed = ALLOWED_OPTIONS[command];
    assert.ok(allowed, `${command} has no allowed-option list`);
    for (const option of REQUIRED_OPTIONS[command]) {
      assert.ok(
        allowed.includes(option),
        `${command} requires unusable --${option}`,
      );
    }

    const [first] = REQUIRED_OPTIONS[command];
    if (!first) continue;
    await assert.rejects(
      () => main([command]),
      new RegExp(`--${first} required`),
      command,
    );
  }

  await assert.rejects(() => main(["not-a-command"]), /Unknown command/);
  await assert.rejects(
    () => main(["show", "--nope", "x"]),
    /Unknown option: --nope/,
  );
});

test("matrix로 차단된 실행 전 거부는 workflow attempt를 소비하지 않는다", async () => {
  // 브리프 기준 6: predictLaunchPath가 blocked를 반환하면 터미널이 열리지 않으며
  // Orca 호출 없이 오류를 던진다. Attempt 예약은 터미널이 열린 뒤에 일어나므로
  // Orca 호출이 0건임을 확인하면 attempt 소비가 없음을 증명한다.
  const { openRoleTerminal } =
    await import("../plugins/oh-my-teams/scripts/role-terminal.mjs");
  const { VERIFIED_ORCA_VERSION, VERIFIED_CLI_VERSION } =
    await import("../plugins/oh-my-teams/scripts/launch-matrix.mjs");
  const { roleCommand } =
    await import("../plugins/oh-my-teams/scripts/role-launch.mjs");

  const orcaCalls = [];
  const execute = async (argv) => {
    orcaCalls.push(argv);
    return { code: 0, stdout: "{}" };
  };

  const org = readJSON(
    new URL(
      "../plugins/oh-my-teams/examples/organization.json",
      import.meta.url,
    ),
  );
  const gemini = roleCommand(org, "senior");

  // Agy gemini win32/powershell → orca-idle-requires-narrow-screen (matrix blocked)
  let thrown = null;
  try {
    await openRoleTerminal({
      worktree: "id:repo::/tmp/wt",
      command: gemini,
      execute,
      platform: "win32",
      shell: "powershell",
      trustRecordExists: true,
      orcaVersion: VERIFIED_ORCA_VERSION,
      cliVersion: VERIFIED_CLI_VERSION,
      settleMs: 5,
      readyMs: 20,
      pollMs: 1,
    });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, "openRoleTerminal must throw for blocked matrix path");
  assert.match(thrown.message, /orca-idle-requires-narrow-screen/);

  // Orca 호출이 전혀 없어야 함 → attempt 예약 시도 없음
  assert.equal(
    orcaCalls.length,
    0,
    "matrix refusal must not invoke orca (no attempt consumed)",
  );
});
