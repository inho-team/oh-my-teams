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
import { readJSON, resolveCommand, writeJSON } from "./core.mjs";

const POLL_MS = 500;
const KILL_GRACE_MS = 5000;

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

/**
 * Runs the turn described by `<turnDir>/turn.json` to completion.
 *
 * @param {string} turnDir - Directory holding turn.json and receiving output.
 * @returns {Promise<object>} The exit record written to exit.json.
 */
export function runTurn(turnDir) {
  const turn = readJSON(path.join(turnDir, "turn.json"));
  const input = turn.stdinFile
    ? fs.readFileSync(path.join(turnDir, turn.stdinFile), "utf8")
    : "";
  const stdout = fs.openSync(path.join(turnDir, "stream.jsonl"), "a");
  const stderr = fs.openSync(path.join(turnDir, "stderr.txt"), "a");
  const command = resolveCommand(turn.argv);
  const child = spawn(command[0], command.slice(1), {
    cwd: turn.cwd,
    env: process.env,
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
  child.stdin.end(input);

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
      writeJSON(path.join(turnDir, "exit.json"), record);
      resolve(record);
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
