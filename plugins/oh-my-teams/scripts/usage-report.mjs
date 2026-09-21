/**
 * Per-role usage of a kickoff, built from the sessions providers recorded.
 *
 * A kickoff's places are the PM worktree from the registry, the worktrees the
 * launch ledger recorded, and any a caller names by hand. Sessions collected
 * from those places are attributed to the role that was launched there by
 * provider, directory and time. Headless workers and harness calls name their
 * role themselves. What cannot be measured is reported as unmeasured with the
 * reason, never as zero, and a session no place explains is reported as
 * unattributed rather than guessed.
 */
import fs from "node:fs";
import path from "node:path";
import { assert, canonicalRole, readJSON, writeJSON } from "./core.mjs";
import { modelVerdict } from "./headless.mjs";
import {
  kickoffEntryName,
  listKickoffs,
  ownerProject,
  validateEntry,
} from "./kickoff-registry.mjs";
import { readLaunches } from "./usage-ledger.mjs";
import {
  collectAgyConversations,
  collectClaudeTranscripts,
  collectCodexRollouts,
  collectHarnessReports,
  collectHeadless,
  pathWithin,
  usageHomes,
} from "./usage-sources.mjs";

/**
 * How far a session may start before its launch's recorded time and still be
 * that launch's, and how close two launches must be to be indistinguishable.
 * Launch lines carry the time the command began, so this covers clock and
 * ordering noise, not the wait for a terminal to become ready.
 */
export const LAUNCH_SLACK_MS = 60 * 1000;

const SUMMED_FIELDS = [
  "turns",
  "calls",
  "steps",
  "promptTokens",
  "cachedInputTokens",
  "cacheCreationTokens",
  "outputTokens",
  "reasoningTokens",
  "costUsd",
];

function ms(value) {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value) {
  return value === null ? null : new Date(value).toISOString();
}

function historyDirectory(orgFile) {
  return path.join(path.dirname(path.resolve(orgFile)), "history");
}

function readHistory(orgFile) {
  const directory = historyDirectory(orgFile);
  if (!fs.existsSync(directory)) return { entries: [], skipped: [] };
  const entries = [];
  const skipped = [];
  for (const name of fs.readdirSync(directory).sort()) {
    if (!/^kickoff-.+\.json$/.test(name)) continue;
    try {
      const stored = readJSON(path.join(directory, name));
      entries.push({
        ...validateEntry(stored),
        releasedAt: stored.releasedAt ?? null,
        releaseReason: stored.releaseReason ?? null,
      });
    } catch (error) {
      skipped.push({ file: name, reason: error.message });
    }
  }
  return { entries, skipped };
}

/**
 * Chooses the kickoffs a usage report covers.
 *
 * @param {object} options - Selection options.
 * @param {string} options.orgFile - Organization JSON path.
 * @param {string} [options.worktreeId] - PM worktree id of one kickoff.
 * @param {boolean} [options.all] - Every active and archived kickoff.
 * @param {string} [options.stateDir] - PM state directory naming one kickoff.
 * @returns {{kickoffs: object[], skipped: object[]}} Entries with `status`
 *   `active` or `released`, and archives that could not be read.
 * @throws {Error} When the selection names no kickoff or is ambiguous.
 */
export function selectKickoffs({ orgFile, worktreeId, all, stateDir }) {
  const active = listKickoffs(orgFile).kickoffs.map((entry) => ({
    ...entry,
    status: "active",
    releasedAt: null,
  }));
  const history = readHistory(orgFile);
  const released = history.entries.map((entry) => ({
    ...entry,
    status: "released",
  }));
  let kickoffs;
  if (all) kickoffs = [...active, ...released];
  else if (worktreeId) {
    const matching = [...active, ...released].filter(
      (entry) => entry.pm.worktreeId === worktreeId,
    );
    assert(matching.length, `No kickoff was registered for ${worktreeId}`);
    // A worktree may hold several kickoffs over time; the latest is meant.
    kickoffs = [matching.sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0]];
  } else if (stateDir) {
    const matching = [...active, ...released].filter(
      (entry) =>
        pathWithin(stateDir, entry.pm.stateDir) &&
        pathWithin(entry.pm.stateDir, stateDir),
    );
    assert(matching.length, `No kickoff records state directory ${stateDir}`);
    kickoffs = [matching.sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0]];
  } else {
    assert(
      active.length === 1,
      active.length
        ? "Several kickoffs are running; pass --worktree <pm-worktree-id> or --all"
        : "No kickoff is running; pass --worktree <pm-worktree-id> or --all",
    );
    kickoffs = active;
  }
  return {
    kickoffs: kickoffs.sort((a, b) => ms(a.createdAt) - ms(b.createdAt)),
    skipped: history.skipped,
  };
}

// A kickoff runs on the organization revision it was registered with; a later
// adjust must not move the PM's provider under an old kickoff's report.
function kickoffOrganization(orgFile, entry) {
  const current = readJSON(orgFile);
  if (current.revision === entry.organizationRevision) return current;
  const archived = path.join(
    historyDirectory(orgFile),
    `org-${entry.organizationRevision}.json`,
  );
  return fs.existsSync(archived) ? readJSON(archived) : current;
}

function roleProfile(org, role) {
  const profile = org.roles?.[role]?.profile ?? null;
  return {
    profile,
    provider: org.profiles?.[profile]?.provider ?? null,
    modelRequested: org.profiles?.[profile]?.model ?? null,
  };
}

/**
 * Parses a `--place role=path` value.
 *
 * @param {string} value - Role name, `=`, and a directory.
 * @returns {{role: string, path: string}} Role and absolute directory.
 * @throws {Error} When the value has no role or no directory.
 */
export function parsePlace(value) {
  const match = /^([a-z]+)=(.+)$/.exec(String(value ?? ""));
  assert(match, `--place takes role=path, not ${value}`);
  return { role: match[1], path: path.resolve(match[2]) };
}

/**
 * Lists the places a kickoff's roles ran in, with when each was theirs.
 *
 * A ledger launch holds its place until the next launch in the same terminal,
 * or the next launch of the same provider in the same worktree, since either
 * replaces the session a later transcript there would come from.
 *
 * @param {object} options - Place sources.
 * @param {object} options.entry - Registry entry of the kickoff.
 * @param {object} options.org - Organization the kickoff runs on.
 * @param {object[]} options.launches - Ledger lines of the organization.
 * @param {object[]} [options.manual] - Parsed `--place` values.
 * @param {number} options.end - Kickoff end in epoch ms.
 * @returns {object[]} Places with role, provider, path, `at` and `to`.
 */
export function kickoffPlaces({ entry, org, launches, manual = [], end }) {
  const start = ms(entry.createdAt);
  const places = [
    {
      role: "pm",
      ...roleProfile(org, "pm"),
      path: entry.pm.path,
      at: start,
      to: end,
      source: "registry",
      via: null,
      terminal: null,
    },
  ];
  const lines = launches
    .filter(
      (line) =>
        line.kickoffPmWorktreeId === entry.pm.worktreeId &&
        ms(line.at) !== null &&
        ms(line.at) >= start &&
        ms(line.at) <= end,
    )
    .sort((a, b) => ms(a.at) - ms(b.at));
  lines.forEach((line, index) => {
    const replacedBy = lines
      .slice(index + 1)
      .find(
        (later) =>
          (line.terminal && later.terminal === line.terminal) ||
          (line.worktreePath &&
            later.provider === line.provider &&
            pathWithin(later.worktreePath, line.worktreePath) &&
            pathWithin(line.worktreePath, later.worktreePath)),
      );
    places.push({
      role: line.role,
      profile: line.profile ?? null,
      provider: line.provider ?? null,
      modelRequested: line.modelRequested ?? null,
      path: line.worktreePath ?? null,
      at: ms(line.at),
      to: replacedBy ? ms(replacedBy.at) : end,
      source: "ledger",
      via: line.via ?? null,
      terminal: line.terminal ?? null,
    });
  });
  for (const place of manual) {
    places.push({
      role: place.role,
      ...roleProfile(org, place.role),
      path: place.path,
      at: start,
      to: end,
      source: "manual",
      via: null,
      terminal: null,
    });
  }
  return places;
}

function depth(directory) {
  return path
    .resolve(directory)
    .split(/[\\/]+/)
    .filter(Boolean).length;
}

function verdictOf(requested, reported) {
  if (!requested) return "unrequested";
  if (!reported.length) return "unproven";
  const verdicts = reported.map((model) => modelVerdict(requested, model));
  if (verdicts.includes("mismatched")) return "mismatched";
  return verdicts.includes("alias") ? "alias" : "matched";
}

/**
 * Assigns each collected session to the role whose place explains it.
 *
 * A candidate place has the session's provider and contains its directory. Of
 * those launched no later than a minute after the session began and not yet
 * replaced, the deepest directory wins, then the latest launch. Two roles
 * launched within a minute of each other in the same directory cannot be told
 * apart, and such a session is marked ambiguous instead of given to either.
 *
 * @param {object[]} records - Session records from the collectors.
 * @param {object[]} places - Result of {@link kickoffPlaces}.
 * @param {object} [options] - `platform` for path comparison.
 * @returns {object[]} The same records with role, attribution, and verdict set.
 */
export function attributeSessions(records, places, options = {}) {
  const platform = options.platform ?? process.platform;
  for (const record of records) {
    if (record.attribution?.method === "declared") {
      record.modelVerdict = verdictOf(
        record.modelRequested,
        record.modelReported,
      );
      continue;
    }
    const start = ms(record.firstAt);
    const candidates = places.filter(
      (place) =>
        place.path &&
        place.provider === record.provider &&
        pathWithin(record.cwd, place.path, platform),
    );
    const valid = candidates.filter(
      (place) =>
        start !== null &&
        place.at <= start + LAUNCH_SLACK_MS &&
        start < place.to + LAUNCH_SLACK_MS,
    );
    if (!valid.length) {
      record.role = "unattributed";
      record.attribution = {
        method: "place",
        reason: candidates.length ? "outside-launch-window" : "no-place",
      };
      record.modelVerdict = verdictOf(null, record.modelReported);
      continue;
    }
    valid.sort((a, b) => depth(b.path) - depth(a.path) || b.at - a.at);
    const [best] = valid;
    // A launch replaced by a near-simultaneous one is still a rival: which of
    // the two opened this session cannot be told from the ledger.
    const rivals = candidates.filter(
      (place) =>
        start !== null &&
        place.at <= start + LAUNCH_SLACK_MS &&
        place.role !== best.role &&
        depth(place.path) === depth(best.path) &&
        Math.abs(place.at - best.at) <= LAUNCH_SLACK_MS,
    );
    if (rivals.length) {
      record.role = "ambiguous";
      record.attribution = {
        method: "place",
        roles: [...new Set([best.role, ...rivals.map((place) => place.role)])],
      };
      if (record.measured === true) record.measured = "partial";
      record.modelVerdict = verdictOf(null, record.modelReported);
      continue;
    }
    record.role = best.role;
    record.profile = best.profile ?? null;
    record.modelRequested = best.modelRequested ?? null;
    record.attribution = {
      method: "place",
      place: best.source,
      path: best.path,
      launchedAt: iso(best.at),
    };
    record.modelVerdict = verdictOf(
      record.modelRequested,
      record.modelReported,
    );
  }
  return records;
}

function addField(total, value) {
  if (typeof value !== "number") return total;
  return (total ?? 0) + value;
}

function tokenWeight(record) {
  if (record.measured === false) return null;
  if (record.promptTokens === null && record.outputTokens === null) return null;
  return (record.promptTokens ?? 0) + (record.outputTokens ?? 0);
}

/**
 * Totals session records by role.
 *
 * @param {object[]} records - Attributed session records.
 * @returns {Record<string, object>} Per role: requested and reported models,
 *   summed counters (null when no session reported one), session counts by
 *   measurement, and the reasons sessions went unmeasured.
 */
export function summarizeByRole(records) {
  const byRole = {};
  for (const record of records) {
    // Sessions recorded before 2.6.0 may name intern; they count toward Junior.
    const role = (byRole[canonicalRole(record.role)] ??= {
      models: { requested: [], reported: [] },
      sources: [],
      sessions: 0,
      measuredSessions: 0,
      partialSessions: 0,
      unmeasuredSessions: 0,
      reasons: [],
      ...Object.fromEntries(SUMMED_FIELDS.map((field) => [field, null])),
    });
    role.sessions += 1;
    if (record.measured === true) role.measuredSessions += 1;
    else if (record.measured === "partial") role.partialSessions += 1;
    else role.unmeasuredSessions += 1;
    if (record.reason && !role.reasons.includes(record.reason))
      role.reasons.push(record.reason);
    if (!role.sources.includes(record.source)) role.sources.push(record.source);
    if (
      record.modelRequested &&
      !role.models.requested.includes(record.modelRequested)
    )
      role.models.requested.push(record.modelRequested);
    for (const model of record.modelReported) {
      if (!role.models.reported.includes(model))
        role.models.reported.push(model);
    }
    for (const field of SUMMED_FIELDS) {
      // An unmeasured session's token fields are null already; its turns and
      // steps still count, since they were read.
      role[field] = addField(role[field], record[field]);
    }
  }
  return byRole;
}

/**
 * Computes each role's share of the measured tokens.
 *
 * @param {object[]} records - Attributed session records.
 * @param {Record<string, object>} byRole - Result of {@link summarizeByRole}.
 * @returns {{shares: Record<string, number | string>, coverage: object}} A
 *   fraction per role, or `unmeasured` for a role with no measured session,
 *   and how many sessions the fractions rest on.
 */
export function usageShare(records, byRole) {
  const weights = {};
  let total = 0;
  for (const record of records) {
    const weight = tokenWeight(record);
    if (weight === null) continue;
    const key = canonicalRole(record.role);
    weights[key] = (weights[key] ?? 0) + weight;
    total += weight;
  }
  const shares = {};
  for (const role of Object.keys(byRole)) {
    shares[role] =
      weights[role] === undefined || total === 0
        ? "unmeasured"
        : Number((weights[role] / total).toFixed(4));
  }
  const measured = records.filter((record) => tokenWeight(record) !== null);
  const unmeasuredRoles = Object.keys(shares).filter(
    (role) => shares[role] === "unmeasured",
  );
  return {
    shares,
    coverage: {
      measuredSessions: measured.length,
      totalSessions: records.length,
      unmeasuredRoles,
      note: unmeasuredRoles.length
        ? "Shares cover measured sessions only; unmeasured roles are not zero."
        : "Every attributed role has at least one measured session.",
    },
  };
}

function sourceSummary(collected) {
  return Object.fromEntries(
    collected.map((result) => [
      result.source,
      { sessions: result.records.length, unavailable: result.unavailable },
    ]),
  );
}

async function kickoffUsage(entry, options) {
  const { orgFile, homes, launches, manual, now, platform } = options;
  const end = entry.releasedAt ? ms(entry.releasedAt) : now;
  const window = { from: ms(entry.createdAt), to: end };
  const org = kickoffOrganization(orgFile, entry);
  const places = kickoffPlaces({ entry, org, launches, manual, end });
  const stateDir = options.stateDir ?? entry.pm.stateDir;
  const directories = [
    ...new Set(places.map((place) => place.path).filter(Boolean)),
  ];
  const declared = [
    collectHeadless(stateDir, { codexHome: homes.codexHome, window }),
    collectHarnessReports(stateDir, { window, org }),
  ];
  const discovered = [
    collectClaudeTranscripts({
      claudeHome: homes.claudeHome,
      places: directories,
      window,
      platform,
    }),
    collectCodexRollouts({
      codexHome: homes.codexHome,
      places: directories,
      window,
      platform,
    }),
    await collectAgyConversations({
      agyHome: homes.agyHome,
      places: directories,
      window,
      platform,
    }),
  ];
  // A headless worker or harness call also leaves its provider's ordinary
  // session record behind; counting both would double its usage.
  const covered = new Set(
    declared.flatMap((result) =>
      result.records.flatMap((record) => [
        record.sessionKey,
        ...(record.sessionKeys ?? []),
      ]),
    ),
  );
  let excludedDuplicates = 0;
  for (const result of discovered) {
    result.records = result.records.filter((record) => {
      if (!covered.has(record.sessionKey)) return true;
      excludedDuplicates += 1;
      return false;
    });
  }
  const collected = [...declared, ...discovered];
  const records = attributeSessions(
    collected.flatMap((result) => result.records),
    places,
    { platform },
  ).map((record) => ({ ...record, kickoff: entry.pm.worktreeId }));
  records.sort((a, b) => (ms(a.firstAt) ?? 0) - (ms(b.firstAt) ?? 0));
  const byRole = summarizeByRole(records);
  const { shares, coverage } = usageShare(records, byRole);
  return {
    kickoff: {
      worktreeId: entry.pm.worktreeId,
      entryName: kickoffEntryName(entry.pm.worktreeId),
      status: entry.status,
      pmPath: entry.pm.path,
      stateDir,
      organizationRevision: entry.organizationRevision,
      createdAt: entry.createdAt,
      releasedAt: entry.releasedAt ?? null,
      releaseReason: entry.releaseReason ?? null,
    },
    window: {
      from: iso(window.from),
      to: iso(window.to),
      open: !entry.releasedAt,
    },
    places: places.map((place) => ({
      ...place,
      at: iso(place.at),
      to: iso(place.to),
    })),
    sources: sourceSummary(collected),
    byRole,
    share: shares,
    coverage,
    mismatches: records
      .filter((record) => record.modelVerdict === "mismatched")
      .map((record) => ({
        role: record.role,
        source: record.source,
        sessionKey: record.sessionKey,
        modelRequested: record.modelRequested,
        modelReported: record.modelReported,
      })),
    unattributed: records
      .filter((record) => ["unattributed", "ambiguous"].includes(record.role))
      .map((record) => ({
        role: record.role,
        source: record.source,
        provider: record.provider,
        sessionKey: record.sessionKey,
        cwd: record.cwd,
        firstAt: record.firstAt,
        measured: record.measured,
        attribution: record.attribution,
      })),
    recordedLaunches: places.filter((place) => place.source === "ledger")
      .length,
    excludedDuplicates,
    clippedEntries: records.reduce(
      (total, record) => total + (record.clippedEntries ?? 0),
      0,
    ),
    records,
  };
}

function reportTotals(kickoffs) {
  const records = kickoffs.flatMap((kickoff) => kickoff.records);
  const totals = {
    kickoffs: kickoffs.length,
    sessions: records.length,
    measuredSessions: records.filter((record) => record.measured === true)
      .length,
    partialSessions: records.filter((record) => record.measured === "partial")
      .length,
    unmeasuredSessions: records.filter((record) => record.measured === false)
      .length,
    unattributedSessions: records.filter(
      (record) => record.role === "unattributed",
    ).length,
    ambiguousSessions: records.filter((record) => record.role === "ambiguous")
      .length,
    mismatches: kickoffs.reduce(
      (total, kickoff) => total + kickoff.mismatches.length,
      0,
    ),
  };
  for (const field of SUMMED_FIELDS) {
    totals[field] = records.reduce(
      (total, record) => addField(total, record[field]),
      null,
    );
  }
  return totals;
}

/**
 * Where `--write` stores a kickoff's usage snapshot.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {object} kickoff - `kickoff` block of a kickoff usage report.
 * @returns {string} `<project>/.omt/history/usage-<entry>-<createdAt>.json`.
 */
export function usageSnapshotFile(orgFile, kickoff) {
  return path.join(
    historyDirectory(orgFile),
    `usage-${kickoff.entryName}-${kickoff.createdAt.replace(/[:.]/g, "-")}.json`,
  );
}

/**
 * Builds the per-role usage report of one or more kickoffs.
 *
 * @param {object} options - Report options.
 * @param {string} options.orgFile - Organization JSON path.
 * @param {string} [options.worktreeId] - PM worktree id of one kickoff.
 * @param {boolean} [options.all] - Report every active and archived kickoff.
 * @param {string} [options.stateDir] - PM state directory to read, which also
 *   names the kickoff when no worktree id is given.
 * @param {string[]} [options.places] - `role=path` values for places the
 *   ledger did not record, such as a kickoff from before it existed.
 * @param {object} [options.homes] - `claudeHome`, `codexHome`, `agyHome`.
 * @param {object} [options.env=process.env] - Environment for default homes.
 * @param {boolean} [options.write] - Store each kickoff's report in history.
 * @param {number | string} [options.now] - End of a still-running kickoff.
 * @param {string} [options.platform] - Path rules for comparing directories.
 * @returns {Promise<object>} `kickoffs`, `totals`, `snapshots`, `written`, `skipped`.
 * @throws {Error} When the selection names no kickoff or `--place` is misused.
 */
export async function usageReport(options) {
  const orgFile = path.resolve(options.orgFile);
  assert(fs.existsSync(orgFile), `No organization at ${orgFile}`);
  const stateDir = options.stateDir ? path.resolve(options.stateDir) : null;
  const selection = selectKickoffs({
    orgFile,
    worktreeId: options.worktreeId,
    all: options.all,
    stateDir,
  });
  const manual = (options.places ?? []).map(parsePlace);
  assert(
    !manual.length || selection.kickoffs.length === 1,
    "--place names the places of one kickoff; select it with --worktree",
  );
  assert(
    !stateDir || selection.kickoffs.length === 1,
    "--state reads the state of one kickoff; select it with --worktree",
  );
  const shared = {
    orgFile,
    homes: usageHomes(options.homes ?? {}, options.env ?? process.env),
    launches: readLaunches(orgFile),
    manual,
    now: ms(options.now ?? Date.now()),
    platform: options.platform ?? process.platform,
    stateDir,
  };
  const kickoffs = [];
  for (const entry of selection.kickoffs) {
    kickoffs.push(await kickoffUsage(entry, shared));
  }
  const written = [];
  if (options.write) {
    for (const kickoff of kickoffs) {
      const file = usageSnapshotFile(orgFile, kickoff.kickoff);
      writeJSON(file, {
        schemaVersion: 1,
        generatedAt: iso(shared.now),
        ...kickoff,
      });
      written.push(file);
    }
  }
  const history = historyDirectory(orgFile);
  return {
    project: ownerProject(orgFile),
    generatedAt: iso(shared.now),
    kickoffs,
    totals: reportTotals(kickoffs),
    snapshots: fs.existsSync(history)
      ? fs
          .readdirSync(history)
          .filter((name) => /^usage-.+\.json$/.test(name))
          .sort()
          .map((name) => path.join(history, name))
      : [],
    written,
    skipped: selection.skipped,
  };
}

function number(value) {
  return value === null || value === undefined
    ? "-"
    : Number(value).toLocaleString("en-US");
}

function table(rows) {
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => String(row[column]).length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) => String(cell).padEnd(widths[column]))
        .join(" | "),
    )
    .join("\n");
}

/**
 * Renders a usage report as one plain-text table per kickoff.
 *
 * @param {object} report - Result of {@link usageReport}.
 * @returns {string} Tables with coverage, mismatch and unattributed notes.
 */
export function formatUsageTable(report) {
  const blocks = report.kickoffs.map((kickoff) => {
    const rows = [
      [
        "role",
        "models requested -> reported",
        "sessions measured/total",
        "turns",
        "calls",
        "steps",
        "prompt (cached/creation)",
        "output",
        "share",
      ],
    ];
    for (const [role, summary] of Object.entries(kickoff.byRole)) {
      const share = kickoff.share[role];
      rows.push([
        role,
        `${summary.models.requested.join(",") || "-"} -> ${summary.models.reported.join(",") || "-"}`,
        `${summary.measuredSessions}${summary.partialSessions ? `+${summary.partialSessions} partial` : ""}/${summary.sessions}`,
        number(summary.turns),
        number(summary.calls),
        number(summary.steps),
        `${number(summary.promptTokens)} (${number(summary.cachedInputTokens)}/${number(summary.cacheCreationTokens)})`,
        number(summary.outputTokens),
        typeof share === "number" ? `${(share * 100).toFixed(1)}%` : share,
      ]);
    }
    const lines = [
      `kickoff ${kickoff.kickoff.worktreeId} (${kickoff.kickoff.status}) ${kickoff.window.from} .. ${kickoff.window.to}`,
      rows.length > 1
        ? table(rows)
        : "no sessions found in this kickoff's places",
      `coverage: ${kickoff.coverage.measuredSessions}/${kickoff.coverage.totalSessions} sessions measured. ${kickoff.coverage.note}`,
    ];
    // Without launch lines only the PM worktree is searched, so roles that
    // worked elsewhere are missing rather than idle.
    if (
      !kickoff.recordedLaunches &&
      !kickoff.places.some((place) => place.source === "manual")
    ) {
      lines.push(
        "no launches recorded for this kickoff: only the PM worktree was read; name other roles' worktrees with --place role=path",
      );
    }
    for (const [source, summary] of Object.entries(kickoff.sources)) {
      if (summary.unavailable)
        lines.push(`source ${source} unavailable: ${summary.unavailable}`);
    }
    for (const mismatch of kickoff.mismatches) {
      lines.push(
        `model mismatch: ${mismatch.role} requested ${mismatch.modelRequested}, reported ${mismatch.modelReported.join(",")} (${mismatch.source})`,
      );
    }
    if (kickoff.unattributed.length) {
      lines.push(
        `unattributed or ambiguous sessions: ${kickoff.unattributed.length}; name their places with --place role=path`,
      );
    }
    return lines.join("\n");
  });
  if (!blocks.length) blocks.push("no kickoffs selected");
  if (report.written.length)
    blocks.push(`written: ${report.written.join(", ")}`);
  return blocks.join("\n\n");
}
