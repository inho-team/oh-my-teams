/** Composes standalone runtime generation and its write/check command interface. */
import { buildRuntime } from "./adapters/runtime-build.mjs";

const args = process.argv.slice(2);
let root;
let write = false;
try {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--write") write = true;
    else if (args[index] === "--root" && args[index + 1]) root = args[++index];
    else throw new Error(`unknown or incomplete option: ${args[index]}`);
  }
  const result = buildRuntime({ root, write });
  console.log(JSON.stringify(result, null, 2));
  if (result.mismatches.length) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
