#!/usr/bin/env python3
"""Send exactly one explicitly authorized Agy pool-transition request."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--lab', type=Path, required=True)
parser.add_argument('--port', type=int, default=18473)
parser.add_argument('--active-prefix', required=True)
args = parser.parse_args()
lab = args.lab.resolve(strict=True)
env = dict(os.environ, OPENCODEX_HOME=str(lab / 'ocx'), CODEX_HOME=str(lab / 'codex'))
exe = str(lab / 'install/node_modules/.bin/ocx')

def cli(*words):
    child = subprocess.run([exe, 'account', *words, '--json'], env=env, capture_output=True, text=True)
    if child.returncode:
        raise RuntimeError('account command failed; no inference sent')
    return json.loads(child.stdout)

def fingerprint(value):
    return hashlib.sha256(value.encode()).hexdigest()

rows = cli('list', 'google-antigravity')['accounts']
# This probe is bound to the user's explicitly declared three-account experiment.
assert {r['id'][:8] for r in rows} == {'e4a44806', '143f974f', '5926ffe8'}
selected = [r for r in rows if r['id'].startswith(args.active_prefix)]
assert len(selected) == 1
assert cli('use', 'google-antigravity', selected[0]['id'])['ok']
before = cli('current', 'google-antigravity')
assert before['activeId'] == selected[0]['id']
config = json.loads((lab / 'ocx/config.json').read_text())
assert config['providers']['google-antigravity']['authMode'] == 'oauth'
assert not config.get('oauthAccountFailover', {}).get('enabled', False)
assert not config['providers']['google-antigravity'].get('oauthAccountFailover', {}).get('enabled', False)
result = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'requestedModel': 'google-antigravity/claude-sonnet-4-6', 'clientSendCount': 1,
          'activeBeforeHash': fingerprint(before['activeId']),
          'declaredAccounts': [{'idHash': fingerprint(r['id']),
                                'logLabel': 'o' + fingerprint('google-antigravity\0' + r['id'])[:6]} for r in rows]}
# Reserve before sending, including HTTP errors and timeouts. Never delete to retry.
with (lab / 'pool-attempt.lock').open('x') as lock:
    lock.write(result['startedAt'])
request = urllib.request.Request(f'http://127.0.0.1:{args.port}/v1/responses',
    data=json.dumps({'model': result['requestedModel'], 'input': 'Return exactly pool-probe-ok.',
                     'max_output_tokens': 32, 'stream': False}).encode(),
    headers={'Content-Type': 'application/json'})
start = time.monotonic()
try:
    with urllib.request.urlopen(request, timeout=90) as response:
        payload = json.load(response)
        result.update(httpStatus=response.status, responseModel=payload.get('model'),
                      responseStatus=payload.get('status'),
                      accountHeaderNames=[k for k in response.headers if 'account' in k.lower()])
        result['usage'] = {k: v for k, v in payload.get('usage', {}).items() if isinstance(v, (int, float))}
except urllib.error.HTTPError as error:
    result.update(httpStatus=error.code, error='http-error-no-retry')
except (TimeoutError, urllib.error.URLError):
    result.update(error='transport-timeout-or-error-no-retry')
result['durationMs'] = round((time.monotonic() - start) * 1000)
result['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
after = cli('current', 'google-antigravity')
result['activeAfterHash'] = fingerprint(after['activeId'])
(lab / 'pool-result.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
