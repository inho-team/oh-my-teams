/** Replays only failed historical benchmark attempts with bounded feedback. */
import fs from "node:fs";
import path from "node:path";
import { problems } from "./compare-models.mjs";
import {
  readJSON,
  writeJSON,
  run,
  assert,
  hash,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  invoke,
  parseModelJSON,
} from "../plugins/oh-my-teams/scripts/providers.mjs";

const dir = path.resolve(process.argv[2]);
const manifest = readJSON(path.join(dir, "manifest.json"));
for (const record of manifest.records) {
  for (const first of record.results.filter((r) => !r.passed)) {
    const problem = problems.find((p) => p.id === first.task);
    const cwd = path.join(record.worktree.path, "benchmark-fixture");
    const prompt =
      `Return only a JSON object with a code property containing your COMPLETE IMPLEMENTATION as an ES ` +
      `module source string. Do not output placeholder text. Do not use tools, inspect files, run ` +
      `commands, or edit files.\n\n${problem.prompt}\n\nYour previous attempt returned placeholder ` +
      `text instead of JavaScript and failed with SyntaxError. Produce the actual complete JavaScript ` +
      `implementation now.`;
    const response = await invoke(
      {
        provider: "agy",
        command: ["agy"],
        model: record.model,
        account: "current",
      },
      cwd,
      prompt,
      300000,
    );
    const destination = path.join(dir, record.model, first.task, "retry");
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, "response.txt"), response.stdout);
    let test = { code: -1 },
      error = null;
    try {
      assert(
        response.code === 0 && !response.providerError && !response.timedOut,
        "Provider failed",
      );
      const payload = parseModelJSON(response.text);
      assert(typeof payload.code === "string", "No code");
      fs.writeFileSync(path.join(destination, "solution.mjs"), payload.code);
      fs.writeFileSync(path.join(cwd, "solution.mjs"), payload.code);
      fs.writeFileSync(path.join(cwd, "acceptance.mjs"), problem.test);
      test = await run(
        [
          process.execPath,
          "--permission",
          `--allow-fs-read=${cwd}`,
          path.join(cwd, "acceptance.mjs"),
        ],
        { cwd, timeoutMs: 10000 },
      );
    } catch (e) {
      error = e.message;
    }
    const result = {
      model: record.model,
      task: first.task,
      promptHash: hash(prompt),
      elapsedMs: response.elapsedMs,
      usage: response.usage,
      passed: test.code === 0,
      test,
      error,
    };
    writeJSON(path.join(destination, "measurement.json"), result);
    console.log(JSON.stringify(result));
    for (const f of ["solution.mjs", "acceptance.mjs"])
      if (fs.existsSync(path.join(cwd, f))) fs.unlinkSync(path.join(cwd, f));
  }
}
