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
import { run } from "./core.mjs";

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

const rank = (model) =>
  Number.isFinite(model.priority) ? model.priority : Number.POSITIVE_INFINITY;

async function codexDefault({ home, env, codexHome: explicitHome, execute }) {
  const codexHome = explicitHome || env.CODEX_HOME || path.join(home, ".codex");
  const configFile = path.join(codexHome, "config.toml");
  const configured = topLevelTomlString(readText(configFile), "model");
  const result = await execute(["codex", "debug", "models"], {
    timeoutMs: 60000,
    env: { ...process.env, ...env, CODEX_HOME: codexHome },
  });
  let listed = [];
  let error = null;
  if (result.timedOut) {
    error = "codex debug models timed out";
  } else if (result.code !== 0) {
    error = result.stderr || result.stdout || "codex debug models failed";
  } else {
    try {
      listed = JSON.parse(result.stdout)
        .models.filter((model) => model.visibility === "list")
        // A priority that is not a number sorts after every numbered one
        // instead of making the whole order undefined.
        .sort((left, right) => rank(left) - rank(right))
        .map((model) => model.slug);
    } catch {
      error = "codex debug models did not return a JSON catalog";
    }
  }
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
