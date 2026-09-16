/** Claude Code CLI adapter: print mode, no tools, no session persistence. */
import {
  agentCliResetHint,
  classifyAgentCliFailure,
  decodeAgentCli,
} from "./shared.mjs";

/**
 * Adapter for the `claude` CLI.
 *
 * `claude --help` (2.1.273) documents `--effort <level>` with low, medium,
 * high, xhigh and max. An earlier CLI had no such flag, and this adapter kept
 * rejecting every Claude effort after it appeared, so a Claude role could not
 * have its depth set at all.
 */
export default {
  id: "claude",
  transports: ["process"],
  efforts: ["low", "medium", "high", "xhigh", "max"],
  workspaceAccess: true,

  /**
   * Builds the argv and stdin payload for one print-mode Claude call.
   *
   * @param {object} profile - Provider profile with command and optional model.
   * @param {object} context - Call context carrying the prompt and effort.
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
    if (context.effort) argv.push("--effort", context.effort);
    return { argv, input: context.prompt };
  },

  decode: (stdout) => decodeAgentCli(stdout),
  classifyFailure: (result, decoded) =>
    classifyAgentCliFailure(result, decoded),
  capacityResetHint: (result, decoded) => agentCliResetHint(result, decoded),
};
