/** Checks that what the skills tell a model to do actually works. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readJSON,
  resolveRole,
  validateOrg,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import { assist } from "../plugins/oh-my-teams/scripts/worker.mjs";
import { REQUIRED_OPTIONS } from "../plugins/oh-my-teams/scripts/teams-org.mjs";
import {
  TIER_ROLES,
  parseModelChoice,
} from "../plugins/oh-my-teams/scripts/org-draft.mjs";
import { removedSkillNames } from "./removed-skills.mjs";

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
    // built from them. A reduced organization need not declare all five, and
    // there the assist runs as the role that took the absent one's duties over.
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
      assert.equal(
        report.callerRole,
        resolveRole(org, role),
        `${name} must allow ${role}`,
      );
    }
  }
});

test("form says the assistant allowlist starts empty, and what that refuses", () => {
  const form = readSkill("form");
  // form no longer asks for `assistants`, and worker.mjs refuses an assist call
  // for a role that is absent from it, so an unmentioned empty list would read
  // as a broken assist rather than a default adjust can change.
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
  // Every skill that prints a command is checked, not only pl: a lifecycle
  // skill whose example omits a required option fails at the moment a user is
  // starting or ending a kickoff.
  for (const entry of fs.readdirSync(skills)) {
    const file = path.join(skills, entry, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const [, command, rest] of text.matchAll(
      /node <runtime> ([a-z-]+)([^\n`]*)/g,
    )) {
      const required = REQUIRED_OPTIONS[command];
      assert.ok(required, `${entry} names an unknown command: ${command}`);
      for (const option of required) {
        assert.ok(
          rest.includes(`--${option}`),
          `${entry}'s ${command} example omits required --${option}`,
        );
      }
    }
  }

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

test("no runtime message sends the reader to a name 2.0.0 removed", () => {
  const removed = removedSkillNames();
  const scripts = path.join(root, "plugins/oh-my-teams/scripts");

  // The earlier guard only walked skills/, so two runtime error messages kept
  // telling the user to run a name that was by then only a thin alias. Those
  // aliases are gone now, so the same message would name nothing at all.
  for (const entry of fs.readdirSync(scripts)) {
    if (!entry.endsWith(".mjs")) continue;
    const text = fs.readFileSync(path.join(scripts, entry), "utf8");
    for (const name of removed) {
      assert.ok(
        !text.includes(`run ${name}`) && !text.includes(`with ${name}`),
        `${entry} names the removed ${name}`,
      );
    }
  }
});

test("the preset preview is described as changing what it actually changes", () => {
  const adjust = readSkill("adjust");
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
  // "status", "close", "kickoff", "disband" and "help" are read 어저스트,
  // 스테이터스, 클로즈, 킥오프, 디스밴드 and 헬프, all ending in a vowel, so
  // they take 를. Dropping the team- prefix did not change any of these,
  // because the particle was already following the last syllable.
  const wrong = [
    "form를",
    "adjust을",
    "status을",
    "close을",
    "kickoff을",
    "disband을",
    "help을",
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
  const close = readSkill("close");
  const disband = readSkill("disband");

  // close carried no CLI command at all, so merge-check - the thing that
  // mechanically refuses a merge without PM acceptance - was left to the
  // model's reading of the situation.
  for (const command of ["verify", "merge-check", "workflow-status"]) {
    assert.ok(
      close.includes(`node <runtime> ${command}`),
      `close must run ${command}`,
    );
  }

  // A kickoff disbanded with a running attempt left the workflow in "running"
  // forever: recordSettlement requires "running" and releaseReservation
  // requires "reserved", and neither was ever called.
  for (const command of ["workflow-settle", "workflow-release"]) {
    assert.ok(
      disband.includes(`node <runtime> ${command}`),
      `disband must run ${command}`,
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
  for (const skill of ["close", "disband"]) {
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
  // The distinction is stated once in the runtime reference; status
  // points at it and kickoff repeats only the part it must act on.
  const runtime = fs.readFileSync(
    path.join(root, "plugins/oh-my-teams/references/orca-runtime.md"),
    "utf8",
  );
  assert.match(runtime, /workflow-status`의 `blocked`/);
  assert.match(runtime, /되돌릴 수 있는 일시 상태/);

  assert.match(readSkill("status"), /orca-runtime\.md/);
  assert.match(readSkill("kickoff"), /그것만으로 Goal을 차단 처리하지 않는다/);
});

test("every skill that queries worker-list pins the executable first", () => {
  // orca-runtime requires one executable to be chosen and never silently
  // swapped; status queried worker-list without referencing that rule and
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
    [/"coordinator": \{/, "the kickoff lease record"],
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

test("form points at one structural example, not three overlapping ones", () => {
  const form = readSkill("form");
  // The preset files restate the model assignments the paragraph above already
  // gives in prose, and presets.mjs is the source of truth for them, so reading
  // all three cost about 7KB to see one structure. The single-subscription
  // example is not one of those: it is the only example of a reduced role
  // ladder, which no prose in form conveys as precisely as the file does.
  const linked = [
    ...form.matchAll(/examples\/(organization[.\w-]*\.json)/g),
  ].map((match) => match[1]);
  assert.deepEqual([...new Set(linked)].sort(), [
    "organization.json",
    "organization.single-subscription.json",
  ]);
});

test("init is described as the no-op it can be", () => {
  const form = readSkill("form");
  // init returns { created: false } and exits 0 when the file already exists,
  // so a run that changed nothing reads as a successful formation.
  assert.match(form, /`created`가 `true`인 경우에만/);
});

test("every skill that asks the user a question points at one contract", () => {
  // form asked its questions in prose that named no tool, so each host
  // improvised: Claude Code has AskUserQuestion and Codex has nothing
  // equivalent, and a skill that hard-codes either name is wrong on the other.
  for (const skill of ["form", "adjust", "kickoff", "close"]) {
    assert.match(
      readSkill(skill),
      /references\/user-choice\.md/,
      `${skill} takes a decision from the user and must follow the contract`,
    );
  }
});

test("the user-choice contract picks a method by capability, not by host", () => {
  const contract = fs.readFileSync(
    path.join(root, "plugins/oh-my-teams/references/user-choice.md"),
    "utf8",
  );
  // Naming AskUserQuestion as the method rather than as one host's
  // implementation is what would break Codex, where `codex features list`
  // reports default_mode_request_user_input as under development and off.
  assert.match(contract, /구조화된 선택 도구를 실제로 사용할 수 있는지/);
  assert.match(contract, /번호를 매긴 선택지/);
  assert.match(contract, /AskUserQuestion/);
  assert.match(contract, /Codex CLI에는 \*\*이 용도로 확인된 도구가 없다/);

  // A default silently standing in for an answer is the failure this contract
  // exists to prevent: the organization file would record a subscription the
  // user never chose.
  assert.match(contract, /권장값을 답으로 삼지 않는다/);
});

test("the help flow shows the path, and says what is not on it", () => {
  const help = readSkill("help");
  // status only reads and adjust applies to later kickoffs, so
  // neither is a step; the diagram implied status was one and left
  // adjust out of a list that had introduced it as a lifecycle skill.
  const diagram = help.split("## 일반적인 흐름")[1];
  assert.ok(diagram, "the flow section must exist");
  assert.ok(!/form → kickoff → status/.test(diagram));
  assert.match(diagram, /`status`와 `adjust`는/);

  // "Print this verbatim" and "change the invocation prefix" contradicted each
  // other, because the tables carry bare skill names and no prefix at all.
  assert.match(help, /표는 스킬 이름만 담는다/);
});

test("one project holds one kickoff, and every lifecycle skill reads the lease", () => {
  const lease = fs.readFileSync(
    path.join(root, "plugins/oh-my-teams/references/kickoff-lease.md"),
    "utf8",
  );
  // workflow.mjs counts concurrency slots and the call budget inside a single
  // workflow state, so two kickoffs sharing one organization file spend the
  // same subscription twice while neither can see the other's slots. Nothing
  // in teams-org.mjs refuses that, which is why the lease has to be read by
  // every skill that starts, inspects or ends a kickoff.
  assert.match(lease, /런타임이 거부로 강제한다/);
  assert.match(lease, /active-kickoff\.json/);

  for (const skill of ["form", "kickoff", "status", "close", "disband"]) {
    assert.match(
      readSkill(skill),
      /references\/kickoff-lease\.md/,
      `${skill} touches the single active kickoff and must read the contract`,
    );
  }
});

test("the Goal belongs to the session that can bind the Run", () => {
  const kickoff = readSkill("kickoff");
  const lease = fs.readFileSync(
    path.join(root, "plugins/oh-my-teams/references/kickoff-lease.md"),
    "utf8",
  );
  // worker-start is fenced to the terminal that created the Run, so a session
  // that hands the work to a child worktree and keeps the Goal would own a
  // Goal it can never dispatch for. The declaring session hands over a brief;
  // the coordinator creates the Goal and binds the Run in the same terminal.
  assert.match(kickoff, /coordinator 세션이 브리프를 읽고 하나 만들며/);
  assert.match(kickoff, /worker-start`가 Run에 바인딩된 coordinator 터미널/);
  assert.match(lease, /Goal의 유일한 소유자는 B다/);
});

test("closing runs where the coordinator worktree can actually be reclaimed", () => {
  // A worktree cannot remove itself, so close and disband belong to the
  // declaring session rather than the coordinator that did the work.
  for (const skill of ["close", "disband"]) {
    assert.match(
      readSkill(skill),
      /선언한 세션에서 수행한다/,
      `${skill} must not run inside the worktree it reclaims`,
    );
  }
});

test("the lease is released by an ending, never by a reading", () => {
  const close = readSkill("close");
  const disband = readSkill("disband");
  const status = readSkill("status");
  // A lease left behind blocks every later kickoff on the project, and a lease
  // cleared on an unverifiable coordinator would abandon a run that may still
  // be alive. Both endings delete it; the read-only skill never does.
  assert.match(close, /kickoff-release .*--reason completed/);
  assert.match(disband, /kickoff-release .*--reason disbanded/);
  assert.match(status, /점유 기록을 지우거나 고쳐 쓰지 않는다/);
});

test("form asks for the ladder and its models, and nothing else", () => {
  const form = readSkill("form");
  // Formation used to ask for the name, parents, slots, subscriptions,
  // fallbacks, exhaustion policy, call limit and assistant allowlist before a
  // team existed. Everything but the ladder and its models now has a default
  // that org-draft records and adjust changes.
  assert.match(form, /질문은 두 번으로 끝난다/);
  assert.match(form, /node <runtime> org-draft/);
  assert.match(form, /묻지 않고 정하는 것/);
});

test("the ladder form describes is the ladder org-draft builds", () => {
  const form = readSkill("form");
  const names = {
    PM: "pm",
    PL: "pl",
    Senior: "senior",
    Junior: "junior",
    Intern: "intern",
  };
  // The table is prose a model reads to explain the choice; the mapping in
  // org-draft.mjs is what gets saved. A mismatch would tell the user one team
  // and store another.
  const rows = new Map(
    [...form.matchAll(/^\| (\d)단계[^|]* \| ([^|]+) \|$/gm)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  for (const [tiers, roles] of Object.entries(TIER_ROLES)) {
    const row = rows.get(tiers);
    assert.ok(row, `form must describe the ${tiers}-tier ladder`);
    const described = row.split(" → ").map((name) => names[name.trim()]);
    assert.deepEqual(described, roles, `${tiers}-tier ladder drifted`);
  }
});

test("every model form offers is a choice org-draft accepts, Gemini included", () => {
  const table = readSkill("form")
    .split("| 단계 | 선택지 |")[1]
    ?.split("\n\n")[0];
  assert.ok(table, "form must keep its model option table");
  const offered = [...table.matchAll(/`([a-z]+:[a-z0-9.-]+)`/g)].map(
    (match) => match[1],
  );
  // Gemini 3.1 Pro and 3.8 Flash were listed as confirmed choices yet never
  // offered, because the only proposals were presets that assign Opus, Sonnet
  // and GPT-OSS.
  assert.ok(offered.includes("agy:gemini-3.1-pro-high"));
  assert.ok(offered.includes("agy:gemini-3.8-flash-high"));
  for (const choice of offered) {
    assert.doesNotThrow(() => parseModelChoice(choice), choice);
  }
});

test("effort is set in adjust, which carries the ranges form no longer does", () => {
  // form records no effort, so the per-executor ranges belong where a value is
  // first chosen. Keeping them in both would be two copies of one fact.
  assert.doesNotMatch(readSkill("form"), /model_reasoning_effort/);
  assert.match(readSkill("adjust"), /model_reasoning_effort/);
  assert.match(readSkill("adjust"), /contextTokens/);

  const contract = fs.readFileSync(
    path.join(root, "plugins/oh-my-teams/references/user-choice.md"),
    "utf8",
  );
  // A default saved without asking is only acceptable when it spends no more
  // than what the user chose and the user is told where to change it.
  assert.match(contract, /묻지 않고 정한다고 명시한/);
});
