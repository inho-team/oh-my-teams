/**
 * 사용자 제공 Mac 집계와 OMT 실행 귀속 근거를 개인정보 없이 결합한다.
 *
 * 실행 예:
 * node experiments/delegation-economics/mac-usage.mjs --user <evidence.json> \
 *   --checkpoint <usage-checkpoint.json> --launches <launches.jsonl> \
 *   --out docs/plan/delegation-economics/mac-usage-evidence.json
 */

import fs from "node:fs";
import path from "node:path";

/**
 * 명령줄 인자를 읽는다.
 * @param {string[]} argv 명령줄 인자이다.
 * @returns {{user: string, checkpoint: string, launches: string, out: string}} 입력과 출력 경로이다.
 */
export function parseArgs(argv) {
  const result = { user: null, checkpoint: null, launches: null, out: null };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--user") result.user = value;
    else if (flag === "--checkpoint") result.checkpoint = value;
    else if (flag === "--launches") result.launches = value;
    else if (flag === "--out") result.out = value;
    else throw new Error(`알 수 없는 인자입니다: ${flag}`);
  }
  if (Object.values(result).some((value) => value === null)) {
    throw new Error(
      "--user, --checkpoint, --launches, --out이 모두 필요합니다.",
    );
  }
  return result;
}

/**
 * JSON 파일을 읽는다.
 * @param {string} file JSON 파일 경로이다.
 * @returns {Record<string, any>} 파싱한 JSON이다.
 */
export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * OMT 작업 경로를 저장소 밖 절대 경로 없이 분류한다.
 * @param {string} value 작업 경로이다.
 * @returns {string} 익명화한 작업 공간 식별자이다.
 */
export function workspaceLabel(value) {
  const base = path.basename(value ?? "");
  return base || "unknown-workspace";
}

/**
 * launch ledger를 줄 단위 JSON으로 읽는다.
 * @param {string} file ledger 경로이다.
 * @returns {Array<Record<string, any>>} launch 기록이다.
 */
export function readLaunches(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * 실행 기록의 역할과 도구 종류를 근거가 있는 범위에서 요약한다.
 * @param {Record<string, any>} record usage 기록이다.
 * @returns {Record<string, any>} 개인정보를 제외한 실행 요약이다.
 */
export function summarizeRecord(record) {
  return {
    role: record.role,
    source: record.source,
    provider: record.provider,
    model: record.modelReported ?? [],
    workspace: workspaceLabel(record.cwd),
    firstAt: record.firstAt ?? null,
    lastAt: record.lastAt ?? null,
    turns: record.turns ?? null,
    calls: record.calls ?? null,
    measured: record.measured ?? false,
    tokens: {
      totalWithCache: record.promptTokens ?? null,
      cachedInput: record.cachedInputTokens ?? null,
      cacheCreation: record.cacheCreationTokens ?? null,
      output: record.outputTokens ?? null,
      nonCached: null,
    },
  };
}

/**
 * 사용자 집계·OMT 연결·Astra 분류를 생성한다.
 * @param {{user: string, checkpoint: string, launches: string, out: string}} args 입력과 출력 경로이다.
 * @returns {Record<string, any>} 기록한 익명 근거이다.
 */
export function buildEvidence(args) {
  const user = readJson(args.user);
  const checkpoint = readJson(args.checkpoint).kickoffs[0];
  const workflowId = "intern-first-r3";
  const records = checkpoint.records ?? [];
  const launches = readLaunches(args.launches);
  const workflowLaunches = launches.filter(
    (launch) => launch.workflowId === workflowId,
  );
  const astra = records.filter((record) =>
    (record.modelReported ?? []).includes("gpt-6-astra"),
  );
  const output = {
    schemaVersion: 1,
    provenance:
      "user-provided Mac aggregate plus OMT read-only attribution evidence; not independently recomputed",
    userAggregate: {
      period: user.period,
      reportedSources: user.reportedSources,
      reportedMethod: user.reportedMethod,
      scope: user.scope,
      models: user.models,
      notMeasures: user.notMeasures,
      proposal: user.proposal,
    },
    omtConnection: {
      workflow: {
        entry: checkpoint.kickoff.entryName.slice(0, 12),
        workflowId,
        status: checkpoint.kickoff.status,
        organizationRevision: checkpoint.kickoff.organizationRevision,
        window: checkpoint.window,
      },
      sources: checkpoint.sources,
      recordedLaunches: checkpoint.recordedLaunches,
      excludedDuplicates: checkpoint.excludedDuplicates,
      clippedEntries: checkpoint.clippedEntries,
      places: (checkpoint.places ?? []).map((place) => ({
        role: place.role,
        profile: place.profile,
        provider: place.provider,
        modelRequested: place.modelRequested,
        workspace: workspaceLabel(place.path),
        at: place.at,
        to: place.to,
        source: place.source,
        via: place.via,
        measuredTokens: false,
      })),
      records: records.map(summarizeRecord),
      byRole: checkpoint.byRole,
      share: checkpoint.share,
      coverage: checkpoint.coverage,
      unattributed: (checkpoint.unattributed ?? []).map((record) => ({
        provider: record.provider,
        source: record.source,
        model: record.modelReported ?? [],
        workspace: workspaceLabel(record.cwd),
        reason: record.attribution?.reason ?? "unknown",
        tokens: "unallocated",
      })),
    },
    launchLedger: {
      workflow: workflowId,
      entries: workflowLaunches.map((launch) => ({
        at: launch.at,
        via: launch.via,
        role: launch.role,
        provider: launch.provider,
        modelRequested: launch.modelRequested,
        workspace: workspaceLabel(launch.worktreePath),
        terminalPresent: Boolean(launch.terminal),
        workerPresent: Boolean(launch.workerId),
      })),
    },
    astraClassification: {
      measuredRecords: astra.length,
      classifiedRecords: 0,
      unclassifiedRecords: astra.length,
      categories: {
        planningAssignmentAggregation: { records: 0, tokens: null },
        repeatedStatusObservation: { records: 0, tokens: null },
        importantDirectorJudgment: { records: 0, tokens: null },
        directImplementation: { records: 0, tokens: null },
        failureRecovery: { records: 0, tokens: null },
        unclassified: { records: astra.length, tokens: null },
      },
      reason:
        "Astra record has no explicit role or task connection in the read-only usage evidence; model name alone is not used for role inference.",
    },
    measurementLimits: [
      "User-provided Mac totals cover all local Codex usage, not OMT-only usage, and were not independently recomputed.",
      "Calls, turns, cache-including totals, cached input, cache creation, output, and non-cached totals are separate signals; " +
        "non-cached totals remain null when the source does not provide them.",
      "Token allocation is unmeasured when a record cannot be connected to a verified OMT role and task.",
      "No billing, quota deduction, currency conversion, or savings rate is inferred.",
    ],
  };
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(output, null, 2)}\n`);
  return output;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildEvidence(parseArgs(process.argv.slice(2)));
}
