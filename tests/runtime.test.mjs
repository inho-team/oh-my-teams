/** End-to-end and unit regression coverage for the oh my teams runtime. */
import { after } from "node:test";
import { getTemplateRepo, cleanupTemplates } from "./template-factory.mjs";
after(() => cleanupTemplates());
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROVIDER_EFFORTS,
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
  capacityResetHint,
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
  fs.cpSync(await getTemplateRepo(), dir, { recursive: true });
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
  assert.ok(chart(validateOrg(clone())).includes("JUNIOR"));
  const cycle = clone();
  cycle.roles.pl.parent = "junior";
  assert.throws(() => validateOrg(cycle), /cycle/);
  const bad = clone();
  bad.roles.junior.profile = "missing";
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
  assert.deepEqual(Object.keys(org.roles), ["pm", "pl", "senior", "junior"]);
  assert.deepEqual(
    ["pm", "pl", "senior", "junior"].map((role) => org.roles[role].concurrency),
    // Every Agy role draws on one shared quota pool, so the shipped default
    // holds a single slot each and extra parallelism is opted into per team.
    [1, 1, 1, 1],
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
  assert.ok(
    Object.values(org.profiles).some(
      (profile) => profile.model === "gpt-oss-120b-medium",
    ),
  );
  assert.deepEqual(Object.keys(org.assistants), [
    "pm",
    "pl",
    "senior",
    "junior",
  ]);
  for (const role of ["pm", "pl", "senior", "junior"]) {
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
  for (const role of ["pm", "pl", "senior", "junior"]) {
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
    assert.equal(
      report.logHash,
      hash(
        `${JSON.stringify({
          summary: "Found beta",
          items: ["beta is present"],
          citations: [{ file: "source.txt", line: 2, quote: "beta" }],
        })}\n`,
      ),
    );
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
test("a profile without effort sends no effort argument to any provider", () => {
  for (const provider of ["agy", "claude", "codex"]) {
    const spec = providerCommand(
      { provider, command: [provider], model: "specific-id" },
      "/tmp/task",
      "prompt",
    );
    assert.ok(!spec.argv.includes("--effort"));
    assert.ok(!spec.argv.some((v) => v.startsWith("model_reasoning_effort")));
  }
});
test("each provider carries reasoning effort in its own verified CLI syntax", () => {
  // `agy --help` (1.2.3) documents `--effort`; `codex exec --help` (0.154.0)
  // has no such flag, so the level travels as a `-c` config override.
  const agy = providerCommand(
    {
      provider: "agy",
      command: ["agy"],
      model: "gemini-3.8-flash-high",
      effort: "high",
    },
    "/tmp/task",
    "prompt",
  );
  assert.equal(agy.argv[agy.argv.indexOf("--effort") + 1], "high");

  // `claude --help` (2.1.273) documents `--effort` with five levels.
  const claude = providerCommand(
    { provider: "claude", command: ["claude"], model: null, effort: "xhigh" },
    "/tmp/task",
    "prompt",
  );
  assert.equal(claude.argv[claude.argv.indexOf("--effort") + 1], "xhigh");

  const codex = providerCommand(
    {
      provider: "codex",
      command: ["codex"],
      model: "gpt-5.6-terra",
      effort: "xhigh",
    },
    "/tmp/task",
    "prompt",
  );
  const override = codex.argv[codex.argv.indexOf("--config") + 1];
  assert.equal(override, "model_reasoning_effort=xhigh");
  assert.ok(!codex.argv.includes("--effort"));
  // `-c` is `--continue` on the Agy CLI, so the short form must not appear.
  assert.ok(!codex.argv.includes("-c"));
  assert.ok(codex.argv.indexOf("--config") > codex.argv.indexOf("exec"));
});
test("an effort the provider cannot select fails instead of running at another depth", () => {
  assert.throws(
    () =>
      providerCommand(
        {
          provider: "claude",
          command: ["claude"],
          model: null,
          effort: "ultra",
        },
        "/tmp/task",
        "prompt",
      ),
    /cannot select effort/,
  );
  assert.throws(
    () =>
      providerCommand(
        {
          provider: "agy",
          command: ["agy"],
          model: "gpt-oss-120b-medium",
          effort: "xhigh",
        },
        "/tmp/task",
        "prompt",
      ),
    /cannot select effort/,
  );
  assert.deepEqual(PROVIDER_EFFORTS.claude, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.ok(!PROVIDER_EFFORTS.agy.includes("xhigh"));
  assert.ok(PROVIDER_EFFORTS.codex.includes("ultra"));
});
test("organization validation narrows effort per provider and rejects a self-contradicting Agy profile", () => {
  const org = clone();
  org.profiles["codex-terra"].effort = "ultra";
  validateOrg(org);

  const unsupported = clone();
  // Claude accepts five levels; `ultra` is Codex's alone.
  unsupported.profiles["claude-current"].effort = "ultra";
  assert.throws(() => validateOrg(unsupported), /must be one of/);

  const tooDeep = clone();
  tooDeep.profiles["agy-flash"].effort = "xhigh";
  assert.throws(() => validateOrg(tooDeep), /must be one of low\|medium\|high/);

  // `gemini-3.8-flash-high` already names its level, so `low` would leave the
  // report claiming a depth the call did not use.
  const contradicting = clone();
  contradicting.profiles["agy-flash"].effort = "low";
  assert.throws(() => validateOrg(contradicting), /contradicts model/);

  // Agy Claude model IDs carry no level suffix, so they stay unconstrained.
  const unsuffixed = clone();
  unsuffixed.profiles["agy-opus"].effort = "low";
  validateOrg(unsuffixed);
});
test("the example organization offers every listed Codex model as its own profile", () => {
  const codex = Object.values(example.profiles)
    .filter((profile) => profile.provider === "codex")
    .map((profile) => profile.model);
  for (const model of ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"]) {
    assert.ok(codex.includes(model), `example must offer ${model}`);
  }
});
test("the organization chart states the effort each role actually runs at", () => {
  const org = clone();
  assert.match(chart(org), /PL: codex-current .* effort=provider-default/);

  org.profiles["codex-current"].effort = "high";
  assert.match(chart(org), /PL: codex-current .* effort=high/);
});
test("no bound profile in the example changes the effort the call used to run at", () => {
  // Adding the field must not silently deepen an existing organization's calls,
  // so every profile a role actually binds still sends no effort argument.
  for (const role of Object.values(example.roles)) {
    assert.equal(example.profiles[role.profile].effort, undefined);
  }
});
test("failed OSS output promotes once to configured fallback and preserves org snapshot", async (t) => {
  const dir = await repo(t),
    org = clone();
  org.roles.junior.profile = "agy-oss";
  org.roles.junior.fallbacks = ["agy-sonnet"];
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
  retryOrg.roles.junior.profile = "agy-oss";
  retryOrg.roles.junior.fallbacks = ["agy-sonnet"];
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
  org.roles.junior.concurrency = 1;
  const stateDir = path.join(dir, ".omt");
  fs.mkdirSync(path.join(stateDir, "slots"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "slots", "junior-0.lock"), "owned");
  await assert.rejects(
    () => work(dir, org, task, { stateDir, call: async () => response({}) }),
    /occupied/,
  );
});
test("timed-out provider retains the slot and does not start fallback", async (t) => {
  const dir = await repo(t),
    org = clone();
  org.roles.junior.concurrency = 1;
  const stateDir = path.join(dir, ".omt");
  const result = await work(dir, org, task, {
    stateDir,
    call: async () => response({}, { timedOut: true, pid: 123 }),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.calls.length, 1);
  assert.ok(fs.existsSync(path.join(stateDir, "slots", "junior-0.lock")));
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
// Captured verbatim from agy 1.2.2 against a genuinely exhausted Antigravity
// pool on 2026-09-15. The probe consumed zero tokens because the call is
// refused before inference. Agy reports exhaustion as a prose string with no
// structured code or scope, so the classifier cannot confirm pool scope and
// must stop on the conservative quota-unknown path instead.
const AGY_EXHAUSTED_STDOUT = JSON.stringify({
  conversation_id: "2fe57b28-e436-4b84-a719-005ebcf43efa",
  status: "ERROR",
  response: "",
  error:
    "API error (attempt 5): RESOURCE_EXHAUSTED (code 429): Individual quota " +
    "reached. Please upgrade your subscription to increase your limits. " +
    "Resets in 3h57m23s.",
  duration_seconds: 51.0886511,
  num_turns: 1,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
  },
});
test("a real Agy exhaustion response stops the call and reports its reset window", async () => {
  const result = await invoke(
    {
      provider: "agy",
      command: ["agy"],
      model: "gpt-oss-120b-medium",
      pool: "agy-shared",
    },
    ".",
    "prompt",
    60000,
    async () => ({ code: 0, stdout: AGY_EXHAUSTED_STDOUT, stderr: "" }),
  );
  assert.equal(result.failureClass, "quota-unknown");
  assert.equal(result.exhausted, true);
  // Prose-only exhaustion never proves pool scope, so the runtime must not
  // claim it and must not keep probing other members of the same pool.
  assert.notEqual(result.failureClass, "pool-exhausted");
  assert.equal(result.capacityResetsIn, "3h57m23s");
  assert.equal(result.usage.total_tokens, 0);
});
test("a reset window is read only from a response the provider marked failed", () => {
  const answer = JSON.stringify({
    result: "The retry banner should read: resets in 9h9m.",
  });
  assert.equal(
    capacityResetHint(
      { code: 0, stdout: answer, stderr: "" },
      decodeOutput(answer),
    ),
    null,
  );
  assert.equal(
    capacityResetHint(
      { code: 0, stdout: AGY_EXHAUSTED_STDOUT, stderr: "" },
      decodeOutput(AGY_EXHAUSTED_STDOUT),
    ),
    "3h57m23s",
  );
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
    ["senior", "junior"],
  );
  assert.equal(balanced.organization.roles.pm.profile, org.roles.pm.profile);
  assert.equal(balanced.organization.roles.pl.profile, org.roles.pl.profile);
  assert.equal(balanced.organization.roles.senior.profile, "agy-opus");
  assert.equal(balanced.organization.roles.junior.profile, "agy-sonnet");
});
test("presets pin one slot per shared-pool role and keep each fallback chain to what they name", () => {
  const org = clone();
  for (const name of ["balanced", "opus-first"]) {
    const preview = previewPreset(org, name);
    assert.equal(preview.organization.roles.intern, undefined);
    for (const role of ["senior", "junior"]) {
      assert.equal(
        preview.organization.roles[role].concurrency,
        1,
        `${name}/${role} must hold a single shared-pool slot`,
      );
    }
  }
  // Balanced escalates Sonnet implementation to Opus once and nothing further;
  // Opus judgment and opus-first have no fallback to spend another quota on.
  const balanced = previewPreset(org, "balanced").organization.roles;
  assert.deepEqual(balanced.junior.fallbacks, ["agy-opus"]);
  assert.deepEqual(balanced.senior.fallbacks, []);
  const opusFirst = previewPreset(org, "opus-first").organization.roles;
  assert.deepEqual(opusFirst.senior.fallbacks, []);
  assert.deepEqual(opusFirst.junior.fallbacks, []);
});
test("presets lacking provider metadata throw when generating model or tier changes", async () => {
  const org = clone();
  const { PRESETS } =
    await import("../plugins/oh-my-teams/scripts/presets.mjs");

  for (const [name, preset] of Object.entries(PRESETS)) {
    if (preset.kind === "models" || preset.kind === "tiers") {
      assert.ok(preset.provider, `Preset ${name} missing provider metadata`);
    }
  }

  const original = PRESETS["opus-first"].provider;
  PRESETS["opus-first"].provider = undefined;
  assert.throws(
    () => previewPreset(org, "opus-first"),
    /Preset missing provider metadata/,
  );
  PRESETS["opus-first"].provider = original;
});
test("presets match provider as well as model to prevent Claude Code profiles from masking Agy profiles", () => {
  const org = clone();
  org.profiles["claude-opus-spoof"] = {
    provider: "claude",
    command: ["claude", "--profile", "test"],
    model: "claude-opus-4-6-thinking",
    account: "test",
    subscription: "test",
    concurrency: 1,
  };
  org.profiles["claude-sonnet-spoof"] = {
    provider: "claude",
    command: ["claude", "--profile", "test"],
    model: "claude-sonnet-4-6",
    account: "test",
    subscription: "test",
    concurrency: 1,
  };

  const opusFirst = previewPreset(org, "opus-first").organization;
  assert.equal(opusFirst.roles.senior.profile, "agy-opus");
  assert.equal(opusFirst.roles.junior.profile, "agy-opus");

  const balanced = previewPreset(org, "balanced").organization;
  assert.equal(balanced.roles.senior.profile, "agy-opus");
  assert.equal(balanced.roles.junior.profile, "agy-sonnet");
});
test("provider print timeout expires before the runtime kills the call", () => {
  for (const timeoutMs of [60000, 300000, 600000]) {
    const spec = providerCommand(
      { provider: "agy", command: ["agy"], model: "claude-opus-4-6-thinking" },
      "/tmp/task",
      "prompt",
      timeoutMs,
    );
    const seconds = Number(
      spec.argv[spec.argv.indexOf("--print-timeout") + 1].replace("s", ""),
    );
    assert.ok(
      seconds * 1000 < timeoutMs,
      `provider must self-terminate before ${timeoutMs}ms and report its usage`,
    );
  }
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
test("status reports persisted gate owner and keeps unknown usage/cost explicit", async (t) => {
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
  assert.deepEqual(
    supervisedProgressStatus({ goalStatus: "blocked", workers }),
    {
      status: "blocked",
      activeWorkers: 0,
      unverifiableWorkers: 0,
    },
  );
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
          result: { worktree: { id: "wrong", path: os.tmpdir() } },
        },
        executable: "orca",
        runtime,
      }),
    /does not match/,
  );

  // The same attachment, driven by a runtime that has no Orca receipt, no
  // discovery step and no worktree envelope. Nothing outside the adapter had
  // to learn which runtime it was.
  const localAttached = await attachWorkspace({
    parentRepo: dir,
    workspace: dir,
    stateDir,
    name: "local-task",
    runtimeName: "local",
    org: clone(),
    task: prepared.frozenTask,
    receipt: { id: "work", path: dir },
    executable: "git",
    runtime: null,
    execute: async () => ({
      code: 0,
      stdout: `${dir}\nwork`,
      stderr: "",
      timedOut: false,
    }),
  });
  assert.equal(readJSON(localAttached.record).worktree.id, "work");

  await assert.rejects(
    () =>
      attachWorkspace({
        parentRepo: dir,
        workspace: dir,
        stateDir,
        name: "local-forged",
        runtimeName: "local",
        org: clone(),
        task: prepared.frozenTask,
        receipt: { id: "work", path: dir },
        executable: "git",
        runtime: null,
        execute: async () => ({
          code: 0,
          stdout: `${dir}\nsomething-else`,
          stderr: "",
          timedOut: false,
        }),
      }),
    /does not match/,
  );

  await assert.rejects(
    () =>
      attachWorkspace({
        parentRepo: dir,
        workspace: dir,
        stateDir,
        name: "unknown-runtime",
        runtimeName: "paseo",
        org: clone(),
        task: prepared.frozenTask,
        receipt,
        executable: "orca",
        runtime,
      }),
    /Unknown execution runtime: paseo/,
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
      { file: "a.json", role: "junior" },
      { file: "b.json", role: "junior" },
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
    tasks: [{ file: "task.json", role: "junior" }],
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
      { file: "a.json", role: "junior" },
      { file: "b.json", role: "junior" },
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
      { file: "ca.json", role: "junior" },
      { file: "cb.json", role: "junior" },
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
      { file: "a.json", role: "junior" },
      { file: "b.json", role: "junior" },
    ],
    policy: { maxRunning: 2, maxReviewPending: 2 },
    budget: { maxAttempts: 2, maxCalls: 4 },
  };
  // Concurrent dispatch, not the shipped slot default, is under test, so this
  // organization opts into the second junior slot explicitly.
  const parallelOrganization = clone();
  parallelOrganization.roles.junior.concurrency = 2;
  await createWorkflow(stateDir, request, parallelOrganization, dir);
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
  assert.deepEqual(
    classifyFailure({
      message: "the execution runtime does not launch this agent",
      evidence: "start.json",
      kind: "execution-unconfigured",
    }),
    {
      category: "execution-unconfigured",
      nextOwner: "pm",
      action: "rebind-profile-agent",
      retryable: false,
    },
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
    tasks: [{ file: "task.json", role: "junior" }],
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
      call: async () => response({ summary: "s", items: ["i"], citations }),
    });

  await assert.rejects(
    () =>
      answer([{ file: "docs/architecture/overview.md", line: 1, quote: "x" }]),
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
  assert.equal(fs.readFileSync(path.join(dir, "value.txt"), "utf8"), "wrong\n");
});
test("ungrounded answers route to workspace rebinding", () => {
  // A model-binding mismatch is routed separately, by boundary-and-gate tests:
  // rebinding the workspace would leave the wrong model in place.
  for (const input of [
    { kind: "workspace-context" },
    { grounded: false },
    {
      message:
        "Assistant cited 2 of 3 lines that do not exist in this workspace",
    },
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

// ─── 이사(director) 역할 존재·보고 체계 ──────────────────────────────────────
// These tests provide evidence for the director-role eval scenario (scenarios.json).
// They verify: (1) the director skill file exists and has the required sections,
// (2) PM-and-below spec headers report to 이사, not to 사용자.
import {
  DIRECTOR_ROLE,
  ROLE_LADDER,
  ROLES,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import { roleSpec } from "../plugins/oh-my-teams/scripts/role-launch.mjs";

test("director skill exists, has authority-responsibility-limits section, and PM-and-below report to 이사", () => {
  // 1) DIRECTOR_ROLE is defined and sits above pm in ROLE_LADDER
  assert.equal(DIRECTOR_ROLE, "director");
  assert.equal(ROLE_LADDER[0], DIRECTOR_ROLE);
  assert.equal(ROLES.includes(DIRECTOR_ROLE), false);

  // 2) The director skill file contains the required 권한·책임·한계 section
  const skillPath = new URL(
    "../plugins/oh-my-teams/skills/director/SKILL.md",
    import.meta.url,
  );
  const skillContent = fs.readFileSync(skillPath, "utf8");
  assert.match(
    skillContent,
    /권한·책임·한계/,
    "director skill must have a 권한·책임·한계 section",
  );
  assert.match(
    skillContent,
    /### 권한/,
    "director skill must have a 권한 subsection",
  );
  assert.match(
    skillContent,
    /### 한계/,
    "director skill must have a 한계 subsection",
  );

  // 3) PM spec header reports to 이사, not to 사용자
  const pmSpec = roleSpec(
    readJSON(
      new URL(
        "../plugins/oh-my-teams/examples/organization.json",
        import.meta.url,
      ),
    ),
    "pm",
    "kickoff를 감독한다.",
  );
  assert.match(pmSpec, /보고 대상: 이사/);
  assert.doesNotMatch(pmSpec, /보고 대상: 사용자/);

  // 4) All PM-and-below roles include the no-direct-user-contact sentence
  const sentence = "사용자에게 직접 묻거나 보고하지 않는다.";
  const org = readJSON(
    new URL(
      "../plugins/oh-my-teams/examples/organization.json",
      import.meta.url,
    ),
  );
  for (const role of ROLES) {
    const spec = roleSpec(org, role, "작업한다.");
    assert.ok(
      spec.includes(sentence),
      `${role} spec is missing the no-direct-user-contact sentence`,
    );
  }
});
