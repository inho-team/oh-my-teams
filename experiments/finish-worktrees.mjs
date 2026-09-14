/** Finalizes the historical benchmark worktrees retained for inspection. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  readJSON,
  writeJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import { runOrcaJson } from "../plugins/oh-my-teams/scripts/orca-adapter.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = readJSON(
  path.join(root, "experiments/results/2026-09-14T07-51-22-988Z/manifest.json"),
);
const smoke = readJSON(path.join(root, ".omt/smoke-setup/receipt.json"));
const owned = [
  ...manifest.records.map((r) => ({
    worktree: r.worktree,
    comment: `Benchmark complete: ${r.model}; evidence in experiments/REPORT.md`,
  })),
  {
    worktree: smoke.worktree,
    comment:
      "GPT-OSS harness smoke passed; evidence preserved in coordinator .omt/runs",
  },
];
async function orca(args) {
  return (await runOrcaJson("orca", args, { cwd: root })).result;
}
const results = [];
for (const { worktree, comment } of owned) {
  assert(
    worktree.parentWorktreeId === manifest.records[0].worktree.parentWorktreeId,
    "Unexpected parent",
  );
  assert(
    /^(bench-[012]-\d+|intern-smoke-\d+)$/.test(worktree.displayName),
    "Not an experiment workspace",
  );
  const state = await orca([
    "terminal",
    "list",
    "--worktree",
    `id:${worktree.id}`,
  ]);
  const closed = [];
  for (const terminal of state.terminals) {
    assert(terminal.worktreeId === worktree.id, "Terminal ownership mismatch");
    const preview = (terminal.preview || "").trim();
    assert(
      preview.startsWith("PS ") &&
        preview.endsWith(">") &&
        preview.replaceAll("\\", "/").includes(worktree.path),
      "Terminal is not a proven unused experiment shell",
    );
    await orca(["terminal", "close", "--terminal", terminal.handle]);
    closed.push(terminal.handle);
  }
  await orca([
    "worktree",
    "set",
    "--worktree",
    `id:${worktree.id}`,
    "--workspace-status",
    "completed",
    "--comment",
    comment,
  ]);
  results.push({
    worktreeId: worktree.id,
    closed,
    retainedForInspection: true,
  });
}
writeJSON(path.join(root, ".omt/experiment-cleanup.json"), results);
console.log(JSON.stringify(results, null, 2));
