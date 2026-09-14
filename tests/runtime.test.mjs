import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJSON, writeJSON, validateOrg, saveOrg, chart, inside, hash, run } from '../plugins/orca/scripts/core.mjs';
import { applyEdits, work } from '../plugins/orca/scripts/worker.mjs';
import { verify, validateEvidence, aggregate, checkCitations } from '../plugins/orca/scripts/evidence.mjs';
import { decodeOutput, providerCommand, invoke } from '../plugins/orca/scripts/providers.mjs';

const example = readJSON(new URL('../plugins/orca/examples/organization.json', import.meta.url));
const clone = () => structuredClone(example);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-org-test-'));
  // Exact test-owned directory, verified at creation; no user paths are removed.
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
async function repo(t) {
  const dir = fixture(t);
  for (const args of [['init'], ['config','user.name','Orca Test'], ['config','user.email','test@example.invalid']]) {
    const result = await run(['git', ...args], { cwd: dir }); assert.equal(result.code, 0, result.stderr);
  }
  fs.writeFileSync(path.join(dir, '.gitignore'), '.orca/\n');
  fs.writeFileSync(path.join(dir, 'value.txt'), 'wrong\n');
  fs.writeFileSync(path.join(dir, 'check.mjs'), `import fs from 'node:fs';if(fs.readFileSync('value.txt','utf8')!=='right\\n')process.exit(1);`);
  for (const args of [['add','.gitignore','value.txt','check.mjs'], ['commit','-m','fixture']]) {
    const result = await run(['git', ...args], { cwd: dir }); assert.equal(result.code, 0, result.stderr);
  }
  return dir;
}
const task = { schemaVersion: 1, id: 'value-fix', instruction: 'Replace wrong with right, retaining newline', files: ['value.txt'], checks: [[process.execPath, 'check.mjs']], environment: 'fixture-v1', baseRef: 'HEAD', risk: 'low' };
function response(payload, extras = {}) { return { code: 0, stdout: JSON.stringify(payload), stderr: '', text: JSON.stringify(payload), elapsedMs: 1, usage: null, ...extras }; }

test('first setup is idempotent; explicit edits archive and reject stale revisions', t => {
  const file = path.join(fixture(t), 'organization.json');
  assert.equal(saveOrg(file, clone()).created, true);
  const changed = clone(); changed.name = 'new-team';
  assert.equal(saveOrg(file, changed).organization.name, 'example-team');
  assert.equal(saveOrg(file, changed, { update: true, expectedRevision: 1 }).organization.revision, 2);
  assert.equal(readJSON(path.join(path.dirname(file), 'history', 'org-1.json')).name, 'example-team');
  assert.throws(() => saveOrg(file, clone(), { update: true, expectedRevision: 1 }), /changed/);
});
test('graph validation accepts branches and rejects cycle/missing profile/second root', () => {
  assert.ok(chart(validateOrg(clone())).includes('INTERN'));
  const cycle = clone(); cycle.roles.pl.parent = 'intern'; assert.throws(() => validateOrg(cycle), /cycle/);
  const bad = clone(); bad.roles.intern.profile = 'missing'; assert.throws(() => validateOrg(bad), /profile/);
  const root = clone(); root.roles.senior.parent = null; assert.throws(() => validateOrg(root), /root/);
});
test('account labels alone cannot pretend to switch subscriptions', () => {
  const org = clone(); org.profiles['agy-oss'].account = 'second-account'; assert.throws(() => validateOrg(org), /binding/);
  org.profiles['agy-oss'].env = { AUTH_TOKEN: 'ACTUAL_SECRET_TEXT-with-hyphen' }; assert.throws(() => validateOrg(org), /environment/);
});
test('edit protocol validates every edit before writing and rejects traversal/stale input', t => {
  const dir = fixture(t); fs.writeFileSync(path.join(dir, 'value.txt'), 'old');
  assert.throws(() => inside(dir, '../outside'), /Forbidden/);
  assert.throws(() => inside(dir, '.git/config'), /Forbidden/);
  assert.throws(() => applyEdits(dir, task, { edits: [{file:'value.txt',beforeHash:hash('old'),content:'new'},{file:'other',beforeHash:null,content:'bad'}] }), /Unexpected/);
  assert.equal(fs.readFileSync(path.join(dir, 'value.txt'), 'utf8'), 'old');
  assert.throws(() => applyEdits(dir, task, { edits: [{file:'value.txt',beforeHash:'stale',content:'new'}] }), /changed/);
});
test('evidence is cached only for identical source, commands, base, environment and logs', async t => {
  const dir = await repo(t), store = path.join(dir,'.orca','evidence');
  fs.writeFileSync(path.join(dir,'value.txt'),'right\n');
  const options = { store, commands: task.checks, environment: 'env1', baseRef: 'HEAD' };
  const first = await verify(dir, options); assert.equal(first.status, 'passed'); assert.equal(first.cached, false);
  assert.equal((await verify(dir, options)).cached, true);
  assert.equal(await validateEvidence(dir, first, 'HEAD'), true);
  fs.appendFileSync(first.checks[0].log, 'tamper');
  await assert.rejects(() => validateEvidence(dir, first, 'HEAD'), /log/);
  assert.equal((await verify(dir, options)).cached, false);
  assert.equal((await verify(dir, {...options,environment:'env2'})).cached, false);
  fs.writeFileSync(path.join(dir,'value.txt'),'wrong\n');
  await assert.rejects(() => validateEvidence(dir, first, 'HEAD'), /Stale/);
  const bad = await verify(dir, options); assert.equal(bad.status, 'failed'); assert.equal((await verify(dir, options)).cached, false);
});
test('checks that mutate source cannot produce reusable success', async t => {
  const dir = await repo(t);
  const result = await verify(dir, { store:path.join(dir,'.orca','evidence'),baseRef:'HEAD',environment:'fixture',commands:[[process.execPath,'-e',"require('fs').writeFileSync('value.txt','mutated')"]] });
  assert.equal(result.status, 'failed'); assert.equal(result.unchanged, false);
});
test('aggregation rejects missing, duplicate and failed task results', () => {
  const report = {taskId:'a',status:'passed',evidence:{status:'passed',key:'key'}};
  assert.equal(aggregate([report],['a']).status,'ready-for-verification');
  assert.deepEqual(aggregate([report],['a','b']).missing,['b']);
  assert.throws(() => aggregate([report,report],['a']), /duplicate/);
  assert.equal(aggregate([{...report,status:'failed'}],['a']).status,'blocked');
});
test('citations match exact source lines within tolerance; no invented evidence', t => {
  const dir = fixture(t);fs.writeFileSync(path.join(dir,'file.txt'),'alpha\nbeta\ngamma\n');
  const result = checkCitations(dir,[{file:'file.txt',line:1,quote:'beta'},{file:'file.txt',line:1,quote:'bet'},{file:'../secret',line:1,quote:'secret'}]);
  assert.deepEqual(result.map(r=>r.verified),[true,false,false]);assert.equal(result[0].actualLine,2);
});
test('usage is measured separately from missing monetary cost', () => {
  const agy=decodeOutput(JSON.stringify({result:'{"code":"x"}',usage:{input_tokens:10,total_tokens:12}}));
  assert.equal(agy.usage.total_tokens,12);assert.equal(agy.costUsd,null);
  const codex=decodeOutput('{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}\n{"type":"turn.completed","usage":{"input_tokens":5}}');
  assert.equal(codex.text,'answer');assert.equal(codex.usage.input_tokens,5);
  assert.equal(decodeOutput('no metrics').usage,null);
});
test('provider argv preserves prompt literally without shell execution or permission bypass', () => {
  for(const provider of ['agy','claude','codex']) {
    const spec=providerCommand({provider,command:[provider],model:'specific-id'},'/tmp/task', 'literal $(not-a-command) `text`');
    assert.ok(spec.argv.includes('specific-id'));
    assert.ok(!spec.argv.some(v=>v.startsWith('--dangerously')));
  }
});
test('failed OSS output promotes once to configured fallback and preserves org snapshot', async t => {
  const dir = await repo(t), org=clone(); let calls=0;
  const result=await work(dir,org,task,{stateDir:path.join(dir,'.orca'),call:async(profile)=>{
    calls++;return calls===1?response({edits:[]}):response({edits:[{file:'value.txt',beforeHash:hash('wrong\n'),content:'right\n'}]});
  }});
  assert.equal(result.status,'passed');assert.equal(calls,2);
  assert.deepEqual(result.calls.map(c=>c.profile),['agy-oss','agy-sonnet']);
  org.name='later';assert.equal(readJSON(path.join(path.dirname(result.reportPath),'organization.json')).name,'example-team');
});
test('quota stop does not switch subscriptions; repeated failure never becomes success', async t => {
  const dir = await repo(t),org=clone();org.policy.onExhaustion='stop';let calls=0;
  const result=await work(dir,org,task,{stateDir:path.join(dir,'.orca'),call:async()=>{calls++;return response({}, {code:1,exhausted:true});}});
  assert.equal(result.status,'failed');assert.equal(calls,1);
  const failed=await work(dir,clone(),task,{stateDir:path.join(dir,'.orca'),call:async()=>response({edits:[]})});
  assert.equal(failed.status,'failed');assert.equal(failed.calls.length,2);
});
test('provider editing workspace outside JSON protocol is blocked and preserved', async t => {
  const dir=await repo(t);
  const result=await work(dir,clone(),task,{stateDir:path.join(dir,'.orca'),call:async()=>{fs.writeFileSync(path.join(dir,'check.mjs'),'// weakened');return response({edits:[]});}});
  assert.equal(result.status,'failed');assert.equal(result.calls.length,1);assert.match(result.issues[0],/outside/);
  assert.equal(fs.readFileSync(path.join(dir,'check.mjs'),'utf8'),'// weakened');
});
test('concurrency locks block extra workers and are released after settlement', async t => {
  const dir=await repo(t),org=clone();org.roles.intern.concurrency=1;
  const stateDir=path.join(dir,'.orca');fs.mkdirSync(path.join(stateDir,'slots'),{recursive:true});fs.writeFileSync(path.join(stateDir,'slots','intern-0.lock'),'owned');
  await assert.rejects(()=>work(dir,org,task,{stateDir,call:async()=>response({})}),/occupied/);
});
test('timed-out provider retains the slot and does not start fallback', async t => {
  const dir=await repo(t),org=clone();org.roles.intern.concurrency=1;
  const stateDir=path.join(dir,'.orca');
  const result=await work(dir,org,task,{stateDir,call:async()=>response({}, {timedOut:true,pid:123})});
  assert.equal(result.status,'failed');assert.equal(result.calls.length,1);
  assert.ok(fs.existsSync(path.join(stateDir,'slots','intern-0.lock')));
});
test('base and check argv changes invalidate success even with identical source', async t => {
  const dir=await repo(t),store=path.join(dir,'.orca','evidence');
  fs.writeFileSync(path.join(dir,'value.txt'),'right\n');
  await run(['git','add','value.txt'],{cwd:dir});await run(['git','commit','-m','fixed'],{cwd:dir});
  const options={store,commands:task.checks,environment:'env',baseRef:'HEAD'};
  const first=await verify(dir,options);assert.equal(first.status,'passed');
  const changedBase=await verify(dir,{...options,baseRef:'HEAD~1'});assert.notEqual(changedBase.key,first.key);assert.equal(changedBase.cached,false);
  const changedCommand=await verify(dir,{...options,commands:[[process.execPath,'--no-warnings','check.mjs']]});assert.notEqual(changedCommand.key,first.key);assert.equal(changedCommand.cached,false);
});
test('CLI init reuses the existing organization without reading replacement input', async t => {
  const dir=fixture(t),file=path.join(dir,'organization.json');saveOrg(file,clone());
  const result=await run([process.execPath,path.resolve('plugins/orca/scripts/orca-org.mjs'),'init','--org',file,'--from',path.join(dir,'does-not-exist.json')]);
  assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).created,false);
});
test('concurrent edits cannot both accept the same revision', async t => {
  const dir=fixture(t),file=path.join(dir,'organization.json'),proposal=path.join(dir,'next.json');saveOrg(file,clone());writeJSON(proposal,{...clone(),name:'changed'});
  const argv=[process.execPath,path.resolve('plugins/orca/scripts/orca-org.mjs'),'edit','--org',file,'--from',proposal,'--revision','1'];
  const results=await Promise.all([run(argv),run(argv)]);assert.equal(results.filter(r=>r.code===0).length,1);assert.equal(readJSON(file).revision,2);
});
test('429 in successful source code is not quota exhaustion', async () => {
  const result=await invoke({provider:'agy',command:['agy'],model:'gpt-oss-120b-medium'},'.','prompt',1000,async()=>({code:0,stdout:JSON.stringify({result:'{"edits":[],"summary":"handle HTTP 429"}'}),stderr:''}));
  assert.equal(result.exhausted,false);
  const failed=await invoke({provider:'agy',command:['agy'],model:'gpt-oss-120b-medium'},'.','prompt',1000,async()=>({code:0,stdout:JSON.stringify({is_error:true,result:'RESOURCE_EXHAUSTED 429'}),stderr:''}));
  assert.equal(failed.exhausted,true);
});
test('merge validation refuses evidence for weaker acceptance commands', async t => {
  const dir=await repo(t);fs.writeFileSync(path.join(dir,'value.txt'),'right\n');
  const evidence=await verify(dir,{store:path.join(dir,'.orca','evidence'),commands:[[process.execPath,'-e','process.exit(0)']],environment:task.environment,baseRef:'HEAD'});
  await assert.rejects(()=>validateEvidence(dir,evidence,'HEAD',task),/acceptance/);
});
