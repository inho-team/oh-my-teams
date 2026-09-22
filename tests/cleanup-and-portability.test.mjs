/** Covers the installer wrappers, engine floor, and the prepared-input check. */
import { after } from "node:test";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readJSON,
  run,
  writeJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  ALLOWED_OPTIONS,
  REQUIRED_OPTIONS,
  main,
} from "../plugins/oh-my-teams/scripts/teams-org.mjs";
import { prepareInput } from "../plugins/oh-my-teams/scripts/workspace.mjs";
import { getTemplateRepo, cleanupTemplates } from "./template-factory.mjs";

after(() => cleanupTemplates());

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const organization = readJSON(
  path.join(root, "plugins/oh-my-teams/examples/organization.json"),
);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-cleanup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const task = {
  schemaVersion: 2,
  revision: 3,
  kind: "edit",
  id: "prepared",
  goal: "Prepared input",
  instruction: "Make the change",
  nonGoals: [],
  constraints: [],
  files: ["value.txt"],
  checks: [[process.execPath, "-e", "process.exit(0)"]],
  acceptance: [
    { id: "check", description: "check", method: "check", checkIndexes: [0] },
  ],
  dependencies: [],
  contractRefs: [],
  contextRefs: [],
  openQuestions: [],
  reviewRequirements: [],
  environment: "test",
  baseRef: "HEAD",
  risk: "low",
};

async function repo(t) {
  const dir = fixture(t);
  fs.cpSync(await getTemplateRepo(), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "value.txt"), "wrong\n");
  assert.equal((await run(["git", "add", "value.txt"], { cwd: dir })).code, 0);
  assert.equal(
    (await run(["git", "commit", "-m", "seed"], { cwd: dir })).code,
    0,
  );
  return dir;
}

test("both installer wrappers forward every documented flag", () => {
  const shell = fs.readFileSync(path.join(root, "install.sh"), "utf8");
  const powershell = fs.readFileSync(path.join(root, "install.ps1"), "utf8");

  // install.sh forwarded only "${1:-both}" and install.ps1 accepted a single
  // validated host name, so --dry-run and --remove-legacy could not reach the
  // installer that documents them, and the two wrappers disagreed.
  assert.match(shell, /install\.mjs" "\$@"/);
  assert.match(powershell, /install\.mjs'\) @args/);
  for (const wrapper of [shell, powershell]) {
    assert.ok(
      !wrapper.includes("ValidateSet") && !wrapper.includes("${1:-both}"),
      "the wrapper must not re-declare the installer's own argument rules",
    );
  }
});

test("the engine floor covers the flags the test suite actually uses", () => {
  const engines = readJSON(path.join(root, "package.json")).engines.node;

  // routing-fixtures.mjs runs node --permission, which exists from 22.13. A
  // ">=22" floor let 22.0 through, where that test fails for the environment
  // rather than for the code.
  const [major, minor] = engines.replace(">=", "").split(".").map(Number);
  assert.ok(
    major > 22 || (major === 22 && minor >= 13),
    `engines ${engines} must not admit a Node without --permission`,
  );
  const fixtures = fs.readFileSync(
    path.join(root, "experiments/routing-fixtures.mjs"),
    "utf8",
  );
  assert.ok(
    fixtures.includes("--permission"),
    "this floor exists because the fixtures use --permission",
  );
});

test("a prepared input directory can be validated before it is attached", async (t) => {
  const dir = await repo(t);
  const output = path.join(fixture(t), "prepared");
  await prepareInput(organization, task, dir, output);

  const printed = [];
  const log = console.log;
  console.log = (line) => printed.push(line);
  try {
    await main(["prepare-verify", "--input", output]);
  } finally {
    console.log = log;
  }
  const result = JSON.parse(printed.join("\n"));
  assert.equal(result.valid, true);
  assert.equal(result.taskId, "prepared");
  assert.equal(result.taskRevision, 3);
  assert.equal(result.organizationRevision, organization.revision);

  // Nothing checked a prepared directory before attaching it, so a snapshot
  // that had drifted from its own contract travelled into the workspace.
  writeJSON(path.join(output, "task.json"), { ...task, risk: "reckless" });
  await assert.rejects(
    () => main(["prepare-verify", "--input", output]),
    /Task risk must be low, normal or high/,
  );

  fs.rmSync(path.join(output, "organization.json"));
  await assert.rejects(() => main(["prepare-verify", "--input", output]));
});

test("prepare-verify is declared in both option tables", () => {
  assert.deepEqual(ALLOWED_OPTIONS["prepare-verify"], ["input"]);
  assert.deepEqual(REQUIRED_OPTIONS["prepare-verify"], ["input"]);
});
