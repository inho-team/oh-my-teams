/**
 * PoC: can a role run as a non-interactive process instead of an Orca terminal?
 *
 * For each provider CLI this creates a plain Git worktree with the local
 * adapter, runs one small implementation task with file edits and a commit in
 * print/exec mode with streamed JSON output, and records what an Orca-free
 * supervisor could observe: exit code and duration, the model the stream
 * reports, the commit and file the task asked for, and anything else left in
 * the worktree. It spends real subscription calls, so it runs only on demand:
 *
 *   node experiments/headless-worker-poc.mjs [--only claude,codex,agy]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, writeJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import { createWorkspace } from "../plugins/oh-my-teams/scripts/local-adapter.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 6 * 60 * 1000;

/** Provider launches under test, each allowed to edit files and run Git. */
export const PROVIDERS = {
  claude: {
    model: "sonnet",
    command: (prompt, model) => ({
      argv: [
        "claude",
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--model",
        model,
      ],
      input: prompt,
    }),
  },
  codex: {
    model: null,
    command: (prompt) => ({
      argv: [
        "codex",
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        prompt,
      ],
      input: "",
    }),
  },
  agy: {
    model: "gemini-3.8-flash-high",
    command: (prompt, model) => ({
      argv: [
        "agy",
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
        "--model",
        model,
        "--print-timeout",
        "5m",
        "-p",
        prompt,
      ],
      input: "",
    }),
  },
};

/**
 * Builds the implementation task every provider receives.
 *
 * @param {string} provider - Provider name, used in the file and commit.
 * @returns {{prompt: string, file: string, content: string, subject: string}}
 *   The prompt and the exact result it asks for.
 */
export function taskFor(provider) {
  const file = `poc/${provider}.md`;
  const content = `headless worker ok: ${provider}`;
  const subject = `poc: ${provider} headless worker`;
  const prompt = [
    "You are a Junior engineer running without a human watching.",
    `In the current Git worktree, create the file ${file} whose entire content is the single line: ${content}`,
    `Then run: git add ${file} && git commit -m "${subject}"`,
    "Do not create, modify or leave any other file in this worktree, including scratch files.",
    "When the commit exists, reply with exactly one line: DONE <full commit sha>.",
  ].join("\n");
  return { prompt, file, content, subject };
}

// Streams mix event shapes per provider; the first string under a `model` key
// anywhere in an event is what the stream says the session ran on.
function findModel(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.model === "string" && value.model.trim()) return value.model;
  for (const child of Object.values(value)) {
    const found = findModel(child);
    if (found) return found;
  }
  return null;
}

/**
 * Summarizes a JSONL stream: events, reported models, and the final text.
 *
 * @param {string} stdout - Raw standard output of the provider process.
 * @returns {object} Event count, types, models, unparsed lines, and last text.
 */
export function readStream(stdout) {
  const events = [];
  let unparsed = 0;
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      unparsed += 1;
    }
  }
  const models = [...new Set(events.map(findModel).filter(Boolean))];
  const texts = String(stdout).match(/DONE [0-9a-f]{7,40}/g) ?? [];
  return {
    eventCount: events.length,
    eventTypes: [...new Set(events.map((event) => event.type ?? "?"))],
    models,
    unparsedLines: unparsed,
    doneLine: texts.at(-1) ?? null,
  };
}

async function git(cwd, ...args) {
  const result = await run(["git", ...args], { cwd, timeoutMs: 30000 });
  return String(result.stdout ?? "").trim();
}

async function tryProvider(name, base, out) {
  const spec = PROVIDERS[name];
  const task = taskFor(name);
  const worktree = path.join(base, `wt-${name}`);
  const workspace = await createWorkspace(path.join(base, "repo"), {
    name: `poc-${name}`,
    base: "main",
    path: worktree,
  });
  const { argv, input } = spec.command(task.prompt, spec.model);
  const startedAt = Date.now();
  const result = await run(argv, {
    cwd: worktree,
    input,
    timeoutMs: TIMEOUT_MS,
  });
  const durationMs = Date.now() - startedAt;
  fs.writeFileSync(path.join(out, `${name}.stdout.jsonl`), result.stdout ?? "");
  fs.writeFileSync(path.join(out, `${name}.stderr.txt`), result.stderr ?? "");

  const head = await git(worktree, "log", "-1", "--format=%H%x09%s");
  const [sha, subject] = head.split("\t");
  const filePath = path.join(worktree, task.file);
  const content = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf8").trim()
    : null;
  const stream = readStream(result.stdout);
  return {
    provider: name,
    argv: argv.map((arg) => (arg === task.prompt ? "<prompt>" : arg)),
    requestedModel: spec.model,
    workspace,
    exit: { code: result.code, timedOut: Boolean(result.timedOut), durationMs },
    stream,
    committed: subject === task.subject,
    commitSha: sha,
    doneMatchesCommit:
      stream.doneLine === `DONE ${sha}` ||
      (stream.doneLine !== null && sha.startsWith(stream.doneLine.slice(5))),
    fileContentOk: content === task.content,
    changedFiles: (
      await git(worktree, "show", "--name-only", "--format=", "HEAD")
    )
      .split("\n")
      .filter(Boolean),
    leftovers: (
      await git(worktree, "status", "--porcelain", "--untracked-files=all")
    )
      .split("\n")
      .filter(Boolean),
  };
}

async function main() {
  const onlyIndex = process.argv.indexOf("--only");
  const names =
    onlyIndex === -1
      ? Object.keys(PROVIDERS)
      : process.argv[onlyIndex + 1].split(",");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omt-headless-poc-"));
  const repo = path.join(base, "repo");
  fs.mkdirSync(repo);
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "poc@example.invalid"],
    ["config", "user.name", "omt poc"],
  ]) {
    await git(repo, ...args);
  }
  fs.writeFileSync(path.join(repo, "README.md"), "headless worker PoC\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "base");

  const out = path.join(
    root,
    "experiments",
    "results",
    `headless-poc-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  fs.mkdirSync(out, { recursive: true });
  const results = [];
  for (const name of names) {
    process.stderr.write(`running ${name}...\n`);
    try {
      results.push(await tryProvider(name, base, out));
    } catch (error) {
      results.push({ provider: name, error: error.message });
    }
    writeJSON(path.join(out, "results.json"), { base, results });
  }
  console.log(JSON.stringify({ out, base, results }, null, 2));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
