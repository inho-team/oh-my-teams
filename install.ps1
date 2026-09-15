# PowerShell wrapper around the shared Node installer; no host logic lives here.
# Every argument is forwarded, so --dry-run and --remove-legacy work here too.
# The installer validates them, which keeps one usage message for both wrappers.
$ErrorActionPreference = 'Stop'
node (Join-Path $PSScriptRoot 'scripts/install.mjs') @args
exit $LASTEXITCODE
