#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, readJSON, writeJSON, validateOrg, saveOrg, chart, run } from './core.mjs';
import { work, draft, validateTask } from './worker.mjs';
import { verify, validateEvidence, aggregate, git } from './evidence.mjs';

const help = `Orca organization runtime (Node >=22)
  init --org FILE --from CONFIG                 Create once; existing config is reused
  edit --org FILE --from CONFIG --revision N    Validate, archive, update atomically
  show --org FILE [--state DIR] [--json]         Organization chart and local run status
  validate --org FILE                          Validate configuration
  prepare --org FILE --task FILE --repo DIR --name NAME [--orca EXECUTABLE]
                                               Create an Orca child worktree + immutable input snapshot
  work --org SNAPSHOT --task FILE --repo WORKTREE --state SHARED_DIR [--role intern]
  draft --org FILE --task FILE --repo DIR [--kind citations|checklist]
  verify --task FILE --repo DIR --state DIR     Run or reuse exact-source evidence
  merge-check --evidence FILE --task TRUSTED_TASK --repo DIR --base REF
  aggregate --expected id,id --report FILE [--report FILE ...]
No command asks for subscriptions after init. Use org-setup/org-edit skills for the one-time choices.
No automatic push, PR merge, deployment, public publishing or deletion.`;

export function parseArgs(argv) {
  const [command, ...rest] = argv, args = { command, report: [] };
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]; assert(key.startsWith('--'), `Unexpected argument: ${key}`);
    if (key === '--json') { args.json = true; continue; }
    assert(rest[i + 1] && !rest[i + 1].startsWith('--'), `Missing value: ${key}`);
    if (key === '--report') args.report.push(rest[++i]);
    else { assert(!(key.slice(2) in args), `Duplicate option: ${key}`); args[key.slice(2)] = rest[++i]; }
  }
  return args;
}
export async function main(argv = process.argv.slice(2)) {
  if (!argv.length || argv.includes('--help')) { console.log(help); return; }
  const a = parseArgs(argv);
  const allowed = {
    init: ['org', 'from'], edit: ['org', 'from', 'revision'], show: ['org', 'state', 'json'], validate: ['org'],
    prepare: ['org', 'task', 'repo', 'name', 'orca'], work: ['org', 'task', 'repo', 'state', 'role'], draft: ['org', 'task', 'repo', 'kind'],
    verify: ['task', 'repo', 'state'], 'merge-check': ['evidence', 'task', 'repo', 'base'], aggregate: ['expected', 'report']
  };
  assert(allowed[a.command], `Unknown command: ${a.command}`);
  for (const key of Object.keys(a)) assert(['command', 'report'].includes(key) || allowed[a.command].includes(key), `Unknown option: --${key}`);
  const required = {
    init: ['org', 'from'], edit: ['org', 'from', 'revision'], show: ['org'], validate: ['org'], prepare: ['org', 'task', 'repo', 'name'],
    work: ['org', 'task', 'repo', 'state'], draft: ['org', 'task', 'repo'], verify: ['task', 'repo', 'state'], 'merge-check': ['evidence', 'task', 'repo', 'base'], aggregate: ['expected']
  };
  required[a.command].forEach(key => assert(a[key], `--${key} required`));
  let output;
  switch (a.command) {
    case 'init':
      // Do not even read a proposed replacement if the organization already exists.
      output = fs.existsSync(a.org) ? { created: false, organization: validateOrg(readJSON(a.org)) } : saveOrg(a.org, readJSON(a.from)); break;
    case 'edit': output = saveOrg(a.org, readJSON(a.from), { update: true, expectedRevision: Number(a.revision) }); break;
    case 'validate': output = { valid: Boolean(validateOrg(readJSON(a.org))) }; break;
    case 'show': {
      const org = validateOrg(readJSON(a.org));
      const runsDir = a.state && path.join(a.state, 'runs');
      const runs = runsDir && fs.existsSync(runsDir) ? fs.readdirSync(runsDir).flatMap(id => {
        const file = path.join(runsDir, id, 'report.json');
        if (!fs.existsSync(file)) return [{ runId: id, status: 'unsettled', note: 'Check execution-host process liveness' }];
        const r = readJSON(file); return [{ runId: id, taskId: r.taskId, role: r.role, status: r.status, issues: r.issues }];
      }) : [];
      if (!a.json) { console.log(chart(org)); if (a.state) console.log(JSON.stringify({ runs }, null, 2)); return; }
      output = { organization: org, runs }; break;
    }
    case 'prepare': {
      const org = validateOrg(readJSON(a.org)), task = validateTask(readJSON(a.task)), repo = path.resolve(a.repo);
      assert(/^[a-z][a-z0-9-]*$/.test(a.name), 'Worktree name must be lower-case words/numbers/hyphens');
      const base = await git(repo, ['rev-parse', '--verify', `${task.baseRef}^{commit}`]);
      const executable = a.orca || process.env.ORCA_CLI_COMMAND || (process.env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : process.platform === 'linux' && process.env.TERM_PROGRAM !== 'Orca' ? 'orca-ide' : 'orca');
      const started = await run([executable, 'worktree', 'create', '--name', a.name, '--parent-worktree', `path:${repo}`, '--base-branch', base, '--setup', 'inherit', '--json'], { cwd: repo, timeoutMs: 60000 });
      assert(started.code === 0 && !started.timedOut, `Orca prepare failed; inspect residual resources before retry: ${started.stderr || started.stdout}`);
      const receipt = JSON.parse(started.stdout);
      assert(receipt.ok !== false && receipt.result?.worktree?.path && receipt.result.worktree.id, 'Orca receipt missing worktree identity');
      const wt = receipt.result.worktree, state = path.join(repo, '.orca');
      const snapshot = path.join(wt.path, '.orca');
      writeJSON(path.join(snapshot, 'organization.json'), org);
      writeJSON(path.join(snapshot, 'task.json'), { ...task, baseRef: base });
      writeJSON(path.join(state, 'worktrees', `${a.name}.json`), { worktree: wt, taskId: task.id, organizationRevision: org.revision, executable, receipt });
      output = { worktree: wt, state, org: path.join(snapshot, 'organization.json'), task: path.join(snapshot, 'task.json'), note: 'Worktree prepared. Run work in this checkout, or use the orchestration skill to start a supervised worker. Preserve its receipt for cleanup.' }; break;
    }
    case 'work': output = await work(path.resolve(a.repo), readJSON(a.org), readJSON(a.task), { role: a.role || 'intern', stateDir: path.resolve(a.state) }); break;
    case 'draft': output = await draft(path.resolve(a.repo), readJSON(a.org), readJSON(a.task), { kind: a.kind || 'citations' }); break;
    case 'verify': {
      const task = validateTask(readJSON(a.task));
      output = await verify(path.resolve(a.repo), { commands: task.checks, baseRef: task.baseRef, environment: task.environment, store: path.join(path.resolve(a.state), 'evidence') }); break;
    }
    case 'merge-check': output = { valid: await validateEvidence(path.resolve(a.repo), readJSON(a.evidence), a.base, validateTask(readJSON(a.task))), note: 'Evidence valid for this checkout, base and trusted acceptance specification. Apply project merge authorization and mandatory CI separately.' }; break;
    case 'aggregate': output = aggregate(a.report.map(file => ({ ...readJSON(file), reportPath: path.resolve(file) })), a.expected.split(',')); break;
  }
  console.log(JSON.stringify(output, null, 2));
  if (output?.status === 'failed' || output?.status === 'blocked') process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
