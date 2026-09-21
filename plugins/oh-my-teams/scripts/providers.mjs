/**
 * Provider-neutral call surface over the adapter registry in `providers/`.
 *
 * Callers pass a profile and a prompt and read one normalized result. Which
 * provider answers, and whether it answers over a child process or over HTTP,
 * is resolved here so that routing, evidence, and usage reporting never branch
 * on a provider name.
 */
import { assert, profileEnv, run } from "./core.mjs";
import { adapterFor, transportFor } from "./providers/index.mjs";
import { httpRun } from "./providers/http.mjs";
import {
  agentCliResetHint,
  classifyAgentCliFailure,
  decodeAgentCli,
  tryParseJson,
} from "./providers/shared.mjs";
import { defaultRuntimeRoot, doctor, runtimePaths } from "./dependencies.mjs";
import {
  openCodexCommand,
  openCodexEnvironment,
  isolatedOpenCodexEnvironment,
  readOpenCodexObservation,
  resolveOpenCodexBinding,
  startOpenCodexProxy,
} from "./opencodex.mjs";

/**
 * Returns the effort a profile asks for after re-checking provider support.
 *
 * `validateOrg` already rejects an unsupported pairing, but a profile can also
 * reach here from a caller that never loaded an organization document. Silently
 * dropping the level would run the call at a different reasoning depth than the
 * report later claims, so an unsupported pairing fails instead.
 *
 * @param {object} profile - Provider profile, possibly carrying `effort`.
 * @returns {string | null} Validated effort, or `null` to keep the CLI default.
 * @throws {Error} When the provider cannot select the requested effort.
 */
function requestedEffort(profile) {
  if (profile.effort === undefined || profile.effort === null) return null;
  const accepted = adapterFor(profile).efforts;
  assert(
    accepted.includes(profile.effort),
    `Provider ${profile.provider} cannot select effort ${profile.effort}`,
  );
  return profile.effort;
}

/**
 * Builds the transport-specific request one provider call will be issued as.
 *
 * Model identifiers are opaque configuration values. The runtime does not infer
 * price or quality, and it gives every provider read-only/no-tool constraints.
 *
 * A profile without `effort` sends no effort argument, so the provider keeps the
 * default its own account settings define.
 *
 * @param {object} profile - Valid provider profile with command or endpoint.
 * @param {string} cwd - Workspace exposed as read-only model context.
 * @param {string} prompt - Literal prompt passed through stdin, argv, or a body.
 * @param {number} [timeoutMs=300000] - Call budget the runtime enforces.
 * @returns {object} Request spec plus the transport that will carry it.
 * @throws {Error} When the provider or its transport is unsupported.
 */
export function providerRequest(profile, cwd, prompt, timeoutMs = 300000) {
  const adapter = adapterFor(profile);
  const transport = transportFor(profile);
  const spec = adapter.request(profile, {
    cwd,
    prompt,
    timeoutMs,
    transport,
    effort: requestedEffort(profile),
  });
  return { ...spec, transport };
}

/**
 * Builds a shell-free command for one process-transport provider.
 *
 * @param {object} profile - Valid provider profile with command and optional model.
 * @param {string} cwd - Workspace exposed as read-only model context.
 * @param {string} prompt - Literal prompt passed through stdin or argv.
 * @param {number} [timeoutMs=300000] - Call budget the runtime enforces.
 * @returns {{argv: string[], input: string}} Command arguments and stdin payload.
 * @throws {Error} When the provider is unsupported or is not process-backed.
 */
export function providerCommand(profile, cwd, prompt, timeoutMs = 300000) {
  assert(
    !profile.runner,
    "opencodex-headless-unverified: use the fixed-account provider invocation",
  );
  const { argv, input, transport } = providerRequest(
    profile,
    cwd,
    prompt,
    timeoutMs,
  );
  assert(
    transport === "process",
    `Provider ${profile.provider} is not a command`,
  );
  return { argv, input };
}

/**
 * Normalizes JSON-envelope and JSONL provider output into one result shape.
 *
 * @param {string} stdout - Raw provider standard output.
 * @returns {object} Text, usage, effective model, cost, and provider-error flag.
 */
export function decodeOutput(stdout) {
  return decodeAgentCli(stdout);
}

/**
 * Compares the requested profile model with the model the provider reported.
 *
 * Routing, quota, and cost decisions are all made from the requested model, so
 * a provider that silently answers from another model invalidates them. Absent
 * model metadata stays `unproven` instead of being read as agreement.
 *
 * @param {object} profile - Provider profile carrying the requested model.
 * @param {object} decoded - Normalized output from {@link decodeOutput}.
 * @returns {{requested: string | null, effective: string | null, status: string}}
 * Status is `unrequested`, `unproven`, `matched`, or `mismatched`.
 */
export function modelBinding(profile, decoded) {
  const requested = profile?.model ?? null;
  const effective = decoded?.effectiveModel ?? null;
  if (requested === null)
    return { requested, effective, status: "unrequested" };
  if (effective === null) return { requested, effective, status: "unproven" };
  return {
    requested,
    effective,
    status: effective === requested ? "matched" : "mismatched",
  };
}

/**
 * Classifies a failed provider call without treating arbitrary `429` text as quota.
 *
 * @param {object} result - Raw command result.
 * @param {object} decoded - Normalized output from {@link decodeOutput}.
 * @returns {string | null} Stable failure class, or `null` for success.
 */
export function classifyProviderFailure(result, decoded) {
  return classifyAgentCliFailure(result, decoded);
}

/**
 * Reads how long a provider says its exhausted capacity stays unavailable.
 *
 * @param {object} result - Raw command result.
 * @param {object} decoded - Normalized output from {@link decodeOutput}.
 * @returns {string | null} Provider-reported reset window, or `null`.
 */
export function capacityResetHint(result, decoded) {
  return agentCliResetHint(result, decoded);
}

/**
 * Extracts a JSON object from plain, fenced, or prose-wrapped model text.
 *
 * @param {string} text - Model response text.
 * @returns {object} Parsed JSON payload.
 * @throws {Error | SyntaxError} When no valid JSON object can be found.
 */
export function parseModelJSON(text) {
  const direct = tryParseJson(text);
  if (direct !== undefined) return direct;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return JSON.parse(fenced[1]);

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  assert(start >= 0 && end > start, "Model did not return a JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

/** Failure classes that mean the profile has no capacity left to give. */
const EXHAUSTED_CLASSES = ["pool-exhausted", "quota-unknown", "rate-limit"];

/**
 * Invokes one provider and returns raw plus normalized response metadata.
 *
 * @param {object} profile - Provider profile and environment references.
 * @param {string} cwd - Invocation workspace.
 * @param {string} prompt - Literal model prompt.
 * @param {number} timeoutMs - Maximum provider runtime.
 * @param {Function} [execute=run] - Injectable process runner.
 * @param {Function} [request=httpRun] - Injectable HTTP runner.
 * @returns {Promise<object>} Process, output, usage, and failure metadata.
 */
export async function invoke(
  profile,
  cwd,
  prompt,
  timeoutMs,
  execute = run,
  request = httpRun,
) {
  if (profile.runner?.kind === "opencodex") {
    const root = defaultRuntimeRoot();
    const diagnosed = await doctor(root);
    assert(
      diagnosed.status === "ready",
      "opencodex-action-required: run runtime-install first",
    );
    const paths = runtimePaths(root);
    const binding = resolveOpenCodexBinding(profile, diagnosed.runtime);
    const profileEnvironment = profileEnv(profile);
    const proxyEnvironment = openCodexEnvironment({
      ...binding,
      env: profileEnvironment,
    });
    const proxy = await startOpenCodexProxy({
      ...binding,
      runtimePrefix: paths.runtime,
    });
    try {
      const startedAt = Date.now();
      const argv = openCodexCommand({
        cwd,
        port: proxy.port,
        model: profile.model,
        effort: profile.effort,
      });
      const result = await execute(argv, {
        cwd,
        input: prompt,
        timeoutMs,
        env: isolatedOpenCodexEnvironment(profileEnvironment, proxyEnvironment),
      });
      const decoded = adapterFor({ ...profile, provider: "codex" }).decode(
        result.stdout,
        { profile, cwd, transport: "process" },
      );
      const observed = await readOpenCodexObservation({
        ...binding,
        port: proxy.port,
        provider: profile.provider,
        model: profile.model,
        startedAt,
      });
      const bindingResult = modelBinding(profile, {
        ...decoded,
        effectiveModel: observed.model,
      });
      assert(
        bindingResult.status === "matched",
        "opencodex-model-unproven-or-mismatched",
      );
      return {
        ...result,
        ...decoded,
        modelBinding: bindingResult,
        effectiveModel: observed.model,
        usage: decoded.usage ?? observed.usage ?? null,
        failureClass: classifyAgentCliFailure(result, decoded),
        exhausted: false,
        observed,
        lifecycle: {
          inputAccepted: result.code === 0 || Boolean(result.stdout),
          turnStarted: /"type":"turn\.started"/.test(result.stdout),
          upstreamRequestStarted: true,
          completed: /"type":"turn\.completed"/.test(result.stdout),
          exitObserved: result.code !== undefined,
          cancelRequested: false,
          termination: result.code === 0 ? "exited" : "unverifiable",
        },
      };
    } finally {
      await proxy.stop();
    }
  }
  const adapter = adapterFor(profile);
  const spec = providerRequest(profile, cwd, prompt, timeoutMs);
  const result =
    spec.transport === "http"
      ? await request(spec, { timeoutMs })
      : await execute(spec.argv, {
          cwd,
          input: spec.input,
          timeoutMs,
          env: profileEnv(profile),
        });

  const context = { profile, cwd, transport: spec.transport };
  const decoded = adapter.decode(result.stdout, context);
  const failureClass = adapter.classifyFailure(result, decoded, context);
  return {
    ...result,
    ...decoded,
    modelBinding: modelBinding(profile, decoded),
    failureClass,
    capacityResetsIn: adapter.capacityResetHint(result, decoded, context),
    exhausted: EXHAUSTED_CLASSES.includes(failureClass),
  };
}
