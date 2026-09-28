/** The structured .omt document schemas match design 3.2, and organization.schema.json stays backward compatible. */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readJSON, validateOrg } from "../plugins/oh-my-teams/scripts/core.mjs";

const schema = (file) =>
  readJSON(path.resolve("plugins/oh-my-teams/schemas", file));

const example = (file) =>
  readJSON(path.resolve("plugins/oh-my-teams/examples", file));

// docs/plan/structured-omt-documents.md 3.2 common envelope.
const ENVELOPE_FIELDS = [
  "schemaVersion",
  "docId",
  "stage",
  "kickoffId",
  "workflowId",
  "revision",
  "state",
  "author",
  "createdAt",
  "basedOnRevision",
  "reason",
];

// docs/plan/structured-omt-documents.md 3.2's per-folder body field table.
const DOCUMENT_TYPES = [
  {
    file: "document-kickoff-brief-ref.schema.json",
    bodyFields: [
      "briefPath",
      "acceptanceSummary",
      "nonGoals",
      "constraints",
      "kickoffEntryRef",
    ],
  },
  {
    file: "document-design-contract.schema.json",
    bodyFields: [
      "problemStatement",
      "decisions",
      "openQuestions",
      "reviewRequirementRef",
    ],
  },
  {
    file: "document-workflow-task-ref.schema.json",
    bodyFields: ["workflowRef", "taskRef", "attemptRefs", "designRef"],
  },
  {
    file: "document-integration-ref.schema.json",
    bodyFields: ["integrationTaskRef", "taskHashRef", "extensionHistory"],
  },
  {
    file: "document-review-ref.schema.json",
    bodyFields: ["reviewFileRef", "conclusion", "criteriaRefs"],
  },
  {
    file: "document-acceptance-ref.schema.json",
    bodyFields: ["decisionFileRef", "acceptedBy", "criteriaSatisfied"],
  },
  {
    file: "document-delivery-ref.schema.json",
    bodyFields: ["evidenceRef", "reportRef", "deliveredCommit"],
  },
  {
    file: "document-closure-record.schema.json",
    bodyFields: [
      "directorSignalRef",
      "kickoffArchiveRef",
      "outcome",
      "incidentRefs",
      "lessonCandidateRefs",
    ],
  },
];

test("document-envelope.schema.json is valid JSON and requires every 3.2 envelope field", () => {
  const envelope = schema("document-envelope.schema.json");
  assert.deepEqual([...envelope.required].sort(), [...ENVELOPE_FIELDS].sort());
});

for (const { file, bodyFields } of DOCUMENT_TYPES) {
  test(`${file} is valid JSON and requires every 3.2 envelope and body field`, () => {
    const doc = schema(file);
    const expected = [...ENVELOPE_FIELDS, ...bodyFields].sort();
    assert.deepEqual([...doc.required].sort(), expected);
    for (const field of bodyFields) {
      assert.ok(
        Object.hasOwn(doc.properties, field),
        `${file} must declare a property for required field ${field}`,
      );
    }
  });
}

test("workflow-task-ref requires designRef even though its value may be null", () => {
  const doc = schema("document-workflow-task-ref.schema.json");
  assert.ok(doc.required.includes("designRef"));
  assert.ok(
    JSON.stringify(doc.properties.designRef).includes('"null"'),
    "designRef must allow null for kickoffs with no design-contract document (3.2)",
  );
});

test("organization.schema.json adds documentSystemActivatedAt without requiring it", () => {
  const org = schema("organization.schema.json");
  assert.ok(
    Object.hasOwn(org.properties, "documentSystemActivatedAt"),
    "organization.schema.json must declare documentSystemActivatedAt (3.10)",
  );
  assert.ok(
    !org.required.includes("documentSystemActivatedAt"),
    "documentSystemActivatedAt must stay optional so pre-existing organizations remain valid",
  );
});

test("an existing organization without documentSystemActivatedAt still validates", () => {
  const org = example("organization.json");
  assert.ok(!Object.hasOwn(org, "documentSystemActivatedAt"));
  assert.deepEqual(validateOrg(org), org);
});
