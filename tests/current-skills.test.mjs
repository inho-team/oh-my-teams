/** Installed role skills must describe commands that the active CLI supports. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED_OPTIONS } from "../plugins/oh-my-teams/scripts/cli-spec.mjs";

const skills = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../plugins/oh-my-teams/skills",
);

test("the installed role roster contains PM and Worker without retired role skills", () => {
  for (const role of ["director", "pm", "worker", "auditor"]) {
    assert.ok(fs.existsSync(path.join(skills, role, "SKILL.md")), role);
  }
  for (const role of ["pl", "senior", "junior"]) {
    assert.equal(fs.existsSync(path.join(skills, role, "SKILL.md")), false);
  }
});

test("active role instructions do not invoke removed mailbox or supervision commands", () => {
  const retired =
    /\b(?:message-send|message-inbox|message-ack|message-watch|supervision-next|supervision-wait|director-watch)\b/;
  for (const role of ["director", "pm", "worker"]) {
    const text = fs.readFileSync(path.join(skills, role, "SKILL.md"), "utf8");
    assert.doesNotMatch(text, retired, role);
  }
  for (const command of ["director-signal", "director-reply", "worker-start"]) {
    assert.ok(ALLOWED_OPTIONS[command], command);
  }
});
