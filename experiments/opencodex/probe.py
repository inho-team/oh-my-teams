#!/usr/bin/env python3
"""Run one isolated subscription probe; retain only allowlisted observations.

No login, credential copying, provider fallback, or raw transcript persistence.
The caller must inspect routing and supply the exact account-pinned model slug.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--subscription', choices=['chatgpt', 'claude', 'antigravity'], required=True)
parser.add_argument('--model', required=True)
parser.add_argument('--lab', type=Path, required=True)
parser.add_argument('--execute', action='store_true')
parser.add_argument('--routing-reviewed', action='store_true')
args = parser.parse_args()
lab = args.lab.resolve(strict=True)
repo = Path(__file__).resolve().parents[2]
if lab == repo or repo in lab.parents:
    parser.error('lab must be outside the worktree')
now = datetime.datetime.now(datetime.timezone.utc)
result = dict(subscription=args.subscription, requestedModel=args.model,
              observedModels=[], status='not-run', timestamp=now.isoformat(),
              accountAttribution='unverified', usage={}, events={}, commandExecutions=0,
              fileChanges=0, completion='not-observed', error=None, httpStatuses=[], quotaErrorObserved=False)
result_path = lab / (args.subscription + '-result.json')
work = Path(tempfile.mkdtemp(prefix='fixture-', dir=lab))
shutil.copytree(Path(__file__).parent / 'fixture', work, dirs_exist_ok=True)
# A local package boundary prevents an ancestor package.json from changing JS mode.
(work / 'package.json').write_text('{"type":"commonjs"}\n')

def test_fixture():
    return subprocess.run(['node', '--test', 'sum.test.js'], cwd=work,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode

original_test_hash = hashlib.sha256((work / 'sum.test.js').read_bytes()).hexdigest()
result['baselineTestExit'] = test_fixture()
result['fixtureHashBefore'] = hashlib.sha256((work / 'sum.js').read_bytes()).hexdigest()
result['workDirectory'] = str(work)
credential = lab / 'ocx' / ('codex-accounts.json' if args.subscription == 'chatgpt' else 'auth.json')
result['credentialStoreExists'] = credential.is_file()
if not credential.is_file():
    result['error'] = 'isolated-login-required'
elif args.subscription == 'antigravity' and now < datetime.datetime(2026, 9, 21, 6, 4, tzinfo=datetime.timezone.utc):
    result['error'] = 'shared-quota-hold-until-2026-09-21T06:04Z'
elif not args.execute or not args.routing_reviewed:
    result['error'] = 'execution-and-account-routing-review-required'
else:
    # Reserve once before launch, including failures/timeouts; never retry Agy automatically.
    if args.subscription == 'antigravity':
        with (lab / 'antigravity-attempt.lock').open('x') as lock:
            lock.write(now.isoformat())
    env = {k: v for k, v in os.environ.items()
           if k in ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL']}
    env.update(OPENCODEX_HOME=str(lab / 'ocx'), CODEX_HOME=str(lab / 'codex'))
    command = ['codex', 'exec', '--json', '--ephemeral', '--ignore-user-config',
               '--skip-git-repo-check', '-C', str(work), '-s', 'workspace-write',
               '-c', 'approval_policy="never"', '-c', 'cli_auth_credentials_store="file"',
               '-c', 'model_provider="probe"', '-c', 'model_providers.probe.name="OpenCodex probe"',
               '-c', 'model_providers.probe.base_url="http://127.0.0.1:18473/v1"',
               '-c', 'model_providers.probe.wire_api="responses"',
               '-c', 'model_providers.probe.requires_openai_auth=false',
               '-c', 'model_providers.probe.request_max_retries=0',
               '-c', 'model_providers.probe.stream_max_retries=0', '-m', args.model,
               'Read sum.js and sum.test.js, fix only sum.js, run node --test sum.test.js, then finish. '
               'Do not read other directories, credentials, environment variables, or use network tools.']
    try:
        child = subprocess.run(command, cwd=work, env=env, capture_output=True,
                               text=True, timeout=180)
        result['exitCode'] = child.returncode
        result['stderrPresent'] = bool(child.stderr)
        for line in child.stdout.splitlines():
            try:
                event = json.loads(line)
            except (ValueError, TypeError):
                continue
            kind = event.get('type')
            if kind in ['thread.started', 'turn.started', 'turn.completed', 'turn.failed',
                        'item.started', 'item.completed', 'error']:
                result['events'][kind] = result['events'].get(kind, 0) + 1
            # Never persist free text, command strings, identities, or raw error payloads.
            item = event.get('item', {})
            if kind == 'item.completed' and item.get('type') == 'command_execution':
                result['commandExecutions'] += 1
            if kind == 'item.completed' and item.get('type') == 'file_change':
                result['fileChanges'] += 1
            usage = event.get('usage', {})
            for key in ['input_tokens', 'cached_input_tokens', 'output_tokens']:
                if isinstance(usage.get(key), int):
                    result['usage'][key] = usage[key]
            # Only model-shaped identifiers are retained, never arbitrary event text.
            model = event.get('model')
            if isinstance(model, str) and re.fullmatch(r'[a-zA-Z0-9._/-]{1,100}', model):
                if model not in result['observedModels']:
                    result['observedModels'].append(model)
            diagnostic = str(event.get('message', '')) + str(event.get('error', ''))
            for code in re.findall(r'\b(?:400|401|403|404|429|500|502|503)\b', diagnostic):
                if int(code) not in result['httpStatuses']:
                    result['httpStatuses'].append(int(code))
            if re.search(r'quota|RESOURCE_EXHAUSTED|rate.limit|429', diagnostic, re.I):
                result['quotaErrorObserved'] = True
        result['postTestExit'] = test_fixture()
        result['fixtureHashAfter'] = hashlib.sha256((work / 'sum.js').read_bytes()).hexdigest()
        complete = child.returncode == 0 and result['events'].get('turn.completed', 0) > 0
        result['completion'] = 'exit-zero-and-turn.completed' if complete else 'incomplete'
        result['testUnchanged'] = hashlib.sha256((work / 'sum.test.js').read_bytes()).hexdigest() == original_test_hash
        fixed = (result['baselineTestExit'] != 0 and result['postTestExit'] == 0
                 and result['testUnchanged'] and result['fixtureHashAfter'] != result['fixtureHashBefore'])
        result['status'] = 'task-completed-attribution-unverified' if complete and fixed else 'failed'
        if not complete:
            result['error'] = 'execution-failed-see-local-process-observation'
    except subprocess.TimeoutExpired:
        result.update(status='failed', error='timeout-180s', completion='timeout')
result_path.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
