#Requires -Version 5.1
<#
.SYNOPSIS
  Removes an OiJudge deployment created by install.ps1.

.DESCRIPTION
  Stops the server, removes the HKCU Run autostart entry and its VBS wrapper,
  the desktop shortcut, the Windows Firewall rule, the deployed application
  tree and the install state. The data directory is kept by default; pass
  -RemoveData to delete the database, submissions and logs as well.

  Removing the firewall rule needs an elevated PowerShell. When the rule exists
  and the script is not elevated, the rest of the cleanup still runs and the
  script exits with code 3.

.PARAMETER DeployDir
  Deployment directory created by install.ps1. Default:
  %LOCALAPPDATA%\OiJudge\deploy.

.PARAMETER DataDir
  Override the data directory recorded in install.json.

.PARAMETER RemoveData
  Also delete the data directory (database, submissions, temp files, logs).
  Without this switch the data is left in place and the path is printed.

.PARAMETER DryRun
  Print the cleanup steps without changing anything.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File uninstall.ps1

.EXAMPLE
  # Elevated, and delete the data directory too.
  powershell -ExecutionPolicy Bypass -File uninstall.ps1 -RemoveData
#>
[CmdletBinding()]
param(
  [string]$DeployDir,
  [string]$DataDir,
  [switch]$RemoveData,
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
if ($DataDir) {
  $DataDir = Resolve-OijFullPath -Path $DataDir -BaseDirectory $currentDirectory
}

$state = Read-OijInstallState -DeployDir $DeployDir
$appDir = Join-Path $DeployDir 'app'
$scriptsDir = Join-Path $DeployDir 'scripts'
$launcherPath = Join-Path $DeployDir $OijLauncherFileName
$shortcutCandidates = @()
$port = 8787
$firewallExpected = $false

if ($state) {
  if ($state.appDir) {
    $appDir = [string]$state.appDir
  }
  if (-not $DataDir -and $state.dataDir) {
    $DataDir = [string]$state.dataDir
  }
  if ($state.port) {
    $port = [int]$state.port
  }
  if ($state.shortcut) {
    $shortcutCandidates += [string]$state.shortcut
  }
  if ($state.scriptDir) {
    $scriptsDir = [string]$state.scriptDir
  }
  if ($state.launcher) {
    $launcherPath = [string]$state.launcher
  }
  if ($state.firewallRule) {
    $firewallExpected = $true
  }
}
if (-not $DataDir) {
  $DataDir = Get-OijDefaultDataDir
}
$defaultShortcut = Get-OijDesktopShortcutPath
if ($defaultShortcut) {
  $shortcutCandidates += $defaultShortcut
}
$shortcutCandidates = @($shortcutCandidates | Select-Object -Unique)

$deployExists = Test-Path -LiteralPath $DeployDir
if (-not $state -and -not $deployExists) {
  Write-OijSkip ("OiJudge is not installed in {0}; nothing to uninstall." -f $DeployDir)
  exit $OijExitSuccess
}
if (-not $state) {
  Write-OijWarn ("No install.json found in {0}; performing a best-effort cleanup of known locations." -f $DeployDir)
}

$titleSuffix = ''
if ($DryRun) {
  $titleSuffix = ' (dry run)'
}
Write-Host ''
Write-Host ("OiJudge uninstall{0}" -f $titleSuffix) -ForegroundColor Cyan
Write-Host ("  deploy:  {0}" -f $DeployDir)
Write-Host ("  data:    {0}{1}" -f $DataDir, $(if ($RemoveData) { ' (will be deleted)' } else { ' (kept)' }))
Write-Host ''

$cleanupIncomplete = $false
$administratorBlocked = $false
$predictedExitCode = $OijExitSuccess

# --- Stop the server -----------------------------------------------------
$running = @()
if (Test-Path -LiteralPath $appDir) {
  $running = @(Get-OijProcessesForApp -AppDir $appDir)
}
if ($running.Count -gt 0) {
  $processIdText = ($running | ForEach-Object { [string]$_.ProcessId }) -join ', '
  if ($DryRun) {
    Write-OijPlan ("stop the running server (PID {0})" -f $processIdText)
  } else {
    Write-Host ("[..] stopping the running server (PID {0})" -f $processIdText)
    if (-not (Stop-OijProcessesForApp -AppDir $appDir)) {
      Stop-OijDeployment -ExitCode $OijExitFailure -Message (
        "Could not stop PID {0}. Stop it manually and run this script again." -f $processIdText
      )
    }
    Write-OijOk 'running server stopped'
  }
} else {
  Write-OijSkip 'no running server was found'
}

# --- Autostart -----------------------------------------------------------
$autostartCommand = Get-OijAutostartCommand
if ($autostartCommand) {
  if ($DryRun) {
    Write-OijPlan 'remove the HKCU Run autostart entry (value name OiJudge)'
  } else {
    Remove-OijAutostartCommand
    Write-OijOk 'removed the HKCU Run autostart entry'
  }
} else {
  Write-OijSkip 'no HKCU Run autostart entry was found'
}

# --- Desktop shortcut ----------------------------------------------------
$removedShortcut = $false
foreach ($shortcutPath in $shortcutCandidates) {
  if (-not $shortcutPath -or -not (Test-Path -LiteralPath $shortcutPath)) {
    continue
  }
  if ($DryRun) {
    Write-OijPlan ("delete desktop shortcut {0}" -f $shortcutPath)
  } else {
    Remove-Item -LiteralPath $shortcutPath -Force
    Write-OijOk ("deleted desktop shortcut {0}" -f $shortcutPath)
  }
  $removedShortcut = $true
}
if (-not $removedShortcut) {
  Write-OijSkip 'no desktop shortcut was found'
}

# --- Windows Firewall ----------------------------------------------------
if (Test-OijFirewallRule -Port $port) {
  if ($DryRun) {
    if (-not (Test-OijAdministrator)) {
      Write-OijPlan ("remove firewall rule '{0}' (needs administrator)" -f (Get-OijFirewallRuleName -Port $port))
      $predictedExitCode = $OijExitAdminRequired
    } else {
      Write-OijPlan ("remove firewall rule '{0}'" -f (Get-OijFirewallRuleName -Port $port))
    }
  } elseif (-not (Test-OijAdministrator)) {
    $firewallWarning = (
      "The firewall rule '{0}' exists but removing it needs an elevated PowerShell. " +
      "Re-run this script as administrator to remove it."
    ) -f (Get-OijFirewallRuleName -Port $port)
    Write-OijWarn $firewallWarning
    $administratorBlocked = $true
  } elseif (Remove-OijFirewallRule -Port $port) {
    Write-OijOk ("removed firewall rule '{0}'" -f (Get-OijFirewallRuleName -Port $port))
  } else {
    Write-OijWarn 'the firewall rule could not be removed'
    $cleanupIncomplete = $true
  }
} elseif ($firewallExpected -and $state.firewallRule) {
  Write-OijSkip ("firewall rule '{0}' is already gone" -f [string]$state.firewallRule)
} else {
  Write-OijSkip 'no firewall rule was found'
}

# --- Worker isolation (F-01) --------------------------------------------
if ($state -and $state.PSObject.Properties['workerIsolation'] -and $state.workerIsolation) {
  $workerAccount = $OijWorkerAccountName
  if ($DryRun) {
    Write-OijPlan ("remove the outbound firewall rule and local user {0} (needs administrator)" -f $workerAccount)
  } elseif (-not (Test-OijAdministrator)) {
    Write-OijWarn ("worker isolation cleanup (firewall rule/local user {0}) needs an elevated PowerShell" -f $workerAccount)
    $administratorBlocked = $true
  } else {
    try {
      $workerRule = Get-NetFirewallRule -DisplayName 'OiJudge Worker outbound block' -ErrorAction SilentlyContinue
      if ($workerRule) { Remove-NetFirewallRule -DisplayName 'OiJudge Worker outbound block' }
      if (Get-LocalUser -Name $workerAccount -ErrorAction SilentlyContinue) {
        Remove-LocalUser -Name $workerAccount
      }
      Write-OijOk ("removed the worker firewall rule and local user {0}" -f $workerAccount)
    } catch {
      Write-OijWarn ("could not fully remove worker isolation: {0}" -f $_.Exception.Message)
      $cleanupIncomplete = $true
    }
  }
}

# --- Application tree, launcher, helper scripts, state ------------------
if ((Test-Path -LiteralPath $appDir) -or (Test-OijReparsePoint -Path $appDir)) {
  if ($DryRun) {
    if (Test-OijReparsePoint -Path $appDir) {
      Write-OijPlan ("delete junction {0} (the linked source is not touched)" -f $appDir)
    } else {
      Write-OijPlan ("delete deployed application tree {0}" -f $appDir)
    }
  } else {
    try {
      Remove-OijAppDirectory -Path $appDir
      Write-OijOk ("deleted deployed application tree {0}" -f $appDir)
    } catch {
      Write-OijWarn ("could not delete {0}: {1}" -f $appDir, $_.Exception.Message)
      $cleanupIncomplete = $true
    }
  }
}

foreach ($filePath in @($launcherPath, (Get-OijStatePath -DeployDir $DeployDir))) {
  if (-not $filePath -or -not (Test-Path -LiteralPath $filePath)) {
    continue
  }
  if ($DryRun) {
    Write-OijPlan ("delete {0}" -f $filePath)
  } else {
    Remove-Item -LiteralPath $filePath -Force
    Write-OijOk ("deleted {0}" -f $filePath)
  }
}

if (Test-Path -LiteralPath $scriptsDir) {
  if ($DryRun) {
    Write-OijPlan ("delete helper scripts {0}" -f $scriptsDir)
  } else {
    try {
      Remove-Item -LiteralPath $scriptsDir -Recurse -Force
      Write-OijOk ("deleted helper scripts {0}" -f $scriptsDir)
    } catch {
      # The script may be running from this very directory.
      Write-OijWarn ("could not delete {0}: {1}. Delete it manually after this run." -f
        $scriptsDir, $_.Exception.Message)
      $cleanupIncomplete = $true
    }
  }
}

# --- Data directory ------------------------------------------------------
if ($RemoveData) {
  $normalizedData = $DataDir.TrimEnd('\')
  $rootPath = [IO.Path]::GetPathRoot($normalizedData).TrimEnd('\')
  if ($normalizedData.Length -lt 4 -or $normalizedData -eq $rootPath) {
    Stop-OijDeployment -ExitCode $OijExitUsage -Message (
      "Refusing to delete {0}: it is a drive root. Pass a proper -DataDir." -f $DataDir
    )
  }
  if ($DryRun) {
    Write-OijPlan ("delete data directory {0}" -f $DataDir)
  } elseif (Test-Path -LiteralPath $DataDir) {
    Remove-Item -LiteralPath $DataDir -Recurse -Force
    Write-OijOk ("deleted data directory {0}" -f $DataDir)
  } else {
    Write-OijSkip ("data directory {0} does not exist" -f $DataDir)
  }
} else {
  Write-OijSkip ("keeping data directory {0} (pass -RemoveData to delete it)" -f $DataDir)
}

# --- Remove the deployment directory when it is empty -------------------
if (Test-Path -LiteralPath $DeployDir) {
  $remaining = @(Get-ChildItem -LiteralPath $DeployDir -Force -ErrorAction SilentlyContinue)
  if ($remaining.Count -eq 0) {
    if ($DryRun) {
      Write-OijPlan ("delete the empty deployment directory {0}" -f $DeployDir)
    } else {
      Remove-Item -LiteralPath $DeployDir -Force
      Write-OijOk ("deleted the empty deployment directory {0}" -f $DeployDir)
    }
  } else {
    Write-OijSkip ("deployment directory kept; it still contains {0} item(s)" -f $remaining.Count)
  }
}

Write-Host ''
if ($predictedExitCode -ne $OijExitSuccess) {
  Write-OijWarn ("Dry run finished; the real run would exit with code {0}." -f $predictedExitCode)
  exit $predictedExitCode
}
if ($administratorBlocked) {
  Write-OijWarn 'Uninstall finished, but the firewall rule needs an elevated re-run.'
  exit $OijExitAdminRequired
}
if ($cleanupIncomplete) {
  Write-OijWarn 'Uninstall finished with warnings; see the messages above.'
  exit $OijExitFailure
}
if ($DryRun) {
  Write-OijPlan 'dry run finished; nothing was changed'
} else {
  Write-OijOk 'OiJudge was uninstalled.'
  if (-not $RemoveData) {
    Write-Host ("  Data kept at {0}" -f $DataDir)
  }
}
exit $OijExitSuccess
