param(
  [string]$Distribution = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

function Invoke-Wsl {
  param([Parameter(Mandatory = $true)][string]$Command)

  $args = @()
  if ($Distribution) {
    $args += @("--distribution", $Distribution)
  }
  $args += @("--exec", "bash", "-lc", $Command)
  & wsl.exe @args
  if ($LASTEXITCODE -ne 0) {
    throw "WSL command failed with exit code $LASTEXITCODE"
  }
}

$status = (& wsl.exe --status 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) {
  throw "WSL is unavailable: $status"
}

$wslPathArgs = @()
if ($Distribution) {
  $wslPathArgs += @("--distribution", $Distribution)
}
$wslPathArgs += @("--exec", "wslpath", "-a", $RepoRoot)
$wslRepoRoot = (& wsl.exe @wslPathArgs).Trim()
if (-not $wslRepoRoot) {
  throw "failed to resolve repository path inside WSL"
}

$command = @"
set -euo pipefail
cd '$wslRepoRoot'
command -v node >/dev/null
command -v pnpm >/dev/null
command -v cargo >/dev/null
command -v bwrap >/dev/null
pnpm sandbox:native:build:platform -- --platform linux --arch x64
pnpm sandbox:native:protocol
pnpm sandbox:native:smoke
"@

Invoke-Wsl -Command $command
Write-Host "[wsl-smoke] WSL2 sandbox validation passed"
