/** Regression coverage for the experimental Jev shadow judgments. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJSON, validateOrg } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  JEV_ENDPOINT,
  judge,
  shadowAutoObserve,
  shadowFailureFallback,
  shadowModelCheck,
  shadowStatusFilter,
} from "../plugins/oh-my-teams/scripts/jev.mjs";
import { collectHarnessReports } from "../plugins/oh-my-teams/scripts/usage-sources.mjs";
import { parseArgs } from "../plugins/oh-my-teams/scripts/teams-org.mjs";

const example = readJSON(
  new URL("../plugins/oh-my-teams/examples/organization.json", import.meta.url),
);

const SHADOW = Object.freeze({
  mode: "shadow",
  model: "jev-1.13.0",
  points: ["status-filter", "auto-observe", "model-check", "failure-fallback"],
  budgetPerKickoff: 10,
  timeoutMs: 2000,
});

function orgWith(jev) {
  const org = structuredClone(example);
  if (jev !== undefined) org.policy.experimental = { jev };
  return org;
}

function stateDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-jev-test-"));
  // Exact test-owned directory, verified at creation; no user paths are removed.
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeFetch(
  answers,
  { status = 200, usage = { input_tokens: 1000, output_tokens: 3 } } = {},
) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name) => (name === "x-typesafe-request-id" ? "req-1" : null),
      },
      json: async () => ({ model: "jev-1.13.0", answers, usage }),
    };
  };
  return { impl, calls };
}

const ENV = Object.freeze({ TYPESAFE_API_KEY: "test-key" });

function records(dir) {
  const directory = path.join(dir, "judgments");
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJSON(path.join(directory, name)));
}

test("an organization without the experimental block stays valid and judges nothing", async (t) => {
  const org = validateOrg(orgWith());
  const dir = stateDir(t);
  const { impl, calls } = fakeFetch({});
  const result = await judge({
    org,
    stateDir: dir,
    point: "status-filter",
    state: {},
    questions: {},
    env: ENV,
    fetchImpl: impl,
  });
  assert.equal(result, null);
  assert.equal(calls.length, 0);
  assert.deepEqual(records(dir), []);
});

test("the experimental Jev block must be complete, pinned and shadow-only", () => {
  assert.doesNotThrow(() => validateOrg(orgWith({ ...SHADOW })));
  assert.doesNotThrow(() => validateOrg(orgWith({ ...SHADOW, mode: "off" })));
  assert.throws(
    () => validateOrg(orgWith({ ...SHADOW, mode: "on" })),
    /mode must be off or shadow/,
  );
  assert.throws(
    () => validateOrg(orgWith({ ...SHADOW, model: "jev-latest" })),
    /pinned version/,
  );
  assert.throws(
    () => validateOrg(orgWith({ ...SHADOW, points: ["merge-gate"] })),
    /points must list/,
  );
  assert.throws(
    () => validateOrg(orgWith({ ...SHADOW, points: [] })),
    /points must list/,
  );
  const { timeoutMs: _omitted, ...partial } = SHADOW;
  assert.throws(() => validateOrg(orgWith(partial)), /requires exactly/);
  assert.throws(
    () => validateOrg(orgWith({ ...SHADOW, extra: 1 })),
    /requires exactly/,
  );
  const other = structuredClone(example);
  other.policy.experimental = { other: {} };
  assert.throws(() => validateOrg(other), /experimental accepts only jev/);
});

test("a shadow judgment records the answers and a state hash, never the state", async (t) => {
  const org = validateOrg(orgWith({ ...SHADOW }));
  const dir = stateDir(t);
  const { impl, calls } = fakeFetch({
    needs_action: { type: "noul", noul: 0.12 },
  });
  const record = await judge({
    org,
    stateDir: dir,
    point: "status-filter",
    state: { note: "NOTION_TOKEN=secret-value" },
    questions: { needs_action: { type: "noul", instructions: "q" } },
    context: { deliveryId: "d-1" },
    env: ENV,
    fetchImpl: impl,
  });
  assert.equal(record.status, "answered");
  assert.equal(record.mode, "shadow");
  assert.equal(record.effectiveModel, "jev-1.13.0");
  assert.equal(record.answers.needs_action.noul, 0.12);
  assert.equal(record.costUsd, (1000 * 0.042) / 1e6);
  assert.equal(calls[0].url, JEV_ENDPOINT);
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-key");
  assert.equal(calls[0].body.model, "jev-1.13.0");
  const [saved] = records(dir);
  assert.equal(saved.id, record.id);
  const text = fs.readFileSync(
    path.join(dir, "judgments", `${record.id}.json`),
    "utf8",
  );
  assert.doesNotMatch(text, /secret-value/);
  assert.doesNotMatch(text, /test-key/);
});

test("a missing key or an exhausted budget is recorded without calling Jev", async (t) => {
  const dir = stateDir(t);
  const { impl, calls } = fakeFetch({});
  const org = validateOrg(orgWith({ ...SHADOW, budgetPerKickoff: 1 }));
  const call = (env) =>
    judge({
      org,
      stateDir: dir,
      point: "model-check",
      state: {},
      questions: {},
      env,
      fetchImpl: impl,
    });
  assert.equal((await call({})).reason, "missing-api-key");
  assert.equal(calls.length, 0);
  assert.equal((await call(ENV)).status, "answered");
  assert.equal((await call(ENV)).reason, "budget-exhausted");
  assert.equal(calls.length, 1);
});

test("a refused or failed call is recorded and never thrown", async (t) => {
  const dir = stateDir(t);
  const org = validateOrg(orgWith({ ...SHADOW }));
  const refused = fakeFetch({}, { status: 529 });
  const first = await judge({
    org,
    stateDir: dir,
    point: "model-check",
    state: {},
    questions: {},
    env: ENV,
    fetchImpl: refused.impl,
  });
  assert.equal(first.status, "failed");
  assert.equal(first.reason, "http-529");
  const thrown = async () => {
    throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
  };
  const second = await judge({
    org,
    stateDir: dir,
    point: "model-check",
    state: {},
    questions: {},
    env: ENV,
    fetchImpl: thrown,
  });
  assert.equal(second.status, "failed");
  assert.equal(second.reason, "TimeoutError");
});

test("a point left out of the block is not judged", async (t) => {
  const dir = stateDir(t);
  const org = validateOrg(orgWith({ ...SHADOW, points: ["model-check"] }));
  const { impl, calls } = fakeFetch({});
  const delivery = {
    deliveryId: "d",
    messages: [{ type: "status", body: "step 2 of 3" }],
  };
  assert.equal(
    await shadowStatusFilter({
      org,
      stateDir: dir,
      delivery,
      env: ENV,
      fetchImpl: impl,
    }),
    null,
  );
  assert.equal(calls.length, 0);
});

test("only a Delivery made entirely of status messages is judged", async (t) => {
  const dir = stateDir(t);
  const org = validateOrg(orgWith({ ...SHADOW }));
  const { impl, calls } = fakeFetch({
    needs_action: { type: "noul", noul: 0.9 },
  });
  const mixed = {
    deliveryId: "d1",
    messages: [
      { type: "status", body: "x" },
      { type: "worker_done", body: "y" },
    ],
  };
  assert.equal(
    await shadowStatusFilter({
      org,
      stateDir: dir,
      delivery: mixed,
      env: ENV,
      fetchImpl: impl,
    }),
    null,
  );
  const status = {
    deliveryId: "d2",
    messages: [{ type: "status", subject: "진행", body: "2단계 진행 중" }],
  };
  const record = await shadowStatusFilter({
    org,
    stateDir: dir,
    delivery: status,
    env: ENV,
    fetchImpl: impl,
  });
  assert.equal(record.point, "status-filter");
  assert.deepEqual(record.context, { deliveryId: "d2", messageCount: 1 });
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].body.questions).sort(), [
    "kind",
    "needs_action",
  ]);
  assert.equal(calls[0].body.state.messages[0].body, "2단계 진행 중");
});

test("a stalled worker's output is read and judged beside the unchanged decision", async (t) => {
  const dir = stateDir(t);
  const org = validateOrg(orgWith({ ...SHADOW }));
  const { impl, calls } = fakeFetch({
    state: { type: "choice", choice: "usage-limit" },
  });
  const decision = { action: "inspect", reason: "no-observed-activity" };
  const readOutput = async (id) => ({
    ok: true,
    result: {
      dispatchId: id,
      rows: [{ text: "Working..." }, { text: "usage limit reached" }],
    },
  });
  const record = await shadowAutoObserve({
    org,
    stateDir: dir,
    dispatchId: "ctx_1",
    decision,
    liveness: "live",
    readOutput,
    env: ENV,
    fetchImpl: impl,
  });
  assert.equal(record.answers.state.choice, "usage-limit");
  assert.deepEqual(record.context, {
    dispatchId: "ctx_1",
    liveness: "live",
    action: "inspect",
    reason: "no-observed-activity",
  });
  assert.match(calls[0].body.state.worker_output_tail, /usage limit reached$/);
  const unreadable = async () => {
    throw new Error("worker_identity_changed");
  };
  assert.equal(
    await shadowAutoObserve({
      org,
      stateDir: dir,
      dispatchId: "ctx_2",
      decision,
      readOutput: unreadable,
      env: ENV,
      fetchImpl: impl,
    }),
    null,
  );
  assert.equal(calls.length, 1);
});

test("a role terminal's screen is judged against the requested model", async (t) => {
  const dir = stateDir(t);
  const org = validateOrg(orgWith({ ...SHADOW }));
  const { impl, calls } = fakeFetch({
    match: { type: "choice", choice: "matches" },
  });
  const opened = {
    role: "pm",
    profile: "p",
    provider: "claude",
    modelRequested: "opus",
    ready: true,
    screen: "Claude Code · Opus 5",
  };
  const record = await shadowModelCheck({
    org,
    stateDir: dir,
    opened,
    env: ENV,
    fetchImpl: impl,
  });
  assert.equal(record.point, "model-check");
  assert.equal(calls[0].body.state.requested_model, "opus");
  assert.equal(
    await shadowModelCheck({
      org,
      stateDir: dir,
      opened: { ...opened, screen: "" },
      env: ENV,
      fetchImpl: impl,
    }),
    null,
  );
});

test("only a failure the rules left unknown is judged", async (t) => {
  const dir = stateDir(t);
  const org = validateOrg(orgWith({ ...SHADOW }));
  const { impl, calls } = fakeFetch({
    category: { type: "choice", choice: "environment-failure" },
  });
  const known = { category: "implementation-error" };
  assert.equal(
    await shadowFailureFallback({
      org,
      stateDir: dir,
      input: { message: "test failed" },
      decision: known,
      env: ENV,
      fetchImpl: impl,
    }),
    null,
  );
  const record = await shadowFailureFallback({
    org,
    stateDir: dir,
    input: { message: "node: command exited oddly", exitCode: 3 },
    decision: { category: "unknown" },
    env: ENV,
    fetchImpl: impl,
  });
  assert.equal(record.context.deterministic, "unknown");
  assert.deepEqual(calls[0].body.state.signals, { exitCode: 3 });
  assert.ok(calls[0].body.questions.category.criteria.unclear);
  assert.equal(calls.length, 1);
});

test("usage reports count answered judgments and skip ones that never called Jev", async (t) => {
  const dir = stateDir(t);
  const org = validateOrg(orgWith({ ...SHADOW }));
  const { impl } = fakeFetch({});
  await judge({
    org,
    stateDir: dir,
    point: "model-check",
    state: {},
    questions: {},
    env: ENV,
    fetchImpl: impl,
  });
  await judge({
    org,
    stateDir: dir,
    point: "model-check",
    state: {},
    questions: {},
    env: {},
    fetchImpl: impl,
  });
  const { records: collected } = collectHarnessReports(dir, { org });
  assert.equal(collected.length, 1);
  assert.equal(collected[0].provider, "typesafe");
  assert.equal(collected[0].inputTokens, 1000);
});

test("no gate or acceptance path reads a judgment", () => {
  const scripts = new URL("../plugins/oh-my-teams/scripts/", import.meta.url);
  for (const name of ["gates.mjs", "evidence.mjs", "workflow.mjs"]) {
    const source = fs.readFileSync(new URL(name, scripts), "utf8");
    assert.doesNotMatch(source, /judgments|jev\.mjs/, name);
  }
});

test("the shadow flags are optional on the commands that feed them", () => {
  assert.equal(
    parseArgs([
      "supervision-wait",
      "--run",
      "r",
      "--org",
      "o.json",
      "--state",
      "s",
    ]).state,
    "s",
  );
  assert.equal(
    parseArgs([
      "supervision-next",
      "--org",
      "o",
      "--observation",
      "b",
      "--dispatch",
      "d",
      "--state",
      "s",
    ]).dispatch,
    "d",
  );
  assert.equal(
    parseArgs([
      "failure-classify",
      "--failure",
      "f",
      "--org",
      "o",
      "--state",
      "s",
    ]).org,
    "o",
  );
  assert.equal(parseArgs(["failure-classify", "--failure", "f"]).failure, "f");
});
