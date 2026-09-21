#!/usr/bin/env python3
"""Collect allowlisted local proxy history; admin authentication stays in memory."""
import argparse
import json
from pathlib import Path
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--lab', type=Path, required=True)
parser.add_argument('--port', type=int, default=18473)
args = parser.parse_args()
# Read only the experiment's management token; never copy it to output or argv.
headers = {'X-OpenCodex-API-Key': (args.lab / 'ocx/admin-api-token').read_text().strip()}
url = f'http://127.0.0.1:{args.port}/api/request-history?limit=100'
with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=10) as response:
    data = json.load(response)
fields = ['timestamp', 'requestedModel', 'model', 'resolvedModel', 'provider', 'status', 'usageStatus']
attempt_fields = ['ordinal', 'provider', 'model', 'adapter', 'status', 'sendCount', 'accountLogLabel', 'requestedEffort', 'durationMs', 'recoveryKinds']
rows = []
for row in data['entries']:
    clean = {k: row[k] for k in fields if k in row}
    clean['usage'] = {k: v for k, v in row.get('usage', {}).items() if isinstance(v, (int, float))}
    clean['attempts'] = [{k: a[k] for k in attempt_fields if k in a} for a in row.get('attempts', [])]
    clean['routeKind'] = row.get('routeDecision', {}).get('routeKind')
    rows.append(clean)
result = {'entries': rows, 'hasMore': data.get('hasMore'),
          'modelObservationScope': 'proxy routing/history, not independently verified upstream identity'}
(args.lab / 'request-summary.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'entries': len(rows), 'hasMore': result['hasMore']}))
