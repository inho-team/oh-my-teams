/**
 * Ollama adapter for locally served models, over HTTP or the `ollama` CLI.
 *
 * Ollama differs from the hosted agent CLIs in ways the runtime must encode
 * rather than discover at run time. It never reaches the workspace, so a task
 * whose contract references carry only a path and a hash is unanswerable. It
 * has no shared quota, so an unreachable server is a routing failure and not
 * pool exhaustion. And it truncates a prompt longer than the configured context
 * window without reporting an error, which would otherwise let a model answer
 * from a silently shortened contract.
 */
import {
  assertProvider,
  classifyAgentCliFailure,
  decodeAgentCli,
  tryParseJson,
} from "./shared.mjs";

/**
 * Conservative bytes-per-token divisor used to size a prompt before sending.
 *
 * The runtime carries no tokenizer, so this is a guard and not a measurement.
 * It exists to stop an obviously oversized prompt on the CLI path, where no
 * usage counter comes back. The HTTP path additionally verifies the real token
 * count the server reports, which is the authoritative check.
 */
const BYTES_PER_TOKEN = 3;

/** Signals that name a transport failure rather than a model or capacity failure. */
const UNREACHABLE = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed/i;

/**
 * Estimates an upper bound on the tokens a prompt occupies.
 *
 * @param {string} prompt - Literal prompt text.
 * @returns {number} Estimated token count, rounded up.
 */
export function estimateTokens(prompt) {
  return Math.ceil(Buffer.byteLength(prompt) / BYTES_PER_TOKEN);
}

function endpointUrl(profile, route) {
  const base = String(profile.endpoint).replace(/\/+$/, "");
  return `${base}${route}`;
}

export default {
  id: "ollama",
  transports: ["http", "process"],
  // gpt-oss and other thinking models accept `think: "low" | "medium" | "high"`.
  // A model without a thinking mode rejects the request, which surfaces as an
  // ordinary provider failure rather than a silently ignored reasoning depth.
  efforts: ["low", "medium", "high"],
  // Ollama receives a prompt and returns text; it cannot open a repository file.
  workspaceAccess: false,

  /**
   * Rejects an Ollama profile that cannot produce accountable routing evidence.
   *
   * @param {string} id - Profile identifier used in failure messages.
   * @param {object} profile - Provider profile under validation.
   * @throws {Error} For a missing model, context window, pool, or bad endpoint.
   */
  validateProfile(id, profile) {
    assertProvider(
      typeof profile.model === "string" && profile.model.trim(),
      `Ollama profile needs an explicit model; there is no host default: ${id}`,
    );
    assertProvider(
      Number.isInteger(profile.contextTokens) && profile.contextTokens >= 2048,
      `Ollama profile needs contextTokens (>= 2048) to detect truncation: ${id}`,
    );
    assertProvider(
      profile.pool === undefined,
      `Local Ollama inference draws from no shared quota pool: ${id}`,
    );
    if (profile.endpoint !== undefined) {
      let parsed = null;
      try {
        parsed = new URL(profile.endpoint);
      } catch {
        parsed = null;
      }
      assertProvider(
        parsed !== null && ["http:", "https:"].includes(parsed.protocol),
        `Ollama endpoint must be an http(s) URL: ${id}`,
      );
      // Environment references reach a child process, and an HTTP call spawns
      // none. Accepting them here would let an operator believe a variable
      // selected the server or the account while nothing carried it.
      assertProvider(
        profile.env === undefined,
        `An HTTP Ollama profile carries no environment; use endpoint: ${id}`,
      );
    }
  },

  /**
   * Builds either an HTTP generate request or an `ollama run` invocation.
   *
   * The prompt travels through stdin on the CLI path. A task prompt here reaches
   * tens of kilobytes, which exceeds the Windows command-line limit, so passing
   * it as an argument would fail on exactly the largest tasks.
   *
   * @param {object} profile - Ollama profile with model and context window.
   * @param {object} context - Call context with prompt, effort, and transport.
   * @returns {object} Process spec `{argv, input}` or an HTTP request spec.
   * @throws {Error} When the prompt cannot fit the declared context window.
   */
  request(profile, context) {
    const estimated = estimateTokens(context.prompt);
    assertProvider(
      estimated <= profile.contextTokens,
      `Prompt needs about ${estimated} tokens but ${profile.model} is configured ` +
        `for ${profile.contextTokens}; Ollama would truncate it silently`,
    );

    if (context.transport === "http") {
      const body = {
        model: profile.model,
        prompt: context.prompt,
        stream: false,
        // Every prompt this harness sends demands a JSON-only answer, so the
        // server constrains decoding instead of trusting the model to comply.
        format: "json",
        options: { num_ctx: profile.contextTokens, temperature: 0 },
      };
      if (context.effort) body.think = context.effort;
      if (profile.keepAlive) body.keep_alive = profile.keepAlive;
      return {
        url: endpointUrl(profile, "/api/generate"),
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      };
    }

    const argv = [...profile.command, "run", profile.model];
    // A reasoning trace printed before the answer would merge with it, and the
    // JSON extractor spans the first brace to the last one, so a trace holding
    // braces would corrupt the parse instead of failing loudly.
    if (context.effort) argv.push("--think", context.effort);
    argv.push("--hidethinking");
    return { argv, input: context.prompt };
  },

  /**
   * Normalizes an Ollama answer and flags truncated prompts or cut-off answers.
   *
   * @param {string} stdout - HTTP response body, or CLI standard output.
   * @param {object} context - Call context carrying the profile and transport.
   * @returns {object} Text, usage, effective model, cost, and provider-error flag.
   */
  decode(stdout, context) {
    if (context?.transport !== "http") {
      // The CLI prints the answer as plain text and reports no token counts, so
      // nothing here can confirm the prompt arrived whole.
      return { ...decodeAgentCli(stdout), costUsd: 0 };
    }

    const envelope = tryParseJson(stdout);
    if (envelope === undefined) {
      return {
        text: stdout,
        usage: null,
        effectiveModel: null,
        costUsd: 0,
        providerError: true,
      };
    }

    const promptTokens = envelope.prompt_eval_count ?? null;
    const answerTokens = envelope.eval_count ?? null;
    const window = context.profile?.contextTokens ?? null;
    // Ollama caps prompt evaluation at the context window instead of refusing
    // the request, so a count that reaches the window means the contract the
    // model actually read was shorter than the one this runtime composed.
    const truncatedPrompt =
      window !== null && promptTokens !== null && promptTokens >= window;
    const truncatedAnswer = envelope.done_reason === "length";

    return {
      text: typeof envelope.response === "string" ? envelope.response : stdout,
      usage:
        promptTokens === null && answerTokens === null
          ? null
          : {
              input_tokens: promptTokens ?? 0,
              output_tokens: answerTokens ?? 0,
              total_tokens: (promptTokens ?? 0) + (answerTokens ?? 0),
            },
      effectiveModel:
        typeof envelope.model === "string" ? envelope.model : null,
      // Local inference spends no API budget. Reporting `null` instead would
      // leave every aggregate cost permanently unknown once one local profile
      // takes part in a run.
      costUsd: 0,
      providerError:
        envelope.error != null || truncatedPrompt || truncatedAnswer,
      truncatedPrompt,
      truncatedAnswer,
    };
  },

  /**
   * Classifies a failure, separating an unreachable server from a model fault.
   *
   * @param {object} result - Raw transport result.
   * @param {object} decoded - Normalized output from this adapter's decoder.
   * @returns {string | null} Stable failure class, or `null` for success.
   */
  classifyFailure(result, decoded) {
    if (result.code === 0 && !decoded.providerError) return null;
    if (decoded.truncatedPrompt || decoded.truncatedAnswer) {
      return "context-truncated";
    }
    if (UNREACHABLE.test(`${result.stderr ?? ""}`)) {
      return "provider-unavailable";
    }
    return classifyAgentCliFailure(result, decoded);
  },

  /**
   * Reports no capacity window, because local inference has no shared quota.
   *
   * @returns {null} Always `null`.
   */
  capacityResetHint: () => null,
};
