import fs from 'node:fs';
import path from 'node:path';
import { assert, hash, readJSON, run, writeJSON, inside } from './core.mjs';

export async function git(repo, args) {
  const r = await run(['git', '-C', repo, ...args], { timeoutMs: 60000 });
  assert(r.code === 0, `git ${args[0]} failed: ${r.stderr}`); return args.includes('-z') ? r.stdout : r.stdout.trim();
}
export async function fingerprint(repo, baseRef, commands, environment) {
  assert(typeof environment === 'string' && environment.trim(), 'Explicit environment fingerprint required (toolchain/lockfile/DB fixture revision)');
  assert(Array.isArray(commands) && commands.length && commands.every(c => Array.isArray(c) && c.length && c.every(v => typeof v === 'string' && v.length)), 'Non-empty check argv arrays required');
  const head = await git(repo, ['rev-parse', 'HEAD']);
  const base = await git(repo, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
  // Include untracked and dirty content; status alone cannot identify a changed file.
  const tracked = (await git(repo, ['ls-files', '-z'])).split('\0').filter(Boolean);
  const untracked = (await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const files = [...new Set([...tracked, ...untracked])].filter(f => !f.startsWith('.orca/')).sort();
  const contents = files.map(f => {
    const file = inside(repo, f);
    return [f, fs.existsSync(file) ? hash(fs.readFileSync(file).toString('base64')) : null, fs.existsSync(file) ? fs.statSync(file).mode : null];
  });
  return { head, base, tree: hash(contents), commands, environment, platform: process.platform, node: process.version };
}
export async function verify(repo, { baseRef = 'HEAD', commands, environment, store, timeoutMs = 300000 }) {
  const before = await fingerprint(repo, baseRef, commands, environment), key = hash(before);
  const file = path.join(store, `${key}.json`);
  if (fs.existsSync(file)) {
    const cached = readJSON(file);
    if (cached.status === 'passed' && cached.key === key && hash(cached.fingerprint) === key && cached.checks?.length === commands.length && cached.checks.every(c => c.code === 0 && !c.timedOut && !c.overflow) && cached.checks.every(c => fs.existsSync(c.log) && hash(fs.readFileSync(c.log, 'utf8')) === c.logHash)) return { ...cached, cached: true };
  }
  fs.mkdirSync(store, { recursive: true });
  const checks = [];
  for (let i = 0; i < commands.length; i++) {
    const r = await run(commands[i], { cwd: repo, timeoutMs });
    const log = path.resolve(store, `${key}-${i}.log`), text = r.stdout + '\n' + r.stderr;
    fs.writeFileSync(log, text);
    checks.push({ argv: commands[i], code: r.code, timedOut: r.timedOut, overflow: r.overflow, pid: r.pid, elapsedMs: r.elapsedMs, log, logHash: hash(text), tail: text.slice(-2000) });
    if (r.timedOut || r.overflow) break; // Process descendants may still be live; do not overlap more checks.
  }
  const after = await fingerprint(repo, baseRef, commands, environment);
  const unchanged = hash(after) === key;
  const evidence = { schemaVersion: 1, key, fingerprint: before, status: unchanged && checks.length === commands.length && checks.every(c => c.code === 0 && !c.timedOut && !c.overflow) ? 'passed' : 'failed', unchanged, checks, createdAt: new Date().toISOString(), cached: false };
  writeJSON(file, evidence); return evidence;
}
export async function validateEvidence(repo, evidence, baseRef, expected) {
  assert(evidence?.schemaVersion === 1 && evidence.status === 'passed', 'Evidence did not pass');
  if (expected) {
    assert(JSON.stringify(evidence.fingerprint?.commands) === JSON.stringify(expected.checks) && evidence.fingerprint?.environment === expected.environment, 'Evidence does not match the trusted acceptance specification');
  }
  assert(Array.isArray(evidence.checks) && evidence.checks.length > 0 && evidence.checks.every(c => c.code === 0 && !c.timedOut && !c.overflow), 'Failed or missing checks');
  const current = await fingerprint(repo, baseRef, evidence.fingerprint.commands, evidence.fingerprint.environment);
  assert(hash(current) === evidence.key && hash(evidence.fingerprint) === evidence.key, 'Stale evidence: head, base, tree, commands or environment changed');
  assert(evidence.checks.length === current.commands.length && evidence.checks.every((c, i) => JSON.stringify(c.argv) === JSON.stringify(current.commands[i])), 'Evidence checks do not match commands');
  assert(evidence.checks.every(c => fs.existsSync(c.log) && hash(fs.readFileSync(c.log, 'utf8')) === c.logHash), 'Missing or changed evidence log');
  return true;
}
export function aggregate(reports, expectedIds) {
  assert(Array.isArray(expectedIds) && expectedIds.length && new Set(expectedIds).size === expectedIds.length, 'Unique expected task IDs required');
  const seen = new Set(), rows = [], blockers = [], usageByProfile = Object.create(null);
  for (const report of reports) {
    assert(report && typeof report.taskId === 'string' && expectedIds.includes(report.taskId) && !seen.has(report.taskId), 'Unexpected or duplicate task report');
    seen.add(report.taskId);
    for (const call of report.calls ?? []) {
      const group = usageByProfile[call.profile] ??= { calls: 0, callsWithUsage: 0, tokens: {}, callsWithCost: 0, knownCostUsd: null };
      group.calls++;
      if (call.usage) {
        group.callsWithUsage++;
        for (const [key, value] of Object.entries(call.usage)) if (typeof value === 'number' && Number.isFinite(value)) group.tokens[key] = (group.tokens[key] ?? 0) + value;
      }
      if (typeof call.costUsd === 'number' && Number.isFinite(call.costUsd)) { group.callsWithCost++; group.knownCostUsd = (group.knownCostUsd ?? 0) + call.costUsd; }
    }
    const passed = report.status === 'passed' && report.evidence?.status === 'passed' && typeof report.evidence.key === 'string';
    rows.push({ taskId: report.taskId, status: passed ? 'reported-passed' : 'blocked', head: report.evidence?.fingerprint?.head ?? null, evidenceKey: report.evidence?.key ?? null, reportPath: report.reportPath ?? null, calls: report.calls?.length ?? 0, issues: report.issues ?? [] });
    if (!passed || report.issues?.length) blockers.push(report.taskId);
  }
  const missing = expectedIds.filter(id => !seen.has(id));
  return { schemaVersion: 1, status: blockers.length || missing.length ? 'blocked' : 'ready-for-verification', missing, blockers, tasks: rows, usageByProfile, note: 'Aggregation is not merge authorization. Verify each evidence record against its actual workspace and final integration head.' };
}
export function checkCitations(repo, citations) {
  assert(Array.isArray(citations), 'citations must be an array');
  return citations.map(c => {
    try {
      assert(Number.isInteger(c.line) && c.line >= 1 && typeof c.quote === 'string' && c.quote.trim(), 'Invalid citation');
      const lines = fs.readFileSync(inside(repo, c.file), 'utf8').split(/\r?\n/);
      const index = lines.findIndex((line, i) => Math.abs(i + 1 - c.line) <= 3 && line.trim() === c.quote.trim());
      return { ...c, verified: index >= 0, actualLine: index >= 0 ? index + 1 : null };
    } catch { return { ...c, verified: false, actualLine: null }; }
  });
}
