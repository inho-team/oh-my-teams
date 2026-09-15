/** End-to-end and unit regression coverage for the oh my teams runtime. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readJSON,
  writeJSON,
  validateOrg,
  saveOrg,
  chart,
  inside,
  hash,
  run,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  assist,
  applyEdits,
  draft,
  makePrompt,
  work,
} from "../plugins/oh-my-teams/scripts/worker.mjs";
import {
  verify,
  validateEvidence,
  aggregate,
  checkCitations,
  citationGrounding,
  workspaceBinding,
} from "../plugins/oh-my-teams/scripts/evidence.mjs";
import {
  classifyProviderFailure,
  decodeOutput,
  modelBinding,
  providerCommand,
  invoke,
} from "../plugins/oh-my-teams/scripts/providers.mjs";
import {
  taskHash,
  validateTask,
} from "../plugins/oh-my-teams/scripts/contracts.mjs";
import { previewPreset } from "../plugins/oh-my-teams/scripts/presets.mjs";
import {
  acceptOutcome,
  gateCheck,
  recordReview,
} from "../plugins/oh-my-teams/scripts/gates.mjs";
import {
  attachWorkspace,
  prepareInput,
} from "../plugins/oh-my-teams/scripts/workspace.mjs";
import {
  attachExecution,
  createWorkflow,
  readWorkflow,
  recordSettlement,
  resumeWorkflow,
  retryTask,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";
import { classifyFailure } from "../plugins/oh-my-teams/scripts/failures.mjs";
import { recordLessonCandidate } from "../plugins/oh-my-teams/scripts/lessons.mjs";
import {
  incidentStatus,
  ingestIncident,
  observeIncident,
} from "../plugins/oh-my-teams/scripts/incidents.mjs";
import {
  createWorktree,
  discoverOrcaRuntime,
} from "../plugins/oh-my-teams/scripts/orca-adapter.mjs";
import { supervisedProgressStatus } from "../plugins/oh-my-teams/scripts/status.mjs";
import {
  evaluateRoutingFixture,
  routingFixtures,
} from "../experiments/routing-fixtures.mjs";
import { summarizeRouting } from "../experiments/summarize-routing.mjs";
import {
  compareQuotaSnapshots,
  latestQuotaSnapshots,
  quotaStatus,
  recordQuotaSnapshot,
} from "../plugins/oh-my-teams/scripts/quota.mjs";
import { parseArgs } from "../plugins/oh-my-teams/scripts/teams-org.mjs";
import {
  buildInstallPlan,
  parseInstallArgs,
  pluginStates,
} from "../scripts/install.mjs";

const example = readJSON(
  new URL("../plugins/oh-my-teams/examples/organization.json", import.meta.url),
);
const clone = () => structuredClone(example);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-org-test-"));
  // Exact test-owned directory, verified at creation; no user paths are removed.
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function repo(t) {
  const dir = fixture(t);
  for (const args of [
    ["init"],
    ["config", "user.name", "Orca Test"],
    ["config", "user.email", "test@example.invalid"],
  ]) {
    const result = await run(["git", ...args], { cwd: dir });
    assert.equal(result.code, 0, result.stderr);
  }
  fs.writeFileSync(path.join(dir, ".gitignore"), ".omt/\n");
  fs.writeFileSync(path.join(dir, "value.txt"), "wrong\n");
  fs.writeFileSync(
    path.join(dir, "check.mjs"),
    `import fs from 'node:fs';if(fs.readFileSync('value.txt','utf8')!=='right\\n')process.exit(1);`,
  );
  for (const args of [
    ["add", ".gitignore", "value.txt", "check.mjs"],
    ["commit", "-m", "fixture"],
  ]) {
    const result = await run(["git", ...args], { cwd: dir });
    assert.equal(result.code, 0, result.stderr);
  }
  return dir;
}
const task = {
  schemaVersion: 1,
  id: "value-fix",
  instruction: "Replace wrong with right, retaining newline",
  files: ["value.txt"],
  checks: [[process.execPath, "check.mjs"]],
  environment: "fixture-v1",
  baseRef: "HEAD",
  risk: "low",
};
const taskV2 = {
  schemaVersion: 2,
  revision: 1,
  kind: "edit",
  id: "value-fix-v2",
  goal: "Make the checked value correct",
  instruction: "Replace wrong with right, retaining newline",
  nonGoals: ["Do not change the checker"],
  constraints: ["Retain the newline"],
  files: ["value.txt"],
  checks: [[process.execPath, "check.mjs"]],
  acceptance: [
    {
      id: "value-check",
      description: "The fixed value passes the checker",
      method: "check",
      checkIndexes: [0],
    },
    {
      id: "scope-review",
      description: "Only the allowed file changes",
      method: "review",
    },
  ],
  dependencies: [],
  contractRefs: [],
  contextRefs: [],
  openQuestions: [],
  reviewRequirements: [
    {
      id: "semantic-review",
      kind: "agent-review",
      role: "senior",
      criteria: ["scope-review"],
    },
  ],
  environment: "fixture-v2",
  baseRef: "HEAD",
  risk: "normal",
};
function response(payload, extras = {}) {
  return {
    code: 0,
    stdout: JSON.stringify(payload),
    stderr: "",
    text: JSON.stringify(payload),
    elapsedMs: 1,
    usage: null,
    ...extras,
  };
}

test("first setup is idempotent; explicit edits archive and reject stale revisions", (t) => {
  const file = path.join(fixture(t), "organization.json");
  assert.equal(saveOrg(file, clone()).created, true);
  const changed = clone();
  changed.name = "new-team";
  assert.equal(saveOrg(file, changed).organization.name, "example-team");
  assert.equal(
    saveOrg(file, changed, { update: true, expectedRevision: 1 }).organization
      .revision,
    2,
  );
  assert.equal(
    readJSON(path.join(path.dirname(file), "history", "org-1.json")).name,
    "example-team",
  );
  assert.throws(
    () => saveOrg(file, clone(), { update: true, expectedRevision: 1 }),
    /changed/,
  );
});
test("graph validation accepts branches and rejects cycle/missing profile/second root", () => {
  assert.ok(chart(validateOrg(clone())).includes("INTERN"));
  const cycle = clone();
  cycle.roles.pl.parent = "intern";
  assert.throws(() => validateOrg(cycle), /cycle/);
  const bad = clone();
  bad.roles.intern.profile = "missing";
  assert.throws(() => validateOrg(bad), /profile/);
  const root = clone();
  root.roles.senior.parent = null;
  assert.throws(() => validateOrg(root), /root/);
  const assistant = clone();
  assistant.assistants.pm = ["missing"];
  assert.throws(() => validateOrg(assistant), /assistant profiles/);
});
test("default organization uses the responsibility hierarchy and routing", () => {
  const org = validateOrg(clone());
  assert.equal(org.roles.pl.parent, "pm");
  assert.equal(org.roles.senior.parent, "pl");
  assert.equal(org.roles.junior.parent, "senior");
  assert.equal(org.roles.intern.parent, "junior");
  assert.deepEqual(
    ["pm", "pl", "senior", "junior", "intern"].map(
      (role) => org.roles[role].concurrency,
    ),
    [1, 1, 1, 2, 4],
  );
  assert.equal(org.profiles[org.roles.pl.profile].model, "gpt-5.6-sol");
  assert.equal(
    org.profiles[org.roles.senior.profile].model,
    "gemini-3.8-flash-high",
  );
  assert.equal(
    org.profiles[org.roles.junior.profile].model,
    "claude-opus-4-6-thinking",
  );
  assert.equal(
    org.profiles[org.roles.intern.profile].model,
    "claude-sonnet-4-6",
  );
  assert.ok(Object.values(org.profiles).some((profile) => profile.model === "gpt-oss-120b-medium"));
  for (const role of ["pm", "pl", "senior", "junior", "intern"]) {
    assert.deepEqual(org.assistants[role], ["agy-oss"]);
  }
});
test("every role can use the configured GPT-OSS research assistant with an audit record", async (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "source.txt"), "alpha\nbeta\n");
  const assistantTask = {
    ...task,
    id: "assistant-research",
    instruction: "Find the beta line",
    files: ["source.txt"],
    checks: [[process.execPath, "--version"]],
  };
  for (const role of ["pm", "pl", "senior", "junior", "intern"]) {
    const stateDir = path.join(dir, `.omt-${role}`);
    const report = await assist(dir, clone(), assistantTask, {
      role,
      kind: "research",
      stateDir,
      call: async (profile) => {
        assert.equal(profile.model, "gpt-oss-120b-medium");
        return response({
          summary: "Found beta",
          items: ["beta is present"],
          citations: [{ file: "source.txt", line: 2, quote: "beta" }],
        });
      },
    });
    assert.equal(report.callerRole, role);
    assert.equal(report.profile, "agy-oss");
    assert.equal(report.citations[0].verified, true);
    assert.ok(fs.existsSync(report.reportPath));
    assert.ok(fs.existsSync(report.log));
    assert.equal(report.logHash, hash(`${JSON.stringify({
      summary: "Found beta",
      items: ["beta is present"],
      citations: [{ file: "source.txt", line: 2, quote: "beta" }],
    })}\n`));
  }
});
test("assistant edit uses GPT-OSS while retaining caller role checks and scope", async (t) => {
  const dir = await repo(t);
  const result = await assist(dir, clone(), task, {
    role: "junior",
    kind: "edit",
    stateDir: path.join(dir, ".omt"),
    call: async (profile) => {
      assert.equal(profile.model, "gpt-oss-120b-medium");
      return response({
        edits: [
          {
            file: "value.txt",
            beforeHash: hash("wrong\n"),
            content: "right\n",
          },
        ],
      });
    },
  });
  assert.equal(result.status, "passed");
  assert.equal(result.role, "junior");
  assert.equal(result.calls[0].profile, "agy-oss");
  assert.equal(result.calls[0].selectionReason, "assistant:junior:edit");
});
test("assistant rejects profiles not authorized for the caller", async (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "source.txt"), "alpha\n");
  const assistantTask = {
    ...task,
    files: ["source.txt"],
    checks: [[process.execPath, "--version"]],
  };
  await assert.rejects(
    () =>
      assist(dir, clone(), assistantTask, {
        role: "pm",
        kind: "research",
        profileId: "agy-sonnet",
        stateDir: path.join(dir, ".omt"),
        call: async () => response({}),
      }),
    /not allowed/,
  );
});
test("account labels alone cannot pretend to switch subscriptions", () => {
  const org = clone();
  org.profiles["agy-oss"].account = "second-account";
  assert.throws(() => validateOrg(org), /binding/);
  org.profiles["agy-oss"].env = {
    AUTH_TOKEN: "ACTUAL_SECRET_TEXT-with-hyphen",
  };
  assert.throws(() => validateOrg(org), /environment/);
});
test("edit protocol validates every edit before writing and rejects traversal/stale input", (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "value.txt"), "old");
  assert.throws(() => inside(dir, "../outside"), /Forbidden/);
  assert.throws(() => inside(dir, ".git/config"), /Forbidden/);
  assert.throws(() => inside(dir, ".orca/runtime.json"), /Forbidden/);
  assert.throws(() => inside(dir, ".omt/organization.json"), /Forbidden/);
  assert.throws(
    () =>
      applyEdits(dir, task, {
        edits: [
          { file: "value.txt", beforeHash: hash("old"), content: "new" },
          { file: "other", beforeHash: null, content: "bad" },
        ],
      }),
    /Unexpected/,
  );
  assert.equal(fs.readFileSync(path.join(dir, "value.txt"), "utf8"), "old");
  assert.throws(
    () =>
      applyEdits(dir, task, {
        edits: [{ file: "value.txt", beforeHash: "stale", content: "new" }],
      }),
    /changed/,
  );
});
test("evidence is cached only for identical source, commands, base, environment and logs", async (t) => {
  const dir = await repo(t),
    store = path.join(dir, ".omt", "evidence");
  fs.writeFileSync(path.join(dir, "value.txt"), "right\n");
  const options = {
    store,
    commands: task.checks,
    environment: "env1",
    baseRef: "HEAD",
  };
  const first = await verify(dir, options);
  assert.equal(first.status, "passed");
  assert.equal(first.cached, false);
  assert.equal((await verify(dir, options)).cached, true);
  assert.equal(await validateEvidence(dir, first, "HEAD"), true);
  fs.appendFileSync(first.checks[0].log, "tamper");
  await assert.rejects(() => validateEvidence(dir, first, "HEAD"), /log/);
  assert.equal((await verify(dir, options)).cached, false);
  assert.equal(
    (await verify(dir, { ...options, environment: "env2" })).cached,
    false,
  );
  fs.writeFileSync(path.join(dir, "value.txt"), "wrong\n");
  await assert.rejects(() => validateEvidence(dir, first, "HEAD"), /Stale/);
  const bad = await verify(dir, options);
  assert.equal(bad.status, "failed");
  assert.equal((await verify(dir, options)).cached, false);
});
test("checks that mutate source cannot produce reusable success", async (t) => {
  const dir = await repo(t);
  const result = await verify(dir, {
    store: path.join(dir, ".omt", "evidence"),
    baseRef: "HEAD",
    environment: "fixture",
    commands: [
      [
        process.execPath,
        "-e",
        "require('fs').writeFileSync('value.txt','mutated')",
      ],
    ],
  });
  assert.equal(result.status, "failed");
  assert.equal(result.unchanged, false);
});
test("aggregation rejects missing, duplicate and failed task results", () => {
  const report = {
    taskId: "a",
    status: "passed",
    evidence: { status: "passed", key: "key" },
  };
  assert.equal(aggregate([report], ["a"]).status, "ready-for-verification");
  assert.deepEqual(aggregate([report], ["a", "b"]).missing, ["b"]);
  assert.throws(() => aggregate([report, report], ["a"]), /duplicate/);
  assert.equal(
    aggregate([{ ...report, status: "failed" }], ["a"]).status,
    "blocked",
  );
});
test("citations match exact source lines within tolerance; no invented evidence", (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "file.txt"), "alpha\nbeta\ngamma\n");
  const result = checkCitations(dir, [
    { file: "file.txt", line: 1, quote: "beta" },
    { file: "file.txt", line: 1, quote: "bet" },
    { file: "../secret", line: 1, quote: "secret" },
  ]);
  assert.deepEqual(
    result.map((r) => r.verified),
    [true, false, false],
  );
  assert.equal(result[0].actualLine, 2);
});
test("usage is measured separately from missing monetary cost", () => {
  const agy = decodeOutput(
    JSON.stringify({
      result: '{"code":"x"}',
      usage: { input_tokens: 10, total_tokens: 12 },
    }),
  );
  assert.equal(agy.usage.total_tokens, 12);
  assert.equal(agy.costUsd, null);
  const codex = decodeOutput(
    '{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}\n{"type":"turn.completed","usage":{"input_tokens":5}}',
  );
  assert.equal(codex.text, "answer");
  assert.equal(codex.usage.input_tokens, 5);
  assert.equal(decodeOutput("no metrics").usage, null);
  assert.equal(
    decodeOutput(JSON.stringify({ result: "ok", model: "effective-model" }))
      .effectiveModel,
    "effective-model",
  );
});
test("provider argv preserves prompt literally without shell execution or permission bypass", () => {
  for (const provider of ["agy", "claude", "codex"]) {
    const spec = providerCommand(
      { provider, command: [provider], model: "specific-id" },
      "/tmp/task",
      "literal $(not-a-command) `text`",
    );
    assert.ok(spec.argv.includes("specific-id"));
    assert.ok(!spec.argv.some((v) => v.startsWith("--dangerously")));
  }
});
test("Agy selects GPT-OSS, Sonnet, and Opus with the same model argument", () => {
  for (const model of [
    "gpt-oss-120b-medium",
    "claude-sonnet-4-6",
    "claude-opus-4-6-thinking",
  ]) {
    const spec = providerCommand(
      { provider: "agy", command: ["agy"], model },
      "/tmp/task",
      "prompt",
    );
    const modelIndex = spec.argv.indexOf("--model");
    assert.ok(modelIndex > 0);
    assert.equal(spec.argv[modelIndex + 1], model);
    assert.ok(!spec.argv.includes("--effort"));
  }
});
test("failed OSS output promotes once to configured fallback and preserves org snapshot", async (t) => {
  const dir = await repo(t),
    org = clone();
  org.roles.intern.profile = "agy-oss";
  org.roles.intern.fallbacks = ["agy-sonnet"];
  let calls = 0;
  const result = await work(dir, org, task, {
    stateDir: path.join(dir, ".omt"),
    call: async (profile) => {
      calls++;
      return calls === 1
        ? response({ edits: [] })
        : response({
            edits: [
              {
                file: "value.txt",
                beforeHash: hash("wrong\n"),
                content: "right\n",
              },
            ],
          });
    },
  });
  assert.equal(result.status, "passed");
  assert.equal(calls, 2);
  assert.deepEqual(
    result.calls.map((c) => c.profile),
    ["agy-oss", "agy-sonnet"],
  );
  org.name = "later";
  assert.equal(
    readJSON(path.join(path.dirname(result.reportPath), "organization.json"))
      .name,
    "example-team",
  );
});
test("quota stop does not switch subscriptions; repeated failure never becomes success", async (t) => {
  const dir = await repo(t),
    org = clone();
  org.policy.onExhaustion = "stop";
  let calls = 0;
  const result = await work(dir, org, task, {
    stateDir: path.join(dir, ".omt"),
    call: async () => {
      calls++;
      return response({}, { code: 1, exhausted: true });
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(calls, 1);
  const retryOrg = clone();
  retryOrg.roles.intern.profile = "agy-oss";
  retryOrg.roles.intern.fallbacks = ["agy-sonnet"];
  const failed = await work(dir, retryOrg, task, {
    stateDir: path.join(dir, ".omt"),
    call: async () => response({ edits: [] }),
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.calls.length, 2);
});
test("provider editing workspace outside JSON protocol is blocked and preserved", async (t) => {
  const dir = await repo(t);
  const result = await work(dir, clone(), task, {
    stateDir: path.join(dir, ".omt"),
    call: async () => {
      fs.writeFileSync(path.join(dir, "check.mjs"), "// weakened");
      return response({ edits: [] });
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.calls.length, 1);
  assert.match(result.issues[0], /outside/);
  assert.equal(
    fs.readFileSync(path.join(dir, "check.mjs"), "utf8"),
    "// weakened",
  );
});
test("concurrency locks block extra workers and are released after settlement", async (t) => {
  const dir = await repo(t),
    org = clone();
  org.roles.intern.concurrency = 1;
  const stateDir = path.join(dir, ".omt");
  fs.mkdirSync(path.join(stateDir, "slots"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "slots", "intern-0.lock"), "owned");
  await assert.rejects(
    () => work(dir, org, task, { stateDir, call: async () => response({}) }),
    /occupied/,
  );
});
test("timed-out provider retains the slot and does not start fallback", async (t) => {
  const dir = await repo(t),
    org = clone();
  org.roles.intern.concurrency = 1;
  const stateDir = path.join(dir, ".omt");
  const result = await work(dir, org, task, {
    stateDir,
    call: async () => response({}, { timedOut: true, pid: 123 }),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.calls.length, 1);
  assert.ok(fs.existsSync(path.join(stateDir, "slots", "intern-0.lock")));
});
test("base and check argv changes invalidate success even with identical source", async (t) => {
  const dir = await repo(t),
    store = path.join(dir, ".omt", "evidence");
  fs.writeFileSync(path.join(dir, "value.txt"), "right\n");
  await run(["git", "add", "value.txt"], { cwd: dir });
  await run(["git", "commit", "-m", "fixed"], { cwd: dir });
  const options = {
    store,
    commands: task.checks,
    environment: "env",
    baseRef: "HEAD",
  };
  const first = await verify(dir, options);
  assert.equal(first.status, "passed");
  const changedBase = await verify(dir, { ...options, baseRef: "HEAD~1" });
  assert.notEqual(changedBase.key, first.key);
  assert.equal(changedBase.cached, false);
  const changedCommand = await verify(dir, {
    ...options,
    commands: [[process.execPath, "--no-warnings", "check.mjs"]],
  });
  assert.notEqual(changedCommand.key, first.key);
  assert.equal(changedCommand.cached, false);
});
test("CLI init reuses the existing organization without reading replacement input", async (t) => {
  const dir = fixture(t),
    file = path.join(dir, "organization.json");
  saveOrg(file, clone());
  const result = await run([
    process.execPath,
    path.resolve("plugins/oh-my-teams/scripts/teams-org.mjs"),
    "init",
    "--org",
    file,
    "--from",
    path.join(dir, "does-not-exist.json"),
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).created, false);
});
test("concurrent edits cannot both accept the same revision", async (t) => {
  const dir = fixture(t),
    file = path.join(dir, "organization.json"),
    proposal = path.join(dir, "next.json");
  saveOrg(file, clone());
  writeJSON(proposal, { ...clone(), name: "changed" });
  const argv = [
    process.execPath,
    path.resolve("plugins/oh-my-teams/scripts/teams-org.mjs"),
    "edit",
    "--org",
    file,
    "--from",
    proposal,
    "--revision",
    "1",
  ];
  const results = await Promise.all([run(argv), run(argv)]);
  assert.equal(results.filter((r) => r.code === 0).length, 1);
  assert.equal(readJSON(file).revision, 2);
});
test("429 in successful source code is not quota exhaustion", async () => {
  const result = await invoke(
    { provider: "agy", command: ["agy"], model: "gpt-oss-120b-medium" },
    ".",
    "prompt",
    1000,
    async () => ({
      code: 0,
      stdout: JSON.stringify({
        result: '{"edits":[],"summary":"handle HTTP 429"}',
      }),
      stderr: "",
    }),
  );
  assert.equal(result.exhausted, false);
  const failed = await invoke(
    { provider: "agy", command: ["agy"], model: "gpt-oss-120b-medium" },
    ".",
    "prompt",
    1000,
    async () => ({
      code: 0,
      stdout: JSON.stringify({
        is_error: true,
        result: "RESOURCE_EXHAUSTED 429",
      }),
      stderr: "",
    }),
  );
  assert.equal(failed.exhausted, true);
});
test("confirmed shared-pool exhaustion skips fallback models in the same pool", async (t) => {
  const dir = await repo(t),
    org = clone();
  let calls = 0;
  const result = await work(dir, org, task, {
    stateDir: path.join(dir, ".omt"),
    call: async () => {
      calls++;
      return response(
        {},
        {
          code: 1,
          providerError: true,
          exhausted: true,
          failureClass: "pool-exhausted",
        },
      );
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(calls, 1);
  assert.equal(result.calls[0].pool, "agy-shared");
});
test("provider failure classification requires structured pool scope", () => {
  assert.equal(
    classifyProviderFailure(
      {
        code: 1,
        stdout: JSON.stringify({
          error: { code: "RESOURCE_EXHAUSTED", scope: "pool" },
        }),
        stderr: "",
      },
      { providerError: true },
    ),
    "pool-exhausted",
  );
  assert.equal(
    classifyProviderFailure(
      {
        code: 1,
        stdout: JSON.stringify({ error: { code: "RESOURCE_EXHAUSTED" } }),
        stderr: "",
      },
      { providerError: true },
    ),
    "quota-unknown",
  );
  assert.equal(
    classifyProviderFailure(
      { code: 1, stdout: "model returned text containing 429", stderr: "" },
      { providerError: false },
    ),
    "model-error",
  );
});
test("merge validation refuses evidence for weaker acceptance commands", async (t) => {
  const dir = await repo(t);
  fs.writeFileSync(path.join(dir, "value.txt"), "right\n");
  const evidence = await verify(dir, {
    store: path.join(dir, ".omt", "evidence"),
    commands: [[process.execPath, "-e", "process.exit(0)"]],
    environment: task.environment,
    baseRef: "HEAD",
  });
  await assert.rejects(
    () => validateEvidence(dir, evidence, "HEAD", task),
    /acceptance/,
  );
});
test("task v2 validates acceptance links and rejects unresolved or unsupported contracts", () => {
  assert.equal(validateTask(structuredClone(taskV2)).revision, 1);
  const badIndex = structuredClone(taskV2);
  badIndex.acceptance[0].checkIndexes = [1];
  assert.throws(() => validateTask(badIndex), /check index/i);
  const question = structuredClone(taskV2);
  question.openQuestions = [
    { id: "q1", question: "Which behavior?", blocking: true },
  ];
  assert.throws(() => validateTask(question), /resolved/);
  const kind = structuredClone(taskV2);
  kind.kind = "research";
  assert.throws(() => validateTask(kind), /kind=edit/);
  const uncovered = structuredClone(taskV2);
  uncovered.reviewRequirements = [];
  assert.throws(() => validateTask(uncovered), /review acceptance criterion/);
});
test("task v2 prompt and report bind goal, acceptance, revision and immutable hash", async (t) => {
  const dir = await repo(t);
  let observed = "";
  assert.match(makePrompt(dir, taskV2), /value-check/);
  const result = await work(dir, clone(), taskV2, {
    stateDir: path.join(dir, ".omt"),
    call: async (_profile, _repo, prompt) => {
      observed = prompt;
      return response({
        edits: [
          {
            file: "value.txt",
            beforeHash: hash("wrong\n"),
            content: "right\n",
          },
        ],
      });
    },
  });
  assert.equal(result.status, "submitted");
  assert.equal(result.implementation.status, "passed");
  assert.equal(result.gates["review-complete"].status, "pending");
  assert.equal(result.taskRevision, 1);
  assert.equal(result.taskHash, taskHash(taskV2));
  assert.match(observed, /Make the checked value correct/);
  assert.deepEqual(
    readJSON(path.join(path.dirname(result.reportPath), "task.json")),
    taskV2,
  );
});
test("model presets preview only changed roles and never mutate an existing organization", () => {
  const org = clone(),
    before = JSON.stringify(org),
    balanced = previewPreset(org, "balanced");
  assert.equal(JSON.stringify(org), before);
  assert.deepEqual(
    balanced.changes.map((change) => change.role),
    ["senior", "junior", "intern"],
  );
  assert.equal(balanced.organization.roles.pm.profile, org.roles.pm.profile);
  assert.equal(balanced.organization.roles.pl.profile, org.roles.pl.profile);
  assert.equal(balanced.organization.roles.senior.profile, "agy-opus");
  assert.equal(balanced.organization.roles.junior.profile, "agy-sonnet");
});
test("legacy runtime path forwards to the renamed oh my teams runtime", async () => {
  const modern = await run([
    process.execPath,
    path.resolve("plugins/oh-my-teams/scripts/teams-org.mjs"),
    "--help",
  ]);
  const legacy = await run([
    process.execPath,
    path.resolve("plugins/orca/scripts/orca-org.mjs"),
    "--help",
  ]);
  assert.equal(legacy.code, 0, legacy.stderr);
  assert.equal(legacy.stdout, modern.stdout);
});
test("task v2 cannot be accepted before independent review and stale source invalidates review", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  const report = await work(dir, clone(), taskV2, {
    stateDir,
    call: async () =>
      response({
        edits: [
          {
            file: "value.txt",
            beforeHash: hash("wrong\n"),
            content: "right\n",
          },
        ],
      }),
  });
  const decision = {
    schemaVersion: 1,
    id: "accept-value",
    decider: { kind: "pm", executionId: "pm-1" },
    criteria: ["value-check", "scope-review"],
    basis: "Checks and semantic review satisfy the goal",
  };
  await assert.rejects(
    () => acceptOutcome(dir, taskV2, report, decision, stateDir),
    /reviews are incomplete/,
  );
  const review = {
    schemaVersion: 1,
    id: "review-value",
    requirementId: "semantic-review",
    reviewer: { kind: "agent-review", role: "senior", executionId: "senior-1" },
    implementationExecutionId: report.runId,
    conclusion: "approved",
    criteria: [
      {
        id: "scope-review",
        conclusion: "approved",
        evidence: "Diff contains only value.txt",
      },
    ],
    findings: [],
  };
  await recordReview(dir, taskV2, report, review, stateDir);
  assert.equal(
    (await gateCheck(dir, taskV2, report, stateDir)).state,
    "reviewed",
  );
  await acceptOutcome(dir, taskV2, report, decision, stateDir);
  assert.equal(
    (await gateCheck(dir, taskV2, report, stateDir)).state,
    "accepted",
  );
  fs.writeFileSync(path.join(dir, "value.txt"), "changed after review\n");
  await assert.rejects(
    () => gateCheck(dir, taskV2, report, stateDir),
    /Stale evidence/,
  );
});
test("same execution cannot satisfy an independent review requirement", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  const report = await work(dir, clone(), taskV2, {
    stateDir,
    call: async () =>
      response({
        edits: [
          {
            file: "value.txt",
            beforeHash: hash("wrong\n"),
            content: "right\n",
          },
        ],
      }),
  });
  const review = {
    schemaVersion: 1,
    id: "self-review",
    requirementId: "semantic-review",
    reviewer: {
      kind: "agent-review",
      role: "senior",
      executionId: report.runId,
    },
    implementationExecutionId: report.runId,
    conclusion: "approved",
    criteria: [
      { id: "scope-review", conclusion: "approved", evidence: "self claim" },
    ],
    findings: [],
  };
  await assert.rejects(
    () => recordReview(dir, taskV2, report, review, stateDir),
    /different execution/,
  );
});
test("an open finding cannot be erased by omitting it from a later approved review", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  const report = await work(dir, clone(), taskV2, {
    stateDir,
    call: async () =>
      response({
        edits: [
          {
            file: "value.txt",
            beforeHash: hash("wrong\n"),
            content: "right\n",
          },
        ],
      }),
  });
  const rejected = {
    schemaVersion: 1,
    id: "review-rejected",
    requirementId: "semantic-review",
    reviewer: { kind: "agent-review", role: "senior", executionId: "senior-1" },
    implementationExecutionId: report.runId,
    conclusion: "changes-requested",
    criteria: [
      {
        id: "scope-review",
        conclusion: "changes-requested",
        evidence: "Finding f-1 blocks approval",
      },
    ],
    findings: [
      {
        id: "f-1",
        status: "open",
        description: "Public contract needs confirmation",
      },
    ],
  };
  const approved = {
    schemaVersion: 1,
    id: "review-omits-finding",
    requirementId: "semantic-review",
    reviewer: { kind: "agent-review", role: "senior", executionId: "senior-2" },
    implementationExecutionId: report.runId,
    conclusion: "approved",
    criteria: [
      {
        id: "scope-review",
        conclusion: "approved",
        evidence: "Diff otherwise looks correct",
      },
    ],
    findings: [],
  };
  await recordReview(dir, taskV2, report, rejected, stateDir);
  await recordReview(dir, taskV2, report, approved, stateDir);
  const gates = await gateCheck(dir, taskV2, report, stateDir);
  assert.equal(gates.gates["review-complete"].status, "pending");
  assert.deepEqual(gates.gates["review-complete"].openFindings, ["f-1"]);
});
test("org-show reports persisted gate owner and keeps unknown usage/cost explicit", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt"),
    orgFile = path.join(stateDir, "organization.json");
  saveOrg(orgFile, clone());
  await work(dir, clone(), taskV2, {
    stateDir,
    call: async () =>
      response({
        edits: [
          {
            file: "value.txt",
            beforeHash: hash("wrong\n"),
            content: "right\n",
          },
        ],
      }),
  });
  const shown = await run([
    process.execPath,
    path.resolve("plugins/oh-my-teams/scripts/teams-org.mjs"),
    "show",
    "--org",
    orgFile,
    "--state",
    stateDir,
    "--json",
  ]);
  assert.equal(shown.code, 0, shown.stderr);
  const output = JSON.parse(shown.stdout);
  assert.equal(output.runs[0].nextOwner, "senior");
  assert.equal(output.usage.missingUsageCalls, 1);
  assert.equal(output.usage.missingCostCalls, 1);
  assert.equal(output.pools["agy-shared"].status, "unknown");
});
test("terminal dispatches cannot be reported as active goal progress", () => {
  const workers = [
    { id: "agy-design", status: "failed", liveness: "exited" },
    { id: "codex-pl", status: "blocked", liveness: "exited" },
  ];
  assert.deepEqual(supervisedProgressStatus({ goalStatus: "blocked", workers }), {
    status: "blocked",
    activeWorkers: 0,
    unverifiableWorkers: 0,
  });
  assert.equal(
    supervisedProgressStatus({ goalStatus: "active", workers }).status,
    "stopped",
  );
  assert.equal(
    supervisedProgressStatus({
      goalStatus: "active",
      workers: [{ liveness: "unverifiable" }],
    }).status,
    "unverifiable",
  );
});
test("workspace preparation and receipt attachment are separated and bind actual Git state", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt"),
    preparedDir = path.join(stateDir, "prepared", "value-task");
  const prepared = await prepareInput(clone(), taskV2, dir, preparedDir);
  assert.match(prepared.frozenTask.baseRef, /^[a-f0-9]{40}$/);
  assert.equal(
    readJSON(prepared.manifest).taskHash,
    taskHash(prepared.frozenTask),
  );
  const receipt = {
      ok: true,
      result: { worktree: { id: "actual-worktree-id", path: dir } },
    },
    runtime = {
      schemaVersion: 1,
      executable: "orca",
      cliVersion: "1.0.0",
      runtimeVersion: "1.0.0",
      versionsMatch: true,
      runtimeId: "runtime-1",
      guide: { id: "orca-cli", sha256: "a".repeat(64) },
    };
  const attached = await attachWorkspace({
    parentRepo: dir,
    workspace: dir,
    stateDir,
    name: "value-task",
    execute: async () => ({
      code: 0,
      stdout: JSON.stringify(receipt),
      stderr: "",
      timedOut: false,
    }),
    org: clone(),
    task: prepared.frozenTask,
    receipt,
    executable: "orca",
    runtime,
  });
  assert.equal(readJSON(attached.record).worktree.id, "actual-worktree-id");
  await assert.rejects(
    () =>
      attachWorkspace({
        parentRepo: dir,
        workspace: dir,
        stateDir,
        name: "forged",
        org: clone(),
        task: prepared.frozenTask,
        receipt,
        executable: "orca",
        runtime,
        execute: async () => ({
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            result: { worktree: { id: "different", path: dir } },
          }),
          stderr: "",
          timedOut: false,
        }),
      }),
    /lookup does not match/,
  );
  await assert.rejects(
    () =>
      attachWorkspace({
        parentRepo: dir,
        workspace: dir,
        stateDir,
        name: "bad-receipt",
        org: clone(),
        task: prepared.frozenTask,
        receipt: {
          ok: true,
          result: { worktree: { id: "wrong", path: "/tmp" } },
        },
        executable: "orca",
        runtime,
      }),
    /does not match/,
  );
});
test("Orca discovery binds the selected executable, runtime version and guide hash", async () => {
  const execute = async (argv) =>
    argv[1] === "--version"
      ? { code: 0, timedOut: false, stdout: "1.2.3\n", stderr: "" }
      : argv[1] === "skills"
        ? { code: 0, timedOut: false, stdout: "current guide", stderr: "" }
        : {
            code: 0,
            timedOut: false,
            stdout: JSON.stringify({
              ok: true,
              result: {
                runtime: {
                  reachable: true,
                  state: "ready",
                  appVersion: "1.2.3",
                  runtimeId: "runtime-123",
                },
              },
            }),
            stderr: "",
          };
  const result = await discoverOrcaRuntime("orca-test", execute);
  assert.equal(result.executable, "orca-test");
  assert.equal(result.versionsMatch, true);
  assert.equal(result.runtimeId, "runtime-123");
  assert.equal(result.guide.sha256, hash("current guide"));
});
test("Orca worktree adapter uses the version-matched active parent contract", async () => {
  const calls = [],
    execute = async (argv) => {
      calls.push(argv);
      if (argv[1] === "--version")
        return { code: 0, timedOut: false, stdout: "1.2.3\n", stderr: "" };
      if (argv[1] === "skills")
        return { code: 0, timedOut: false, stdout: "guide", stderr: "" };
      if (argv[1] === "status")
        return {
          code: 0,
          timedOut: false,
          stdout: JSON.stringify({
            ok: true,
            result: {
              runtime: {
                reachable: true,
                state: "ready",
                appVersion: "1.2.3",
                runtimeId: "r1",
              },
            },
          }),
          stderr: "",
        };
      return {
        code: 0,
        timedOut: false,
        stdout: JSON.stringify({
          ok: true,
          result: { worktree: { id: "repo::/tmp/wt", path: "/tmp/wt" } },
        }),
        stderr: "",
      };
    };
  const result = await createWorktree("/tmp", {
    name: "task-name",
    base: "a".repeat(40),
    executable: "orca-test",
    execute,
  });
  assert.equal(result.worktree.id, "repo::/tmp/wt");
  const create = calls.at(-1);
  assert.deepEqual(create.slice(0, 7), [
    "orca-test",
    "worktree",
    "create",
    "--name",
    "task-name",
    "--parent-worktree",
    "active",
  ]);
});
test("workflow schedules only dependency-ready tasks and requires reconciliation before restart", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  const a = {
    ...structuredClone(taskV2),
    id: "task-a",
    risk: "low",
    acceptance: [
      {
        id: "a-check",
        description: "A passes",
        method: "check",
        checkIndexes: [0],
      },
    ],
    reviewRequirements: [],
  };
  const b = {
    ...structuredClone(a),
    id: "task-b",
    acceptance: [
      {
        id: "b-check",
        description: "B passes",
        method: "check",
        checkIndexes: [0],
      },
    ],
    dependencies: [
      { taskId: "task-a", revision: 1, acceptedResult: "accept-a" },
    ],
  };
  writeJSON(path.join(dir, "a.json"), a);
  writeJSON(path.join(dir, "b.json"), b);
  const request = {
    schemaVersion: 1,
    id: "workflow-deps",
    goal: "Complete A then B",
    repo: ".",
    tasks: [
      { file: "a.json", role: "intern" },
      { file: "b.json", role: "intern" },
    ],
    policy: { maxRunning: 2, maxReviewPending: 2 },
    budget: { maxAttempts: 3, maxCalls: 6 },
  };
  await createWorkflow(stateDir, request, clone(), dir);
  const first = resumeWorkflow(stateDir, request.id, 1);
  assert.deepEqual(
    first.actions.map((action) => action.taskId),
    ["task-a"],
  );
  const receipt = {
    executionId: "exec-a",
    runId: "run-a",
    taskId: "orca-task-a",
    dispatchId: "dispatch-a",
    worktreeId: "worktree-a",
  };
  attachExecution(stateDir, request.id, 2, {
    schemaVersion: 1,
    eventId: "attach-a",
    attemptId: "attempt-a",
    taskId: "task-a",
    receipt,
  });
  const waiting = resumeWorkflow(stateDir, request.id, 3);
  assert.equal(waiting.actions[0].type, "reconcile-required");
  assert.equal(waiting.actions[0].attemptId, "attempt-a");
  const observed = resumeWorkflow(stateDir, request.id, 4, {
    "attempt-a": {
      executionId: "exec-a",
      status: "settled",
      eventId: "observed-a",
      callsUsed: 1,
    },
  });
  assert.equal(observed.state.tasks["task-a"].state, "submitted");
  assert.equal(observed.state.budget.callsUsed, 1);
  const frozenA = readWorkflow(stateDir, request.id).tasks["task-a"];
  fs.mkdirSync(path.join(stateDir, "gates"), { recursive: true });
  writeJSON(path.join(stateDir, "gates", "task-a.json"), {
    runId: "exec-a",
    state: "accepted",
    gates: {
      "contract-ready": { taskHash: taskHash(frozenA) },
      "outcome-accepted": { decisionId: "accept-a" },
    },
  });
  const unlocked = resumeWorkflow(stateDir, request.id, 5);
  assert.equal(unlocked.state.tasks["task-a"].state, "accepted");
  assert.deepEqual(
    unlocked.actions.map((action) => action.taskId),
    ["task-b"],
  );
});
test("workflow deduplicates settlements, ignores stale attempts, and enforces total call budget", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt"),
    single = { ...structuredClone(taskV2), id: "single-task" };
  writeJSON(path.join(dir, "task.json"), single);
  const request = {
    schemaVersion: 1,
    id: "workflow-events",
    goal: "Exercise event safety",
    repo: ".",
    tasks: [{ file: "task.json", role: "intern" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 2, maxCalls: 2 },
  };
  await createWorkflow(stateDir, request, clone(), dir);
  resumeWorkflow(stateDir, request.id, 1);
  const receipt = {
    executionId: "exec-1",
    runId: "run-1",
    taskId: "orca-task-1",
    dispatchId: "dispatch-1",
    worktreeId: "wt-1",
  };
  attachExecution(stateDir, request.id, 2, {
    schemaVersion: 1,
    eventId: "attach-1",
    attemptId: "attempt-1",
    taskId: "single-task",
    receipt,
  });
  const attachReplay = attachExecution(stateDir, request.id, 2, {
    schemaVersion: 1,
    eventId: "attach-1",
    attemptId: "attempt-1",
    taskId: "single-task",
    receipt,
  });
  assert.equal(attachReplay.duplicate, true);
  const stale = recordSettlement(stateDir, request.id, 3, {
    schemaVersion: 1,
    eventId: "late-old",
    attemptId: "attempt-old",
    taskId: "single-task",
    executionId: "exec-old",
    outcome: "settled",
    callsUsed: 0,
  });
  assert.equal(stale.stale, true);
  const settled = recordSettlement(stateDir, request.id, 4, {
    schemaVersion: 1,
    eventId: "settle-1",
    attemptId: "attempt-1",
    taskId: "single-task",
    executionId: "exec-1",
    outcome: "settled",
    callsUsed: 2,
  });
  assert.equal(settled.state.budget.callsUsed, 2);
  const duplicate = recordSettlement(stateDir, request.id, 4, {
    schemaVersion: 1,
    eventId: "settle-1",
    attemptId: "attempt-1",
    taskId: "single-task",
    executionId: "exec-1",
    outcome: "settled",
    callsUsed: 2,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(readWorkflow(stateDir, request.id).state.revision, 5);
});
test("workflow rejects dependency cycles and avoids parallel shared-contract conflicts", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt"),
    sha = "a".repeat(64);
  const a = {
    ...structuredClone(taskV2),
    id: "conflict-a",
    contractRefs: [{ path: "shared.md", sha256: sha }],
    dependencies: [],
  };
  const b = {
    ...structuredClone(taskV2),
    id: "conflict-b",
    contractRefs: [{ path: "shared.md", sha256: sha }],
    dependencies: [],
  };
  writeJSON(path.join(dir, "a.json"), a);
  writeJSON(path.join(dir, "b.json"), b);
  const request = {
    schemaVersion: 1,
    id: "workflow-conflict",
    goal: "Serialize shared contract work",
    repo: ".",
    tasks: [
      { file: "a.json", role: "intern" },
      { file: "b.json", role: "intern" },
    ],
    policy: { maxRunning: 2, maxReviewPending: 2 },
    budget: { maxAttempts: 3, maxCalls: 5 },
  };
  await createWorkflow(stateDir, request, clone(), dir);
  assert.equal(
    resumeWorkflow(stateDir, request.id, 1).actions.filter(
      (action) => action.type === "dispatch-ready",
    ).length,
    1,
  );
  const cycleA = {
      ...a,
      id: "cycle-a",
      dependencies: [
        { taskId: "cycle-b", revision: 1, acceptedResult: "accept-b" },
      ],
    },
    cycleB = {
      ...b,
      id: "cycle-b",
      dependencies: [
        { taskId: "cycle-a", revision: 1, acceptedResult: "accept-a" },
      ],
    };
  writeJSON(path.join(dir, "ca.json"), cycleA);
  writeJSON(path.join(dir, "cb.json"), cycleB);
  const cycle = {
    ...request,
    id: "workflow-cycle",
    tasks: [
      { file: "ca.json", role: "intern" },
      { file: "cb.json", role: "intern" },
    ],
  };
  await assert.rejects(
    () => createWorkflow(stateDir, cycle, clone(), dir),
    /cycle/,
  );
});
test("workflow offers independent tasks together within role and workflow limits", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt");
  fs.writeFileSync(path.join(dir, "a.txt"), "a");
  fs.writeFileSync(path.join(dir, "b.txt"), "b");
  const a = {
    ...structuredClone(taskV2),
    id: "independent-a",
    files: ["a.txt"],
    acceptance: [
      {
        id: "a-check",
        description: "A is checked",
        method: "check",
        checkIndexes: [0],
      },
    ],
    reviewRequirements: [],
  };
  const b = {
    ...structuredClone(a),
    id: "independent-b",
    files: ["b.txt"],
    acceptance: [
      {
        id: "b-check",
        description: "B is checked",
        method: "check",
        checkIndexes: [0],
      },
    ],
  };
  writeJSON(path.join(dir, "a.json"), a);
  writeJSON(path.join(dir, "b.json"), b);
  const request = {
    schemaVersion: 1,
    id: "workflow-independent",
    goal: "Run independent tasks together",
    repo: ".",
    tasks: [
      { file: "a.json", role: "intern" },
      { file: "b.json", role: "intern" },
    ],
    policy: { maxRunning: 2, maxReviewPending: 2 },
    budget: { maxAttempts: 2, maxCalls: 4 },
  };
  await createWorkflow(stateDir, request, clone(), dir);
  assert.deepEqual(
    resumeWorkflow(stateDir, request.id, 1).actions.map(
      (action) => action.taskId,
    ),
    ["independent-a", "independent-b"],
  );
});
test("failure routing uses deterministic signals and does not retry ambiguous work unchanged", () => {
  assert.equal(
    classifyFailure({
      message: "request timed out",
      evidence: "run.log",
      timedOut: true,
    }).category,
    "process-unknown",
  );
  assert.equal(
    classifyFailure({
      message: "contradictory requirement",
      evidence: "request.md",
      kind: "requirement",
    }).nextOwner,
    "pm",
  );
  assert.equal(
    classifyFailure({
      message: "fixture missing",
      evidence: "check.log",
      kind: "environment",
    }).action,
    "repair-environment",
  );
  assert.equal(
    classifyFailure({
      message: "tests failed",
      evidence: "check.log",
      checkFailed: true,
    }).category,
    "implementation-error",
  );
  assert.equal(
    classifyFailure({ message: "unrecognized failure", evidence: "run.log" })
      .nextOwner,
    "senior",
  );
});
test("workflow retry preserves attempts and cumulative budget", async (t) => {
  const dir = await repo(t),
    stateDir = path.join(dir, ".omt"),
    single = { ...structuredClone(taskV2), id: "retry-task" };
  writeJSON(path.join(dir, "task.json"), single);
  const request = {
    schemaVersion: 1,
    id: "workflow-retry",
    goal: "Retry with preserved history",
    repo: ".",
    tasks: [{ file: "task.json", role: "intern" }],
    policy: { maxRunning: 1, maxReviewPending: 1 },
    budget: { maxAttempts: 2, maxCalls: 3 },
  };
  await createWorkflow(stateDir, request, clone(), dir);
  resumeWorkflow(stateDir, request.id, 1);
  const receipt1 = {
    executionId: "exec-r1",
    runId: "run-r1",
    taskId: "orca-r1",
    dispatchId: "dispatch-r1",
    worktreeId: "wt-r1",
  };
  attachExecution(stateDir, request.id, 2, {
    schemaVersion: 1,
    eventId: "attach-r1",
    attemptId: "attempt-r1",
    taskId: "retry-task",
    receipt: receipt1,
  });
  recordSettlement(stateDir, request.id, 3, {
    schemaVersion: 1,
    eventId: "settle-r1",
    attemptId: "attempt-r1",
    taskId: "retry-task",
    executionId: "exec-r1",
    outcome: "failed",
    callsUsed: 1,
    failure: {
      message: "implementation test failed",
      evidence: "runs/r1/check.log",
      checkFailed: true,
    },
  });
  const retried = retryTask(stateDir, request.id, 4, {
    schemaVersion: 1,
    eventId: "retry-r1",
    taskId: "retry-task",
    resolvedBy: "junior",
    resolution: "Corrected the boundary logic",
    evidence: "review/fix-1.md",
  });
  assert.equal(retried.budget.callsUsed, 1);
  assert.equal(retried.budget.attemptsUsed, 1);
  assert.equal(retried.tasks["retry-task"].attempts.length, 1);
  assert.equal(retried.tasks["retry-task"].rework[0].fromAttempt, "attempt-r1");
  resumeWorkflow(stateDir, request.id, 5);
  const receipt2 = {
    executionId: "exec-r2",
    runId: "run-r2",
    taskId: "orca-r2",
    dispatchId: "dispatch-r2",
    worktreeId: "wt-r2",
  };
  const second = attachExecution(stateDir, request.id, 6, {
    schemaVersion: 1,
    eventId: "attach-r2",
    attemptId: "attempt-r2",
    taskId: "retry-task",
    receipt: receipt2,
  });
  assert.equal(second.budget.attemptsUsed, 2);
  assert.equal(second.tasks["retry-task"].attempts.length, 2);
});
test("lesson candidates are deduplicated and never auto-promoted", (t) => {
  const stateDir = path.join(fixture(t), ".omt"),
    lesson = {
      schemaVersion: 1,
      failureCategory: "implementation-error",
      failureEvidence: "runs/r1/check.log",
      resolution: "Added a boundary regression test",
      reproduction: "Run node --test boundary.test.mjs",
      target: "organization-eval",
      owner: "senior",
    };
  const first = recordLessonCandidate(stateDir, lesson),
    second = recordLessonCandidate(stateDir, lesson);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(readJSON(first.file).status, "candidate");
});
test("incident adapter deduplicates events and never grants deployment authority", (t) => {
  const stateDir = path.join(fixture(t), ".omt"),
    now = Date.parse("2026-09-14T00:00:00Z");
  const config = {
    schemaVersion: 1,
    enabled: true,
    maxOpen: 2,
    maxProposalsPerWindow: 2,
    windowMs: 3600000,
    observationMs: 60000,
    noProgressLimit: 2,
  };
  const event = {
    schemaVersion: 1,
    source: "tracker",
    externalId: "issue-1",
    dedupeKey: "service:expiry",
    summary: "Expiry failed",
    evidence: "tracker/issue-1",
    observedAt: "2026-09-14T00:00:00Z",
  };
  const first = ingestIncident(stateDir, event, config, now),
    duplicate = ingestIncident(
      stateDir,
      { ...event, externalId: "issue-2" },
      config,
      now + 1,
    );
  assert.equal(first.incident.status, "proposed");
  assert.equal(first.incident.proposal.deploymentAuthorized, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(Object.keys(incidentStatus(stateDir).incidents).length, 1);
});
test("incident kill switch, observation window, and no-progress limit stop unsafe loops", (t) => {
  const stateDir = path.join(fixture(t), ".omt"),
    now = Date.parse("2026-09-14T00:00:00Z");
  const config = {
    schemaVersion: 1,
    enabled: false,
    maxOpen: 1,
    maxProposalsPerWindow: 1,
    windowMs: 3600000,
    observationMs: 60000,
    noProgressLimit: 2,
  };
  const event = {
    schemaVersion: 1,
    source: "alert",
    externalId: "alert-1",
    dedupeKey: "service:latency",
    summary: "Latency alert",
    evidence: "alerts/1",
    observedAt: "2026-09-14T00:00:00Z",
  };
  assert.equal(
    ingestIncident(stateDir, event, config, now).incident.holdReason,
    "kill-switch",
  );
  const enabled = { ...config, enabled: true },
    active = ingestIncident(
      stateDir,
      { ...event, externalId: "alert-2", dedupeKey: "service:error" },
      enabled,
      now,
    ).incident;
  assert.equal(
    observeIncident(
      stateDir,
      {
        incidentId: active.id,
        eventId: "obs-1",
        outcome: "resolved",
        evidence: "checks/pass",
        observedAt: "2026-09-14T00:00:30Z",
      },
      enabled,
    ).incident.status,
    "observing",
  );
  assert.equal(
    observeIncident(
      stateDir,
      {
        incidentId: active.id,
        eventId: "obs-2",
        outcome: "no-progress",
        evidence: "checks/still-failing",
        observedAt: "2026-09-14T00:01:10Z",
      },
      enabled,
    ).incident.status,
    "observing",
  );
  assert.equal(
    observeIncident(
      stateDir,
      {
        incidentId: active.id,
        eventId: "obs-3",
        outcome: "no-progress",
        evidence: "checks/still-failing-2",
        observedAt: "2026-09-14T00:02:10Z",
      },
      enabled,
    ).incident.status,
    "stopped",
  );
});
test("routing experiment evaluators are deterministic and model calls require explicit confirmation", async (t) => {
  const dir = fixture(t),
    narrow = routingFixtures.find((item) => item.id === "narrow-edit"),
    general = routingFixtures.find(
      (item) => item.id === "general-implementation",
    );
  assert.equal(
    (await evaluateRoutingFixture(narrow, { answer: "now >= expiresAt" }, dir))
      .passed,
    true,
  );
  assert.equal(
    (await evaluateRoutingFixture(narrow, { answer: "now > expiresAt" }, dir))
      .passed,
    false,
  );
  assert.equal(
    (
      await evaluateRoutingFixture(
        narrow,
        {
          answer: "현재 시각(current time) >= 만료 시각(expiry time)이면 만료",
        },
        dir,
      )
    ).passed,
    true,
  );
  const valid =
    "export function parseRetries(value){if(typeof value!=='string'||!/^[0-5]$/.test(value))return null;return Number(value)}";
  assert.equal(
    (await evaluateRoutingFixture(general, { code: valid }, dir)).passed,
    true,
  );
  const refused = await run(
    [
      process.execPath,
      "experiments/run-routing.mjs",
      "--mode",
      "balanced",
      "--max-calls",
      "6",
    ],
    { cwd: path.resolve(".") },
  );
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /confirm-subscription-use/);
  const dry = await run(
    [
      process.execPath,
      "experiments/run-routing.mjs",
      "--mode",
      "balanced",
      "--max-calls",
      "6",
      "--dry-run",
    ],
    { cwd: path.resolve(".") },
  );
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).subscriptionCallsStarted, false);
});
test("routing summary requires matched quality and keeps recommendations provisional", () => {
  const records = (tokens, model) =>
    routingFixtures.map((fixture) => ({
      fixture: fixture.id,
      requestedModel: model,
      evaluation: { passed: true },
      usage: { total_tokens: tokens },
      elapsedMs: tokens,
    }));
  const e1 = {
    status: "complete",
    mode: "e1",
    plannedCalls: 3,
    actualCalls: 3,
    records: [
      {
        fixture: "narrow-edit",
        requestedModel: "gpt-oss-120b-medium",
        evaluation: { passed: true },
        usage: { total_tokens: 10 },
        elapsedMs: 10,
      },
      {
        fixture: "regression-review",
        requestedModel: "gpt-oss-120b-medium",
        evaluation: { passed: false },
        usage: { total_tokens: 10 },
        elapsedMs: 10,
      },
      {
        fixture: "regression-review",
        requestedModel: "claude-opus-4-6-thinking",
        evaluation: { passed: true },
        usage: { total_tokens: 10 },
        elapsedMs: 10,
      },
    ],
  };
  const summary = summarizeRouting([
    e1,
    {
      status: "complete",
      mode: "opus-first",
      plannedCalls: 6,
      actualCalls: 6,
      records: records(100, "claude-opus-4-6-thinking"),
    },
    {
      status: "complete",
      mode: "balanced",
      plannedCalls: 6,
      actualCalls: 6,
      records: records(80, "mixed"),
    },
  ]);
  assert.equal(summary.recommendation.preset, "balanced");
  assert.equal(summary.recommendation.status, "provisional");
  assert.deepEqual(summary.gptOssKeep, ["narrow-edit"]);
  assert.equal(summary.runs[0].quota.attributable, false);
});
test("quota snapshots expire and mixed activity or reset windows are not attributable", (t) => {
  const stateDir = path.join(fixture(t), ".omt"),
    before = {
      schemaVersion: 1,
      poolId: "agy-shared",
      accountProfile: "current",
      observedAt: "2026-09-14T00:00:00Z",
      source: "user-snapshot",
      windows: [
        {
          kind: "weekly",
          remainingPercent: 90,
          resetAt: "2026-09-20T00:00:00Z",
        },
        {
          kind: "five-hour",
          remainingPercent: 80,
          resetAt: "2026-09-14T05:00:00Z",
        },
      ],
      otherActivity: "none",
    };
  const after = {
    ...structuredClone(before),
    observedAt: "2026-09-14T00:10:00Z",
    windows: [
      { kind: "weekly", remainingPercent: 89, resetAt: "2026-09-20T00:00:00Z" },
      {
        kind: "five-hour",
        remainingPercent: 78,
        resetAt: "2026-09-14T05:00:00Z",
      },
    ],
  };
  assert.deepEqual(compareQuotaSnapshots(before, after).consumption, {
    weekly: 1,
    "five-hour": 2,
  });
  assert.equal(
    compareQuotaSnapshots(before, { ...after, otherActivity: "unknown" })
      .attributable,
    false,
  );
  const reset = structuredClone(after);
  reset.windows[1].resetAt = "2026-09-14T10:00:00Z";
  assert.equal(
    compareQuotaSnapshots(before, reset).reasons.includes(
      "window-reset:five-hour",
    ),
    true,
  );
  assert.equal(
    quotaStatus(before, {
      now: Date.parse("2026-09-14T02:00:00Z"),
      maxAgeMs: 3600000,
    }).reason,
    "stale-snapshot",
  );
  recordQuotaSnapshot(stateDir, before);
  assert.equal(
    latestQuotaSnapshots(stateDir)["agy-shared"].observedAt,
    before.observedAt,
  );
});

test("CLI report parsing distinguishes a single gate report from aggregate reports", () => {
  assert.equal(
    parseArgs(["gate-check", "--report", "one.json"]).report,
    "one.json",
  );
  assert.deepEqual(
    parseArgs(["aggregate", "--report", "one.json", "--report", "two.json"])
      .report,
    ["one.json", "two.json"],
  );
  assert.throws(
    () =>
      parseArgs(["gate-check", "--report", "one.json", "--report", "two.json"]),
    /Duplicate option/,
  );
});

test("installer planning verifies versions before reversible legacy migration", () => {
  const options = parseInstallArgs(["both"]);
  const claudePayload = [
    { id: "oh-my-teams@oh-my-teams", version: "1.1.0", enabled: true },
    { id: "orca@orca-skills", version: "0.6.1", enabled: true },
  ];
  const codexPayload = {
    installed: [
      {
        pluginId: "oh-my-teams@oh-my-teams",
        version: "1.2.0",
        installed: true,
        enabled: true,
      },
    ],
  };
  const plan = buildInstallPlan(options, "/repo", "1.2.0", {
    claude: pluginStates("claude", claudePayload),
    codex: pluginStates("codex", codexPayload),
  });
  assert.deepEqual(plan.clients.claude.actions, [
    "update-oh-my-teams",
    "disable-legacy-after-new-install-verification",
  ]);
  assert.equal(plan.clients.codex.newCurrent, true);
  assert.throws(() => parseInstallArgs(["claude", "codex"]), /only one/);
});
test("assistant answers that cite another tree are rejected, not stored", async (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "source.txt"), "alpha\nbeta\n");
  const stateDir = path.join(dir, ".omt");
  const groundedTask = {
    ...task,
    id: "grounding",
    instruction: "Find the beta line",
    files: ["source.txt"],
    checks: [[process.execPath, "--version"]],
  };
  const answer = (citations) =>
    assist(dir, clone(), groundedTask, {
      role: "pm",
      kind: "research",
      stateDir,
      call: async () =>
        response({ summary: "s", items: ["i"], citations }),
    });

  await assert.rejects(
    () => answer([{ file: "docs/architecture/overview.md", line: 1, quote: "x" }]),
    /do not exist in this workspace/,
  );
  await assert.rejects(
    () => answer([{ file: "source.txt", line: 2, quote: "invented" }]),
    /do not exist in this workspace/,
  );
  await assert.rejects(() => answer([]), /no source citation/);
  assert.equal(fs.existsSync(path.join(stateDir, "assists")), false);

  const accepted = await answer([
    { file: "source.txt", line: 2, quote: "beta" },
  ]);
  assert.deepEqual(accepted.grounding, {
    total: 1,
    verified: 1,
    unverified: 0,
    grounded: true,
  });
  assert.equal(accepted.workspace.repo, path.resolve(dir));
  assert.equal(accepted.workspace.head, null);
});
test("a read-only answer binds the Git head of the workspace it ran against", async (t) => {
  const dir = await repo(t);
  fs.writeFileSync(path.join(dir, "source.txt"), "alpha\nbeta\n");
  const bound = await draft(
    dir,
    clone(),
    {
      ...task,
      id: "binding",
      files: ["source.txt"],
      checks: [[process.execPath, "--version"]],
    },
    {
      call: async () =>
        response({
          citations: [{ file: "source.txt", line: 2, quote: "beta" }],
        }),
    },
  );
  assert.equal(bound.workspace.repo, path.resolve(dir));
  assert.match(bound.workspace.head, /^[0-9a-f]{40}$/);
  assert.deepEqual(await workspaceBinding(dir), bound.workspace);
});
test("a provider answering from another model is refused and left auditable", async (t) => {
  assert.equal(
    modelBinding({ model: "a" }, { effectiveModel: "b" }).status,
    "mismatched",
  );
  assert.equal(
    modelBinding({ model: "a" }, { effectiveModel: "a" }).status,
    "matched",
  );
  assert.equal(modelBinding({ model: "a" }, {}).status, "unproven");
  assert.equal(modelBinding({}, { effectiveModel: "b" }).status, "unrequested");

  const dir = await repo(t);
  const result = await work(dir, clone(), task, {
    stateDir: path.join(dir, ".omt"),
    call: async () =>
      response(
        { edits: [] },
        { effectiveModel: "gemini-flash-3-8", modelBinding: undefined },
      ),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.calls.length, 1);
  assert.ok(result.calls[0].requestedModel);
  assert.notEqual(result.calls[0].requestedModel, "gemini-flash-3-8");
  assert.equal(result.calls[0].effectiveModel, "gemini-flash-3-8");
  assert.equal(result.calls[0].modelProof, "mismatched");
  assert.match(result.issues[0], /answered from gemini-flash-3-8/);
  assert.equal(
    fs.readFileSync(path.join(dir, "value.txt"), "utf8"),
    "wrong\n",
  );
});
test("ungrounded and misrouted answers route to workspace rebinding", () => {
  for (const input of [
    { kind: "workspace-context" },
    { grounded: false },
    { message: "Assistant cited 2 of 3 lines that do not exist in this workspace" },
    { message: "Provider answered from x; routing evidence is invalid" },
  ]) {
    assert.deepEqual(classifyFailure(input), {
      category: "environment-context",
      nextOwner: "pl",
      action: "rebind-workspace",
      retryable: true,
    });
  }
  assert.equal(
    classifyFailure({ kind: "environment" }).category,
    "environment-failure",
  );
  assert.deepEqual(citationGrounding([]), {
    total: 0,
    verified: 0,
    unverified: 0,
    grounded: false,
  });
});
