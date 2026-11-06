#Requires -Version 5.1
<#
.SYNOPSIS
  Starts a deployed OiJudge server and waits until /api/health answers.

.DESCRIPTION
  Reads install.json from the deployment directory, starts node.exe with the
  same environment the installer used, then polls
  http://127.0.0.1:<port>/api/health. Safe to run twice: an already healthy
  instance is reported and left alone.

.PARAMETER DeployDir
  Deployment directory created by install.ps1. Default:
  %LOCALAPPDATA%\OiJudge\deploy.

.PARAMETER OpenBrowser
  Open http://127.0.0.1:<port>/ in the default browser after a successful
  start. Used by the desktop shortcut launcher.

.PARAMETER DryRun
  Print the command that would run without starting anything.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File start.ps1 -DeployDir C:\OiJudge
#>
[CmdletBinding()]
param(
  [string]$DeployDir,
  [switch]$OpenBrowser,
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
if (-not $state) {
  Stop-OijDeployment -ExitCode $OijExitNotInstalled -Message (
    "OiJudge is not installed in {0}. Run install.ps1 first, or pass -DeployDir for a custom location." -f
    $DeployDir
  )
}

$appDir = [string]$state.appDir
if (-not $appDir) {
  $appDir = Join-Path $DeployDir 'app'
}
$dataDir = [string]$state.dataDir
if (-not $dataDir) {
  $dataDir = Get-OijDefaultDataDir
}
$port = [int]$state.port
if ($port -le 0) {
  $port = 8787
}
$logDir = [string]$state.logDir
if (-not $logDir) {
  $logDir = Join-Path $dataDir 'logs'
}
$url = 'http://127.0.0.1:{0}/' -f $port
$cliPath = Join-Path $appDir 'apps\server\dist\cli.js'

if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
  Stop-OijDeployment -ExitCode $OijExitUsage -Message (
    "The deployed application is missing or incomplete: {0}. Reinstall with install.ps1." -f $appDir
  )
}

$running = @(Get-OijProcessesForApp -AppDir $appDir)
if ($running.Count -gt 0) {
  $processIdText = ($running | ForEach-Object { [string]$_.ProcessId }) -join ', '
  if (Test-OijHealth -Port $port) {
    Write-OijOk ("OiJudge is already running at {0} (PID {1})." -f $url, $processIdText)
    if ($OpenBrowser) {
      Start-Process $url
      Write-OijOk ("opened {0}" -f $url)
    }
    exit $OijExitSuccess
  }
  Write-OijWarn ("A server process is running (PID {0}) but /api/health is not answering." -f $processIdText)
  Write-OijWarn 'Run stop.ps1 and then start.ps1 again to restart it.'
  exit $OijExitHealthCheck
}

$listener = Get-OijPortListener -Port $port
if ($listener) {
  Stop-OijDeployment -ExitCode $OijExitPortInUse -Message (
    "TCP port {0} is already in use by PID {1}. Stop that process or reinstall on another port." -f
    $port, $listener.OwningProcess
  )
}

$nodePath = [string]$state.nodePath
if (-not $nodePath -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  $nodePath = Get-OijNodePath
}
if (-not $nodePath) {
  Stop-OijDeployment -ExitCode $OijExitUsage -Message (
    'node.exe was not found. Install Node.js 24+ and make sure it is on PATH, ' +
    'or set the OIJ_NODE environment variable to the full path of node.exe.'
  )
}

if ($DryRun) {
  Write-OijPlan ("start {0} `"{1}`" (working directory {2})" -f $nodePath, $cliPath, $appDir)
  Write-OijPlan ("data directory {0}, port {1}" -f $dataDir, $port)
  Write-OijPlan ("wait up to 30 s for http://127.0.0.1:{0}/api/health" -f $port)
  Write-OijPlan 'dry run finished; nothing was started'
  exit $OijExitSuccess
}

Write-Host ("[..] starting OiJudge on port {0}" -f $port)
$serverProcess = Start-OijServer -AppDir $appDir -DataDir $dataDir -Port $port -NodePath $nodePath -LogDir $logDir
if (-not (Wait-OijHealth -Port $port -TimeoutSeconds 30)) {
  Show-OijLogTail -LogDir $logDir -Lines 25
  Stop-OijDeployment -ExitCode $OijExitHealthCheck -Message (
    "The server did not answer on {0}api/health within 30 s. See the log files under {1}." -f
    $url, $logDir
  )
}

Write-OijOk ("OiJudge is running at {0} (PID {1})." -f $url, $serverProcess.Id)
if ($OpenBrowser) {
  Start-Process $url
  Write-OijOk ("opened {0}" -f $url)
}
exit $OijExitSuccess
