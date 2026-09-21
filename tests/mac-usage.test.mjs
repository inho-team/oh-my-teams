/** Regression coverage for anonymous PM connection evidence. */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildEvidence,
  parseArgs,
} from "../experiments/delegation-economics/mac-usage.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-mac-usage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = (name) => path.join(dir, name);
  const write = (name, value) =>
    fs.writeFileSync(file(name), `${JSON.stringify(value)}\n`);
  const connection = {
    schemaVersion: 1,
    runId: "run-fixture",
    terminal: "term-fixture",
    threadId: "thread-fixture",
    workflowId: "intern-first-r3",
    sources: {
      runBinding: file("binding.json"),
      launchLedger: file("launches.jsonl"),
    },
  };
  write("binding.json", {
    result: {
      run: { id: connection.runId, coordinator_handle: connection.terminal },
    },
  });
  fs.writeFileSync(
    file("launches.jsonl"),
    `${JSON.stringify({ role: "pm", terminal: connection.terminal })}\n`,
  );
  write("connection.json", connection);
  write("checkpoint.json", {
    kickoffs: [
      {
        kickoff: { entryName: "fixture-entry", status: "active" },
        window: {
          from: "2026-09-21T00:00:00.000Z",
          to: "2026-09-21T01:00:00.000Z",
        },
        records: [
          {
            sessionKey: connection.threadId,
            provider: "codex",
            modelReported: ["gpt-6-astra"],
          },
        ],
        sources: {},
        recordedLaunches: 1,
        excludedDuplicates: 0,
        clippedEntries: 0,
        byRole: {},
        share: {},
        coverage: {},
      },
    ],
  });
  write("user.json", {
    period: {
      from: "2026-09-21T00:00:00.000Z",
      to: "2026-09-21T01:00:00.000Z",
    },
  });
  write("workflow-state.json", {
    id: connection.workflowId,
    organizationRevision: 1,
    revision: 3,
  });
  write("workflow-organization.json", { revision: 1 });
  write("registry-state.json", {
    id: "prior",
    organizationRevision: 1,
    revision: 1,
  });
  fs.writeFileSync(file("rollout.jsonl"), "{}\n");
  return { connection, file };
}

function args(file) {
  return {
    user: file("user.json"),
    checkpoint: file("checkpoint.json"),
    launches: file("launches.jsonl"),
    connection: file("connection.json"),
    workflowState: file("workflow-state.json"),
    workflowOrganization: file("workflow-organization.json"),
    registryState: file("registry-state.json"),
    rollout: file("rollout.jsonl"),
    out: file("out.json"),
  };
}

test("mac usage hashes only a PM connection corroborated by saved evidence", (t) => {
  const { connection, file } = fixture(t);
  const output = buildEvidence(args(file));
  const hash = (value) =>
    crypto.createHash("sha256").update(value).digest("hex");

  assert.equal(output.manualConnection.scope.runHash, hash(connection.runId));
  assert.equal(
    output.manualConnection.scope.terminalHash,
    hash(connection.terminal),
  );
  assert.equal(
    output.manualConnection.scope.threadHash,
    hash(connection.threadId),
  );
  assert.ok(!JSON.stringify(output).includes(connection.runId));
  assert.ok(!JSON.stringify(output).includes(connection.terminal));
  assert.ok(!JSON.stringify(output).includes(connection.threadId));
});

test("mac usage rejects an uncorroborated PM connection before hashing it", (t) => {
  const { file } = fixture(t);
  const connection = JSON.parse(
    fs.readFileSync(file("connection.json"), "utf8"),
  );
  connection.threadId = "thread-not-in-checkpoint";
  fs.writeFileSync(file("connection.json"), `${JSON.stringify(connection)}\n`);

  assert.throws(
    () => buildEvidence(args(file)),
    /threadId가 Astra checkpoint 기록과 일치하지 않습니다/,
  );
});

test("mac usage requires the local PM connection input", () => {
  assert.throws(
    () => parseArgs(["--user", "user.json"]),
    /모든 입력 경로와 --out이 필요합니다/,
  );
});
