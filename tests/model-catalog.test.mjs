/** Covers the executor model-catalog query and its choice-validation contract. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CATALOG_FAILURE_REASONS,
  CHOICE_REJECTION_REASONS,
  fetchModelCatalog,
  validateModelChoice,
} from "../plugins/oh-my-teams/scripts/model-catalog.mjs";

function codexCatalogJson(models) {
  return JSON.stringify({ models });
}

const DEFAULT_RESPONSES = {
  "claude --version": {
    code: 0,
    stdout: "2.1.283 (Claude Code)\n",
    stderr: "",
    timedOut: false,
  },
  "codex debug models": {
    code: 0,
    stdout: codexCatalogJson([
      {
        slug: "gpt-6-astra",
        visibility: "list",
        priority: 1,
        display_name: "GPT-6-Astra",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
      },
      { slug: "gpt-reserve", visibility: "hide", priority: 0 },
    ]),
    stderr: "",
    timedOut: false,
  },
  "agy models": {
    code: 0,
    stdout:
      "gemini-3.1-pro-high\tGemini 3.1 Pro (High)\n" +
      "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)\n",
    stderr: "Fetching available models...\n",
    timedOut: false,
  },
};

// A fake `execute` keyed by argv, the same injection point host-defaults'
// own tests use, so a real claude/codex/agy binary is never spawned by this
// suite. An argv this test did not stub fails loudly instead of hanging.
function fakeExecute(overrides = {}) {
  const table = { ...DEFAULT_RESPONSES, ...overrides };
  return async (argv) => {
    const key = argv.join(" ");
    assert.ok(Object.hasOwn(table, key), `no fake response for: ${key}`);
    return table[key];
  };
}

test("the same code returns different catalog models when executor output changes", async () => {
  const first = await fetchModelCatalog({ execute: fakeExecute() });
  assert.deepEqual(
    first.codex.models.map((model) => model.id),
    ["gpt-6-astra"],
  );
  assert.deepEqual(first.codex.models[0], {
    id: "gpt-6-astra",
    displayName: "GPT-6-Astra",
    efforts: ["low", "high"],
  });
  assert.deepEqual(
    first.agy.models.map((model) => model.id),
    ["gemini-3.1-pro-high", "gemini-3.1-pro-low"],
  );

  const second = await fetchModelCatalog({
    execute: fakeExecute({
      "codex debug models": {
        code: 0,
        stdout: codexCatalogJson([
          {
            slug: "gpt-7-nova",
            visibility: "list",
            priority: 1,
            display_name: "GPT-7-Nova",
          },
        ]),
        stderr: "",
        timedOut: false,
      },
    }),
  });
  assert.deepEqual(
    second.codex.models.map((model) => model.id),
    ["gpt-7-nova"],
  );
});

test("one executor's failure reports only that executor unavailable; the rest stay ok", async () => {
  const catalog = await fetchModelCatalog({
    execute: fakeExecute({
      "codex debug models": {
        code: 1,
        stdout: "",
        stderr: "boom: account not entitled",
        timedOut: false,
      },
    }),
  });
  assert.equal(catalog.codex.status, "unavailable");
  assert.equal(catalog.codex.reasonCode, "command-failed");
  assert.match(catalog.codex.reason, /boom: account not entitled/);
  assert.deepEqual(catalog.codex.models, []);

  assert.equal(catalog.agy.status, "ok");
  assert.ok(catalog.agy.models.length > 0);
  // Claude has no listing command of its own, independent of how codex or
  // agy answered; this is a fixed fact about the installed CLI, not a
  // transient failure the other two could ever clear.
  assert.equal(catalog.claude.status, "unavailable");
  assert.equal(catalog.claude.reasonCode, "no-catalog-interface");
});

test("a missing executable is distinguished from a command that ran and failed", async () => {
  const catalog = await fetchModelCatalog({
    execute: fakeExecute({
      "agy models": {
        code: -1,
        stdout: "",
        stderr: "spawn agy ENOENT",
        timedOut: false,
      },
    }),
  });
  assert.equal(catalog.agy.status, "unavailable");
  assert.equal(catalog.agy.reasonCode, "not-installed");
  assert.equal(catalog.codex.status, "ok");
});

test("a timeout and an empty parsed catalog are reported as distinct reasons", async () => {
  const timedOut = await fetchModelCatalog({
    execute: fakeExecute({
      "codex debug models": {
        code: -1,
        stdout: "",
        stderr: "",
        timedOut: true,
      },
    }),
  });
  assert.equal(timedOut.codex.reasonCode, "command-failed");

  const emptyCatalog = await fetchModelCatalog({
    execute: fakeExecute({
      "codex debug models": {
        code: 0,
        stdout: codexCatalogJson([
          { slug: "hidden", visibility: "hide", priority: 1 },
        ]),
        stderr: "",
        timedOut: false,
      },
      "agy models": {
        code: 0,
        stdout: "\n",
        stderr: "Fetching available models...\n",
        timedOut: false,
      },
    }),
  });
  assert.equal(emptyCatalog.codex.reasonCode, "empty-catalog");
  assert.equal(emptyCatalog.agy.reasonCode, "empty-catalog");
});

test("output that is not the expected JSON shape is unparseable, not silently empty", async () => {
  const catalog = await fetchModelCatalog({
    execute: fakeExecute({
      "codex debug models": {
        code: 0,
        stdout: "not json",
        stderr: "",
        timedOut: false,
      },
    }),
  });
  assert.equal(catalog.codex.status, "unavailable");
  assert.equal(catalog.codex.reasonCode, "unparseable");
});

test("an explicit codexHome reaches the codex catalog command as CODEX_HOME", async () => {
  let capturedEnv;
  const execute = async (argv, options) => {
    if (argv.join(" ") === "codex debug models") {
      capturedEnv = options.env;
      return {
        code: 0,
        stdout: codexCatalogJson([
          { slug: "x", visibility: "list", priority: 1 },
        ]),
        stderr: "",
        timedOut: false,
      };
    }
    return DEFAULT_RESPONSES[argv.join(" ")];
  };
  await fetchModelCatalog({ execute, codexHome: "/tmp/launcher-codex-home" });
  assert.equal(capturedEnv.CODEX_HOME, "/tmp/launcher-codex-home");
});

test("validateModelChoice rejects malformed input, unknown providers, unavailable executors, and off-catalog models", async () => {
  const catalog = await fetchModelCatalog({
    execute: fakeExecute({
      "codex debug models": {
        code: 1,
        stdout: "",
        stderr: "not entitled",
        timedOut: false,
      },
    }),
  });

  assert.equal(
    validateModelChoice(catalog, "not-a-choice").reasonCode,
    "malformed-choice",
  );
  assert.equal(
    validateModelChoice(catalog, "ollama:llama3").reasonCode,
    "unknown-provider",
  );
  assert.equal(
    validateModelChoice(catalog, "codex:gpt-6-astra").reasonCode,
    "provider-unavailable",
  );
  assert.equal(
    validateModelChoice(catalog, "agy:not-a-real-model").reasonCode,
    "model-not-in-catalog",
  );

  const accepted = validateModelChoice(catalog, "agy:gemini-3.1-pro-high");
  assert.deepEqual(accepted, {
    ok: true,
    provider: "agy",
    model: "gemini-3.1-pro-high",
  });
});

test("the failure-reason and rejection-reason vocabularies are stable and non-empty", () => {
  assert.ok(CATALOG_FAILURE_REASONS.includes("not-installed"));
  assert.ok(CATALOG_FAILURE_REASONS.includes("no-catalog-interface"));
  assert.ok(CHOICE_REJECTION_REASONS.includes("model-not-in-catalog"));
  assert.equal(
    new Set(CATALOG_FAILURE_REASONS).size,
    CATALOG_FAILURE_REASONS.length,
  );
  assert.equal(
    new Set(CHOICE_REJECTION_REASONS).size,
    CHOICE_REJECTION_REASONS.length,
  );
});
