/** Fail-closed OpenCodex fixed-account runner binding validation. */
import path from "node:path";
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
    env: { ...process.env, ...env },
    stdio: "ignore",
    shell: false,
  });
  const deadline = Date.now() + (binding.readyTimeoutMs ?? 15000);
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        return {
          port,
          pid: child.pid ?? null,
          env,
          stop: async () => {
            if (!child.killed) child.kill("SIGTERM");
            await new Promise((resolve) => child.once("close", resolve));
          },
        };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!child.killed) child.kill("SIGTERM");
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
    `openai_base_url=http://127.0.0.1:${request.port}/v1`,
    "-",
  ];
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
  return {
    accountHome,
    accountLogLabel,
    sessionHome,
    runtimePrefix: runtime.runtimePrefix,
  };
}
