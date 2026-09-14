import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, assert } from '../plugins/orca/scripts/core.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = process.argv[2] || 'both';
assert(['claude','codex','both'].includes(host), 'Host must be claude, codex or both');
async function execute(argv) {
  const result = await run(argv, {cwd:root,timeoutMs:120000});
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  assert(result.code === 0 && !result.timedOut, `${argv[0]} installation failed; inspect the error before retrying`);
}
if (host === 'claude' || host === 'both') {
  await execute(['claude','plugin','marketplace','add',root]);
  await execute(['claude','plugin','install','orca@orca-skills']);
}
if (host === 'codex' || host === 'both') {
  await execute(['codex','plugin','marketplace','add',root]);
  await execute(['codex','plugin','add','orca@orca-skills']);
}
console.log('Installed. Start a new conversation and invoke org-setup. Existing organizations are reused.');
