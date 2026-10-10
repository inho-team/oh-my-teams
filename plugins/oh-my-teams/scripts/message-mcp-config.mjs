/**
 * Per-session Message MCP launch arguments for interactive agent CLIs.
 * @module message-mcp-config
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateMessageActor } from "./message-store.mjs";

const serverScript = fileURLToPath(
  new URL("./message-mcp.mjs", import.meta.url),
);

/**
 * Build session-only MCP flags without writing a user's agent configuration.
 * @param {string} provider - Interactive agent provider.
 * @param {string | undefined} stateDir - PM state directory for a kickoff role.
 * @param {string} actor - Role mailbox identity.
 * @param {{orgFile?: string}} [options] - Organization registry for the director.
 * @returns {{argv: string[], available: boolean}} CLI flags and support verdict.
 */
export function messageMcpLaunch(provider, stateDir, actor, { orgFile } = {}) {
  validateMessageActor(actor);
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
