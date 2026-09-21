/** Fail-closed OpenCodex fixed-account runner binding validation. */
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import { assert } from "./core.mjs";

/**
 * Validates a profile's optional OpenCodex runner without changing legacy profile behavior.
 * @param {object} profile - Organization profile.
 * @param {object} activeRuntime - Active runtime identity.
 * @returns {{kind: string, mode: string, accountHomeRef: string, runtimeFingerprint: string} | null} Valid runner or null for legacy.
 */
export function validateOpenCodexRunner(profile, activeRuntime) {
  if (!profile.runner) return null;
  const runner = profile.runner;
  assert(runner.kind === "opencodex", "opencodex-binding-unverified");
  assert(runner.mode === "fixed-account", "opencodex-pool-unverified");
  assert(
    typeof runner.accountHomeRef === "string" &&
      runner.accountHomeRef === profile.account,
    "opencodex-binding-unverified",
  );
  assert(
    runner.runtimeFingerprint === activeRuntime?.prefixFingerprint,
    "opencodex-binding-unverified",
  );
  assert(profile.model !== null, "opencodex-binding-unverified");
  return runner;
}

/**
 * Builds isolated environment variables for a fixed account turn.
 * @param {object} binding - Validated binding input.
 * @returns {Record<string, string>} Environment additions.
 */
export function openCodexEnvironment(binding) {
  assert(
    binding.accountHome && binding.sessionHome && binding.runtimePrefix,
    "opencodex-binding-unverified",
  );
  assert(
    path.resolve(binding.accountHome) !== path.resolve(binding.sessionHome),
    "opencodex-binding-unverified",
  );
  assert(
    path.resolve(binding.accountHome) !== path.resolve(binding.runtimePrefix),
    "opencodex-binding-unverified",
  );
  assert(
    !Object.keys(binding.env ?? {}).some((key) => /API[_-]?KEY/i.test(key)),
    "api-key-fallback-blocked",
  );
  return {
    OPENCODEX_HOME: binding.accountHome,
    CODEX_HOME: binding.sessionHome,
  };
}

/**
 * Keeps an OpenCodex child from inheriting an API-key or another OpenCodex home.
 * @param {NodeJS.ProcessEnv} environment - Parent process environment.
 * @param {Record<string, string>} homes - Verified turn homes.
 * @returns {NodeJS.ProcessEnv} Isolated child environment.
 */
export function isolatedOpenCodexEnvironment(environment, homes) {
  const safe = { ...environment };
  for (const key of Object.keys(safe)) {
    if (
      /(?:^|_)(?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|API)[A-Z_]*(?:KEY|TOKEN)(?:$|_)/i.test(
        key,
      ) ||
      key === "OPENCODEX_HOME" ||
      key === "CODEX_HOME"
    ) {
      delete safe[key];
    }
  }
  return { ...safe, ...homes };
}

/**
 * Verifies that an OpenAI account home cannot select a second account or native path.
 * Credential contents are not returned or persisted.
 * @param {string} accountHome - Isolated OpenCodex account directory.
 * @param {string} accountLogLabel - Expected secret-free account label.
 * @returns {{provider: string, accountLogLabel: string}} Fixed account proof.
 */
export function validateFixedOpenCodexAccountHome(
  accountHome,
  accountLogLabel,
) {
  const configFile = path.join(accountHome, "config.json");
  const storeFile = path.join(accountHome, "codex-accounts.json");
  assert(
    fs.existsSync(configFile) && fs.existsSync(storeFile),
    "opencodex-binding-unverified",
  );
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  const credentials = JSON.parse(fs.readFileSync(storeFile, "utf8"));
  const accounts = config.codexAccounts;
  assert(
    Array.isArray(accounts) &&
      accounts.length === 1 &&
      Object.keys(credentials).length === 1 &&
      accounts[0]?.id === config.activeCodexAccountId &&
      accounts[0]?.id in credentials &&
      accounts[0]?.logLabel === accountLogLabel,
    "opencodex-binding-unverified",
  );
  assert(
    config.activeCodexAccountPinned === accounts[0]?.id &&
      config.providers?.openai?.codexAccountMode === "pool" &&
      config.clientIntegrations?.codex === false,
    "opencodex-pool-unverified",
  );
  return { provider: "openai", accountLogLabel };
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) =>
    server.listen(0, "127.0.0.1", resolve).on("error", reject),
  );
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Starts an owned loopback OpenCodex process and waits for its health endpoint.
 * This never invokes a login command and only terminates the child it started.
 * @param {object} binding - Runtime prefix and isolated fixed-account homes.
 * @returns {Promise<{port: number, pid: number | null, env: Record<string, string>, stop: () => Promise<void>}>} Owned proxy receipt.
 */
export async function startOpenCodexProxy(binding) {
  const env = openCodexEnvironment(binding);
  const port = binding.port ?? (await unusedPort());
  const binary = path.join(
    binding.runtimePrefix,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "ocx.cmd" : "ocx",
  );
  const child = spawn(binary, ["start", "--port", String(port)], {
    cwd: binding.runtimePrefix,
    env: isolatedOpenCodexEnvironment(process.env, env),
    stdio: "ignore",
    shell: false,
  });
  let exited = false;
  let spawnError = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.once("close", () => {
    exited = true;
  });
  const deadline = Date.now() + (binding.readyTimeoutMs ?? 15000);
  while (Date.now() < deadline) {
    if (spawnError || exited) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        return {
          port,
          pid: child.pid ?? null,
          env,
          stop: async () => {
            if (child.exitCode !== null || exited) return;
            child.kill("SIGTERM");
            await Promise.race([
              new Promise((resolve) => child.once("close", resolve)),
              new Promise((resolve) => setTimeout(resolve, 3000)),
            ]);
          },
        };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (child.exitCode === null && !exited) child.kill("SIGTERM");
  throw new Error("opencodex-proxy-not-ready");
}

/**
 * Builds the actual Codex CLI argv for an already-ready OpenCodex proxy.
 * @param {object} request - Requested model, effort, cwd and proxy port.
 * @returns {string[]} Shell-free Codex argv.
 */
export function openCodexCommand(request) {
  assert(request.model, "opencodex-binding-unverified");
  assert(request.effort, "opencodex-binding-unverified");
  assert(Number.isInteger(request.port), "opencodex-proxy-not-ready");
  return [
    "codex",
    "exec",
    "--json",
    "--cd",
    request.cwd,
    "--model",
    request.model,
    "--config",
    `model_reasoning_effort=${request.effort}`,
    "--config",
    "model_provider=omt-opencodex",
    "--config",
    'model_providers.omt-opencodex.name="OpenCodex OMT proxy"',
    "--config",
    `model_providers.omt-opencodex.base_url="http://127.0.0.1:${request.port}/v1"`,
    "--config",
    'model_providers.omt-opencodex.wire_api="responses"',
    "--config",
    "model_providers.omt-opencodex.requires_openai_auth=false",
    "--config",
    "model_providers.omt-opencodex.request_max_retries=0",
    "--config",
    "model_providers.omt-opencodex.stream_max_retries=0",
    "-",
  ];
}

/**
 * Returns the provider name recorded by OpenCodex for an OMT logical provider.
 * @param {string} provider - OMT logical provider identifier.
 * @returns {string} OpenCodex request-history provider identifier.
 */
export function openCodexProvider(provider, accountLogLabel) {
  return (
    (provider === "codex" && accountLogLabel
      ? `openai-${accountLogLabel}`
      : { claude: "anthropic", agy: "google-antigravity" }[provider]) ??
    provider
  );
}

/**
 * Reads the one request-history observation created after a caller's boundary.
 * The management token is sent only to loopback and is never returned.
 * @param {object} input - Loopback proxy and requested binding data.
 * @param {typeof fetch} [fetcher=fetch] - Injectable loopback fetch implementation.
 * @returns {Promise<{provider: string, accountLogLabel: string, model: string, usage: object | null}>}
 */
export async function readOpenCodexObservation(input, fetcher = fetch) {
  const tokenFile = path.join(input.accountHome, "admin-api-token");
  assert(fs.existsSync(tokenFile), "opencodex-binding-unverified");
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  assert(token, "opencodex-binding-unverified");
  const response = await fetcher(
    `http://127.0.0.1:${input.port}/api/request-history?limit=20`,
    { headers: { "X-OpenCodex-API-Key": token } },
  );
  assert(response.ok, "opencodex-binding-unverified");
  const history = await response.json();
  const entries = Array.isArray(history.entries) ? history.entries : [];
  const entry = entries.find(
    (candidate) =>
      candidate.timestamp &&
      Date.parse(candidate.timestamp) >= input.startedAt &&
      candidate.requestedModel === input.model &&
      candidate.provider ===
        openCodexProvider(input.provider, input.accountLogLabel),
  );
  const attempt = entry?.attempts?.at(-1);
  assert(
    entry &&
      attempt?.accountLogLabel === input.accountLogLabel &&
      typeof attempt.provider === "string",
    "opencodex-binding-unverified",
  );
  const model = entry.resolvedModel ?? entry.model ?? null;
  assert(
    typeof model === "string" && model,
    "opencodex-model-unproven-or-mismatched",
  );
  return {
    provider: attempt.provider,
    accountLogLabel: attempt.accountLogLabel,
    model,
    usage: entry.usage ?? null,
  };
}

/**
 * Resolves a named fixed-account binding from explicit process environment references.
 * @param {object} profile - Organization profile with an OpenCodex runner.
 * @param {object} runtime - Active runtime diagnosis result.
 * @param {NodeJS.ProcessEnv} [environment=process.env] - Explicit caller configuration.
 * @returns {object} Secret-free fixed-account binding.
 */
export function resolveOpenCodexBinding(
  profile,
  runtime,
  environment = process.env,
) {
  const runner = validateOpenCodexRunner(profile, runtime);
  if (!runner) return null;
  const key = runner.accountHomeRef.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const accountHome = environment[`OMT_OPENCODEX_${key}_HOME`];
  const accountLogLabel = environment[`OMT_OPENCODEX_${key}_LABEL`];
  const sessionHome = environment.OMT_OPENCODEX_SESSION_HOME;
  assert(
    accountHome && accountLogLabel && sessionHome,
    "opencodex-action-required: configure named account home, label and session home",
  );
  validateFixedOpenCodexAccountHome(accountHome, accountLogLabel);
  return {
    accountHome,
    accountLogLabel,
    sessionHome,
    runtimePrefix: runtime.runtimePrefix,
  };
}
