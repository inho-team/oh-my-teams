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

test("the closing skills run the gates instead of judging by eye", () => {
  const close = readSkill("team-close");
  const disband = readSkill("team-disband");

  // team-close carried no CLI command at all, so merge-check - the thing that
  // mechanically refuses a merge without PM acceptance - was left to the
  // model's reading of the situation.
  for (const command of ["verify", "merge-check", "workflow-status"]) {
    assert.ok(
      close.includes(`node <runtime> ${command}`),
      `team-close must run ${command}`,
    );
  }

  // A kickoff disbanded with a running attempt left the workflow in "running"
  // forever: recordSettlement requires "running" and releaseReservation
  // requires "reserved", and neither was ever called.
  for (const command of ["workflow-settle", "workflow-release"]) {
    assert.ok(
      disband.includes(`node <runtime> ${command}`),
      `team-disband must run ${command}`,
    );
  }
});

test("a worker whose exit is unconfirmed is fenced, not released", () => {
  const runtime = fs.readFileSync(
    path.join(root, "plugins/oh-my-teams/references/orca-runtime.md"),
    "utf8",
  );
  // worker-release is documented by the CLI as post-completion cleanup for a
  // settled worker; worker-abandon exists precisely for the unobserved case.
  assert.match(runtime, /worker-abandon/);
  for (const skill of ["team-close", "team-disband"]) {
    assert.match(
      readSkill(skill),
      /worker-abandon/,
      `${skill} must name the fence for an unconfirmed worker`,
    );
  }
});

test("the two meanings of blocked are kept apart", () => {
  // deriveWorkflowStatus returns "blocked" for a single failed task, which
  // workflow-retry can undo. A Goal is blocked only after a repeated, policy
  // level obstruction. Copying one into the other freezes recoverable work.
  // The distinction is stated once in the runtime reference; team-status
  // points at it and team-kickoff repeats only the part it must act on.
  const runtime = fs.readFileSync(
    path.join(root, "plugins/oh-my-teams/references/orca-runtime.md"),
    "utf8",
  );
  assert.match(runtime, /workflow-status`의 `blocked`/);
  assert.match(runtime, /되돌릴 수 있는 일시 상태/);

  assert.match(readSkill("team-status"), /orca-runtime\.md/);
  assert.match(
    readSkill("team-kickoff"),
    /그것만으로 Goal을 차단 처리하지 않는다/,
  );
});

test("every skill that queries worker-list pins the executable first", () => {
  // orca-runtime requires one executable to be chosen and never silently
  // swapped; team-status queried worker-list without referencing that rule and
  // could report another Run's state.
  for (const entry of fs.readdirSync(skills)) {
    const file = path.join(skills, entry, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("worker-list")) continue;
    assert.match(
      text,
      /orca-runtime\.md/,
      `${entry} queries worker-list without the discovery contract`,
    );
  }
});

test("one rule lives in one place", () => {
  const references = path.join(root, "plugins/oh-my-teams/references");
  const runtime = fs.readFileSync(
    path.join(references, "orca-runtime.md"),
    "utf8",
  );
  const assistRef = fs.readFileSync(path.join(references, "assist.md"), "utf8");

  // The liveness verdict and the assist contract are fixed facts. Each used to
  // be restated in four or five places, so a correction had to be applied in
  // every one of them or the copies disagreed.
  assert.match(runtime, /## worker-list와 liveness/);
  assert.match(assistRef, /gpt-oss-120b-medium/);

  const restatements = [
    [/`live` worker가 0명이면.*표현하지 않는다/, "the liveness verdict"],
    [/--role \w+ --kind research/, "the assist invocation"],
  ];
  for (const entry of fs.readdirSync(skills)) {
    const file = path.join(skills, entry, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const [pattern, what] of restatements) {
      assert.ok(
        !pattern.test(text),
        `${entry} restates ${what} instead of referencing it`,
      );
    }
  }
});

test("the assist reference states what the code enforces, not what we wish", () => {
  const assistRef = fs.readFileSync(
    path.join(root, "plugins/oh-my-teams/references/assist.md"),
    "utf8",
  );
  const worker = fs.readFileSync(
    path.join(root, "plugins/oh-my-teams/scripts/worker.mjs"),
    "utf8",
  );

  // worker.mjs accepts all three kinds from any role, so the per-role table is
  // a convention. Presenting it as an enforced rule would be a new mismatch of
  // exactly the kind this audit kept finding.
  assert.match(worker, /\["research", "checklist", "edit"\]\.includes\(kind\)/);
  assert.match(assistRef, /역할에 따라 `kind`를 제한하지 않는다/);

  for (const option of REQUIRED_OPTIONS.assist) {
    assert.ok(
      assistRef.includes(`--${option}`),
      `the reference must show the required --${option}`,
    );
  }
});

test("team-form points at one structural example, not three overlapping ones", () => {
  const form = readSkill("team-form");
  // The preset files restate the model assignments the paragraph above already
  // gives in prose, and presets.mjs is the source of truth for them, so reading
  // all three cost about 7KB to see one structure.
  const linked = [
    ...form.matchAll(/examples\/(organization[.\w-]*\.json)/g),
  ].map((match) => match[1]);
  assert.deepEqual([...new Set(linked)], ["organization.json"]);
});

test("init is described as the no-op it can be", () => {
  const form = readSkill("team-form");
  // init returns { created: false } and exits 0 when the file already exists,
  // so a run that changed nothing reads as a successful formation.
  assert.match(form, /`created`가 `true`인 경우에만/);
});

test("the six aliases carry one identical body", () => {
  const aliases = [
    "team-setup",
    "team-show",
    "team-edit",
    "org-setup",
    "org-show",
    "org-edit",
  ];
  // Two variants had drifted apart: half carried the no-duplication sentence
  // and half did not, which is how the bodies start to diverge.
  for (const alias of aliases) {
    const text = readSkill(alias);
    assert.match(
      text,
      /절차 본문은 그 스킬 한 곳에만 있으며 여기에 복제하지 않는다/,
    );
    assert.match(text, /이전 호출과의 호환 진입점이다/);
  }
});

test("the help flow shows the path, and says what is not on it", () => {
  const help = readSkill("team-help");
  // team-status only reads and team-adjust applies to later kickoffs, so
  // neither is a step; the diagram implied team-status was one and left
  // team-adjust out of a list that had introduced it as a lifecycle skill.
  const diagram = help.split("## 일반적인 흐름")[1];
  assert.ok(diagram, "the flow section must exist");
  assert.ok(!/team-form → team-kickoff → team-status/.test(diagram));
  assert.match(diagram, /`team-status`와 `team-adjust`는/);

  // "Print this verbatim" and "change the invocation prefix" contradicted each
  // other, because the tables carry bare skill names and no prefix at all.
  assert.match(help, /표는 스킬 이름만 담는다/);
});
