/**
 * Shared fixture for tests that need a claim's `requirements` block but are
 * not themselves exercising the requirements ledger (delivery, documents,
 * kickoff registry, director role/terminal, auditor). Counterexample 7
 * (docs/plan/requirements-ledger-and-audit.md A.2): `validateLedgerForClaim`
 * and `requirementsRetrofit` now require a claim's statements/criteria/
 * confirmations to match a stored draft field-for-field, so a claim built by
 * hand-assembling that shape (without ever calling `requirementsDraft`) fails
 * validation. This fixture always records a real draft first, then returns
 * its recorded content, so every test importing it still goes through the
 * same requirements-draft path a real kickoff would.
 */
import {
  readDraft,
  requirementsDraft,
} from "../plugins/oh-my-teams/scripts/requirements.mjs";

/**
 * Records a draft ledger with one equal-scope criterion — the smallest shape
 * that passes `validateLedgerForClaim` (an equal-scope criterion needs no
 * user confirmation) — and returns the recorded draft's content for a claim
 * to carry as `requirements`.
 *
 * @param {string} orgFile - Organization JSON path.
 * @param {string} worktreeId - PM worktree the draft is recorded for.
 * @returns {{statements: object[], criteria: object[], confirmations: object[]}} Draft content for a claim.
 */
export function minimalRequirements(orgFile, worktreeId) {
  const statements = [
    { id: "s1", text: `deliver ${worktreeId}`, source: "brief" },
  ];
  const criteria = [
    {
      id: "c1",
      text: `deliver ${worktreeId}`,
      scope: "equal",
      userVisible: false,
      derivedFrom: ["s1"],
    },
  ];
  requirementsDraft(orgFile, { worktreeId, statements, criteria });
  const draft = readDraft(orgFile, worktreeId);
  return {
    statements: draft.statements,
    criteria: draft.criteria,
    confirmations: draft.confirmations,
  };
}
