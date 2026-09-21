#!/usr/bin/env python3
"""Observe one Codex exec cancellation immediately after its turn-start event."""
import datetime
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import tempfile
import time
import argparse

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--lab', type=Path, required=True)
args = parser.parse_args()
lab = args.lab.resolve(strict=True)
work = Path(tempfile.mkdtemp(prefix='cancel-fixture-', dir=lab))
shutil.copytree(Path(__file__).parent / 'fixture', work, dirs_exist_ok=True)
(work / 'package.json').write_text('{"type":"commonjs"}')
env = {k: v for k, v in os.environ.items() if k in ['PATH','HOME','TMPDIR','LANG','SHELL']}
env.update(OPENCODEX_HOME=str(lab / 'ocx'), CODEX_HOME=str(lab / 'codex'))
exe = str(lab / 'install/node_modules/.bin/ocx')
current = subprocess.run([exe,'account','current','openai','--json'],env=env,capture_output=True,text=True)
account = json.loads(current.stdout)
assert current.returncode == 0 and account['activeId'] and account['autoSwitchThreshold'] == 0
result = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'model':'gpt-6-astra','effort':'medium','events':[], 'signals':[], 'workDirectory':str(work)}
with (lab / 'cancel-attempt.lock').open('x') as lock:
    lock.write(result['startedAt'])
command = ['codex','exec','--json','--ephemeral','--ignore-user-config','--skip-git-repo-check',
           '-C',str(work),'-s','workspace-write','-m','gpt-6-astra',
           '-c','model_reasoning_effort="medium"','-c','model_provider="probe"',
           '-c','model_providers.probe.name="Cancel probe"',
           '-c','model_providers.probe.base_url="http://127.0.0.1:18473/v1"',
           '-c','model_providers.probe.wire_api="responses"',
           '-c','model_providers.probe.requires_openai_auth=false',
           '-c','model_providers.probe.request_max_retries=0',
           '-c','model_providers.probe.stream_max_retries=0',
           'Read sum.js and sum.test.js, fix only sum.js, then run node --test sum.test.js.']

def process_table():
    raw = subprocess.check_output(['ps','-axo','pid=,ppid=,stat='],text=True)
    return {int(a): (int(b),c) for a,b,c in (line.split() for line in raw.splitlines())}

def descendants(root, table):
    found = {root}
    while True:
        new = {pid for pid,(parent,_) in table.items() if parent in found}
        if new <= found:
            return sorted(found)
        found |= new

child = subprocess.Popen(command,env=env,cwd=work,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                         text=True,start_new_session=True)
selector = selectors.DefaultSelector()
selector.register(child.stdout,selectors.EVENT_READ)
known = [child.pid]
deadline = time.monotonic()+30
while child.poll() is None and time.monotonic()<deadline:
    if not selector.select(timeout=0.1):
        continue
    line = child.stdout.readline()
    if not line:
        break
    try:
        event=json.loads(line)
    except ValueError:
        continue
    kind=event.get('type')
    if kind in ['thread.started','turn.started','turn.completed','turn.failed','error']:
        result['events'].append(kind)
    if kind=='turn.started':
        known=descendants(child.pid,process_table())
        os.killpg(child.pid,signal.SIGINT)
        result['signals'].append({'signal':'SIGINT','at':datetime.datetime.now(datetime.timezone.utc).isoformat()})
        break
try:
    output,error=child.communicate(timeout=10)
except subprocess.TimeoutExpired:
    os.killpg(child.pid,signal.SIGTERM)
    result['signals'].append({'signal':'SIGTERM','at':datetime.datetime.now(datetime.timezone.utc).isoformat()})
    output,error=child.communicate(timeout=10)
for line in output.splitlines():
    try:
        kind=json.loads(line).get('type')
    except ValueError:
        continue
    if kind in ['thread.started','turn.started','turn.completed','turn.failed','error']:
        result['events'].append(kind)
result['exitCode']=child.returncode
result['stderrPresent']=bool(error)
result['knownPidsBeforeSignal']=known
current_table=process_table()
result['remainingKnownPids']=[pid for pid in known if pid in current_table]
result['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
(lab / 'cancel-result.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
