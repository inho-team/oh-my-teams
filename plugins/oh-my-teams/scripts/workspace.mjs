/** Prepares immutable task inputs and attaches verified runtime workspaces. */
import fs from "node:fs";
import path from "node:path";
import { assert, hash, readJSON, validateOrg, writeJSON } from "./core.mjs";
import { git } from "./evidence.mjs";
import { taskHash, validateTask } from "./contracts.mjs";
import { executionAdapter } from "./adapters.mjs";

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

/**
 * Attaches an existing workspace receipt after checking its actual Git state.
 *
 * The runtime that issued the receipt is the only one that can confirm it, so
 * reading the claim and re-observing it are delegated to that runtime's
 * adapter. What stays here is what holds for any of them: the confirmed path
 * has to be the workspace being attached, and the Git tree there has to be the
 * one the frozen task named.
 *
 * @param {object} input - Paths, snapshots, receipts, and optional runtime name.
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
  // Records written before the port existed name no runtime, and every one of
  // them came from Orca, so that is what an absent name still means.
  const adapter = executionAdapter(input.runtimeName ?? "orca");
  adapter.assertDiscovery(runtime, executable);

  const parentRepo = fs.realpathSync(input.parentRepo);
  const workspace = fs.realpathSync(input.workspace);
  const worktree = adapter.readWorkspaceClaim(receipt);
  // A receipt naming a path that does not exist is a mismatched receipt, not a
  // filesystem error: resolving it directly surfaced a raw lstat ENOENT with no
  // indication of which claim failed.
  assert(
    resolvedOrNull(worktree.path) === workspace,
    "Receipt worktree path does not match the attached workspace",
  );
  // A supplied receipt is only a claim until the selected runtime returns it.
  const confirmed = await adapter.confirmWorkspace(worktree, {
    parentRepo,
    executable,
    runtime,
    execute: input.execute,
  });
  const observed = confirmed.observed;
  assert(
    resolvedOrNull(confirmed.path) === workspace,
    "Runtime lookup does not match the attached workspace",
  );

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
