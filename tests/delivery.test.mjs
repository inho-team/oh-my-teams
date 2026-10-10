/** Delivering a kickoff into the project that owns it, and nothing else merging there. */
import { after } from "node:test";
import { cloneTemplateProject, cleanupTemplates } from "./template-factory.mjs";
after(() => cleanupTemplates());
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUDITOR_ROLE,
  run,
  writeJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  listKickoffs,
  recordAuditorLaunch,
  registerKickoff,
  releaseKickoff,
} from "../plugins/oh-my-teams/scripts/kickoff-registry.mjs";
import {
  deliverKickoff,
  kickoffOwner,
} from "../plugins/oh-my-teams/scripts/delivery.mjs";
import {
  requirementsFidelity,
  requirementsFidelityConfirm,
} from "../plugins/oh-my-teams/scripts/requirements.mjs";
import {
  auditAccept,
  auditChecked,
  auditObjection,
} from "../plugins/oh-my-teams/scripts/audit.mjs";
import { recordLaunch } from "../plugins/oh-my-teams/scripts/usage-ledger.mjs";
import {
  deliveryRefDocId,
  resolveKickoffHash,
  saveDocument,
} from "../plugins/oh-my-teams/scripts/documents.mjs";
import { main } from "../plugins/oh-my-teams/scripts/teams-org.mjs";
import { minimalRequirements } from "./requirements-draft-fixture.mjs";
import { acceptTaskThroughRuntime } from "./accepted-workflow-fixture.mjs";
import { acceptWorkflowIntegration } from "../plugins/oh-my-teams/scripts/workflow.mjs";

const exampleOrg = path.resolve(
  "plugins/oh-my-teams/examples/organization.json",
);

async function git(cwd, ...args) {
  const result = await run(["git", ...args], { cwd });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

// These tests are about delivery, not the requirements ledger (which has its
// own tests), so every claim carries the smallest ledger that passes
// validateLedgerForClaim: one equal-scope criterion needs no user
// confirmation and so no director. kickoffProject drives it to close-ready
// (a director-confirmed fidelity check covering s1/c1 as "met") right after
// registering, since assertKickoffCloseReady now runs unconditionally inside
// deliverKickoff/releaseKickoff.
// A project on main that owns an organization, and one kickoff worktree with
// a committed result, like literacy-test's report branch.

async function kickoffProject(
  t,
  delivery = { mode: "local-merge", branch: "main" },
  { auditor } = {},
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
  await cloneTemplateProject(project);
  const org = path.join(project, ".omt", "organization.json");
  fs.mkdirSync(path.dirname(org), { recursive: true });
  fs.copyFileSync(exampleOrg, org);
  // D1: registerKickoff pins auditPolicy from organizationAtClaim.auditor at
  // claim time, with no later live-organization.json fallback, so a caller
  // wanting an audited kickoff must set org.auditor here, before
  // registerKickoff runs below, not by mutating the org file afterward.
  if (auditor !== undefined) {
    const orgConfig = JSON.parse(fs.readFileSync(org, "utf8"));
    orgConfig.auditor = auditor;
    fs.writeFileSync(org, JSON.stringify(orgConfig, null, 2));
  }
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
    requirements: minimalRequirements(org, worktreeId),
    // validateLedgerForClaim requires a registered director unconditionally,
    // even for this equal-only ledger. The checkout is the test process's own
    // cwd so releaseKickoff's director-authority check passes without
    // --force.
    director: {
      terminalHandle: `term_director_${worktreeId}`,
      checkoutPath: process.cwd(),
    },
  });
  await requirementsFidelity(org, worktreeId, {
    head,
    repo: worktree,
    recordedBy: "pm",
    items: [
      { type: "statement", id: "s1", status: "met", evidence: "report.md" },
      { type: "criterion", id: "c1", status: "met", evidence: "report.md" },
    ],
  });
  await requirementsFidelityConfirm(org, worktreeId, process.cwd());
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
    requirements: minimalRequirements(fixture.org, "wt-2"),
    director: {
      terminalHandle: "term_director_wt-2",
      checkoutPath: process.cwd(),
    },
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

  // Save the delivery-ref document before releasing
  const kickoffHash = resolveKickoffHash(fixture.org, fixture.worktreeId);
  const docId = deliveryRefDocId(kickoffHash, delivered.mergeCommit);
  const entry = listKickoffs(fixture.org).kickoffs[0];
  saveDocument(entry.pm.stateDir, {
    schemaVersion: 1,
    docId,
    stage: "delivery",
    kickoffId: kickoffHash,
    workflowId: null,
    revision: 1,
    state: "resolved",
    author: { role: "pm", executionId: "exec-1" },
    createdAt: new Date().toISOString(),
    basedOnRevision: null,
    reason: "delivery recorded",
    deliveredCommit: delivered.mergeCommit,
  });

  assert.equal(
    (
      await releaseKickoff(fixture.org, {
        worktreeId: fixture.worktreeId,
        reason: "completed",
      })
    ).released,
    true,
  );
});

test("a later delivery preserves the earlier merge and refuses a stale stage", async (t) => {
  const fixture = await kickoffProject(t);
  const options = {
    orgFile: fixture.org,
    worktreeId: fixture.worktreeId,
    source: fixture.worktree,
    head: fixture.head,
  };
  const first = await deliverKickoff(options);
  const ownerAfterFirst = await git(fixture.project, "rev-parse", "HEAD");

  // A new commit on the old branch cannot replace the first delivered result.
  fs.writeFileSync(path.join(fixture.worktree, "docs", "later.md"), "stale\n");
  await git(fixture.worktree, "add", ".");
  await git(fixture.worktree, "commit", "-qm", "stale continuation");
  const staleHead = await git(fixture.worktree, "rev-parse", "HEAD");
  // The lineage check (entry.delivered.mergeCommit must be staleHead's
  // ancestor) runs only after assertKickoffCloseReady's fidelity gate, so
  // this counterexample must first clear that gate for staleHead too — the
  // rejection under test is lineage, not missing evidence.
  await requirementsFidelity(fixture.org, fixture.worktreeId, {
    head: staleHead,
    repo: fixture.worktree,
    recordedBy: "pm",
    items: [
      { type: "statement", id: "s1", status: "met", evidence: "report.md" },
      { type: "criterion", id: "c1", status: "met", evidence: "report.md" },
    ],
  });
  await requirementsFidelityConfirm(
    fixture.org,
    fixture.worktreeId,
    process.cwd(),
  );
  await assert.rejects(
    deliverKickoff({ ...options, head: staleHead }),
    /does not contain previous merge/,
  );
  assert.equal(
    await git(fixture.project, "rev-parse", "HEAD"),
    ownerAfterFirst,
  );
  assert.equal(
    listKickoffs(fixture.org).kickoffs[0].deliveryHistory,
    undefined,
  );

  await git(
    fixture.worktree,
    "merge",
    "--no-ff",
    "-qm",
    "integrate main",
    "main",
  );
  fs.writeFileSync(
    path.join(fixture.worktree, "docs", "later.md"),
    "current\n",
  );
  await git(fixture.worktree, "commit", "-qam", "finish continuation");
  const nextHead = await git(fixture.worktree, "rev-parse", "HEAD");
  await requirementsFidelity(fixture.org, fixture.worktreeId, {
    head: nextHead,
    repo: fixture.worktree,
    recordedBy: "pm",
    items: [
      { type: "statement", id: "s1", status: "met", evidence: "report.md" },
      { type: "criterion", id: "c1", status: "met", evidence: "report.md" },
    ],
  });
  await requirementsFidelityConfirm(
    fixture.org,
    fixture.worktreeId,
    process.cwd(),
  );
  let gateCalls = 0;
  const second = await deliverKickoff({
    ...options,
    head: nextHead,
    gate: async () => {
      gateCalls += 1;
    },
  });
  assert.equal(second.merged, true);
  assert.equal(gateCalls, 1);
  assert.equal(
    await git(fixture.project, "rev-parse", "HEAD"),
    second.mergeCommit,
  );
  assert.equal(await git(fixture.project, "rev-parse", "HEAD^2"), nextHead);
  const [entry] = listKickoffs(fixture.org).kickoffs;
  assert.deepEqual(entry.deliveryHistory, [
    {
      head: first.head,
      mergeCommit: first.mergeCommit,
      at: entry.deliveryHistory[0].at,
    },
  ]);
  assert.equal(entry.delivered.head, nextHead);
  assert.equal(entry.delivered.mergeCommit, second.mergeCommit);
  assert.equal(
    (await deliverKickoff({ ...options, head: nextHead })).merged,
    false,
  );
  assert.deepEqual(
    listKickoffs(fixture.org).kickoffs[0].deliveryHistory,
    entry.deliveryHistory,
  );
});

// #139 counterexamples: deliverKickoff's early-return branch
// (`entry.delivered?.head === head`, line 209 in delivery.mjs) sits AFTER
// `assertKickoffCloseReady` (line 196), so redelivery — same head or a new
// one — always re-runs the ledger/audit gate rather than skipping it. These
// two tests exercise that ordering directly, one gate at a time.
test("deliver refuses a redelivery whose new head has no confirmed fidelity check (evidence gate is not skipped on redelivery)", async (t) => {
  const fixture = await kickoffProject(t);
  const options = {
    orgFile: fixture.org,
    worktreeId: fixture.worktreeId,
    source: fixture.worktree,
    head: fixture.head,
  };
  const first = await deliverKickoff(options);
  assert.equal(first.merged, true);

  // A new commit lands, but no requirementsFidelity/requirementsFidelityConfirm
  // is ever recorded for it: the user-evidence checkpoint for this head is missing.
  await git(
    fixture.worktree,
    "merge",
    "--no-ff",
    "-qm",
    "integrate main",
    "main",
  );
  fs.writeFileSync(
    path.join(fixture.worktree, "docs", "report.md"),
    "undisclosed change\n",
  );
  await git(fixture.worktree, "commit", "-qam", "undisclosed change");
  const undisclosedHead = await git(fixture.worktree, "rev-parse", "HEAD");

  await assert.rejects(
    deliverKickoff({ ...options, head: undisclosedHead }),
    /No director-confirmed fidelity check exists/,
  );
  // Nothing merged: the owner branch stays exactly at the first delivery.
  assert.equal(
    await git(fixture.project, "rev-parse", "HEAD"),
    first.mergeCommit,
  );
  assert.equal(
    listKickoffs(fixture.org).kickoffs[0].delivered.head,
    fixture.head,
  );
});

test(
  "deliver refuses a same-head redelivery of an auditor-pinned kickoff once its earlier valid " +
    "brief-audit acceptance is invalidated by a new objection (early return does not skip the audit gate)",
  async (t) => {
    // D1: the auditor requirement must come from this kickoff's auditPolicy,
    // pinned at claim time, not a live organization.json read — so org.auditor
    // is set here, before kickoffProject's registerKickoff call, rather than
    // mutated onto the org file after the first delivery. Because that policy
    // can never be relaxed afterward, proving the redelivery gate still runs
    // now needs a brief-audit acceptance that was valid for the first delivery
    // and is invalidated afterward, rather than one simply never recorded.
    const fixture = await kickoffProject(
      t,
      { mode: "local-merge", branch: "main" },
      { auditor: { profile: "claude-current" } },
    );
    const [entry] = listKickoffs(fixture.org, fixture.worktreeId).kickoffs;
    const auditorHandle = `term_auditor_${fixture.worktreeId}`;
    recordLaunch(fixture.org, {
      via: "role-terminal",
      role: AUDITOR_ROLE,
      terminal: auditorHandle,
      stateDir: entry.pm.stateDir,
    });
    recordAuditorLaunch(fixture.org, {
      worktreeId: fixture.worktreeId,
      terminalHandle: auditorHandle,
      path: fixture.project,
    });

    const previousHandle = process.env.ORCA_TERMINAL_HANDLE;
    process.env.ORCA_TERMINAL_HANDLE = auditorHandle;
    t.after(() => {
      if (previousHandle === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
      else process.env.ORCA_TERMINAL_HANDLE = previousHandle;
    });
    await auditChecked(fixture.org, fixture.worktreeId, "brief", [
      { type: "statement", id: "s1" },
      { type: "criterion", id: "c1" },
    ]);
    await auditAccept(
      fixture.org,
      fixture.worktreeId,
      "brief",
      undefined,
      undefined,
    );
    // The result repository is fixed by a workflow accepted through the
    // runtime path (Appendix G): task acceptance, then workflow-accept.
    const staged = await acceptTaskThroughRuntime({
      org: fixture.org,
      stateDir: entry.pm.stateDir,
      taskDir: fixture.worktree,
      workflowId: "wf-redelivery",
      resultRepo: fixture.worktree,
    });
    await acceptWorkflowIntegration(
      staged.stateDir,
      staged.workflowId,
      staged.revision,
    );
    await auditChecked(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      [
        { type: "statement", id: "s1" },
        { type: "criterion", id: "c1" },
      ],
      undefined,
      fixture.head,
      fixture.worktree,
    );
    await auditAccept(
      fixture.org,
      fixture.worktreeId,
      "outcome",
      fixture.head,
      fixture.worktree,
    );

    const options = {
      orgFile: fixture.org,
      worktreeId: fixture.worktreeId,
      source: fixture.worktree,
      head: fixture.head,
    };
    const first = await deliverKickoff(options);
    assert.equal(first.merged, true);

    // A new brief-checkpoint objection raised after acceptance makes the
    // acceptance recorded above no longer valid (tests/auditor.test.mjs's
    // "hasValidAcceptance refuses once a new unresolved objection is raised
    // after acceptance" proves the same mechanism for the outcome checkpoint).
    await auditObjection(fixture.org, fixture.worktreeId, {
      checkpoint: "brief",
      target: { type: "criterion", id: "c1" },
      kind: "gap",
      description: "criterion c1 needs a second look",
      rebuttalRequested: "point to where it is met",
    });

    // Same head as the first, successful delivery: this is exactly the
    // `entry.delivered?.head === head` branch that returns early. If that
    // early return ran before the gate, this call would wrongly succeed
    // despite the now-unresolved objection raised above.
    await assert.rejects(
      deliverKickoff(options),
      /Brief audit acceptance is missing or no longer valid/,
    );
    assert.equal(
      await git(fixture.project, "rev-parse", "HEAD"),
      first.mergeCommit,
    );
    assert.equal(
      listKickoffs(fixture.org).kickoffs[0].delivered.head,
      fixture.head,
    );
  },
);

test("deliver ignores an auditor the organization adopts after this kickoff already claimed with none pinned (no live-organization.json fallback, D1)", async (t) => {
  const fixture = await kickoffProject(t);
  const options = {
    orgFile: fixture.org,
    worktreeId: fixture.worktreeId,
    source: fixture.worktree,
    head: fixture.head,
  };
  const first = await deliverKickoff(options);
  assert.equal(first.merged, true);

  // This kickoff's auditPolicy was pinned as auditorConfigured: false at
  // claim time, before org.auditor below was ever set. Mutating the live
  // organization.json afterward must not retroactively impose an audit
  // obligation this kickoff never took on (director decision
  // msg_0b114271f1f5): there is no live-read fallback, only the pinned
  // policy, so a same-head redelivery still succeeds instead of being
  // refused for a missing brief-audit acceptance.
  const org = JSON.parse(fs.readFileSync(fixture.org, "utf8"));
  org.auditor = { profile: "claude-current" };
  fs.writeFileSync(fixture.org, JSON.stringify(org, null, 2));

  const second = await deliverKickoff(options);
  assert.equal(second.merged, false);
  assert.equal(second.head, fixture.head);
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
  await assert.rejects(
    releaseKickoff(fixture.org, {
      worktreeId: fixture.worktreeId,
      reason: "completed",
      head: fixture.head,
    }),
    /which deliver has not recorded/,
  );
  assert.equal(
    (
      await releaseKickoff(fixture.org, {
        worktreeId: fixture.worktreeId,
        reason: "completed",
        head: fixture.head,
        force: true,
      })
    ).released,
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
      (
        await releaseKickoff(fixture.org, {
          worktreeId: fixture.worktreeId,
          reason: "completed",
          head: fixture.head,
          repo: fixture.worktree,
        })
      ).released,
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
