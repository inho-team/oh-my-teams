/** Handoff checkpoints a worker keeps so a fallback profile can take its task over. */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assert, readJSON, writeJSON } from "./core.mjs";
import { readWorkflowSnapshot } from "./workflow-store.mjs";

/** Sections every checkpoint.md must carry, each once and non-empty. */
export const HANDOFF_SECTIONS = Object.freeze([
  "목표",
  "끝낸 일",
  "남은 일",
  "결정과 이유",
  "검증 상태",
  "다음 단계",
  "주의 사항",
]);

/**
 * Validates a checkpoint document against the required sections.
 *
 * @param {string} text - Markdown checkpoint written by the worker.
 * @returns {Record<string, string>} Section bodies keyed by heading.
 * @throws {Error} When a section is missing, repeated, empty, or unknown.
 */
export function validateCheckpoint(text) {
  assert(typeof text === "string" && text.trim(), "Checkpoint text required");
  const sections = {};
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      assert(
        HANDOFF_SECTIONS.includes(current),
        `Unknown checkpoint section: ${current}`,
      );
      assert(
        !(current in sections),
        `Duplicate checkpoint section: ${current}`,
      );
      sections[current] = [];
    } else if (current) sections[current].push(line);
  }
  const bodies = {};
  for (const name of HANDOFF_SECTIONS) {
    assert(name in sections, `Missing checkpoint section: ${name}`);
    bodies[name] = sections[name].join("\n").trim();
    assert(bodies[name], `Empty checkpoint section: ${name}`);
  }
  return bodies;
}

/**
 * Resolves the handoff directory of one workflow task.
 *
 * @param {string} stateDir - PM worktree `.omt` state directory.
 * @param {string} workflowId - Workflow ID.
 * @param {string} taskId - Task ID declared by the workflow.
 * @returns {{directory: string, task: object}} Directory and the task's state.
 * @throws {Error} When the workflow or the task does not exist.
 */
export function handoffDirectory(stateDir, workflowId, taskId) {
  const { dir, state } = readWorkflowSnapshot(stateDir, workflowId);
  const task = Object.hasOwn(state.tasks, taskId) ? state.tasks[taskId] : null;
  assert(task, `Unknown workflow task: ${taskId}`);
  return {
    directory: path.join(dir, "tasks", taskId, "handoff"),
    task,
  };
}

function gitHead(repo) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(`Cannot read HEAD of ${repo}`);
  }
}

/**
 * Validates and stores a worker's checkpoint, replacing the previous one.
 *
 * @param {string} stateDir - PM worktree `.omt` state directory.
 * @param {string} workflowId - Workflow ID.
 * @param {string} taskId - Task ID declared by the workflow.
 * @param {{text: string, repo: string}} checkpoint - Markdown and the worker's worktree.
 * @returns {object} The stored checkpoint.json record and file paths.
 * @throws {Error} When the document is invalid or HEAD cannot be read.
 */
export function recordCheckpoint(stateDir, workflowId, taskId, { text, repo }) {
  validateCheckpoint(text);
  const { directory, task } = handoffDirectory(stateDir, workflowId, taskId);
  const head = gitHead(repo);
  const metaFile = path.join(directory, "checkpoint.json");
  const previous = fs.existsSync(metaFile) ? readJSON(metaFile) : null;
  const markdownFile = path.join(directory, "checkpoint.md");
  fs.mkdirSync(directory, { recursive: true });
  const temporaryFile = `${markdownFile}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryFile, text.endsWith("\n") ? text : `${text}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporaryFile, markdownFile);
  const record = {
    schemaVersion: 1,
    workflowId,
    taskId,
    role: task.role,
    repo: path.resolve(repo),
    head,
    sequence: (previous?.sequence ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  writeJSON(metaFile, record);
  return { ...record, checkpoint: markdownFile, meta: metaFile };
}
