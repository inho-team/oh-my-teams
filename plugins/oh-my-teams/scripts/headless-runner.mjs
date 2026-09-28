#!/usr/bin/env node
/**
 * Historical headless lifecycle evidence helpers and a retired runner guard.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { readJSON } from "./core.mjs";

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

/**
 * Refuses the retired headless provider runner.
 *
 * Historical parser and lifecycle helpers remain exported so records made
 * before the removal can be read. Neither direct imports nor `node
 * headless-runner.mjs` may create a provider process again.
 *
 * @param {string} turnDir - Retired turn directory argument.
 * @param {object} [deps] - Retired test seam argument.
 * @returns {Promise<never>} This function always rejects.
 */
export async function runTurn(turnDir, deps = {}) {
  void turnDir;
  void deps;
  throw new Error(
    "New headless runner execution was removed; read legacy records or use an Orca role terminal",
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.error(
    "New headless runner execution was removed; read legacy records or use an Orca role terminal",
  );
  process.exitCode = 1;
}
