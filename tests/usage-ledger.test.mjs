/** Test suite for usage ledger appending and reading. */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recordLaunch,
  readLaunches,
  resolveLaunchKickoff,
} from "../plugins/oh-my-teams/scripts/usage-ledger.mjs";

test("P-09: readLaunches and recordLaunch", () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-ledger-"));
  const orgFile = path.join(tmpdir, "organization.json");
  recordLaunch(orgFile, { role: "senior", via: "role-terminal" });
  const launches = readLaunches(orgFile);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].role, "senior");
  assert.equal(launches[0].via, "role-terminal");
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

test("P-09: resolveLaunchKickoff", () => {
  const kickoffs = [
    { pm: { worktreeId: "wt-1", stateDir: "/state/wt1", path: "/pm/wt1" } },
    { pm: { worktreeId: "wt-2", stateDir: "/state/wt2", path: "/pm/wt2" } },
  ];

  assert.equal(
    resolveLaunchKickoff(kickoffs, [], {
      stateDir: "/state/wt1",
      callerCwd: "/other",
    }),
    "wt-1",
  );

  assert.equal(
    resolveLaunchKickoff(kickoffs, [], {
      stateDir: "/state/wt3",
      callerCwd: "/pm/wt2/sub",
    }),
    "wt-2",
  );
});
