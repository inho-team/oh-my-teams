/** Covers the executor model-catalog query and its choice-validation contract. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CATALOG_FAILURE_REASONS,
  CHOICE_REJECTION_REASONS,
  EXECUTOR_INSTALL_STATES,
  REVALIDATION_STATUSES,
  fetchModelCatalog,
  revalidateModelChoices,
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
  "codex --version": {
    code: 0,
    stdout: "codex-cli 0.157.1\n",
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
  "agy --version": {
    code: 0,
    stdout: "1.2.12\n",
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
  assert.deepEqual(
    [...EXECUTOR_INSTALL_STATES].sort(),
    ["installed", "not-installed", "unknown"].sort(),
  );
});

test("one executor's execute rejecting does not lose the other executors' already-settled results", async () => {
  const execute = async (argv) => {
    const key = argv.join(" ");
    if (key === "codex debug models") {
      throw new Error("simulated ECONNRESET from execute()");
    }
    return DEFAULT_RESPONSES[key];
  };
  // fetchModelCatalog itself must not reject: a broken execute for one
  // provider is not allowed to take down claude/agy's independent results.
  const catalog = await fetchModelCatalog({ execute });
  assert.equal(catalog.codex.status, "unavailable");
  assert.equal(catalog.codex.reasonCode, "execute-error");
  assert.match(catalog.codex.reason, /simulated ECONNRESET/);
  assert.equal(catalog.claude.status, "unavailable");
  assert.equal(catalog.claude.reasonCode, "no-catalog-interface");
  assert.equal(catalog.agy.status, "ok");
  assert.ok(catalog.agy.models.length > 0);
});

test("a synchronous throw from execute is caught the same way a rejection is", async () => {
  const execute = (argv) => {
    const key = argv.join(" ");
    if (key === "agy models") {
      throw new Error("execute is not even async here");
    }
    return Promise.resolve(DEFAULT_RESPONSES[key]);
  };
  const catalog = await fetchModelCatalog({ execute });
  assert.equal(catalog.agy.status, "unavailable");
  assert.equal(catalog.agy.reasonCode, "execute-error");
  assert.equal(catalog.codex.status, "ok");
});

test("an agy stdout line without an id/name separator is reported as unparseable, not silently dropped or absorbed as a model", async () => {
  const catalog = await fetchModelCatalog({
    execute: fakeExecute({
      "agy models": {
        code: 0,
        stdout:
          "gemini-3.1-pro-high\tGemini 3.1 Pro (High)\n" +
          "Warning: model cache stale, retrying...\n" +
          "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)\n",
        stderr: "",
        timedOut: false,
      },
    }),
  });
  assert.equal(catalog.agy.status, "unavailable");
  assert.equal(catalog.agy.reasonCode, "unparseable");
  assert.match(catalog.agy.reason, /Warning: model cache stale/);
  assert.deepEqual(catalog.agy.models, []);
  // The malformed agy line must never surface as a fabricated "model".
  assert.equal(catalog.codex.status, "ok");
});

test("an agy line with a tab but no id before it is rejected the same way", async () => {
  const catalog = await fetchModelCatalog({
    execute: fakeExecute({
      "agy models": {
        code: 0,
        stdout: "\tNo id before this tab\n",
        stderr: "",
        timedOut: false,
      },
    }),
  });
  assert.equal(catalog.agy.status, "unavailable");
  assert.equal(catalog.agy.reasonCode, "unparseable");
});

test("validateModelChoice rejects a malformed catalog argument instead of throwing", () => {
  const wellFormedChoice = "codex:gpt-6-astra";

  for (const badCatalog of [
    null,
    undefined,
    "not-an-object",
    42,
    ["array", "not", "record"],
  ]) {
    const result = validateModelChoice(badCatalog, wellFormedChoice);
    assert.equal(
      result.ok,
      false,
      `expected rejection for catalog: ${JSON.stringify(badCatalog)}`,
    );
    assert.equal(result.reasonCode, "malformed-catalog");
  }

  for (const badEntry of [
    { status: "ok" }, // models key missing entirely
    { status: "ok", models: "not-an-array" },
    { status: "ok", models: null },
  ]) {
    const result = validateModelChoice({ codex: badEntry }, wellFormedChoice);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "malformed-catalog");
  }

  // A corrupt item inside an otherwise well-formed models array must not
  // crash the .find() lookup; it should just fail to match.
  const corruptItemCatalog = {
    codex: { status: "ok", models: [null, "not-an-object", 42] },
  };
  const corruptResult = validateModelChoice(
    corruptItemCatalog,
    wellFormedChoice,
  );
  assert.equal(corruptResult.ok, false);
  assert.equal(corruptResult.reasonCode, "model-not-in-catalog");
});

test("fetchModelCatalog carries a fetchedAt timestamp and per-provider executorVersion", async () => {
  const catalog = await fetchModelCatalog({
    execute: fakeExecute(),
    now: () => "2026-09-27T00:00:00.000Z",
  });
  assert.equal(catalog.fetchedAt, "2026-09-27T00:00:00.000Z");
  assert.equal(catalog.claude.executorVersion, "2.1.283 (Claude Code)");
  assert.equal(catalog.codex.executorVersion, "codex-cli 0.157.1");
  assert.equal(catalog.agy.executorVersion, "1.2.12");
});

test("catalogRevision (per-provider and overall) is unchanged by fetch time, error text, or output order, and changes only with the models/efforts on offer", async () => {
  const first = await fetchModelCatalog({
    execute: fakeExecute(),
    now: () => "2026-09-27T00:00:00.000Z",
  });
  const second = await fetchModelCatalog({
    execute: fakeExecute({
      "agy models": {
        code: 0,
        // Same two models, reversed order.
        stdout:
          "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)\n" +
          "gemini-3.1-pro-high\tGemini 3.1 Pro (High)\n",
        stderr: "Fetching available models...\n",
        timedOut: false,
      },
    }),
    now: () => "2026-09-28T12:34:56.000Z",
  });
  assert.equal(first.codex.catalogRevision, second.codex.catalogRevision);
  assert.equal(first.agy.catalogRevision, second.agy.catalogRevision);
  assert.equal(first.catalogRevision, second.catalogRevision);

  const differentReasonText = await fetchModelCatalog({
    execute: fakeExecute({
      "codex debug models": {
        code: 1,
        stdout: "",
        stderr: "a completely different error message",
        timedOut: false,
      },
    }),
  });
  const sameReasonCodeDifferentText = await fetchModelCatalog({
    execute: fakeExecute({
      "codex debug models": {
        code: 1,
        stdout: "",
        stderr: "yet another unrelated failure string",
        timedOut: false,
      },
    }),
  });
  assert.equal(
    differentReasonText.codex.catalogRevision,
    sameReasonCodeDifferentText.codex.catalogRevision,
  );

  const changedModel = await fetchModelCatalog({
    execute: fakeExecute({
      "codex debug models": {
        code: 0,
        stdout: codexCatalogJson([
          {
            slug: "gpt-6-astra",
            visibility: "list",
            priority: 1,
            supported_reasoning_levels: [{ effort: "low" }],
          },
        ]),
        stderr: "",
        timedOut: false,
      },
    }),
  });
  assert.notEqual(
    first.codex.catalogRevision,
    changedModel.codex.catalogRevision,
  );
  assert.notEqual(first.catalogRevision, changedModel.catalogRevision);
});

test("validateModelChoice checks an optional effort against the matched model's efforts", async () => {
  const catalog = await fetchModelCatalog({ execute: fakeExecute() });

  const supported = validateModelChoice(catalog, "codex:gpt-6-astra", "low");
  assert.deepEqual(supported, {
    ok: true,
    provider: "codex",
    model: "gpt-6-astra",
    effortChecked: true,
  });

  const unsupported = validateModelChoice(catalog, "codex:gpt-6-astra", "max");
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.reasonCode, "effort-not-supported");

  // agy never reports efforts at all; a requested effort is not guessed at
  // or rejected against an invented allow-list, but is flagged unverified.
  const unverifiable = validateModelChoice(
    catalog,
    "agy:gemini-3.1-pro-high",
    "high",
  );
  assert.deepEqual(unverifiable, {
    ok: true,
    provider: "agy",
    model: "gemini-3.1-pro-high",
    effortChecked: false,
  });

  // No effort requested at all keeps the original, field-for-field shape.
  assert.deepEqual(validateModelChoice(catalog, "codex:gpt-6-astra"), {
    ok: true,
    provider: "codex",
    model: "gpt-6-astra",
  });
});

test("revalidateModelChoices distinguishes valid, changed, invalid, and unavailable selections", async () => {
  const before = await fetchModelCatalog({ execute: fakeExecute() });
  const after = await fetchModelCatalog({
    execute: fakeExecute({
      "codex debug models": {
        code: 0,
        stdout: codexCatalogJson([
          {
            slug: "gpt-6-astra",
            visibility: "list",
            priority: 1,
            supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
          },
          {
            slug: "gpt-7-nova",
            visibility: "list",
            priority: 2,
          },
        ]),
        stderr: "",
        timedOut: false,
      },
    }),
  });
  // codex's revision changed (a model was added); agy's did not.
  assert.notEqual(before.codex.catalogRevision, after.codex.catalogRevision);
  assert.equal(before.agy.catalogRevision, after.agy.catalogRevision);

  const receipt = revalidateModelChoices(after, [
    {
      key: "valid-pick",
      provider: "agy",
      model: "gemini-3.1-pro-high",
      catalogRevision: before.agy.catalogRevision,
    },
    {
      key: "changed-pick",
      provider: "codex",
      model: "gpt-6-astra",
      catalogRevision: before.codex.catalogRevision,
    },
    {
      key: "invalid-pick",
      provider: "codex",
      model: "no-such-model",
      catalogRevision: before.codex.catalogRevision,
    },
    {
      key: "unavailable-pick",
      provider: "claude",
      model: "whatever",
      catalogRevision: null,
    },
  ]);

  const byKey = Object.fromEntries(
    receipt.selections.map((selection) => [selection.key, selection]),
  );
  assert.equal(byKey["valid-pick"].status, "valid");
  assert.equal(byKey["valid-pick"].savable, true);
  assert.equal(byKey["changed-pick"].status, "changed");
  assert.equal(byKey["changed-pick"].savable, true);
  assert.equal(byKey["invalid-pick"].status, "invalid");
  assert.equal(byKey["invalid-pick"].reasonCode, "model-not-in-catalog");
  assert.equal(byKey["invalid-pick"].savable, false);
  assert.equal(byKey["unavailable-pick"].status, "unavailable");
  assert.equal(byKey["unavailable-pick"].reasonCode, "no-catalog-interface");
  assert.equal(byKey["unavailable-pick"].savable, false);
  assert.equal(receipt.savable, false);

  for (const status of Object.values(byKey).map((s) => s.status)) {
    assert.ok(REVALIDATION_STATUSES.includes(status));
  }
});

test("a host-default delegation is delegated and catalog-unverified, and only savable once the caller confirms the adapter contract", async () => {
  const catalog = await fetchModelCatalog({ execute: fakeExecute() });

  const unconfirmed = revalidateModelChoices(catalog, [
    { key: "host-default-pick", provider: "codex", hostDefault: true },
  ]).selections[0];
  assert.equal(unconfirmed.status, "delegated");
  assert.equal(unconfirmed.model, null);
  assert.equal(unconfirmed.hostDefault, true);
  assert.equal(unconfirmed.catalogVerified, false);
  assert.equal(unconfirmed.reasonCode, "adapter-contract-not-confirmed");
  assert.equal(unconfirmed.delegationGrounds.adapterContractConfirmed, false);
  assert.equal(unconfirmed.savable, false);

  const confirmed = revalidateModelChoices(catalog, [
    {
      key: "host-default-pick",
      provider: "codex",
      hostDefault: true,
      adapterContractConfirmed: true,
    },
  ]).selections[0];
  assert.equal(confirmed.status, "delegated");
  assert.equal(confirmed.catalogVerified, false);
  assert.equal(confirmed.delegationGrounds.executorInstalled, "installed");
  assert.equal(confirmed.delegationGrounds.adapterContractConfirmed, true);
  assert.equal(confirmed.savable, true);
  assert.notEqual(confirmed.status, "valid");
  assert.notEqual(confirmed.status, "changed");
});

test("a host-default delegation to claude is confirmable even though claude's own catalog entry is always unavailable (no-catalog-interface is not uninstalled)", async () => {
  const catalog = await fetchModelCatalog({ execute: fakeExecute() });
  assert.equal(catalog.claude.status, "unavailable");
  assert.equal(catalog.claude.reasonCode, "no-catalog-interface");

  const selection = revalidateModelChoices(catalog, [
    {
      key: "claude-host-default",
      provider: "claude",
      hostDefault: true,
      adapterContractConfirmed: true,
    },
  ]).selections[0];
  assert.equal(selection.status, "delegated");
  assert.equal(selection.delegationGrounds.executorInstalled, "installed");
  assert.equal(selection.catalogVerified, false);
  assert.equal(selection.savable, true);
});

test("a host-default delegation naming a concrete model is rejected instead of silently discarding the model", async () => {
  const catalog = await fetchModelCatalog({ execute: fakeExecute() });
  const selection = revalidateModelChoices(catalog, [
    {
      key: "conflicting-pick",
      provider: "codex",
      model: "gpt-6-astra",
      hostDefault: true,
      adapterContractConfirmed: true,
    },
  ]).selections[0];
  assert.equal(selection.status, "invalid");
  assert.equal(selection.reasonCode, "host-default-with-model");
  assert.equal(selection.model, "gpt-6-astra");
  assert.equal(selection.savable, false);
});

test("a host-default delegation to a genuinely unreachable executor is unavailable, not silently delegated", async () => {
  const catalog = await fetchModelCatalog({
    execute: fakeExecute({
      "codex debug models": {
        code: -1,
        stdout: "",
        stderr: "spawn codex ENOENT",
        timedOut: false,
      },
    }),
  });
  const touched = revalidateModelChoices(catalog, [
    {
      key: "codex-host-default",
      provider: "codex",
      hostDefault: true,
      adapterContractConfirmed: true,
      touched: true,
    },
  ]).selections[0];
  assert.equal(touched.status, "unavailable");
  assert.equal(touched.reasonCode, "not-installed");
  assert.equal(touched.delegationGrounds.executorInstalled, "not-installed");
  assert.equal(touched.preserved, false);
  assert.equal(touched.savable, false);

  const preserved = revalidateModelChoices(catalog, [
    {
      key: "codex-host-default",
      provider: "codex",
      hostDefault: true,
      adapterContractConfirmed: true,
      touched: false,
    },
  ]).selections[0];
  assert.equal(preserved.status, "unavailable");
  assert.equal(preserved.preserved, true);
  assert.equal(preserved.savable, true);
});

test("a host-default delegation whose executor never actually answered (execute itself rejecting) is unknown, not installed", async () => {
  const execute = async (argv) => {
    const key = argv.join(" ");
    if (key === "codex debug models") {
      throw new Error("simulated network failure from execute()");
    }
    return DEFAULT_RESPONSES[key];
  };
  const catalog = await fetchModelCatalog({ execute });
  assert.equal(catalog.codex.reasonCode, "execute-error");
  assert.equal(catalog.codex.executorVersion, null);

  const touched = revalidateModelChoices(catalog, [
    {
      key: "codex-host-default",
      provider: "codex",
      hostDefault: true,
      adapterContractConfirmed: true,
      touched: true,
    },
  ]).selections[0];
  assert.equal(touched.status, "unavailable");
  assert.equal(touched.reasonCode, "execute-error");
  assert.equal(touched.delegationGrounds.executorInstalled, "unknown");
  assert.equal(touched.savable, false);

  const preserved = revalidateModelChoices(catalog, [
    {
      key: "codex-host-default",
      provider: "codex",
      hostDefault: true,
      adapterContractConfirmed: true,
      touched: false,
    },
  ]).selections[0];
  assert.equal(preserved.delegationGrounds.executorInstalled, "unknown");
  assert.equal(preserved.preserved, true);
  assert.equal(preserved.savable, true);
});

test("a host-default delegation whose executor's catalog command failed with no version evidence is unknown, not installed", async () => {
  const catalog = await fetchModelCatalog({
    execute: fakeExecute({
      "codex debug models": {
        code: 1,
        stdout: "",
        stderr: "internal error: unexpected token",
        timedOut: false,
      },
      "codex --version": {
        code: 1,
        stdout: "",
        stderr: "codex: config error",
        timedOut: false,
      },
    }),
  });
  assert.equal(catalog.codex.reasonCode, "command-failed");
  assert.equal(catalog.codex.executorVersion, null);

  const selection = revalidateModelChoices(catalog, [
    {
      key: "codex-host-default",
      provider: "codex",
      hostDefault: true,
      adapterContractConfirmed: true,
      touched: true,
    },
  ]).selections[0];
  assert.equal(selection.status, "unavailable");
  assert.equal(selection.reasonCode, "command-failed");
  assert.equal(selection.delegationGrounds.executorInstalled, "unknown");
  assert.equal(selection.savable, false);
});

test("a host-default delegation to claude is not confused with unknown even without a parsed version string", async () => {
  const catalog = await fetchModelCatalog({
    execute: fakeExecute({
      "claude --version": { code: 0, stdout: "", stderr: "", timedOut: false },
    }),
  });
  assert.equal(catalog.claude.reasonCode, "no-catalog-interface");
  assert.equal(catalog.claude.executorVersion, null);

  const selection = revalidateModelChoices(catalog, [
    {
      key: "claude-host-default",
      provider: "claude",
      hostDefault: true,
      adapterContractConfirmed: true,
    },
  ]).selections[0];
  assert.equal(selection.delegationGrounds.executorInstalled, "installed");
  assert.equal(selection.status, "delegated");
  assert.equal(selection.savable, true);
});

test("a provider lookup failure never turns an explicit model selection into a host-default delegation", async () => {
  const catalog = await fetchModelCatalog({
    execute: fakeExecute({
      "codex debug models": {
        code: -1,
        stdout: "",
        stderr: "spawn codex ENOENT",
        timedOut: false,
      },
    }),
  });
  const selection = revalidateModelChoices(catalog, [
    { key: "explicit-pick", provider: "codex", model: "gpt-6-astra" },
  ]).selections[0];
  assert.equal(selection.status, "unavailable");
  assert.equal(selection.hostDefault, false);
  assert.equal(selection.model, "gpt-6-astra");
  assert.notEqual(selection.status, "delegated");
});

test("a non-array selections argument is malformed and unsavable, unlike a genuinely empty batch", () => {
  const malformed = revalidateModelChoices({}, "not-an-array");
  assert.equal(malformed.malformed, true);
  assert.equal(malformed.savable, false);
  assert.deepEqual(malformed.selections, []);

  const empty = revalidateModelChoices({}, []);
  assert.equal(empty.malformed, false);
  assert.equal(empty.savable, true);
  assert.deepEqual(empty.selections, []);
});

test("revalidateModelChoices preserves an untouched selection whose own provider's lookup failed, without touching other providers' selections", async () => {
  const before = await fetchModelCatalog({ execute: fakeExecute() });
  const after = await fetchModelCatalog({
    execute: fakeExecute({
      "codex debug models": {
        code: 1,
        stdout: "",
        stderr: "not entitled",
        timedOut: false,
      },
    }),
  });

  const receipt = revalidateModelChoices(after, [
    {
      key: "existing-codex-pick",
      provider: "codex",
      model: "gpt-6-astra",
      catalogRevision: before.codex.catalogRevision,
      touched: false,
    },
    {
      key: "fresh-agy-pick",
      provider: "agy",
      model: "gemini-3.1-pro-high",
      catalogRevision: before.agy.catalogRevision,
      touched: true,
    },
  ]);

  const [codexPick, agyPick] = receipt.selections;
  assert.equal(codexPick.status, "unavailable");
  assert.equal(codexPick.preserved, true);
  assert.equal(codexPick.catalogVerified, false);
  // Preserving an existing choice is not a successful revalidation, so it
  // does not block the batch, but a fresh attempt at a down provider would.
  assert.equal(codexPick.savable, true);

  assert.equal(agyPick.status, "valid");
  assert.equal(agyPick.savable, true);
  assert.equal(receipt.savable, true);

  const touchedAtDownProvider = revalidateModelChoices(after, [
    {
      key: "fresh-codex-pick",
      provider: "codex",
      model: "gpt-6-astra",
      catalogRevision: before.codex.catalogRevision,
      touched: true,
    },
  ]);
  assert.equal(touchedAtDownProvider.selections[0].status, "unavailable");
  assert.equal(touchedAtDownProvider.selections[0].preserved, false);
  assert.equal(touchedAtDownProvider.selections[0].savable, false);
  assert.equal(touchedAtDownProvider.savable, false);
});

test("validateModelChoice keeps rejecting inherited prototype-chain provider names safely", () => {
  const catalog = {
    codex: { status: "ok", models: [{ id: "gpt-6-astra" }] },
  };
  // "constructor" is the one JS-reserved property name this module's
  // provider regex (lowercase only) can actually produce; Object.hasOwn
  // must refuse to treat the inherited Object constructor as a real entry.
  for (const provider of ["constructor", "hasownproperty", "valueof"]) {
    const result = validateModelChoice(catalog, `${provider}:gpt-6-astra`);
    assert.equal(result.ok, false);
    assert.ok(
      result.reasonCode === "unknown-provider" ||
        result.reasonCode === "malformed-choice",
      `unexpected reasonCode for provider ${provider}: ${result.reasonCode}`,
    );
  }
});
