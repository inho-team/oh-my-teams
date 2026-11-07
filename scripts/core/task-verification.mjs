/** Correlates optional completion evidence with the final source and requested delivery. */

function ensure(condition, message) {
  if (!condition) throw new SyntaxError(message);
}

/**
 * Checks recorded delivery evidence without claiming to query the remote destination.
 * @param {object} delivery - Validated delivery observation.
 * @param {string | undefined} head - Observed source commit.
 * @returns {void} Throws when a receipt contradicts the observed delivery or source.
 */
export function assertDeliveryEvidence(delivery, head) {
  const { receipt } = delivery;
  if (!receipt) return;
  ensure(
    delivery.state === "delivered",
    "delivery receipt requires delivered state",
  );
  ensure(
    receipt.source_commit === head,
    "delivery receipt must match final source commit",
  );
  if (["commit", "merge"].includes(receipt.mode))
    ensure(
      receipt.delivered_commit,
      "commit and merge receipts require delivered_commit",
    );
  if (receipt.mode === "commit")
    ensure(
      receipt.delivered_commit === head,
      "commit delivery must preserve final source commit",
    );
}

/**
 * Rejects stale successful checks and contradictory review summaries when supplied.
 * @param {object} document - Validated completion report.
 * @returns {void} Throws when recorded evidence cannot support the completion claim.
 */
export function assertCompletionEvidence({ subject, payload }) {
  for (const check of payload.checks)
    if (check.status === "passed" && check.source_commit)
      ensure(
        check.source_commit === subject.commit,
        "passed check must match final source commit",
      );
  const reviews = payload.reviews ?? [];
  ensure(
    new Set(reviews.map((review) => review.result_id)).size === reviews.length,
    "review result IDs must be unique",
  );
  for (const review of reviews) {
    if (review.independent)
      ensure(
        review.reviewer_session_id !== review.implementation_session_id,
        "implementation session cannot independently review its work",
      );
    if (payload.outcome === "completed") {
      ensure(
        review.source_commit === subject.commit,
        "completion review must match final source commit",
      );
      ensure(
        review.implementation_session_id === subject.implementation_session_id,
        "completion review must match implementation session",
      );
      ensure(
        review.conclusion === "no_findings",
        "completion cannot retain unresolved or inconclusive reviews",
      );
    }
  }
}

/**
 * Enforces the verification requirements explicitly recorded in the original task.
 * @param {object} request - Validated task request, including optional verification requirements.
 * @param {object} response - Validated completion report correlated to this task.
 * @returns {void} Throws when a completed report omits required source, CI, review, or delivery evidence.
 */
export function assertTaskVerification(request, response) {
  const { verification } = request.payload;
  const report = response.payload;
  const { receipt } = report.delivery;
  if (receipt) {
    ensure(
      receipt.mode === request.payload.delivery.mode,
      "delivery receipt must match requested mode",
    );
    ensure(
      receipt.target === request.payload.delivery.target,
      "delivery receipt must match requested target",
    );
  }
  if (!verification || report.outcome !== "completed") return;
  for (const check of report.checks)
    if (check.status === "passed")
      ensure(
        check.source_commit === response.subject.commit,
        "verified completion requires check source_commit",
      );
  for (const expected of verification.required_ci) {
    const checks = report.ci.filter((check) => check.name === expected.name);
    ensure(
      checks.length === 1,
      "verified completion must include each required CI exactly once",
    );
    ensure(
      checks[0].target_branch === expected.target_branch,
      "required CI must match requested target branch",
    );
  }
  if (verification.independent_review)
    ensure(
      report.reviews?.some(
        (review) => review.independent && review.conclusion === "no_findings",
      ),
      "verified completion requires independent review evidence",
    );
  if (verification.delivery_receipt)
    ensure(receipt, "verified completion requires delivery receipt");
}
