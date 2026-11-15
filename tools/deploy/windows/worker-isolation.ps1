#Requires -Version 5.1
<#
.SYNOPSIS
  Enables or removes the optional OiJudge judge-account isolation.

.DESCRIPTION
  Creates (or resets) the low-privilege local account OiJudgeWorker, generates
  a 24-byte random password, stores it in an ACL-protected
  <DataDir>\worker.json, denies the worker account read access to the data
  directory, grants it write access to the judge work root (a sibling of the
  data directory), and blocks its outbound network traffic with a per-user
  Windows Firewall rule.

  This script is shared by the NSIS installer, install.ps1 and uninstall.ps1.
  It is intentionally ASCII-only: Windows PowerShell 5.1 reads BOM-less .ps1
  files with the ANSI code page, so non-ASCII text here would be garbled on
  Chinese Windows.

  Honesty rules:
    * exit 0 only after every step was applied and verified;
    * a failed step or a cancelled UAC prompt reports a warning and leaves the
      deployment in the optional mode (never a fake "enabled");
    * a failed install rolls its partial changes back (best effort) so the
      server does not pick up half-configured credentials.

  Exit codes:
    0 success
    1 a step failed (see the [error]/[warn] lines)
    2 invalid argument
    3 administrator rights are required and -Elevate was not given
    4 the UAC prompt was cancelled or elevation failed

.PARAMETER Install
  Create or reset the worker account and the isolation settings.

.PARAMETER Remove
  Remove the outbound firewall rule, the worker account and worker.json.

.PARAMETER DataDir
  OiJudge data directory. Default: %LOCALAPPDATA%\OiJudge\runtime. The NSIS
  installer passes %APPDATA%\OiJudge\runtime (the Electron userData runtime
  directory).

.PARAMETER WorkDir
  Judge work root. Default: a sibling of DataDir named
  "<DataDirName>-judge-tmp", matching apps/server/src/judge/isolation.ts.

.PARAMETER Owner
  Local account that must keep read access to worker.json (normally the
  account that runs the OiJudge server and installed it). Default: %USERNAME%.

.PARAMETER Account
  Worker account name. Default: OiJudgeWorker.

.PARAMETER Elevate
  Relaunch this script through UAC when administrator rights are required.
  Use this from the NSIS installer; console scripts generally run elevated
  already.

.PARAMETER DryRun
  Print the planned steps without changing the machine. No elevation needed.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File worker-isolation.ps1 -Install -DataDir "$env:LOCALAPPDATA\OiJudge\runtime"

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File worker-isolation.ps1 -Remove -DataDir "$env:APPDATA\OiJudge\runtime" -Elevate
#>
[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$Remove,
  [string]$DataDir,
  [string]$WorkDir,
  [string]$Owner = $env:USERNAME,
  [string]$Account = 'OiJudgeWorker',
  [switch]$Elevate,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$OijWorkerExitSuccess = 0
$OijWorkerExitFailure = 1
$OijWorkerExitUsage = 2
$OijWorkerExitAdminRequired = 3
$OijWorkerExitElevationCancelled = 4
$OijWorkerFirewallRuleName = 'OiJudge Worker outbound block'

$script:OijWorkerLogFile = $null

function Write-OijWorkerOk {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Host ('[ok] ' + $Message) -ForegroundColor Green
}

function Write-OijWorkerPlan {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Host ('[dry-run] ' + $Message) -ForegroundColor Cyan
}

function Write-OijWorkerWarn {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Host ('[warn] ' + $Message) -ForegroundColor Yellow
}

function Write-OijWorkerFail {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Host ('[error] ' + $Message) -ForegroundColor Red
}

function Write-OijWorkerLog {
  param([Parameter(Mandatory = $true)][string]$Message)
  if (-not $script:OijWorkerLogFile) {
    return
  }
  try {
    $line = '{0} {1}' -f (Get-Date).ToString('o'), $Message
    Add-Content -LiteralPath $script:OijWorkerLogFile -Value $line -Encoding ASCII
  } catch {
    # Logging must never block the isolation step.
  }
}

function Start-OijWorkerLog {
  param([Parameter(Mandatory = $true)][string]$DataRoot)
  if ($DryRun) {
    return
  }
  try {
    $logDir = Join-Path $DataRoot 'logs'
    if (-not (Test-Path -LiteralPath $logDir)) {
      New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }
    $script:OijWorkerLogFile = Join-Path $logDir 'worker-isolation.log'
  } catch {
    $script:OijWorkerLogFile = $null
  }
}

function Test-OijWorkerAdministrator {
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch {
    return $false
  }
}

function Confirm-OijWorkerAccountName {
  param([Parameter(Mandatory = $true)][string]$Name)
  if ($Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$') {
    Write-OijWorkerFail ('Invalid -Account "{0}": use 1-20 letters, digits, dot, dash or underscore.' -f $Name)
    return $false
  }
  $reserved = @('Administrator', 'SYSTEM', 'LOCAL SERVICE', 'NETWORK SERVICE', 'DefaultAccount', 'Guest', 'WDAGUtilityAccount')
  foreach ($skip in $reserved) {
    if ($Name -ieq $skip) {
      Write-OijWorkerFail ('Refusing to manage the built-in account "{0}".' -f $Name)
      return $false
    }
  }
  if ($env:USERNAME -and $Name -ieq $env:USERNAME) {
    Write-OijWorkerFail ('Refusing to use the current Windows account ({0}) as the worker account.' -f $Name)
    return $false
  }
  return $true
}

function Resolve-OijWorkerPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$What
  )
  try {
    $expanded = [Environment]::ExpandEnvironmentVariables($Path)
    return [IO.Path]::GetFullPath($expanded).TrimEnd('\')
  } catch {
    Write-OijWorkerFail ('Cannot resolve {0} "{1}": {2}' -f $What, $Path, $_.Exception.Message)
    return $null
  }
}

function Get-OijWorkerJudgeWorkRoot {
  param([Parameter(Mandatory = $true)][string]$DataRoot)
  $data = [IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
  $parent = [IO.Path]::GetDirectoryName($data)
  $leaf = [IO.Path]::GetFileName($data)
  if (-not $parent -or -not $leaf) {
    return (Join-Path $env:TEMP 'oij-judge')
  }
  return [IO.Path]::Combine($parent, ($leaf + '-judge-tmp'))
}

function Test-OijWorkerAclEntry {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$IdentityName,
    [Parameter(Mandatory = $true)][string]$AccessType,
    [switch]$RequireWrite
  )
  try {
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
  } catch {
    return $false
  }
  foreach ($ace in $acl.Access) {
    if ([string]$ace.AccessControlType -ne $AccessType) {
      continue
    }
    $identity = [string]$ace.IdentityReference.Value
    $shortName = ($identity -split '\\')[-1]
    if ($identity -ine $IdentityName -and $shortName -ine $IdentityName) {
      continue
    }
    if ($RequireWrite) {
      $rights = [Security.AccessControl.FileSystemRights]$ace.FileSystemRights
      $write = [Security.AccessControl.FileSystemRights]::Write
      if (($rights -band $write) -ne $write) {
        continue
      }
    }
    return $true
  }
  return $false
}

function Invoke-OijWorkerIcacls {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  try {
    & icacls.exe @Arguments 2>&1 | Out-Null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

function Remove-OijWorkerAccountFromAdministrators {
  param([Parameter(Mandatory = $true)][string]$Name)
  $admins = Get-LocalGroup -SID 'S-1-5-32-544' -ErrorAction Stop
  $members = @(Get-LocalGroupMember -Group $admins.Name -ErrorAction SilentlyContinue)
  foreach ($member in $members) {
    $memberName = [string]$member.Name
    if ($memberName -ieq $Name -or $memberName.EndsWith('\' + $Name, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-LocalGroupMember -Group $admins.Name -Member $member -ErrorAction Stop
      Write-OijWorkerWarn ('removed {0} from the Administrators group' -f $Name)
    }
  }
}

function Invoke-OijWorkerElevation {
  param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [string]$WorkRoot
  )
  $exe = $null
  try {
    $exe = (Get-Process -Id $PID).Path
  } catch {
    $exe = $null
  }
  if (-not $exe) {
    $exe = 'powershell.exe'
  }

  $parts = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', ('"{0}"' -f $PSCommandPath)
  )
  if ($Install) {
    $parts += '-Install'
  }
  if ($Remove) {
    $parts += '-Remove'
  }
  $parts += @('-DataDir', ('"{0}"' -f $DataRoot))
  if ($WorkRoot) {
    $parts += @('-WorkDir', ('"{0}"' -f $WorkRoot))
  }
  $parts += @('-Owner', ('"{0}"' -f $Owner), '-Account', ('"{0}"' -f $Account))

  $argumentLine = $parts -join ' '
  try {
    $process = Start-Process -FilePath $exe -Verb RunAs -ArgumentList $argumentLine -PassThru -Wait -WindowStyle Hidden
    return [int]$process.ExitCode
  } catch {
    $nativeError = 0
    try {
      if ($_.Exception -is [System.ComponentModel.Win32Exception]) {
        $nativeError = [int]$_.Exception.NativeErrorCode
      }
    } catch {
      $nativeError = 0
    }
    if ($nativeError -eq 1223) {
      Write-OijWorkerWarn 'Administrator approval was cancelled (UAC), so worker isolation was not enabled.'
    } else {
      Write-OijWorkerWarn ('Could not start the elevated helper: {0}' -f $_.Exception.Message)
    }
    Write-OijWorkerLog ('elevation failed: {0}' -f $_.Exception.Message)
    return $OijWorkerExitElevationCancelled
  }
}

function New-OijWorkerAccount {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Password
  )
  $securePassword = ConvertTo-SecureString -String $Password -AsPlainText -Force
  $existing = Get-LocalUser -Name $Name -ErrorAction SilentlyContinue
  $created = $false
  if ($existing) {
    Write-OijWorkerLog ('resetting the password of the existing account {0}' -f $Name)
    Set-LocalUser -Name $Name -Password $securePassword -PasswordNeverExpires $true -ErrorAction Stop
    if (-not $existing.Enabled) {
      Enable-LocalUser -Name $Name -ErrorAction Stop
      Write-OijWorkerLog ('enabled the disabled account {0}' -f $Name)
    }
  } else {
    New-LocalUser -Name $Name -Password $securePassword -PasswordNeverExpires -UserMayNotChangePassword `
      -Description 'OiJudge judge worker (low privilege)' -ErrorAction Stop | Out-Null
    $created = $true
    Write-OijWorkerLog ('created local account {0}' -f $Name)
  }
  Remove-OijWorkerAccountFromAdministrators -Name $Name
  return $created
}

function ConvertTo-OijWorkerJson {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Password
  )
  $document = [ordered]@{
    username    = $Name
    password    = $Password
    required    = $true
    generatedAt = (Get-Date).ToString('o')
  }
  return ($document | ConvertTo-Json)
}

function Undo-OijWorkerInstall {
  param(
    [string]$WorkerFile,
    [string]$DataRoot,
    [string]$WorkRoot,
    [string]$Name,
    [bool]$CreatedAccount
  )
  Write-OijWorkerWarn 'rolling back the partial worker-isolation setup ...'
  try {
    $rule = Get-NetFirewallRule -DisplayName $OijWorkerFirewallRuleName -ErrorAction SilentlyContinue
    if ($rule) {
      Remove-NetFirewallRule -Name $rule.Name -ErrorAction Stop
      Write-OijWorkerLog 'rollback: removed the outbound firewall rule'
    }
  } catch {
    Write-OijWorkerWarn ('rollback: could not remove the firewall rule: {0}' -f $_.Exception.Message)
  }
  try {
    if ($WorkerFile -and (Test-Path -LiteralPath $WorkerFile)) {
      Remove-Item -LiteralPath $WorkerFile -Force -ErrorAction Stop
      Write-OijWorkerLog 'rollback: deleted worker.json'
    }
  } catch {
    Write-OijWorkerWarn ('rollback: could not delete worker.json: {0}' -f $_.Exception.Message)
  }
  try {
    if ($DataRoot) {
      & icacls.exe $DataRoot '/remove:d' $Name '/C' '/Q' 2>&1 | Out-Null
    }
  } catch {
    # Best effort only.
  }
  try {
    if ($WorkRoot -and (Test-Path -LiteralPath $WorkRoot)) {
      & icacls.exe $WorkRoot '/remove' $Name '/T' '/C' '/Q' 2>&1 | Out-Null
    }
  } catch {
    # Best effort only.
  }
  if ($CreatedAccount) {
    try {
      Remove-LocalUser -Name $Name -ErrorAction Stop
      Write-OijWorkerLog ('rollback: removed the account {0} created by this run' -f $Name)
    } catch {
      Write-OijWorkerWarn ('rollback: could not remove the local account: {0}' -f $_.Exception.Message)
    }
  }
}

function Get-OijWorkerArtifacts {
  param(
    [Parameter(Mandatory = $true)][string]$WorkerFile
  )
  $file = Test-Path -LiteralPath $WorkerFile
  $account = $false
  $firewall = $false
  try {
    if (Get-LocalUser -Name $Account -ErrorAction SilentlyContinue) {
      $account = $true
    }
  } catch {
    # Account lookup is best effort.
  }
  try {
    if (Get-NetFirewallRule -DisplayName $OijWorkerFirewallRuleName -ErrorAction SilentlyContinue) {
      $firewall = $true
    }
  } catch {
    # Firewall lookup is best effort.
  }
  return [pscustomobject]@{
    WorkerFile = $file
    Account    = $account
    Firewall   = $firewall
    Any        = ($file -or $account -or $firewall)
  }
}

function Invoke-OijWorkerInstall {
  param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][string]$WorkRoot
  )
  $workerFile = Join-Path $DataRoot 'worker.json'

  # Last chance to avoid wasting a password: the directory must be usable.
  if (-not (Test-Path -LiteralPath $DataRoot)) {
    New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
  }

  # 24 random bytes -> 32 Base64 characters (meets the default complexity
  # policy without relying on the truncated '=' padding).
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object byte[] 24
  $rng.GetBytes($bytes)
  $password = [Convert]::ToBase64String($bytes).TrimEnd('=')

  $createdAccount = $false
  try {
    $createdAccount = New-OijWorkerAccount -Name $Account -Password $password
  } catch {
    Write-OijWorkerFail ('Could not create or reset the local account {0}: {1}' -f $Account, $_.Exception.Message)
    Write-OijWorkerLog ('account step failed: {0}' -f $_.Exception.Message)
    return $OijWorkerExitFailure
  }
  Write-OijWorkerOk ('local account {0} is ready' -f $Account)

  try {
    # worker.json is written only after the account exists, and is unreadable
    # by the worker account itself.
    $json = ConvertTo-OijWorkerJson -Name $Account -Password $password
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($workerFile, ($json + [Environment]::NewLine), $encoding)

    $aclArguments = @(
      $workerFile,
      '/inheritance:r',
      '/grant:r', ('{0}:F' -f $Owner),
      '/grant:r', '*S-1-5-18:F',
      '/grant:r', '*S-1-5-32-544:F',
      '/deny', ('{0}:(R)' -f $Account)
    )
    if (-not (Invoke-OijWorkerIcacls -Arguments $aclArguments)) {
      throw ('icacls failed while protecting {0}' -f $workerFile)
    }
    if (-not (Test-OijWorkerAclEntry -Path $workerFile -IdentityName $Owner -AccessType 'Allow')) {
      throw ('{0} has no read ACE for {1}' -f $workerFile, $Owner)
    }
    if (-not (Test-OijWorkerAclEntry -Path $workerFile -IdentityName $Account -AccessType 'Deny')) {
      throw ('{0} is not denied to {1}' -f $workerFile, $Account)
    }
    Write-OijWorkerOk ('wrote {0} (owner-only read, {1} denied)' -f $workerFile, $Account)
  } catch {
    Write-OijWorkerFail ('Could not protect worker.json: {0}' -f $_.Exception.Message)
    Write-OijWorkerLog ('worker.json step failed: {0}' -f $_.Exception.Message)
    Undo-OijWorkerInstall -WorkerFile $workerFile -DataRoot $DataRoot -WorkRoot $WorkRoot -Name $Account -CreatedAccount $createdAccount
    return $OijWorkerExitFailure
  }

  try {
    # Secrets, database and answers must stay unreadable to the worker. The
    # deny is inheritable, which is why the work root lives outside DataRoot.
    if (-not (Invoke-OijWorkerIcacls -Arguments @($DataRoot, '/deny', ('{0}:(OI)(CI)R' -f $Account), '/C', '/Q'))) {
      throw ('icacls failed on the data directory {0}' -f $DataRoot)
    }
    if (-not (Test-OijWorkerAclEntry -Path $DataRoot -IdentityName $Account -AccessType 'Deny')) {
      throw ('the data directory {0} does not deny {1}' -f $DataRoot, $Account)
    }
    Write-OijWorkerOk ('{0} cannot read the data directory' -f $Account)
  } catch {
    Write-OijWorkerFail ('Could not deny the data directory: {0}' -f $_.Exception.Message)
    Write-OijWorkerLog ('data directory ACL step failed: {0}' -f $_.Exception.Message)
    Undo-OijWorkerInstall -WorkerFile $workerFile -DataRoot $DataRoot -WorkRoot $WorkRoot -Name $Account -CreatedAccount $createdAccount
    return $OijWorkerExitFailure
  }

  try {
    # The server creates one directory per run below this root and grants the
    # worker access there; without this ACE required mode could not start a
    # judged process at all.
    if (-not (Test-Path -LiteralPath $WorkRoot)) {
      New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null
    }
    if (-not (Invoke-OijWorkerIcacls -Arguments @($WorkRoot, '/grant', ('{0}:(OI)(CI)F' -f $Owner), '/T', '/C', '/Q'))) {
      throw ('icacls failed while granting {0} access to {1}' -f $Owner, $WorkRoot)
    }
    if (-not (Invoke-OijWorkerIcacls -Arguments @($WorkRoot, '/grant', ('{0}:(OI)(CI)M' -f $Account), '/T', '/C', '/Q'))) {
      throw ('icacls failed while granting write access to {0}' -f $WorkRoot)
    }
    if (-not (Test-OijWorkerAclEntry -Path $WorkRoot -IdentityName $Account -AccessType 'Allow' -RequireWrite)) {
      throw ('{0} has no write ACE for {1}' -f $WorkRoot, $Account)
    }
    Write-OijWorkerOk ('{0} can write to the judge work root {1}' -f $Account, $WorkRoot)
  } catch {
    Write-OijWorkerFail ('Could not grant the judge work root: {0}' -f $_.Exception.Message)
    Write-OijWorkerLog ('work root step failed: {0}' -f $_.Exception.Message)
    Undo-OijWorkerInstall -WorkerFile $workerFile -DataRoot $DataRoot -WorkRoot $WorkRoot -Name $Account -CreatedAccount $createdAccount
    return $OijWorkerExitFailure
  }

  try {
    $existingRule = Get-NetFirewallRule -DisplayName $OijWorkerFirewallRuleName -ErrorAction SilentlyContinue
    if ($existingRule) {
      Remove-NetFirewallRule -Name $existingRule.Name -ErrorAction Stop
    }
    $localUser = '{0}\{1}' -f $env:COMPUTERNAME, $Account
    New-NetFirewallRule -DisplayName $OijWorkerFirewallRuleName -Direction Outbound -Action Block `
      -Profile Any -LocalUser $localUser -Description 'OiJudge judge worker outbound network block' `
      -ErrorAction Stop | Out-Null
    if (-not (Get-NetFirewallRule -DisplayName $OijWorkerFirewallRuleName -ErrorAction SilentlyContinue)) {
      throw 'the firewall rule is missing after creation'
    }
    Write-OijWorkerOk ('outbound network is blocked for {0}' -f $localUser)
  } catch {
    Write-OijWorkerFail ('Could not block the worker account outbound traffic: {0}' -f $_.Exception.Message)
    Write-OijWorkerLog ('firewall step failed: {0}' -f $_.Exception.Message)
    Undo-OijWorkerInstall -WorkerFile $workerFile -DataRoot $DataRoot -WorkRoot $WorkRoot -Name $Account -CreatedAccount $createdAccount
    return $OijWorkerExitFailure
  }

  Write-OijWorkerOk 'worker isolation is enabled and requested as required (workerIsolation=required)'
  Write-Host ('  account:   {0}' -f $Account)
  Write-Host ('  data dir:  {0}' -f $DataRoot)
  Write-Host ('  work root: {0}' -f $WorkRoot)
  Write-Host ('  secrets:   {0}' -f $workerFile)
  Write-OijWorkerLog 'worker isolation enabled (required)'
  return $OijWorkerExitSuccess
}

function Invoke-OijWorkerRemove {
  param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][string]$WorkRoot
  )
  $workerFile = Join-Path $DataRoot 'worker.json'
  $failures = New-Object System.Collections.ArrayList

  try {
    $rule = Get-NetFirewallRule -DisplayName $OijWorkerFirewallRuleName -ErrorAction SilentlyContinue
    if ($rule) {
      Remove-NetFirewallRule -Name $rule.Name -ErrorAction Stop
      Write-OijWorkerOk 'removed the worker outbound firewall rule'
    } else {
      Write-Host '[skip] no worker outbound firewall rule was found'
    }
  } catch {
    [void]$failures.Add(('firewall rule: {0}' -f $_.Exception.Message))
  }

  try {
    if (Get-LocalUser -Name $Account -ErrorAction SilentlyContinue) {
      Remove-LocalUser -Name $Account -ErrorAction Stop
      Write-OijWorkerOk ('removed the local account {0}' -f $Account)
    } else {
      Write-Host ('[skip] the local account {0} does not exist' -f $Account)
    }
  } catch {
    [void]$failures.Add(('local account {0}: {1}' -f $Account, $_.Exception.Message))
  }

  try {
    if (Test-Path -LiteralPath $workerFile) {
      Remove-Item -LiteralPath $workerFile -Force -ErrorAction Stop
      Write-OijWorkerOk ('deleted {0}' -f $workerFile)
    } else {
      Write-Host '[skip] worker.json does not exist'
    }
  } catch {
    [void]$failures.Add(('worker.json: {0}' -f $_.Exception.Message))
  }

  try {
    if (Test-Path -LiteralPath $DataRoot) {
      & icacls.exe $DataRoot '/remove:d' $Account '/C' '/Q' 2>&1 | Out-Null
    }
  } catch {
    # The deny ACE of a deleted account is harmless; keep going.
  }
  try {
    if (Test-Path -LiteralPath $WorkRoot) {
      & icacls.exe $WorkRoot '/remove' $Account '/T' '/C' '/Q' 2>&1 | Out-Null
    }
  } catch {
    # Best effort only.
  }

  if ($failures.Count -gt 0) {
    foreach ($failure in $failures) {
      Write-OijWorkerFail ('cleanup incomplete: ' + $failure)
    }
    Write-OijWorkerLog ('cleanup incomplete: ' + ($failures -join '; '))
    return $OijWorkerExitFailure
  }

  Write-OijWorkerOk 'worker isolation was removed'
  Write-OijWorkerLog 'worker isolation removed'
  return $OijWorkerExitSuccess
}

# --- Main ------------------------------------------------------------------

if (-not $Install -and -not $Remove) {
  Write-OijWorkerFail 'Pass -Install or -Remove.'
  exit $OijWorkerExitUsage
}
if ($Install -and $Remove) {
  Write-OijWorkerFail 'Pass only one of -Install or -Remove.'
  exit $OijWorkerExitUsage
}
if (-not (Confirm-OijWorkerAccountName -Name $Account)) {
  exit $OijWorkerExitUsage
}
if (-not $Owner) {
  $Owner = $env:USERNAME
}
if (-not $Owner) {
  Write-OijWorkerFail '-Owner must name the account that keeps access to worker.json.'
  exit $OijWorkerExitUsage
}

if (-not $DataDir) {
  $localAppData = $env:LOCALAPPDATA
  if (-not $localAppData) {
    $localAppData = Join-Path $env:USERPROFILE 'AppData\Local'
  }
  $DataDir = Join-Path (Join-Path $localAppData 'OiJudge') 'runtime'
}
$resolvedDataDir = Resolve-OijWorkerPath -Path $DataDir -What 'data directory'
if (-not $resolvedDataDir) {
  exit $OijWorkerExitUsage
}
if ($WorkDir) {
  $resolvedWorkDir = Resolve-OijWorkerPath -Path $WorkDir -What 'work directory'
  if (-not $resolvedWorkDir) {
    exit $OijWorkerExitUsage
  }
} else {
  $resolvedWorkDir = Get-OijWorkerJudgeWorkRoot -DataRoot $resolvedDataDir
}

if ($DryRun) {
  if ($Install) {
    Write-OijWorkerPlan ('create or reset local user {0} with a new 24-byte random password' -f $Account)
    Write-OijWorkerPlan ('write owner-only {0} and deny {1} read access' -f (Join-Path $resolvedDataDir 'worker.json'), $Account)
    Write-OijWorkerPlan ('deny {0} read access to {1}' -f $Account, $resolvedDataDir)
    Write-OijWorkerPlan ('grant {0} modify access to the judge work root {1}' -f $Account, $resolvedWorkDir)
    Write-OijWorkerPlan ('block outbound traffic for {0}\{1} in Windows Firewall ({2})' -f $env:COMPUTERNAME, $Account, $OijWorkerFirewallRuleName)
    Write-OijWorkerPlan 'on success the server is started with OIJ_WORKER_ISOLATION=required; on failure it stays optional'
  } else {
    Write-OijWorkerPlan ('remove the Windows Firewall rule "{0}"' -f $OijWorkerFirewallRuleName)
    Write-OijWorkerPlan ('remove the local user {0}' -f $Account)
    Write-OijWorkerPlan ('delete {0}' -f (Join-Path $resolvedDataDir 'worker.json'))
    Write-OijWorkerPlan ('remove the {0} ACEs from {1} and {2}' -f $Account, $resolvedDataDir, $resolvedWorkDir)
  }
  Write-OijWorkerPlan 'dry run finished; nothing was changed'
  exit $OijWorkerExitSuccess
}

$administrator = Test-OijWorkerAdministrator
$resolvedWorkerFile = Join-Path $resolvedDataDir 'worker.json'

# Removal of a setup that does not exist is a no-op and needs no elevation.
# A leftover worker.json is a plain file owned by the installing user, so it
# can be deleted without UAC as well.
if ($Remove -and -not $administrator) {
  $artifacts = Get-OijWorkerArtifacts -WorkerFile $resolvedWorkerFile
  if (-not $artifacts.Account -and -not $artifacts.Firewall) {
    if ($artifacts.WorkerFile) {
      try {
        Remove-Item -LiteralPath $resolvedWorkerFile -Force -ErrorAction Stop
        Write-OijWorkerOk ('deleted {0}' -f $resolvedWorkerFile)
        exit $OijWorkerExitSuccess
      } catch {
        Write-OijWorkerWarn ('could not delete {0}: {1}' -f $resolvedWorkerFile, $_.Exception.Message)
        exit $OijWorkerExitFailure
      }
    }
    Write-Host '[skip] no judge worker isolation was found; nothing to remove.'
    exit $OijWorkerExitSuccess
  }
}

Start-OijWorkerLog -DataRoot $resolvedDataDir
Write-OijWorkerLog ('{0} requested for account {1} (dataDir={2})' -f $(if ($Install) { 'install' } else { 'remove' }), $Account, $resolvedDataDir)

if (-not $administrator) {
  if (-not $Elevate) {
    Write-OijWorkerWarn 'Administrator rights are required to manage the worker account, ACLs and the firewall rule.'
    Write-OijWorkerWarn 'Re-run this script from an elevated PowerShell (or pass -Elevate in the installer).'
    exit $OijWorkerExitAdminRequired
  }
  Write-Host '[..] requesting administrator approval (UAC) ...'
  $elevatedExit = Invoke-OijWorkerElevation -DataRoot $resolvedDataDir -WorkRoot $resolvedWorkDir
  exit $elevatedExit
}

if ($Install) {
  $result = Invoke-OijWorkerInstall -DataRoot $resolvedDataDir -WorkRoot $resolvedWorkDir
} else {
  if (-not (Get-OijWorkerArtifacts -WorkerFile $resolvedWorkerFile).Any) {
    Write-Host '[skip] no judge worker isolation was found; nothing to remove.'
    exit $OijWorkerExitSuccess
  }
  $result = Invoke-OijWorkerRemove -DataRoot $resolvedDataDir -WorkRoot $resolvedWorkDir
}
exit $result
