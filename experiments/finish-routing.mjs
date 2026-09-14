#!/usr/bin/env node
/** Closes one exact experiment worktree's terminals and retains its evidence. */
import path from "node:path";
import {
  assert,
  readJSON,
  writeJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  discoverOrcaRuntime,
  runOrcaJson,
} from "../plugins/oh-my-teams/scripts/orca-adapter.mjs";

const manifestFile = path.resolve(process.argv[2] ?? "");
assert(
  process.argv.includes("--confirm-close"),
  "Refusing terminal cleanup without --confirm-close",
);
const manifest = readJSON(manifestFile);
assert(
  manifest.experiment === "routing-e1-e2" && manifest.worktree?.id,
  "Routing manifest with worktree required",
);
const runtime = await discoverOrcaRuntime(
  manifest.runtime?.executable ?? "orca",
);
assert(
  runtime.runtimeId === manifest.runtime.runtimeId,
  "Orca runtime changed; inspect worktree before cleanup",
);
await runOrcaJson(runtime.executable, [
  "terminal",
  "close",
  "--worktree",
  `id:${manifest.worktree.id}`,
  "--all",
]);
await runOrcaJson(runtime.executable, [
  "worktree",
  "set",
  "--worktree",
  `id:${manifest.worktree.id}`,
  "--workspace-status",
  "completed",
  "--comment",
  `Routing ${manifest.mode} complete; retained for evidence`,
]);
manifest.cleanup = {
  status: "completed",
  worktreeRetained: true,
  completedAt: new Date().toISOString(),
  runtime,
};
writeJSON(manifestFile, manifest);
console.log(JSON.stringify(manifest.cleanup, null, 2));
