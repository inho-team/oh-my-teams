/**
 * Reads the model catalog each installed executor currently offers.
 *
 * Codex and Agy both ship a command that lists the models their account can
 * use right now (`codex debug models`, `agy models`); Claude Code ships
 * neither, only a `--model` flag whose help text names aliases as examples,
 * not a queryable list. No provider's model list is written into this module
 * as a constant: every call re-reads the installed CLI, and a provider this
 * cannot read comes back `unavailable` with a specific reason instead of a
 * remembered or guessed model. `docs/plan/model-catalog.md` records the exact
 * commands, installed versions, and output shapes this reads, and the concrete
 * failure modes are read from `docs/CODE_QUALITY.md`'s adjoining commands run
 * live rather than assumed.
 *
 * {@link validateModelChoice} is the public contract a caller that lets a user
 * pick a `provider:model` value must call before persisting it; this module
 * does not call it from anywhere itself.
 */
import os from "node:os";
import { assert, run } from "./core.mjs";
import {
  codexModelRank,
  fetchCodexModelCatalog,
  resolveCodexHome,
} from "./host-defaults.mjs";

/** Executors this module queries. Ollama is a separate, endpoint-based provider. */
export const CATALOG_PROVIDERS = Object.freeze(["claude", "codex", "agy"]);

/**
 * Stable reasons a provider's catalog entry can be `unavailable`.
 *
 * `not-installed` means the executable could not be spawned at all;
 * `command-failed` covers a non-zero exit or a timeout; `unparseable` means
 * the command ran but its output was not the shape this reads; `empty-catalog`
 * means it parsed but named no usable model; `no-catalog-interface` means the
 * executor has no listing command to run in the first place; `execute-error`
 * means the injected `execute` itself rejected or threw before any process
 * result came back, which is a break of the `execute` contract rather than a
 * command that ran and failed.
 */
export const CATALOG_FAILURE_REASONS = Object.freeze([
  "not-installed",
  "command-failed",
  "unparseable",
  "empty-catalog",
  "no-catalog-interface",
  "execute-error",
]);

function excerpt(text, max = 300) {
  const trimmed = (text ?? "").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function unavailable(provider, reasonCode, reason, source) {
  assert(
    CATALOG_FAILURE_REASONS.includes(reasonCode),
    `Unknown catalog failure reason: ${reasonCode}`,
  );
  return {
    provider,
    status: "unavailable",
    reasonCode,
    reason,
    source,
    models: [],
  };
}

function ok(provider, source, models) {
  return { provider, status: "ok", source, models };
}

// Both Codex and Agy fail the same two structural ways before either gets to
// parse its own output: the binary itself is missing, or it ran but did not
// exit cleanly. Only "not-installed" is distinguished here; a non-zero exit
// and a timeout both read as "command-failed" because neither names a
// narrower cause the caller could act on differently.
function classifyProcessFailure(result) {
  return /ENOENT/.test(result.stderr ?? "")
    ? "not-installed"
    : "command-failed";
}

async function codexCatalog({ execute, env, home, codexHome }) {
  const source = "codex debug models";
  const resolvedHome = resolveCodexHome({ home, env, codexHome });
  const {
    models: raw,
    error,
    reasonCode,
  } = await fetchCodexModelCatalog({
    codexHome: resolvedHome,
    env,
    execute,
  });
  if (error)
    return unavailable("codex", reasonCode ?? "command-failed", error, source);

  const listed = raw.filter((model) => model.visibility === "list");
  if (listed.length === 0) {
    return unavailable(
      "codex",
      "empty-catalog",
      "codex debug models returned no visibility:list entry",
      source,
    );
  }
  const models = listed
    .sort((left, right) => codexModelRank(left) - codexModelRank(right))
    .map((model) => ({
      id: model.slug,
      displayName:
        typeof model.display_name === "string" ? model.display_name : null,
      efforts: Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels
            .map((level) => level.effort)
            .filter((effort) => typeof effort === "string")
        : [],
    }));
  return ok("codex", source, models);
}

// A well-formed line is `<id>\t<display name>`; anything without a tab, or
// with nothing before the tab, is not a model line, and null tells the
// caller to reject the whole batch instead of silently dropping just that
// line (a mis-shapen line signals the parser no longer understands the
// output, not that one model happens to be missing).
function parseAgyLine(line) {
  const tabIndex = line.indexOf("\t");
  if (tabIndex === -1) return null;
  const id = line.slice(0, tabIndex).trim();
  if (!id) return null;
  const displayName = line.slice(tabIndex + 1).trim();
  return { id, displayName: displayName || null, efforts: [] };
}

async function agyCatalog({ execute, env }) {
  const source = "agy models";
  const result = await execute(["agy", "models"], {
    timeoutMs: 60000,
    env: { ...process.env, ...env },
  });
  if (result.timedOut || result.code !== 0) {
    return unavailable(
      "agy",
      classifyProcessFailure(result),
      excerpt(result.stderr || result.stdout || "agy models failed"),
      source,
    );
  }
  // Each stdout line is `<id>\t<display name>`; a progress line such as
  // "Fetching available models..." goes to stderr, not stdout (verified live).
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const models = [];
  for (const line of lines) {
    const parsed = parseAgyLine(line);
    if (!parsed) {
      return unavailable(
        "agy",
        "unparseable",
        `agy models printed a line with no id/name separator: ${excerpt(line, 120)}`,
        source,
      );
    }
    models.push(parsed);
  }
  if (models.length === 0) {
    return unavailable(
      "agy",
      "empty-catalog",
      "agy models printed no model line on stdout",
      source,
    );
  }
  return ok("agy", source, models);
}

async function claudeCatalog({ execute, env }) {
  const source = "claude --version";
  const result = await execute(["claude", "--version"], {
    timeoutMs: 60000,
    env: { ...process.env, ...env },
  });
  if (result.timedOut || result.code !== 0) {
    return unavailable(
      "claude",
      classifyProcessFailure(result),
      excerpt(result.stderr || result.stdout || "claude --version failed"),
      source,
    );
  }
  const version = result.stdout.trim() || "installed";
  return unavailable(
    "claude",
    "no-catalog-interface",
    `claude ${version} exposes no model-listing command; ` +
      "'claude --help' documents --model as accepting a named alias " +
      "(e.g. 'fable', 'opus', 'sonnet') or a full model name as free-form " +
      "examples, not a catalog this can enumerate.",
    source,
  );
}

// A provider function normally resolves with an ok/unavailable entry itself,
// but an injected `execute` that rejects or throws synchronously (rather than
// resolving with a failed process result, as the real core.mjs `run` always
// does) would otherwise reject the whole `Promise.all` below and take the
// other, independently-succeeded providers down with it. Catching here keeps
// each provider's outcome isolated no matter how its `execute` misbehaves.
async function safeCatalog(provider, source, attempt) {
  try {
    return await attempt();
  } catch (err) {
    return unavailable(
      provider,
      "execute-error",
      excerpt(err?.stack ?? err?.message ?? String(err)),
      source,
    );
  }
}

/**
 * Queries every executor in {@link CATALOG_PROVIDERS} for its current model
 * catalog, in parallel and independently.
 *
 * One executor failing never blocks or alters another's result: each provider
 * function catches its own process outcome, and a rejection or synchronous
 * throw from the injected `execute` itself is also caught per-provider, so it
 * never takes down the other providers' already-settled results.
 *
 * @param {object} [options={}] - Injectable environment for tests.
 * @param {Function} [options.execute=run] - Command runner.
 * @param {NodeJS.ProcessEnv} [options.env=process.env] - Environment passed to each command.
 * @param {string} [options.home=os.homedir()] - Home directory Codex falls back to.
 * @param {string} [options.codexHome] - Explicit Codex home, when the caller sets its own.
 * @returns {Promise<Record<string, object>>} One entry per provider in
 * {@link CATALOG_PROVIDERS}, each `{provider, status, source, models}` and,
 * when `status` is `"unavailable"`, `reasonCode` and `reason`.
 */
export async function fetchModelCatalog({
  execute = run,
  env = process.env,
  home = os.homedir(),
  codexHome,
} = {}) {
  const [claude, codex, agy] = await Promise.all([
    safeCatalog("claude", "claude --version", () =>
      claudeCatalog({ execute, env }),
    ),
    safeCatalog("codex", "codex debug models", () =>
      codexCatalog({ execute, env, home, codexHome }),
    ),
    safeCatalog("agy", "agy models", () => agyCatalog({ execute, env })),
  ]);
  return { claude, codex, agy };
}

/**
 * Reasons {@link validateModelChoice} can reject a choice.
 *
 * The first four judge the `choice` string against a well-formed catalog;
 * `malformed-catalog` is different in kind, it means the catalog argument
 * itself is not a usable {@link fetchModelCatalog} result (missing, not an
 * object, or a provider entry whose `models` is not an array), which is a
 * caller bug rather than anything the user typed.
 */
export const CHOICE_REJECTION_REASONS = Object.freeze([
  "malformed-choice",
  "unknown-provider",
  "provider-unavailable",
  "model-not-in-catalog",
  "malformed-catalog",
]);

function ownEntry(catalog, provider) {
  return Object.hasOwn(catalog, provider) ? catalog[provider] : undefined;
}

/**
 * Validates a `provider:model` choice against a fetched catalog.
 *
 * This is the contract org-draft and adjust must call before persisting a
 * user's model choice; neither is wired to it yet. The four choice-shaped
 * rejection reasons are kept distinct so a caller can tell a typo from a
 * model the catalog simply does not (or no longer) list, from an executor it
 * could not reach at all. Never throws: a `catalog` that is not a well-formed
 * {@link fetchModelCatalog} result (null, a provider entry missing `models`,
 * `models` not being an array, or a corrupt item inside it) is rejected with
 * `malformed-catalog` instead of raising.
 *
 * @param {Record<string, object>} catalog - Result of {@link fetchModelCatalog}.
 * @param {string} choice - Value such as `codex:gpt-6-astra`.
 * @returns {{ok: boolean, provider?: string, model?: string, reasonCode?: string, reason?: string}}
 * `{ok: true, provider, model}` when the choice is in the catalog, otherwise
 * `{ok: false, reasonCode, reason}` with `reasonCode` one of
 * {@link CHOICE_REJECTION_REASONS}.
 */
export function validateModelChoice(catalog, choice) {
  const match = /^([a-z][a-z0-9_-]*):(\S+)$/.exec(choice ?? "");
  if (!match) {
    return {
      ok: false,
      reasonCode: "malformed-choice",
      reason: `Model choice must be provider:model, got: ${JSON.stringify(choice ?? null)}`,
    };
  }
  const [, provider, model] = match;
  if (
    catalog === null ||
    typeof catalog !== "object" ||
    Array.isArray(catalog)
  ) {
    return {
      ok: false,
      reasonCode: "malformed-catalog",
      reason: `Catalog must be a provider record, got: ${JSON.stringify(catalog ?? null)}`,
    };
  }
  const entry = ownEntry(catalog, provider);
  if (!entry) {
    return {
      ok: false,
      reasonCode: "unknown-provider",
      reason: `Catalog has no entry for provider: ${provider}`,
    };
  }
  if (entry.status !== "ok") {
    return {
      ok: false,
      reasonCode: "provider-unavailable",
      reason: entry.reason ?? `Provider ${provider} is unavailable`,
    };
  }
  if (!Array.isArray(entry.models)) {
    return {
      ok: false,
      reasonCode: "malformed-catalog",
      reason: `Catalog entry for ${provider} has no models array`,
    };
  }
  const found = entry.models.find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      candidate.id === model,
  );
  if (!found) {
    return {
      ok: false,
      reasonCode: "model-not-in-catalog",
      reason: `Model ${model} is not in the current ${provider} catalog`,
    };
  }
  return { ok: true, provider, model };
}
