#!/bin/sh
# Portable wrapper around the shared Node installer; no host logic lives here.
# Every argument is forwarded, so --dry-run and --remove-legacy work here too.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec node "$ROOT/scripts/install.mjs" "$@"
