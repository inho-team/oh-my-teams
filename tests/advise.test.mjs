/** Regression coverage for advisor calls and the advisor tier presets. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ADVICE_BUDGET_DEFAULT,
  chart,
  readJSON,
  validateOrg,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  advise,
  validateBrief,
} from "../plugins/oh-my-teams/scripts/worker.mjs";
import { previewPreset } from "../plugins/oh-my-teams/scripts/presets.mjs";
import { collectHarnessReports } from "../plugins/oh-my-teams/scripts/usage-sources.mjs";
import {
  parseArgs,
  REQUIRED_OPTIONS,
} from "../plugins/oh-my-teams/scripts/teams-org.mjs";

const example = readJSON(
  new URL("../plugins/oh-my-teams/examples/organization.json", import.meta.url),
);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-advise-test-"));
  // Exact test-owned directory, verified at creation; no user paths are removed.
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "plan.md"), "# Plan\nsplit into two waves\n");
  return dir;
}

function codexProfile(model) {
  return {
    provider: "codex",
    command: ["codex"],
    account: "current",
    subscription: "Codex (current account)",
    model,
    pool: "codex-current",
  };
}

// The shape the grid and trading organizations were saved with: Astra as PM,
// Sol as PL, Terra as Senior, and Luna for the implementation role.
function astraLedOrg() {
  const org = structuredClone(example);
  org.pools = { "codex-current": { label: "Codex current account" } };
  org.profiles = {
    "codex-gpt-6-astra": codexProfile("gpt-6-astra"),
    "codex-gpt-5-6-sol": codexProfile("gpt-5.6-sol"),
    "codex-gpt-5-6-terra": codexProfile("gpt-5.6-terra"),
    "codex-gpt-5-6-luna": codexProfile("gpt-5.6-luna"),
  };
  const profiles = {
    pm: "codex-gpt-6-astra",
    pl: "codex-gpt-5-6-sol",
    senior: "codex-gpt-5-6-terra",
    junior: "codex-gpt-5-6-luna",
  };
  for (const [role, profile] of Object.entries(profiles)) {
    org.roles[role] = { ...org.roles[role], profile, fallbacks: [] };
  }
  return validateOrg(org);
}

// The advisor-codex preset used to build this shape by reassigning Astra's org
// onto Sol/Terra/Luna models and an advisor allowlist; that reassignment is
// gone (see the preset tests below), so advise()'s own tests set the
// allowlist directly instead of routing through the retired preset.
function advisedOrg(budget) {
  const org = astraLedOrg();
  org.advisors = {
    pm: ["codex-gpt-6-astra"],
    pl: ["codex-gpt-6-astra"],
    senior: ["codex-gpt-6-astra"],
  };
  if (budget) org.policy.adviceBudget = budget;
  return validateOrg(org);
}

const brief = {
  schemaVersion: 1,
  id: "wave-split",
  question: "Should the migration ship in one wave or two?",
  summary: "Two tasks touch the same schema file; tests take 9 minutes.",
  files: ["plan.md"],
  options: ["one wave", "two waves"],
};

const answer = {
  decision: "revise",
  recommendation: "Ship in two waves so the schema change lands first",
  rationale: "Both tasks edit one file",
  risks: ["second wave must rebase"],
  citations: [{ file: "plan.md", line: 2, quote: "split into two waves" }],
};

function response(payload) {
  const text = JSON.stringify(payload);
  return {
    code: 0,
    text,
    stdout: `${text}\n`,
    stderr: "",
    elapsedMs: 5,
    usage: { input_tokens: 900, output_tokens: 80 },
  };
}

test("the advisor-codex and advisor-claude presets refuse to reassign roles or advisors", () => {
  const org = astraLedOrg();
  const before = JSON.stringify(org);
  for (const name of ["advisor-codex", "advisor-claude"]) {
    assert.throws(
      () => previewPreset(org, name),
      /no longer assigns fixed models, fallbacks, or advisors/,
    );
    assert.throws(() => previewPreset(org, name), /edit/);
    assert.throws(() => previewPreset(org, name), /model-catalog/);
  }
  // Neither the roles nor the profiles the preset used to rewrite were touched.
  assert.equal(JSON.stringify(org), before);
  assert.equal(org.roles.pm.profile, "codex-gpt-6-astra");
});

test("an organization saved under the retired advisor-codex preset still validates", () => {
  const org = astraLedOrg();
  org.advisors = { pm: ["codex-gpt-6-astra"] };
  const saved = {
    ...org,
    modelPolicy: { preset: "advisor-codex", revision: 1 },
  };
  assert.equal(validateOrg(saved), saved);
  assert.match(chart(saved), /ADVISOR for PM: codex-gpt-6-astra/);
});

test("advice is persisted with its slot, decision, and verified citations", async (t) => {
  const dir = fixture(t);
  const stateDir = path.join(dir, ".omt");
  let prompt = "";
  const report = await advise(dir, advisedOrg(), brief, {
    role: "pm",
    kind: "plan",
    stateDir,
    call: async (profile, _repo, text) => {
      assert.equal(profile.model, "gpt-6-astra");
      prompt = text;
      return response(answer);
    },
  });
  assert.equal(report.decision, "revise");
  assert.equal(report.slot, 1);
  assert.equal(report.callerRole, "pm");
  assert.equal(report.citations[0].verified, true);
  assert.match(report.responsibility, /advice is not approval/);
  assert.ok(fs.existsSync(report.reportPath));
  assert.match(prompt, /split into two waves/);
  assert.match(prompt, /two waves/);

  const usage = collectHarnessReports(stateDir, {
    org: advisedOrg(),
    window: { from: 0, to: Date.now() + 1000 },
  });
  assert.equal(usage.records.length, 1);
  assert.equal(usage.records[0].role, "pm");
});

test("advice refuses roles without an advisor and kinds it does not know", async (t) => {
  const dir = fixture(t);
  const org = advisedOrg();
  await assert.rejects(
    () =>
      advise(dir, org, brief, {
        role: "junior",
        kind: "review",
        stateDir: path.join(dir, ".omt"),
        call: async () => response(answer),
      }),
    /Advisor profile not allowed: junior/,
  );
  await assert.rejects(
    () =>
      advise(dir, org, brief, {
        role: "pm",
        kind: "approve",
        stateDir: path.join(dir, ".omt"),
        call: async () => response(answer),
      }),
    /Advice kind must be/,
  );
});

test("the advice budget counts failed calls and stops at the limit", async (t) => {
  const dir = fixture(t);
  const stateDir = path.join(dir, ".omt");
  const org = advisedOrg(2);
  await assert.rejects(
    () =>
      advise(dir, org, brief, {
        role: "senior",
        kind: "review",
        stateDir,
        call: async () => ({ ...response(answer), code: 1 }),
      }),
    /Advisor provider failed/,
  );
  await advise(dir, org, brief, {
    role: "senior",
    kind: "review",
    stateDir,
    call: async () => response(answer),
  });
  let called = false;
  await assert.rejects(
    () =>
      advise(dir, org, brief, {
        role: "senior",
        kind: "review",
        stateDir,
        call: async () => {
          called = true;
          return response(answer);
        },
      }),
    /Advice budget exhausted: 2/,
  );
  assert.equal(called, false, "an exhausted budget must not reach the model");
  assert.equal(ADVICE_BUDGET_DEFAULT, 6);
});

test("advice that cites another tree is rejected, and a brief without files needs no citation", async (t) => {
  const dir = fixture(t);
  const stateDir = path.join(dir, ".omt");
  await assert.rejects(
    () =>
      advise(dir, advisedOrg(), brief, {
        role: "pm",
        kind: "design",
        stateDir,
        call: async () =>
          response({
            ...answer,
            citations: [{ file: "plan.md", line: 2, quote: "one wave only" }],
          }),
      }),
    /do not exist in this workspace/,
  );
  const report = await advise(
    dir,
    advisedOrg(),
    { ...brief, files: [] },
    {
      role: "pm",
      kind: "unblock",
      stateDir,
      call: async () => response({ ...answer, citations: [] }),
    },
  );
  assert.equal(report.grounding, null);
});

test("a brief must be a summary, not a transcript", () => {
  assert.throws(
    () => validateBrief({ ...brief, summary: "x".repeat(12001) }),
    /summarize the decision instead of pasting the conversation/,
  );
  assert.throws(
    () => validateBrief({ ...brief, id: "Wave Split" }),
    /Brief id/,
  );
  assert.throws(
    () =>
      validateBrief({
        ...brief,
        files: Array.from({ length: 9 }, (_, i) => `f${i}.md`),
      }),
    /at most 8/,
  );
});

test("organization validation guards the advisor allowlist and budget", () => {
  const org = advisedOrg();
  assert.throws(
    () => validateOrg({ ...org, advisors: { pm: ["missing-profile"] } }),
    /Invalid advisor profiles: pm/,
  );
  assert.throws(
    () => validateOrg({ ...org, policy: { ...org.policy, adviceBudget: 0 } }),
    /adviceBudget must be 1..50/,
  );
});

test("the advise command takes a brief and requires six inputs", () => {
  assert.deepEqual(REQUIRED_OPTIONS.advise, [
    "org",
    "brief",
    "repo",
    "state",
    "role",
    "kind",
  ]);
  const args = parseArgs([
    "advise",
    "--org",
    "o.json",
    "--brief",
    "b.json",
    "--repo",
    ".",
    "--state",
    ".omt",
    "--role",
    "pm",
    "--kind",
    "plan",
  ]);
  assert.equal(args.brief, "b.json");
});
