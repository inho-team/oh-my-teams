/** Source fingerprinting, command evidence, aggregation, and citation checks. */
import fs from "node:fs";
import path from "node:path";
import { assert, hash, inside, readJSON, run, writeJSON } from "./core.mjs";
import { groupUsageByProfile } from "./usage.mjs";

const OUTPUT_TAIL_LENGTH = 2000;

/**
 * Executes Git against an explicit repository and normalizes text output.
 *
 * @param {string} repo - Repository path.
 * @param {string[]} args - Literal Git arguments without the executable name.
 * @returns {Promise<string>} Raw NUL output for `-z`, otherwise trimmed text.
 * @throws {Error} When Git returns a non-zero exit code.
 */
export async function git(repo, args) {
  const result = await run(["git", "-C", repo, ...args], { timeoutMs: 60000 });
  assert(result.code === 0, `git ${args[0]} failed: ${result.stderr}`);
  return args.includes("-z") ? result.stdout : result.stdout.trim();
}

function validateCommands(commands) {
  assert(
    Array.isArray(commands) &&
      commands.length > 0 &&
      commands.every(
        (command) =>
          Array.isArray(command) &&
          command.length > 0 &&
          command.every(
            (argument) => typeof argument === "string" && argument.length > 0,
          ),
      ),
    "Non-empty check argv arrays required",
  );
}

async function workspaceContents(repo) {
  const tracked = (await git(repo, ["ls-files", "-z"]))
    .split("\0")
    .filter(Boolean);
  const untracked = (
    await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"])
  )
    .split("\0")
    .filter(Boolean);
  const files = [...new Set([...tracked, ...untracked])]
    // Coordinator state is excluded whatever its spelling: on a
    // case-insensitive filesystem ".OMT/" is the same directory, and it would
    // otherwise reach inside() and be rejected as a forbidden segment.
    .filter((file) => !/^\.(omt|orca)\//i.test(file))
    .sort();

  return files.map((relative) => {
    // One tracked entry must not abort the whole fingerprint. `inside` resolves
    // symlinks, so a link pointing outside the repository used to throw here
    // and take verify, gateCheck and validateEvidence down with it. An entry
    // that cannot be contained is recorded as unreadable, which still changes
    // the fingerprint if it ever appears or disappears.
    let file;
    try {
      file = inside(repo, relative);
    } catch {
      return [relative, null, null];
    }
    const exists = fs.existsSync(file);
    return [
      relative,
      exists ? hash(fs.readFileSync(file).toString("base64")) : null,
      exists ? fs.statSync(file).mode : null,
    ];
  });
}

/**
 * Captures every input that can affect reusable command evidence.
 *
 * @param {string} repo - Git workspace.
 * @param {string} baseRef - Trusted base ref or commit.
 * @param {string[][]} commands - Acceptance commands as argv arrays.
 * @param {string} environment - Toolchain/fixture environment fingerprint.
 * @returns {Promise<object>} HEAD, base, tree, commands, and runtime fingerprint.
 * @throws {Error} For invalid commands, environment, Git, or unsafe paths.
 */
export async function fingerprint(repo, baseRef, commands, environment) {
  assert(
    typeof environment === "string" && environment.trim(),
    "Explicit environment fingerprint required " +
      "(toolchain/lockfile/DB fixture revision)",
  );
  validateCommands(commands);
  const head = await git(repo, ["rev-parse", "HEAD"]);
  const base = await git(repo, [
    "rev-parse",
    "--verify",
    `${baseRef}^{commit}`,
  ]);
  return {
    head,
    base,
    tree: hash(await workspaceContents(repo)),
    commands,
    environment,
    platform: process.platform,
    node: process.version,
  };
}

function checkSucceeded(check) {
  return check.code === 0 && !check.timedOut && !check.overflow;
}

function logIsIntact(check) {
  return (
    fs.existsSync(check.log) &&
    hash(fs.readFileSync(check.log, "utf8")) === check.logHash
  );
}

function reusableEvidence(cached, key, commandCount) {
  return (
    cached.status === "passed" &&
    cached.key === key &&
    hash(cached.fingerprint) === key &&
    cached.checks?.length === commandCount &&
    cached.checks.every(checkSucceeded) &&
    cached.checks.every(logIsIntact)
  );
}

/**
 * Runs acceptance commands or reuses intact evidence for the exact fingerprint.
 *
 * Checks stop after timeout/overflow because descendant liveness is uncertain.
 * A check that changes source makes the entire evidence record fail.
 *
 * @param {string} repo - Git workspace to verify.
 * @param {object} options - Base, commands, environment, store, and timeout.
 * @returns {Promise<object>} Durable evidence record with logs and fingerprint.
 * @throws {Error} For invalid input, Git failure, or command spawn failure.
 */
export async function verify(
  repo,
  { baseRef = "HEAD", commands, environment, store, timeoutMs = 300000 },
) {
  const before = await fingerprint(repo, baseRef, commands, environment);
  const key = hash(before);
  const evidenceFile = path.join(store, `${key}.json`);
  if (fs.existsSync(evidenceFile)) {
    const cached = readJSON(evidenceFile);
    if (reusableEvidence(cached, key, commands.length)) {
      return { ...cached, cached: true };
    }
  }

  fs.mkdirSync(store, { recursive: true });
  const checks = [];
  for (let index = 0; index < commands.length; index += 1) {
    const result = await run(commands[index], { cwd: repo, timeoutMs });
    const log = path.resolve(store, `${key}-${index}.log`);
    const text = `${result.stdout}\n${result.stderr}`;
    fs.writeFileSync(log, text);
    checks.push({
      argv: commands[index],
      code: result.code,
      timedOut: result.timedOut,
      overflow: result.overflow,
      pid: result.pid,
      elapsedMs: result.elapsedMs,
      log,
      logHash: hash(text),
      tail: text.slice(-OUTPUT_TAIL_LENGTH),
    });
    if (result.timedOut || result.overflow) break;
  }

  const after = await fingerprint(repo, baseRef, commands, environment);
  const unchanged = hash(after) === key;
  const status =
    unchanged &&
    checks.length === commands.length &&
    checks.every(checkSucceeded)
      ? "passed"
      : "failed";
  const evidence = {
    schemaVersion: 1,
    key,
    fingerprint: before,
    status,
    unchanged,
    checks,
    createdAt: new Date().toISOString(),
    cached: false,
  };
  writeJSON(evidenceFile, evidence);
  return evidence;
}

/**
 * Revalidates stored evidence against current source and trusted acceptance input.
 *
 * @param {string} repo - Current Git workspace.
 * @param {object} evidence - Previously recorded passing evidence.
 * @param {string} baseRef - Current trusted base reference.
 * @param {object} [expected] - Optional trusted task with checks/environment.
 * @returns {Promise<true>} `true` only when every binding and log still matches.
 * @throws {Error} When evidence is failed, stale, weakened, or tampered with.
 */
export async function validateEvidence(repo, evidence, baseRef, expected) {
  assert(
    evidence?.schemaVersion === 1 && evidence.status === "passed",
    "Evidence did not pass",
  );
  if (expected) {
    assert(
      JSON.stringify(evidence.fingerprint?.commands) ===
        JSON.stringify(expected.checks) &&
        evidence.fingerprint?.environment === expected.environment,
      "Evidence does not match the trusted acceptance specification",
    );
  }
  assert(
    Array.isArray(evidence.checks) &&
      evidence.checks.length > 0 &&
      evidence.checks.every(checkSucceeded),
    "Failed or missing checks",
  );

  const current = await fingerprint(
    repo,
    baseRef,
    evidence.fingerprint.commands,
    evidence.fingerprint.environment,
  );
  assert(
    hash(current) === evidence.key &&
      hash(evidence.fingerprint) === evidence.key,
    "Stale evidence: head, base, tree, commands or environment changed",
  );
  assert(
    evidence.checks.length === current.commands.length &&
      evidence.checks.every(
        (check, index) =>
          JSON.stringify(check.argv) ===
          JSON.stringify(current.commands[index]),
      ),
    "Evidence checks do not match commands",
  );
  assert(evidence.checks.every(logIsIntact), "Missing or changed evidence log");
  return true;
}

function aggregateRow(report) {
  const implementationPassed =
    (report.status === "passed" ||
      (report.status === "submitted" &&
        report.implementation?.status === "passed")) &&
    report.evidence?.status === "passed" &&
    typeof report.evidence.key === "string";
  const pendingGates = Object.entries(report.gates ?? {})
    .filter(([, gate]) => gate.status === "pending")
    .map(([id]) => id);
  const passed = implementationPassed && pendingGates.length === 0;
  return {
    passed,
    row: {
      taskId: report.taskId,
      status: passed
        ? "reported-passed"
        : implementationPassed
          ? "submitted"
          : "blocked",
      head: report.evidence?.fingerprint?.head ?? null,
      evidenceKey: report.evidence?.key ?? null,
      reportPath: report.reportPath ?? null,
      calls: report.calls?.length ?? 0,
      pendingGates,
      gates: report.gates ?? null,
      issues: report.issues ?? [],
    },
  };
}

/**
 * Deterministically aggregates worker reports without granting merge authority.
 *
 * @param {object[]} reports - Worker reports augmented with optional paths.
 * @param {string[]} expectedIds - Exact task IDs expected in the result set.
 * @returns {object} Missing/blocking tasks, rows, and usage by profile.
 * @throws {Error} For duplicate, unexpected, or malformed report identities.
 */
export function aggregate(reports, expectedIds) {
  assert(
    Array.isArray(expectedIds) &&
      expectedIds.length > 0 &&
      new Set(expectedIds).size === expectedIds.length,
    "Unique expected task IDs required",
  );
  const seen = new Set();
  const rows = [];
  const blockers = [];
  const calls = [];

  for (const report of reports) {
    assert(
      report &&
        typeof report.taskId === "string" &&
        expectedIds.includes(report.taskId) &&
        !seen.has(report.taskId),
      "Unexpected or duplicate task report",
    );
    seen.add(report.taskId);
    calls.push(...(report.calls ?? []));
    const { passed, row } = aggregateRow(report);
    rows.push(row);
    if (!passed || report.issues?.length) blockers.push(report.taskId);
  }

  const missing = expectedIds.filter((id) => !seen.has(id));
  const usageByProfile = groupUsageByProfile(calls);
  return {
    schemaVersion: 1,
    status:
      blockers.length || missing.length ? "blocked" : "ready-for-verification",
    missing,
    blockers,
    tasks: rows,
    usageByProfile,
    usageUnknown: Object.values(usageByProfile).some(
      (group) => group.callsWithUsage < group.calls,
    ),
    costUnknown: Object.values(usageByProfile).some(
      (group) => group.callsWithCost < group.calls,
    ),
    note: "Aggregation is not merge authorization. Verify evidence against each workspace and integration head.",
  };
}

/**
 * Verifies model-supplied citations against nearby exact source lines.
 *
 * @param {string} repo - Workspace containing cited files.
 * @param {object[]} citations - File, line, and exact quote candidates.
 * @returns {object[]} Candidates annotated with verification and actual line.
 * @throws {Error} When `citations` itself is not an array.
 */
export function checkCitations(repo, citations) {
  assert(Array.isArray(citations), "citations must be an array");
  return citations.map((citation) => {
    try {
      assert(
        Number.isInteger(citation.line) &&
          citation.line >= 1 &&
          typeof citation.quote === "string" &&
          citation.quote.trim(),
        "Invalid citation",
      );
      const lines = fs
        .readFileSync(inside(repo, citation.file), "utf8")
        .split(/\r?\n/);
      const index = lines.findIndex(
        (line, candidateIndex) =>
          Math.abs(candidateIndex + 1 - citation.line) <= 3 &&
          line.trim() === citation.quote.trim(),
      );
      return {
        ...citation,
        verified: index >= 0,
        actualLine: index >= 0 ? index + 1 : null,
      };
    } catch {
      return { ...citation, verified: false, actualLine: null };
    }
  });
}

/**
 * Summarizes how much of a citation set was matched against real source lines.
 *
 * @param {object[]} citations - Annotated output of {@link checkCitations}.
 * @returns {{total: number, verified: number, unverified: number, grounded: boolean}}
 * Counts plus whether every citation resolved to an actual workspace line.
 * @throws {Error} When `citations` itself is not an array.
 */
export function citationGrounding(citations) {
  assert(Array.isArray(citations), "citations must be an array");
  const verified = citations.filter((citation) => citation.verified).length;
  return {
    total: citations.length,
    verified,
    unverified: citations.length - verified,
    grounded: citations.length > 0 && verified === citations.length,
  };
}

/**
 * Rejects a read-only result whose citations do not exist in this workspace.
 *
 * A model that describes a different repository still produces well-formed
 * JSON, so an ungrounded answer must fail instead of being stored as success.
 *
 * @param {object[]} citations - Annotated output of {@link checkCitations}.
 * @param {string} label - Caller name used in the failure message.
 * @returns {{total: number, verified: number, unverified: number, grounded: boolean}}
 * The same summary {@link citationGrounding} returns.
 * @throws {Error} When no citation is supplied or any citation is unverified.
 */
export function assertGroundedCitations(citations, label) {
  const grounding = citationGrounding(citations);
  assert(
    grounding.total > 0,
    `${label} returned no source citation; an ungrounded answer is not evidence`,
  );
  assert(
    grounding.grounded,
    `${label} cited ${grounding.unverified} of ${grounding.total} lines that ` +
      "do not exist in this workspace; the answer describes a different tree",
  );
  return grounding;
}

/**
 * Binds a report to the workspace it was actually produced against.
 *
 * @param {string} repo - Workspace passed to the provider as its cwd.
 * @returns {Promise<{repo: string, head: string | null}>} Resolved path and
 * Git HEAD, with `head` left null outside a Git workspace.
 * @throws {Error} When the workspace path does not exist.
 */
export async function workspaceBinding(repo) {
  const resolved = path.resolve(repo);
  assert(fs.existsSync(resolved), `Workspace does not exist: ${resolved}`);
  try {
    return { repo: resolved, head: await git(resolved, ["rev-parse", "HEAD"]) };
  } catch {
    return { repo: resolved, head: null };
  }
}
