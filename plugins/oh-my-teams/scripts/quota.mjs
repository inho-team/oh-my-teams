/** Manual or provider-supported quota snapshot validation and comparison. */
import fs from "node:fs";
import path from "node:path";
import { assert, readJSON, writeJSON } from "./core.mjs";

/**
 * Validates a quota snapshot without interpreting percentages as token cost.
 *
 * @param {object} snapshot - Pool, account, observation, and reset-window data.
 * @returns {object} The same validated snapshot.
 * @throws {Error} When identifiers, dates, windows, or percentages are invalid.
 */
export function validateQuotaSnapshot(snapshot) {
  assert(
    snapshot?.schemaVersion === 1 && typeof snapshot.poolId === "string",
    "Quota snapshot poolId required",
  );
  // recordQuotaSnapshot builds a state path from this value, so it must carry
  // the same pool identity the organization declares. A free-form string here
  // would let "../.." place a snapshot outside the coordinator state.
  assert(
    /^[a-z0-9][a-z0-9-]*$/.test(snapshot.poolId),
    `Invalid pool id: ${snapshot.poolId}`,
  );
  assert(
    typeof snapshot.accountProfile === "string" &&
      snapshot.accountProfile.trim() &&
      typeof snapshot.source === "string" &&
      snapshot.source.trim(),
    "Quota snapshot account/source required",
  );
  assert(
    Number.isFinite(Date.parse(snapshot.observedAt)),
    "Quota snapshot observedAt required",
  );
  assert(
    Array.isArray(snapshot.windows) && snapshot.windows.length > 0,
    "Quota windows required",
  );

  for (const window of snapshot.windows) {
    assert(
      typeof window.kind === "string" && window.kind.trim(),
      "Quota window kind required",
    );
    assert(
      window.remainingPercent === null ||
        (typeof window.remainingPercent === "number" &&
          window.remainingPercent >= 0 &&
          window.remainingPercent <= 100),
      "remainingPercent must be 0..100 or null",
    );
    assert(
      window.resetAt === null || Number.isFinite(Date.parse(window.resetAt)),
      "resetAt must be date-time or null",
    );
  }
  assert(
    ["none", "known", "unknown"].includes(snapshot.otherActivity),
    "otherActivity must be none, known or unknown",
  );
  return snapshot;
}

/**
 * Classifies whether a single snapshot is fresh enough for display.
 *
 * @param {object} snapshot - Valid quota snapshot.
 * @param {object} [options] - Freshness controls.
 * @param {number} [options.now=Date.now()] - Comparison time in milliseconds.
 * @param {number} [options.maxAgeMs=3600000] - Maximum accepted age.
 * @returns {object} `observed` windows or an explicit `unknown` reason.
 * @throws {Error} When the snapshot is malformed.
 */
export function quotaStatus(
  snapshot,
  { now = Date.now(), maxAgeMs = 3600000 } = {},
) {
  validateQuotaSnapshot(snapshot);
  const ageMs = now - Date.parse(snapshot.observedAt);
  if (ageMs < 0 || ageMs > maxAgeMs) {
    return { status: "unknown", reason: "stale-snapshot", ageMs };
  }
  if (snapshot.windows.some((window) => window.remainingPercent === null)) {
    return { status: "unknown", reason: "missing-window-value", ageMs };
  }
  return { status: "observed", ageMs, windows: snapshot.windows };
}

/**
 * Compares two same-pool snapshots only when consumption is attributable.
 *
 * Reset boundaries, other activity, missing values, or account changes make the
 * result unknown instead of manufacturing a consumption number.
 *
 * @param {object} before - Earlier quota snapshot.
 * @param {object} after - Later quota snapshot.
 * @returns {object} Attribution result and percentage-point consumption.
 * @throws {Error} When either snapshot is malformed.
 */
export function compareQuotaSnapshots(before, after) {
  validateQuotaSnapshot(before);
  validateQuotaSnapshot(after);
  const reasons = [];

  if (
    before.poolId !== after.poolId ||
    before.accountProfile !== after.accountProfile
  ) {
    reasons.push("different-pool-or-account");
  }
  if (before.otherActivity !== "none" || after.otherActivity !== "none") {
    reasons.push("other-activity-not-excluded");
  }

  const previousByKind = new Map(
    before.windows.map((window) => [window.kind, window]),
  );
  if (previousByKind.size !== after.windows.length) {
    reasons.push("different-window-set");
  }

  const consumption = {};
  for (const current of after.windows) {
    const previous = previousByKind.get(current.kind);
    if (!previous) {
      reasons.push(`missing-before-window:${current.kind}`);
      continue;
    }
    if (previous.resetAt !== current.resetAt) {
      reasons.push(`window-reset:${current.kind}`);
    }
    if (
      previous.remainingPercent === null ||
      current.remainingPercent === null
    ) {
      reasons.push(`missing-value:${current.kind}`);
    } else {
      consumption[current.kind] =
        previous.remainingPercent - current.remainingPercent;
    }
  }

  return {
    attributable: reasons.length === 0,
    reasons,
    consumption: reasons.length === 0 ? consumption : null,
    note: "Percentage-point consumption is not token usage or monetary cost.",
  };
}

/**
 * Writes an immutable quota snapshot under its pool and observation time.
 *
 * @param {string} stateDir - Coordinator `.omt` state directory.
 * @param {object} snapshot - Valid quota snapshot.
 * @returns {{file: string, snapshot: object}} Persisted location and value.
 * @throws {Error} When validation fails or the timestamp already exists.
 */
export function recordQuotaSnapshot(stateDir, snapshot) {
  validateQuotaSnapshot(snapshot);
  const timestamp = snapshot.observedAt.replace(/[:.]/g, "-");
  const file = path.join(
    stateDir,
    "quota",
    snapshot.poolId,
    `${timestamp}.json`,
  );
  assert(!fs.existsSync(file), "Quota snapshot already recorded");
  writeJSON(file, snapshot);
  return { file, snapshot };
}

/**
 * Loads the lexically latest snapshot for every recorded quota pool.
 *
 * @param {string} stateDir - Coordinator `.omt` state directory.
 * @returns {Record<string, object>} Latest snapshot keyed by pool ID.
 */
export function latestQuotaSnapshots(stateDir) {
  const root = path.join(stateDir, "quota");
  if (!fs.existsSync(root)) return {};

  const entries = fs.readdirSync(root).flatMap((poolId) => {
    const directory = path.join(root, poolId);
    if (!fs.statSync(directory).isDirectory()) return [];
    const files = fs
      .readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort();
    if (files.length === 0) return [];
    return [[poolId, readJSON(path.join(directory, files.at(-1)))]];
  });
  return Object.fromEntries(entries);
}
