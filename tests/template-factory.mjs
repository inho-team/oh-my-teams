/**
 * Factory for creating and cleaning up Git template repositories used in tests.
 * @module tests/template-factory
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { run } from "../plugins/oh-my-teams/scripts/core.mjs";

let templateRepoDir;

/**
 * Initializes and returns a template bare repository path.
 * @returns {Promise<string>} The path to the initialized template repository.
 */
export async function getTemplateRepo() {
  if (templateRepoDir) return templateRepoDir;
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "omt-repo-template-")),
  );
  for (const args of [
    ["init"],
    ["config", "user.name", "Orca Test"],
    ["config", "user.email", "test@example.invalid"],
  ]) {
    const result = await run(["git", ...args], { cwd: dir });
    if (result.code !== 0) throw new Error("Git failed: " + result.stderr);
  }
  templateRepoDir = dir;
  return templateRepoDir;
}

let templateProjectDir;

/**
 * Initializes and returns a template project path with an initial commit.
 * @returns {Promise<string>} The path to the initialized template project.
 */
export async function getTemplateProject() {
  if (templateProjectDir) return templateProjectDir;
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "omt-template-")),
  );
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  await run(["git", "init", "-q", "-b", "main"], { cwd: project });
  await run(["git", "config", "user.email", "t@example.invalid"], {
    cwd: project,
  });
  await run(["git", "config", "user.name", "t"], { cwd: project });
  fs.writeFileSync(path.join(project, ".gitignore"), ".omt/\n");
  fs.writeFileSync(path.join(project, "README.md"), "base\n");
  await run(["git", "add", "."], { cwd: project });
  await run(["git", "commit", "-q", "-m", "base"], { cwd: project });
  templateProjectDir = project;
  return templateProjectDir;
}

/**
 * Clones the committed template into an independent Git fixture. Git creates
 * its own object directory instead of copying a live .git tree with fs.cpSync.
 * @param {string} destination The new fixture repository path.
 * @returns {Promise<string>} The cloned repository path.
 */
export async function cloneTemplateProject(destination) {
  const source = await getTemplateProject();
  const commands = [
    ["clone", "--no-local", "-q", source, destination],
    ["-C", destination, "config", "user.email", "t@example.invalid"],
    ["-C", destination, "config", "user.name", "t"],
  ];
  for (const args of commands) {
    const result = await run(["git", ...args], {
      cwd: path.dirname(destination),
    });
    if (result.code !== 0) throw new Error("Git failed: " + result.stderr);
  }
  return destination;
}

/**
 * Cleans up all template directories that were created during the test run.
 * @returns {void}
 */
export function cleanupTemplates() {
  if (templateRepoDir) {
    fs.rmSync(templateRepoDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
    templateRepoDir = undefined;
  }
  if (templateProjectDir) {
    // getTemplateProject creates a root dir and puts 'project' inside it.
    fs.rmSync(path.dirname(templateProjectDir), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
    templateProjectDir = undefined;
  }
}
