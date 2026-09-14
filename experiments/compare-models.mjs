import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, writeJSON, assert, hash } from '../plugins/orca/scripts/core.mjs';
import { invoke, parseModelJSON } from '../plugins/orca/scripts/providers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'experiments', 'results', new Date().toISOString().replace(/[:.]/g, '-'));
const models = ['gpt-oss-120b-medium', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking'];
export const problems = [
  {
    id: 'evidence-cache',
    prompt: `Implement an ES module exporting function reusable(saved, current). Return true only if both are non-null objects, saved.status is exactly "passed", both head and base are non-empty strings and equal on both objects, environment is a non-empty string and equal, commands are non-empty arrays of non-empty arrays of strings, and commands match element by element in order. Do not mutate inputs. Invalid input returns false, never throws. No imports or side effects.`,
    test: `import { reusable as f } from './solution.mjs';
import assert from 'node:assert/strict';
const good={status:'passed',head:'abc',base:'def',environment:'node22',commands:[['node','--test'],['npm','test']]};
const copy=x=>JSON.parse(JSON.stringify(x));
assert.equal(f(good,copy(good)),true);
for(const key of ['head','base','environment']) {const b=copy(good);b[key]='other';assert.equal(f(good,b),false);}
assert.equal(f({...good,status:'failed'},good),false);
assert.equal(f(good,{...good,commands:[['npm','test'],['node','--test']]}),false);
assert.equal(f({...good,commands:[['a','b']]},{...good,commands:[['a b']]}),false);
for(const bad of [null,undefined,0,'x',[],{}, {...good,head:''},{...good,base:''},{...good,environment:''},{...good,commands:[]},{...good,commands:[[]]},{...good,commands:[['node',null]]}]) {assert.equal(f(bad,good),false);assert.equal(f(good,bad),false);}
const before=JSON.stringify(good);Object.freeze(good);f(good,copy(good));assert.equal(JSON.stringify(good),before);
console.log('all evidence-cache acceptance cases passed');`
  },
  {
    id: 'organization-graph',
    prompt: `Implement an ES module exporting function validateOrg(roles). Valid input is a non-null non-array object with exactly five own keys pm, pl, senior, junior, intern. Each value is a non-null non-array object containing a parent property and a positive integer concurrency no greater than 32. pm.parent must be null. Every other parent must be one of those five role IDs, may not equal itself, and following parents must terminate at pm with no cycle. Branching is allowed, so senior and junior may both report to pl. Return {valid:true,errors:[]} when valid, otherwise {valid:false,errors:[at least one non-empty string]}. Never throw for invalid inputs; do not mutate input. No imports or side effects.`,
    test: `import {validateOrg as f} from './solution.mjs';import assert from 'node:assert/strict';
const good={pm:{parent:null,concurrency:1},pl:{parent:'pm',concurrency:1},senior:{parent:'pl',concurrency:2},junior:{parent:'pl',concurrency:3},intern:{parent:'junior',concurrency:8}};
const clone=()=>JSON.parse(JSON.stringify(good));
assert.deepEqual(f(good),{valid:true,errors:[]});
const cycle=clone();cycle.pl.parent='intern';
const self=clone();self.junior.parent='junior';
const extra=clone();extra.manager={parent:'pm',concurrency:1};
const missing=clone();delete missing.intern;
const secondRoot=clone();secondRoot.senior.parent=null;
const badParent=clone();badParent.intern.parent='unknown';
const badPM=clone();badPM.pm.parent='pl';
const invalid=[null,undefined,[],42,'str',{},cycle,self,extra,missing,secondRoot,badParent,badPM];
for(const c of [0,-1,1.5,33,'2',null,NaN,Infinity]){const x=clone();x.intern.concurrency=c;invalid.push(x);}
for(const r of [null,[],false,'x']){const x=clone();x.senior=r;invalid.push(x);}
for(const x of invalid){const r=f(x);assert.equal(r.valid,false);assert.ok(Array.isArray(r.errors)&&r.errors.length>0&&r.errors.every(e=>typeof e==='string'&&e.length>0));}
const before=JSON.stringify(good);f(good);assert.equal(JSON.stringify(good),before);
console.log('all organization-graph acceptance cases passed');`
  }
];

async function orca(args) {
  const r = await run(['orca', ...args, '--json'], { cwd: root, timeoutMs: 60000 });
  assert(r.code === 0, `Orca failed: ${r.stderr || r.stdout}`);
  const j = JSON.parse(r.stdout); assert(j.ok !== false, JSON.stringify(j)); return j.result;
}
async function main() {
fs.mkdirSync(out, { recursive: true });
const base = (await run(['git', 'rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
const records = [];
// Sequential creates avoid worktree/registry mutation races; model calls then run independently.
for (let i = 0; i < models.length; i++) {
  const result = await orca(['worktree', 'create', '--name', `bench-${i}-${Date.now()}`, '--parent-worktree', 'active', '--base-branch', base, '--setup', 'skip']);
  assert(result.worktree?.path && result.worktree?.id, 'Missing worktree receipt');
  records.push({ model: models[i], worktree: result.worktree, results: [] });
  writeJSON(path.join(out, 'manifest.json'), { base, records });
}
await Promise.all(records.map(async record => {
  for (const problem of problems) {
    const cwd = path.join(record.worktree.path, 'benchmark-fixture');
    fs.mkdirSync(cwd, { recursive: true });
    // No candidate can inspect acceptance tests: they are materialized only after output is returned.
    const prompt = `Return only a JSON object {"code":"complete ES module source"}. Do not use tools, inspect files, run commands, or edit files. Work entirely from this specification.\n\n${problem.prompt}`;
    const profile = { provider: 'agy', command: ['agy'], model: record.model, account: 'current', subscription: 'current Agy subscription' };
    const result = await invoke(profile, cwd, prompt, 300000);
    const dir = path.join(out, record.model, problem.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'response.txt'), result.stdout);
    fs.writeFileSync(path.join(dir, 'stderr.txt'), result.stderr);
    let test = { code: -1, stdout: '', stderr: 'No valid code' }, parseError = null;
    try {
      assert(result.code === 0 && !result.providerError && !result.timedOut, 'Provider did not succeed');
      const payload = parseModelJSON(result.text);
      assert(typeof payload.code === 'string', 'Missing code');
      fs.writeFileSync(path.join(dir, 'solution.mjs'), payload.code);
      fs.writeFileSync(path.join(cwd, 'solution.mjs'), payload.code);
      fs.writeFileSync(path.join(cwd, 'acceptance.mjs'), problem.test);
      test = await run([process.execPath, '--permission', `--allow-fs-read=${cwd}`, path.join(cwd, 'acceptance.mjs')], { cwd, timeoutMs: 10000 });
    } catch (error) { parseError = error.message; }
    const summary = { task: problem.id, promptHash: hash(prompt), promptChars: prompt.length, elapsedMs: result.elapsedMs, providerExit: result.code, timedOut: result.timedOut, usage: result.usage, costUsd: result.costUsd, passed: test.code === 0, parseError, test };
    record.results.push(summary); writeJSON(path.join(dir, 'measurement.json'), summary);
    console.log(JSON.stringify({ model: record.model, ...summary }));
    // Remove only exact experiment-owned fixture files, so the next task has no prior answer/context.
    for (const file of ['solution.mjs', 'acceptance.mjs']) { const target = path.join(cwd, file); if (fs.existsSync(target)) fs.unlinkSync(target); }
  }
}));
writeJSON(path.join(out, 'manifest.json'), { base, provider: 'agy', attemptsPerTask: 1, taskCount: problems.length, records });
console.log(`RESULTS=${out}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
