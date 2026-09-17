/** Checks that what the skills tell a model to do actually works. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEPTH_ROLES,
  readJSON,
  resolveRole,
  validateOrg,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import { assist } from "../plugins/oh-my-teams/scripts/worker.mjs";
import { REQUIRED_OPTIONS } from "../plugins/oh-my-teams/scripts/teams-org.mjs";
import { parseModelChoice } from "../plugins/oh-my-teams/scripts/org-draft.mjs";
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
    [/"pm": \{/, "the kickoff registry entry"],
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

test("kickoffs run in parallel, and every lifecycle skill reads the registry", () => {
  const registry = fs.readFileSync(
    path.join(root, "plugins/oh-my-teams/references/kickoff-registry.md"),
    "utf8",
  );
  // Worktrees keep parallel kickoffs from touching the same files, but not
  // from drawing on the same subscription: slots and the call budget are
  // counted inside each workflow state. Allowing parallel kickoffs is a choice,
  // so the cost has to be stated where the choice is made.
  assert.match(registry, /kickoff를 몇 개든 동시에 진행할 수 있다/);
  assert.match(registry, /## 병렬 kickoff의 비용/);
  assert.doesNotMatch(registry, /활성 kickoff는 하나/);

  for (const skill of ["form", "kickoff", "status", "close", "disband"]) {
    assert.match(
      readSkill(skill),
      /references\/kickoff-registry\.md/,
      `${skill} starts, shows or ends a kickoff and must read the contract`,
    );
  }
  assert.match(
    readSkill("kickoff"),
    /할당량을 함께 소모한다는 점을 사용자에게 알린다/,
  );
});

test("the Goal belongs to the session that can bind the Run", () => {
  const kickoff = readSkill("kickoff");
  const registry = fs.readFileSync(
    path.join(root, "plugins/oh-my-teams/references/kickoff-registry.md"),
    "utf8",
  );
  // worker-start is fenced to the terminal that created the Run, so a session
  // that hands the work to a child worktree and keeps the Goal would own a
  // Goal it can never dispatch for. The declaring session hands over a brief;
  // the PM creates the Goal and binds the Run in the same terminal.
  assert.match(kickoff, /PM 세션이 브리프를 읽고 하나 만들며/);
  assert.match(kickoff, /worker-start`가 Run에 바인딩된 coordinator 터미널/);
  assert.match(registry, /Goal의 유일한 소유자는 B다/);
});

test("closing runs where the PM worktree can actually be reclaimed", () => {
  // A worktree cannot remove itself, so close and disband belong to the
  // declaring session rather than the PM that did the work.
  for (const skill of ["close", "disband"]) {
    assert.match(
      readSkill(skill),
      /선언한 세션에서 수행한다/,
      `${skill} must not run inside the worktree it reclaims`,
    );
  }
});

test("a kickoff is released by its ending, never by a reading", () => {
  const close = readSkill("close");
  const disband = readSkill("disband");
  const status = readSkill("status");
  // An entry left behind shows a finished kickoff as running and blocks its
  // worktree, and an entry cleared on an unverifiable PM would abandon
  // a run that may still be alive. Both endings release the one kickoff they
  // end; the read-only skill never touches an entry.
  assert.match(close, /kickoff-release .*--reason completed/);
  assert.match(disband, /kickoff-release .*--reason disbanded/);
  for (const skill of [close, disband]) {
    assert.match(skill, /kickoff-show --worktree <pm-worktree-id>/);
    assert.match(skill, /사용자가 지목한 것만/);
  }
  assert.match(status, /등록 항목을 지우거나 고쳐 쓰지 않는다/);
});

test("form asks for the five role models, and not for a ladder size", () => {
  const form = readSkill("form");
  // Formation used to ask for the name, parents, slots, subscriptions,
  // fallbacks, exhaustion policy, call limit and assistant allowlist before a
  // team existed, and then for a ladder size. Every organization now declares
  // all five roles; how many a run uses is the PM's depth decision per kickoff.
  assert.match(form, /질문은 두 번으로 끝난다/);
  assert.match(form, /몇 단계로 운영할지는 묻지 않는다/);
  assert.match(form, /묻지 않고 정하는 것/);
  const draft = /node <runtime> org-draft([^\n`]*)/.exec(form);
  assert.ok(draft, "form must draft the organization");
  assert.doesNotMatch(draft[1], /--tiers/);
});

test("the depth table the PM reads is the depth the runtime applies", () => {
  const pm = readSkill("pm");
  const names = {
    PM: "pm",
    PL: "pl",
    Senior: "senior",
    Junior: "junior",
    Intern: "intern",
  };
  // The table is what the PM reasons from when it picks a depth; DEPTH_ROLES is
  // what workflow creation and workflow-depth record. A mismatch would have the
  // PM choose one team and the runtime run another.
  const rows = new Map(
    [...pm.matchAll(/^\| (\d) \| ([^|]+) \| [^|]+ \|$/gm)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  for (const [depth, roles] of Object.entries(DEPTH_ROLES)) {
    const row = rows.get(depth);
    assert.ok(row, `pm must describe depth ${depth}`);
    const described = row.split(" → ").map((name) => names[name.trim()]);
    assert.deepEqual(described, [...roles], `depth ${depth} drifted`);
  }
});

test("the depth is decided by the PM, reported, and changed through the runtime", () => {
  const pm = readSkill("pm");
  // The user chose not to be asked for a depth, so the PM must at least say
  // which one it picked and why; a change made only in prose would leave the
  // runtime dispatching to the roles of the old depth.
  assert.match(pm, /깊이는 사용자에게 묻지 않고 PM이 정하되/);
  assert.match(pm, /node <runtime> workflow-depth/);
  assert.match(
    pm,
    /내리기는 빠지는 역할에 예약되었거나 실행 중인 작업이 없을 때만/,
  );
  for (const skill of ["kickoff", "form", "adjust"]) {
    assert.match(
      readSkill(skill),
      /「실행 깊이」/,
      `${skill} must point at the one place the depth rules live`,
    );
  }
});

test("every model form offers is a choice org-draft accepts, Gemini included", () => {
  const table = readSkill("form")
    .split("| 역할 | 선택지 |")[1]
    ?.split("\n\n")[0];
  assert.ok(table, "form must keep its model option table");
  const offered = [...table.matchAll(/`([a-z]+:[a-z0-9.-]+)`/g)].map(
    (match) => match[1],
  );
  // Gemini 3.1 Pro and 3.8 Flash were listed as confirmed choices yet never
  // offered, because the only proposals were presets that assign Opus, Sonnet
  // and GPT-OSS.
  assert.ok(offered.includes("agy:gemini-3.1-pro-high"));
  assert.ok(offered.includes("agy:gemini-3.8-flash-medium"));
  // Agy has no level-free Gemini ID and refuses one without --effort, so a
  // Gemini choice always fixes a depth the user did not pick. Flash has a
  // middle level; Pro 3.1 offers only high and low.
  assert.ok(!offered.includes("agy:gemini-3.8-flash-high"));
  const form = readSkill("form");
  assert.match(form, /requires --effort/);
  assert.match(form, /결성 보고에 반드시 적고/);
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

const readReference = (name) =>
  fs.readFileSync(
    path.join(root, "plugins/oh-my-teams/references", name),
    "utf8",
  );

test("roles are launched from their profile, never by hand-typed agent flags", () => {
  // A PL bound to a Codex model ran on the account default because the
  // PM typed `orca orchestration worker-start --agent codex` without
  // --model, and the PM was opened by `worktree create --agent`,
  // which has no model option at all.
  const runtime = readReference("orca-runtime.md");
  for (const text of [readSkill("pm"), readSkill("pl"), runtime]) {
    assert.match(text, /worker-start --org <\S+ --role/);
    // Every launch example names the workflow, so roles fold to the run's
    // depth and the organization comes from the snapshot the workflow froze.
    for (const [line] of text.matchAll(
      /node <runtime> (?:worker-start|role-spec) [^\n`]*/g,
    )) {
      assert.match(line, /--workflow-id <\S+> --state <\S+>/, line);
    }
    // A worker started by agent id got no permission bypass flag, so every
    // launch example hands over a terminal role-terminal opened.
    for (const [line] of text.matchAll(
      /node <runtime> worker-start [^\n`]*/g,
    )) {
      assert.match(line, /--terminal <\S+>/, line);
      assert.doesNotMatch(line, /new-child/, line);
    }
  }
  for (const entry of fs.readdirSync(skills)) {
    const file = path.join(skills, entry, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    assert.doesNotMatch(
      fs.readFileSync(file, "utf8"),
      /orchestration worker-start --(task|spec)/,
      `${entry} shows a raw worker-start launch`,
    );
  }
  assert.doesNotMatch(
    runtime,
    /npm run org -- worker-start --repo <경로> --task <id> --agent/,
  );
  for (const verdict of ["matched", "mismatched", "unproven", "unrequested"]) {
    assert.ok(runtime.includes(`\`${verdict}\``), `modelProof ${verdict}`);
  }
  assert.match(runtime, /## PM 실행/);
  // A hand-typed `terminal create --command` left the command unsubmitted at
  // the prompt, so role terminals open through role-terminal, which reads the
  // screen and submits the command once.
  assert.match(runtime, /node <runtime> role-terminal --org/);
  assert.match(runtime, /결과의 `screen`/);
  assert.match(runtime, /`antigravity`/);
  // Agy roles had no sanctioned launch, and Claude and Codex roles started by
  // agent id stopped at their first approval prompt; every role now starts
  // from a terminal opened with its model and bypass flag.
  assert.match(runtime, /### 역할 터미널에서 시작/);
  assert.match(runtime, /\| Claude·Codex·Agy \|/);
  assert.match(
    runtime,
    /\| Agy\(Windows, `gemini` 모델\) \|[^\n]*`headless-start`로 실행한다/,
  );
  assert.match(runtime, /`agentDefaultArgs`/);
  // Orca pre-trusts a Codex folder only when it launches Codex itself, so the
  // terminal path can stop at Codex's trust screen until a person answers.
  assert.match(runtime, /Orca가 Codex 작업 폴더를 미리 신뢰해 두지 않는다/);
  assert.match(
    runtime,
    /`agent-trust-workspace`로 거부하므로 kickoff는 사람이 답할 때까지 멈춘다/,
  );
  assert.doesNotMatch(runtime, /명령이 agent 이름 하나뿐일 때만 붙이므로/);
  assert.match(runtime, /`satisfied: false`와 `blockedReason`/);
  assert.match(
    runtime,
    /Claude·Codex 역할에 이 옵션을 붙이면 Orca를 호출하기 전에 거부한다/,
  );
  assert.match(runtime, /--terminal <handle> --worktree id:<worktreeId>/);
  // The terminal and the hand-over must read the same run, or an Agy terminal
  // built for one role is accepted as the role the run folded it onto.
  assert.match(
    runtime,
    /node <runtime> role-terminal --org <organization\.json> --role <역할> --worktree id:<worktreeId> --workflow-id <workflowId> --state <pm-state>/,
  );
  assert.doesNotMatch(readSkill("pl"), /custom argv/);
  assert.match(runtime, /감독 worker로 띄울 수 없고[^\n]*`work` 하네스/);
  assert.match(runtime, /대괄호/);
  for (const role of ["pm", "pl"]) {
    assert.match(
      readSkill(role),
      /Claude·Codex·Agy 역할은 모두 `role-terminal`로 모델·강도·권한 우회 플래그를 담아 연 터미널/,
    );
    assert.doesNotMatch(readSkill(role), /래퍼가 새 터미널을 띄우/);
    // #46: on Windows Orca never reports a Gemini Agy terminal idle, so that
    // one role runs headless instead of through the terminal path.
    assert.match(
      readSkill(role),
      /Windows에서 모델이 `gemini`로 시작하는 Agy 역할은 Orca 터미널로 시작하지 않고 `headless-start`로 실행/,
    );
    // The example checks the terminal, then reserves, then hands it over.
    assert.match(
      readSkill(role),
      /terminal-idle-check --terminal <\S+>\nnode <runtime> workflow-reserve [^\n]*\nnode <runtime> worker-start /,
    );
    // An Agy terminal never reports tui-idle, and the inject workaround
    // escapes worker-stop and model checks.
    assert.match(readSkill(role), /원시 `dispatch --inject`로 우회하지 않고/);
    // #41: a released reservation keeps its attempt spent, so the idle check
    // runs before the attempt is reserved.
    assert.match(readSkill(role), /예약하기 전에 `terminal-idle-check`/);
  }
  assert.match(
    runtime,
    /호출하기 전에 같은 터미널에 `terminal wait --for tui-idle`/,
  );
  assert.match(runtime, /멈춘 뒤 거부 원문과 함께 사용자에게 보고한다/);
  // Orca refuses nested workers by default, so PL cannot be the dispatcher.
  assert.match(readSkill("pm"), /NESTED_WORKER_MAX_DEPTH` 기본값 1/);
  assert.match(readSkill("pl"), /기본값이 1/);
  assert.match(readSkill("senior"), /- Junior가 이번 실행에 있으면 기능 구현/);
  assert.match(readSkill("kickoff"), /`PM 실행` 절/);
  // A session that could not start the PM went on as PM itself.
  assert.match(readSkill("kickoff"), /선언 세션은 PM을 대신 맡지 않는다/);
  assert.match(readReference("kickoff-registry.md"), /인계에 실패한 것이다/);
  assert.match(
    readReference("kickoff-registry.md"),
    /worktree create --agent`를 쓰지 않고/,
  );
});

test("form says what a default model runs today and reads Codex models at ask time", () => {
  const form = readSkill("form");
  // "Codex 기본" was chosen as if it named one model, and the only Codex IDs
  // form knew were a catalog that had already changed.
  assert.match(form, /node <runtime> host-defaults/);
  assert.match(form, /codex debug models/);
  assert.match(form, /`codex:<id>`/);
  assert.match(form, /지금은 gpt-6-astra가 실행됩니다/);
  assert.match(form, /현재 해석값/);
  for (const stale of ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"]) {
    assert.ok(!form.includes(stale), `form hardcodes ${stale}`);
  }
  assert.match(form, /질문 수와 선택지 수는 늘지 않고/);
  assert.match(form, /서열을 매기지 않는다/);
});

test("planning roles hand the deliverable down instead of writing it", () => {
  const pm = readSkill("pm");
  const pl = readSkill("pl");
  const senior = readSkill("senior");
  // PM told PL to "write research reports", and PL wrote them itself: the old
  // wording let PL take exploration and implementation as its own work.
  assert.doesNotMatch(
    pm,
    /상세 저장소 분석과 대안 조사는 PL에게 맡길 수 있지만/,
  );
  assert.doesNotMatch(pm, /PL의 감독 실행 경로를 쓴다/);
  assert.match(pm, /PL에게는 분할·의존성·작업 파동·통합과 검증만 맡기고/);
  assert.match(pm, /나눌 필요가 없는 일은 PL을 거치지 않고/);
  assert.match(pl, /최종 산출물을 직접 작성하거나 커밋하지 않는다/);
  assert.match(pl, /nested_worker_depth_exceeded/);
  assert.match(pl, /작업을 스스로 수행하지 않는다/);
  assert.match(pl, /<orca> orchestration run-create/);
  assert.match(senior, /기능 구현이나 파일 편집을 직접 하지 않는다/);
});

test("every role charter names only commands that exist", () => {
  const orcaVerbs = new Set([
    "run-create",
    "task-create",
    "worker-list",
    "worker-show",
    "worker-read",
    "worker-stop",
    "worker-abandon",
    "worker-release",
  ]);
  for (const role of ["pm", "pl", "senior", "junior", "intern"]) {
    const text = readSkill(role);
    const charter = text.split("## 권한·책임·한계")[1]?.split(/\n## /)[0];
    assert.ok(charter, `${role} lacks the charter section`);
    for (const part of ["### 권한", "### 책임", "### 한계"]) {
      assert.ok(charter.includes(part), `${role} charter lacks ${part}`);
    }
    // The fold rule is what lets a reduced team act without a missing role.
    assert.match(charter, /resolveRole/, `${role} charter omits folding`);
    const authority = charter.split("### 책임")[0];
    for (const [, token] of authority.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)) {
      assert.ok(
        Object.hasOwn(REQUIRED_OPTIONS, token) || orcaVerbs.has(token),
        `${role} charter names an unknown command: ${token}`,
      );
    }
  }
  for (const role of ["senior", "junior", "intern"]) {
    assert.match(readSkill(role), /`worker-start`를 호출하지 않/);
  }
});

test("a silent worker is asked, then escalated, and never shown as progressing", () => {
  const runtime = readReference("orca-runtime.md");
  assert.match(runtime, /## 무응답 worker 감독/);
  assert.match(runtime, /node <runtime> supervision-next --org/);
  assert.match(
    runtime,
    /orchestration send --to dispatch:<id> --type question/,
  );
  assert.match(runtime, /worker-read --dispatch <id> --source auto/);
  assert.match(runtime, /`무응답 N분`/);
  assert.match(runtime, /재시도나 종료를 결정하지 않는다/);
  for (const role of ["pm", "pl"]) {
    assert.match(readSkill(role), /무응답 worker 감독/);
  }
  for (const role of ["pl", "senior", "junior", "intern"]) {
    assert.match(readSkill(role), /진행 요청에는/);
    assert.match(readSkill(role), /heartbeat/);
  }
  assert.match(readSkill("form"), /progressCheckMs: 900000/);
  assert.match(readSkill("adjust"), /policy\.supervision/);
});

test("reports lead with a verdict and instructions lead with the goal", () => {
  const bluf = readReference("bluf.md");
  for (const verdict of ["완료", "부분 완료", "실패", "차단"]) {
    assert.ok(bluf.includes(`| \`${verdict}\` |`), `bluf.md lacks ${verdict}`);
  }
  // The first line must not become a success claim ahead of evidence.
  assert.match(bluf, /검증 전에 성공을 선언하는 문장이 되어서는 안 된다/);
  assert.match(bluf, /결론을 마지막에 다시 요약하지 않는다/);
  // Structured outputs and the headless last-line marker keep their format.
  assert.match(bluf, /`DONE:`, `QUESTION:`, `FAILED:`/);
  assert.match(bluf, /## 아래로 내리는 지시/);

  assert.match(
    readSkill("pm"),
    /\]\(\.\.\/\.\.\/references\/bluf\.md\)의 「아래로 내리는 지시」/,
  );
  assert.match(
    readSkill("kickoff"),
    /브리프는 \[두괄식\]\(\.\.\/\.\.\/references\/bluf\.md\)/,
  );
  assert.match(
    readReference("korean-result-reporting.md"),
    /\[`bluf\.md`\]\(bluf\.md\)/,
  );
});
test("minimal-change discipline lives in one place and each role links it", () => {
  const references = path.join(root, "plugins/oh-my-teams/references");
  const canonicalPath = path.join(references, "minimal-change.md");

  // 수용 기준 1: 정본 파일이 존재한다
  assert.ok(
    fs.existsSync(canonicalPath),
    "references/minimal-change.md must exist",
  );

  const canonical = fs.readFileSync(canonicalPath, "utf8");

  // 수용 기준 6: 두 예외의 핵심 문구가 정본에 있다
  // 안전 예외
  assert.match(
    canonical,
    /신뢰 경계의 입력 검증/,
    "canonical must state the safety exception",
  );
  assert.match(
    canonical,
    /데이터 손실을 막는 오류 처리/,
    "canonical must state data-loss clause of safety exception",
  );
  // 가독성 예외
  assert.match(
    canonical,
    /줄 수를 줄이려고 읽기 어려운 코드를 만들지 않는다/,
    "canonical must state the readability exception",
  );
  assert.match(
    canonical,
    /지루한 코드가 영리한 코드보다 낫다/,
    "canonical must state the boring-over-clever principle",
  );

  // 수용 기준 4: Senior가 다섯 판정 대상을 명시한다
  const seniorText = readSkill("senior");
  const fiveTargets = [
    /요청하지 않은 리팩터링/,
    /변경 줄 밖의 정리/,
    /추측성 확장/,
    /이미 있는 helper의 재구현/,
    /요청하지 않은 주석/,
  ];
  for (const pattern of fiveTargets) {
    assert.match(
      seniorText,
      pattern,
      `senior must list all five finding targets (missing: ${pattern})`,
    );
  }

  // 수용 기준 1: 다섯 역할 스킬이 정본을 링크한다
  for (const role of ["pm", "pl", "senior", "junior", "intern"]) {
    assert.match(
      readSkill(role),
      /references\/minimal-change\.md/,
      `${role} must link to references/minimal-change.md`,
    );
  }

  // 수용 기준 5: Junior·Intern의 링크가 ### 한계 절 안에 있다
  for (const role of ["junior", "intern"]) {
    const text = readSkill(role);
    const limitsSection = text.split("### 한계")[1]?.split(/\n## /)[0];
    assert.ok(limitsSection, `${role} must have a ### 한계 section`);
    assert.match(
      limitsSection,
      /references\/minimal-change\.md/,
      `${role} must link to minimal-change.md inside ### 한계`,
    );
  }
});
