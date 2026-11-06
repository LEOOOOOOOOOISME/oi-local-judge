#Requires -Version 5.1
<#
.SYNOPSIS
  Stops a deployed OiJudge server.

.DESCRIPTION
  Finds node.exe processes whose command line runs the deployed
  apps\server\dist\cli.js and terminates them. Idempotent: running it when the
  server is already stopped is a no-op. The SQLite database uses WAL, so a hard
  stop is crash-safe; the next start recovers interrupted work automatically.

.PARAMETER DeployDir
  Deployment directory created by install.ps1. Default:
  %LOCALAPPDATA%\OiJudge\deploy.

.PARAMETER DryRun
  Print the processes that would be stopped without stopping anything.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File stop.ps1
#>
[CmdletBinding()]
param(
  [string]$DeployDir,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'oij-common.ps1')

$currentDirectory = (Get-Location).Path
if (-not $DeployDir) {
  $DeployDir = Get-OijDefaultDeployDir
} else {
  $DeployDir = Resolve-OijFullPath -Path $DeployDir -BaseDirectory $currentDirectory
}

$state = Read-OijInstallState -DeployDir $DeployDir
$appDir = Join-Path $DeployDir 'app'
if ($state -and $state.appDir) {
  $appDir = [string]$state.appDir
}

if (-not $state -and -not (Test-Path -LiteralPath $appDir)) {
  Stop-OijDeployment -ExitCode $OijExitNotInstalled -Message (
    "OiJudge is not installed in {0}. Pass -DeployDir for a custom location." -f $DeployDir
  )
}

$running = @()
if (Test-Path -LiteralPath $appDir) {
  $running = @(Get-OijProcessesForApp -AppDir $appDir)
}
if ($running.Count -eq 0) {
  Write-OijSkip 'OiJudge is not running.'
  exit $OijExitSuccess
}

$processIdText = ($running | ForEach-Object { [string]$_.ProcessId }) -join ', '
if ($DryRun) {
  Write-OijPlan ("stop the OiJudge server process(es): PID {0}" -f $processIdText)
  Write-OijPlan 'dry run finished; nothing was stopped'
  exit $OijExitSuccess
}

Write-Host ("[..] stopping OiJudge (PID {0})" -f $processIdText)
if (-not (Stop-OijProcessesForApp -AppDir $appDir)) {
  Stop-OijDeployment -ExitCode $OijExitFailure -Message (
    "The OiJudge server is still running (PID {0}). Stop it manually, then run this script again." -f
    $processIdText
  )
}
Write-OijOk 'OiJudge stopped.'
exit $OijExitSuccess
