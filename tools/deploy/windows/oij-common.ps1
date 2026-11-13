#Requires -Version 5.1
# Shared helpers for tools/deploy/windows.
#
# The deployment scripts are ASCII-only on purpose: Windows PowerShell 5.1 reads
# BOM-less .ps1 files with the ANSI code page, so non-ASCII text here would be
# garbled on Chinese Windows. User-facing documentation lives in
# docs/help/maintenance/windows-deploy.md.
#
# Exit codes used by every script in this directory:
#   0 success
#   1 unexpected failure (a command reported an error)
#   2 invalid argument or incomplete source/build
#   3 administrator rights are required for a requested step
#   4 the requested TCP port is already used by another process
#   5 the server started but /api/health never answered
#   6 no deployment state (install.json) was found

$OijExitSuccess = 0
$OijExitFailure = 1
$OijExitUsage = 2
$OijExitAdminRequired = 3
$OijExitPortInUse = 4
$OijExitHealthCheck = 5
$OijExitNotInstalled = 6

$OijRunValueName = 'OiJudge'
$OijShortcutFileName = 'OiJudge.lnk'
$OijLauncherFileName = 'OiJudge.cmd'
$OijProductName = 'OiJudge'
$OijWorkerAccountName = 'OiJudgeWorker'

function Write-OijOk {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Host ("[ok] " + $Message) -ForegroundColor Green
}

function Write-OijSkip {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Host ("[skip] " + $Message)
}

function Write-OijPlan {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Host ("[dry-run] " + $Message) -ForegroundColor Cyan
}

function Write-OijWarn {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Host ("[warn] " + $Message) -ForegroundColor Yellow
}

function Stop-OijDeployment {
  param(
    [Parameter(Mandatory = $true)][string]$Message,
    [int]$ExitCode = 1
  )
  Write-Host ("[error] " + $Message) -ForegroundColor Red
  exit $ExitCode
}

function Resolve-OijFullPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$BaseDirectory
  )
  $expanded = [Environment]::ExpandEnvironmentVariables($Path)
  if (-not [IO.Path]::IsPathRooted($expanded)) {
    $expanded = Join-Path $BaseDirectory $expanded
  }
  return [IO.Path]::GetFullPath($expanded)
}

function Get-OijRepoRoot {
  param(
    [Parameter(Mandatory = $true)][string]$ScriptRoot,
    [string]$Override
  )
  if ($Override) {
    return Resolve-OijFullPath -Path $Override -BaseDirectory (Get-Location).Path
  }
  return [IO.Path]::GetFullPath((Join-Path $ScriptRoot '..\..\..'))
}

function Get-OijLocalAppData {
  if ($env:LOCALAPPDATA) {
    return $env:LOCALAPPDATA
  }
  return (Join-Path $env:USERPROFILE 'AppData\Local')
}

function Get-OijDefaultDataDir {
  return (Join-Path (Get-OijLocalAppData) 'OiJudge\runtime')
}

function Get-OijDefaultDeployDir {
  return (Join-Path (Get-OijLocalAppData) 'OiJudge\deploy')
}

function Get-OijStatePath {
  param([Parameter(Mandatory = $true)][string]$DeployDir)
  return (Join-Path $DeployDir 'install.json')
}

function Read-OijInstallState {
  param([Parameter(Mandatory = $true)][string]$DeployDir)
  $statePath = Get-OijStatePath -DeployDir $DeployDir
  if (-not (Test-Path -LiteralPath $statePath)) {
    return $null
  }
  try {
    $raw = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8
    return ($raw | ConvertFrom-Json)
  } catch {
    Write-Warning ("Could not read install state {0}: {1}" -f $statePath, $_.Exception.Message)
    return $null
  }
}

function Write-OijInstallState {
  param(
    [Parameter(Mandatory = $true)][string]$DeployDir,
    [Parameter(Mandatory = $true)]$State
  )
  $json = ($State | ConvertTo-Json -Depth 8) + [Environment]::NewLine
  Write-OijTextFile -Path (Get-OijStatePath -DeployDir $DeployDir) -Content $json
}

function Write-OijTextFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )
  $parent = Split-Path -Parent $Path
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, $Content, $encoding)
}

function New-OijDirectory {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Test-OijAdministrator {
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch {
    return $false
  }
}

function Test-OijReparsePoint {
  param([Parameter(Mandatory = $true)][string]$Path)
  try {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    return (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
  } catch {
    return $false
  }
}

function Remove-OijAppDirectory {
  param([Parameter(Mandatory = $true)][string]$Path)
  # Test-Path reports False for a junction whose target disappeared, so ask the
  # filesystem entry itself whether anything is there.
  $entryExists = $false
  try {
    $null = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $entryExists = $true
  } catch {
    $entryExists = $false
  }
  if (-not $entryExists) {
    return
  }
  if (Test-OijReparsePoint -Path $Path) {
    # Directory.Delete removes the junction itself and never touches its
    # target; Remove-Item -Recurse on a junction can follow the link.
    [IO.Directory]::Delete($Path)
    return
  }
  Remove-Item -LiteralPath $Path -Recurse -Force
}

function New-OijAppJunction {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Target
  )
  New-OijDirectory -Path (Split-Path -Parent $Path)
  New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null
}

function Get-OijNodePath {
  $candidates = @()
  if ($env:OIJ_NODE) {
    $candidates += $env:OIJ_NODE
  }
  try {
    $command = Get-Command node.exe -ErrorAction Stop
    if ($command -and $command.Source) {
      $candidates += $command.Source
    }
  } catch {
    # node.exe is not on PATH; the explicit candidates below may still match.
  }
  if ($env:ProgramFiles) {
    $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe')
  }
  $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  if ($programFilesX86) {
    $candidates += (Join-Path $programFilesX86 'nodejs\node.exe')
  }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return [IO.Path]::GetFullPath($candidate)
    }
  }
  return $null
}

function Get-OijAppVersion {
  param([Parameter(Mandatory = $true)][string]$AppDir)
  $packagePath = Join-Path $AppDir 'package.json'
  if (-not (Test-Path -LiteralPath $packagePath)) {
    return $null
  }
  try {
    $package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($package.version) {
      return [string]$package.version
    }
  } catch {
    return $null
  }
  return $null
}

# Resolves the application tree to deploy. A repository checkout keeps the
# server in <root>\apps\server\dist; an extracted portable build keeps it in
# <root>\resources\app. Both layouts are recognized next to the script and in
# <root>\release\oi-local-judge-*-win-x64 (the portable build output).
function Get-OijSourceCandidates {
  param([Parameter(Mandatory = $true)][string]$Root)
  $candidates = @()
  $candidates += @{ AppDir = (Join-Path $Root 'resources\app'); Kind = 'portable'; Root = $Root }
  $candidates += @{ AppDir = $Root; Kind = 'repo'; Root = $Root }
  $releaseDir = Join-Path $Root 'release'
  if (Test-Path -LiteralPath $releaseDir) {
    $portableDirs = @(
      Get-ChildItem -LiteralPath $releaseDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'oi-local-judge-*-win-x64' } |
        Sort-Object LastWriteTime -Descending
    )
    foreach ($dir in $portableDirs) {
      $candidates += @{ AppDir = (Join-Path $dir.FullName 'resources\app'); Kind = 'portable'; Root = $dir.FullName }
    }
  }
  return $candidates
}

function Resolve-OijAppSource {
  param(
    [string]$Override,
    [Parameter(Mandatory = $true)][string]$ScriptRoot
  )
  $checked = @()
  $root = $null
  if ($Override) {
    $root = Resolve-OijFullPath -Path $Override -BaseDirectory (Get-Location).Path
  } else {
    $root = [IO.Path]::GetFullPath((Join-Path $ScriptRoot '..\..\..'))
  }
  foreach ($candidate in (Get-OijSourceCandidates -Root $root)) {
    $cliPath = Join-Path $candidate.AppDir 'apps\server\dist\cli.js'
    if (Test-Path -LiteralPath $cliPath -PathType Leaf) {
      return $candidate
    }
    $checked += $candidate.AppDir
  }
  return @{ AppDir = $null; Kind = $null; Root = $root; Checked = $checked }
}

# Files the server cannot run without. Missing entries mean the tree was never
# built (dist) or the portable archive was unpacked incompletely.
function Get-OijSourceProblems {
  param([Parameter(Mandatory = $true)][string]$AppDir)
  $required = @(
    'apps\server\dist\cli.js',
    'apps\web\dist\index.html',
    'packages\shared\dist\index.js',
    'node_modules\fastify\package.json'
  )
  $missing = @()
  foreach ($relativePath in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $AppDir $relativePath) -PathType Leaf)) {
      $missing += $relativePath
    }
  }
  return $missing
}

# Native runners are optional for starting the server: without them the site
# works but submissions cannot be judged. They are reported as warnings.
function Get-OijSourceWarnings {
  param([Parameter(Mandatory = $true)][string]$AppDir)
  $warnings = @()
  foreach ($relativePath in @('native\runner\out\ojrunner.exe', 'native\interact\out\ojinteract.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $AppDir $relativePath) -PathType Leaf)) {
      $warnings += $relativePath
    }
  }
  return $warnings
}

function Get-OijFirewallRuleName {
  param([Parameter(Mandatory = $true)][int]$Port)
  return ("OiJudge Server (TCP {0})" -f $Port)
}

function Test-OijFirewallRule {
  param([Parameter(Mandatory = $true)][int]$Port)
  try {
    $rule = Get-NetFirewallRule -DisplayName (Get-OijFirewallRuleName -Port $Port) -ErrorAction Stop |
      Select-Object -First 1
    return ($null -ne $rule)
  } catch {
    return $false
  }
}

function Remove-OijFirewallRule {
  param([Parameter(Mandatory = $true)][int]$Port)
  try {
    $rules = @(Get-NetFirewallRule -DisplayName (Get-OijFirewallRuleName -Port $Port) -ErrorAction SilentlyContinue)
    foreach ($rule in $rules) {
      Remove-NetFirewallRule -Name $rule.Name -ErrorAction Stop
    }
    return $true
  } catch {
    Write-Warning ("Could not remove firewall rule: {0}" -f $_.Exception.Message)
    return $false
  }
}

function Add-OijFirewallRule {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$ProgramPath
  )
  # Recreate the rule so a changed node.exe path or port is reflected.
  Remove-OijFirewallRule -Port $Port | Out-Null
  New-NetFirewallRule -DisplayName (Get-OijFirewallRuleName -Port $Port) `
    -Direction Inbound -Action Allow -Program $ProgramPath -Protocol TCP -LocalPort $Port `
    -Profile Private, Domain -Description 'OiJudge local judge server' -ErrorAction Stop | Out-Null
}

function Get-OijAutostartRegistryPath {
  return 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
}

function Get-OijAutostartCommand {
  try {
    $item = Get-ItemProperty -LiteralPath (Get-OijAutostartRegistryPath) -Name $OijRunValueName -ErrorAction Stop
    $property = $item.PSObject.Properties[$OijRunValueName]
    if ($property) {
      return [string]$property.Value
    }
  } catch {
    return $null
  }
  return $null
}

function Test-OijAutostart {
  return [bool](Get-OijAutostartCommand)
}

function Set-OijAutostartCommand {
  param([Parameter(Mandatory = $true)][string]$Command)
  $registryPath = Get-OijAutostartRegistryPath
  if (-not (Test-Path -LiteralPath $registryPath)) {
    New-Item -Path $registryPath -Force | Out-Null
  }
  Set-ItemProperty -LiteralPath $registryPath -Name $OijRunValueName -Value $Command
}

function Remove-OijAutostartCommand {
  Remove-ItemProperty -LiteralPath (Get-OijAutostartRegistryPath) -Name $OijRunValueName -ErrorAction SilentlyContinue
}

function Get-OijDesktopShortcutPath {
  $desktop = [Environment]::GetFolderPath('Desktop')
  if (-not $desktop) {
    return $null
  }
  return (Join-Path $desktop $OijShortcutFileName)
}

function New-OijShortcut {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$TargetPath,
    [string]$Arguments,
    [string]$WorkingDirectory,
    [string]$IconLocation,
    [string]$Description
  )
  New-OijDirectory -Path (Split-Path -Parent $Path)
  $shell = New-Object -ComObject WScript.Shell
  try {
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $TargetPath
    if ($Arguments) {
      $shortcut.Arguments = $Arguments
    }
    if ($WorkingDirectory) {
      $shortcut.WorkingDirectory = $WorkingDirectory
    }
    if ($IconLocation) {
      $shortcut.IconLocation = $IconLocation
    }
    if ($Description) {
      $shortcut.Description = $Description
    }
    $shortcut.Save()
  } finally {
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
  }
}

function Get-OijPortListener {
  param([Parameter(Mandatory = $true)][int]$Port)
  try {
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($listener) {
      return $listener
    }
  } catch {
    return $null
  }
  return $null
}

function Get-OijServerProcesses {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)
  $cliPath = Join-Path $RepoRoot 'apps\server\dist\cli.js'
  try {
    $nodeProcesses = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
  } catch {
    Write-Warning ("Could not enumerate node.exe processes: {0}" -f $_.Exception.Message)
    return @()
  }
  $result = @()
  foreach ($nodeProcess in $nodeProcesses) {
    if (-not $nodeProcess.CommandLine) {
      continue
    }
    if ($nodeProcess.CommandLine.IndexOf($cliPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $result += $nodeProcess
    }
  }
  return $result
}

function Get-OijProcessesForApp {
  param([Parameter(Mandatory = $true)][string]$AppDir)
  return @(Get-OijServerProcesses -RepoRoot $AppDir)
}

function Stop-OijProcessesForApp {
  param(
    [Parameter(Mandatory = $true)][string]$AppDir,
    [int]$TimeoutSeconds = 10
  )
  $processes = @(Get-OijProcessesForApp -AppDir $AppDir)
  foreach ($process in $processes) {
    try {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    } catch {
      Write-Warning ("Could not stop PID {0}: {1}" -f $process.ProcessId, $_.Exception.Message)
    }
  }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (@(Get-OijProcessesForApp -AppDir $AppDir).Count -eq 0) {
      return $true
    }
    Start-Sleep -Milliseconds 300
  }
  return (@(Get-OijProcessesForApp -AppDir $AppDir).Count -eq 0)
}

# Starts the headless server detached from the calling shell. The environment
# variables mirror what the desktop app passes to the embedded server, so both
# front-ends share one data directory layout.
function Start-OijServer {
  param(
    [Parameter(Mandatory = $true)][string]$AppDir,
    [Parameter(Mandatory = $true)][string]$DataDir,
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [string]$LogDir,
    [string]$HostAddress = '127.0.0.1',
    [ValidateSet('optional', 'required')][string]$WorkerIsolation = 'optional'
  )
  $cliPath = Join-Path $AppDir 'apps\server\dist\cli.js'
  if (-not $LogDir) {
    $LogDir = Join-Path $DataDir 'logs'
  }
  New-OijDirectory -Path $LogDir
  $stdoutPath = Join-Path $LogDir 'server.out.log'
  $stderrPath = Join-Path $LogDir 'server.err.log'
  $variableNames = @('OIJ_PORT', 'OIJ_HOST', 'OIJ_DATA_DIR', 'OIJ_RUNNER', 'OIJ_INTERACT_RUNNER', 'OIJ_WORKER_ISOLATION')
  $previousValues = @{}
  foreach ($name in $variableNames) {
    $previousValues[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  try {
    $env:OIJ_PORT = [string]$Port
    $env:OIJ_HOST = $HostAddress
    $env:OIJ_DATA_DIR = $DataDir
    $env:OIJ_RUNNER = Join-Path $AppDir 'native\runner\out\ojrunner.exe'
    $env:OIJ_INTERACT_RUNNER = Join-Path $AppDir 'native\interact\out\ojinteract.exe'
    $env:OIJ_WORKER_ISOLATION = $WorkerIsolation
    $process = Start-Process -FilePath $NodePath -ArgumentList ('"' + $cliPath + '"') `
      -WorkingDirectory $AppDir -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
  } finally {
    foreach ($name in $variableNames) {
      if ($null -eq $previousValues[$name]) {
        Remove-Item -Path ('Env:' + $name) -ErrorAction SilentlyContinue
      } else {
        Set-Item -Path ('Env:' + $name) -Value $previousValues[$name]
      }
    }
  }
  return $process
}

function Get-OijLogTail {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [int]$Lines = 20
  )
  if (-not (Test-Path -LiteralPath $Path)) {
    return @()
  }
  try {
    return @(Get-Content -LiteralPath $Path -Encoding UTF8 -Tail $Lines)
  } catch {
    return @()
  }
}

function Show-OijLogTail {
  param(
    [Parameter(Mandatory = $true)][string]$LogDir,
    [int]$Lines = 20
  )
  foreach ($name in @('server.err.log', 'server.out.log')) {
    $path = Join-Path $LogDir $name
    $tail = @(Get-OijLogTail -Path $path -Lines $Lines)
    if ($tail.Count -eq 0) {
      continue
    }
    Write-Host ("--- {0} (last {1} lines) ---" -f $path, $tail.Count) -ForegroundColor DarkGray
    foreach ($line in $tail) {
      Write-Host ("  " + $line)
    }
  }
}

function Test-OijHealth {
  param([Parameter(Mandatory = $true)][int]$Port)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/api/health" -f $Port) -TimeoutSec 3 -ErrorAction Stop
    return ($response.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Wait-OijHealth {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [int]$TimeoutSeconds = 20
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-OijHealth -Port $Port) {
      return $true
    }
    Start-Sleep -Milliseconds 500
  }
  return $false
}
