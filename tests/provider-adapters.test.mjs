/** Covers the provider adapter registry, transports, and the Ollama adapter. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  hash,
  readJSON,
  run,
  validateOrg,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  ADAPTERS,
  PROVIDER_EFFORTS,
  PROVIDER_IDS,
  transportFor,
} from "../plugins/oh-my-teams/scripts/providers/index.mjs";
import { httpRun } from "../plugins/oh-my-teams/scripts/providers/http.mjs";
import ollama, {
  estimateTokens,
} from "../plugins/oh-my-teams/scripts/providers/ollama.mjs";
import {
  invoke,
  providerCommand,
  providerRequest,
} from "../plugins/oh-my-teams/scripts/providers.mjs";
import { work } from "../plugins/oh-my-teams/scripts/worker.mjs";

const schema = readJSON(
  new URL(
    "../plugins/oh-my-teams/schemas/organization.schema.json",
    import.meta.url,
  ),
);
const localOrg = readJSON(
  new URL(
    "../plugins/oh-my-teams/examples/organization.local-ollama.json",
    import.meta.url,
  ),
);

const httpProfile = {
  provider: "ollama",
  endpoint: "http://127.0.0.1:11434",
  account: "current",
  subscription: "Local Ollama server",
  model: "qwen3-coder:30b",
  contextTokens: 8192,
};
const cliProfile = {
  provider: "ollama",
  command: ["ollama"],
  account: "current",
  subscription: "Local Ollama CLI",
  model: "gpt-oss:20b",
  contextTokens: 8192,
};

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-provider-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the registry is the single list every other surface is derived from", () => {
  for (const [id, adapter] of Object.entries(ADAPTERS)) {
    assert.equal(adapter.id, id, `adapter ${id} disagrees with its key`);
    assert.ok(Array.isArray(adapter.transports) && adapter.transports.length);
    assert.equal(typeof adapter.request, "function");
    assert.equal(typeof adapter.decode, "function");
    assert.equal(typeof adapter.classifyFailure, "function");
    assert.equal(typeof adapter.capacityResetHint, "function");
    assert.deepEqual(PROVIDER_EFFORTS[id], adapter.efforts);
  }

  // The schema is a separate artifact that cannot import the registry, so a
  // provider added to one and not the other would be accepted by the runtime
  // and rejected by validation, or the reverse.
  assert.deepEqual(
    [...schema.$defs.profile.properties.provider.enum].sort(),
    [...PROVIDER_IDS].sort(),
  );
});

test("a profile names exactly one transport its provider can serve", () => {
  assert.equal(transportFor(httpProfile), "http");
  assert.equal(transportFor(cliProfile), "process");

  assert.throws(
    () => transportFor({ ...httpProfile, command: ["ollama"] }),
    /exactly one of command or endpoint/,
  );
  assert.throws(
    () => transportFor({ provider: "ollama", account: "current" }),
    /exactly one of command or endpoint/,
  );
  // Claude has no HTTP transport here, so an endpoint on a Claude profile is a
  // configuration error rather than a silently ignored field.
  assert.throws(
    () => transportFor({ provider: "claude", endpoint: "http://localhost" }),
    /does not support the http transport/,
  );
  assert.throws(
    () => transportFor({ provider: "vllm", command: ["vllm"] }),
    /Unsupported provider: vllm/,
  );
});

test("an Ollama profile must carry the facts routing evidence depends on", () => {
  const org = structuredClone(localOrg);
  assert.equal(validateOrg(org).name, "local-first-team");

  const cases = [
    [{ model: null }, /needs an explicit model/],
    [{ drop: "contextTokens" }, /needs contextTokens/],
    [{ contextTokens: 1024 }, /needs contextTokens/],
    [{ pool: "agy-shared" }, /draws from no shared quota pool/],
    [{ endpoint: "ftp://host/x" }, /must be an http\(s\) URL/],
    [{ env: { OLLAMA_HOST: "OMT_HOST" } }, /carries no environment/],
  ];
  for (const [patch, pattern] of cases) {
    const broken = structuredClone(localOrg);
    const { drop, ...assigned } = patch;
    Object.assign(broken.profiles["ollama-qwen-http"], assigned);
    if (drop) delete broken.profiles["ollama-qwen-http"][drop];
    assert.throws(() => validateOrg(broken), pattern, JSON.stringify(patch));
  }
});

test("an HTTP call pins the context window and demands a JSON answer", () => {
  const spec = providerRequest(httpProfile, "/repo", "do the thing", 300000);
  assert.equal(spec.transport, "http");
  assert.equal(spec.url, "http://127.0.0.1:11434/api/generate");
  assert.equal(spec.method, "POST");

  const body = JSON.parse(spec.body);
  assert.equal(body.model, "qwen3-coder:30b");
  assert.equal(body.prompt, "do the thing");
  assert.equal(body.stream, false);
  assert.equal(body.format, "json");
  // Left unset, Ollama falls back to its own default window and quietly cuts
  // the prompt down to it.
  assert.equal(body.options.num_ctx, 8192);
  assert.equal(body.think, undefined);

  const thinking = providerRequest(
    { ...httpProfile, effort: "low", keepAlive: "10m" },
    "/repo",
    "p",
    300000,
  );
  const thinkingBody = JSON.parse(thinking.body);
  assert.equal(thinkingBody.think, "low");
  assert.equal(thinkingBody.keep_alive, "10m");

  assert.throws(
    () => providerRequest({ ...httpProfile, effort: "ultra" }, "/r", "p", 1000),
    /cannot select effort ultra/,
  );
});

test("a CLI call sends the prompt through stdin, not the command line", () => {
  const wide = { ...cliProfile, contextTokens: 32768 };
  const spec = providerCommand(wide, "/repo", "a".repeat(40000), 300000);
  assert.deepEqual(spec.argv, [
    "ollama",
    "run",
    "gpt-oss:20b",
    "--hidethinking",
  ]);
  // Windows caps a command line near 32k characters, so a task prompt passed as
  // an argument would fail on exactly the largest tasks.
  assert.equal(spec.input.length, 40000);
  assert.equal(
    providerCommand({ ...wide, effort: "high" }, "/r", "p", 1000).argv[3],
    "--think",
  );

  assert.throws(
    () => providerCommand(httpProfile, "/repo", "p", 1000),
    /is not a command/,
  );
});

test("a prompt larger than the context window is refused, not truncated", () => {
  const window = 4096;
  const profile = { ...httpProfile, contextTokens: window };
  const oversized = "x".repeat(window * 3 + 3);
  assert.ok(estimateTokens(oversized) > window);
  assert.throws(
    () => providerRequest(profile, "/repo", oversized, 300000),
    /would truncate it silently/,
  );
  assert.doesNotThrow(() =>
    providerRequest(profile, "/repo", "x".repeat(window), 300000),
  );
});

test("Ollama token counts become usage, and a filled window becomes an error", () => {
  const context = { profile: httpProfile, transport: "http" };
  const answer = ollama.decode(
    JSON.stringify({
      model: "qwen3-coder:30b",
      response: '{"edits":[]}',
      done: true,
      done_reason: "stop",
      prompt_eval_count: 1200,
      eval_count: 300,
    }),
    context,
  );
  assert.equal(answer.text, '{"edits":[]}');
  assert.equal(answer.effectiveModel, "qwen3-coder:30b");
  assert.deepEqual(answer.usage, {
    input_tokens: 1200,
    output_tokens: 300,
    total_tokens: 1500,
  });
  // Local inference spends no API budget; a null here would make every run that
  // includes one local profile report an unknown total cost forever.
  assert.equal(answer.costUsd, 0);
  assert.equal(answer.providerError, false);
  assert.equal(ollama.classifyFailure({ code: 0, stderr: "" }, answer), null);

  // Ollama caps prompt evaluation at the window instead of refusing the call,
  // so a count that reaches it means the model read a shortened contract.
  const cut = ollama.decode(
    JSON.stringify({
      model: "qwen3-coder:30b",
      response: '{"edits":[]}',
      done_reason: "stop",
      prompt_eval_count: 8192,
      eval_count: 10,
    }),
    context,
  );
  assert.equal(cut.truncatedPrompt, true);
  assert.equal(cut.providerError, true);
  assert.equal(
    ollama.classifyFailure({ code: 0, stderr: "" }, cut),
    "context-truncated",
  );

  const unfinished = ollama.decode(
    JSON.stringify({
      response: '{"edits":[{"file":"a.txt"',
      done_reason: "length",
      prompt_eval_count: 10,
      eval_count: 4096,
    }),
    context,
  );
  assert.equal(unfinished.truncatedAnswer, true);
  assert.equal(
    ollama.classifyFailure({ code: 0, stderr: "" }, unfinished),
    "context-truncated",
  );
});

test("an unreachable local server is a routing failure, not lost capacity", () => {
  const decoded = ollama.decode("", {
    profile: httpProfile,
    transport: "http",
  });
  const result = { code: -1, stdout: "", stderr: "fetch failed: ECONNREFUSED" };
  assert.equal(ollama.classifyFailure(result, decoded), "provider-unavailable");
  // Pool exhaustion halts every profile sharing that pool. A local server has
  // no pool to exhaust, so the run must keep its remaining cloud profiles.
  assert.equal(ollama.capacityResetHint(result, decoded), null);

  const notFound = ollama.decode(
    JSON.stringify({ error: 'model "absent" not found' }),
    { profile: httpProfile, transport: "http" },
  );
  assert.equal(notFound.providerError, true);
  assert.equal(
    ollama.classifyFailure(
      { code: 1, stdout: "", stderr: "HTTP 404" },
      notFound,
    ),
    "model-error",
  );
});

test("invoke reports an HTTP provider in the same shape as a process one", async () => {
  const seen = [];
  const request = async (spec, options) => {
    seen.push({ spec, options });
    return {
      code: 0,
      stdout: JSON.stringify({
        model: "qwen3-coder:30b",
        response: '{"summary":"ok"}',
        done_reason: "stop",
        prompt_eval_count: 12,
        eval_count: 5,
      }),
      stderr: "",
      timedOut: false,
      overflow: false,
      pid: null,
      elapsedMs: 7,
    };
  };

  const response = await invoke(
    httpProfile,
    "/repo",
    "prompt",
    120000,
    async () => assert.fail("the process runner must not be used"),
    request,
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].options.timeoutMs, 120000);
  assert.equal(response.code, 0);
  assert.equal(response.elapsedMs, 7);
  assert.equal(response.text, '{"summary":"ok"}');
  assert.equal(response.failureClass, null);
  assert.equal(response.exhausted, false);
  assert.equal(response.modelBinding.status, "matched");
  assert.equal(response.capacityResetsIn, null);
});

test("httpRun keeps an error body instead of reducing it to a status code", async () => {
  const body = JSON.stringify({ error: 'model "absent" not found' });
  const failing = await httpRun(
    { url: "http://x/api/generate", body: "{}" },
    {
      fetchImpl: async () =>
        new Response(body, { status: 404, statusText: "Not Found" }),
    },
  );
  assert.equal(failing.code, 1);
  assert.equal(failing.stdout, body);
  assert.match(failing.stderr, /HTTP 404/);
  assert.equal(failing.timedOut, false);
  assert.equal(failing.pid, null);

  const unreachable = await httpRun(
    { url: "http://x/api/generate", body: "{}" },
    {
      fetchImpl: async () => {
        throw new Error("fetch failed");
      },
    },
  );
  assert.equal(unreachable.code, -1);
  assert.match(unreachable.stderr, /fetch failed/);
});

test("an unusable profile yields its remaining attempts to the next profile", async (t) => {
  const dir = fixture(t);
  for (const args of [
    ["init"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"],
  ]) {
    assert.equal((await run(["git", ...args], { cwd: dir })).code, 0);
  }
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

  const org = structuredClone(localOrg);
  org.roles.intern.profile = "ollama-qwen-http";
  org.roles.intern.fallbacks = ["agy-sonnet"];
  org.roles.intern.attempts = 3;
  validateOrg(org);

  const calls = [];
  const report = await work(
    dir,
    org,
    {
      schemaVersion: 2,
      revision: 1,
      kind: "edit",
      id: "local",
      goal: "Local first",
      instruction: "Make the change",
      nonGoals: [],
      constraints: [],
      files: ["value.txt"],
      checks: [[process.execPath, "-e", "process.exit(0)"]],
      acceptance: [
        {
          id: "check",
          description: "check",
          method: "check",
          checkIndexes: [0],
        },
      ],
      dependencies: [],
      contractRefs: [],
      contextRefs: [],
      openQuestions: [],
      reviewRequirements: [],
      environment: "test",
      baseRef: "HEAD",
      risk: "low",
    },
    {
      stateDir: path.join(dir, ".omt"),
      call: async (profile) => {
        calls.push(profile.provider);
        if (profile.provider === "ollama") {
          return {
            code: -1,
            stdout: "",
            stderr: "fetch failed: ECONNREFUSED",
            text: "",
            usage: null,
            effectiveModel: null,
            costUsd: 0,
            providerError: true,
            failureClass: "provider-unavailable",
            exhausted: false,
            elapsedMs: 1,
          };
        }
        return {
          code: 0,
          stdout: "",
          text: JSON.stringify({
            edits: [
              {
                file: "value.txt",
                beforeHash: hash(
                  fs.readFileSync(path.join(dir, "value.txt"), "utf8"),
                ),
                content: "right\n",
              },
            ],
            summary: "fixed",
          }),
          usage: null,
          effectiveModel: "claude-sonnet-4-6",
          costUsd: null,
          providerError: false,
          failureClass: null,
          exhausted: false,
          elapsedMs: 2,
        };
      },
    },
  );

  // Without this, a dead local server consumed all three attempts and the call
  // budget the cloud fallback needed to finish the task.
  assert.deepEqual(calls, ["ollama", "agy"]);
  assert.equal(
    report.implementation.status,
    "passed",
    JSON.stringify(report.issues),
  );
  assert.equal(report.status, "submitted");
});
