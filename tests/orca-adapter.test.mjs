/** selectTrustedOrcaExecutable: the fixed, per-platform executable choice identity confirmation and auditor launch trust (B.6, decision B). */
import test from "node:test";
import assert from "node:assert/strict";
import { selectTrustedOrcaExecutable } from "../plugins/oh-my-teams/scripts/orca-adapter.mjs";

test("selectTrustedOrcaExecutable returns the first injected candidate that exists", () => {
  const found = selectTrustedOrcaExecutable({
    candidates: ["/missing/orca", "/real/orca"],
    exists: (candidate) => candidate === "/real/orca",
  });
  assert.equal(found, "/real/orca");
});

test("selectTrustedOrcaExecutable prefers an earlier candidate over a later one that also exists", () => {
  const found = selectTrustedOrcaExecutable({
    candidates: ["/first/orca", "/second/orca"],
    exists: () => true,
  });
  assert.equal(found, "/first/orca");
});

test("selectTrustedOrcaExecutable throws, without falling back to any other selection, when no candidate exists", () => {
  assert.throws(
    () =>
      selectTrustedOrcaExecutable({
        platform: "darwin",
        candidates: ["/missing/orca"],
        exists: () => false,
      }),
    /No trusted Orca executable found for platform "darwin"/,
  );
});

test("selectTrustedOrcaExecutable throws for a platform with no known trusted path, rather than guess one", () => {
  assert.throws(
    () =>
      selectTrustedOrcaExecutable({
        platform: "win32",
        exists: () => true,
      }),
    /No trusted Orca executable found for platform "win32"/,
  );
  assert.throws(
    () =>
      selectTrustedOrcaExecutable({
        platform: "linux",
        exists: () => true,
      }),
    /No trusted Orca executable found for platform "linux"/,
  );
});

// The error message is the only channel this function has to explain a
// fail-closed refusal, so it must name the reason (no fallback exists),
// not just that the search failed.
test("selectTrustedOrcaExecutable's error explains it refuses --orca/ORCA_CLI_COMMAND/ORCA_DEV_REPO_ROOT/PATH fallback rather than guess", () => {
  assert.throws(
    () =>
      selectTrustedOrcaExecutable({
        platform: "darwin",
        candidates: [],
        exists: () => true,
      }),
    /--orca, ORCA_CLI_COMMAND, ORCA_DEV_REPO_ROOT, or PATH/,
  );
});

// darwin's real, built-in candidate list (no injected `candidates`) is
// exercised with an injected `exists`, so this stays independent of whatever
// Orca install (if any) the machine running this test actually has.
test("selectTrustedOrcaExecutable's real darwin candidate list includes /usr/local/bin/orca", () => {
  const found = selectTrustedOrcaExecutable({
    platform: "darwin",
    exists: (candidate) => candidate === "/usr/local/bin/orca",
  });
  assert.equal(found, "/usr/local/bin/orca");
});

// Production callers (audit.mjs's verifiedPm, teams-org.mjs's auditor
// role-terminal launch) must never pass `candidates`/`exists`: this only
// confirms the real, unpatched `existsSync` is what a call with no options
// consults, i.e. that a caller cannot silently disable the disk check.
test("selectTrustedOrcaExecutable with no options consults the real filesystem, not a fixed answer", () => {
  assert.throws(() =>
    selectTrustedOrcaExecutable({
      platform: "darwin",
      candidates: ["/nonexistent/path/for/omt-orca-adapter-test/orca"],
    }),
  );
});
