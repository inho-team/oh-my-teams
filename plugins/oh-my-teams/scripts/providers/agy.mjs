/** Agy CLI adapter: sandboxed plan mode with a bounded print timeout. */
import {
  agentCliResetHint,
  assertProvider,
  classifyAgentCliFailure,
  decodeAgentCli,
  printTimeout,
} from "./shared.mjs";

// Agy encodes the level in the model ID itself (`gemini-3.8-flash-high`), so a
// profile can state the level twice. Contradictory pairs are rejected instead of
// letting an unverified precedence rule decide which one the call actually used.
const MODEL_EFFORT = /-(low|medium|high)$/;

/**
 * Adapter for the `agy` CLI.
 *
 * `agy --help` (1.2.3) documents `--effort low|medium|high`.
 */
export default {
  id: "agy",
  transports: ["process"],
  efforts: ["low", "medium", "high"],
  workspaceAccess: true,

  /**
   * Rejects a profile whose explicit effort contradicts its model identifier.
   *
   * @param {string} id - Profile identifier used in failure messages.
   * @param {object} profile - Provider profile under validation.
   * @throws {Error} When the model encodes a different effort than requested.
   */
  validateProfile(id, profile) {
    if (profile.effort === undefined) return;
    const encoded = MODEL_EFFORT.exec(profile.model ?? "")?.[1];
    assertProvider(
      !encoded || encoded === profile.effort,
      `Effort ${profile.effort} contradicts model ${profile.model}: ${id}`,
    );
  },

  /**
   * Builds the argv for one sandboxed, tool-free Agy plan-mode call.
   *
   * @param {object} profile - Provider profile with command and optional model.
   * @param {object} context - Call context with prompt, cwd, effort, and budget.
   * @returns {{argv: string[], input: string}} Command arguments and stdin payload.
   */
  request(profile, context) {
    const argv = [
      ...profile.command,
      "--mode",
      "plan",
      "--sandbox",
      "--add-dir",
      context.cwd,
      "--disable-slash-commands",
      "--output-format",
      "json",
      "--print-timeout",
      printTimeout(context.timeoutMs),
    ];
    if (profile.model) argv.push("--model", profile.model);
    if (context.effort) argv.push("--effort", context.effort);
    argv.push("-p", context.prompt);
    return { argv, input: "" };
  },

  decode: (stdout) => decodeAgentCli(stdout),
  classifyFailure: (result, decoded) =>
    classifyAgentCliFailure(result, decoded),
  capacityResetHint: (result, decoded) => agentCliResetHint(result, decoded),
};
