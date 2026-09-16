/** Codex CLI adapter: ephemeral read-only `exec` runs with JSONL output. */
import {
  agentCliResetHint,
  classifyAgentCliFailure,
  decodeAgentCli,
} from "./shared.mjs";

/**
 * Adapter for the `codex` CLI.
 *
 * Codex exposes no `exec` effort flag; its levels come from the account's model
 * catalog and travel as a `--config model_reasoning_effort=<value>` override.
 * Codex does not reject an unknown value, so the runtime has to.
 */
export default {
  id: "codex",
  transports: ["process"],
  efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  workspaceAccess: true,

  /**
   * Builds the argv and stdin payload for one ephemeral Codex `exec` call.
   *
   * @param {object} profile - Provider profile with command and optional model.
   * @param {object} context - Call context with prompt, cwd, and effort.
   * @returns {{argv: string[], input: string}} Command arguments and stdin payload.
   */
  request(profile, context) {
    const argv = [
      ...profile.command,
      "exec",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--json",
      "--cd",
      context.cwd,
    ];
    if (profile.model) argv.push("--model", profile.model);
    // The long name is deliberate: `-c` means `--continue` on the Agy CLI, so the
    // short form would read as the opposite of a one-shot call.
    if (context.effort) {
      argv.push("--config", `model_reasoning_effort=${context.effort}`);
    }
    argv.push("-");
    return { argv, input: context.prompt };
  },

  decode: (stdout) => decodeAgentCli(stdout),
  classifyFailure: (result, decoded) =>
    classifyAgentCliFailure(result, decoded),
  capacityResetHint: (result, decoded) => agentCliResetHint(result, decoded),
};
