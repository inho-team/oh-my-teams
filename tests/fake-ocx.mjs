/** A fake OpenCodex runtime whose launcher behaves as its mode says, for proxy tests. */
import fs from "node:fs";
import path from "node:path";
import {
  killWindowsProcessTree,
  openCodexLaunch,
} from "../plugins/oh-my-teams/scripts/opencodex.mjs";

// The launcher runs as the extensionless POSIX `.bin/ocx` script and as the
// Windows `bin/ocx.mjs` module, so it uses only `process.getBuiltinModule`.
const script = (mode, pids) => `#!${process.execPath}
const { createServer } = process.getBuiltinModule("node:http");
const fs = process.getBuiltinModule("node:fs");
const { spawn } = process.getBuiltinModule("node:child_process");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const pids = ${JSON.stringify(pids)};
const record = (name, pid) => fs.writeFileSync(pids + "/" + name, String(pid));
const serve = "require('node:http').createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({status:'ok',port:" + port + ",pid:process.pid}))}).listen(" + port + ",'127.0.0.1');process.on('SIGTERM',()=>{if(!process.env.STUBBORN)process.exit(0)});setInterval(()=>{},1000)";
const mode = ${JSON.stringify(mode)};
record("launcher", process.pid);
fs.writeFileSync(pids + "/home", process.env.HOME || "");
if (process.env.USERPROFILE) fs.writeFileSync(pids + "/userprofile", process.env.USERPROFILE);
const health = (body) => (q, r) => {
  r.setHeader("content-type", "application/json");
  r.end(JSON.stringify(body));
};
if (mode === "serve" || mode === "stubborn-descendant") {
  createServer(health({ status: "ok", port, pid: process.pid })).listen(port, "127.0.0.1");
  if (mode === "stubborn-descendant") {
    const d = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
    record("descendant", d.pid);
  }
  process.on("SIGTERM", () => process.exit(0));
} else if (mode === "serve-child") {
  // As the real launcher does: a child process holds the port, the launcher stays.
  const d = spawn(process.execPath, ["-e", serve], { stdio: "ignore" });
  record("server", d.pid);
  setInterval(() => {}, 1000);
} else if (mode === "impostor") {
  // Another group answers health while the launcher stays alive.
  const d = spawn(process.execPath, ["-e", serve], { detached: true, stdio: "ignore" });
  d.unref();
  record("impostor", d.pid);
  setInterval(() => {}, 1000);
} else if (mode === "outside-listener") {
  // A relay starts the server and exits before the server listens. Windows
  // never re-parents, so the server's parent pid names a process that is gone
  // and the server is not reachable from the launcher.
  const relay = "const {spawn}=require('node:child_process');const d=spawn(process.execPath,['-e',process.argv[1]],{stdio:'ignore',detached:true});d.unref();require('node:fs').writeFileSync(process.argv[2],String(d.pid));";
  spawn(process.execPath, ["-e", relay, "setTimeout(()=>{" + serve + "},1500)", pids + "/outside"], { stdio: "ignore" });
  setInterval(() => {}, 1000);
} else if (mode === "leaves-descendant") {
  // The launcher exits at once; a descendant keeps the port.
  const d = spawn(process.execPath, ["-e", serve], { stdio: "ignore" });
  d.unref();
  record("descendant", d.pid);
} else if (mode === "wrong-health") {
  createServer((q, r) => r.end(JSON.stringify({ status: "ok", port: port + 1 }))).listen(port, "127.0.0.1");
  process.on("SIGTERM", () => process.exit(0));
} else if (mode === "wrong-pid") {
  createServer(health({ status: "ok", port, pid: process.pid + 1 })).listen(port, "127.0.0.1");
}
`;

/**
 * Writes a fake OpenCodex launcher where `openCodexLaunch` says it starts.
 * @param {string} prefix - Runtime prefix that will hold `node_modules`.
 * @param {string} mode - How the launcher behaves.
 * @param {string} pids - Directory where the launcher records the pids it makes.
 * @returns {void}
 */
export function writeFakeOcx(prefix, mode, pids) {
  const launch = openCodexLaunch(prefix);
  const file = process.platform === "win32" ? launch.args[0] : launch.command;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, script(mode, pids), { mode: 0o755 });
}

/**
 * Ends every process a fake launcher recorded, whatever the platform.
 * @param {string} pids - Directory the launcher recorded into.
 * @returns {void}
 */
export function killRecorded(pids) {
  for (const name of fs.readdirSync(pids)) {
    const pid = Number(fs.readFileSync(path.join(pids, name), "utf8"));
    // Files that hold a path or nothing are not pids; 0 would name our own group.
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (process.platform === "win32") {
      killWindowsProcessTree(pid);
      continue;
    }
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {}
    }
  }
}
