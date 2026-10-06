/** Checks that what the skills tell a model to do actually works. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEPTH_ROLES, readJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import { REQUIRED_OPTIONS } from "../plugins/oh-my-teams/scripts/teams-org.mjs";
import { draftResourceOrganization } from "../plugins/oh-my-teams/scripts/org-draft.mjs";
import { fetchModelCatalog } from "../plugins/oh-my-teams/scripts/model-catalog.mjs";
import {
  roleCommand,
  roleSpec,
} from "../plugins/oh-my-teams/scripts/role-launch.mjs";
import { PROMPT_ANSWER_REFUSALS } from "../plugins/oh-my-teams/scripts/prompt-supervision.mjs";
import { removedSkillNames } from "./removed-skills.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examples = path.join(root, "plugins/oh-my-teams/examples");
const skills = path.join(root, "plugins/oh-my-teams/skills");
const references = path.join(root, "plugins/oh-my-teams/references");

const readSkill = (name) =>
  fs.readFileSync(path.join(skills, name, "SKILL.md"), "utf8");

test("form no longer mentions the removed assist feature or its allowlist", () => {
  const form = readSkill("form");
  assert.doesNotMatch(form, /assistants|assist/);
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

test("close runs branch cleanup and disband preserves branches", () => {
  const close = readSkill("close");
  const disband = readSkill("disband");

  // CLOSE-01: the close skill must instruct the runtime to clean up branches.
  assert.ok(
    close.includes("node <runtime> kickoff-branch-cleanup"),
    "close must reference kickoff-branch-cleanup",
  );
  // The command must carry the required options.
  assert.ok(
    close.includes("--org") &&
      close.includes("--worktree") &&
      close.includes("--branches"),
    "close kickoff-branch-cleanup example must include --org, --worktree, --branches",
  );
  // disband must not instruct branch deletion; it preserves branches for recovery.
  assert.ok(
    !disband.includes("kickoff-branch-cleanup"),
    "disband must not run kickoff-branch-cleanup",
  );
  // The distinction between close and disband must be stated in the close skill.
  assert.match(
    close,
    /disband.*브랜치를 보존/,
    "close must state that disband preserves branches",
  );
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
  const subagents = fs.readFileSync(
    path.join(references, "subagents.md"),
    "utf8",
  );

  // The liveness verdict and the subagent rule are fixed facts. Each used to
  // be restated in four or five places, so a correction had to be applied in
  // every one of them or the copies disagreed.
  assert.match(runtime, /## worker-list와 liveness/);
  assert.match(subagents, /## 서브에이전트와 Worker/);

  const restatements = [
    [/`live` worker가 0명이면.*표현하지 않는다/, "the liveness verdict"],
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

test("form asks for subscription resources, not role models or a ladder size", () => {
  const form = readSkill("form");
  assert.match(form, /질문은 한 번으로 끝난다/);
  assert.match(form, /사용할 구독 자원만/);
  assert.doesNotMatch(form, /PM·PL·Senior·Junior의 모델을 한꺼번에 묻는다/);
  assert.match(form, /묻지 않고 정하는 것/);
  assert.match(form, /명시적인 호환 입력/);
  const draft = /node <runtime> org-draft([^\n`]*)/.exec(form);
  assert.ok(draft, "form must draft the organization");
  assert.doesNotMatch(draft[1], /--tiers/);
  assert.match(draft[1], /--resources <codex,claude,agy>/);
});

test("the depth table the PM reads is the depth the runtime applies", () => {
  const pm = readSkill("pm");
  const names = {
    PM: "pm",
    PL: "pl",
    Senior: "senior",
    Junior: "junior",
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
  assert.deepEqual([...rows.keys()], Object.keys(DEPTH_ROLES));
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
      /「실행 깊이」|깊이 1|깊이 2|Worker를 사용하지 않을 수|역할 ID는 `pm`과 `worker`/,
      `${skill} must point at the one place the depth rules live`,
    );
  }
});

test("every catalog-verified provider form documents is a resource draft accepts", async () => {
  const fakeExecute = async (argv) => {
    const key = argv.join(" ");
    const table = {
      "claude --version": {
        code: 0,
        stdout: "2.1.283 (Claude Code)\n",
        stderr: "",
        timedOut: false,
      },
      "codex --version": {
        code: 0,
        stdout: "codex-cli 0.157.1\n",
        stderr: "",
        timedOut: false,
      },
      "codex debug models": {
        code: 0,
        stdout: JSON.stringify({
          models: [
            {
              slug: "gpt-6-astra",
              visibility: "list",
              priority: 1,
              display_name: "GPT-6-Astra",
              supported_reasoning_levels: [{ effort: "low" }],
            },
          ],
        }),
        stderr: "",
        timedOut: false,
      },
      "agy --version": {
        code: 0,
        stdout: "1.2.12\n",
        stderr: "",
        timedOut: false,
      },
      "agy models": {
        code: 0,
        stdout: "gemini-3.1-pro-high\tGemini 3.1 Pro (High)\n",
        stderr: "Fetching available models...\n",
        timedOut: false,
      },
    };
    assert.ok(Object.hasOwn(table, key), `no fake response for: ${key}`);
    return table[key];
  };

  const catalog = await fetchModelCatalog({ execute: fakeExecute });

  assert.equal(catalog.claude.status, "unavailable");
  assert.equal(catalog.claude.reasonCode, "no-catalog-interface");
  const form = readSkill("form");
  assert.equal(catalog.codex.status, "ok");
  assert.equal(catalog.agy.status, "ok");
  const org = draftResourceOrganization({
    name: "test",
    resources: ["claude", "codex", "agy"],
  });
  assert.deepEqual(Object.keys(org.resources).sort(), [
    "agy-current",
    "claude-current",
    "codex-current",
  ]);
  assert.equal(org.profiles, undefined);
  assert.match(form, /모델을 선택하거나 모델 접근 권한을 단정하지 않는다/);
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
    /\| Agy\(모델·플랫폼 조합에 따라\) \|[^\n]*`scripts\/launch-matrix\.mjs`/,
  );
  assert.match(runtime, /`agentDefaultArgs`/);
  // Orca pre-trusts a Codex folder only when it launches Codex itself, so the
  // terminal path can stop at Codex's trust screen; the supervisor answers it.
  assert.match(runtime, /Orca가 Codex 작업 폴더를 미리 신뢰해 두지 않는다/);
  assert.match(runtime, /`agent-trust-workspace`로 거부하며/);
  assert.doesNotMatch(runtime, /kickoff는 사람이 답할 때까지 멈춘다/);
  assert.doesNotMatch(runtime, /사람이 그 터미널에서 답한 뒤/);
  assert.doesNotMatch(runtime, /터미널 앞의 사람만 답할 수 있으므로/);
  // A stopped role's question goes through the supervisor command and back to
  // the precheck.
  assert.match(runtime, /### 프롬프트 질문 답하기/);
  assert.match(
    runtime,
    /node <runtime> prompt-answer --org <organization\.json> --terminal <handle>/,
  );
  assert.match(runtime, /`prompt-answers\.jsonl`/);
  for (const code of PROMPT_ANSWER_REFUSALS) {
    assert.ok(runtime.includes(`\`${code}\``), `거부 코드 ${code}`);
  }
  assert.match(runtime, /`waiting-on-human-prompt`이면 사람을 기다리지 않고/);
  // The worktree is proven by Orca's own lineage, not by the launcher's word,
  // and the caller's identity is documented as unproven.
  assert.match(runtime, /\*\*워크트리 확인\.\*\*/);
  assert.match(runtime, /orca worktree show --worktree id:<repoId>::<경로>/);
  assert.match(runtime, /`parentWorktreeId`/);
  assert.match(runtime, /\*\*호출자 식별의 한계\.\*\*/);
  assert.match(runtime, /감독 관계가 없는 터미널의 실수 호출/);
  assert.match(runtime, /「사람이 필요한 경우」를 따른다/);
  for (const name of ["pm", "pl"]) {
    assert.match(readSkill(name), /악의적인 프로세스를 막지는 못한다/);
  }
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
    new RegExp(
      [
        "node <runtime> role-worktree-create --org <organization\\.json>",
        " --role <역할> --repo <pm-worktree> --name <name> --base <base-sha>",
        " --workflow-id <workflowId> --state <pm-state> --workflow-task <task id>",
      ].join(""),
    ),
  );
  assert.doesNotMatch(readSkill("pl"), /custom argv/);
  assert.match(runtime, /감독 worker로 띄울 수 없고[^\n]*`work` 하네스/);
  assert.match(runtime, /대괄호/);
  assert.doesNotMatch(runtime, /Windows에서 Agy는 신뢰 상태와 무관하게/);
  assert.doesNotMatch(
    runtime,
    /표가 `headless`를 돌려주면 `headless-start`로 실행/,
  );
  const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  const archivedHeadlessPlan = fs.readFileSync(
    path.join(root, "docs/plan/headless-runtime.md"),
    "utf8",
  );
  assert.doesNotMatch(agents, /headless-runtime\.md.*예외/);
  assert.match(archivedHeadlessPlan, /보관 기록: 제거된 비대화형 감독 런타임/);
  assert.match(
    archivedHeadlessPlan,
    /새 역할 실행을 시작하거나 재개하지 않는다/,
  );
  assert.match(archivedHeadlessPlan, /제거된 명령 표면/);
  const runtimeSource = fs.readFileSync(
    path.join(root, "plugins/oh-my-teams/scripts/teams-org.mjs"),
    "utf8",
  );
  const help = runtimeSource.slice(
    runtimeSource.indexOf("const HELP ="),
    runtimeSource.indexOf("`;", runtimeSource.indexOf("const HELP =")),
  );
  assert.doesNotMatch(help, /headless-start|headless-answer/);
  for (const role of ["pm", "pl"]) {
    assert.match(
      readSkill(role),
      /Claude·Codex·Agy 역할은 모두 `role-terminal`로 모델·강도·권한 우회 플래그를 담아 연 터미널/,
    );
    assert.doesNotMatch(readSkill(role), /래퍼가 새 터미널을 띄우/);
    // #46: on Windows Orca never reports a Gemini Agy terminal idle, so the
    // matrix decides the launch path and skills link the matrix table.
    assert.match(
      readSkill(role),
      /호환성 표\(`scripts\/launch-matrix\.mjs`\)가 `blocked`를 돌려주는 프로필은 세션 없는 대체 실행을 시작하지 않고/,
    );
    // Skills and orca-runtime.md must link launch-matrix.mjs.
    assert.match(readSkill(role), /launch-matrix\.mjs/);
    // The example checks the terminal, then reserves, then hands it over.
    assert.match(
      readSkill(role),
      /terminal-idle-check --terminal <\S+>\nnode <runtime> workflow-reserve [^\n]*\nnode <runtime> worker-start /,
    );
    // An Agy terminal never reports tui-idle, and the inject workaround
    // escapes worker-stop and model checks.
    assert.match(
      readSkill(role),
      /원시 `dispatch --inject`로 우회하지 (?:않고|않습니다)/,
    );
    // #41: a released reservation keeps its attempt spent, so the idle check
    // runs before the attempt is reserved.
    assert.match(readSkill(role), /예약하기 전에 `terminal-idle-check`/);
  }
  assert.match(
    runtime,
    /호출하기 전에 같은 터미널에 `terminal wait --for tui-idle`/,
  );
  assert.match(runtime, /멈춘 뒤 거부 원문과 함께 사용자에게 보고한다/);
  // orca-runtime.md must link the compatibility matrix.
  assert.match(runtime, /launch-matrix\.mjs/);

  // New PMs dispatch workers directly; legacy PL still documents nesting.
  assert.match(readSkill("pm"), /PM이 직접 작업 그래프와 통합 결과를 책임지고/);
  assert.match(readSkill("pl"), /기본값이 1/);
  assert.match(
    readSkill("senior"),
    /- 구현 task의 담당으로 배정받지 않았고 Junior가 이번 실행에 있으면 기능 구현/,
  );
  assert.match(readSkill("kickoff"), /`PM 실행` 절/);
  // A session that could not start the PM went on as PM itself.
  assert.match(readSkill("kickoff"), /이사는 PM을 대신 맡지 않는다/);
  assert.match(readReference("kickoff-registry.md"), /인계에 실패한 것이다/);
  assert.match(
    readReference("kickoff-registry.md"),
    /`role-worktree-create --brief <브리프 경로>`/,
  );
});

test("form registers catalog-verified subscription resources without choosing models", () => {
  const form = readSkill("form");
  assert.match(form, /node <runtime> model-catalog/);
  assert.match(form, /사용할 구독 자원만/);
  assert.match(form, /account·subscription·pool·동시 실행·호출 한도/);
  assert.match(
    form,
    /카탈로그가 실패했을 때 host default나 고정 모델을 추측하여 넣지 않는다/,
  );
  assert.doesNotMatch(form, /node <runtime> host-defaults/);
  assert.doesNotMatch(form, /`codex:<id>`/);
});

test("form does not hardcode model identifiers or restore role-by-role selection", () => {
  const form = readSkill("form");
  for (const id of [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-6-astra",
  ]) {
    assert.ok(
      !form.includes(id),
      `form hardcodes ${id} despite resource-only formation`,
    );
  }
  assert.doesNotMatch(form, /PM·PL·Senior·Junior의 모델을 한꺼번에/);
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
  assert.match(pm, /PM이 직접 작업 그래프와 통합 결과를 책임지고/);
  assert.match(pm, /Worker에게 직접 배정/);
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
  for (const role of ["pm", "pl", "senior", "junior"]) {
    const text = readSkill(role);
    const charter = text.split("## 권한·책임·한계")[1]?.split(/\n## /)[0];
    assert.ok(charter, `${role} lacks the charter section`);
    for (const part of ["### 권한", "### 책임", "### 한계"]) {
      assert.ok(charter.includes(part), `${role} charter lacks ${part}`);
    }
    // The fold rule is what lets a reduced team act without a missing role.
    // Junior is the lowest rung, so no role's work folds onto it; it instead
    // names the alias that hands it work a pre-2.6.0 record gave to Intern.
    if (role === "junior") {
      assert.match(charter, /canonicalRole/, "junior charter omits Intern");
    } else {
      assert.match(charter, /resolveRole/, `${role} charter omits folding`);
    }
    const authority = charter.split("### 책임")[0];
    for (const [, token] of authority.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)) {
      assert.ok(
        Object.hasOwn(REQUIRED_OPTIONS, token) || orcaVerbs.has(token),
        `${role} charter names an unknown command: ${token}`,
      );
    }
  }
  for (const role of ["senior", "junior"]) {
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
  for (const role of ["pl", "senior", "junior"]) {
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
test("all roles and director follow bluf for reports and signals", () => {
  const bluf = readReference("bluf.md");
  const koreanReport = readReference("korean-result-reporting.md");
  const director = readSkill("director");
  const pm = readSkill("pm");

  // (a) director 스킬이 bluf.md와 korean-result-reporting.md를 링크한다
  assert.match(
    director,
    /\[두괄식\]\(\.\.\/\.\.\/references\/bluf\.md\)/,
    "director must link to bluf.md",
  );
  assert.match(
    director,
    /korean-result-reporting\.md/,
    "director must link to korean-result-reporting.md",
  );

  // (b) korean-result-reporting.md의 대상이 이사다
  assert.match(
    koreanReport,
    /이사가 한국어 사용자에게/,
    "korean-result-reporting.md must target the director",
  );
  assert.match(
    koreanReport,
    /PM이 이사에게 올리는 보고/,
    "korean-result-reporting.md must mention PM reporting to director",
  );

  // (c) director·pm·pl·senior·junior 스킬이 모두 bluf.md를 참조한다
  for (const role of ["director", "pm", "pl", "senior", "junior"]) {
    assert.match(
      readSkill(role),
      /references\/bluf\.md/,
      `${role} must reference bluf.md`,
    );
  }

  // (d) bluf.md가 이사를 대상에 포함한다
  assert.match(
    bluf,
    /이사가 사용자에게 보내는 보고/,
    "bluf.md must explicitly include the director reporting to the user",
  );
  assert.match(
    bluf,
    /배정자, 이사, 사용자가 결정해야 하는 일/,
    "bluf.md must include the user as a decision maker in the second line",
  );

  // (e) pm·director 스킬이 신호 본문의 두괄식 첫 줄 규칙을 적는다
  assert.match(
    pm,
    /두괄식 첫 줄\(판정 또는 결정 요청\)/,
    "pm must state signal text starts with bluf first line",
  );
  assert.match(
    director,
    /두괄식 첫 줄\(결정\)/,
    "director must state reply text starts with bluf first line",
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

  // 수용 기준 1: 네 역할 스킬이 정본을 링크한다
  for (const role of ["pm", "pl", "senior", "junior"]) {
    assert.match(
      readSkill(role),
      /references\/minimal-change\.md/,
      `${role} must link to references/minimal-change.md`,
    );
  }

  // 수용 기준 5: Junior의 링크가 ### 한계 절 안에 있다
  for (const role of ["junior"]) {
    const text = readSkill(role);
    const limitsSection = text.split("### 한계")[1]?.split(/\n## /)[0];
    assert.ok(limitsSection, `${role} must have a ### 한계 section`);
    assert.match(
      limitsSection,
      /references\/minimal-change\.md/,
      `${role} must link to minimal-change.md inside ### 한계`,
    );
    assert.match(
      limitsSection,
      /신뢰 경계의 입력 검증/,
      `${role} 한계 section must mention 신뢰 경계의 입력 검증`,
    );
    assert.match(
      limitsSection,
      /읽기 어려운 코드/,
      `${role} 한계 section must mention 읽기 어려운 코드`,
    );
  }

  // 수용 기준: 정본과 PM 스킬에 이스케이프된 따옴표(\")가 없다
  assert.doesNotMatch(
    canonical,
    /\\"/,
    "references/minimal-change.md must not contain escaped quotes",
  );
  assert.doesNotMatch(
    readSkill("pm"),
    /\\"/,
    "pm SKILL.md must not contain escaped quotes",
  );
});

test("no-ghostwriting discipline lives in one place and every role limit links it", () => {
  const canonical = fs.readFileSync(
    path.join(root, "plugins/oh-my-teams/references/no-ghostwriting.md"),
    "utf8",
  );
  // Review independence is the reason specific to this organization, and the
  // exception keeps a run without lower roles from reading the rule as a ban.
  assert.match(canonical, /\*\*검토 독립성:\*\*/);
  assert.match(canonical, /\*\*하위 역할이 없는 실행:\*\*/);
  assert.match(canonical, /## 합리화 차단표/);
  // The limits section is the part role-spec prepends to each instruction.
  for (const role of ["pm", "pl", "senior", "junior"]) {
    const limits = readSkill(role).split("### 한계")[1]?.split(/\n## /)[0];
    assert.ok(limits, `${role} must have a ### 한계 section`);
    assert.match(
      limits,
      /\.\.\/\.\.\/references\/no-ghostwriting\.md/,
      `${role} must link to no-ghostwriting.md inside ### 한계`,
    );
  }
  assert.match(
    readSkill("junior"),
    /옮겨 적었다는 사실을 `worker_done` 보고에 남긴다/,
  );
});

test("a senior may implement only a task assigned to it, and never reviews its own work", () => {
  const senior = readSkill("senior");
  const pm = readSkill("pm");
  // Tiering by reasoning strength: the assignment is the marker, so no new
  // contract field is needed, and review independence stays with the runtime.
  assert.match(senior, /workflow task의 `role`이 `senior`/);
  assert.match(
    senior,
    /직접 구현한 task의 필수 검토는 다른 Senior 실행이나 PL·PM이 맡으며/,
  );
  assert.match(pm, /## 구현 등급/);
  assert.match(pm, /workflow task의 `role`을 `senior`로 적는다/);
  assert.match(pm, /같은 실행이 검토하면 런타임이 거부한다/);
  assert.match(readSkill("pl"), /「구현 등급」을 따른다/);
});

test("skills cut review-rework loops and wasted context", () => {
  const pm = readSkill("pm");
  const senior = readSkill("senior");
  const junior = readSkill("junior");
  const pl = readSkill("pl");
  const runtime = readReference("orca-runtime.md");
  // A Junior implementation goes up after its first rejected review.
  assert.match(pm, /Junior 구현이 검토에서 한 번 반려된 일/);
  assert.match(pm, /첫 검토에서 반려되어 Senior의 별도 소유권이 필요하면/);
  assert.doesNotMatch(pm, /반복해서 실패한 일/);
  // Reviewers list every finding at once, then re-review only the fix diff.
  assert.match(senior, /첫 검토에서는 발견한 finding을 한 번에 모두 적고/);
  assert.match(
    senior,
    /이전 finding이 해결되었는지와 그 diff가 새로 만든 문제만/,
  );
  assert.match(pm, /앞선 검토 파일의 경로와 수정 diff 범위/);
  // Reviewers reuse recorded verify evidence instead of rerunning suites.
  assert.match(
    senior,
    /전체 테스트나 무거운 스크립트를 되풀이해 실행하지 않는다/,
  );
  assert.match(senior, /별도 작업으로 나누도록/);
  // Implementers self-check before worker_done.
  for (const text of [junior, senior]) {
    assert.match(text, /`worker_done` 전에 (task의 )?수용 기준/);
    assert.match(text, /실패하는 검사를 알고도 제출하지 않/);
  }
  // Fresh context and early compaction for Claude role terminals.
  assert.match(pm, /`\/clear`/);
  assert.match(pm, /--autocompact 250k/);
  assert.match(pm, /--purpose review/);
  assert.match(pl, /--workflow-task/);
  assert.match(runtime, /다른 task를 넘길 때의 새 대화/);
  // Supervisors wait through heartbeats with supervision-wait.
  assert.match(runtime, /node <runtime> supervision-wait --run <runId>/);
  for (const text of [pm, pl]) {
    assert.match(text, /supervision-wait/);
  }
  assert.doesNotMatch(pl, /check --wait --types/);
});

test("pm, pl and status skills route a stopped role's question through the supervisor command", () => {
  for (const name of ["pm", "pl"]) {
    const text = readSkill(name);
    assert.match(
      text,
      /node <runtime> prompt-answer --org [^\n]*--terminal <[a-z-]*handle> --workflow-id <workflowId> --state <pm-state>/,
      `${name} 스킬에 prompt-answer 호출이 있다`,
    );
    assert.match(text, /terminal-idle-check`부터 다시 (진행|실행)한다/);
    assert.match(text, /「프롬프트 질문 답하기」/);
  }
  assert.match(readSkill("pm"), /`director-signal`로 이사에게 알린다/);
  assert.match(readSkill("pl"), /다른 PL의 하위 역할이나 PM의 워크트리 터미널/);
  assert.match(readSkill("status"), /`promptAnswers`/);
});

test("roadmap canon exists and has one official source", () => {
  const canonicalPath = path.join(references, "roadmap.md");
  assert.ok(
    fs.existsSync(canonicalPath),
    "plugins/oh-my-teams/references/roadmap.md must exist as the single source of truth",
  );
});

test("roleSpec header injects roadmap reference into all role instructions", () => {
  const org = readJSON(path.join(examples, "organization.json"));

  const roadmapRefPath = path.join(references, "roadmap.md");
  for (const role of ["pm", "pl", "senior", "junior"]) {
    const spec = roleSpec(org, role, "# 작업\n\n테스트", {
      orgFile: "/project/.omt/organization.json",
    });
    assert.ok(
      spec.includes(`로드맵 규칙: ${roadmapRefPath}`),
      `${role} specification header must inject the roadmap reference`,
    );
  }
});

test("each role skill links to roadmap reference", () => {
  const roadmapRef = "../../references/roadmap.md";
  const roles = {
    director: true,
    pm: true,
    pl: true,
    senior: true,
    junior: true,
  };

  for (const role of Object.keys(roles)) {
    const text = readSkill(role);
    assert.ok(
      text.includes(roadmapRef),
      `${role} skill must link to roadmap reference`,
    );
  }
});
