/** Records deduplicated learning candidates without auto-editing instructions. */
import fs from "node:fs";
import path from "node:path";
import { assert, hash, writeJSON } from "./core.mjs";

const LESSON_TARGETS = [
  "runtime-check",
  "role-skill",
  "repository-guidance",
  "design-decision",
  "organization-eval",
];

/**
 * Persists a candidate lesson under a stable failure/reproduction fingerprint.
 *
 * Repeated observations return the existing candidate. Creation never modifies
 * a role skill or promotes the record to reviewed knowledge.
 *
 * @param {string} stateDir - PM worktree `.omt` state directory.
 * @param {object} input - Failure, resolution, reproduction, target, and owner.
 * @returns {object} Creation status, fingerprint, path, and optional new record.
 * @throws {Error} When required evidence or routing metadata is invalid.
 */
export function recordLessonCandidate(stateDir, input) {
  assert(
    input?.schemaVersion === 1 && typeof input.failureCategory === "string",
    "Lesson failure category required",
  );
  assert(
    typeof input.failureEvidence === "string" && input.failureEvidence.trim(),
    "Lesson failure evidence required",
  );
  assert(
    typeof input.resolution === "string" && input.resolution.trim(),
    "Lesson resolution required",
  );
  assert(
    typeof input.reproduction === "string" && input.reproduction.trim(),
    "Lesson reproduction required",
  );
  assert(LESSON_TARGETS.includes(input.target), "Invalid lesson target");
  assert(
    typeof input.owner === "string" && input.owner.trim(),
    "Lesson owner required",
  );

  const fingerprint = hash({
    failureCategory: input.failureCategory,
    reproduction: input.reproduction.trim(),
    target: input.target,
  });
  const file = path.join(
    stateDir,
    "lessons",
    "candidates",
    `${fingerprint}.json`,
  );
  if (fs.existsSync(file)) return { created: false, fingerprint, file };

  const record = {
    ...input,
    fingerprint,
    status: "candidate",
    createdAt: new Date().toISOString(),
    note: "Candidates require separate verification before changing skills or knowledge.",
  };
  writeJSON(file, record);
  return { created: true, fingerprint, file, record };
}
