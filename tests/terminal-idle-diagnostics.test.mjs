/** Tests for terminal idle check with diagnostic information. */
import assert from "assert";
import { test } from "node:test";
import { checkTerminalIdle } from "../plugins/oh-my-teams/scripts/orca-adapter.mjs";

function reply(data) {
  return {
    code: 0,
    stdout: JSON.stringify({ ok: true, result: data }),
  };
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
        screen: {
          lines: [
            { cells: [{ char: "W" }, { char: "e" }, { char: "l" }] },
            { cells: [{ char: "c" }, { char: "o" }, { char: "m" }] },
          ],
          cursor: { row: 0, col: 2 },
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
    assert.deepEqual(error.diagnostics.screen, {
      lines: [
        { cells: [{ char: "W" }, { char: "e" }, { char: "l" }] },
        { cells: [{ char: "c" }, { char: "o" }, { char: "m" }] },
      ],
      cursor: { row: 0, col: 2 },
    });
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
