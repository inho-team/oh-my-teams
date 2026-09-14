import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, readJSON, writeJSON, run } from '../plugins/orca/scripts/core.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=readJSON(path.join(root,'experiments/results/2026-09-14T07-51-22-988Z/manifest.json'));
const smoke=readJSON(path.join(root,'.orca/smoke-setup/receipt.json'));
const owned=[...manifest.records.map(r=>({worktree:r.worktree,comment:`Benchmark complete: ${r.model}; evidence in experiments/REPORT.md`})),{worktree:smoke.worktree,comment:'GPT-OSS harness smoke passed; evidence preserved in coordinator .orca/runs'}];
async function orca(args){const r=await run(['orca',...args,'--json'],{cwd:root,timeoutMs:60000});assert(r.code===0,r.stderr||r.stdout);const parsed=JSON.parse(r.stdout);assert(parsed.ok!==false,JSON.stringify(parsed));return parsed.result;}
const results=[];
for(const {worktree,comment} of owned){
  assert(worktree.parentWorktreeId===manifest.records[0].worktree.parentWorktreeId,'Unexpected parent');
  assert(/^(bench-[012]-\d+|intern-smoke-\d+)$/.test(worktree.displayName),'Not an experiment workspace');
  const state=await orca(['terminal','list','--worktree',`id:${worktree.id}`]);
  const closed=[];
  for(const terminal of state.terminals){
    assert(terminal.worktreeId===worktree.id,'Terminal ownership mismatch');
    const preview=(terminal.preview||'').trim();
    assert(preview.startsWith('PS ')&&preview.endsWith('>')&&preview.replaceAll('\\','/').includes(worktree.path),'Terminal is not a proven unused experiment shell');
    await orca(['terminal','close','--terminal',terminal.handle]);closed.push(terminal.handle);
  }
  await orca(['worktree','set','--worktree',`id:${worktree.id}`,'--workspace-status','completed','--comment',comment]);
  results.push({worktreeId:worktree.id,closed,retainedForInspection:true});
}
writeJSON(path.join(root,'.orca/experiment-cleanup.json'),results);
console.log(JSON.stringify(results,null,2));
