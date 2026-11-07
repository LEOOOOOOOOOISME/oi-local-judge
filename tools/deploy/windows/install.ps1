#Requires -Version 5.1
<#
.SYNOPSIS
  Installs OiJudge as an always-on local web server on Windows.

.DESCRIPTION
  The script deploys the server tree (a repository build or an extracted
  portable build) into a deployment directory, prepares the data directory,
  optionally opens the Windows Firewall, creates a desktop shortcut and a
  sign-in autostart entry (HKCU Run), then starts the server and waits until
  GET /api/health answers. Finally it writes install.json next to the app so
  start/stop/status/uninstall can find the deployment.

  Nothing in the machine-wide service database (SCM) is touched: the server
  runs as a hidden node.exe process owned by the current user. Use a dedicated
  Windows account when the judge must survive sign-out or run as a service.

.PARAMETER RepoRoot
  Application source: either a repository checkout containing
  apps\server\dist\cli.js, or an extracted portable directory containing
  resources\app\apps\server\dist\cli.js. When omitted the script looks next to
  itself and in <root>\release\oi-local-judge-*-win-x64 (newest first).

.PARAMETER DeployDir
  Deployment directory. Default: %LOCALAPPDATA%\OiJudge\deploy.
  The application tree is placed in <DeployDir>\app and helper scripts in
  <DeployDir>\scripts.

.PARAMETER DataDir
  Data directory (database, submissions, logs). Default:
  %LOCALAPPDATA%\OiJudge\runtime. It survives reinstall and upgrade.

.PARAMETER Port
  TCP port for the web UI and API. Default: 8787. The server listens on
  127.0.0.1 by default; pass -Lan to expose it on all interfaces.

.PARAMETER Lan
  Listen on 0.0.0.0 and create the inbound Windows Firewall rule so other
  classroom machines can reach the OJ. Without this switch the server is only
  reachable from this machine (127.0.0.1).

.PARAMETER NoFirewall
  Do not create the inbound Windows Firewall rule. The firewall rule is the
  only step that needs an elevated PowerShell.

.PARAMETER NoShortcut
  Do not create the desktop shortcut.

.PARAMETER NoAutostart
  Do not register the HKCU Run autostart entry.

.PARAMETER Mode
  auto (default): junction when deploying a repository checkout, copy when
  deploying a portable build. copy: copy the portable application tree (only
  valid for portable builds). link: create a directory junction to the source
  tree so a rebuilt source takes effect without reinstalling.

.PARAMETER DryRun
  Validate everything and print the planned actions without changing the
  machine. The script exits with the code the real run would use when the plan
  is blocked (for example 3 when the firewall rule needs elevation).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\deploy\windows\install.ps1 -DryRun

.EXAMPLE
  # Elevated PowerShell: deploy the newest portable build, port 8787.
  powershell -ExecutionPolicy Bypass -File tools\deploy\windows\install.ps1

.EXAMPLE
  # Deployment without firewall/shortcut/autostart (no elevation needed).
  .\install.ps1 -RepoRoot C:\builds\oi-local-judge-1.1.0-win-x64 -Port 8080 -NoFirewall -NoShortcut -NoAutostart
#>
[CmdletBinding()]
param(
  [string]$RepoRoot,
  [string]$DeployDir,
  [string]$DataDir,
  [int]$Port = 8787,
  [switch]$Lan,
  [switch]$NoFirewall,
  [switch]$NoShortcut,
  [switch]$NoAutostart,
  [ValidateSet('auto', 'copy', 'link')][string]$Mode = 'auto',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'oij-common.ps1')

if ($Port -lt 1 -or $Port -gt 65535) {
  Stop-OijDeployment -ExitCode $OijExitUsage -Message ("-Port must be between 1 and 65535 (got {0})." -f $Port)
}

$currentDirectory = (Get-Location).Path
if (-not $DeployDir) {
  $DeployDir = Get-OijDefaultDeployDir
} else {
  $DeployDir = Resolve-OijFullPath -Path $DeployDir -BaseDirectory $currentDirectory
}
if (-not $DataDir) {
  $DataDir = Get-OijDefaultDataDir
} else {
  $DataDir = Resolve-OijFullPath -Path $DataDir -BaseDirectory $currentDirectory
}

# --- Source ---------------------------------------------------------------
$source = Resolve-OijAppSource -Override $RepoRoot -ScriptRoot $PSScriptRoot
if (-not $source.AppDir) {
  $checkedList = @($source.Checked)
  $checkedText = '  (nothing)'
  if ($checkedList.Count -gt 0) {
    $checkedText = ($checkedList | ForEach-Object { '  ' + $_ }) -join [Environment]::NewLine
  }
  $sourceMessage = (
    "No runnable OiJudge application was found.`nChecked:`n" + $checkedText + "`n" +
    "Build it first with 'npm run build' (repository) or 'npm run build:release' (portable), " +
    "or pass -RepoRoot <path> explicitly."
  )
  Stop-OijDeployment -ExitCode $OijExitUsage -Message $sourceMessage
}
$appSource = $source.AppDir
$sourceKind = $source.Kind
$sourceRoot = $source.Root
$appVersion = Get-OijAppVersion -AppDir $appSource

$sourceProblems = @(Get-OijSourceProblems -AppDir $appSource)
if ($sourceProblems.Count -gt 0) {
  $problemMessage = (
    "The application tree at {0} is incomplete; missing: {1}.`n" +
    "Run 'npm run build' in the repository or unpack a fresh portable ZIP, then retry."
  ) -f $appSource, ($sourceProblems -join ', ')
  Stop-OijDeployment -ExitCode $OijExitUsage -Message $problemMessage
}
foreach ($missingNative in @(Get-OijSourceWarnings -AppDir $appSource)) {
  Write-OijWarn ("{0} is missing; the site will start but submissions cannot be judged until native runners are built." -f $missingNative)
}

$nodePath = Get-OijNodePath
if (-not $nodePath) {
  Stop-OijDeployment -ExitCode $OijExitUsage -Message (
    "node.exe was not found. Install Node.js 24+ (x64) and make sure it is on PATH, " +
    "or set the OIJ_NODE environment variable to the full path of node.exe."
  )
}

# --- Mode ----------------------------------------------------------------
$resolvedMode = $Mode
if ($resolvedMode -eq 'auto') {
  if ($sourceKind -eq 'portable') {
    $resolvedMode = 'copy'
  } else {
    $resolvedMode = 'link'
  }
}
if ($resolvedMode -eq 'copy' -and $sourceKind -eq 'repo') {
  Stop-OijDeployment -ExitCode $OijExitUsage -Message (
    "Copy mode is only supported for a portable build. A repository checkout also contains " +
    ".git, tests and build sources, which must not be copied as-is. Create a portable tree " +
    "with 'npm run build:release' and point -RepoRoot at it, or keep the default link mode."
  )
}

$appTarget = Join-Path $DeployDir 'app'
$scriptsDir = Join-Path $DeployDir 'scripts'
$logDir = Join-Path $DataDir 'logs'
$launcherPath = Join-Path $DeployDir $OijLauncherFileName

if ($resolvedMode -eq 'link') {
  $sourceFull = [IO.Path]::GetFullPath($appSource).TrimEnd('\')
  $targetFull = [IO.Path]::GetFullPath($appTarget).TrimEnd('\')
  $nested = $false
  if ($targetFull.StartsWith($sourceFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
    $nested = $true
  }
  if ($sourceFull.StartsWith($targetFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
    $nested = $true
  }
  if ($sourceFull -eq $targetFull) {
    $nested = $true
  }
  if ($nested) {
    Stop-OijDeployment -ExitCode $OijExitUsage -Message (
      "The deploy directory and the application source must not contain each other when a " +
      "junction is used ({0} vs {1}). Choose another -DeployDir or install from a portable build." -f
      $DeployDir, $appSource
    )
  }
}

# --- Elevation -----------------------------------------------------------
$administrator = Test-OijAdministrator
# A loopback-only install needs no firewall exception (and no elevation).
$firewallRequested = (-not $NoFirewall) -and $Lan
$hostAddress = if ($Lan) { '0.0.0.0' } else { '127.0.0.1' }
$predictedExitCode = $OijExitSuccess
if ($firewallRequested -and -not $administrator) {
  if ($DryRun) {
    Write-OijWarn 'The firewall rule needs administrator rights; the real run would stop with exit code 3. Use -NoFirewall to install without it.'
    $predictedExitCode = $OijExitAdminRequired
  } else {
    Stop-OijDeployment -ExitCode $OijExitAdminRequired -Message (
      "Administrator rights are required to add the Windows Firewall rule. Re-run this script " +
      "from an elevated PowerShell, or pass -NoFirewall to install without it."
    )
  }
}

# --- Existing deployment -------------------------------------------------
$existingState = Read-OijInstallState -DeployDir $DeployDir
$processCheckDirs = @($appTarget)
if ($existingState -and $existingState.appDir) {
  $processCheckDirs += [string]$existingState.appDir
}
$processCheckDirs = @($processCheckDirs | Select-Object -Unique)

$runningProcesses = @()
foreach ($checkDir in $processCheckDirs) {
  if (-not (Test-Path -LiteralPath $checkDir)) {
    continue
  }
  foreach ($process in @(Get-OijProcessesForApp -AppDir $checkDir)) {
    $alreadyListed = $false
    foreach ($known in $runningProcesses) {
      if ($known.ProcessId -eq $process.ProcessId) {
        $alreadyListed = $true
      }
    }
    if (-not $alreadyListed) {
      $runningProcesses += $process
    }
  }
}

$listener = Get-OijPortListener -Port $Port
if ($listener) {
  $listenerIsOurs = $false
  foreach ($process in $runningProcesses) {
    if ($process.ProcessId -eq $listener.OwningProcess) {
      $listenerIsOurs = $true
    }
  }
  if (-not $listenerIsOurs) {
    $ownerName = 'unknown'
    try {
      $owner = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + [string]$listener.OwningProcess) -ErrorAction Stop
      if ($owner -and $owner.Name) {
        $ownerName = [string]$owner.Name
      }
    } catch {
      $ownerName = 'unknown'
    }
    Stop-OijDeployment -ExitCode $OijExitPortInUse -Message (
      "TCP port {0} is already in use by PID {1} ({2}). Stop that process or pass another -Port." -f
      $Port, $listener.OwningProcess, $ownerName
    )
  }
}

$titleSuffix = ''
if ($DryRun) {
  $titleSuffix = ' (dry run)'
}
Write-Host ''
Write-Host ("OiJudge Windows deployment{0}" -f $titleSuffix) -ForegroundColor Cyan
Write-Host ("  app:       {0}" -f $appSource)
Write-Host ("  build:     {0} ({1})" -f $sourceKind, $sourceRoot)
Write-Host ("  deploy:    {0} ({1})" -f $DeployDir, $resolvedMode)
Write-Host ("  data:      {0}" -f $DataDir)
Write-Host ("  port:      {0}" -f $Port)
if ($appVersion) {
  Write-Host ("  version:   {0}" -f $appVersion)
}
Write-Host ''

# --- Stop a previous instance -------------------------------------------
if ($runningProcesses.Count -gt 0) {
  $processIdText = ($runningProcesses | ForEach-Object { [string]$_.ProcessId }) -join ', '
  if ($DryRun) {
    Write-OijPlan ("stop the running server (PID {0})" -f $processIdText)
  } else {
    Write-Host ("[..] stopping the running server (PID {0})" -f $processIdText)
    foreach ($checkDir in $processCheckDirs) {
      if (Test-Path -LiteralPath $checkDir) {
        Stop-OijProcessesForApp -AppDir $checkDir | Out-Null
      }
    }
    Write-OijOk 'running server stopped'
  }
}

# --- Deploy directory ----------------------------------------------------
if (Test-Path -LiteralPath $DeployDir) {
  Write-OijSkip ("deploy directory already exists: {0}" -f $DeployDir)
} elseif ($DryRun) {
  Write-OijPlan ("create deploy directory {0}" -f $DeployDir)
} else {
  New-OijDirectory -Path $DeployDir
  Write-OijOk ("created deploy directory {0}" -f $DeployDir)
}

# --- Application tree ----------------------------------------------------
$appExists = $false
try {
  $null = Get-Item -LiteralPath $appTarget -Force -ErrorAction Stop
  $appExists = $true
} catch {
  $appExists = $false
}
if ($DryRun) {
  if ($appExists) {
    Write-OijPlan ("remove the previous application tree {0}" -f $appTarget)
  }
  if ($resolvedMode -eq 'copy') {
    Write-OijPlan ("copy {0} -> {1}" -f $appSource, $appTarget)
  } else {
    Write-OijPlan ("create junction {0} -> {1}" -f $appTarget, $appSource)
  }
} else {
  if ($appExists) {
    Remove-OijAppDirectory -Path $appTarget
    Write-OijOk ("removed the previous application tree {0}" -f $appTarget)
  }
  if ($resolvedMode -eq 'copy') {
    Copy-Item -LiteralPath $appSource -Destination $appTarget -Recurse -Force
    Write-OijOk ("copied the application tree to {0}" -f $appTarget)
  } else {
    New-OijAppJunction -Path $appTarget -Target $appSource
    Write-OijOk ("created junction {0} -> {1}" -f $appTarget, $appSource)
  }
}

# --- Helper scripts ------------------------------------------------------
$scriptFiles = @('oij-common.ps1', 'install.ps1', 'uninstall.ps1', 'start.ps1', 'stop.ps1', 'status.ps1')
if ($DryRun) {
  Write-OijPlan ("copy {0} helper script(s) to {1}" -f $scriptFiles.Count, $scriptsDir)
} else {
  New-OijDirectory -Path $scriptsDir
  foreach ($scriptName in $scriptFiles) {
    $scriptSource = Join-Path $PSScriptRoot $scriptName
    if (-not (Test-Path -LiteralPath $scriptSource -PathType Leaf)) {
      Stop-OijDeployment -ExitCode $OijExitUsage -Message ("Missing deployment script {0}." -f $scriptSource)
    }
    Copy-Item -LiteralPath $scriptSource -Destination (Join-Path $scriptsDir $scriptName) -Force
  }
  Write-OijOk ("copied {0} helper script(s) to {1}" -f $scriptFiles.Count, $scriptsDir)
}

# --- Data directory ------------------------------------------------------
if ($DryRun) {
  Write-OijPlan ("create data directory {0} (db, problems, submissions, tmp, logs)" -f $DataDir)
} else {
  foreach ($directory in @($DataDir, $logDir, (Join-Path $DataDir 'db'), (Join-Path $DataDir 'problems'),
      (Join-Path $DataDir 'submissions'), (Join-Path $DataDir 'tmp'))) {
    New-OijDirectory -Path $directory
  }
  Write-OijOk ("data directory ready: {0}" -f $DataDir)
}

# --- Launcher ------------------------------------------------------------
$launcherLines = @(
  '@echo off',
  'setlocal',
  'set "OIJ_HOME=%~dp0"',
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%OIJ_HOME%scripts\start.ps1" -DeployDir "%OIJ_HOME:~0,-1%" -OpenBrowser',
  'if errorlevel 1 (',
  '  echo.',
  '  echo OiJudge failed to start. Check the log files in the data directory.',
  '  pause',
  ')',
  'endlocal',
  ''
)
$launcherContent = $launcherLines -join "`r`n"
if ($DryRun) {
  Write-OijPlan ("write launcher {0}" -f $launcherPath)
} else {
  Write-OijTextFile -Path $launcherPath -Content $launcherContent
  Write-OijOk ("wrote launcher {0}" -f $launcherPath)
}

# --- Windows Firewall ----------------------------------------------------
if ($firewallRequested) {
  if ($DryRun) {
    Write-OijPlan ("allow inbound TCP {0} for {1} in Windows Firewall" -f $Port, $nodePath)
  } else {
    try {
      Add-OijFirewallRule -Port $Port -ProgramPath $nodePath
      Write-OijOk ("firewall rule '{0}' is in place" -f (Get-OijFirewallRuleName -Port $Port))
    } catch {
      Stop-OijDeployment -ExitCode $OijExitAdminRequired -Message (
        "Could not create the firewall rule: {0}. Re-run elevated or pass -NoFirewall." -f
        $_.Exception.Message
      )
    }
  }
} else {
  Write-OijSkip 'firewall rule disabled (-NoFirewall)'
}

# --- Desktop shortcut ----------------------------------------------------
$shortcutPath = $null
$iconPath = $nodePath
$portableIcon = Join-Path $sourceRoot 'OiJudge.exe'
if (Test-Path -LiteralPath $portableIcon -PathType Leaf) {
  $iconPath = $portableIcon
}
if ($NoShortcut) {
  Write-OijSkip 'desktop shortcut disabled (-NoShortcut)'
} else {
  $shortcutPath = Get-OijDesktopShortcutPath
  if (-not $shortcutPath) {
    Write-OijWarn 'The Desktop folder could not be resolved; skipping the shortcut.'
  } elseif ($DryRun) {
    Write-OijPlan ("create desktop shortcut {0}" -f $shortcutPath)
  } else {
    New-OijShortcut -Path $shortcutPath -TargetPath $launcherPath -WorkingDirectory $DeployDir `
      -IconLocation ($iconPath + ',0') -Description 'Start the OiJudge local judge'
    Write-OijOk ("created desktop shortcut {0}" -f $shortcutPath)
  }
}

# --- Sign-in autostart (HKCU Run) ---------------------------------------
# HKCU Run was chosen over a scheduled task: it needs no elevation and matches
# the "one account, one judge" deployment model. The VBS wrapper starts
# PowerShell with a hidden window, so signing in does not flash a console.
$autostartCommand = $null
if ($NoAutostart) {
  Write-OijSkip 'sign-in autostart disabled (-NoAutostart)'
} else {
  $startScriptPath = Join-Path $scriptsDir 'start.ps1'
  $vbsPath = Join-Path $scriptsDir 'oij-autostart.vbs'
  $wscriptPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
  if (-not (Test-Path -LiteralPath $wscriptPath -PathType Leaf)) {
    $wscriptPath = 'wscript.exe'
  }
  $autostartCommand = '"{0}" //B //Nologo "{1}"' -f $wscriptPath, $vbsPath
  $vbsLines = @(
    'Set shell = CreateObject("WScript.Shell")',
    ('shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""{0}"" -DeployDir ""{1}""", 0, False' -f $startScriptPath, $DeployDir),
    ''
  )
  $vbsContent = $vbsLines -join "`r`n"
  if ($DryRun) {
    Write-OijPlan 'enable sign-in autostart via HKCU Run (value name OiJudge)'
  } else {
    Write-OijTextFile -Path $vbsPath -Content $vbsContent
    Set-OijAutostartCommand -Command $autostartCommand
    Write-OijOk 'enabled sign-in autostart (HKCU Run)'
  }
}

# --- Install state -------------------------------------------------------
$state = [ordered]@{
  schemaVersion = 1
  product = $OijProductName
  installedAt = (Get-Date).ToString('o')
  version = $appVersion
  source = $appSource
  sourceKind = $sourceKind
  deployDir = $DeployDir
  appDir = $appTarget
  dataDir = $DataDir
  port = $Port
  host = $hostAddress
  url = ('http://127.0.0.1:{0}/' -f $Port)
  linkMode = $resolvedMode
  nodePath = $nodePath
  firewallRule = $null
  shortcut = $null
  autostart = $null
  scriptDir = $scriptsDir
  launcher = $launcherPath
  logDir = $logDir
}
if ($firewallRequested) {
  $state['firewallRule'] = Get-OijFirewallRuleName -Port $Port
}
if ($shortcutPath -and -not $NoShortcut) {
  $state['shortcut'] = $shortcutPath
}
if ($autostartCommand -and -not $NoAutostart) {
  $state['autostart'] = [ordered]@{
    kind = 'hkcu-run'
    valueName = $OijRunValueName
    command = $autostartCommand
  }
}
if ($DryRun) {
  Write-OijPlan ("write {0}" -f (Get-OijStatePath -DeployDir $DeployDir))
} else {
  Write-OijInstallState -DeployDir $DeployDir -State $state
  Write-OijOk ("wrote {0}" -f (Get-OijStatePath -DeployDir $DeployDir))
}

# --- Start the server ----------------------------------------------------
if ($DryRun) {
  Write-OijPlan ("start the server: `"{0}`" `"{1}`"" -f $nodePath, (Join-Path $appTarget 'apps\server\dist\cli.js'))
  Write-OijPlan ("wait up to 30 s for http://127.0.0.1:{0}/api/health" -f $Port)
  Write-Host ''
  if ($predictedExitCode -ne $OijExitSuccess) {
    Write-OijWarn ("Dry run finished; the real run would exit with code {0}." -f $predictedExitCode)
    exit $predictedExitCode
  }
  Write-OijPlan 'dry run finished; nothing was changed'
  exit $OijExitSuccess
}

$serverProcess = Start-OijServer -AppDir $appTarget -DataDir $DataDir -Port $Port -NodePath $nodePath -LogDir $logDir -HostAddress $hostAddress
if (-not (Wait-OijHealth -Port $Port -TimeoutSeconds 30)) {
  Show-OijLogTail -LogDir $logDir -Lines 25
  $healthMessage = (
    "The server did not answer on http://127.0.0.1:{0}/api/health within 30 s. " +
    "See the log files under {1}."
  ) -f $Port, $logDir
  Stop-OijDeployment -ExitCode $OijExitHealthCheck -Message $healthMessage
}
Write-OijOk ("server is healthy (PID {0})" -f $serverProcess.Id)

# --- Summary -------------------------------------------------------------
$statusCommand = 'powershell -ExecutionPolicy Bypass -File "{0}" -DeployDir "{1}"' -f (Join-Path $scriptsDir 'status.ps1'), $DeployDir
$startCommand = 'powershell -ExecutionPolicy Bypass -File "{0}" -DeployDir "{1}"' -f (Join-Path $scriptsDir 'start.ps1'), $DeployDir
$stopCommand = 'powershell -ExecutionPolicy Bypass -File "{0}" -DeployDir "{1}"' -f (Join-Path $scriptsDir 'stop.ps1'), $DeployDir
$uninstallCommand = 'powershell -ExecutionPolicy Bypass -File "{0}" -DeployDir "{1}"' -f (Join-Path $scriptsDir 'uninstall.ps1'), $DeployDir

Write-Host ''
Write-OijOk ("OiJudge is deployed to {0}" -f $DeployDir)
Write-Host ("  URL:        http://127.0.0.1:{0}/" -f $Port)
if ($Lan) {
  Write-Host ("  LAN:        http://<this-machine-ip>:{0}/ (enabled by -Lan)" -f $Port)
} else {
  Write-Host '  LAN:        disabled (loopback only; re-run install.ps1 -Lan to expose it)'
}
Write-Host ("  Data:       {0}" -f $DataDir)
Write-Host ("  Logs:       {0}" -f $logDir)
if ($shortcutPath -and -not $NoShortcut) {
  Write-Host ("  Shortcut:   {0}" -f $shortcutPath)
}
if (-not $NoAutostart) {
  Write-Host '  Autostart:  HKCU Run at sign-in'
}
if ($NoFirewall) {
  Write-Host '  Firewall:   no rule (only local access guaranteed)'
} else {
  Write-Host ("  Firewall:   {0}" -f (Get-OijFirewallRuleName -Port $Port))
}
Write-Host ''
Write-Host 'Manage the deployment with:'
Write-Host ('  status:    ' + $statusCommand)
Write-Host ('  start:     ' + $startCommand)
Write-Host ('  stop:      ' + $stopCommand)
Write-Host ('  uninstall: ' + $uninstallCommand)
Write-Host ''
Write-Host 'Admin account: on first start OiJudge generates a random administrator password.'
Write-Host ("The one-time password is printed once in {0}." -f (Join-Path $logDir 'server.out.log'))
Write-Host 'The first login is forced to change that password.'

exit $OijExitSuccess
