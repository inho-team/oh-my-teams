/**
 * Reports which model a host-default profile would run right now.
 *
 * A profile saved as `claude:default` or `codex:default` stores `model: null`,
 * and the option that saved it said nothing about what that resolves to. A user
 * who picked "Codex 기본" believed it meant one model while Codex launched its
 * first listed catalog entry. This module reads the same sources the CLIs read,
 * so the question and the formation report can name the model, and says so when
 * the answer cannot be determined instead of guessing one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, run } from "./core.mjs";

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// Only a top-level key counts: the same key inside `[profiles.x]` applies only
// when that profile is selected, which an Orca launch does not do.
function topLevelTomlString(text, key) {
  for (const line of (text ?? "").split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = new RegExp(
      `^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')\\s*(?:#.*)?$`,
    ).exec(line);
    if (match) return match[1] ?? match[2];
  }
  return null;
}

function readSettingsModel(file) {
  const text = readText(file);
  if (text === null) return null;
  try {
    const model = JSON.parse(text.replace(/^\uFEFF/, "")).model;
    return typeof model === "string" && model.trim() ? model : null;
  } catch {
    return null;
  }
}

/**
 * Ranks a raw `codex debug models` entry so the lowest-priority listed model
 * sorts first; a priority that is not a number sorts after every numbered one
 * instead of making the whole order undefined.
 *
 * @param {object} model - Raw catalog entry with an optional `priority`.
 * @returns {number} Sort key; lower runs first.
 */
export const codexModelRank = (model) =>
  Number.isFinite(model.priority) ? model.priority : Number.POSITIVE_INFINITY;

/**
 * Resolves the Codex home a catalog or default-model lookup should read.
 *
 * Orca may launch Codex under its own `CODEX_HOME` instead of the user's, so
 * an explicit override always wins over the environment and the home guess.
 *
 * @param {object} [options={}] - Resolution inputs.
 * @param {string} [options.home=os.homedir()] - Fallback home directory.
 * @param {NodeJS.ProcessEnv} [options.env=process.env] - Environment consulted for `CODEX_HOME`.
 * @param {string} [options.codexHome] - Explicit override from a caller that sets its own.
 * @returns {string} Codex home directory to read `config.toml` from and pass as `CODEX_HOME`.
 */
export function resolveCodexHome({
  home = os.homedir(),
  env = process.env,
  codexHome,
} = {}) {
  return codexHome || env.CODEX_HOME || path.join(home, ".codex");
}

/**
 * Runs `codex debug models` and returns its parsed catalog or a failure reason.
 *
 * Host-default resolution and the model-catalog command both need the raw
 * entries this reads; each derives a different projection of them (the
 * best-ranked listed slug versus every field a caller might display), so the
 * process call and its JSON parsing live here once instead of twice.
 *
 * @param {object} [options={}] - Injectable environment for tests.
 * @param {string} options.codexHome - Codex home to pass as `CODEX_HOME`.
 * @param {NodeJS.ProcessEnv} [options.env=process.env] - Environment to read.
 * @param {Function} [options.execute=run] - Command runner.
 * @returns {Promise<{models: object[] | null, error: string | null, reasonCode: string | null}>}
 * Raw catalog entries as `codex debug models` prints them, or a failure with
 * a stable `reasonCode` of `not-installed`, `command-failed`, or `unparseable`.
 */
export async function fetchCodexModelCatalog({
  codexHome,
  env = process.env,
  execute = run,
} = {}) {
  const result = await execute(["codex", "debug", "models"], {
    timeoutMs: 60000,
    env: { ...process.env, ...env, CODEX_HOME: codexHome },
  });
  if (result.timedOut) {
    return {
      models: null,
      error: "codex debug models timed out",
      reasonCode: "command-failed",
    };
  }
  if (result.code !== 0) {
    return {
      models: null,
      error: result.stderr || result.stdout || "codex debug models failed",
      reasonCode: /ENOENT/.test(result.stderr ?? "")
        ? "not-installed"
        : "command-failed",
    };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    assert(Array.isArray(parsed.models), "no models array");
    return { models: parsed.models, error: null, reasonCode: null };
  } catch {
    return {
      models: null,
      error: "codex debug models did not return a JSON catalog",
      reasonCode: "unparseable",
    };
  }
}

async function codexDefault({ home, env, codexHome: explicitHome, execute }) {
  const codexHome = resolveCodexHome({ home, env, codexHome: explicitHome });
  const configFile = path.join(codexHome, "config.toml");
  const configured = topLevelTomlString(readText(configFile), "model");
  const { models: raw, error } = await fetchCodexModelCatalog({
    codexHome,
    env,
    execute,
  });
  const listed = (raw ?? [])
    .filter((model) => model.visibility === "list")
    .sort((left, right) => codexModelRank(left) - codexModelRank(right))
    .map((model) => model.slug);
  if (configured) {
    return {
      model: configured,
      source: "config.toml",
      configFile,
      listed,
      error,
    };
  }
  return {
    model: listed[0] ?? null,
    source: listed[0] ? "catalog" : null,
    configFile,
    listed,
    error,
  };
}

function claudeDefault({ home, env, project }) {
  if (env.ANTHROPIC_MODEL) {
    return { model: env.ANTHROPIC_MODEL, source: "env:ANTHROPIC_MODEL" };
  }
  // Local project settings override shared project settings, which override
  // user settings. Managed policy settings are not read, so an organization
  // that enforces a model there is reported as unknown rather than wrong.
  const candidates = [
    ...(project
      ? [
          path.join(project, ".claude", "settings.local.json"),
          path.join(project, ".claude", "settings.json"),
        ]
      : []),
    path.join(home, ".claude", "settings.json"),
  ];
  for (const file of candidates) {
    const model = readSettingsModel(file);
    if (model) return { model, source: file };
  }
  return {
    model: null,
    source: null,
    note: "No model setting found; Claude Code decides and this runtime does not assert which model",
  };
}

/**
 * Resolves the model each host-default provider would launch at this moment.
 *
 * Codex uses the top-level `model` of `$CODEX_HOME/config.toml`, otherwise the
 * lowest-priority `visibility: list` entry of `codex debug models`. Claude uses
 * `ANTHROPIC_MODEL`, then project and user settings `model`, otherwise null.
 * Both answers change when the account or configuration changes.
 *
 * @param {object} [options={}] - Injectable environment for tests.
 * @param {string} [options.home=os.homedir()] - Home directory to read.
 * @param {NodeJS.ProcessEnv} [options.env=process.env] - Environment to read.
 * @param {string} [options.project] - Project whose `.claude` settings apply.
 * @param {string} [options.codexHome] - Codex home the launcher uses, when it
 * sets its own `CODEX_HOME` instead of inheriting the user's.
 * @param {Function} [options.execute=run] - Command runner.
 * @returns {Promise<object>} `codex` and `claude` entries with model and source.
 */
export async function resolveHostDefaults({
  home = os.homedir(),
  env = process.env,
  project,
  codexHome,
  execute = run,
} = {}) {
  return {
    codex: await codexDefault({ home, env, codexHome, execute }),
    claude: claudeDefault({ home, env, project }),
    note: "Defaults follow the account and configuration, so they can change after formation.",
  };
}
