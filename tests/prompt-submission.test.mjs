/** Prompt delivery: input acceptance is told apart from submission, and nothing is sent twice. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DELIVERY_OUTCOMES,
  confirmWorkerSubmission,
  deliverPrompt,
  inputLine,
  judgeDelivery,
  judgeWorkerStartDelivery,
  readSendReceipt,
} from "../plugins/oh-my-teams/scripts/prompt-submission.mjs";

const TEXT = "[omt] progress from wt: tests are green";
const RULE = "─".repeat(60);
const STATUS = "  ⏵⏵ bypass permissions on (shift+tab to cycle)";

// The bottom of an agent screen with `boxText` typed in the input box.
const boxScreen = (boxText, above = []) => [
  ...above,
  RULE,
  boxText ? `❯ ${boxText}` : "❯",
  RULE,
  STATUS,
];

const accepted = { accepted: true, stages: ["input_accepted"] };
const proven = { accepted: true, stages: ["input_accepted", "turn_started"] };

test("the five delivery cases are told apart by receipt and screen", () => {
  // Accepted, and the approved text still waits in the input box.
  const held = judgeDelivery({
    receipt: accepted,
    screen: boxScreen(TEXT),
    text: TEXT,
  });
  assert.deepEqual(held, {
    outcome: "unsubmitted",
    reason: "approved-text-in-box",
    enter: true,
  });

  // The turn is proven: that is a submission whatever the screen shows.
  const started = judgeDelivery({
    receipt: proven,
    screen: boxScreen(TEXT),
    text: TEXT,
  });
  assert.equal(started.outcome, "submitted");
  assert.equal(started.enter, false);

  // The box is empty and the text sits in the transcript: already started.
  const running = judgeDelivery({
    receipt: accepted,
    screen: boxScreen("", [`❯ ${TEXT}`, "✻ Cultivating… (3s · thinking)"]),
    text: TEXT,
  });
  assert.equal(running.outcome, "already-started");
  assert.equal(running.enter, false);

  // Something else is typed in the box: Enter would submit that instead.
  for (const other of [
    "half a sentence someone was writing",
    `${TEXT} plus more`,
  ]) {
    const foreign = judgeDelivery({
      receipt: accepted,
      screen: boxScreen(other),
      text: TEXT,
    });
    assert.equal(foreign.outcome, "foreign-input");
    assert.equal(foreign.enter, false);
  }

  // No evidence either way: never Enter, ask for the same request to be replayed.
  for (const screen of [[], ["plain output"], boxScreen("")]) {
    const unclear = judgeDelivery({ receipt: accepted, screen, text: TEXT });
    assert.equal(unclear.outcome, "unclear");
    assert.equal(unclear.enter, false);
  }
  assert.equal(
    judgeDelivery({ receipt: { accepted: false, stages: [] }, text: TEXT })
      .outcome,
    "unclear",
  );
});

test("Enter is allowed only for approved text alone in the input box", () => {
  const enters = (screen, text = TEXT) =>
    judgeDelivery({ receipt: accepted, screen, text }).enter;
  assert.equal(enters(boxScreen(TEXT)), true);
  // A long input wraps onto indented rows and is still the same text.
  const long = `${TEXT} ${"details ".repeat(20)}`.trim();
  const wrapped = [
    RULE,
    `❯ ${long.slice(0, 80)}`,
    `  ${long.slice(80)}`,
    RULE,
    STATUS,
  ];
  assert.equal(enters(wrapped, long), true);
  // Part of the text: it may still be arriving, so nothing is pressed.
  assert.equal(enters(boxScreen(TEXT.slice(0, 12))), false);
  // The same words as an old echo with agent output under them are not a box.
  const echo = [
    `❯ ${TEXT}`,
    ...Array.from({ length: 6 }, (_, i) => `⏺ line ${i}`),
  ];
  assert.equal(enters(echo), false);
  // Quoting and wrapping differences do not matter.
  assert.equal(enters(boxScreen(`"${TEXT}"`)), true);
});

test("the input box is the lowest row that starts with a prompt mark", () => {
  assert.equal(inputLine([]), null);
  assert.equal(inputLine(["no prompt here"]), null);
  const line = inputLine([`❯ ${TEXT}`, "⏺ reply", ...boxScreen("draft")]);
  assert.equal(line.text, "draft");
  assert.equal(line.index, 3);
  assert.deepEqual(DELIVERY_OUTCOMES.slice(0, 2), [
    "submitted",
    "already-started",
  ]);
});

test("a send receipt is read without guessing missing fields", () => {
  const receipt = readSendReceipt({
    ok: true,
    result: {
      send: {
        accepted: true,
        prompt: {
          requestId: "req-9",
          stages: ["input_accepted", "turn_started"],
          provider: "claude",
          observation: "supported",
        },
      },
      mutation: { requestId: "req-9", replayed: true },
      warnings: ["unproven"],
    },
  });
  assert.deepEqual(receipt, {
    accepted: true,
    requestId: "req-9",
    stages: ["input_accepted", "turn_started"],
    provider: "claude",
    observation: "supported",
    replayed: true,
    warnings: ["unproven"],
  });
  // A bare Enter or raw text has no prompt block: only acceptance is known.
  const bare = readSendReceipt({ result: { send: { accepted: true } } });
  assert.deepEqual(bare.stages, []);
  assert.equal(bare.requestId, null);
  assert.equal(readSendReceipt({}).accepted, false);
});

// Plays Orca's send and read. `sends` and `screens` are consumed in order and
// the last one repeats; a send that is a `--retry-request` replay is answered
// from `replays`. A read reports `source` like Orca does; `null` leaves the
// field out, as a host that predates it would.
function fakeOrca({
  sends,
  replays = [],
  screens = [[]],
  failWith,
  source = "screen",
}) {
  const calls = [];
  const queue = {
    sends: [...sends],
    replays: [...replays],
    screens: [...screens],
  };
  const next = (list) => (list.length > 1 ? list.shift() : list[0]);
  // Like Orca, a receipt without the turn stage carries the "unproven" warning.
  const envelope = (stages) => {
    const warnings = stages.includes("turn_started") ? null : ["unproven"];
    return JSON.stringify({
      ok: true,
      result: {
        send: {
          accepted: true,
          prompt: { requestId: "req-1", stages, provider: "claude" },
        },
        mutation: { requestId: "req-1", replayed: false },
        ...(warnings ? { warnings } : {}),
      },
    });
  };
  const execute = async (argv) => {
    const args = argv.slice(1, -1);
    calls.push(args);
    if (failWith) return { code: 1, stdout: "", stderr: failWith };
    if (args[1] === "read") {
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          result: {
            terminal: {
              tail: next(queue.screens),
              ...(source === null ? {} : { source }),
            },
          },
        }),
      };
    }
    if (args.includes("--retry-request")) {
      return { code: 0, stdout: envelope(next(queue.replays)) };
    }
    if (args[args.indexOf("--text") + 1] === "") {
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          result: { send: { accepted: true } },
        }),
      };
    }
    return { code: 0, stdout: envelope(next(queue.sends)) };
  };
  const textSends = () =>
    calls.filter(
      (call) =>
        call[1] === "send" &&
        call.includes(TEXT) &&
        !call.includes("--retry-request"),
    );
  const enters = () =>
    calls.filter(
      (call) => call[1] === "send" && call[call.indexOf("--text") + 1] === "",
    );
  const replayed = () =>
    calls.filter((call) => call.includes("--retry-request"));
  return { calls, execute, textSends, enters, replayed };
}

const deliver = (orca) =>
  deliverPrompt({
    orca: "orca",
    terminal: "term_1",
    text: TEXT,
    execute: orca.execute,
  });

test("a proven turn is delivered with one send and no Enter", async () => {
  const orca = fakeOrca({ sends: [["input_accepted", "turn_started"]] });
  const result = await deliver(orca);
  assert.equal(result.outcome, "submitted");
  assert.equal(result.delivered, true);
  assert.equal(result.enterSent, false);
  assert.equal(orca.textSends().length, 1);
  assert.equal(orca.enters().length, 0);
  assert.equal(orca.replayed().length, 0);
  // The single send asked Orca to observe the turn instead of stopping at acceptance.
  assert.deepEqual(orca.textSends()[0].slice(-2), ["--wait-submit", "5"]);
});

test("an accepted input whose turn already runs gets no second send and no Enter", async () => {
  const orca = fakeOrca({
    sends: [["input_accepted"]],
    screens: [boxScreen("", [`❯ ${TEXT}`, "✻ Cultivating… (3s)"])],
  });
  const result = await deliver(orca);
  assert.equal(result.outcome, "already-started");
  assert.equal(result.delivered, true);
  assert.equal(orca.textSends().length, 1);
  assert.equal(orca.enters().length, 0);
  assert.equal(orca.replayed().length, 0);
});

test("an accepted input left in the box gets exactly one Enter", async () => {
  const orca = fakeOrca({
    sends: [["input_accepted"]],
    replays: [["input_accepted", "turn_started"]],
    // Held before the Enter, cleared after it.
    screens: [
      boxScreen(TEXT),
      boxScreen(TEXT),
      boxScreen("", [`❯ ${TEXT}`, "✻ Working…"]),
    ],
  });
  const result = await deliver(orca);
  assert.equal(result.outcome, "submitted");
  assert.equal(result.enterSent, true);
  assert.equal(result.delivered, true);
  assert.equal(orca.enters().length, 1);
  // The prompt itself was typed once; the rest are replays of the same request.
  assert.equal(orca.textSends().length, 1);
  for (const replay of orca.replayed()) {
    assert.equal(replay[replay.indexOf("--retry-request") + 1], "req-1");
  }
});

test("an Enter that does not submit is reported, never pressed twice", async () => {
  const orca = fakeOrca({
    sends: [["input_accepted"]],
    replays: [["input_accepted"]],
    screens: [boxScreen(TEXT)],
  });
  const result = await deliver(orca);
  assert.equal(result.outcome, "unsubmitted");
  assert.equal(result.delivered, false);
  assert.equal(result.enterSent, true);
  assert.equal(orca.enters().length, 1);
  assert.equal(orca.textSends().length, 1);
});

test("other text in the box is left alone", async () => {
  const orca = fakeOrca({
    sends: [["input_accepted"]],
    screens: [boxScreen("a draft that is not ours")],
  });
  const result = await deliver(orca);
  assert.equal(result.outcome, "foreign-input");
  assert.equal(result.delivered, false);
  assert.equal(result.enterSent, false);
  assert.equal(orca.enters().length, 0);
  assert.equal(orca.textSends().length, 1);
});

test("an unclear delivery replays the request and can then prove the turn", async () => {
  const orca = fakeOrca({
    sends: [["input_accepted"]],
    replays: [["input_accepted", "turn_started"]],
    screens: [[]],
  });
  const result = await deliver(orca);
  assert.equal(result.outcome, "submitted");
  assert.equal(result.retried, true);
  assert.equal(result.requestId, "req-1");
  assert.equal(orca.enters().length, 0);
  assert.equal(orca.textSends().length, 1);
  assert.equal(orca.replayed().length, 1);
});

test("a delivery that stays unclear keeps its request ID and presses nothing", async () => {
  const orca = fakeOrca({
    sends: [["input_accepted"]],
    replays: [["input_accepted"]],
    screens: [[]],
  });
  const result = await deliver(orca);
  assert.equal(result.outcome, "unclear");
  assert.equal(result.delivered, false);
  assert.equal(result.requestId, "req-1");
  assert.deepEqual(result.stages, ["input_accepted"]);
  assert.deepEqual(result.warnings, ["unproven"]);
  assert.equal(orca.enters().length, 0);
  assert.equal(orca.textSends().length, 1);
});

test("an Orca failure keeps its own text and sends nothing more", async () => {
  const orca = fakeOrca({
    sends: [],
    failWith: "terminal_not_writable: pane is closed",
  });
  const result = await deliver(orca);
  assert.equal(result.outcome, "failed");
  assert.equal(result.delivered, false);
  assert.match(result.error, /terminal_not_writable: pane is closed/);
  assert.equal(orca.calls.length, 1);
});

test("a screen Orca could not render never earns an Enter", async () => {
  // The tail looks exactly like an unsubmitted prompt, and would get an Enter
  // from a rendered screen. Whatever else `source` says, it is not the screen.
  for (const source of ["screen-unavailable", "stream", null]) {
    const orca = fakeOrca({
      sends: [["input_accepted"]],
      replays: [["input_accepted"]],
      screens: [boxScreen(TEXT)],
      source,
    });
    const result = await deliver(orca);
    assert.equal(result.outcome, "unclear", String(source));
    assert.equal(result.reason, "no-input-box-on-screen", String(source));
    assert.equal(result.delivered, false);
    assert.equal(result.enterSent, false);
    assert.equal(orca.enters().length, 0);
    // The request is still observed again, and the text is typed only once.
    assert.equal(orca.textSends().length, 1);
    assert.equal(orca.replayed().length, 1);
  }
});

test("accumulated output of an already submitted prompt gets no Enter", async () => {
  // Repainted lines pile up: the box line that once held the text stays in the
  // stream tail after the prompt left it and the turn began.
  const orca = fakeOrca({
    sends: [["input_accepted"]],
    replays: [["input_accepted"]],
    screens: [[`❯ ${TEXT}`, "✻ Working…"]],
    source: "screen-unavailable",
  });
  const result = await deliver(orca);
  assert.equal(result.outcome, "unclear");
  assert.equal(orca.enters().length, 0);
  assert.equal(orca.textSends().length, 1);
});

test("a rendered screen still decides an Enter", async () => {
  const orca = fakeOrca({
    sends: [["input_accepted"]],
    replays: [["input_accepted", "turn_started"]],
    screens: [boxScreen(TEXT), boxScreen(TEXT), boxScreen("")],
    source: "screen",
  });
  const result = await deliver(orca);
  assert.equal(result.enterSent, true);
  assert.equal(orca.enters().length, 1);
});

// worker-start types its own preamble, not the approved spec or task text, so
// judgeWorkerStartDelivery anchors on the task id instead of an exact match.
test("a worker-start hand-off is judged by its task id, never by its own preamble text (#87)", () => {
  const stages = ["input_accepted"];
  assert.deepEqual(
    judgeWorkerStartDelivery({
      stages: ["input_accepted", "turn_started"],
      screen: [],
      taskId: "task_1",
    }),
    { outcome: "submitted", reason: "turn-started", enter: false },
  );
  assert.deepEqual(
    judgeWorkerStartDelivery({ stages, screen: [], taskId: "task_1" }),
    { outcome: "unclear", reason: "no-input-box-on-screen", enter: false },
  );
  assert.deepEqual(
    judgeWorkerStartDelivery({
      stages,
      screen: ["❯ some Orca preamble around the spec"],
      taskId: "task_1",
    }),
    { outcome: "unsubmitted", reason: "text-in-box", enter: true },
  );
  assert.deepEqual(
    judgeWorkerStartDelivery({
      stages,
      screen: ["handed off task_1", "❯"],
      taskId: "task_1",
    }),
    {
      outcome: "already-started",
      reason: "task-id-in-transcript",
      enter: false,
    },
  );
  assert.deepEqual(
    judgeWorkerStartDelivery({ stages, screen: ["❯"], taskId: "task_1" }),
    { outcome: "unclear", reason: "empty-box-without-task-id", enter: false },
  );
  // No taskId at all: an empty box never counts as already-started by luck.
  assert.deepEqual(
    judgeWorkerStartDelivery({ stages, screen: ["❯"], taskId: null }),
    { outcome: "unclear", reason: "empty-box-without-task-id", enter: false },
  );
});

test("confirmWorkerSubmission reads the screen once and presses Enter at most once (#87)", async () => {
  const fakeConfirm = (screen) => {
    const calls = [];
    const execute = async (argv) => {
      calls.push(argv.slice(1, -1));
      if (argv[2] === "read") {
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            result: { terminal: { source: "screen", tail: screen } },
          }),
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          result: { send: { accepted: true } },
        }),
      };
    };
    return { calls, execute };
  };

  const unsubmitted = fakeConfirm(["❯ preamble"]);
  const pressed = await confirmWorkerSubmission({
    orca: "orca",
    terminal: "term_1",
    stages: ["input_accepted"],
    taskId: "task_1",
    execute: unsubmitted.execute,
  });
  assert.deepEqual(pressed, {
    outcome: "unsubmitted",
    reason: "text-in-box",
    enterSent: true,
  });
  assert.equal(
    unsubmitted.calls.filter((call) => call[1] === "send").length,
    1,
  );

  const alreadyStarted = fakeConfirm(["handed off task_1", "❯"]);
  const untouched = await confirmWorkerSubmission({
    orca: "orca",
    terminal: "term_1",
    stages: ["input_accepted"],
    taskId: "task_1",
    execute: alreadyStarted.execute,
  });
  assert.deepEqual(untouched, {
    outcome: "already-started",
    reason: "task-id-in-transcript",
    enterSent: false,
  });
  assert.deepEqual(alreadyStarted.calls, [
    ["terminal", "read", "--terminal", "term_1", "--screen"],
  ]);
});
