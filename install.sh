#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec node "$ROOT/scripts/install.mjs" "${1:-both}"
