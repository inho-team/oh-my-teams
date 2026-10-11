/**
 * Per-session Message MCP launch arguments for interactive agent CLIs.
 * @module message-mcp-config
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { validateMessageActor } from "./message-store.mjs";

const serverScript = fileURLToPath(
  new URL("./message-mcp.mjs", import.meta.url),
);

/**
 * Checks the dependency from the MCP server's own installation path, rather
 * than from the launching agent's project. A plugin cache can contain its
 * source and lockfile while its production node_modules are absent.
 *
 * @param {{resolve?: Function}} [options] - Resolver injection for tests.
 * @returns {{ready: boolean, packagePath?: string, reason?: string}} Startup dependency verdict.
 */
export function messageMcpDependencyStatus({ resolve } = {}) {
  const checkedAt = new Date().toISOString();
  const resolvePackage = resolve ?? createRequire(serverScript).resolve;
  try {
    return {
      ready: true,
      packagePath: resolvePackage("@modelcontextprotocol/sdk/package.json"),
      checkedAt,
      source: "message-mcp-installation-probe",
    };
  } catch (error) {
    return {
      ready: false,
      reason:
        "Message MCP dependency @modelcontextprotocol/sdk is unavailable from the " +
        "plugin installation; prepare that installation before launching a role and retry startup verification",
      error: error.code ?? error.name,
      checkedAt,
      source: "message-mcp-installation-probe",
    };
  }
}

/**
 * Build session-only MCP flags without writing a user's agent configuration.
 * @param {string} provider - Interactive agent provider.
 * @param {string | undefined} stateDir - PM state directory for a kickoff role.
 * @param {string} actor - Role mailbox identity.
 * @param {{orgFile?: string}} [options] - Organization registry for the director.
 * @returns {{argv: string[], available: boolean}} CLI flags and support verdict.
 */
export function messageMcpLaunch(
  provider,
  stateDir,
  actor,
  { orgFile, dependencyStatus = messageMcpDependencyStatus() } = {},
) {
  validateMessageActor(actor);
  if (!dependencyStatus.ready) {
    return {
      argv: [],
      available: false,
      startup: "dependency-unavailable",
      reason: dependencyStatus.reason,
      source: dependencyStatus.source,
      checkedAt: dependencyStatus.checkedAt,
    };
  }
  const command = process.execPath;
  const args = [
    serverScript,
    ...(orgFile
      ? ["--org", path.resolve(orgFile)]
      : ["--state", path.resolve(stateDir)]),
    "--actor",
    actor,
  ];
  if (provider === "claude") {
    return {
      argv: [
        "--mcp-config",
        JSON.stringify({ mcpServers: { omt_message: { command, args } } }),
      ],
      available: true,
    };
  }
  if (provider === "codex") {
    const encoded = `{command=${JSON.stringify(command)},args=[${args.map((value) => JSON.stringify(value)).join(",")}]}`;
    return {
      argv: ["--config", `mcp_servers.omt_message=${encoded}`],
      available: true,
    };
  }
  return { argv: [], available: false };
}

/**
 * Refuses a role startup when its requested Message MCP could not start.
 * Provider non-support remains a capability verdict, not a dependency error.
 *
 * @param {{available: boolean, startup?: string, reason?: string}} launch - MCP launch verdict.
 * @returns {void}
 * @throws {Error} When the installed MCP SDK is unavailable.
 */
export function assertMessageMcpStartup(launch) {
  if (launch?.startup === "dependency-unavailable") {
    const detail = [
      `Message MCP startup blocked: ${launch.reason ?? "installation dependency unavailable"}`,
      `source=${launch.source ?? "message-mcp-installation-probe"}`,
      `checkedAt=${launch.checkedAt ?? "unknown"}`,
      "nextOwner=director",
      "nextAction=repair-plugin-installation-and-retry-role-launch",
    ].join("; ");
    const error = new Error(detail);
    error.messageMcpStartup = {
      status: "blocked",
      reason: launch.reason ?? "installation dependency unavailable",
      source: launch.source ?? "message-mcp-installation-probe",
      checkedAt: launch.checkedAt ?? null,
      nextOwner: "director",
      nextAction: "repair-plugin-installation-and-retry-role-launch",
    };
    throw error;
  }
}
