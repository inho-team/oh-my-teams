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
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJSON, resolveCommand, writeJSON } from "./core.mjs";

const POLL_MS = 500;
const KILL_GRACE_MS = 5000;

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
    const startedAt = Date.now();
    const stopChild = (why) => {
      if (reason) return;
      reason = why;
      child.kill();
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
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
