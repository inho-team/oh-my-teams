/**
 * Test support: drives a workflow task to "accepted" through the runtime path
 * (attach, settle, real evidence, acceptOutcome, resume) instead of writing
 * state.json or gate files by hand, so a fixture that needs an accepted
 * workflow reaches it the way production does (Appendix G, decision G-2).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJSON, writeJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import { taskHash } from "../plugins/oh-my-teams/scripts/contracts.mjs";
import { verify } from "../plugins/oh-my-teams/scripts/evidence.mjs";
import { acceptOutcome } from "../plugins/oh-my-teams/scripts/gates.mjs";
import {
  buildDocId,
  saveDocument,
} from "../plugins/oh-my-teams/scripts/documents.mjs";
import { resolveRegisteredKickoffFromState } from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";
import {
  attachExecution,
  createWorkflow,
  readWorkflow,
  recordSettlement,
  resumeWorkflow,
} from "../plugins/oh-my-teams/scripts/workflow.mjs";

/**
 * Builds a minimal edit task whose one check always passes.
 *
 * @param {string} id - Task identifier.
 * @returns {object} Task contract.
 */
export function taskBody(id) {
  return {
    schemaVersion: 2,
    revision: 1,
    kind: "edit",
    id,
    goal: "noop",
    instruction: "noop",
    nonGoals: [],
    constraints: [],
    files: [`${id}.txt`],
    checks: [[process.execPath, "-e", "process.exit(0)"]],
    acceptance: [
      { id: "check", description: "check", method: "check", checkIndexes: [0] },
    ],
    dependencies: [],
    contractRefs: [],
    contextRefs: [],
    openQuestions: [],
    reviewRequirements: [],
    environment: "test",
    baseRef: "HEAD",
    risk: "low",
  };
}

/**
 * Creates a one-task workflow whose task file lives in `repoDir`.
 *
 * @param {string} org - Organization JSON path.
 * @param {string} stateDir - PM state directory.
 * @param {string} repoDir - Git directory holding the task file.
 * @param {string} workflowId - Workflow identifier.
 * @param {object} [options] - Task overrides.
 * @param {string[][]} [options.checks] - Check commands replacing the default passing one.
 * @param {string} [options.role] - Role of the task (a worker organization needs "worker").
 * @param {string} [options.taskId] - Task identifier; workflows of one state directory that must both stay accepted need distinct ones, because a gate record is keyed by it.
 * @returns {Promise<object>} The created workflow.
 */
export async function createSingleTaskWorkflow(
  org,
  stateDir,
  repoDir,
  workflowId,
  { checks, role = "senior", taskId = "a" } = {},
) {
  writeJSON(path.join(repoDir, `${taskId}.json`), {
    ...taskBody(taskId),
    ...(checks === undefined ? {} : { checks }),
  });
  return createWorkflow(
    stateDir,
    {
      schemaVersion: 1,
      id: workflowId,
      goal: "fixture's own workflow",
      repo: ".",
      tasks: [{ file: `${taskId}.json`, role }],
      policy: { maxRunning: 1, maxReviewPending: 1 },
      budget: { maxAttempts: 1, maxCalls: 4 },
    },
    readJSON(org),
    repoDir,
  );
}

/**
 * Runs `work` while the repository's local exclude file ignores every
 * untracked file, then puts that file back exactly as it was, whether `work`
 * settles or throws. Untracked files (the task file, the organization,
 * evidence stores) would otherwise change the workspace fingerprint between
 * the two reads verify makes. Only a repository under the operating system's
 * temporary directory is accepted, so a test can never edit a real checkout.
 *
 * @param {string} repo - Git repository (or worktree) of the fixture.
 * @param {() => Promise<*>} work - Work that needs the untracked files hidden.
 * @returns {Promise<*>} What `work` resolves to.
 * @throws {Error} When `repo` is not strictly inside the temporary directory.
 */
export async function withUntrackedHidden(repo, work) {
  const tmp = fs.realpathSync(os.tmpdir());
  const real = fs.realpathSync(repo);
  if (!real.startsWith(`${tmp}${path.sep}`)) {
    throw new Error(
      `Refusing to edit the exclude file of ${real}: not inside ${tmp}`,
    );
  }
  const exclude = path.resolve(
    real,
    execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: real,
    })
      .toString()
      .trim(),
  );
  const existed = fs.existsSync(exclude);
  const original = existed ? fs.readFileSync(exclude) : null;
  const createdDir = !fs.existsSync(path.dirname(exclude));
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.appendFileSync(
    exclude,
    `${original === null || original.length === 0 || original.at(-1) === 10 ? "" : "\n"}*\n`,
  );
  try {
    return await work();
  } finally {
    if (original === null) fs.rmSync(exclude, { force: true });
    else fs.writeFileSync(exclude, original);
    if (createdDir)
      fs.rmSync(path.dirname(exclude), { recursive: true, force: true });
  }
}

/**
 * Saves the acceptance-ref document a registered kickoff's outcome-accepted
 * gate requires before `acceptOutcome` runs for a workflow's task; a state
 * directory no kickoff owns needs none, so nothing is written for it.
 *
 * @param {string} stateDir - PM state directory.
 * @param {string} workflowId - Workflow the accepted task belongs to.
 * @param {string} decisionId - Decision id the acceptance will use.
 * @returns {Promise<void>} Settles once the document, if any, is saved.
 */
export async function recordAcceptanceRef(stateDir, workflowId, decisionId) {
  // Fixture-only ordering: under a registered kickoff the outcome-accepted
  // gate also requires the acceptance-ref document, and the decision id is
  // chosen here, so the document goes in before acceptOutcome. This is not
  // evidence of the production order nor of which CLI role may write it.
  const registered = await resolveRegisteredKickoffFromState(stateDir);
  const kickoffHash = registered?.kickoffHash;
  if (kickoffHash !== undefined) {
    saveDocument(stateDir, {
      schemaVersion: 1,
      docId: buildDocId({
        kickoffHash,
        workflowId,
        stageSlug: "acceptance",
        docType: "acceptance-ref",
        localId: decisionId,
      }),
      stage: "acceptance",
      kickoffId: kickoffHash,
      workflowId,
      revision: 1,
      state: "resolved",
      author: { role: "pm", executionId: "pm" },
      createdAt: new Date().toISOString(),
      basedOnRevision: null,
      reason: "accepted-workflow fixture",
    });
  }
}

/**
 * Takes an existing workflow's component task from creation to accepted:
 * the attempt's receipt names `resultRepo` as its worktree, evidence is
 * verified in that repository, and acceptOutcome and resumeWorkflow record
 * the acceptance.
 *
 * @param {object} options - Task and repository.
 * @param {string} options.stateDir - PM state directory.
 * @param {string} options.workflowId - Workflow identifier.
 * @param {string} options.taskId - Component task identifier.
 * @param {string} options.resultRepo - Repository the task's worktree receipt names.
 * @returns {Promise<{stateDir: string, workflowId: string, revision: number, file: string}>} Where the workflow now stands.
 */
export async function acceptComponentTask({
  stateDir,
  workflowId,
  taskId,
  resultRepo,
}) {
  return withUntrackedHidden(resultRepo, async () => {
    // Workflows of one state directory share its decisions and gates, so each
    // acceptance gets execution and run ids of its own.
    const runId = `${workflowId}-${taskId}`;
    const revision = () => readWorkflow(stateDir, workflowId).state.revision;
    attachExecution(stateDir, workflowId, revision(), {
      schemaVersion: 1,
      eventId: `attach-${runId}`,
      attemptId: `attempt-${runId}`,
      taskId,
      callAllowance: 1,
      receipt: {
        executionId: runId,
        runId,
        taskId,
        dispatchId: runId,
        worktreeId: `wt-${taskId}::${resultRepo}`,
      },
    });
    recordSettlement(stateDir, workflowId, revision(), {
      schemaVersion: 1,
      eventId: `settle-${runId}`,
      attemptId: `attempt-${runId}`,
      taskId,
      executionId: runId,
      outcome: "settled",
      callsUsed: 0,
    });
    const task = readWorkflow(stateDir, workflowId).tasks[taskId];
    const report = {
      taskId,
      taskHash: taskHash(task),
      taskRevision: task.revision,
      runId,
      evidence: await verify(resultRepo, {
        baseRef: task.baseRef,
        commands: task.checks,
        environment: task.environment,
        store: path.join(stateDir, "evidence"),
      }),
    };
    // The accepted report, kept where the result-repository decision looks for
    // it (`<state>/reports/*.json`); reports are written by the PM, not by verify.
    fs.mkdirSync(path.join(stateDir, "reports"), { recursive: true });
    writeJSON(path.join(stateDir, "reports", `${runId}.json`), {
      schemaVersion: 1,
      ...report,
      head: report.evidence.fingerprint.head,
    });
    const decisionId = `accept-${workflowId}-${taskId}`;
    await recordAcceptanceRef(stateDir, workflowId, decisionId);
    await acceptOutcome(
      resultRepo,
      task,
      report,
      {
        schemaVersion: 1,
        id: decisionId,
        decider: { kind: "pm", executionId: "pm" },
        criteria: task.acceptance.map((item) => item.id),
        basis: "the task's check passed",
      },
      stateDir,
      { workflowId },
    );
    resumeWorkflow(stateDir, workflowId, revision());
    const snapshot = readWorkflow(stateDir, workflowId);
    return {
      stateDir,
      workflowId,
      revision: snapshot.state.revision,
      file: path.join(snapshot.dir, "state.json"),
    };
  });
}

/**
 * Creates a one-task workflow and takes its task to accepted, leaving the
 * workflow itself for the caller to accept with `acceptWorkflowIntegration`.
 *
 * @param {object} options - Workflow and repository.
 * @param {string} options.org - Organization JSON path.
 * @param {string} options.stateDir - PM state directory.
 * @param {string} options.taskDir - Git directory holding the task file.
 * @param {string} options.workflowId - Workflow identifier.
 * @param {string} options.resultRepo - Repository the task's receipt names.
 * @param {string} [options.role] - Role of the task, see `createSingleTaskWorkflow`.
 * @param {string} [options.taskId] - Task identifier, see `createSingleTaskWorkflow`.
 * @returns {Promise<{stateDir: string, workflowId: string, revision: number, file: string}>} Where the workflow now stands.
 */
export async function acceptTaskThroughRuntime({
  org,
  stateDir,
  taskDir,
  workflowId,
  resultRepo,
  role,
  taskId = "a",
}) {
  await createSingleTaskWorkflow(org, stateDir, taskDir, workflowId, {
    role,
    taskId,
  });
  return acceptComponentTask({ stateDir, workflowId, taskId, resultRepo });
}
