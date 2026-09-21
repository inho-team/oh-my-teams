/**
 * 사용량 스냅샷과 workflow state를 익명 집계한다.
 *
 * 실행 예:
 * node experiments/delegation-economics/aggregate.mjs --usage <usage-a.json> \
 *   --usage <usage-b.json> --state <state-a> --state <state-b> \
 *   --out docs/plan/delegation-economics/usage-aggregate.json
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const USAGE_FIELDS = [
  "sessions",
  "measuredSessions",
  "turns",
  "calls",
  "promptTokens",
  "cachedInputTokens",
  "cacheCreationTokens",
  "outputTokens",
];

/**
 * 명령줄 인자를 읽는다.
 * @param {string[]} argv 명령줄 인자이다.
 * @returns {{usage: string[], state: string[], out: string}} 집계 입력과 출력 경로이다.
 */
export function parseArgs(argv) {
  const result = {
    usage: [],
    state: [],
    out: "docs/plan/delegation-economics/usage-aggregate.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--usage") result.usage.push(value);
    else if (flag === "--state") result.state.push(value);
    else if (flag === "--out") result.out = value;
    else throw new Error(`알 수 없는 인자입니다: ${flag}`);
    if (flag !== "--out" && flag !== "--usage" && flag !== "--state") continue;
    index += 1;
  }
  if (result.usage.length === 0) throw new Error("--usage 입력이 필요합니다.");
  return result;
}

/**
 * JSON 파일을 읽는다.
 * @param {string} file JSON 파일 경로이다.
 * @returns {Record<string, unknown>} 파싱한 JSON 객체이다.
 */
export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * 입력 파일의 경로를 저장소 밖 정보 없이 표시한다.
 * @param {string} file 입력 파일 경로이다.
 * @returns {string} 파일명이다.
 */
export function fileName(file) {
  return path.basename(file);
}

/**
 * 파일의 SHA-256 지문을 계산한다.
 * @param {string} file 입력 파일 경로이다.
 * @returns {string} SHA-256 지문이다.
 */
export function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

/**
 * 숫자 두 개의 차이를 분 단위로 계산한다.
 * @param {string|null|undefined} from 시작 시각이다.
 * @param {string|null|undefined} to 종료 시각이다.
 * @returns {number|null} 반올림한 경과 시간(분) 또는 null이다.
 */
export function minutesBetween(from, to) {
  if (!from || !to) return null;
  const elapsed = Date.parse(to) - Date.parse(from);
  return Number.isFinite(elapsed) && elapsed >= 0
    ? Math.round((elapsed / 60000) * 100) / 100
    : null;
}

/**
 * 사용량 스냅샷을 경로와 세션 원문 없이 복사한다.
 * @param {Record<string, any>} source 사용량 스냅샷이다.
 * @returns {Record<string, any>} 익명화한 kickoff 집계이다.
 */
export function aggregateUsage(source) {
  const byRole = structuredClone(source.byRole ?? {});
  const kickoff = {
    entry: source.kickoff.entryName.slice(0, 12),
    window: {
      from: source.window?.from ?? null,
      to: source.window?.to ?? null,
      minutes: minutesBetween(source.window?.from, source.window?.to),
    },
    byRole,
    sources: structuredClone(source.sources ?? {}),
    share: structuredClone(source.share ?? {}),
    coverage: structuredClone(source.coverage ?? {}),
  };
  if (!source.byRole?.intern) kickoff.byRoleMissing = ["intern"];
  kickoff.sourceRows = Object.entries(source.byRole ?? {}).flatMap(
    ([role, value]) =>
      (value.sources ?? []).map((sourceType) => ({
        role,
        source: sourceType,
        sessions: value.sessions,
        measuredSessions: value.measuredSessions,
        turns: value.turns,
        calls: value.calls,
        promptTokens: value.promptTokens,
        cachedInputTokens: value.cachedInputTokens,
        cacheCreationTokens: value.cacheCreationTokens,
        outputTokens: value.outputTokens,
        models: structuredClone(
          value.models ?? { requested: [], reported: [] },
        ),
      })),
  );
  return kickoff;
}

/**
 * headless worker의 실행 결과를 읽는다.
 * @param {string} stateDir state 디렉터리이다.
 * @param {string} workerId worker 식별자이다.
 * @returns {Record<string, any>} worker 실행 요약이다.
 */
export function readWorker(stateDir, workerId) {
  const worker = readJson(
    path.join(stateDir, "headless", workerId, "worker.json"),
  );
  const exitFile = path.join(
    stateDir,
    "headless",
    workerId,
    "turns",
    "1",
    "exit.json",
  );
  const exit = fs.existsSync(exitFile) ? readJson(exitFile) : null;
  return {
    id: worker.id ?? workerId,
    role: worker.role ?? null,
    modelRequested: worker.modelRequested ?? null,
    startedAt: worker.createdAt ?? null,
    endedAt: exit?.endedAt ?? null,
    status: exit ? (exit.code === 0 ? "completed" : "failed") : null,
    costUsd: worker.costUsd ?? exit?.costUsd ?? null,
  };
}

/**
 * state 디렉터리 하나를 집계한다.
 * @param {string} stateDir state 디렉터리이다.
 * @returns {Record<string, any>} 익명화한 state 집계이다.
 */
export function aggregateState(stateDir) {
  if (!fs.existsSync(stateDir)) {
    return {
      input: path.basename(stateDir),
      unavailable: {
        value: null,
        reason: "state 디렉터리가 존재하지 않습니다.",
      },
    };
  }
  const workflowRoot = path.join(stateDir, "workflows");
  const workflowNames = fs.existsSync(workflowRoot)
    ? fs
        .readdirSync(workflowRoot)
        .filter((name) =>
          fs.statSync(path.join(workflowRoot, name)).isDirectory(),
        )
    : [];
  const workflows = workflowNames.map((name) => {
    const root = path.join(workflowRoot, name);
    const request = fs.existsSync(path.join(root, "request.json"))
      ? readJson(path.join(root, "request.json"))
      : {};
    const state = fs.existsSync(path.join(root, "state.json"))
      ? readJson(path.join(root, "state.json"))
      : {};
    const eventRoot = path.join(root, "events");
    const events = fs.existsSync(eventRoot)
      ? fs
          .readdirSync(eventRoot)
          .filter((file) => file.endsWith(".json"))
          .map((file) => readJson(path.join(eventRoot, file)))
      : [];
    const workers = fs.existsSync(path.join(stateDir, "headless"))
      ? fs
          .readdirSync(path.join(stateDir, "headless"))
          .filter((workerId) =>
            fs.existsSync(
              path.join(stateDir, "headless", workerId, "worker.json"),
            ),
          )
          .map((workerId) => readWorker(stateDir, workerId))
      : [];
    const reviews = ["reviews", "reviews-inbox"].flatMap((folder) => {
      const reviewRoot = path.join(stateDir, folder);
      if (!fs.existsSync(reviewRoot)) return [];
      return fs
        .readdirSync(reviewRoot)
        .filter((file) => file.endsWith(".json"))
        .map((file) => readJson(path.join(reviewRoot, file)));
    });
    const conclusions = {};
    let findingCount = 0;
    for (const review of reviews) {
      const conclusion = review.conclusion ?? "unknown";
      conclusions[conclusion] = (conclusions[conclusion] ?? 0) + 1;
      findingCount += Array.isArray(review.findings)
        ? review.findings.length
        : Array.isArray(review.criteria)
          ? review.criteria.filter((item) => item.conclusion !== "approved")
              .length
          : 0;
    }
    const created =
      events.find((event) => event.type === "workflow-created")?.recordedAt ??
      null;
    const firstEvent =
      events
        .filter((event) => event.recordedAt)
        .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt))[0]
        ?.recordedAt ?? null;
    const lastEvent =
      events
        .filter((event) => event.recordedAt)
        .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))[0]
        ?.recordedAt ?? null;
    return {
      workflow: name,
      depth: state.depth ?? request.depth ?? null,
      tasks: (request.tasks ?? []).map((task) => ({
        file: path.basename(task.file ?? ""),
        role: task.role ?? null,
      })),
      budget: structuredClone(state.budget ?? request.budget ?? null),
      workers,
      reviews: { conclusions, findingCount },
      events: {
        rework: events.filter(
          (event) => event.type === "review-rework-attached",
        ).length,
        retry: events.filter((event) => /retry|re-?try/i.test(event.type ?? ""))
          .length,
      },
      timing: {
        preparationMinutes: minutesBetween(created, firstEvent),
        preparationEvidence:
          created && firstEvent ? "workflow-created→first event" : null,
        completionMinutes: minutesBetween(created, lastEvent),
        completionEvidence:
          created && lastEvent ? "workflow-created→last event" : null,
      },
    };
  });
  return { input: path.basename(stateDir), workflows };
}

/**
 * 모든 입력을 집계하고 출력 파일을 쓴다.
 * @param {{usage: string[], state: string[], out: string}} args 집계 인자이다.
 * @returns {Record<string, any>} 기록한 출력 객체이다.
 */
export function buildAggregate(args) {
  const sources = args.usage.map((file) => ({
    file: fileName(file),
    sha256: sha256(file),
  }));
  const usage = args.usage.map((file) => aggregateUsage(readJson(file)));
  const notes = [];
  for (const item of usage) {
    for (const [role, value] of Object.entries(item.byRole)) {
      if (
        value.promptTokens !== null &&
        value.cachedInputTokens !== null &&
        value.cachedInputTokens > value.promptTokens
      ) {
        notes.push(
          `${role}의 cachedInputTokens가 promptTokens보다 큽니다(${item.entry}).`,
        );
      }
    }
  }
  const output = {
    generatedAt: new Date().toISOString(),
    inputs: { usage: sources, state: args.state.map(fileName) },
    kickoffs: usage,
    states: args.state.map(aggregateState),
    notes: [...new Set(notes)],
  };
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(output, null, 2)}\n`);
  return output;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildAggregate(parseArgs(process.argv.slice(2)));
}
