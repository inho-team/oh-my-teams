/**
 * Deterministic tests for the prompt screen classifier and the command scope
 * judgement. Every screen captured in `tests/fixtures/prompt-screens/` is fed
 * in, and each fixture must have an expected answer here. Screens that were
 * never captured (update notices, command approvals) are exercised only as
 * unknown input, and the approval decision is exercised with synthetic
 * choices that are not any CLI's wording.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyPromptScreen,
  decideApproval,
  judgeCommandScope,
  trustQuestionVisible,
} from "../plugins/oh-my-teams/scripts/prompt-answers.mjs";
import { trustQuestion } from "../plugins/oh-my-teams/scripts/role-terminal.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, "fixtures", "prompt-screens");
const fixtures = Object.fromEntries(
  fs
    .readdirSync(fixtureDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => [
      name.replace(/\.json$/, ""),
      JSON.parse(fs.readFileSync(path.join(fixtureDir, name), "utf8")),
    ]),
);

// kind, action and key name expected for each captured screen.
const EXPECTED = {
  "agy-1.2.7-folder-trust-default": ["trust", "send-key", "Enter"],
  "agy-1.2.7-folder-trust-changed": ["trust", "none", undefined],
  "agy-1.2.7-unsubmitted-input": ["unknown", "none", undefined],
  "codex-0.155.1-folder-trust-default": ["trust", "send-key", "Enter"],
  "codex-0.155.1-folder-trust-changed": ["trust", "none", undefined],
  "codex-0.155.1-unsubmitted-input": ["unknown", "none", undefined],
  "claude-2.1.278-folder-trust-default": ["trust", "send-key", "Down"],
  "claude-2.1.278-folder-trust-changed": ["trust", "send-key", "Enter"],
  "claude-2.1.278-unsubmitted-input": ["unknown", "none", undefined],
  "claude-2.1.278-askuser-default": ["user-question", "redirect", undefined],
  "claude-2.1.278-askuser-changed": ["user-question", "redirect", undefined],
};

// The folder the three trust captures were taken in. Codex and Claude answer
// only when the caller names the folder the screen shows.
const CAPTURED = {
  worktree:
    "/private/var/folders/hp/nqxfzfgs7xz_fw2k8lh4gn7c0000gn/T/tmp.6Kiqw25mrE",
};
const screen = (name) => fixtures[name].lines;
const swap = (lines, from, to) =>
  lines.map((line) => (line === from ? to : line));

test("every captured fixture has an expected classification and key", () => {
  assert.deepEqual(Object.keys(fixtures).sort(), Object.keys(EXPECTED).sort());
  for (const [name, [kind, action, key]] of Object.entries(EXPECTED)) {
    const result = classifyPromptScreen(screen(name), CAPTURED);
    assert.equal(result.kind, kind, name);
    assert.equal(result.action, action, name);
    assert.equal(result.key?.name, key, name);
    assert.equal(result.cli === null, kind === "unknown", name);
  }
});

test("a key is returned only with its sending arguments, and Esc is never returned", () => {
  for (const name of Object.keys(fixtures)) {
    const { key } = classifyPromptScreen(screen(name), CAPTURED);
    if (!key) continue;
    assert.ok(
      ["captured-input", "footer-text", "existing-behavior"].includes(
        key.basis,
      ),
    );
    assert.notEqual(key.send.text, "\u001b", name);
    assert.notEqual(key.name, "Esc", name);
  }
  const down = classifyPromptScreen(
    screen("claude-2.1.278-folder-trust-default"),
    CAPTURED,
  ).key;
  assert.deepEqual(down.send, { text: "\u001b[B", enter: false });
  const enter = classifyPromptScreen(
    screen("codex-0.155.1-folder-trust-default"),
    CAPTURED,
  ).key;
  assert.deepEqual(enter.send, { text: "", enter: true });
});

test("the result records the compared lines, the selected choice and why nothing is sent", () => {
  const sent = classifyPromptScreen(
    screen("codex-0.155.1-folder-trust-default"),
    CAPTURED,
  );
  assert.equal(sent.reason, null);
  assert.equal(sent.cli, "codex");
  assert.deepEqual(sent.evidence.selected, {
    index: 1,
    label: "Yes, continue",
  });
  assert.ok(
    sent.evidence.matched.some((line) =>
      line.startsWith("Do you trust the contents of this directory?"),
    ),
  );
  assert.ok(sent.evidence.matched.includes("› 1. Yes, continue"));
  assert.ok(sent.evidence.after);
  const withheld = classifyPromptScreen(
    screen("codex-0.155.1-folder-trust-changed"),
    CAPTURED,
  );
  assert.deepEqual(withheld.evidence.selected, { index: 2, label: "No, quit" });
  assert.match(withheld.reason, /No, quit/);
});

test("Claude's trust question opens on No, so it is moved with Down and confirmed only once Yes is selected", () => {
  const opening = classifyPromptScreen(
    screen("claude-2.1.278-folder-trust-default"),
    CAPTURED,
  );
  assert.equal(opening.evidence.selected.label, "No, exit");
  assert.equal(opening.key.name, "Down");
  assert.match(opening.evidence.after, /다시 읽어/);
  const moved = classifyPromptScreen(
    screen("claude-2.1.278-folder-trust-changed"),
    CAPTURED,
  );
  assert.equal(moved.evidence.selected.label, "Yes, I trust this folder");
  assert.equal(moved.key.name, "Enter");
});

test("a different selection state is not answered", () => {
  const cases = {
    // Enter with "No" selected would quit, so the changed captures are withheld.
    agy: screen("agy-1.2.7-folder-trust-changed"),
    codex: screen("codex-0.155.1-folder-trust-changed"),
    // No selection marker, two markers, and a marker on a row that is not a choice.
    "no marker": swap(
      screen("agy-1.2.7-folder-trust-default"),
      "> Yes, I trust this folder",
      "  Yes, I trust this folder",
    ),
    "two markers": swap(
      screen("agy-1.2.7-folder-trust-default"),
      "  No, exit",
      "> No, exit",
    ),
    "other marker": swap(
      screen("agy-1.2.7-folder-trust-default"),
      "> Yes, I trust this folder",
      "❯ Yes, I trust this folder",
    ),
    "codex other marker": swap(
      screen("codex-0.155.1-folder-trust-default"),
      "› 1. Yes, continue",
      "> 1. Yes, continue",
    ),
  };
  for (const [name, lines] of Object.entries(cases)) {
    const result = classifyPromptScreen(lines, CAPTURED);
    assert.equal(result.action, "none", name);
    assert.equal(result.key, null, name);
    assert.ok(result.reason, name);
  }
  // The "changed" screens are still recognized as trust questions.
  assert.equal(classifyPromptScreen(cases.agy).kind, "trust");
  assert.equal(classifyPromptScreen(cases.codex).kind, "trust");
});

test("wording that differs from the capture is not answered", () => {
  const codex = screen("codex-0.155.1-folder-trust-default");
  const claude = screen("claude-2.1.278-folder-trust-default");
  const agy = screen("agy-1.2.7-folder-trust-default");
  const cases = {
    "codex choice text": swap(codex, "› 1. Yes, continue", "› 1. Yes, always"),
    "codex numbering": swap(codex, "› 1. Yes, continue", "› Yes, continue"),
    "codex footer": codex.filter((line) => !line.includes("Press enter")),
    "claude footer": claude.filter(
      (line) => !line.includes("Enter to confirm"),
    ),
    "claude question": claude.map((line) =>
      line.replace("Quick safety check", "Safety check"),
    ),
    "claude missing yes": claude.filter(
      (line) => !line.includes("Yes, I trust"),
    ),
    "agy question": agy.map((line) =>
      line.replace("this project", "this workspace"),
    ),
    "agy missing yes": agy.filter((line) => !line.includes("Yes, I trust")),
  };
  for (const [name, lines] of Object.entries(cases)) {
    const result = classifyPromptScreen(lines, CAPTURED);
    assert.equal(result.action, "none", name);
    assert.equal(result.key, null, name);
  }
});

test("a question left in the buffer after the CLI exited is not answered", () => {
  const prompt = "jinsungkim@host tmp.6Kiqw25mrE %";
  for (const name of [
    "claude-2.1.278-folder-trust-changed",
    "codex-0.155.1-folder-trust-default",
    "agy-1.2.7-folder-trust-default",
  ]) {
    const stale = classifyPromptScreen([...screen(name), prompt], CAPTURED);
    assert.equal(stale.action, "none", name);
    assert.equal(stale.key, null, name);
    const typed = classifyPromptScreen(
      [...screen(name), `${prompt} claude --model haiku`],
      CAPTURED,
    );
    assert.equal(typed.action, "none", name);
  }
});

test("a trust question is answered only when the screen names the role's worktree", () => {
  const worktrees = {
    "agy-1.2.7-folder-trust-default":
      "/private/var/folders/hp/nqxfzfgs7xz_fw2k8lh4gn7c0000gn/T/tmp.6Kiqw25mrE",
    "codex-0.155.1-folder-trust-default":
      "/private/var/folders/hp/nqxfzfgs7xz_fw2k8lh4gn7c0000gn/T/tmp.6Kiqw25mrE",
    "claude-2.1.278-folder-trust-default":
      "/private/var/folders/hp/nqxfzfgs7xz_fw2k8lh4gn7c0000gn/T/tmp.6Kiqw25mrE",
  };
  for (const [name, worktree] of Object.entries(worktrees)) {
    const same = classifyPromptScreen(screen(name), { worktree });
    assert.equal(same.action, "send-key", name);
    assert.equal(same.evidence.workspace, worktree);
    const other = classifyPromptScreen(screen(name), {
      worktree: "/Users/x/orca/workspaces/p/other",
    });
    assert.equal(other.action, "none", name);
    assert.match(other.reason, /역할 워크트리/);
    // A path that shares only a prefix is another folder.
    const prefix = classifyPromptScreen(screen(name), {
      worktree: `${worktree}-2`,
    });
    assert.equal(prefix.action, "none", name);
    // Without a readable folder there is nothing to compare, so nothing is sent.
    const unread = classifyPromptScreen(
      screen(name).filter(
        (line) => !line.includes("tmp.6Kiqw25mrE") || line.includes("%"),
      ),
      { worktree },
    );
    assert.equal(unread.action, "none", name);
  }
});

test("a screen of another CLI than the one asked about is not answered", () => {
  const result = classifyPromptScreen(
    screen("codex-0.155.1-folder-trust-default"),
    { ...CAPTURED, cli: "agy" },
  );
  assert.equal(result.kind, "unknown");
  assert.equal(result.action, "none");
  assert.equal(
    classifyPromptScreen(screen("codex-0.155.1-folder-trust-default"), {
      ...CAPTURED,
      cli: "codex",
    }).action,
    "send-key",
  );
  assert.equal(
    classifyPromptScreen(screen("claude-2.1.278-askuser-default"), {
      cli: "codex",
    }).kind,
    "unknown",
  );
});

test("role-terminal's trustQuestion still answers Agy alone", () => {
  assert.equal(trustQuestion(screen("agy-1.2.7-folder-trust-default")), true);
  assert.equal(trustQuestion(screen("agy-1.2.7-folder-trust-changed")), false);
  assert.equal(
    trustQuestion(screen("codex-0.155.1-folder-trust-default")),
    false,
  );
  assert.equal(
    trustQuestion(screen("claude-2.1.278-folder-trust-changed")),
    false,
  );
  assert.equal(trustQuestion(undefined), false);
});

test("screens that were not captured classify as unknown and are never answered", () => {
  const screens = {
    "update notice": [
      "A new version is available",
      "  1. Update now",
      "  2. Skip",
      "  3. Later",
    ],
    "update notice with marker": [
      "Update available",
      "› 1. Skip",
      "  2. Update now",
    ],
    "command approval": [
      "Run this command?",
      "  npm test",
      "› 1. Yes",
      "  2. Yes, and don't ask again",
      "  3. No",
    ],
    empty: [],
    "blank lines": ["", "  ", ""],
    nullish: undefined,
    "a shell": ["jinsungkim@host repo %"],
    "agent prompt": [" ▐▛███▛█   Claude Code v2.1.278", "❯ hello"],
  };
  for (const [name, lines] of Object.entries(screens)) {
    const result = classifyPromptScreen(lines, CAPTURED);
    assert.equal(result.kind, "unknown", name);
    assert.equal(result.action, "none", name);
    assert.equal(result.key, null, name);
    assert.ok(result.reason, name);
  }
});

test("a user question screen is told apart from unknown and is sent back to the supervisor", () => {
  for (const name of [
    "claude-2.1.278-askuser-default",
    "claude-2.1.278-askuser-changed",
  ]) {
    const result = classifyPromptScreen(screen(name), CAPTURED);
    assert.equal(result.kind, "user-question", name);
    assert.equal(result.action, "redirect", name);
    assert.equal(result.key, null, name);
    assert.match(result.instruction, /orca orchestration ask/);
    assert.match(result.instruction, /사용자에게 직접 묻지 않/);
    for (const line of [
      "A와 B 중 하나를 선택해주세요.",
      "1. A",
      "옵션 A를 선택합니다.",
      "2. B",
      "옵션 B를 선택합니다.",
    ]) {
      assert.ok(result.excerpt.includes(line), `${name}: ${line}`);
      assert.ok(result.instruction.includes(line), `${name}: ${line}`);
    }
    assert.ok(
      !result.excerpt.some((line) =>
        /Type something|Chat about this|─{5,}|Enter to select/.test(line),
      ),
    );
  }
  assert.deepEqual(
    classifyPromptScreen(screen("claude-2.1.278-askuser-default")).evidence
      .selected,
    { index: 1, label: "A" },
  );
  assert.deepEqual(
    classifyPromptScreen(screen("claude-2.1.278-askuser-changed")).evidence
      .selected,
    { index: 2, label: "B" },
  );
});

test("a screen that only resembles the user question is unknown", () => {
  const ask = screen("claude-2.1.278-askuser-default");
  const cases = {
    "footer missing": ask.filter((line) => !line.startsWith("Enter to select")),
    "footer not last": [...ask, "jinsungkim@host repo %"],
    "escape row missing": ask.filter(
      (line) => !line.includes("Chat about this"),
    ),
    "header missing": ask.filter((line) => !line.includes("☐")),
  };
  for (const [name, lines] of Object.entries(cases)) {
    const result = classifyPromptScreen(lines, CAPTURED);
    assert.equal(result.kind, "unknown", name);
    assert.equal(result.action, "none", name);
  }
});

const SCOPE = {
  worktree: "/Users/x/orca/workspaces/p/feat-a",
  ownerCheckout: "/Users/x/orca/p",
  otherWorktrees: ["/Users/x/orca/workspaces/p/feat-b"],
  home: "/Users/x",
  allowedFiles: [
    "src/a.mjs",
    "tests/a.test.mjs",
    "docs/",
    "tests/fixtures/prompt-screens/",
  ],
  checks: [
    ["npm", "run", "format"],
    ["npm", "test"],
  ],
};
const at = (request) =>
  judgeCommandScope({ cwd: SCOPE.worktree, ...request }, SCOPE);

test("a check command run in the worktree is allowed", () => {
  for (const command of [
    "npm test",
    "npm run format",
    "  npm   run   format ",
  ]) {
    const result = at({ command });
    assert.equal(result.verdict, "allow", command);
    assert.ok(result.passed.some((item) => item.startsWith("check-command:")));
    assert.deepEqual(result.reasons, []);
  }
});

test("a path is allowed only inside the worktree and the contract's files", () => {
  const wt = SCOPE.worktree;
  for (const paths of [
    ["src/a.mjs"],
    [`${wt}/tests/a.test.mjs`],
    ["docs/plan/x.md"],
    ["tests/fixtures/prompt-screens/a.json"],
    ["./src/a.mjs"],
  ]) {
    assert.equal(at({ paths }).verdict, "allow", paths[0]);
  }
  assert.equal(
    judgeCommandScope({ paths: [`${wt}/src/a.mjs`] }, SCOPE).verdict,
    "allow",
  );
});

test("anything that cannot be decided is escalated, not allowed or denied", () => {
  const wt = SCOPE.worktree;
  const cases = {
    "command outside the checks": at({ command: "node scripts/other.mjs" }),
    "git commit": at({ command: "git commit -m x" }),
    "no cwd": judgeCommandScope({ command: "npm test" }, SCOPE),
    "relative path without cwd": judgeCommandScope(
      { paths: ["src/a.mjs"] },
      SCOPE,
    ),
    "cwd outside the worktree": judgeCommandScope(
      { command: "npm test", cwd: "/tmp/x" },
      SCOPE,
    ),
    "relative cwd": judgeCommandScope(
      { command: "npm test", cwd: "feat-a" },
      SCOPE,
    ),
    "file not in the contract": at({ paths: ["src/b.mjs"] }),
    "path outside the worktree": at({ paths: ["/tmp/scratch/a.mjs"] }),
    "sibling sharing a prefix": at({ paths: [`${wt}-2/src/a.mjs`] }),
    "traversal out of the worktree": at({ paths: ["../elsewhere/a.mjs"] }),
    "traversal within the worktree to a file that is not allowed": at({
      paths: ["docs/../src/b.mjs"],
    }),
    glob: at({ paths: ["src/*.mjs"] }),
    variable: at({ paths: ["$WORK/src/a.mjs"] }),
    "nothing to judge": at({}),
    "no scope": judgeCommandScope({ command: "npm test", cwd: wt }, undefined),
    "no contract files or checks": judgeCommandScope(
      { command: "npm test", cwd: wt },
      { worktree: wt },
    ),
    "no worktree": judgeCommandScope(
      { command: "npm test", cwd: wt },
      { ...SCOPE, worktree: undefined },
    ),
    "chained command": at({ command: "npm test && echo done" }),
  };
  for (const [name, result] of Object.entries(cases)) {
    assert.equal(
      result.verdict,
      "escalate",
      `${name}: ${JSON.stringify(result.reasons)}`,
    );
    assert.ok(result.reasons.length > 0, name);
    assert.deepEqual(
      result.passed.filter(
        (item) => item.startsWith("allowed-file") && name.includes("path"),
      ),
      [],
      name,
    );
  }
});

test("forbidden commands are denied even when they look like a check", () => {
  const forbidden = {
    "git push": "git-push",
    "git push origin feat/a": "git-push",
    "git -C /Users/x/orca/workspaces/p/feat-a push": "git-push",
    "git -c user.name=x push --force": "git-push",
    "git merge main": "git-merge",
    "git pull": "git-pull",
    "git reset --hard HEAD~1": "git-reset-hard",
    "git clean -fd": "git-clean-force",
    "git clean -fdx": "git-clean-force",
    "git clean --force -d": "git-clean-force",
    "git branch -D old": "git-branch-force-delete",
    "git config --global user.name x": "git-config-global",
    "gh pr create --fill": "gh-pr-create",
    "gh pr merge 3": "gh-pr-merge",
    "gh -R o/r pr merge 3": "gh-pr-merge",
    "gh api -X POST repos/o/r/issues": "remote-write",
    "gh auth token": "credential-access",
    "rm -rf build": "force-delete",
    "rm -f a.txt": "force-delete",
    "find . -delete": "force-delete",
    "npm install -g typescript": "global-install-or-remote-write",
    "npm i --global x": "global-install-or-remote-write",
    "npm publish": "global-install-or-remote-write",
    "pnpm add -g x": "global-install",
    "yarn global add x": "global-install",
    "brew install jq": "global-install",
    "curl -X POST https://x.test": "remote-write",
    "curl -d a=b https://x.test": "remote-write",
    "scp a b:/tmp": "remote-write",
    "security find-generic-password -s x": "credential-access",
    "cd /tmp && git push": "git-push",
    "npm test; git push": "git-push",
    "npm test | git push": "git-push",
    'bash -c "git push origin main"': "git-push",
    "sh -c 'npm test; rm -rf /'": "force-delete",
    "echo $(git push)": "git-push",
    "eval git push": "git-push",
    "zsh -lc 'git reset --hard'": "git-reset-hard",
    "FOO=1 git push": "git-push",
    "env GIT_DIR=x git push": "git-push",
    "sudo rm -rf /": "force-delete",
  };
  for (const [command, rule] of Object.entries(forbidden)) {
    const result = at({ command });
    assert.equal(result.verdict, "deny", command);
    assert.ok(
      result.reasons.some((item) => item.rule === rule),
      `${command}: ${JSON.stringify(result.reasons)}`,
    );
    assert.deepEqual(result.passed, [], command);
  }
  // A forbidden command is denied without a working folder as well.
  assert.equal(
    judgeCommandScope({ command: "git push" }, SCOPE).verdict,
    "deny",
  );
  assert.equal(
    judgeCommandScope({ command: "git push" }, undefined).verdict,
    "deny",
  );
});

test("the owner checkout, another role's worktree and user configuration files are denied", () => {
  const forbidden = {
    "owner checkout file": { paths: ["/Users/x/orca/p/src/a.mjs"] },
    "owner checkout by traversal": { paths: ["../../../p/src/a.mjs"] },
    "other worktree file": {
      paths: ["/Users/x/orca/workspaces/p/feat-b/src/a.mjs"],
    },
    "other worktree in a command": {
      command: "cat /Users/x/orca/workspaces/p/feat-b/src/a.mjs",
    },
    "owner checkout as the working folder": {
      command: "npm test",
      cwd: "/Users/x/orca/p",
    },
    "claude settings": { paths: ["~/.claude/settings.json"] },
    "claude settings by absolute path": {
      paths: ["/Users/x/.claude/settings.json"],
    },
    "claude json": { paths: ["/Users/x/.claude.json"] },
    "codex config": { paths: ["~/.codex/config.toml"] },
    "agy settings": { paths: ["~/.gemini/antigravity-cli/settings.json"] },
    "home variable": { paths: ["$HOME/.claude/settings.json"] },
    "braced home variable": { command: "cat ${HOME}/.codex/config.toml" },
    "redirect into a config file": { command: "echo x >~/.codex/config.toml" },
    "redirect with a space": { command: "echo x > ~/.claude/settings.json" },
    "option value": { command: "tool --config=/Users/x/.codex/config.toml" },
    "relative path reaching the home config": {
      paths: ["../../../../.claude/settings.json"],
    },
    "ssh key": { paths: ["~/.ssh/id_ed25519"] },
    "env file in the worktree": { paths: [".env"] },
    "env file variant": { paths: ["src/.env.local"] },
  };
  for (const [name, request] of Object.entries(forbidden)) {
    const result = judgeCommandScope(
      { cwd: SCOPE.worktree, ...request },
      SCOPE,
    );
    assert.equal(
      result.verdict,
      "deny",
      `${name}: ${JSON.stringify(result.reasons)}`,
    );
    assert.deepEqual(result.passed, [], name);
  }
  // Without knowing the home directory, the config directories are still denied by name.
  const noHome = { ...SCOPE, home: undefined };
  assert.equal(
    judgeCommandScope({ paths: ["~/.claude/settings.json"] }, noHome).verdict,
    "deny",
  );
  assert.equal(
    judgeCommandScope({ paths: ["/Users/y/.codex/config.toml"] }, noHome)
      .verdict,
    "deny",
  );
});

test("a worktree nested inside the owner checkout is not mistaken for the owner checkout", () => {
  const nested = { ...SCOPE, worktree: "/Users/x/orca/p/.wt/feat-a" };
  const result = judgeCommandScope(
    { cwd: nested.worktree, paths: ["src/a.mjs"] },
    nested,
  );
  assert.equal(result.verdict, "allow");
  assert.equal(
    judgeCommandScope(
      { cwd: nested.worktree, paths: ["/Users/x/orca/p/src/a.mjs"] },
      nested,
    ).verdict,
    "deny",
  );
});

// Windows reports a role's paths with a drive letter, backslash separators
// and no case distinction; `platform: "win32"` on the scope picks
// `path.win32` and folds case there, so every request judged above on the
// POSIX form of SCOPE must reach the same verdict on this Windows form.
const WIN_SCOPE = {
  ...SCOPE,
  platform: "win32",
  worktree: "C:\\Users\\x\\orca\\workspaces\\p\\feat-a",
  ownerCheckout: "C:\\Users\\x\\orca\\p",
  otherWorktrees: ["C:\\Users\\x\\orca\\workspaces\\p\\feat-b"],
  home: "C:\\Users\\x",
};
const winAt = (request) =>
  judgeCommandScope({ cwd: WIN_SCOPE.worktree, ...request }, WIN_SCOPE);

test("a Windows-style scope with a drive letter, backslashes and mixed case judges the same requests the POSIX form above allows, denies or escalates", () => {
  for (const paths of [
    ["src\\a.mjs"],
    [`${WIN_SCOPE.worktree}\\tests\\a.test.mjs`],
    ["docs\\plan\\x.md"],
    ["tests\\fixtures\\prompt-screens\\a.json"],
    [".\\src\\a.mjs"],
    // Windows ignores case in both the worktree and the contract's files.
    ["SRC/A.MJS"],
    [`${WIN_SCOPE.worktree.toUpperCase()}\\SRC\\A.MJS`],
  ]) {
    assert.equal(winAt({ paths }).verdict, "allow", paths[0]);
  }

  const forbidden = {
    "owner checkout file": { paths: ["C:\\Users\\x\\orca\\p\\src\\a.mjs"] },
    "other worktree file": {
      paths: ["C:\\Users\\x\\orca\\workspaces\\p\\feat-b\\src\\a.mjs"],
    },
    "claude settings by absolute path": {
      paths: ["C:\\Users\\x\\.claude\\settings.json"],
    },
    "relative path reaching the home config": {
      paths: ["..\\..\\..\\..\\.claude\\settings.json"],
    },
    "ssh key": { paths: ["~\\.ssh\\id_ed25519"] },
    "env file variant": { paths: ["src\\.env.local"] },
  };
  for (const [name, request] of Object.entries(forbidden)) {
    const result = judgeCommandScope(
      { cwd: WIN_SCOPE.worktree, ...request },
      WIN_SCOPE,
    );
    assert.equal(
      result.verdict,
      "deny",
      `${name}: ${JSON.stringify(result.reasons)}`,
    );
    assert.deepEqual(result.passed, [], name);
  }

  assert.equal(winAt({ paths: ["src\\b.mjs"] }).verdict, "escalate");
  assert.equal(winAt({ paths: ["..\\elsewhere\\a.mjs"] }).verdict, "escalate");

  // A worktree nested inside the owner checkout is still not mistaken for it.
  const nested = {
    ...WIN_SCOPE,
    worktree: "C:\\Users\\x\\orca\\p\\.wt\\feat-a",
  };
  assert.equal(
    judgeCommandScope({ cwd: nested.worktree, paths: ["src\\a.mjs"] }, nested)
      .verdict,
    "allow",
  );
  assert.equal(
    judgeCommandScope(
      { cwd: nested.worktree, paths: ["C:\\Users\\x\\orca\\p\\src\\a.mjs"] },
      nested,
    ).verdict,
    "deny",
  );
});

// `pathOf` only expanded `~`, `$HOME` and `${HOME}` when a `/` or the end of
// the word followed. On win32 a marker is just as often followed by `\`, so a
// path like `~\.aws\config` was read as a literal `~` folder under the
// worktree instead of the home directory: `zoneOf` then classified it as
// `worktree`, and it reached `path-not-in-allowed-files` (escalate) instead
// of `user-config-path` (deny). The filenames below are not on the
// `CREDENTIAL_FILE` list, so a deny here can only come from the home
// expansion working, not from the unrelated credential-filename check.
test("a Windows tilde or $HOME marker followed by a backslash still expands to the home directory", () => {
  const forbidden = {
    "tilde then aws config": { paths: ["~\\.aws\\config"] },
    "tilde then gnupg secring": { paths: ["~\\.gnupg\\secring.gpg"] },
    "tilde then codex config": { paths: ["~\\.codex\\config.toml"] },
    "tilde then claude settings": { paths: ["~\\.claude\\settings.json"] },
    "$HOME then aws config": { paths: ["$HOME\\.aws\\config"] },
    "${HOME} then codex config": { paths: ["${HOME}\\.codex\\config.toml"] },
  };
  for (const [name, request] of Object.entries(forbidden)) {
    const result = judgeCommandScope(
      { cwd: WIN_SCOPE.worktree, ...request },
      WIN_SCOPE,
    );
    assert.equal(
      result.verdict,
      "deny",
      `${name}: ${JSON.stringify(result.reasons)}`,
    );
    // Checking the verdict alone is not enough: before the fix, the one
    // backslash-tilde case already in the forbidden list above denied for an
    // unrelated reason (its filename matched `CREDENTIAL_FILE`), which masked
    // this same defect. The rule must be `user-config-path` specifically.
    assert.ok(
      result.reasons.some((item) => item.rule === "user-config-path"),
      `${name}: ${JSON.stringify(result.reasons)}`,
    );
    assert.deepEqual(result.passed, [], name);
  }

  // The POSIX form of the same text is unaffected: POSIX treats `\` as an
  // ordinary filename character, so the marker is not expanded there and the
  // word still resolves to a literal folder under the worktree, exactly as
  // before this fix.
  const posixResult = judgeCommandScope(
    { cwd: SCOPE.worktree, paths: ["~\\.aws\\config"] },
    SCOPE,
  );
  assert.equal(posixResult.verdict, "escalate");
  assert.ok(
    posixResult.reasons.some(
      (item) => item.rule === "path-not-in-allowed-files",
    ),
    JSON.stringify(posixResult.reasons),
  );
});

// No approval screen was captured, so these choices and keys are synthetic.
const KEY = { name: "Enter", send: { text: "", enter: true } };
const ONCE = { label: "Allow this request", grant: "once", key: KEY };
const ALWAYS = {
  label: "Allow every request in this session",
  grant: "always",
  key: { name: "Down", send: { text: "\u001b[B", enter: false } },
};
const DENY = { label: "Reject", grant: "deny", key: KEY };
const decide = (overrides) =>
  decideApproval({
    request: { command: "npm test", cwd: SCOPE.worktree },
    choices: [ALWAYS, ONCE, DENY],
    selected: 1,
    scope: SCOPE,
    ...overrides,
  });

test("an approval inside the scope is allowed once with the key of the one-time choice", () => {
  const result = decide();
  assert.equal(result.kind, "approval");
  assert.equal(result.action, "send-key");
  assert.equal(result.key, KEY);
  assert.equal(result.reason, null);
  assert.equal(result.evidence.chosen, ONCE.label);
  assert.equal(result.evidence.scope.verdict, "allow");
  assert.deepEqual(result.evidence.selected, { index: 2, label: ONCE.label });
});

test("a choice that widens the grant is never picked", () => {
  // Only "always" and "deny" are offered: nothing is sent.
  const withoutOnce = decide({ choices: [ALWAYS, DENY] });
  assert.equal(withoutOnce.action, "escalate");
  assert.equal(withoutOnce.key, null);
  // A choice marked once but worded as a wider grant is not trusted.
  for (const label of [
    "Always allow",
    "Yes, and don't ask again",
    "Allow for this session",
    "이번 세션 동안 항상 허용",
    "Allow every time",
  ]) {
    const result = decide({ choices: [{ ...ONCE, label }, DENY], selected: 0 });
    assert.equal(result.action, "escalate", label);
    assert.equal(result.key, null, label);
  }
  // Two one-time choices cannot be told apart.
  assert.equal(
    decide({ choices: [ONCE, { ...ONCE, label: "Allow again" }] }).action,
    "escalate",
  );
  assert.notEqual(decide().key, ALWAYS.key);
  // With the always row selected, Enter would grant it, so nothing is sent.
  const onAlways = decide({ choices: [ONCE, ALWAYS], selected: 1 });
  assert.equal(onAlways.action, "escalate");
  assert.equal(onAlways.key, null);
});

test("an approval without a known selection, key or scope is not answered", () => {
  assert.equal(decide({ selected: undefined }).action, "escalate");
  assert.equal(decide({ selected: 9 }).action, "escalate");
  assert.equal(decide({ choices: undefined }).action, "escalate");
  const keyless = decide({
    choices: [ALWAYS, { label: ONCE.label, grant: "once" }, DENY],
  });
  assert.equal(keyless.action, "escalate");
  assert.equal(keyless.key, null);
  const undecided = decide({
    request: { command: "node other.mjs", cwd: SCOPE.worktree },
  });
  assert.equal(undecided.action, "escalate");
  assert.equal(undecided.key, null);
  assert.equal(undecided.evidence.scope.verdict, "escalate");
});

test("a forbidden approval is not answered whatever choices are offered", () => {
  for (const request of [
    { command: "git push origin main", cwd: SCOPE.worktree },
    { command: "git merge main", cwd: SCOPE.worktree },
    { command: "git reset --hard", cwd: SCOPE.worktree },
    { command: "npm test", cwd: "/Users/x/orca/p" },
    { paths: ["/Users/x/orca/workspaces/p/feat-b/src/a.mjs"] },
    { paths: ["~/.claude/settings.json"] },
  ]) {
    const result = decide({ request });
    assert.equal(result.action, "none", JSON.stringify(request));
    assert.equal(result.key, null, JSON.stringify(request));
    assert.equal(result.evidence.scope.verdict, "deny");
    assert.match(result.reason, /금지/);
  }
});

test("an approval is not answered when the selected choice is not the one-time choice", () => {
  // Enter would confirm whichever choice is selected, here "always".
  const onAlways = decide({ choices: [ONCE, ALWAYS, DENY], selected: 1 });
  assert.equal(onAlways.action, "escalate");
  assert.equal(onAlways.key, null);
  assert.deepEqual(onAlways.evidence.selected, {
    index: 2,
    label: ALWAYS.label,
  });
  assert.equal(
    decide({ choices: [ONCE, ALWAYS, DENY], selected: 2 }).action,
    "escalate",
  );
  const onOnce = decide({ choices: [ALWAYS, ONCE, DENY], selected: 1 });
  assert.equal(onOnce.action, "send-key");
  assert.equal(onOnce.key, KEY);
});

test("an approval key other than Enter, or a malformed one, is never sent", () => {
  const keys = {
    esc: { name: "Esc", send: { text: "\u001b", enter: false } },
    down: { name: "Down", send: { text: "\u001b[B", enter: false } },
    text: { name: "Enter", send: { text: "y", enter: true } },
    "no send": { name: "Enter" },
    "enter without newline": {
      name: "Enter",
      send: { text: "", enter: false },
    },
  };
  for (const [name, key] of Object.entries(keys)) {
    const result = decide({
      choices: [ALWAYS, { ...ONCE, key }, DENY],
      selected: 1,
    });
    assert.equal(result.action, "escalate", name);
    assert.equal(result.key, null, name);
  }
});

test("a trust question is not answered without the role's worktree, except Agy's existing path", () => {
  for (const name of [
    "codex-0.155.1-folder-trust-default",
    "claude-2.1.278-folder-trust-default",
    "claude-2.1.278-folder-trust-changed",
  ]) {
    const result = classifyPromptScreen(screen(name));
    assert.equal(result.kind, "trust", name);
    assert.equal(result.action, "none", name);
    assert.equal(result.key, null, name);
    assert.match(result.reason, /워크트리/, name);
    assert.equal(
      classifyPromptScreen(screen(name), { cli: fixtures[name].cli }).action,
      "none",
      name,
    );
  }
  // trustQuestion has never known the worktree, so Agy still answers without it.
  assert.equal(
    classifyPromptScreen(screen("agy-1.2.7-folder-trust-default")).action,
    "send-key",
  );
});

test("a check command split over lines is not the check command", () => {
  for (const command of [
    "npm\ntest",
    "npm run\nformat",
    "npm\r\ntest",
    "npm run\r\n\r\nformat",
  ]) {
    const result = at({ command });
    assert.equal(result.verdict, "escalate", JSON.stringify(command));
    assert.ok(
      !result.passed.some((item) => item.startsWith("check-command")),
      JSON.stringify(command),
    );
  }
  // Spaces and tabs between words are still the same command.
  assert.equal(at({ command: "npm\trun  format" }).verdict, "allow");
  assert.equal(at({ command: "npm test\n" }).verdict, "allow");
});

test("a trust question still on the screen is visible even when it is no longer answerable", () => {
  // The old check read the question text and the selected row anywhere, and
  // only the Agy capture has both, so that is the screen it can be shown on.
  const live = screen("agy-1.2.7-folder-trust-default");
  assert.equal(trustQuestionVisible(live), true);
  // Lines drawn below the choices make it unanswerable but not gone.
  const below = [...live, "  something drawn below the question"];
  assert.equal(classifyPromptScreen(below, { cli: "agy" }).action, "none");
  assert.equal(trustQuestionVisible(below), true);
  // The question text alone, or the selected row alone, is not the question.
  assert.equal(
    trustQuestionVisible(live.filter((line) => !/Do you trust/.test(line))),
    false,
  );
  assert.equal(
    trustQuestionVisible(
      swap(live, "> Yes, I trust this folder", "  Yes, I trust this folder"),
    ),
    false,
  );
  assert.equal(trustQuestionVisible(undefined), false);
});
