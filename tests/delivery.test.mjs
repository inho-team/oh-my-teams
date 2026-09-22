/** Delivering a kickoff into the project that owns it, and nothing else merging there. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, writeJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  listKickoffs,
  registerKickoff,
  releaseKickoff,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";
import {
  deliverKickoff,
  kickoffOwner,
} from "../plugins/oh-my-teams/scripts/delivery.mjs";
import { main } from "../plugins/oh-my-teams/scripts/teams-org.mjs";

const exampleOrg = path.resolve(
  "plugins/oh-my-teams/examples/organization.json",
);

async function git(cwd, ...args) {
  const result = await run(["git", ...args], { cwd });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

// A project on main that owns an organization, and one kickoff worktree with
// a committed result, like literacy-test's report branch.

import { after } from "node:test";
let templateProjectDir = null;
after(() => {
  if (templateProjectDir) {
    try {
      fs.rmSync(templateProjectDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
      });
    } catch (e) {}
  }
});
async function getTemplateProject() {
  if (templateProjectDir) return templateProjectDir;
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "omt-template-")),
  );
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  await git(project, "init", "-q", "-b", "main");
  await git(project, "config", "user.email", "t@example.invalid");
  await git(project, "config", "user.name", "t");
  fs.writeFileSync(path.join(project, ".gitignore"), ".omt\n");
  fs.writeFileSync(path.join(project, "README.md"), "base\n");
  await git(project, "add", ".");
  await git(project, "commit", "-q", "-m", "base");
  templateProjectDir = project;
  return templateProjectDir;
}

async function kickoffProject(
  t,
  delivery = { mode: "local-merge", branch: "main" },
) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "omt-deliver-")),
  );
  t.after(() =>
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    }),
  );
  const project = path.join(root, "project");
  fs.cpSync(await getTemplateProject(), project, { recursive: true });
  const org = path.join(project, ".omt", "organization.json");
  fs.mkdirSync(path.dirname(org), { recursive: true });
  fs.copyFileSync(exampleOrg, org);
  const brief = path.join(project, ".omt", "brief.md");
  fs.writeFileSync(brief, "전달 범위: main에 커밋한다.\n");

  const worktree = path.join(root, "kick");
  await git(project, "worktree", "add", "-q", "-b", "kick", worktree);
  fs.mkdirSync(path.join(worktree, "docs"));
  fs.writeFileSync(path.join(worktree, "docs", "report.md"), "report\n");
  await git(worktree, "add", ".");
  await git(worktree, "commit", "-q", "-m", "report");
  const head = await git(worktree, "rev-parse", "HEAD");

  const worktreeId = `repo::${worktree}`;
  registerKickoff(org, {
    goal: "write the report",
    pm: {
      worktreeId,
      path: worktree,
      stateDir: path.join(worktree, ".omt"),
    },
    organizationRevision: JSON.parse(fs.readFileSync(org, "utf8")).revision,
    brief,
    delivery,
  });
  return { project, org, worktree, worktreeId, head };
}

test("a claim records how the brief delivers, and a branch where one is merged", async (t) => {
  const fixture = await kickoffProject(t);
  const [entry] = listKickoffs(fixture.org).kickoffs;
  assert.deepEqual(entry.delivery, { mode: "local-merge", branch: "main" });
  const claim = (delivery) => ({
    goal: "another goal",
    pm: {
      worktreeId: "wt-2",
      path: path.join(fixture.project, "..", "wt-2"),
      stateDir: "/tmp/wt-2/.omt",
    },
    organizationRevision: entry.organizationRevision,
    brief: entry.brief,
    delivery,
  });
  assert.throws(
    () => registerKickoff(fixture.org, claim(undefined)),
    /delivery\.mode must be one of/,
  );
  assert.throws(
    () => registerKickoff(fixture.org, claim({ mode: "local-merge" })),
    /delivery\.branch required/,
  );
  assert.throws(
    () => registerKickoff(fixture.org, claim({ mode: "pull-request" })),
    /delivery\.branch required/,
  );
  assert.deepEqual(
    registerKickoff(fixture.org, claim({ mode: "none", branch: "ignored" }))
      .entry.delivery,
    { mode: "none" },
  );
});

test("deliver merges the verified head into the owner branch once", async (t) => {
  const fixture = await kickoffProject(t);
  const options = {
    orgFile: fixture.org,
    worktreeId: fixture.worktreeId,
    source: fixture.worktree,
    head: fixture.head,
  };
  let gated;
  const delivered = await deliverKickoff({
    ...options,
    gate: async (input) => {
      gated = input;
    },
  });
  // The gates run against the source, compared with the owner branch.
  assert.deepEqual(gated, { source: fixture.worktree, base: "main" });
  assert.equal(delivered.merged, true);
  assert.equal(delivered.head, fixture.head);
  assert.equal(
    await git(fixture.project, "rev-parse", "HEAD"),
    delivered.mergeCommit,
  );
  assert.equal(await git(fixture.project, "rev-parse", "HEAD^2"), fixture.head);
  assert.ok(fs.existsSync(path.join(fixture.project, "docs", "report.md")));
  assert.equal(
    listKickoffs(fixture.org).kickoffs[0].delivered.mergeCommit,
    delivered.mergeCommit,
  );

  // Running close again does not merge twice.
  const again = await deliverKickoff(options);
  assert.equal(again.merged, false);
  assert.equal(again.mergeCommit, delivered.mergeCommit);
  assert.equal(
    await git(fixture.project, "rev-parse", "HEAD"),
    delivered.mergeCommit,
  );
  assert.equal(
    releaseKickoff(fixture.org, {
      worktreeId: fixture.worktreeId,
      reason: "completed",
    }).released,
    true,
  );
});

test("deliver refuses a moved head, an unready owner, and a conflict", async (t) => {
  const fixture = await kickoffProject(t);
  const options = {
    orgFile: fixture.org,
    worktreeId: fixture.worktreeId,
    source: fixture.worktree,
    head: fixture.head,
  };
  const base = await git(fixture.project, "rev-parse", "HEAD");

  // A commit after verification is not what the gates passed.
  fs.writeFileSync(
    path.join(fixture.worktree, "docs", "report.md"),
    "edited\n",
  );
  await git(fixture.worktree, "commit", "-qam", "late edit");
  await assert.rejects(deliverKickoff(options), /not the verified/);
  await git(fixture.worktree, "reset", "-q", "--hard", fixture.head);

  // The owner must be on the brief's branch with nothing uncommitted.
  fs.writeFileSync(path.join(fixture.project, "README.md"), "uncommitted\n");
  await assert.rejects(deliverKickoff(options), /uncommitted changes/);
  await git(fixture.project, "checkout", "-q", "--", "README.md");
  await git(fixture.project, "checkout", "-q", "-b", "other");
  await assert.rejects(deliverKickoff(options), /is on other, not main/);
  await git(fixture.project, "checkout", "-q", "main");

  // A conflicting merge is aborted and leaves main where it was.
  fs.mkdirSync(path.join(fixture.project, "docs"));
  fs.writeFileSync(
    path.join(fixture.project, "docs", "report.md"),
    "owner's own\n",
  );
  await git(fixture.project, "add", ".");
  await git(fixture.project, "commit", "-qm", "owner edit");
  const before = await git(fixture.project, "rev-parse", "HEAD");
  assert.notEqual(before, base);
  await assert.rejects(deliverKickoff(options), /failed and was aborted/);
  assert.equal(await git(fixture.project, "rev-parse", "HEAD"), before);
  assert.equal(
    await git(fixture.project, "status", "--porcelain", "--untracked-files=no"),
    "",
  );
  assert.equal(listKickoffs(fixture.org).kickoffs[0].delivered, undefined);

  // Completing without the merge the brief asked for needs the user's decision.
  assert.throws(
    () =>
      releaseKickoff(fixture.org, {
        worktreeId: fixture.worktreeId,
        reason: "completed",
      }),
    /which deliver has not recorded/,
  );
  assert.equal(
    releaseKickoff(fixture.org, {
      worktreeId: fixture.worktreeId,
      reason: "completed",
      force: true,
    }).released,
    true,
  );
});

test("deliver merges only what the brief authorized", async (t) => {
  for (const [delivery, refusal] of [
    [{ mode: "pull-request", branch: "main" }, /pull request against main/],
    [{ mode: "none" }, /no delivery into the project/],
  ]) {
    const fixture = await kickoffProject(t, delivery);
    await assert.rejects(
      deliverKickoff({
        orgFile: fixture.org,
        worktreeId: fixture.worktreeId,
        source: fixture.worktree,
        head: fixture.head,
      }),
      refusal,
    );
    assert.equal(
      await git(fixture.project, "rev-list", "--count", "HEAD"),
      "1",
    );
    // A kickoff delivered another way is not held back from completing.
    assert.equal(
      releaseKickoff(fixture.org, {
        worktreeId: fixture.worktreeId,
        reason: "completed",
      }).released,
      true,
    );
  }
});

test("no gate or role other than deliver uses the owning checkout", async (t) => {
  const fixture = await kickoffProject(t);
  assert.equal(kickoffOwner(fixture.project), fixture.project);
  // A kickoff worktree keeps no registry, so it is never taken for the owner.
  assert.equal(kickoffOwner(fixture.worktree), null);
  const missing = path.join(fixture.project, "missing.json");
  const owned = /owns running kickoffs/;
  await assert.rejects(
    main([
      "merge-check",
      "--evidence",
      missing,
      "--task",
      missing,
      "--repo",
      fixture.project,
      "--base",
      "main",
    ]),
    owned,
  );
  // In the kickoff's own worktree merge-check goes on to read its inputs.
  await assert.rejects(
    main([
      "merge-check",
      "--evidence",
      missing,
      "--task",
      missing,
      "--repo",
      fixture.worktree,
      "--base",
      "main",
    ]),
    (error) => !owned.test(error.message),
  );
  await assert.rejects(
    main([
      "role-terminal",
      "--org",
      fixture.org,
      "--role",
      "junior",
      "--worktree",
      `path:${fixture.project}`,
    ]),
    owned,
  );
  await assert.rejects(
    main([
      "worker-start",
      "--org",
      fixture.org,
      "--role",
      "senior",
      "--repo",
      fixture.project,
      "--spec",
      "x",
      "--terminal",
      "term_1",
    ]),
    owned,
  );

  // Through the CLI, deliver runs merge-check on the source before merging.
  const evidence = path.join(fixture.worktree, "evidence.json");
  writeJSON(evidence, { schemaVersion: 1, status: "failed" });
  const task = path.join(fixture.worktree, "task.json");
  fs.copyFileSync(path.resolve("plugins/oh-my-teams/examples/task.json"), task);
  await assert.rejects(
    main([
      "deliver",
      "--org",
      fixture.org,
      "--worktree",
      fixture.worktreeId,
      "--source",
      fixture.worktree,
      "--head",
      fixture.head,
      "--evidence",
      evidence,
      "--task",
      task,
    ]),
    /Evidence did not pass/,
  );
  assert.equal(await git(fixture.project, "rev-list", "--count", "HEAD"), "1");
});

test("the lifecycle documents keep the owner merge in close alone", () => {
  const read = (file) =>
    fs.readFileSync(path.resolve("plugins/oh-my-teams", file), "utf8");
  const close = read("skills/close/SKILL.md");
  // close merged by a single "if the user allowed it" rule that did not tell
  // a merge between kickoff worktrees from the one into the owning project.
  assert.match(close, /node <runtime> deliver --org/);
  assert.match(close, /주인 체크아웃/);
  assert.match(close, /`local-merge`/);
  assert.match(read("skills/kickoff/SKILL.md"), /등록 요청의 `delivery`/);
  assert.match(
    read("references/kickoff-registry.md"),
    /## 주인 체크아웃과 병합/,
  );
  for (const skill of ["skills/pm/SKILL.md", "skills/pl/SKILL.md"]) {
    assert.match(read(skill), /주인 체크아웃\)에는 커밋하거나 병합하지 않/);
  }
});

test("kickoffProject creates isolated projects using the template", async (t) => {
  const fixture1 = await kickoffProject(t);
  const fixture2 = await kickoffProject(t);
  assert.notEqual(fixture1.project, fixture2.project);

  const git1 = await git(fixture1.project, "log", "-1", "--format=%s");
  const git2 = await git(fixture2.project, "log", "-1", "--format=%s");
  assert.equal(git1, "base");
  assert.equal(git2, "base");

  fs.writeFileSync(path.join(fixture1.project, "isolate.txt"), "isolate");
  assert.ok(!fs.existsSync(path.join(fixture2.project, "isolate.txt")));
});
