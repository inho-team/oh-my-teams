/** Structured, conservative role selection for newly created workflows. */
import { assert } from "./core.mjs";

const SCOPES = ["closed", "open"];
const VERIFICATIONS = ["deterministic", "independent-review"];
const AUTHORITIES = ["standard", "elevated"];
const DESIGNS = ["routine", "significant"];

/**
 * Validates optional task metadata used only when a workflow has no explicit role.
 *
 * @param {object} task - Task v2 contract.
 * @returns {void}
 * @throws {Error} When delegation metadata is incomplete or invalid.
 */
export function validateDelegationMetadata(task) {
  if (task.delegation === undefined) return;
  const metadata = task.delegation;
  assert(
    metadata && typeof metadata === "object",
    "Delegation metadata must be an object",
  );
  assert(
    SCOPES.includes(metadata.scope),
    "Delegation scope must be closed or open",
  );
  assert(
    VERIFICATIONS.includes(metadata.verification),
    "Delegation verification must be deterministic or independent-review",
  );
  assert(
    AUTHORITIES.includes(metadata.authority),
    "Delegation authority must be standard or elevated",
  );
  assert(
    DESIGNS.includes(metadata.design),
    "Delegation design must be routine or significant",
  );
}

/**
 * Selects the requested role from a task's structured risk metadata.
 *
 * Missing metadata deliberately remains with Junior. Workflow request `role`
 * bypasses this policy, so a user can always choose a role explicitly.
 *
 * @param {object} task - Validated task v2 contract.
 * @param {object} [policy] - Organization delegation policy.
 * @returns {{role: string, reason: string}} Conservative requested role and durable reason.
 */
export function selectDelegatedRole(
  task,
  policy = { strategy: "intern-first" },
) {
  assert(
    policy?.strategy === "intern-first",
    "Delegation strategy must be intern-first",
  );
  validateDelegationMetadata(task);
  const metadata = task.delegation;
  if (!metadata) return { role: "junior", reason: "metadata-missing" };
  if (task.risk === "high") return { role: "senior", reason: "risk-high" };
  if (metadata.authority === "elevated") {
    return { role: "senior", reason: "authority-elevated" };
  }
  if (metadata.design === "significant") {
    return { role: "senior", reason: "design-significant" };
  }
  if (metadata.verification === "independent-review") {
    return { role: "senior", reason: "review-independent" };
  }
  if (
    task.risk === "low" &&
    metadata.scope === "closed" &&
    metadata.verification === "deterministic"
  ) {
    return { role: "intern", reason: "low-risk-closed-deterministic" };
  }
  return { role: "junior", reason: "metadata-conservative" };
}
