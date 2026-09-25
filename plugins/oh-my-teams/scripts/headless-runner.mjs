#!/usr/bin/env node
/**
 * Runs one headless turn: a provider CLI as a child, its output to files.
 *
 * The supervisor starts this runner detached and returns at once. The runner
 * owns the provider process, so it is the one place its exit code can be read;
 * it writes `exit.json` when the child ends, when the turn exceeds its time
 * limit, or when `stop.request` appears. Stopping by file rather than by signal
 * works the same on Windows, where a signal from another process terminates
 * the runner before it can stop its child.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { readJSON, resolveCommand, writeJSON } from "./core.mjs";
import { defaultRuntimeRoot, doctor, runtimePaths } from "./dependencies.mjs";
import {
  isolatedOpenCodexEnvironment,
  openCodexCommand,
  openCodexHistoryBoundary,
  openCodexEnvironment,
  processGroupMembers,
  readOpenCodexObservation,
  resolveOpenCodexBinding,
  startOpenCodexProxy,
} from "./opencodex.mjs";

const POLL_MS = 500;
const KILL_GRACE_MS = 5000;

/**
 * Builds the request-correlated lifecycle record of one OpenCodex headless turn.
 *
 * Each flag is judged on its own evidence and defaults to false when that
 * evidence is missing, so an exit code or a completion marker never stands in
 * for a stage that was not observed. `termination` is `exited` only when the
 * provider exit was observed, its process group was seen empty, and the owned
 * proxy tree was confirmed gone; anything else stays `unverifiable`.
 *
 * @param {object} facts - What the runner observed for the turn.
 * @param {string} facts.turnDir - Turn directory holding `stream.jsonl` and `turn.json`.
 * @param {object | null} facts.observed - Request-history observation, or null when it failed.
 * @param {boolean} facts.inputAccepted - Whether the prompt was written to the provider's stdin.
 * @param {boolean} facts.exitObserved - Whether the provider's exit itself was observed.
 * @param {boolean} facts.cancelRequested - Whether a stop request ended the turn.
 * @param {boolean} facts.descendantsExited - Whether the provider's process group was seen empty.
 * @param {number} facts.orphansTerminated - Descendants still alive at exit that the runner ended.
 * @param {boolean} facts.proxyExited - Whether the owned proxy tree was confirmed gone.
 * @returns {object} Lifecycle record with the worker and turn it belongs to.
 */
export function buildLifecycle({
  turnDir,
  observed,
  inputAccepted,
  exitObserved,
  cancelRequested,
  descendantsExited,
  orphansTerminated,
  proxyExited,
}) {
  let events = [];
  try {
    const CHUNK = 65536;
    let fd;
    try {
      fd = fs.openSync(path.join(turnDir, "stream.jsonl"), "r");
    } catch {
      fd = null;
    }
    if (fd !== null) {
      const buf = Buffer.allocUnsafe(CHUNK);
      // We only need to check if turn.started and turn.completed exist.
      // We don't need a StringDecoder if we just search for the strings.
      // But they might cross boundaries. Since we only check their presence,
      // and they are small JSON events, we can parse them just to be safe.

      const decoder = new StringDecoder("utf8");
      let tail = "";
      let bytesRead;
      do {
        bytesRead = fs.readSync(fd, buf, 0, CHUNK, null);
        tail += decoder.write(buf.subarray(0, bytesRead));
        let start = 0;
        let pos;
        while ((pos = tail.indexOf("\n", start)) !== -1) {
          const line = tail.slice(start, pos).trim();
          start = pos + 1;
          if (line) {
            try {
              const event = JSON.parse(line);
              if (
                event.type === "turn.started" ||
                event.type === "turn.completed"
              ) {
                events.push(event);
              }
            } catch {}
          }
        }
        tail = tail.slice(start);
      } while (bytesRead > 0);
      if (tail.trim()) {
        try {
          const event = JSON.parse(tail.trim());
          if (
            event.type === "turn.started" ||
            event.type === "turn.completed"
          ) {
            events.push(event);
          }
        } catch {}
      }
      fs.closeSync(fd);
    }
  } catch {}
  let turn = {};
  try {
    turn = readJSON(path.join(turnDir, "turn.json"));
  } catch {}
  const workerId = path.basename(path.dirname(path.dirname(turnDir)));
  const has = (type) => events.some((event) => event?.type === type);
  const requestIds = observed?.requestIds ?? [];
  return {
    attemptId: `${workerId}:${turn.number ?? path.basename(turnDir)}`,
    workerId,
    turn: turn.number ?? null,
    inputAccepted: inputAccepted === true,
    turnStarted: has("turn.started"),
    upstreamRequestStarted: requestIds.length > 0,
    completed: has("turn.completed"),
    exitObserved: exitObserved === true,
    cancelRequested: cancelRequested === true,
    descendantsExited: descendantsExited === true,
    orphansTerminated: orphansTerminated ?? 0,
    proxyExited: proxyExited === true,
    termination:
      exitObserved === true &&
      descendantsExited === true &&
      proxyExited === true
        ? "exited"
        : "unverifiable",
    requestIds,
  };
}

/**
 * Terminates a process tree rooted at the given pid.
 *
 * On Windows, `taskkill /T /F /PID` ends the process and all its descendants.
 * On POSIX, SIGTERM is sent to the process group (negative pid) so grandchild
 * processes spawned by the child are also signalled.
 * Errors are returned (not thrown) so the caller can record them in exit.json.
 *
 * @param {number | null | undefined} pid - Root process id to kill.
 * @param {string} [signal="SIGTERM"] - Signal for POSIX; Windows always uses /F.
 * @returns {string | null} Error message if the attempt failed, otherwise null.
 */
export function killTree(pid, signal = "SIGTERM") {
  if (!pid) return null;
  try {
    if (process.platform === "win32") {
      // taskkill /T kills descendants; /F forces immediate termination.
      const result = spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        windowsHide: true,
        timeout: 5000,
      });
      if (result.status !== 0) {
        const msg = (result.stderr ?? result.stdout ?? "").toString().trim();
        return msg || `taskkill exited ${result.status}`;
      }
    } else {
      // Negative pid targets the entire process group the child belongs to.
      process.kill(-pid, signal);
    }
    return null;
  } catch (error) {
    return String(error.message);
  }
}

// Starts the owned proxy and the history boundary for an explicit OpenCodex
// turn. A proxy started before a later step fails is stopped here, because the
// caller never receives it; if it cannot be shown to have exited, that is the
// error reported.
async function prepareOpenCodexTurn(turn) {
  if (turn.runner.kind !== "opencodex")
    throw new Error("opencodex-binding-unverified");
  const diagnosed = await doctor(defaultRuntimeRoot());
  if (diagnosed.status !== "ready")
    throw new Error("opencodex-action-required: run runtime-install first");
  const profile = {
    provider: turn.runner.logicalProvider,
    account: turn.runner.logicalAccount,
    model: turn.runner.model,
    effort: turn.runner.effort,
    runner: {
      kind: turn.runner.kind,
      mode: turn.runner.mode,
      accountHomeRef: turn.runner.accountHomeRef,
      runtimeFingerprint: turn.runner.runtimeFingerprint,
    },
  };
  const binding = {
    ...resolveOpenCodexBinding(
      profile,
      diagnosed.runtime,
      process.env,
      turn.runner.profileId,
    ),
    runtimePrefix: runtimePaths(defaultRuntimeRoot()).runtime,
  };
  const proxy = await startOpenCodexProxy(binding);
  try {
    const historyBoundary = await openCodexHistoryBoundary({
      ...binding,
      port: proxy.port,
    });
    return {
      proxy,
      binding,
      historyBoundary,
      command: openCodexCommand({
        cwd: turn.cwd,
        port: proxy.port,
        model: turn.runner.model,
        effort: turn.runner.effort,
        session: turn.session,
        writable: true,
      }),
      environment: isolatedOpenCodexEnvironment(
        process.env,
        openCodexEnvironment(binding),
      ),
    };
  } catch (error) {
    try {
      await proxy.stop();
    } catch (stopError) {
      throw new Error(`${error.message}; ${stopError.message}`);
    }
    throw error;
  }
}

/**
 * Runs the turn described by `<turnDir>/turn.json` to completion.
 *
 * An explicit OpenCodex turn also writes `opencodex.json` and `lifecycle.json`.
 * Whatever goes wrong around the provider process (setup, request-history
 * observation, descendant cleanup, proxy shutdown) is recorded in `exit.json`
 * as `error`, and the lifecycle then reads `unverifiable` rather than complete.
 *
 * @param {string} turnDir - Directory holding turn.json and receiving output.
 * @param {object} [deps] - Test seams; production uses the defaults.
 * @param {(turn: object) => Promise<object>} [deps.prepare] - Starts the owned proxy and builds the command.
 * @param {typeof readOpenCodexObservation} [deps.observe] - Reads the request-history observation.
 * @param {(group: number) => number[] | null} [deps.groupMembers] - Lists a process group's members.
 * @returns {Promise<object>} The exit record written to exit.json.
 */
export async function runTurn(turnDir, deps = {}) {
  const prepare = deps.prepare ?? prepareOpenCodexTurn;
  const observe = deps.observe ?? readOpenCodexObservation;
  const groupMembers = deps.groupMembers ?? processGroupMembers;
  const turn = readJSON(path.join(turnDir, "turn.json"));
  const input = turn.stdinFile
    ? fs.readFileSync(path.join(turnDir, turn.stdinFile), "utf8")
    : "";
  const stdout = fs.openSync(path.join(turnDir, "stream.jsonl"), "a");
  const stderr = fs.openSync(path.join(turnDir, "stderr.txt"), "a");
  let proxy = null;
  let binding = null;
  let command;
  let environment = process.env;
  let historyBoundary = null;
  try {
    if (turn.runner) {
      ({ proxy, binding, historyBoundary, command, environment } =
        await prepare(turn));
    } else {
      command = resolveCommand(turn.argv);
    }
  } catch (error) {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
    const record = {
      code: null,
      signal: null,
      timedOut: false,
      stopped: false,
      error: String(error.message),
      killError: null,
      endedAt: new Date().toISOString(),
      durationMs: 0,
    };
    writeJSON(path.join(turnDir, "exit.json"), record);
    if (turn.runner) {
      writeJSON(
        path.join(turnDir, "lifecycle.json"),
        buildLifecycle({
          turnDir,
          observed: null,
          inputAccepted: false,
          exitObserved: false,
          cancelRequested: false,
          descendantsExited: false,
          orphansTerminated: 0,
          proxyExited: false,
        }),
      );
    }
    return record;
  }
  const child = spawn(command[0], command.slice(1), {
    cwd: turn.cwd,
    env: environment,
    shell: false,
    windowsHide: true,
    // detached so the child gets its own process group on POSIX, enabling
    // killTree to signal all grandchildren via the negative-pid group kill.
    detached: process.platform !== "win32",
    stdio: ["pipe", stdout, stderr],
  });
  writeJSON(path.join(turnDir, "pids.json"), {
    runner: process.pid,
    child: child.pid ?? null,
  });
  child.stdin.on("error", () => {});
  // Accepted only once the prompt has been flushed to the provider's stdin.
  let inputAccepted = false;
  child.stdin.end(input, (error) => {
    if (!error) inputAccepted = true;
  });

  return new Promise((resolve) => {
    let reason = null;
    let settled = false;
    let killError = null;
    const startedAt = Date.now();
    const stopChild = (why) => {
      if (reason) return;
      reason = why;
      killError = killTree(child.pid);
      setTimeout(() => {
        const err = killTree(child.pid, "SIGKILL");
        if (err && !killError) killError = err;
      }, KILL_GRACE_MS).unref();
    };
    const poll = setInterval(() => {
      if (fs.existsSync(path.join(turnDir, "stop.request")))
        stopChild("stopped");
      else if (turn.timeoutMs && Date.now() - startedAt > turn.timeoutMs) {
        stopChild("timed-out");
      }
    }, POLL_MS);
    // Descendants that outlive the provider are still owned by this runner.
    // They are ended and counted; the tree counts as gone only once the group
    // is observed empty, which no platform without a process group can show.
    const settleDescendants = async () => {
      if (!child.pid || process.platform === "win32")
        return { descendantsExited: false, orphansTerminated: 0 };
      const leftover = groupMembers(child.pid);
      if (leftover === null)
        return { descendantsExited: false, orphansTerminated: 0 };
      if (leftover.length > 0) killTree(child.pid, "SIGKILL");
      for (let i = 0; i < 40 && groupMembers(child.pid)?.length !== 0; i += 1)
        await new Promise((done) => setTimeout(done, 50));
      return {
        descendantsExited: groupMembers(child.pid)?.length === 0,
        orphansTerminated: leftover.length,
      };
    };
    const finish = (code, signal, error) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      fs.closeSync(stdout);
      fs.closeSync(stderr);
      const record = {
        code: code ?? null,
        signal: signal ?? null,
        timedOut: reason === "timed-out",
        stopped: reason === "stopped",
        error: error ? String(error.message) : null,
        killError: killError ?? null,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      };
      // Only the provider's own close event proves its exit; a spawn or
      // process error does not, whatever the observation later finds.
      const exitObserved = !error;
      (async () => {
        let observed = null;
        let descendants = { descendantsExited: false, orphansTerminated: 0 };
        let proxyExited = false;
        try {
          if (turn.runner) descendants = await settleDescendants();
          if (proxy && binding && historyBoundary) {
            observed = await observe({
              ...binding,
              port: proxy.port,
              provider: turn.runner.logicalProvider,
              model: turn.runner.model,
              historyBoundary,
            });
            writeJSON(path.join(turnDir, "opencodex.json"), observed);
          }
        } catch (observationError) {
          record.error ??= String(observationError.message);
        }
        try {
          if (proxy) {
            const stopped = await proxy.stop();
            proxyExited = stopped?.descendantsExited === true;
          }
        } catch (stopError) {
          record.error ??= String(stopError.message);
        }
        try {
          if (turn.runner) {
            writeJSON(
              path.join(turnDir, "lifecycle.json"),
              buildLifecycle({
                turnDir,
                observed,
                inputAccepted,
                exitObserved,
                cancelRequested: reason === "stopped",
                ...descendants,
                proxyExited,
              }),
            );
          }
        } catch (lifecycleError) {
          record.error ??= String(lifecycleError.message);
        }
        writeJSON(path.join(turnDir, "exit.json"), record);
        resolve(record);
      })();
    };
    child.on("error", (error) => finish(null, null, error));
    child.on("close", (code, signal) => finish(code, signal));
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runTurn(path.resolve(process.argv[2])).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
