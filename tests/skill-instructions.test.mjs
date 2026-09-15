/** Checks that what the skills tell a model to do actually works. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJSON, validateOrg } from "../plugins/oh-my-teams/scripts/core.mjs";
import { assist } from "../plugins/oh-my-teams/scripts/worker.mjs";
import { REQUIRED_OPTIONS } from "../plugins/oh-my-teams/scripts/teams-org.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examples = path.join(root, "plugins/oh-my-teams/examples");
const skills = path.join(root, "plugins/oh-my-teams/skills");

const readSkill = (name) =>
  fs.readFileSync(path.join(skills, name, "SKILL.md"), "utf8");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-skill-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("every example organization can run the assist the skills advertise", async (t) => {
  const organizations = fs
    .readdirSync(examples)
    .filter((name) => name.startsWith("organization"));
  assert.ok(organizations.length >= 3, "the preset examples must be covered");

  for (const name of organizations) {
    const org = validateOrg(readJSON(path.join(examples, name)));
    const dir = fixture(t);
    fs.writeFileSync(path.join(dir, "value.txt"), "alpha\n");
    const task = {
      ...readJSON(path.join(examples, "task.v2.json")),
      files: ["value.txt"],
      checks: [[process.execPath, "-e", "process.exit(0)"]],
    };

    // pm, pl, senior, junior and intern all tell the model it may call assist.
    // The preset examples carried no `assistants` block, so every one of those
    // roles failed with "Assistant profile not allowed" on an organization
    // built from them.
    for (const role of ["pm", "pl", "senior", "junior", "intern"]) {
      const report = await assist(dir, org, task, {
        role,
        kind: "research",
        stateDir: path.join(dir, ".omt", role),
        call: async () => ({
          code: 0,
          stdout: "{}",
          stderr: "",
          elapsedMs: 1,
          text: JSON.stringify({
            summary: "found it",
            items: ["alpha is present"],
            citations: [{ file: "value.txt", line: 1, quote: "alpha" }],
          }),
        }),
      });
      assert.equal(report.callerRole, role, `${name} must allow ${role}`);
    }
  }
});

test("team-form asks for the assistant allowlist it cannot infer", () => {
  const form = readSkill("team-form");
  // Nothing else establishes `assistants`, and worker.mjs refuses an assist
  // call for a role that is absent from it.
  assert.match(form, /assistants/);
  assert.match(form, /보조 도구 호출을 허용할지/);
});

test("a multi-task workflow is told about the integration it cannot add later", () => {
  const pm = readSkill("pm");
  // workflow.mjs makes integration required as soon as a second task exists,
  // and workflow-accept then refuses without a frozen integration task that
  // createWorkflow is the only thing able to write.
  assert.match(pm, /integrationTask/);
  assert.match(pm, /생성 뒤에는 추가할 수 없어/);
});

test("the commands written in the skills carry the options the CLI requires", () => {
  const commands = [
    ...readSkill("pl").matchAll(/node <runtime> ([a-z-]+)([^\n`]*)/g),
  ];
  assert.ok(commands.length > 0, "pl must keep its command examples");

  for (const [, command, rest] of commands) {
    const required = REQUIRED_OPTIONS[command];
    assert.ok(required, `pl names an unknown command: ${command}`);
    for (const option of required) {
      assert.ok(
        rest.includes(`--${option}`),
        `pl's ${command} example omits required --${option}`,
      );
    }
  }

  // merge-check additionally requires --report and --state for task v2, which
  // is the only shape the surrounding text describes.
  const mergeCheck = commands.find(([, command]) => command === "merge-check");
  assert.ok(mergeCheck, "pl must keep the merge-check example");
  for (const option of ["report", "state"]) {
    assert.ok(
      mergeCheck[2].includes(`--${option}`),
      `task v2 merge-check needs --${option}`,
    );
  }
});

test("no skill or runtime message sends the reader to a retired skill name", () => {
  const retired = ["team-setup", "team-show", "team-edit"];
  const scripts = path.join(root, "plugins/oh-my-teams/scripts");

  // The earlier guard only walked skills/, so two runtime error messages kept
  // telling the user to run a name that is now only a thin alias.
  for (const entry of fs.readdirSync(scripts)) {
    if (!entry.endsWith(".mjs")) continue;
    const text = fs.readFileSync(path.join(scripts, entry), "utf8");
    for (const name of retired) {
      assert.ok(
        !text.includes(`run ${name}`) && !text.includes(`with ${name}`),
        `${entry} names the retired ${name}`,
      );
    }
  }
});

test("the preset preview is described as changing what it actually changes", () => {
  const adjust = readSkill("team-adjust");
  // presets.mjs pins concurrency to 1, so an organization with more workers is
  // silently reduced. The skill used to promise a profile-only preview.
  assert.match(adjust, /동시 인원/);
  assert.ok(
    !/변경되는 역할 프로필만 미리 본다/.test(adjust),
    "the preview must not be described as profile-only",
  );
});

test("Korean object particles follow the sound of the skill name", () => {
  // The particle follows how the name is read aloud, not its spelling. "form"
  // is read 폼 and ends in a final consonant, so it takes 을; "adjust",
  // "status", "close" and "kickoff" are read 어저스트, 스테이터스, 클로즈 and
  // 킥오프, all ending in a vowel, so they take 를. These lines are generated
  // from a template, so the wrong pair is easy to reintroduce.
  const wrong = [
    "team-form를",
    "team-adjust을",
    "team-status을",
    "team-close을",
  ];
  for (const entry of fs.readdirSync(skills)) {
    const file = path.join(skills, entry, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const bad of wrong) {
      assert.ok(!text.includes(bad), `${entry} writes "${bad}"`);
    }
  }
});
