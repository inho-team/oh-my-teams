/**
 * 사용자 제공 Mac 집계와 OMT 실행 귀속 근거를 개인정보 없이 결합한다.
 *
 * 실행 예:
 * node experiments/delegation-economics/mac-usage.mjs --user <evidence.json> \
 *   --checkpoint <usage-checkpoint.json> --launches <launches.jsonl> \
 *   --out docs/plan/delegation-economics/mac-usage-evidence.json
 */

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

/**
 * 명령줄 인자를 읽는다.
 * @param {string[]} argv 명령줄 인자이다.
 * @returns {{user: string, checkpoint: string, launches: string, workflowState: string, workflowOrganization: string, registryState: string, rollout: string, out: string}}
 * 입력과 출력 경로이다.
 */
export function parseArgs(argv) {
  const result = {
    user: null,
    checkpoint: null,
    launches: null,
    workflowState: null,
    workflowOrganization: null,
    registryState: null,
    rollout: null,
    out: null,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--user") result.user = value;
    else if (flag === "--checkpoint") result.checkpoint = value;
    else if (flag === "--launches") result.launches = value;
    else if (flag === "--workflow-state") result.workflowState = value;
    else if (flag === "--workflow-organization")
      result.workflowOrganization = value;
    else if (flag === "--registry-state") result.registryState = value;
    else if (flag === "--rollout") result.rollout = value;
    else if (flag === "--out") result.out = value;
    else throw new Error(`알 수 없는 인자입니다: ${flag}`);
  }
  if (Object.values(result).some((value) => value === null)) {
    throw new Error("모든 입력 경로와 --out이 필요합니다.");
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
 * 파일의 SHA-256 지문을 계산한다.
 * @param {string} file 파일 경로이다.
 * @returns {string} 지문이다.
 */
export function sha256(file) {
  const input = Buffer.isBuffer(file) ? file : fs.readFileSync(file);
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * state 입력을 절대 경로 없이 기록한다.
 * @param {string} file state JSON 경로이다.
 * @param {string} collectedAt 수집 시각이다.
 * @param {string} [label] 공개할 익명 파일명이다.
 * @returns {Record<string, any>} 익명 출처 기록이다.
 */
export function stateSource(file, collectedAt, label = path.basename(file)) {
  return {
    file: label,
    sha256: sha256(file),
    collectedAt,
  };
}

/**
 * 식별자를 공개하지 않고 연결 방법을 검증할 지문으로 남긴다.
 * @param {string} value 연결 입력이다.
 * @returns {string} 식별자 지문이다.
 */
export function identifierHash(value) {
  return sha256(Buffer.from(value));
}

/**
 * 두 시간 창의 겹침 여부와 경계를 계산한다.
 * @param {{start: string, end: string}} first 첫 창이다.
 * @param {{from: string, to: string}} second 둘째 창이다.
 * @returns {Record<string, any>} 비교 결과이다.
 */
export function compareWindows(first, second) {
  const start = new Date(
    Math.max(Date.parse(first.start), Date.parse(second.from)),
  );
  const end = new Date(Math.min(Date.parse(first.end), Date.parse(second.to)));
  return {
    identical: first.start === second.from && first.end === second.to,
    overlap: start < end,
    overlapFrom: start < end ? start.toISOString() : null,
    overlapTo: start < end ? end.toISOString() : null,
  };
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
  for (const file of [
    args.user,
    args.checkpoint,
    args.launches,
    args.workflowState,
    args.workflowOrganization,
    args.registryState,
    args.rollout,
  ]) {
    if (!fs.existsSync(file)) throw new Error(`입력 파일이 없습니다: ${file}`);
  }
  const collectedAt = new Date().toISOString();
  const user = readJson(args.user);
  const checkpoint = readJson(args.checkpoint).kickoffs[0];
  const workflowState = readJson(args.workflowState);
  const workflowOrganization = readJson(args.workflowOrganization);
  const registryState = readJson(args.registryState);
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
        organizationRevision: workflowState.organizationRevision,
        workflowRevision: workflowState.revision,
        organizationSnapshotRevision: workflowOrganization.revision,
        collectedAt,
        window: checkpoint.window,
      },
      revisionProvenance: {
        currentWorkflow: {
          workflowId,
          organizationRevision: workflowState.organizationRevision,
          workflowRevision: workflowState.revision,
          organizationSnapshotRevision: workflowOrganization.revision,
          source: stateSource(args.workflowState, collectedAt),
          organizationSource: stateSource(
            args.workflowOrganization,
            collectedAt,
          ),
        },
        priorKickoffRegistry: {
          workflowId: registryState.id,
          organizationRevision: registryState.organizationRevision,
          workflowRevision: registryState.revision,
          source: stateSource(args.registryState, collectedAt),
        },
        relation:
          "checkpoint usage belongs to the prior kickoff registry window; current workflow revision 3 is recorded separately and is not substituted into the prior usage totals.",
      },
      windowComparison: {
        userMacPeriod: user.period,
        checkpointWindow: checkpoint.window,
        ...compareWindows(user.period, checkpoint.window),
        note: "The Mac aggregate period and checkpoint window overlap but are not identical.",
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
    manualConnection: {
      role: "pm",
      provider: "codex",
      model: "gpt-6-astra",
      workspace: "docs-delegation-economics",
      connectionMethod: [
        "launch-ledger row",
        "run-use binding",
        "Codex thread metadata match",
      ],
      scope: {
        launchAt: "2026-09-21T05:11:46.880Z",
        checkpointRecordFrom: astra[0]?.firstAt ?? null,
        checkpointRecordTo: astra[0]?.lastAt ?? null,
        runHash: identifierHash("run_55a527acdd09"),
        terminalHash: identifierHash(
          "term_bae15edf-c10c-4e2e-9878-c8e5ec97acc1",
        ),
        threadHash: identifierHash("01a0c260-c41d-7a51-aae8-cba3bc36d75d"),
      },
      attributionEvidence: {
        roleConnection: "PM OMT execution",
        taskUse: "unclassified",
        tokens: null,
        reason:
          "The launch, run binding, worktree, terminal, and rollout thread agree on the PM connection; no evidence assigns Astra tokens to a specific task use.",
      },
      rolloutSource: stateSource(
        args.rollout,
        collectedAt,
        "codex-rollout.jsonl",
      ),
    },
    astraClassification: {
      measuredRecords: astra.length,
      manuallyConnectedRecords: astra.length,
      roleConnectedRecords: astra.length,
      taskUseDenominator: astra.length,
      classifiedRecords: 0,
      unclassifiedRecords: astra.length,
      taskUseUnclassifiedRatio: astra.length ? 1 : null,
      categories: {
        planningAssignmentAggregation: { records: 0, tokens: null },
        repeatedStatusObservation: { records: 0, tokens: null },
        importantDirectorJudgment: { records: 0, tokens: null },
        directImplementation: { records: 0, tokens: null },
        failureRecovery: { records: 0, tokens: null },
        unclassified: { records: astra.length, tokens: null },
      },
      reason:
        "The Astra record is manually connected to the PM OMT execution by launch, " +
        "run-use, and thread metadata; task-use categories remain unclassified " +
        "and their token fields remain null.",
    },
    measurementLimits: [
      "User-provided Mac totals cover all local Codex usage, not OMT-only usage, and were not independently recomputed.",
      "Calls, turns, cache-including totals, cached input, cache creation, output, and non-cached totals are separate signals; " +
        "non-cached totals remain null when the source does not provide them.",
      "Token allocation is unmeasured when a record cannot be connected to a verified OMT role and task.",
      "No billing, quota deduction, currency conversion, or savings rate is inferred.",
    ],
  };
  const categoryRecords = Object.values(
    output.astraClassification.categories,
  ).reduce((sum, category) => sum + category.records, 0);
  if (
    categoryRecords !== output.astraClassification.taskUseDenominator ||
    output.astraClassification.classifiedRecords +
      output.astraClassification.unclassifiedRecords !==
      output.astraClassification.taskUseDenominator
  ) {
    throw new Error(
      "Astra task-use 집계의 분모와 category 합계가 일치하지 않습니다.",
    );
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(output, null, 2)}\n`);
  return output;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildEvidence(parseArgs(process.argv.slice(2)));
}
