#Requires -Version 5.1
<#
.SYNOPSIS
  Shows the state of an OiJudge deployment.

.DESCRIPTION
  Read-only: prints paths, version, port, process/health state, firewall rule,
  desktop shortcut and autostart registration from install.json. Exits 6 when
  no deployment state is found.

.PARAMETER DeployDir
  Deployment directory created by install.ps1. Default:
  %LOCALAPPDATA%\OiJudge\deploy.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File status.ps1
#>
[CmdletBinding()]
param(
  [string]$DeployDir
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
  Write-Host ("OiJudge is not installed in {0}." -f $DeployDir) -ForegroundColor Yellow
  Write-Host 'Run install.ps1 to deploy it.'
  exit $OijExitNotInstalled
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
$url = 'http://127.0.0.1:{0}/' -f $port
$logDir = [string]$state.logDir
if (-not $logDir) {
  $logDir = Join-Path $dataDir 'logs'
}
$linkMode = [string]$state.linkMode
if (-not $linkMode) {
  if (Test-OijReparsePoint -Path $appDir) {
    $linkMode = 'link (junction)'
  } else {
    $linkMode = 'copy'
  }
} else {
  if ($linkMode -eq 'link') {
    $linkMode = 'link (junction)'
  }
}

$running = @()
$appDirExists = Test-Path -LiteralPath $appDir
if ($appDirExists) {
  $running = @(Get-OijProcessesForApp -AppDir $appDir)
}
$healthy = $false
if ($running.Count -gt 0) {
  $healthy = Test-OijHealth -Port $port
}
$listener = Get-OijPortListener -Port $port

function Format-OijStatusLine {
  param([string]$Label, [string]$Value, [string]$Color = 'Gray')
  Write-Host ('  {0,-12}{1}' -f ($Label + ':'), $Value) -ForegroundColor $Color
}

Write-Host ''
Write-Host 'OiJudge deployment status' -ForegroundColor Cyan
Write-Host ''
Format-OijStatusLine -Label 'Deploy dir' -Value $DeployDir
Format-OijStatusLine -Label 'App dir' -Value ("{0} ({1})" -f $appDir, $linkMode)
Format-OijStatusLine -Label 'Scripts' -Value ([string]$state.scriptDir)
Format-OijStatusLine -Label 'Data dir' -Value $dataDir
Format-OijStatusLine -Label 'Logs' -Value $logDir
Format-OijStatusLine -Label 'URL' -Value $url

$version = [string]$state.version
if (-not $version) {
  $version = Get-OijAppVersion -AppDir $appDir
}
if ($version) {
  Format-OijStatusLine -Label 'Version' -Value $version
}
Format-OijStatusLine -Label 'Installed' -Value ([string]$state.installedAt)
Format-OijStatusLine -Label 'Source' -Value ("{0} ({1})" -f [string]$state.source, [string]$state.sourceKind)

if (-not $appDirExists) {
  Format-OijStatusLine -Label 'App state' -Value 'MISSING (reinstall with install.ps1)' -Color 'Red'
} elseif ($running.Count -gt 0) {
  $processIdText = ($running | ForEach-Object { [string]$_.ProcessId }) -join ', '
  Format-OijStatusLine -Label 'Process' -Value ("running (PID {0})" -f $processIdText) -Color 'Green'
} else {
  Format-OijStatusLine -Label 'Process' -Value 'stopped' -Color 'Yellow'
}

if ($running.Count -gt 0 -and $healthy) {
  Format-OijStatusLine -Label 'Health' -Value 'ok' -Color 'Green'
} elseif ($running.Count -gt 0) {
  Format-OijStatusLine -Label 'Health' -Value 'not answering' -Color 'Red'
} else {
  Format-OijStatusLine -Label 'Health' -Value 'not checked (server stopped)'
}

if ($listener) {
  Format-OijStatusLine -Label 'Port' -Value ("{0} (listening, PID {1})" -f $port, $listener.OwningProcess)
} else {
  Format-OijStatusLine -Label 'Port' -Value ("{0} (free)" -f $port)
}

if ([string]$state.firewallRule) {
  if (Test-OijFirewallRule -Port $port) {
    Format-OijStatusLine -Label 'Firewall' -Value ([string]$state.firewallRule) -Color 'Green'
  } else {
    Format-OijStatusLine -Label 'Firewall' -Value 'rule missing (reinstall or add it manually)' -Color 'Red'
  }
} else {
  Format-OijStatusLine -Label 'Firewall' -Value 'not created at install'
}

$shortcutPath = [string]$state.shortcut
if (-not $shortcutPath) {
  $shortcutPath = Get-OijDesktopShortcutPath
}
if ($shortcutPath -and (Test-Path -LiteralPath $shortcutPath)) {
  Format-OijStatusLine -Label 'Shortcut' -Value ('present: ' + $shortcutPath)
} else {
  Format-OijStatusLine -Label 'Shortcut' -Value 'missing'
}

$autostart = Get-OijAutostartCommand
if ($autostart) {
  Format-OijStatusLine -Label 'Autostart' -Value 'enabled (HKCU Run)' -Color 'Green'
} else {
  Format-OijStatusLine -Label 'Autostart' -Value 'disabled'
}
if ($null -ne $state.autostart -and $state.autostart.command) {
  Format-OijStatusLine -Label 'Start cmd' -Value ([string]$state.autostart.command)
}

Write-Host ''
exit $OijExitSuccess
