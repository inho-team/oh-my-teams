/** Bounded incident intake with deduplication, observation, and loop stopping. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { assert, hash, readJSON, withFileLock, writeJSON } from "./core.mjs";

const OPEN_STATUSES = ["proposed", "observing"];
const SETTLED_STATUSES = ["stopped", "resolved"];
const OBSERVATION_OUTCOMES = [
  "progress",
  "no-progress",
  "resolved",
  "regressed",
];
const POSITIVE_CONFIG_FIELDS = [
  "maxOpen",
  "maxProposalsPerWindow",
  "windowMs",
  "observationMs",
  "noProgressLimit",
];

const incidentDir = (stateDir) => path.join(stateDir, "incidents");
const stateFile = (stateDir) => path.join(incidentDir(stateDir), "state.json");

function validateConfig(config) {
  assert(
    config?.schemaVersion === 1 && typeof config.enabled === "boolean",
    "Incident config schemaVersion=1 and enabled required",
  );
  for (const field of POSITIVE_CONFIG_FIELDS) {
    assert(
      Number.isInteger(config[field]) && config[field] >= 1,
      `Positive incident config ${field} required`,
    );
  }
  return config;
}

function validateEvent(event) {
  assert(
    event?.schemaVersion === 1 &&
      typeof event.source === "string" &&
      event.source.trim(),
    "Incident source required",
  );
  assert(
    typeof event.externalId === "string" &&
      event.externalId.trim() &&
      typeof event.dedupeKey === "string" &&
      event.dedupeKey.trim(),
    "Incident externalId and dedupeKey required",
  );
  assert(
    typeof event.summary === "string" &&
      event.summary.trim() &&
      typeof event.evidence === "string" &&
      event.evidence.trim(),
    "Incident summary and evidence required",
  );
  assert(
    Number.isFinite(Date.parse(event.observedAt)),
    "Incident observedAt required",
  );
  return event;
}

function emptyState() {
  return { schemaVersion: 1, incidents: {}, proposalTimes: [] };
}

function loadState(stateDir) {
  return fs.existsSync(stateFile(stateDir))
    ? readJSON(stateFile(stateDir))
    : emptyState();
}

function activeIncidentCount(state) {
  return Object.values(state.incidents).filter((incident) =>
    OPEN_STATUSES.includes(incident.status),
  ).length;
}

function proposalHoldReason(config, openCount, proposalCount) {
  if (!config.enabled) return "kill-switch";
  if (openCount >= config.maxOpen) return "max-open";
  if (proposalCount >= config.maxProposalsPerWindow) return "proposal-budget";
  return null;
}

function createIncident(event, config, now, fingerprint, holdReason) {
  const allowed = holdReason === null;
  const observedAt = Date.parse(event.observedAt);
  return {
    id: `incident-${crypto.randomUUID()}`,
    fingerprint,
    source: event.source,
    externalId: event.externalId,
    dedupeKey: event.dedupeKey,
    summary: event.summary,
    evidence: event.evidence,
    observedAt: event.observedAt,
    status: allowed ? "proposed" : "held",
    holdReason,
    proposal: allowed
      ? { scope: "diagnosis-and-fix-proposal", deploymentAuthorized: false }
      : null,
    observeUntil: new Date(
      Math.max(now, observedAt) + config.observationMs,
    ).toISOString(),
    noProgressCount: 0,
    observations: [],
  };
}

/**
 * Deduplicates and conditionally proposes work for one external incident.
 *
 * Intake never grants deployment permission. A disabled kill switch or exceeded
 * budget records the event as held rather than silently dropping it.
 *
 * @param {string} stateDir - Coordinator `.omt` state directory.
 * @param {object} event - Source event with a stable dedupe key and evidence.
 * @param {object} config - Kill switch, budgets, and observation policy.
 * @param {number} [now=Date.now()] - Injectable clock for deterministic tests.
 * @returns {{duplicate: boolean, incident: object}} Intake result.
 * @throws {Error} For malformed input or concurrent state mutation.
 */
export function ingestIncident(stateDir, event, config, now = Date.now()) {
  validateEvent(event);
  validateConfig(config);
  const directory = incidentDir(stateDir);
  return withFileLock(
    path.join(directory, ".lock"),
    () => {
      const state = loadState(stateDir);
      const fingerprint = hash(`${event.source}\0${event.dedupeKey}`);
      const existing = state.incidents[fingerprint];
      if (existing) return { duplicate: true, incident: existing };

      state.proposalTimes = state.proposalTimes.filter(
        (timestamp) => now - timestamp < config.windowMs,
      );
      const holdReason = proposalHoldReason(
        config,
        activeIncidentCount(state),
        state.proposalTimes.length,
      );
      const incident = createIncident(
        event,
        config,
        now,
        fingerprint,
        holdReason,
      );
      state.incidents[fingerprint] = incident;
      if (holdReason === null) state.proposalTimes.push(now);
      writeJSON(stateFile(stateDir), state);
      writeJSON(path.join(directory, `${incident.id}.json`), incident);
      return { duplicate: false, incident };
    },
    "Incident update in progress",
  );
}

function validateObservation(input) {
  assert(
    typeof input?.eventId === "string" &&
      input.eventId.trim() &&
      typeof input.evidence === "string" &&
      input.evidence.trim(),
    "Observation event and evidence required",
  );
  assert(
    OBSERVATION_OUTCOMES.includes(input.outcome),
    "Invalid observation outcome",
  );
  const observedAt = input.observedAt ?? new Date().toISOString();
  assert(
    Number.isFinite(Date.parse(observedAt)),
    "Observation observedAt must be a date-time",
  );
  return observedAt;
}

function transitionIncident(incident, input, config, observedAt) {
  // A stopped or resolved incident is settled. Without this guard a single
  // "progress" observation cleared noProgressCount and returned the incident to
  // "observing", which disarmed the very no-progress limit that stopped it.
  // Only an explicit regression reopens settled work.
  if (SETTLED_STATUSES.includes(incident.status)) {
    if (input.outcome !== "regressed") return;
    incident.status = "proposed";
    incident.holdReason = null;
    incident.noProgressCount = 0;
    return;
  }
  incident.noProgressCount =
    input.outcome === "no-progress" ? incident.noProgressCount + 1 : 0;
  if (incident.noProgressCount >= config.noProgressLimit) {
    incident.status = "stopped";
    incident.holdReason = "no-progress-limit";
  } else if (input.outcome === "resolved") {
    incident.status =
      Date.parse(observedAt) < Date.parse(incident.observeUntil)
        ? "observing"
        : "resolved";
  } else if (input.outcome === "regressed") {
    incident.status = "proposed";
  } else if (incident.status !== "held") {
    incident.status = "observing";
  }
}

/**
 * Records one idempotent observation and advances the incident lifecycle.
 *
 * @param {string} stateDir - Coordinator `.omt` state directory.
 * @param {object} input - Incident ID, event ID, outcome, evidence, and time.
 * @param {object} config - Observation and no-progress policy.
 * @returns {{duplicate: boolean, incident: object}} Updated incident state.
 * @throws {Error} For unknown incidents, malformed observations, or lock conflict.
 */
export function observeIncident(stateDir, input, config) {
  validateConfig(config);
  const directory = incidentDir(stateDir);
  return withFileLock(
    path.join(directory, ".lock"),
    () => {
      const state = loadState(stateDir);
      const incident = Object.values(state.incidents).find(
        (item) => item.id === input?.incidentId,
      );
      assert(incident, "Unknown incident");
      if (
        incident.observations.some((item) => item.eventId === input.eventId)
      ) {
        return { duplicate: true, incident };
      }

      const observedAt = validateObservation(input);
      incident.observations.push({
        eventId: input.eventId,
        outcome: input.outcome,
        evidence: input.evidence,
        observedAt,
      });
      transitionIncident(incident, input, config, observedAt);
      writeJSON(stateFile(stateDir), state);
      writeJSON(path.join(directory, `${incident.id}.json`), incident);
      return { duplicate: false, incident };
    },
    "Incident update in progress",
  );
}

/**
 * Reads the current incident index without mutating it.
 *
 * @param {string} stateDir - Coordinator `.omt` state directory.
 * @returns {object} Incident state, or an empty initialized shape.
 */
export function incidentStatus(stateDir) {
  return loadState(stateDir);
}
