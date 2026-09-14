# PowerShell wrapper around the shared Node installer; no host logic lives here.
param([ValidateSet('claude', 'codex', 'both')][string]$HostName = 'both')
$ErrorActionPreference = 'Stop'
node (Join-Path $PSScriptRoot 'scripts/install.mjs') $HostName
exit $LASTEXITCODE
