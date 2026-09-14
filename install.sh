#!/bin/sh
# Portable wrapper around the shared Node installer; no host logic lives here.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec node "$ROOT/scripts/install.mjs" "${1:-both}"
