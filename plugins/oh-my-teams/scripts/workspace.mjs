/** Prepares immutable task inputs and attaches verified Orca workspaces. */
import fs from "node:fs";
import path from "node:path";
import { assert, hash, readJSON, validateOrg, writeJSON } from "./core.mjs";
import { git } from "./evidence.mjs";
import { taskHash, validateTask } from "./contracts.mjs";
import { runOrcaJson } from "./orca-adapter.mjs";

function resolvedOrNull(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * Freezes a task's symbolic base reference and writes its input snapshot.
 *
 * @param {object} org - Valid organization snapshot.
 * @param {object} task - Task v1 or v2 input.
 * @param {string} repo - Existing Git repository.
 * @param {string} outputDir - Destination for immutable prepared inputs.
 * @returns {Promise<object>} Snapshot paths, frozen task, and manifest.
 * @throws {Error} When validation or base resolution fails.
 */
export async function prepareInput(org, task, repo, outputDir) {
  validateOrg(org);
  validateTask(task);
  const repository = fs.realpathSync(repo);
  const base = await git(repository, [
    "rev-parse",
    "--verify",
    `${task.baseRef}^{commit}`,
  ]);
  const frozenTask = { ...task, baseRef: base };
  const organizationFile = path.join(outputDir, "organization.json");
  const taskFile = path.join(outputDir, "task.json");
  const manifestFile = path.join(outputDir, "input.json");

  writeJSON(organizationFile, org);
  writeJSON(taskFile, frozenTask);
  const manifest = {
    schemaVersion: 1,
    taskId: task.id,
    taskRevision: task.revision ?? 1,
    taskHash: taskHash(frozenTask),
    organizationRevision: org.revision,
    organizationHash: hash(org),
    base,
    createdAt: new Date().toISOString(),
  };
  writeJSON(manifestFile, manifest);
  return {
    org: organizationFile,
    task: taskFile,
    manifest: manifestFile,
    frozenTask,
    input: manifest,
  };
}

function validateRuntimeReceipt(runtime, executable) {
  assert(
    runtime?.schemaVersion === 1 &&
      runtime.executable === executable &&
      runtime.guide?.id === "orca-cli" &&
      /^[a-f0-9]{64}$/.test(runtime.guide.sha256),
    "Version-matched Orca runtime discovery receipt required",
  );
  assert(
    runtime.versionsMatch !== false,
    "Orca CLI and runtime versions differ; rediscover before attaching",
  );
}

/**
 * Attaches an existing Orca receipt after checking its actual Git workspace.
 *
 * @param {object} input - Parent/workspace paths, snapshots, and Orca receipts.
 * @returns {Promise<object>} Attached identity and persisted record paths.
 * @throws {Error} When runtime identity, receipt path, Git root, or base differs.
 */
export async function attachWorkspace(input) {
  const { stateDir, name, org, task, receipt, executable, runtime } = input;
  validateOrg(org);
  validateTask(task);
  assert(
    /^[a-z][a-z0-9-]*$/.test(name),
    "Worktree name must be lower-case words/numbers/hyphens",
  );
  validateRuntimeReceipt(runtime, executable);

  const parentRepo = fs.realpathSync(input.parentRepo);
  const workspace = fs.realpathSync(input.workspace);
  const worktree = receipt?.result?.worktree;
  assert(
    receipt.ok !== false && worktree?.id && worktree.path,
    "Orca receipt missing worktree identity",
  );
  // A receipt naming a path that does not exist is a mismatched receipt, not a
  // filesystem error: resolving it directly surfaced a raw lstat ENOENT with no
  // indication of which claim failed.
  assert(
    resolvedOrNull(worktree.path) === workspace,
    "Receipt worktree path does not match the attached workspace",
  );
  // A supplied receipt is only a claim until the selected runtime returns it.
  const observed = await runOrcaJson(
    executable,
    ["worktree", "show", "--worktree", `id:${worktree.id}`],
    { cwd: parentRepo, execute: input.execute },
  );
  const current = observed.result?.worktree;
  assert(
    current?.id === worktree.id &&
      current.path &&
      fs.realpathSync(current.path) === workspace,
    "Orca lookup does not match the supplied worktree receipt",
  );
  if (runtime.runtimeId && observed._meta?.runtimeId) {
    assert(
      runtime.runtimeId === observed._meta.runtimeId,
      "Orca runtime changed since discovery",
    );
  }
  if (worktree.instanceId) {
    assert(
      current.instanceId === worktree.instanceId,
      "Orca worktree instance changed",
    );
  }

  const topLevel = fs.realpathSync(
    await git(workspace, ["rev-parse", "--show-toplevel"]),
  );
  assert(
    topLevel === workspace,
    "Attached workspace is not the root of the reported Git worktree",
  );
  assert(
    (await git(workspace, ["rev-parse", "HEAD"])) === task.baseRef,
    "Attached workspace HEAD does not match the frozen task base",
  );
  assert(
    (await git(parentRepo, [
      "rev-parse",
      "--verify",
      `${task.baseRef}^{commit}`,
    ])) === task.baseRef,
    "Frozen task base is not present in the parent repository",
  );

  const snapshotDir = path.join(workspace, ".omt");
  const organizationFile = path.join(snapshotDir, "organization.json");
  const taskFile = path.join(snapshotDir, "task.json");
  const recordFile = path.join(stateDir, "worktrees", `${name}.json`);
  writeJSON(organizationFile, org);
  writeJSON(taskFile, task);

  const record = {
    schemaVersion: 1,
    worktree,
    taskId: task.id,
    taskRevision: task.revision ?? 1,
    taskHash: taskHash(task),
    organizationRevision: org.revision,
    organizationHash: hash(org),
    executable,
    runtime,
    receipt,
    observedReceipt: observed,
    attachedAt: new Date().toISOString(),
  };
  writeJSON(recordFile, record);
  return {
    worktree,
    state: stateDir,
    org: organizationFile,
    task: taskFile,
    record: recordFile,
  };
}

/**
 * Reads and validates a prepared input directory.
 *
 * @param {string} directory - Directory created by {@link prepareInput}.
 * @returns {{org: object, task: object, input: object}} Prepared documents.
 * @throws {Error} When files are missing or snapshots are invalid.
 */
export function readPreparedInput(directory) {
  return {
    org: validateOrg(readJSON(path.join(directory, "organization.json"))),
    task: validateTask(readJSON(path.join(directory, "task.json"))),
    input: readJSON(path.join(directory, "input.json")),
  };
}
