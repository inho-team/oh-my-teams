/** Per-role usage reports: launch ledger, attribution and the usage-report CLI. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJSON, writeJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  kickoffEntryName,
  registryDirectory,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";
import {
  ledgerFile,
  readLaunches,
  lazyLaunchesBackward,
  recordLaunch,
} from "../plugins/oh-my-teams/scripts/usage-ledger.mjs";
import {
  attributeSessions,
  formatUsageTable,
  summarizeByRole,
  kickoffPlaces,
  usageReport,
} from "../plugins/oh-my-teams/scripts/usage-report.mjs";
import { sessionRecord } from "../plugins/oh-my-teams/scripts/usage-sources.mjs";
import { listHeadless } from "../plugins/oh-my-teams/scripts/headless.mjs";
import { main } from "../plugins/oh-my-teams/scripts/teams-org.mjs";

const MINUTE = 60 * 1000;
const CANARY = "CANARY-51c2-message-text";
const exampleOrg = path.resolve(
  "plugins/oh-my-teams/examples/organization.json",
);

function tempDir(t, prefix = "omt-usage-report-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(async () => {
    // A detached headless runner may still hold its files on Windows.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    fs.rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  });
  return dir;
}

const at = (base, minutes) => new Date(base + minutes * MINUTE).toISOString();

function writeLines(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
}

// A project whose registry entry is written directly, so its creation time,
// and with it the report window, is under the test's control.
function project(t, { createdAt, released = null, legacy = false } = {}) {
  const dir = tempDir(t);
  const orgFile = path.join(dir, "project", ".omt", "organization.json");
  const org = readJSON(exampleOrg);
  // No profile can start a real provider CLI from these tests.
  for (const profile of Object.values(org.profiles))
    profile.command = ["omt-no-such-cli"];
  writeJSON(orgFile, org);
  const pmPath = path.join(dir, "kickoff-pm");
  fs.mkdirSync(pmPath, { recursive: true });
  const worktreeId = `repo::${pmPath.replace(/\\/g, "/")}`;
  const entry = {
    schemaVersion: 1,
    goal: "measure usage",
    [legacy ? "coordinator" : "pm"]: {
      worktreeId,
      path: pmPath,
      stateDir: path.join(pmPath, ".omt"),
    },
    runId: null,
    organizationRevision: org.revision,
    brief: path.join(dir, "brief.md"),
    delivery: { mode: "none" },
    createdAt,
  };
  if (released) {
    writeJSON(
      path.join(
        path.dirname(orgFile),
        "history",
        `kickoff-${kickoffEntryName(worktreeId)}-${createdAt.replace(/[:.]/g, "-")}.json`,
      ),
      { ...entry, releasedAt: released, releaseReason: "completed" },
    );
  } else {
    writeJSON(
      path.join(
        registryDirectory(orgFile),
        `${kickoffEntryName(worktreeId)}.json`,
      ),
      entry,
    );
  }
  return {
    dir,
    orgFile,
    pmPath,
    stateDir: path.join(pmPath, ".omt"),
    worktreeId,
    homes: {
      claudeHome: path.join(dir, "claude-home"),
      codexHome: path.join(dir, "codex-home"),
      agyHome: path.join(dir, "agy-home"),
    },
  };
}

test("a launch is tied to its kickoff by state, by PM worktree, or through an earlier launch", (t) => {
  const base = Date.now() - 60 * MINUTE;
  const fixture = project(t, { createdAt: at(base, 0) });
  const plWorktree = path.join(fixture.dir, "pl-worktree");
  const first = recordLaunch(
    fixture.orgFile,
    {
      via: "role-terminal",
      role: "pl",
      provider: "codex",
      worktreePath: plWorktree,
      callerCwd: fixture.dir,
      stateDir: fixture.stateDir,
    },
    at(base, 5),
  );
  assert.equal(first.line.kickoffPmWorktreeId, fixture.worktreeId);
  const fromPm = recordLaunch(fixture.orgFile, {
    via: "headless-start",
    role: "junior",
    callerCwd: path.join(fixture.pmPath, "sub"),
  });
  assert.equal(fromPm.line.kickoffPmWorktreeId, fixture.worktreeId);
  // PL launches Senior from its own worktree, with no --state of its own.
  const fromPl = recordLaunch(fixture.orgFile, {
    via: "worker-start",
    role: "senior",
    worktreePath: plWorktree,
    callerCwd: plWorktree,
  });
  assert.equal(fromPl.line.kickoffPmWorktreeId, fixture.worktreeId);
  const unrelated = recordLaunch(fixture.orgFile, {
    via: "role-terminal",
    role: "junior",
    callerCwd: path.join(fixture.dir, "elsewhere"),
  });
  assert.equal(unrelated.line.kickoffPmWorktreeId, null);
  assert.equal(readLaunches(fixture.orgFile).length, 4);
  assert.equal(
    ledgerFile(fixture.orgFile),
    path.join(path.dirname(fixture.orgFile), "usage", "launches.jsonl"),
  );
  // A half-written last line is skipped, not fatal.
  fs.appendFileSync(ledgerFile(fixture.orgFile), '{"schemaVersion":1,"at"');
  assert.equal(readLaunches(fixture.orgFile).length, 4);
  assert.throws(
    () => recordLaunch(fixture.orgFile, { via: "typed-by-hand", role: "pl" }),
    /Launch via must be one of/,
  );
});

test("F-04: recordLaunch reads only until found, keeping cost low regardless of ledger size", (t) => {
  const dir = tempDir(t, "f04-recent-");
  const orgFile = path.join(dir, "org.json");
  // Provide a dummy kickoff registry so listKickoffs doesn't crash
  fs.writeFileSync(orgFile, JSON.stringify({ revision: 2 }));
  const file = ledgerFile(orgFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const dummyLine =
    JSON.stringify({
      schemaVersion: 1,
      at: new Date().toISOString(),
      via: "role-terminal",
      role: "senior",
      kickoffPmWorktreeId: "repo::dummy",
    }) + "\n";

  // Write a large ledger (e.g., 50000 lines)
  const fd = fs.openSync(file, "w");
  for (let i = 0; i < 50000; i++) {
    fs.writeSync(fd, dummyLine);
  }

  // Write a target line near the start (e.g. line 100)
  const targetCwd = path.join(dir, "target-cwd");
  const targetLine =
    JSON.stringify({
      schemaVersion: 1,
      at: new Date().toISOString(),
      via: "role-terminal",
      role: "junior",
      kickoffPmWorktreeId: "repo::target",
      worktreePath: targetCwd,
    }) + "\n";
  fs.writeSync(fd, targetLine);

  for (let i = 0; i < 1500; i++) {
    fs.writeSync(fd, dummyLine);
  }
  fs.closeSync(fd);

  // Register the kickoff so resolveLaunchKickoff can find it
  const kickoffDir = path.join(path.dirname(orgFile), "kickoffs");
  fs.mkdirSync(kickoffDir, { recursive: true });
  fs.writeFileSync(
    path.join(kickoffDir, "repo-target.json"),
    JSON.stringify({
      schemaVersion: 1,
      goal: "dummy",
      organizationRevision: 2,
      brief: "dummy.md",
      delivery: { mode: "none" },
      pm: {
        worktreeId: "repo::target",
        path: targetCwd,
        stateDir: path.join(targetCwd, ".omt"),
      },
      createdAt: new Date().toISOString(),
      runId: null,
    }),
  );

  let bytesRead = 0;
  const origReadSync = fs.readSync;
  fs.readSync = (fd2, buffer, offset, length, position) => {
    const read = origReadSync(fd2, buffer, offset, length, position);
    bytesRead += read;
    return read;
  };

  const origReadFileSync = fs.readFileSync;
  let usedReadFileSync = false;
  fs.readFileSync = (f, ...rest) => {
    if (f === file) usedReadFileSync = true;
    return origReadFileSync(f, ...rest);
  };

  try {
    const launch = recordLaunch(orgFile, {
      via: "role-terminal",
      role: "junior",
      callerCwd: path.join(targetCwd, "sub"),
    });
    assert.equal(launch.line.kickoffPmWorktreeId, "repo::target");
    assert.equal(
      usedReadFileSync,
      false,
      "Should not read entire ledger with readFileSync",
    );
    assert.ok(
      bytesRead < 500 * 1024,
      "Should read far less than the full file size",
    );
  } finally {
    fs.readSync = origReadSync;
    fs.readFileSync = origReadFileSync;
  }
});

test("sessions go to the role launched in their place, and unclear ones are not guessed", () => {
  const base = Date.parse("2026-09-10T10:00:00.000Z");
  const root = path.resolve(os.tmpdir(), "omt-attribution");
  const pm = path.join(root, "pm");
  const w1 = path.join(root, "w1");
  const end = base + 180 * MINUTE;
  const org = readJSON(exampleOrg);
  const entry = {
    pm: { worktreeId: "repo::pm", path: pm, stateDir: path.join(pm, ".omt") },
    createdAt: at(base, 0),
  };
  const line = (minutes, role, provider, worktreePath, terminal) => ({
    schemaVersion: 1,
    at: at(base, minutes),
    via: "role-terminal",
    role,
    provider,
    modelRequested: `${role}-model`,
    worktreePath,
    terminal,
    kickoffPmWorktreeId: "repo::pm",
  });
  const launches = [
    line(10, "pl", "codex", w1, "t-pl"),
    line(20, "senior", "agy", w1, "t-senior"),
    line(60, "pl", "agy", w1, "t-pl-agy"),
    line(60.5, "junior", "agy", w1, "t-junior"),
    // Another kickoff's launch in the same worktree is not this kickoff's.
    { ...line(30, "junior", "codex", w1, "t-x"), kickoffPmWorktreeId: "o" },
  ];
  const places = kickoffPlaces({ entry, org, launches, end });
  assert.deepEqual(
    places.map((place) => [place.role, place.source]),
    [
      ["pm", "registry"],
      ["pl", "ledger"],
      ["senior", "ledger"],
      ["pl", "ledger"],
      ["junior", "ledger"],
    ],
  );
  // PL's Agy launch in the same worktree and provider ends Senior's hold.
  assert.equal(places[2].to, base + 60 * MINUTE);

  const session = (key, provider, cwd, minutes, extra = {}) =>
    sessionRecord({
      source: "test",
      provider,
      sessionKey: key,
      cwd,
      firstAt: at(base, minutes),
      measured: true,
      promptTokens: 1,
      outputTokens: 1,
      ...extra,
    });
  const records = attributeSessions(
    [
      session("pm", "claude", pm, 1),
      session("pl", "codex", path.join(w1, "src"), 11, {
        modelReported: ["gpt-6-astra"],
      }),
      session("senior", "agy", w1, 21),
      session("late-senior", "agy", w1, 62),
      session("sibling", "claude", `${pm}-2`, 30),
      session("early-agy", "agy", w1, 5),
      session("declared", "agy", null, 1, {
        role: "junior",
        attribution: { method: "declared" },
        modelRequested: "m",
        modelReported: ["m"],
      }),
    ],
    places,
  );
  const byKey = Object.fromEntries(
    records.map((record) => [record.sessionKey, record]),
  );
  assert.equal(byKey.pm.role, "pm");
  assert.equal(byKey.pl.role, "pl");
  assert.equal(byKey.pl.modelVerdict, "mismatched");
  assert.equal(byKey.senior.role, "senior");
  assert.equal(byKey["late-senior"].role, "ambiguous");
  assert.deepEqual(byKey["late-senior"].attribution.roles.sort(), [
    "junior",
    "pl",
  ]);
  assert.equal(byKey["late-senior"].measured, "partial");
  assert.equal(byKey.sibling.role, "unattributed");
  assert.equal(byKey.sibling.attribution.reason, "no-place");
  assert.equal(byKey["early-agy"].role, "unattributed");
  assert.equal(byKey["early-agy"].attribution.reason, "outside-launch-window");
  assert.equal(byKey.declared.role, "junior");
  assert.equal(byKey.declared.modelVerdict, "matched");

  // Windows reports one checkout in several spellings.
  const [windows] = attributeSessions(
    [
      sessionRecord({
        provider: "codex",
        cwd: "c:/work/W1/src",
        firstAt: at(base, 11),
      }),
    ],
    [
      {
        role: "pl",
        provider: "codex",
        path: "C:\\Work\\w1",
        at: base,
        to: end,
      },
    ],
    { platform: "win32" },
  );
  assert.equal(windows.role, "pl");
});

// The session is created when its first event is written, after the launch
// that opened it.
function codexRollout(file, id, cwd, base, events) {
  writeLines(file, [
    {
      timestamp: events[0]?.timestamp ?? at(base, 0),
      type: "session_meta",
      payload: { id, cwd },
    },
    ...events,
  ]);
}

function tokenTotal(base, minutes, input, output) {
  return {
    timestamp: at(base, minutes),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: 0,
          output_tokens: output,
        },
      },
    },
  };
}

// PL on Codex and Senior on Agy share one worktree; Junior runs headless on
// Codex, whose own rollout must not be counted a second time.
function kickoffWithSessions(t) {
  const base = Date.now() - 120 * MINUTE;
  const fixture = project(t, { createdAt: at(base, 0) });
  const shared = path.join(fixture.dir, "shared-worktree");
  const juniorDir = path.join(fixture.dir, "junior-worktree");
  const launch = (minutes, fields) =>
    recordLaunch(
      fixture.orgFile,
      { callerCwd: fixture.pmPath, stateDir: fixture.stateDir, ...fields },
      at(base, minutes),
    );
  launch(5, {
    via: "role-terminal",
    role: "pl",
    provider: "codex",
    modelRequested: "gpt-5.6-sol",
    worktreePath: shared,
    terminal: "term-pl",
  });
  launch(10, {
    via: "role-terminal",
    role: "senior",
    provider: "agy",
    modelRequested: "gemini-3.8-flash-high",
    worktreePath: shared,
    terminal: "term-senior",
  });
  launch(15, {
    via: "headless-start",
    role: "junior",
    provider: "codex",
    worktreePath: juniorDir,
    workerId: "junior-1",
  });

  const sessions = path.join(fixture.homes.codexHome, "sessions", "2026");
  codexRollout(path.join(sessions, "rollout-pl.jsonl"), "th-pl", shared, base, [
    {
      timestamp: at(base, 6),
      type: "turn_context",
      payload: { model: "gpt-5.6-sol" },
    },
    {
      timestamp: at(base, 6),
      type: "event_msg",
      payload: { type: "task_started" },
    },
    {
      timestamp: at(base, 6),
      type: "response_item",
      payload: { content: [{ text: CANARY }] },
    },
    tokenTotal(base, 7, 3000, 200),
  ]);
  codexRollout(
    path.join(sessions, "rollout-junior.jsonl"),
    "th-junior",
    juniorDir,
    base,
    [tokenTotal(base, 16, 500, 50)],
  );

  const worker = path.join(fixture.stateDir, "headless", "junior-1");
  writeJSON(path.join(worker, "worker.json"), {
    schemaVersion: 1,
    id: "junior-1",
    role: "junior",
    profile: "codex-current",
    provider: "codex",
    binary: ["codex"],
    modelRequested: "gpt-5.6-sol",
    effortRequested: null,
    cwd: juniorDir,
  });
  writeJSON(path.join(worker, "turns", "1", "turn.json"), {
    number: 1,
    startedAt: at(base, 16),
  });
  writeJSON(path.join(worker, "turns", "1", "exit.json"), {
    code: 0,
    endedAt: at(base, 17),
  });
  writeLines(path.join(worker, "turns", "1", "stream.jsonl"), [
    { type: "thread.started", thread_id: "th-junior" },
    {
      type: "item.completed",
      item: { type: "agent_message", text: `${CANARY}\nDONE: ok` },
    },
    {
      type: "turn.completed",
      usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 0 },
    },
  ]);
  return { base, fixture, shared };
}

async function agySummary(fixture, base, cwd) {
  const { DatabaseSync } = await import("node:sqlite");
  fs.mkdirSync(fixture.homes.agyHome, { recursive: true });
  const db = new DatabaseSync(
    path.join(fixture.homes.agyHome, "conversation_summaries.db"),
  );
  db.exec(`CREATE TABLE conversation_summaries (conversation_id TEXT,
    title TEXT, preview TEXT, step_count INTEGER, last_modified_time datetime,
    workspace_uris TEXT, last_user_input_time datetime)`);
  const time = (minutes) =>
    at(base, minutes).replace("T", " ").replace("Z", "0000+00:00");
  db.prepare(
    "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "22222222-aaaa-bbbb-cccc-000000000001",
    CANARY,
    CANARY,
    12,
    time(40),
    JSON.stringify([`file:///${cwd.replace(/\\/g, "/").replace(/^\//, "")}`]),
    time(11),
  );
  db.close();
}

test("a report shares measured tokens by role and leaves the unmeasured null", async (t) => {
  const { base, fixture, shared } = kickoffWithSessions(t);
  await agySummary(fixture, base, shared);
  const report = await usageReport({
    orgFile: fixture.orgFile,
    worktreeId: fixture.worktreeId,
    homes: fixture.homes,
    env: {},
    now: base + 60 * MINUTE,
  });
  assert.equal(report.kickoffs.length, 1);
  const [kickoff] = report.kickoffs;
  assert.equal(kickoff.excludedDuplicates, 1);
  assert.equal(kickoff.byRole.pl.promptTokens, 3000);
  assert.equal(kickoff.byRole.pl.turns, 1);
  assert.equal(kickoff.byRole.junior.promptTokens, 1000);
  assert.deepEqual(kickoff.byRole.junior.sources, ["headless"]);
  assert.equal(kickoff.byRole.senior.steps, 12);
  assert.equal(kickoff.byRole.senior.promptTokens, null);
  assert.equal(kickoff.byRole.senior.outputTokens, null);
  assert.deepEqual(kickoff.byRole.senior.reasons, [
    "agy-interactive-usage-not-recorded",
  ]);
  assert.equal(kickoff.share.senior, "unmeasured");
  assert.equal(kickoff.share.pl, Number((3200 / 4200).toFixed(4)));
  assert.equal(kickoff.share.junior, Number((1000 / 4200).toFixed(4)));
  assert.deepEqual(kickoff.coverage.unmeasuredRoles, ["senior"]);
  assert.equal(kickoff.coverage.measuredSessions, 2);
  assert.equal(kickoff.coverage.totalSessions, 3);
  assert.deepEqual(kickoff.mismatches, []);
  assert.equal(
    kickoff.sources["claude-transcript"].unavailable,
    "claude-projects-missing",
  );
  assert.equal(report.totals.promptTokens, 4000);
  assert.ok(!JSON.stringify(report).includes(CANARY));
  const table = formatUsageTable(report);
  assert.match(table, /senior .*unmeasured/);
  assert.match(table, /coverage: 2\/3 sessions measured/);
  assert.equal(kickoff.recordedLaunches, 3);
  assert.doesNotMatch(table, /no launches recorded/);
});

test("an archived pre-rename kickoff is reported, with its places named by hand", async (t) => {
  const base = Date.now() - 300 * MINUTE;
  const fixture = project(t, {
    createdAt: at(base, 0),
    released: at(base, 120),
    legacy: true,
  });
  const child = path.join(fixture.dir, "child-worktree");
  codexRollout(
    path.join(fixture.homes.codexHome, "sessions", "rollout-child.jsonl"),
    "th-child",
    child,
    base,
    [tokenTotal(base, 30, 700, 70)],
  );
  const options = {
    orgFile: fixture.orgFile,
    all: true,
    homes: fixture.homes,
    env: {},
  };
  const without = await usageReport(options);
  assert.equal(without.kickoffs[0].kickoff.status, "released");
  assert.equal(without.kickoffs[0].kickoff.pmPath, fixture.pmPath);
  // Nothing recorded where the child worktree was, so it is not even read.
  assert.equal(without.kickoffs[0].records.length, 0);
  assert.equal(without.kickoffs[0].recordedLaunches, 0);
  assert.match(formatUsageTable(without), /no launches recorded/);

  const backfilled = await usageReport({
    ...options,
    places: [`pl=${child}`],
  });
  const [kickoff] = backfilled.kickoffs;
  assert.equal(kickoff.byRole.pl.promptTokens, 700);
  assert.equal(kickoff.records[0].attribution.place, "manual");
  assert.equal(kickoff.window.to, at(base, 120));

  // An organization with a kickoff that nobody selects is refused, not guessed.
  await assert.rejects(
    usageReport({ orgFile: fixture.orgFile, homes: fixture.homes, env: {} }),
    /No kickoff is running/,
  );
});

function captureLog(t) {
  const lines = [];
  const log = console.log;
  console.log = (...values) => lines.push(values.join(" "));
  t.after(() => {
    console.log = log;
  });
  return {
    lines,
    restore: () => {
      console.log = log;
    },
  };
}

// Every default home points at an empty directory, so a flag the CLI failed
// to pass on would read nothing rather than the real home.
function isolateHomes(t, dir) {
  const empty = path.join(dir, "empty-home");
  fs.mkdirSync(empty, { recursive: true });
  const names = [
    "HOME",
    "USERPROFILE",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "OMT_AGY_HOME",
  ];
  const saved = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  for (const name of names) process.env[name] = empty;
  t.after(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
}

test("usage-report runs from the CLI with explicit homes and writes a snapshot", async (t) => {
  const { fixture } = kickoffWithSessions(t);
  isolateHomes(t, fixture.dir);
  const homeFlags = [
    "--claude-home",
    fixture.homes.claudeHome,
    "--codex-home",
    fixture.homes.codexHome,
    "--agy-home",
    fixture.homes.agyHome,
  ];
  const captured = captureLog(t);
  await main([
    "usage-report",
    "--org",
    fixture.orgFile,
    "--worktree",
    fixture.worktreeId,
    ...homeFlags,
    "--json",
  ]);
  captured.restore();
  const report = JSON.parse(captured.lines.join("\n"));
  assert.equal(report.kickoffs[0].byRole.pl.promptTokens, 3000);
  assert.equal(
    report.kickoffs[0].sources["agy-summary"].unavailable,
    "agy-summary-db-missing",
  );
  assert.deepEqual(report.written, []);

  const table = captureLog(t);
  await main([
    "usage-report",
    "--org",
    fixture.orgFile,
    "--all",
    "--write",
    ...homeFlags,
  ]);
  table.restore();
  const printed = table.lines.join("\n");
  assert.match(
    printed,
    /pl +\| OpenCodex gpt-5\.6-sol -> OpenCodex gpt-5\.6-sol/,
  );
  assert.match(printed, /junior +\| OpenCodex gpt-5\.6-sol -> -/);
  const [written] = fs
    .readdirSync(path.join(path.dirname(fixture.orgFile), "history"))
    .filter((name) => name.startsWith("usage-"));
  assert.ok(
    written.startsWith(`usage-${kickoffEntryName(fixture.worktreeId)}-`),
  );
  assert.match(printed, /written: /);

  // Without the flags, the isolated defaults find no session at all.
  const isolated = captureLog(t);
  await main([
    "usage-report",
    "--org",
    fixture.orgFile,
    "--state",
    fixture.stateDir,
    "--json",
  ]);
  isolated.restore();
  const defaults = JSON.parse(isolated.lines.join("\n")).kickoffs[0];
  assert.equal(
    defaults.sources["codex-rollout"].unavailable,
    "codex-sessions-missing",
  );
  assert.equal(defaults.byRole.pl, undefined);
  await assert.rejects(
    main(["usage-report", "--org", fixture.orgFile, "--place", "pl"]),
    /--place takes role=path/,
  );
});

test("a launch whose ledger cannot be written still starts, and says so", async (t) => {
  const base = Date.now() - 10 * MINUTE;
  const fixture = project(t, { createdAt: at(base, 0) });
  const worktree = path.join(fixture.dir, "junior-worktree");
  fs.mkdirSync(worktree);
  const start = async (worker) => {
    const captured = captureLog(t);
    await main([
      "headless-start",
      "--org",
      fixture.orgFile,
      "--role",
      "junior",
      "--cwd",
      worktree,
      "--spec",
      "x",
      "--state",
      fixture.stateDir,
      "--worker",
      worker,
    ]);
    captured.restore();
    return JSON.parse(captured.lines.join("\n"));
  };
  const recorded = await start("junior-1");
  assert.equal(recorded.ledger, ledgerFile(fixture.orgFile));
  const [line] = readLaunches(fixture.orgFile);
  assert.equal(line.via, "headless-start");
  assert.equal(line.workerId, "junior-1");
  assert.equal(line.kickoffPmWorktreeId, fixture.worktreeId);
  assert.equal(line.worktreePath, worktree);

  // A file where the ledger's directory belongs makes every append fail.
  const usageDir = path.dirname(ledgerFile(fixture.orgFile));
  fs.rmSync(usageDir, { recursive: true, force: true });
  fs.writeFileSync(usageDir, "not a directory");
  const blocked = await start("junior-2");
  assert.equal(blocked.worker.id, "junior-2");
  assert.match(blocked.ledgerError, /\S/);
  assert.equal(blocked.ledger, undefined);
  assert.deepEqual(
    listHeadless(fixture.stateDir, {
      codexHome: fixture.homes.codexHome,
    }).map((worker) => worker.worker),
    ["junior-1", "junior-2"],
  );
});

test("summarizeByRole includes both models if provider differs but model is the same", () => {
  const records = [
    {
      role: "senior",
      provider: "claude",
      modelRequested: "sonnet",
      modelReported: [],
      source: "x",
      measured: true,
      turns: 1,
      calls: 1,
      promptTokens: 10,
      outputTokens: 10,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      timeToFirstToken: 0,
    },
    {
      role: "senior",
      provider: "agy",
      modelRequested: "sonnet",
      modelReported: [],
      source: "x",
      measured: true,
      turns: 1,
      calls: 1,
      promptTokens: 10,
      outputTokens: 10,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      timeToFirstToken: 0,
    },
  ];
  const byRole = summarizeByRole(records);
  assert.equal(byRole.senior.modelsDisplay.requested.length, 2);
  assert.equal(
    byRole.senior.modelsDisplay.requested.includes("Claude Code sonnet"),
    true,
  );
  assert.equal(
    byRole.senior.modelsDisplay.requested.includes("Agy sonnet"),
    true,
  );
});
