import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const ROLES = ['pm', 'pl', 'senior', 'junior', 'intern'];
export const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function assert(ok, message) { if (!ok) throw new Error(message); }
export function inside(root, relative) {
  assert(typeof relative === 'string' && relative && !path.isAbsolute(relative), 'A relative file path is required');
  assert(!relative.split(/[\\/]/).some(p => ['..', '.git', '.orca'].includes(p)), `Forbidden path: ${relative}`);
  const base = fs.realpathSync(root), target = path.resolve(base, relative);
  let ancestor = target;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const real = fs.realpathSync(ancestor);
  assert(real === base || real.startsWith(base + path.sep), `Path escapes workspace: ${relative}`);
  assert(target.startsWith(base + path.sep), `Path escapes workspace: ${relative}`);
  return target;
}
export function run(argv, { cwd, input = '', timeoutMs = 300000, env = process.env, maxBytes = 8 * 1024 * 1024 } = {}) {
  assert(Array.isArray(argv) && argv.length && argv.every(x => typeof x === 'string'), 'Command must be an argv array');
  if (process.platform === 'win32' && argv[0] === 'codex') {
    const entry = path.join(env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(entry)) argv = [process.execPath, entry, ...argv.slice(1)];
  }
  return new Promise(resolve => {
    const started = Date.now();
    // No shell interpolation. On Windows use a native executable or node + an absolute CLI .js path.
    const child = spawn(argv[0], argv.slice(1), { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, overflow = false, done = false;
    let fallbackTimer;
    const timer = setTimeout(() => { timedOut = true; child.kill(); fallbackTimer = setTimeout(() => finish(-1), 1000); }, timeoutMs);
    const finish = (code, error) => {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(fallbackTimer);
      resolve({ code: code ?? -1, stdout, stderr: stderr + (error ? String(error.message) : ''), timedOut, overflow, pid: child.pid ?? null, elapsedMs: Date.now() - started });
    };
    for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.setEncoding('utf8');
      stream.on('data', data => {
        if (name === 'stdout') stdout += data.toString(); else stderr += data.toString();
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBytes) { overflow = true; stdout = stdout.slice(0, maxBytes / 2); stderr = stderr.slice(0, maxBytes / 2); child.kill(); }
      });
    }
    child.on('error', error => finish(-1, error));
    child.on('close', code => finish(code));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function validateOrg(org) {
  assert(org?.schemaVersion === 1 && typeof org.name === 'string' && org.name.trim(), 'Organization name and schemaVersion=1 required');
  assert(Number.isInteger(org.revision) && org.revision >= 1, 'Positive revision required');
  assert(org.profiles && org.roles && org.policy, 'profiles, roles and policy required');
  for (const [id, profile] of Object.entries(org.profiles)) {
    assert(/^[a-z0-9][a-z0-9-]*$/.test(id), `Invalid profile id: ${id}`);
    assert(['claude', 'codex', 'agy'].includes(profile.provider), `Invalid provider: ${id}`);
    assert(typeof profile.subscription === 'string' && profile.subscription.trim(), `Subscription label required: ${id}`);
    assert(Array.isArray(profile.command) && profile.command.length && profile.command.every(x => typeof x === 'string' && x), `Command argv required: ${id}`);
    assert(profile.model === null || typeof profile.model === 'string' && profile.model.trim(), `Model must be an ID or null (host default): ${id}`);
    assert(profile.account === 'current' || typeof profile.account === 'string' && profile.account.trim(), `Account profile reference required: ${id}`);
    assert(!profile.env || Object.entries(profile.env).every(([k, v]) => /^[A-Z_][A-Z0-9_]*$/.test(k) && /^[A-Z_][A-Z0-9_]*$/.test(v)), 'env values must name source environment variables, never secrets');
    if (profile.account !== 'current') assert(profile.env && Object.keys(profile.env).length || profile.command.length > 1, `Named account ${id} needs an actual command/profile or environment binding`);
  }
  assert(Object.keys(org.roles).length === ROLES.length && ROLES.every(r => r in org.roles), 'Exactly PM/PL/Senior/Junior/Intern required');
  for (const role of ROLES) {
    const r = org.roles[role];
    assert(Object.hasOwn(org.profiles, r.profile), `Unknown profile for ${role}`);
    assert(Number.isInteger(r.concurrency) && r.concurrency >= 1 && r.concurrency <= 32, `Invalid concurrency: ${role}`);
    assert(Number.isInteger(r.attempts) && r.attempts >= 1 && r.attempts <= 5, `Invalid attempts: ${role}`);
    assert(r.parent === null || ROLES.includes(r.parent) && r.parent !== role, `Invalid parent: ${role}`);
    assert(role === 'pm' ? r.parent === null : r.parent !== null, 'PM must be the only root');
    const seen = new Set([role]);
    for (let p = r.parent; p; p = org.roles[p]?.parent) {
      assert(!seen.has(p), 'Organization cycle'); seen.add(p);
    }
    assert(Array.isArray(r.fallbacks) && new Set(r.fallbacks).size === r.fallbacks.length && !r.fallbacks.includes(r.profile) && r.fallbacks.every(p => Object.hasOwn(org.profiles, p)), `Invalid fallbacks: ${role}`);
  }
  assert(['stop', 'fallback'].includes(org.policy.onExhaustion), 'onExhaustion must be stop or fallback');
  assert(Number.isInteger(org.policy.maxCalls) && org.policy.maxCalls >= 1 && org.policy.maxCalls <= 20, 'maxCalls must be 1..20');
  assert(Number.isInteger(org.policy.timeoutMs) && org.policy.timeoutMs >= 1000 && org.policy.timeoutMs <= 600000, 'timeoutMs must be 1000..600000');
  assert(Number.isInteger(org.policy.repeatFailureLimit) && org.policy.repeatFailureLimit >= 1, 'repeatFailureLimit required');
  return org;
}
export function saveOrg(file, org, { update = false, expectedRevision } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let fd;
  try { fd = fs.openSync(lock, 'wx'); } catch (error) { if (error.code === 'EEXIST') throw new Error('Organization update in progress; read it again before editing'); throw error; }
  try {
  let old;
  if (fs.existsSync(file)) {
    old = validateOrg(readJSON(file));
    if (!update) return { created: false, organization: old };
    assert(expectedRevision === old.revision, 'Organization changed; read it again before editing');
  } else assert(!update, 'No organization; run org-setup first');
  const next = validateOrg({ ...org, revision: old ? old.revision + 1 : 1 });
  if (old) writeJSON(path.join(path.dirname(file), 'history', `org-${old.revision}.json`), old);
  writeJSON(file, next);
  return { created: !old, organization: next };
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export function chart(org) {
  validateOrg(org);
  const lines = [`Organization: ${org.name} (revision ${org.revision})`];
  function visit(role, depth) {
    const r = org.roles[role], p = org.profiles[r.profile];
    lines.push(`${'  '.repeat(depth)}${role.toUpperCase()}: ${r.profile} | ${p.subscription} | ${p.provider}/${p.model ?? 'host-default'} | slots=${r.concurrency}`);
    ROLES.filter(child => org.roles[child].parent === role).forEach(child => visit(child, depth + 1));
  }
  visit('pm', 0); return lines.join('\n');
}
export function profileEnv(profile) {
  const env = { ...process.env };
  for (const [target, source] of Object.entries(profile.env ?? {})) {
    assert(process.env[source], `Missing environment reference: ${source}`);
    env[target] = process.env[source];
  }
  return env;
}
