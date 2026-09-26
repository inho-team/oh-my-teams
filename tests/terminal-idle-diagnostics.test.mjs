/** Tests for terminal idle check with diagnostic information. */
import assert from "assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkTerminalIdle } from "../plugins/oh-my-teams/scripts/orca-adapter.mjs";
import { main } from "../plugins/oh-my-teams/scripts/teams-org.mjs";
import { readJSON, writeJSON } from "../plugins/oh-my-teams/scripts/core.mjs";

function reply(data) {
  return {
    code: 0,
    stdout: JSON.stringify({ ok: true, result: data }),
  };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-idle-diag-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A minimal Orca stand-in for CLI-level tests: it never signs the tui-idle
// wait it is asked for, then answers `terminal read --screen` and
// `terminal list` with the shape `orca terminal read --screen --json`
// actually returns (confirmed against a live shell terminal before writing
// this fixture), so the diagnostics path is exercised against a real shape
// rather than an invented one.
// `--orca` names one executable, and Windows cannot spawn this shebang
// script without a shell, so the two CLI-path tests stay POSIX only. The
// diagnostics they print are built by the adapter tests in this file, which inject
// `execute` and run on every platform.
const posixOnly = {
  skip: process.platform === "win32" && "the fake Orca is a POSIX script",
};

function writeFakeOrca(dir, terminal) {
  const file = path.join(dir, "fake-orca.mjs");
  fs.writeFileSync(
    file,
    `#!${process.execPath}
const argv = process.argv.slice(2);
function reply(result, code) {
  process.stdout.write(JSON.stringify({ ok: code !== 1, result }));
  process.exit(code ?? 0);
}
if (argv[0] === "--version") {
  process.stdout.write("1.4.210\\n");
} else if (argv[0] === "skills" && argv[1] === "get") {
  process.stdout.write(JSON.stringify({ ok: true, result: { guide: "" } }));
} else if (argv[0] === "status") {
  reply({ runtime: { reachable: true, state: "ready", appVersion: "1.4.210" } });
} else if (argv[0] === "terminal" && argv[1] === "wait") {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: { code: "timeout", message: "not idle" },
  }));
  process.exit(1);
} else if (argv[0] === "terminal" && argv[1] === "read") {
  reply({
    terminal: {
      source: "screen",
      tail: ["Welcome to the Antigravity CLI.", "You are not signed in.", "> "],
    },
  });
} else if (argv[0] === "terminal" && argv[1] === "list") {
  reply({
    terminals: [
      {
        handle: "${terminal}",
        agentIdentity: "agy",
        status: "running",
        lastOutputAt: "2026-09-26T00:00:00Z",
      },
    ],
  });
} else {
  process.stdout.write(JSON.stringify({ ok: true, result: {} }));
}
`,
    { mode: 0o755 },
  );
  return file;
}

test("idle check failure includes screen and terminal state diagnostics", async () => {
  const calls = [];
  let callIndex = 0;
  const execute = async (argv) => {
    calls.push(argv);
    // Sequence: wait, read screen, list terminals
    if (callIndex === 0) {
      callIndex += 1;
      return {
        code: 1,
        stdout: JSON.stringify({
          ok: false,
          error: { code: "timeout", message: "not idle" },
        }),
      };
    }
    if (callIndex === 1) {
      callIndex += 1;
      return reply({
        terminal: {
          source: "screen",
          tail: ["Welcome", "com"],
        },
      });
    }
    // callIndex === 2, list
    return reply({
      terminals: [
        {
          handle: "term_1",
          agentIdentity: "agy_abc",
          status: "active",
          lastOutputAt: "2026-09-26T10:00:00Z",
        },
      ],
    });
  };

  try {
    await checkTerminalIdle("term_1", { executable: "orca", execute });
    assert.fail("Should have thrown");
  } catch (error) {
    assert.ok(error.signal?.kind === "execution-unconfigured");
    assert.ok(error.signal?.code === "timeout");
    assert.ok(error.diagnostics);
    assert.deepEqual(error.diagnostics.screen, ["Welcome", "com"]);
    assert.equal(error.diagnostics.screenSource, "screen");
    assert.deepEqual(error.diagnostics.terminalState, {
      handle: "term_1",
      agentIdentity: "agy_abc",
      status: "active",
      lastOutputAt: "2026-09-26T10:00:00Z",
    });
  }

  // Verify calls
  assert.ok(calls[0].includes("terminal"));
  assert.ok(calls[0].includes("wait"));
  assert.ok(calls[0].includes("--for"));
  assert.ok(calls[0].includes("tui-idle"));

  assert.ok(calls[1].includes("terminal"));
  assert.ok(calls[1].includes("read"));
  assert.ok(calls[1].includes("--screen"));

  assert.ok(calls[2].includes("terminal"));
  assert.ok(calls[2].includes("list"));
});

test("a screen read from the stream (not the screen) is recorded as no screen", async () => {
  // #46 problem A: the stream can still hold a stale startup line ("Welcome to
  // the Antigravity CLI. You are currently not signed in.") after the terminal
  // is actually ready, so only a `source: "screen"` reply is trusted.
  const execute = async (argv) => {
    if (argv.includes("wait")) {
      return {
        code: 1,
        stdout: JSON.stringify({
          ok: false,
          error: { code: "timeout", message: "not idle" },
        }),
      };
    }
    if (argv.includes("read")) {
      return reply({
        terminal: {
          source: "stream",
          tail: [
            "Welcome to the Antigravity CLI.",
            "You are currently not signed in.",
          ],
        },
      });
    }
    return reply({ terminals: [] });
  };

  try {
    await checkTerminalIdle("term_1", { executable: "orca", execute });
    assert.fail("Should have thrown");
  } catch (error) {
    assert.equal(error.diagnostics.screen, null);
    assert.equal(error.diagnostics.screenSource, "stream");
    assert.ok(!error.diagnostics.screenFieldMissing);
  }
});

test("a screen read in an unrecognized shape is recorded distinctly, not as an empty screen", async () => {
  const execute = async (argv) => {
    if (argv.includes("wait")) {
      return {
        code: 1,
        stdout: JSON.stringify({
          ok: false,
          error: { code: "timeout", message: "not idle" },
        }),
      };
    }
    if (argv.includes("read")) {
      // The shape the earlier, buggy implementation read: `result.screen`
      // instead of `result.terminal.tail`. No real Orca response looks like
      // this; it stands in for any future shape this adapter does not expect.
      return reply({ screen: { lines: [{ cells: [{ char: "x" }] }] } });
    }
    return reply({ terminals: [] });
  };

  try {
    await checkTerminalIdle("term_1", { executable: "orca", execute });
    assert.fail("Should have thrown");
  } catch (error) {
    assert.equal(error.diagnostics.screen, null);
    assert.equal(error.diagnostics.screenFieldMissing, true);
    assert.deepEqual(error.diagnostics.screenTopLevelKeys, ["screen"]);
  }
});

test("idle check failure records diagnostic read error", async () => {
  const execute = async (argv) => {
    if (argv.includes("wait")) {
      return {
        code: 1,
        stdout: JSON.stringify({
          ok: false,
          error: { code: "timeout", message: "not idle" },
        }),
      };
    }
    // Both read and list fail
    return { code: 1, stdout: "" };
  };

  try {
    await checkTerminalIdle("term_1", { executable: "orca", execute });
    assert.fail("Should have thrown");
  } catch (error) {
    assert.ok(error.diagnostics);
    assert.ok(error.diagnostics.diagnosticsError);
  }
});

test("a diagnostic read that throws still records the original idle failure", async () => {
  // The exit-code failure above and this one are different paths: readTerminalDiagnostics
  // has its own outer try/catch for execute() itself throwing, not just returning a
  // non-zero code (e.g. the runner rejects on spawn failure).
  const execute = async (argv) => {
    if (argv.includes("wait")) {
      return {
        code: 1,
        stdout: JSON.stringify({
          ok: false,
          error: { code: "timeout", message: "not idle" },
        }),
      };
    }
    throw new Error("boom: could not spawn orca");
  };

  try {
    await checkTerminalIdle("term_1", { executable: "orca", execute });
    assert.fail("Should have thrown");
  } catch (error) {
    assert.match(error.message, /did not report tui-idle within 20000ms/);
    assert.ok(error.diagnostics.diagnosticsError);
    assert.match(error.diagnostics.message, /boom: could not spawn orca/);
  }
});

test("idle check success does not collect diagnostics", async () => {
  const calls = [];
  const execute = async (argv) => {
    calls.push(argv);
    return reply({ wait: { satisfied: true } });
  };

  const result = await checkTerminalIdle("term_1", {
    executable: "orca",
    execute,
  });
  assert.deepEqual(result, { terminal: "term_1", idle: true });
  // Only wait should be called, no read or list
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("wait"));
});

test("default wait is 20000 ms", async () => {
  const calls = [];
  const execute = async (argv) => {
    calls.push(argv);
    return reply({ wait: { satisfied: true } });
  };

  await checkTerminalIdle("term_1", { executable: "orca", execute });
  const waitCall = calls[0];
  assert.ok(waitCall.includes("--timeout-ms"));
  const timeoutIndex = waitCall.indexOf("--timeout-ms");
  assert.equal(waitCall[timeoutIndex + 1], "20000");
});

test(
  "the terminal-idle-check CLI prints diagnostics instead of only the translated message",
  posixOnly,
  async (t) => {
    const dir = tempDir(t);
    const fakeOrca = writeFakeOrca(dir, "term_cli_1");

    await assert.rejects(
      main([
        "terminal-idle-check",
        "--terminal",
        "term_cli_1",
        "--orca",
        fakeOrca,
      ]),
      (error) => {
        assert.match(error.message, /did not report tui-idle within 20000ms/);
        const [firstLine, ...rest] = error.message.split("\n");
        assert.match(firstLine, /did not report tui-idle/);
        const detail = JSON.parse(rest.join("\n"));
        assert.equal(detail.signal.code, "timeout");
        assert.equal(detail.diagnostics.screenSource, "screen");
        assert.deepEqual(detail.diagnostics.screen, [
          "Welcome to the Antigravity CLI.",
          "You are not signed in.",
          "> ",
        ]);
        assert.equal(detail.diagnostics.terminalState.agentIdentity, "agy");
        assert.equal(detail.diagnostics.terminalState.status, "running");
        assert.equal(
          detail.diagnostics.terminalState.lastOutputAt,
          "2026-09-26T00:00:00Z",
        );
        return true;
      },
    );
  },
);

test(
  "worker-start's idle rejection also prints diagnostics through the CLI",
  posixOnly,
  async (t) => {
    const dir = tempDir(t);
    const fakeOrca = writeFakeOrca(dir, "term_cli_2");
    const orgFile = path.join(dir, "organization.json");
    writeJSON(
      orgFile,
      readJSON(
        new URL(
          "../plugins/oh-my-teams/examples/organization.json",
          import.meta.url,
        ),
      ),
    );

    await assert.rejects(
      main([
        "worker-start",
        "--repo",
        dir,
        "--org",
        orgFile,
        "--role",
        "pl",
        "--spec",
        "이어서 한다",
        "--terminal",
        "term_cli_2",
        "--orca",
        fakeOrca,
      ]),
      (error) => {
        assert.match(error.message, /did not report tui-idle within 20000ms/);
        const [, ...rest] = error.message.split("\n");
        const detail = JSON.parse(rest.join("\n"));
        assert.equal(detail.signal.code, "timeout");
        assert.equal(detail.diagnostics.screenSource, "screen");
        assert.equal(detail.diagnostics.terminalState.agentIdentity, "agy");
        return true;
      },
    );
  },
);
