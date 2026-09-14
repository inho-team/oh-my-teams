import { assert, run, profileEnv } from './core.mjs';

// Model IDs are opaque; defaults come from the user's installed CLI, never a price/quality ranking.
export function providerCommand(profile, cwd, prompt) {
  const argv = [...profile.command];
  if (profile.provider === 'agy') {
    argv.push('--mode', 'plan', '--sandbox', '--add-dir', cwd, '--disable-slash-commands', '--output-format', 'json', '--print-timeout', '5m');
    if (profile.model) argv.push('--model', profile.model);
    argv.push('-p', prompt);
    return { argv, input: '' };
  }
  if (profile.provider === 'claude') {
    argv.push('--print', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence');
    if (profile.model) argv.push('--model', profile.model);
    return { argv, input: prompt };
  }
  assert(profile.provider === 'codex', 'Unsupported provider');
  argv.push('exec', '--sandbox', 'read-only', '--ephemeral', '--json', '--cd', cwd);
  if (profile.model) argv.push('--model', profile.model);
  argv.push('-'); return { argv, input: prompt };
}
export function decodeOutput(stdout) {
  let envelope;
  try { envelope = JSON.parse(stdout); } catch {}
  const events = stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  let text = typeof envelope?.result === 'string' ? envelope.result : typeof envelope?.response === 'string' ? envelope.response : undefined;
  let usage = envelope?.usage ?? null;
  for (const event of events) {
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text;
    if (event.type === 'result' && typeof event.result === 'string') text = event.result;
    if (event.usage) usage = event.usage;
  }
  if (!text && envelope && (envelope.edits || envelope.citations || envelope.findings)) text = JSON.stringify(envelope);
  return { text: text ?? stdout, usage, costUsd: typeof envelope?.total_cost_usd === 'number' ? envelope.total_cost_usd : null, providerError: envelope?.is_error === true || envelope?.error != null || envelope?.type === 'error' || events.some(e => e.type === 'error') };
}
export function parseModelJSON(text) {
  try { return JSON.parse(text); } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return JSON.parse(fenced[1]);
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  assert(start >= 0 && end > start, 'Model did not return a JSON object');
  return JSON.parse(text.slice(start, end + 1));
}
export async function invoke(profile, cwd, prompt, timeoutMs, execute = run) {
  const { argv, input } = providerCommand(profile, cwd, prompt);
  const result = await execute(argv, { cwd, input, timeoutMs, env: profileEnv(profile) });
  const decoded = decodeOutput(result.stdout);
  const failed = result.code !== 0 || decoded.providerError;
  return { ...result, ...decoded, exhausted: failed && /RESOURCE_EXHAUSTED|rate.?limit|\b429\b/i.test(result.stderr + result.stdout) };
}
