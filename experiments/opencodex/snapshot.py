#!/usr/bin/env python3
"""Hash global configuration and keychain metadata without requesting secrets."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--compare', type=Path)
args = parser.parse_args()
files = {}
for name in ['.codex/config.toml', '.claude/settings.json', '.opencodex', '.gemini', '.zshrc']:
    path = Path.home() / name
    files[name] = dict(exists=path.exists(), mtime_ns=path.stat().st_mtime_ns if path.exists() else None,
                       sha256=hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None)
keychain = {}
for service in ['opencodex.provider-api-key.v1', 'opencodex.native-main-profile.v1', 'Claude Code-credentials']:
    child = subprocess.run(['security', 'find-generic-password', '-s', service], capture_output=True)
    keychain[service] = dict(exit=child.returncode, metadata_sha256=hashlib.sha256(child.stdout).hexdigest(),
                            secret_requested=False)
result = dict(timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat(), files=files, keychain=keychain)
if args.compare:
    before = json.loads(args.compare.read_text())
    result['unchanged'] = {key: before[key] == result[key] for key in ['files', 'keychain']}
args.output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
