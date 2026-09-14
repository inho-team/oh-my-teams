#!/usr/bin/env node
/** Installs or updates oh my teams with verified legacy-plugin migration. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, readJSON, run } from "../plugins/oh-my-teams/scripts/core.mjs";

const PLUGIN_ID = "oh-my-teams@oh-my-teams";
const LEGACY_PLUGIN_ID = "orca@orca-skills";
const CLIENTS = ["claude", "codex"];
const HOSTS = [...CLIENTS, "both"];
const FLAGS = ["--dry-run", "--remove-legacy"];

/**
 * Parses installer host and migration flags.
 *
 * @param {string[]} argv - Arguments excluding executable and script path.
 * @returns {{host: string, dryRun: boolean, removeLegacy: boolean}}
 * Parsed installer options.
 * @throws {Error} For unknown arguments or unsupported hosts.
 */
export function parseInstallArgs(argv) {
  assert(
    argv.every(
      (argument) => HOSTS.includes(argument) || FLAGS.includes(argument),
    ),
    "Usage: install.mjs [claude|codex|both] [--dry-run] [--remove-legacy]",
  );
  const selectedHosts = argv.filter((argument) => HOSTS.includes(argument));
  assert(selectedHosts.length <= 1, "Choose only one installer host");
  return {
    host: selectedHosts[0] ?? "both",
    dryRun: argv.includes("--dry-run"),
    removeLegacy: argv.includes("--remove-legacy"),
  };
}

/**
 * Normalizes Claude or Codex plugin-list JSON into one comparable shape.
 *
 * @param {"claude" | "codex"} client - Plugin host.
 * @param {unknown} payload - Host-specific JSON list response.
 * @returns {{id: string, version: string | null, enabled: boolean}[]}
 * Installed plugin states.
 */
export function pluginStates(client, payload) {
  if (client === "claude") {
    return payload.map((item) => ({
      id: item.id,
      version: item.version ?? null,
      enabled: item.enabled !== false,
    }));
  }
  return (payload.installed ?? [])
    .filter((item) => item.installed !== false)
    .map((item) => ({
      id: item.pluginId,
      version: item.version ?? null,
      enabled: item.enabled !== false,
    }));
}

function requestedClients(host) {
  return CLIENTS.filter((client) => host === "both" || host === client);
}

function legacyAction(client, state, removeLegacy) {
  if (!state.legacyInstalled) return null;
  if (removeLegacy) return "remove-legacy-after-new-install-verification";
  if (client === "codex") return "retain-legacy-and-report-migration-option";
  return state.legacyEnabled
    ? "disable-legacy-after-new-install-verification"
    : "legacy-already-disabled";
}

/**
 * Builds a non-mutating installation plan from current plugin states.
 *
 * @param {object} options - Host, dry-run, and legacy-removal selection.
 * @param {string} root - Marketplace root.
 * @param {string | Record<string, string>} desiredVersion - Desired host version(s).
 * @param {Record<string, object[]>} statesByClient - Current normalized states.
 * @returns {object} Per-client actions and safety facts.
 */
export function buildInstallPlan(
  options,
  root,
  desiredVersion,
  statesByClient,
) {
  const plan = {
    schemaVersion: 1,
    root,
    host: options.host,
    dryRun: options.dryRun,
    removeLegacy: options.removeLegacy,
    clients: {},
  };

  for (const client of requestedClients(options.host)) {
    const before = statesByClient[client];
    const clientVersion =
      typeof desiredVersion === "string"
        ? desiredVersion
        : desiredVersion[client];
    const current = before.find(
      (item) => item.id === PLUGIN_ID && item.enabled,
    );
    const state = {
      before,
      desiredVersion: clientVersion,
      legacyInstalled: before.some((item) => item.id === LEGACY_PLUGIN_ID),
      legacyEnabled: before.some(
        (item) => item.id === LEGACY_PLUGIN_ID && item.enabled,
      ),
      newInstalled: Boolean(current),
      newCurrent: current?.version === clientVersion,
      actions: [],
    };
    if (!state.newInstalled) {
      state.actions.push("register-local-marketplace", "install-oh-my-teams");
    } else if (!state.newCurrent) {
      state.actions.push("update-oh-my-teams");
    }
    const migration = legacyAction(client, state, options.removeLegacy);
    if (migration) state.actions.push(migration);
    plan.clients[client] = state;
  }
  return plan;
}

async function execute(argv, root, commandRunner) {
  const result = await commandRunner(argv, { cwd: root, timeoutMs: 120000 });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  assert(
    result.code === 0 && !result.timedOut,
    `${argv[0]} installation failed; inspect the error before retrying`,
  );
}

async function listPlugins(client, root, commandRunner) {
  const argv =
    client === "claude"
      ? ["claude", "plugin", "list", "--json"]
      : ["codex", "plugin", "list", "--json"];
  const result = await commandRunner(argv, { cwd: root, timeoutMs: 120000 });
  assert(
    result.code === 0 && !result.timedOut,
    `${client} plugin list failed: ${result.stderr || result.stdout}`,
  );
  try {
    return pluginStates(client, JSON.parse(result.stdout));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${client} plugin list did not return JSON`);
    }
    throw error;
  }
}

function assertCurrent(states, client, desiredVersion) {
  assert(
    states.some(
      (item) =>
        item.id === PLUGIN_ID &&
        item.enabled &&
        item.version === desiredVersion,
    ),
    `${client} did not activate the requested plugin version; ` +
      "legacy plugin was not changed",
  );
}

async function installClaude(plan, root, commandRunner) {
  const state = plan.clients.claude;
  if (!state.newInstalled) {
    await execute(
      ["claude", "plugin", "marketplace", "add", root],
      root,
      commandRunner,
    );
    await execute(
      ["claude", "plugin", "install", PLUGIN_ID],
      root,
      commandRunner,
    );
  } else if (!state.newCurrent) {
    await execute(
      ["claude", "plugin", "update", PLUGIN_ID],
      root,
      commandRunner,
    );
  }

  const afterInstall = await listPlugins("claude", root, commandRunner);
  assertCurrent(afterInstall, "Claude", state.desiredVersion);
  const legacy = afterInstall.find((item) => item.id === LEGACY_PLUGIN_ID);
  if (legacy && (plan.removeLegacy || legacy.enabled)) {
    await execute(
      [
        "claude",
        "plugin",
        plan.removeLegacy ? "uninstall" : "disable",
        LEGACY_PLUGIN_ID,
      ],
      root,
      commandRunner,
    );
  }
  state.after = await listPlugins("claude", root, commandRunner);
}

async function installCodex(plan, root, commandRunner) {
  const state = plan.clients.codex;
  if (!state.newInstalled) {
    await execute(
      ["codex", "plugin", "marketplace", "add", root],
      root,
      commandRunner,
    );
    await execute(["codex", "plugin", "add", PLUGIN_ID], root, commandRunner);
  } else if (!state.newCurrent) {
    await execute(["codex", "plugin", "add", PLUGIN_ID], root, commandRunner);
  }

  const afterInstall = await listPlugins("codex", root, commandRunner);
  assertCurrent(afterInstall, "Codex", state.desiredVersion);
  if (
    plan.removeLegacy &&
    afterInstall.some((item) => item.id === LEGACY_PLUGIN_ID)
  ) {
    await execute(
      ["codex", "plugin", "remove", LEGACY_PLUGIN_ID],
      root,
      commandRunner,
    );
  }
  state.after = await listPlugins("codex", root, commandRunner);
}

/**
 * Plans and optionally performs an idempotent two-host plugin installation.
 *
 * The new version is verified before the legacy Claude plugin is disabled or
 * removed. Existing `.orca` organization state is never read or modified.
 *
 * @param {string[]} [argv=process.argv.slice(2)] - Installer arguments.
 * @param {object} [dependencies] - Injectable root and command runner for tests.
 * @returns {Promise<object>} Final installation plan with before/after states.
 * @throws {Error} For invalid input, list failures, or unverified installation.
 */
export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const root =
    dependencies.root ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const commandRunner = dependencies.commandRunner ?? run;
  const desiredVersion = {
    claude: readJSON(path.join(root, "package.json")).version,
    codex: readJSON(
      path.join(root, "plugins/oh-my-teams/.codex-plugin/plugin.json"),
    ).version,
  };
  const options = parseInstallArgs(argv);
  const statesByClient = {};
  for (const client of requestedClients(options.host)) {
    statesByClient[client] = await listPlugins(client, root, commandRunner);
  }
  const plan = buildInstallPlan(options, root, desiredVersion, statesByClient);
  if (options.dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return plan;
  }

  if (plan.clients.claude) await installClaude(plan, root, commandRunner);
  if (plan.clients.codex) await installCodex(plan, root, commandRunner);
  console.log(JSON.stringify(plan, null, 2));
  console.log(
    "Installed oh my teams. Start a new conversation and invoke team-setup. " +
      "Existing .orca organizations are reused. Legacy removal occurs only " +
      "with --remove-legacy after new-plugin verification.",
  );
  return plan;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
