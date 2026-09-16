/** Claude Code CLI adapter: print mode, no tools, no session persistence. */
import {
  agentCliResetHint,
  classifyAgentCliFailure,
  decodeAgentCli,
} from "./shared.mjs";

/**
 * Adapter for the `claude` CLI.
 *
 * The CLI exposes no reasoning-effort selector, so `efforts` is empty and an
 * effort on a Claude profile is rejected as a configuration error rather than
 * silently ignored at a different reasoning depth than the report claims.
 */
export default {
  id: "claude",
  transports: ["process"],
  efforts: [],
  workspaceAccess: true,

  /**
   * Builds the argv and stdin payload for one print-mode Claude call.
   *
   * @param {object} profile - Provider profile with command and optional model.
   * @param {object} context - Call context carrying the prompt.
   * @returns {{argv: string[], input: string}} Command arguments and stdin payload.
   */
  request(profile, context) {
    const argv = [
      ...profile.command,
      "--print",
      "--output-format",
      "json",
      "--tools",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
    ];
    if (profile.model) argv.push("--model", profile.model);
    return { argv, input: context.prompt };
  },

  decode: (stdout) => decodeAgentCli(stdout),
  classifyFailure: (result, decoded) =>
    classifyAgentCliFailure(result, decoded),
  capacityResetHint: (result, decoded) => agentCliResetHint(result, decoded),
};
