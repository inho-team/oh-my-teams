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
 * does not call it from anywhere itself. Each fetched entry also carries a
 * deterministic `catalogRevision` (over the selectable values only, not the
 * fetch time or raw error text) so a caller can tell whether what a user saw
 * is still current, and {@link revalidateModelChoices} is the public contract
 * for re-checking a whole batch of choices against a freshly fetched catalog
 * right before a save, one executor's failure at a time.
 */
import { createHash } from "node:crypto";
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

function unavailable(
  provider,
  reasonCode,
  reason,
  source,
  executorVersion = null,
) {
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
    executorVersion,
    models: [],
  };
}

function ok(provider, source, models, executorVersion = null) {
  return { provider, status: "ok", source, executorVersion, models };
}

// Version is best-effort evidence, independent of whether the catalog
// command itself succeeded: a caller a few lines above may already know its
// executor is unreachable while this can still say which build is installed.
// Any failure here (missing binary, non-zero exit, a rejecting or throwing
// injected `execute`) reports the version as unknown (`null`) rather than a
// second failure mode alongside the catalog's own `reasonCode`.
async function fetchExecutorVersion(argv, execute, env) {
  try {
    const result = await execute(argv, {
      timeoutMs: 60000,
      env: { ...process.env, ...env },
    });
    if (result.timedOut || result.code !== 0) return null;
    const text = (result.stdout ?? "").trim();
    return text || null;
  } catch {
    return null;
  }
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
  const [{ models: raw, error, reasonCode }, executorVersion] =
    await Promise.all([
      fetchCodexModelCatalog({ codexHome: resolvedHome, env, execute }),
      fetchExecutorVersion(["codex", "--version"], execute, env),
    ]);
  if (error)
    return unavailable(
      "codex",
      reasonCode ?? "command-failed",
      error,
      source,
      executorVersion,
    );

  const listed = raw.filter((model) => model.visibility === "list");
  if (listed.length === 0) {
    return unavailable(
      "codex",
      "empty-catalog",
      "codex debug models returned no visibility:list entry",
      source,
      executorVersion,
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
  return ok("codex", source, models, executorVersion);
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
  const [result, executorVersion] = await Promise.all([
    execute(["agy", "models"], {
      timeoutMs: 60000,
      env: { ...process.env, ...env },
    }),
    fetchExecutorVersion(["agy", "--version"], execute, env),
  ]);
  if (result.timedOut || result.code !== 0) {
    return unavailable(
      "agy",
      classifyProcessFailure(result),
      excerpt(result.stderr || result.stdout || "agy models failed"),
      source,
      executorVersion,
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
        executorVersion,
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
      executorVersion,
    );
  }
  return ok("agy", source, models, executorVersion);
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
      null,
    );
  }
  const executorVersion = result.stdout.trim() || null;
  return unavailable(
    "claude",
    "no-catalog-interface",
    `claude ${executorVersion ?? "installed"} exposes no model-listing command; ` +
      "'claude --help' documents --model as accepting a named alias " +
      "(e.g. 'fable', 'opus', 'sonnet') or a full model name as free-form " +
      "examples, not a catalog this can enumerate.",
    source,
    executorVersion,
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
      null,
    );
  }
}

// A model's selectable identity is its id and the sorted set of efforts it
// supports; sorting both the models and each one's efforts here is what
// makes the revision below insensitive to the order a provider happens to
// print them in.
function canonicalModels(models) {
  return [...models]
    .map((model) => ({
      id: model.id,
      efforts: [...(model.efforts ?? [])].sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function hashCanonical(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// The revision must depend only on what a caller can actually choose from:
// provider, status, and — mutually exclusively — either the failure reason
// code or the sorted model/effort set. `fetchedAt` and the free-form `reason`
// text are deliberately left out, so a revision is stable across repeated
// fetches that see the same selectable values, and a change in the models or
// efforts a provider offers is the only thing that ever moves it.
function computeCatalogRevision(entry) {
  return hashCanonical({
    provider: entry.provider,
    status: entry.status,
    reasonCode: entry.status === "ok" ? null : entry.reasonCode,
    models: entry.status === "ok" ? canonicalModels(entry.models) : [],
  });
}

// The three providers are always looked up by name in CATALOG_PROVIDERS
// order (fixed at module load, not by which Promise.all entry settles
// first), so this input's key order is already deterministic without an
// extra sort.
function computeOverallRevision(catalog) {
  return hashCanonical(
    CATALOG_PROVIDERS.map((provider) => ({
      provider,
      catalogRevision: catalog[provider].catalogRevision,
    })),
  );
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
 * Each provider entry also carries `executorVersion` (the installed CLI's own
 * reported version, or `null` when that could not be determined — always
 * best-effort and independent of catalog `status`) and `catalogRevision`, a
 * deterministic hash of exactly that provider's selectable values (see
 * {@link computeCatalogRevision}). The result itself carries `fetchedAt` (this
 * call's timestamp) and an overall `catalogRevision` combining all three
 * providers', so a caller can tell whether the set of choices a user saw
 * changed since without comparing raw catalogs field by field.
 *
 * @param {object} [options={}] - Injectable environment for tests.
 * @param {Function} [options.execute=run] - Command runner.
 * @param {NodeJS.ProcessEnv} [options.env=process.env] - Environment passed to each command.
 * @param {string} [options.home=os.homedir()] - Home directory Codex falls back to.
 * @param {string} [options.codexHome] - Explicit Codex home, when the caller sets its own.
 * @param {() => string} [options.now] - Clock for `fetchedAt`, injectable for deterministic tests.
 * @returns {Promise<Record<string, object>>} One entry per provider in
 * {@link CATALOG_PROVIDERS}, each `{provider, status, source, executorVersion,
 * catalogRevision, models}` and, when `status` is `"unavailable"`,
 * `reasonCode` and `reason`; plus top-level `fetchedAt` and `catalogRevision`.
 */
export async function fetchModelCatalog({
  execute = run,
  env = process.env,
  home = os.homedir(),
  codexHome,
  now = () => new Date().toISOString(),
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
  const catalog = { claude, codex, agy };
  for (const provider of CATALOG_PROVIDERS) {
    catalog[provider] = {
      ...catalog[provider],
      catalogRevision: computeCatalogRevision(catalog[provider]),
    };
  }
  return {
    ...catalog,
    fetchedAt: now(),
    catalogRevision: computeOverallRevision(catalog),
  };
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
  "effort-not-supported",
]);

function ownEntry(catalog, provider) {
  return Object.hasOwn(catalog, provider) ? catalog[provider] : undefined;
}

/**
 * Validates a `provider:model` choice against a fetched catalog.
 *
 * This is the contract org-draft and adjust must call before persisting a
 * user's model choice; neither is wired to it yet. The choice-shaped
 * rejection reasons are kept distinct so a caller can tell a typo from a
 * model the catalog simply does not (or no longer) list, from an executor it
 * could not reach at all. Never throws: a `catalog` that is not a well-formed
 * {@link fetchModelCatalog} result (null, a provider entry missing `models`,
 * `models` not being an array, or a corrupt item inside it) is rejected with
 * `malformed-catalog` instead of raising.
 *
 * When `effort` is given, it is checked against the matched model's
 * `efforts`. A provider that lists efforts for the model rejects one it does
 * not support with `effort-not-supported`. A provider whose catalog never
 * reports effort information for any model (agy today) is not guessed at or
 * checked against an invented allow-list: the choice still passes, with
 * `effortChecked: false` marking that the effort itself went unverified.
 *
 * @param {Record<string, object>} catalog - Result of {@link fetchModelCatalog}.
 * @param {string} choice - Value such as `codex:gpt-6-astra`.
 * @param {string} [effort] - Reasoning effort the choice was made with, if any.
 * @returns {{ok: boolean, provider?: string, model?: string, effortChecked?: boolean, reasonCode?: string, reason?: string}}
 * `{ok: true, provider, model}` when the choice is in the catalog (plus
 * `effortChecked` when `effort` was given), otherwise `{ok: false, reasonCode,
 * reason}` with `reasonCode` one of {@link CHOICE_REJECTION_REASONS}.
 */
export function validateModelChoice(catalog, choice, effort) {
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
  if (effort !== undefined && effort !== null) {
    const efforts = Array.isArray(found.efforts) ? found.efforts : [];
    if (efforts.length === 0) {
      return { ok: true, provider, model, effortChecked: false };
    }
    if (!efforts.includes(effort)) {
      return {
        ok: false,
        reasonCode: "effort-not-supported",
        reason: `Model ${model} does not support effort ${JSON.stringify(effort)}; ${provider} lists: ${efforts.join(", ")}`,
      };
    }
    return { ok: true, provider, model, effortChecked: true };
  }
  return { ok: true, provider, model };
}

/**
 * Statuses {@link revalidateModelChoices} assigns each selection.
 *
 * `valid` and `changed` both pass validation against the freshly fetched
 * catalog; they differ only in whether the provider's `catalogRevision` is
 * the same one the caller recorded when the user made this choice. `invalid`
 * means the fresh catalog rejects the choice (via {@link validateModelChoice})
 * or names a provider this module does not recognize, or a selection asked
 * for host-default delegation while also naming a concrete model. `unavailable`
 * means the provider's fresh lookup itself failed, so the choice could not be
 * checked at all. `delegated` is a host-default delegation the executor
 * answered to at all; it deliberately never shares its meaning with `valid`
 * or `changed`, since neither this module nor the caller checked any concrete
 * model against the catalog for it — see {@link revalidateOne}'s `hostDefault`
 * branch for exactly what a delegation needs before it is `savable`.
 */
export const REVALIDATION_STATUSES = Object.freeze([
  "valid",
  "changed",
  "invalid",
  "unavailable",
  "delegated",
]);

/**
 * The three-value read {@link revalidateOne} gives for whether a provider's
 * executor is actually present, used only for a host-default delegation
 * (a concrete model selection never needs this: a failed fresh lookup on its
 * own provider already routes it to `unavailable` without asking whether the
 * executable itself exists).
 *
 * `installed` requires positive evidence this module directly observed: a
 * confirmed `executorVersion` string, or a listing command that structurally
 * has none (`no-catalog-interface`) but still answered, which is itself a
 * response from a present executable. `not-installed` is the one reason code
 * that names a confirmed absence (the process could not be spawned at all).
 * Every other failure — `command-failed` with no version evidence,
 * `unparseable`, `empty-catalog`, or `execute-error` (the injected `execute`
 * itself rejected or threw, so no process response of any kind came back) —
 * is `unknown`: this module has no confirmed evidence either way, and never
 * guesses installed from the mere absence of a `not-installed` code.
 */
export const EXECUTOR_INSTALL_STATES = Object.freeze([
  "installed",
  "not-installed",
  "unknown",
]);

function executorInstallState(entry, entryStatus) {
  if (entryStatus === "ok") return "installed";
  if (entry?.reasonCode === "not-installed") return "not-installed";
  if (entry?.reasonCode === "no-catalog-interface") return "installed";
  if (entry?.executorVersion) return "installed";
  return "unknown";
}

function malformedSelection(selection, hostDefault) {
  return {
    key: typeof selection?.key === "string" ? selection.key : null,
    provider:
      typeof selection?.provider === "string" ? selection.provider : null,
    model: selection?.model ?? null,
    status: "invalid",
    reasonCode: "malformed-selection",
    reason: `Selection is missing a usable key, provider, or model: ${JSON.stringify(selection ?? null)}`,
    hostDefault: Boolean(hostDefault),
    catalogVerified: false,
    preserved: false,
    savable: false,
  };
}

// Every selection is judged from its own provider's entry only, so one
// provider's failed fresh lookup can never change the status this returns
// for a different provider's selection (independent-failure-preservation).
function revalidateOne(catalog, selection) {
  const {
    key,
    provider,
    model,
    effort,
    catalogRevision,
    hostDefault = false,
    adapterContractConfirmed = false,
    touched = true,
  } = selection ?? {};
  const hasModel = typeof model === "string" && model.length > 0;
  if (
    typeof key !== "string" ||
    !key ||
    typeof provider !== "string" ||
    (!hostDefault && !hasModel)
  ) {
    return malformedSelection(selection, hostDefault);
  }
  if (!CATALOG_PROVIDERS.includes(provider)) {
    return {
      key,
      provider,
      model: model ?? null,
      status: "invalid",
      reasonCode: "unknown-provider",
      reason: `Catalog has no entry for provider: ${provider}`,
      hostDefault: Boolean(hostDefault),
      catalogVerified: false,
      preserved: false,
      savable: false,
    };
  }

  // A delegation names no concrete model by definition; a selection that
  // sets hostDefault while also naming one is a conflicting input, not a
  // model to quietly discard and fall through to delegation for.
  if (hostDefault && hasModel) {
    return {
      key,
      provider,
      model,
      status: "invalid",
      reasonCode: "host-default-with-model",
      reason: `Selection asks for ${provider}'s host-default delegation but also names model ${model}; a delegation must leave model unset`,
      hostDefault: true,
      catalogVerified: false,
      preserved: false,
      savable: false,
    };
  }

  const entry = catalog?.[provider];
  const entryStatus =
    entry && typeof entry === "object" ? entry.status : undefined;

  if (hostDefault) {
    // "Installed" is judged only from evidence this module itself observed
    // about the executable's presence (see EXECUTOR_INSTALL_STATES), never
    // from whether its catalog lookup itself succeeded: a successful lookup
    // proves this module could list models, not that the caller's adapter
    // execution contract for delegating to this executor is wired up, nor
    // that the account holds any particular subscription or model access.
    const installState = executorInstallState(entry, entryStatus);
    if (installState === "not-installed") {
      const preserved = !touched;
      return {
        key,
        provider,
        model: null,
        status: "unavailable",
        reasonCode: entry?.reasonCode ?? "not-installed",
        reason: entry?.reason ?? `Provider ${provider} is not installed`,
        hostDefault: true,
        catalogVerified: false,
        delegationGrounds: {
          explicitRequest: true,
          executorInstalled: "not-installed",
          adapterContractConfirmed: false,
        },
        preserved,
        savable: preserved,
      };
    }
    if (installState === "unknown") {
      // No confirmed evidence either way: the failed lookup could mean the
      // executable is missing, or it could mean it is present but broke for
      // an unrelated reason (a bad flag, a timeout, a rejecting `execute`).
      // Never resolved as "installed" from silence, and only savable when
      // preserving an existing, untouched choice this save is not disturbing.
      const preserved = !touched;
      return {
        key,
        provider,
        model: null,
        status: "unavailable",
        reasonCode: entry?.reasonCode ?? "command-failed",
        reason:
          entry?.reason ??
          `Whether ${provider} is installed could not be confirmed: its catalog ` +
            "lookup failed with no version evidence and no answered listing command",
        hostDefault: true,
        catalogVerified: false,
        delegationGrounds: {
          explicitRequest: true,
          executorInstalled: "unknown",
          adapterContractConfirmed: Boolean(adapterContractConfirmed),
        },
        preserved,
        savable: preserved,
      };
    }
    // `hostDefault: true` is this module's contract for "the caller confirms
    // the user explicitly asked for delegation"; it never infers that intent
    // from an absent model. The caller separately attests, via
    // `adapterContractConfirmed`, that the existing adapter's execution
    // contract for this delegation is confirmed — this module cannot check
    // that itself without duplicating host-defaults.mjs's ownership of it.
    // Missing or false is never treated as evidence either way, only as
    // "not yet confirmed": the delegation is recorded (so the caller can see
    // what is and is not confirmed) but held back from being savable.
    //
    // `executorInstalled` here is this module's own confirmed observation;
    // `adapterContractConfirmed` is the caller's unverified attestation. The
    // two are kept as separate keys precisely so neither reader nor caller
    // can mistake one for the other.
    const grounds = {
      explicitRequest: true,
      executorInstalled: "installed",
      adapterContractConfirmed: Boolean(adapterContractConfirmed),
    };
    if (!grounds.adapterContractConfirmed) {
      return {
        key,
        provider,
        model: null,
        status: "delegated",
        reasonCode: "adapter-contract-not-confirmed",
        reason: `${provider}'s host-default delegation is not savable: the caller did not confirm the existing adapter's execution contract for it`,
        hostDefault: true,
        catalogVerified: false,
        delegationGrounds: grounds,
        preserved: false,
        savable: false,
      };
    }
    return {
      key,
      provider,
      model: null,
      status: "delegated",
      reasonCode: null,
      reason: null,
      hostDefault: true,
      catalogVerified: false,
      delegationGrounds: grounds,
      preserved: false,
      savable: true,
    };
  }

  if (entryStatus !== "ok") {
    // Not touched this save = an existing choice the caller is not changing
    // right now; its own provider being down does not force a rejection, but
    // it also did not just pass revalidation, so it is marked unvalidated
    // rather than reported as a fresh pass.
    const preserved = !touched;
    return {
      key,
      provider,
      model: model ?? null,
      status: "unavailable",
      reasonCode: entry?.reasonCode ?? "command-failed",
      reason: entry?.reason ?? `Provider ${provider} is unavailable`,
      hostDefault: false,
      catalogVerified: false,
      preserved,
      savable: preserved,
    };
  }

  const result = validateModelChoice(catalog, `${provider}:${model}`, effort);
  if (!result.ok) {
    return {
      key,
      provider,
      model,
      status: "invalid",
      reasonCode: result.reasonCode,
      reason: result.reason,
      hostDefault: false,
      catalogVerified: true,
      preserved: false,
      savable: false,
    };
  }

  const freshRevision = entry.catalogRevision;
  const changed = catalogRevision == null || catalogRevision !== freshRevision;
  return {
    key,
    provider,
    model: result.model,
    status: changed ? "changed" : "valid",
    reasonCode: changed ? "catalog-revision-changed" : null,
    reason: changed
      ? `${provider}'s catalog revision changed since this choice was last seen`
      : null,
    hostDefault: false,
    catalogVerified: true,
    preserved: false,
    savable: true,
    ...(result.effortChecked !== undefined
      ? { effortChecked: result.effortChecked }
      : {}),
  };
}

/**
 * Revalidates a batch of selections against a freshly fetched catalog, right
 * before persisting them.
 *
 * Every selection is judged independently ({@link revalidateOne}): one
 * provider's fresh lookup failing never changes another provider's
 * selection's status. A selection the caller marks `touched: false` (kept
 * from before, not picked or changed this time) is preserved rather than
 * rejected when its own provider is the one that failed, but that
 * preservation is not reported as a fresh pass — {@link REVALIDATION_STATUSES}
 * marks it `unavailable` with `preserved: true` and `catalogVerified: false`.
 * This function never fetches anything itself; the caller fetches `catalog`
 * with {@link fetchModelCatalog} first and passes both in, so no old or
 * built-in catalog is ever substituted here.
 *
 * A malformed `selections` argument (not an array at all) is distinguished
 * from a genuinely empty batch: the former cannot be judged and is reported
 * with `malformed: true` and `savable: false`, while an actual `[]` (a save
 * that touches no model selection at all) is `savable: true` with an empty
 * `selections` list.
 *
 * @param {Record<string, object>} catalog - Freshly fetched {@link fetchModelCatalog} result.
 * @param {Array<{key: string, provider: string, model?: string|null, effort?: string,
 * catalogRevision?: string, hostDefault?: boolean, adapterContractConfirmed?: boolean,
 * touched?: boolean}>} selections -
 * Choices to check. `touched` defaults to `true` (a fresh pick or change);
 * pass `false` for an existing selection the caller is not changing right
 * now. `hostDefault: true` marks a host-default delegation the user
 * explicitly asked for; `model` must then be left unset — a selection that
 * sets both is rejected as `invalid` rather than having its model silently
 * discarded. A delegation is only `savable` once the executor's own
 * {@link EXECUTOR_INSTALL_STATES} reads `installed` (this module's own
 * confirmed evidence, never the caller's) and the caller separately sets
 * `adapterContractConfirmed: true` (the caller's own attestation, never
 * verified here) to confirm the existing adapter's execution contract for
 * it; a missing or false value on either is never inferred as confirmation.
 * @param {object} [options={}] - Injectable environment for tests.
 * @param {() => string} [options.now] - Clock for `verifiedAt`.
 * @returns {{verifiedAt: string, catalogRevision: string|null, providerRevisions: Record<string, string|null>, selections: object[], malformed: boolean, savable: boolean}}
 * `verifiedAt` and the revisions this check used, one entry per input
 * selection (see {@link REVALIDATION_STATUSES}), `malformed` (true only when
 * `selections` itself was not an array), and `savable`, true only when
 * `selections` was a well-formed array and every entry's own `savable` is true.
 */
export function revalidateModelChoices(
  catalog,
  selections,
  { now = () => new Date().toISOString() } = {},
) {
  const malformed = !Array.isArray(selections);
  const list = malformed ? [] : selections;
  const results = list.map((selection) => revalidateOne(catalog, selection));
  const providerRevisions = {};
  for (const provider of CATALOG_PROVIDERS) {
    providerRevisions[provider] =
      catalog && typeof catalog === "object" && catalog[provider]
        ? (catalog[provider].catalogRevision ?? null)
        : null;
  }
  return {
    verifiedAt: now(),
    catalogRevision:
      catalog &&
      typeof catalog === "object" &&
      typeof catalog.catalogRevision === "string"
        ? catalog.catalogRevision
        : null,
    providerRevisions,
    selections: results,
    malformed,
    savable: !malformed && results.every((result) => result.savable),
  };
}
