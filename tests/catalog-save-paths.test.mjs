/**
 * Covers every save path (`init`, `edit`, `preset --apply`, `org-draft`)
 * revalidating its profiles against a freshly fetched model catalog right
 * before persisting. A fake `execute` stands in for claude/codex/agy so these
 * scenarios never depend on what is actually installed on the machine
 * running the suite.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJSON, writeJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  draftOrganization,
  draftResourceOrganization,
} from "../plugins/oh-my-teams/scripts/org-draft.mjs";
import { executeCommand } from "../plugins/oh-my-teams/scripts/teams-org.mjs";

const CLAUDE_VERSION_OK = {
  code: 0,
  stdout: "2.1.283 (Claude Code)\n",
  stderr: "",
  timedOut: false,
};

const CODEX_VERSION_OK = {
  code: 0,
  stdout: "codex-cli 0.157.1\n",
  stderr: "",
  timedOut: false,
};

const AGY_VERSION_OK = {
  code: 0,
  stdout: "1.2.12\n",
  stderr: "",
  timedOut: false,
};

function codexModelsResponse(slugs) {
  return {
    code: 0,
    stdout: JSON.stringify({
      models: slugs.map((slug, index) => ({
        slug,
        visibility: "list",
        priority: index,
        display_name: slug,
        supported_reasoning_levels: [{ effort: "low" }],
      })),
    }),
    stderr: "",
    timedOut: false,
  };
}

function agyModelsResponse(ids) {
  return {
    code: 0,
    stdout: ids.map((id) => `${id}\t${id}`).join("\n") + "\n",
    stderr: "Fetching available models...\n",
    timedOut: false,
  };
}

const COMMAND_FAILED = {
  code: 1,
  stdout: "",
  stderr: "boom\n",
  timedOut: false,
};

// A working catalog: Codex lists gpt-6-astra, Agy lists gemini-3.1-pro-high.
// Claude always reports "unavailable"/"no-catalog-interface" once its
// `--version` call succeeds, regardless of what this table says.
function fakeExecute(overrides = {}) {
  const table = {
    "claude --version": CLAUDE_VERSION_OK,
    "codex --version": CODEX_VERSION_OK,
    "codex debug models": codexModelsResponse(["gpt-6-astra"]),
    "agy --version": AGY_VERSION_OK,
    "agy models": agyModelsResponse(["gemini-3.1-pro-high"]),
    ...overrides,
  };
  return async (argv) => {
    const key = argv.join(" ");
    assert.ok(Object.hasOwn(table, key), `no fake response for: ${key}`);
    return table[key];
  };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-catalog-save-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// pm gets the Claude host-default, pl and junior share one Codex profile,
// senior gets the one Agy Gemini choice the fake catalog lists.
function baseModels() {
  return [
    "claude:default",
    "codex:gpt-6-astra",
    "agy:gemini-3.1-pro-high",
    "codex:gpt-6-astra",
  ];
}

async function initOrg(dir, execute, overrides = {}) {
  const orgFile = path.join(dir, "organization.json");
  const draft = draftOrganization({ name: "team", models: baseModels() });
  const fromFile = path.join(dir, "draft.json");
  writeJSON(fromFile, draft);
  const result = await executeCommand(
    {
      command: "init",
      org: orgFile,
      from: fromFile,
      "host-default": "claude-default",
      ...overrides,
    },
    execute,
  );
  return { orgFile, draft, result };
}

test("init saves normally when every profile checks out against the catalog", async (t) => {
  const dir = tempDir(t);
  const { result } = await initOrg(dir, fakeExecute());
  assert.equal(result.created, true);
  assert.equal(result.catalogReceipt.savable, true);
  assert.ok(result.catalogReceipt.selections.every((entry) => entry.savable));
});

test("resource formation saves verified subscriptions without preselecting role models", async (t) => {
  const dir = tempDir(t);
  const draft = path.join(dir, "resource-draft.json");
  const result = await executeCommand(
    {
      command: "org-draft",
      name: "team",
      resources: "codex,agy",
      concurrency: "2",
      "max-calls": "4",
      output: draft,
    },
    fakeExecute(),
  );

  assert.equal(result.catalogReceipt.savable, true);
  assert.equal(result.organization.profiles, undefined);
  assert.equal(result.organization.resources["codex-current"].maxCalls, 4);
  assert.equal(readJSON(draft).roles.pm.profile, undefined);

  await t.test(
    "saves a Codex-only organization when the unselected Agy catalog fails",
    async (t) => {
      const selectedOnlyDir = tempDir(t);
      const selectedOnlyDraft = path.join(
        selectedOnlyDir,
        "codex-only-draft.json",
      );
      const selectedOnly = await executeCommand(
        {
          command: "org-draft",
          name: "codex-only",
          resources: "codex",
          output: selectedOnlyDraft,
        },
        fakeExecute({ "agy models": COMMAND_FAILED }),
      );

      assert.equal(selectedOnly.catalogReceipt.savable, true);
      assert.deepEqual(Object.keys(selectedOnly.organization.resources), [
        "codex-current",
      ]);
      assert.deepEqual(
        selectedOnly.catalogReceipt.selections.map((entry) => entry.key),
        ["codex-current"],
      );
      assert.equal(
        readJSON(selectedOnlyDraft).resources["agy-current"],
        undefined,
      );
    },
  );
});

test("resource formation rejects a selected provider whose catalog is unavailable", async (t) => {
  const dir = tempDir(t);
  await assert.rejects(
    () =>
      executeCommand(
        {
          command: "org-draft",
          name: "team",
          resources: "codex,agy",
          output: path.join(dir, "resource-draft.json"),
        },
        fakeExecute({ "agy models": COMMAND_FAILED }),
      ),
    /subscription resources failed catalog verification/,
  );
});

test("init and edit reject a resource organization without resources", async (t) => {
  const dir = tempDir(t);
  const orgFile = path.join(dir, "organization.json");
  const valid = draftResourceOrganization({
    name: "team",
    resources: ["codex"],
  });
  writeJSON(orgFile, valid);

  const emptyResources = structuredClone(valid);
  emptyResources.resources = {};
  const fromFile = path.join(dir, "empty-resources.json");
  writeJSON(fromFile, emptyResources);

  await assert.rejects(
    () =>
      executeCommand(
        { command: "init", org: path.join(dir, "new.json"), from: fromFile },
        fakeExecute(),
      ),
    /at least one subscription resource/i,
  );
  await assert.rejects(
    () =>
      executeCommand(
        {
          command: "edit",
          org: orgFile,
          from: fromFile,
          revision: valid.revision,
        },
        fakeExecute(),
      ),
    /at least one subscription resource/i,
  );
});

test("show --json returns a resource organization without profile decoration", async (t) => {
  const dir = tempDir(t);
  const orgFile = path.join(dir, "organization.json");
  const organization = draftResourceOrganization({
    name: "team",
    resources: ["codex"],
  });
  writeJSON(orgFile, organization);

  const result = await executeCommand({
    command: "show",
    org: orgFile,
    json: true,
  });

  assert.equal(result.organization.profiles, undefined);
  assert.deepEqual(result.organization.resources, organization.resources);
});

test("init refuses a model the catalog no longer lists", async (t) => {
  const dir = tempDir(t);
  const orgFile = path.join(dir, "organization.json");
  const draft = draftOrganization({
    name: "team",
    models: [
      "claude:default",
      "codex:gpt-9-ghost",
      "agy:gemini-3.1-pro-high",
      "codex:gpt-9-ghost",
    ],
  });
  const fromFile = path.join(dir, "draft.json");
  writeJSON(fromFile, draft);
  await assert.rejects(
    () =>
      executeCommand(
        {
          command: "init",
          org: orgFile,
          from: fromFile,
          "host-default": "claude-default",
        },
        fakeExecute(),
      ),
    /gpt-9-ghost|failed revalidation/,
  );
  assert.ok(!fs.existsSync(orgFile), "init must not write the rejected save");
});

test("init refuses a fresh model when its executor's catalog lookup fails", async (t) => {
  const dir = tempDir(t);
  const orgFile = path.join(dir, "organization.json");
  const draft = draftOrganization({
    name: "team",
    models: [
      "claude:default",
      "codex:gpt-6-astra",
      "agy:gemini-3.1-pro-high",
      "codex:gpt-6-astra",
    ],
  });
  const fromFile = path.join(dir, "draft.json");
  writeJSON(fromFile, draft);
  // Agy's own listing command fails outright; the freshly picked Agy model
  // has no prior save to fall back on, so this is a rejection, not a preserve.
  await assert.rejects(() =>
    executeCommand(
      {
        command: "init",
        org: orgFile,
        from: fromFile,
        "host-default": "claude-default",
      },
      fakeExecute({ "agy models": COMMAND_FAILED }),
    ),
  );
});

test("edit preserves an untouched profile when only its own provider's lookup fails", async (t) => {
  const dir = tempDir(t);
  const { orgFile } = await initOrg(dir, fakeExecute());
  const previous = readJSON(orgFile);

  // Change something unrelated to any profile (a role's concurrency) while
  // leaving every profile's provider/model exactly as it was.
  const candidate = structuredClone(previous);
  candidate.roles.junior.concurrency = 2;
  const fromFile = path.join(dir, "edit.json");
  writeJSON(fromFile, candidate);

  const result = await executeCommand(
    {
      command: "edit",
      org: orgFile,
      from: fromFile,
      revision: previous.revision,
    },
    // Both Codex and Agy now fail; none of their profiles changed, so their
    // selections must be preserved rather than rejected.
    fakeExecute({
      "codex debug models": COMMAND_FAILED,
      "agy models": COMMAND_FAILED,
    }),
  );
  assert.equal(result.catalogReceipt.savable, true);
  assert.ok(
    result.catalogReceipt.selections.every(
      (entry) => entry.savable && (entry.preserved || entry.hostDefault),
    ),
  );
  assert.equal(readJSON(orgFile).roles.junior.concurrency, 2);
});

test("edit validates a touched profile fully even while another provider's lookup fails", async (t) => {
  const dir = tempDir(t);
  const { orgFile } = await initOrg(dir, fakeExecute());
  const previous = readJSON(orgFile);

  // Move senior to a different, still-listed Agy model (touched) while
  // leaving the Codex profiles alone; Codex's own lookup fails this time.
  const candidate = structuredClone(previous);
  const seniorProfileId = candidate.roles.senior.profile;
  candidate.profiles[seniorProfileId] = {
    ...candidate.profiles[seniorProfileId],
    model: "gemini-3.8-flash-high",
  };
  const fromFile = path.join(dir, "edit.json");
  writeJSON(fromFile, candidate);

  const result = await executeCommand(
    {
      command: "edit",
      org: orgFile,
      from: fromFile,
      revision: previous.revision,
    },
    fakeExecute({
      "codex debug models": COMMAND_FAILED,
      "agy models": agyModelsResponse([
        "gemini-3.1-pro-high",
        "gemini-3.8-flash-high",
      ]),
    }),
  );
  assert.equal(result.catalogReceipt.savable, true);
  const seniorSelection = result.catalogReceipt.selections.find(
    (entry) => entry.key === seniorProfileId,
  );
  // "changed" (not "valid") is expected here: the Agy catalog now lists a
  // second model, so its catalogRevision differs from the one recorded at
  // init time. Either status is fully verified and savable.
  assert.ok(["valid", "changed"].includes(seniorSelection.status));
  assert.equal(seniorSelection.catalogVerified, true);
});

test("edit refuses a new host-default profile with no explicit --host-default", async (t) => {
  const dir = tempDir(t);
  const { orgFile } = await initOrg(dir, fakeExecute());
  const previous = readJSON(orgFile);

  const candidate = structuredClone(previous);
  const juniorProfileId = candidate.roles.junior.profile;
  candidate.profiles[juniorProfileId] = {
    ...candidate.profiles[juniorProfileId],
    provider: "claude",
    model: null,
  };
  const fromFile = path.join(dir, "edit.json");
  writeJSON(fromFile, candidate);

  // No `execute` stub answers anything: the rejection must happen before the
  // catalog is ever fetched.
  const throwingExecute = async (argv) => {
    throw new Error(`unexpected catalog call: ${argv.join(" ")}`);
  };
  await assert.rejects(
    () =>
      executeCommand(
        {
          command: "edit",
          org: orgFile,
          from: fromFile,
          revision: previous.revision,
        },
        throwingExecute,
      ),
    /explicit --host-default/,
  );
});

test("a snapshot's observational modelResolvedAtFormation field never blocks a save", async (t) => {
  const dir = tempDir(t);
  const { orgFile } = await initOrg(dir, fakeExecute());
  const previous = readJSON(orgFile);
  const pmProfileId = previous.roles.pm.profile;
  previous.profiles[pmProfileId].modelResolvedAtFormation = "gpt-6-astra";
  writeJSON(orgFile, previous);

  const candidate = structuredClone(previous);
  candidate.roles.junior.concurrency = 3;
  const fromFile = path.join(dir, "edit.json");
  writeJSON(fromFile, candidate);

  const result = await executeCommand(
    {
      command: "edit",
      org: orgFile,
      from: fromFile,
      revision: previous.revision,
    },
    fakeExecute(),
  );
  assert.equal(result.catalogReceipt.savable, true);
});

test("preset --apply revalidates a policy-only preset the same way any other save does", async (t) => {
  const dir = tempDir(t);
  const { orgFile } = await initOrg(dir, fakeExecute());
  const previous = readJSON(orgFile);

  const result = await executeCommand(
    {
      command: "preset",
      org: orgFile,
      name: "single-subscription",
      revision: previous.revision,
      apply: true,
    },
    fakeExecute(),
  );
  assert.equal(result.applied, true);
  assert.equal(result.catalogReceipt.savable, true);
});

test("preset still reads a compatibility-only name but refuses to run its old assignment", async (t) => {
  const dir = tempDir(t);
  const { orgFile } = await initOrg(dir, fakeExecute());
  const previous = readJSON(orgFile);

  await assert.rejects(
    () =>
      executeCommand(
        {
          command: "preset",
          org: orgFile,
          name: "advisor-codex",
          revision: previous.revision,
          apply: true,
        },
        fakeExecute(),
      ),
    /no longer assigns fixed models/,
  );
});
