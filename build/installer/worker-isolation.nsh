; OiJudge optional judge-account isolation for the NSIS installer.
;
; electron-builder includes this file through `nsis.include`. The actual
; account / ACL / firewall work is implemented once in
; tools/deploy/windows/worker-isolation.ps1; the installer embeds that file and
; runs it only when the user ticks the checkbox. A failure (including a
; cancelled UAC prompt) is reported and OiJudge stays in the optional mode;
; nothing here pretends the isolation was enabled.

!include "LogicLib.nsh"
!include "nsDialogs.nsh"

; The page/install side must not be compiled into the intermediate uninstaller
; build: NSIS treats "unused variable" as an error (-WX) and the page does not
; exist there.
!ifndef BUILD_UNINSTALLER
Var OijWorkerIsolationCheckbox
Var OijWorkerIsolationChecked

!macro customPageAfterChangeDir
  ; Custom page shown after the installation-directory page. The checkbox is
  ; unchecked by default; the state survives Back/Next navigation.
  Function OijWorkerIsolationPageCreate
    !insertmacro MUI_HEADER_TEXT "可选组件：判题账户隔离" "使用低权限 Windows 账户运行选手代码"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 38u "勾选后，选手代码由专用的低权限本地账户 OiJudgeWorker 运行：该账户无法读取题库、提交记录与数据库，且出站网络会被阻断。$\r$\n$\r$\n此步骤需要管理员批准（UAC）。不勾选时 OiJudge 仍可正常安装和使用，判题以普通方式运行。"
    Pop $0
    ${NSD_CreateCheckbox} 0 52u 100% 24u "启用判题账户隔离（需要管理员权限）"
    Pop $OijWorkerIsolationCheckbox
    ${If} $OijWorkerIsolationChecked == "1"
      ${NSD_Check} $OijWorkerIsolationCheckbox
    ${EndIf}
    nsDialogs::Show
  FunctionEnd

  Function OijWorkerIsolationPageLeave
    ${NSD_GetState} $OijWorkerIsolationCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $OijWorkerIsolationChecked "1"
    ${Else}
      StrCpy $OijWorkerIsolationChecked "0"
    ${EndIf}
  FunctionEnd

  Page custom OijWorkerIsolationPageCreate OijWorkerIsolationPageLeave
!macroend

!macro customInstall
  ${If} $OijWorkerIsolationChecked == "1"
    ; Keep a copy in the application directory so the user can retry the
    ; isolation setup later without re-running the installer.
    File "/oname=$INSTDIR\worker-isolation.ps1" "${PROJECT_DIR}\tools\deploy\windows\worker-isolation.ps1"
    ReadEnvStr $0 "USERNAME"
    DetailPrint "Enabling optional judge-account isolation (UAC required) ..."
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\worker-isolation.ps1" -Install -Elevate -DataDir "$APPDATA\OiJudge\runtime" -Owner "$0"' $1
    ${If} $1 == "0"
      DetailPrint "Judge-account isolation is enabled (workerIsolation=required)."
      WriteRegStr HKCU "Software\OiJudge\Installer" "WorkerIsolation" "required"
    ${Else}
      DetailPrint "Judge-account isolation was NOT enabled (exit code $1); OiJudge stays optional."
      WriteRegStr HKCU "Software\OiJudge\Installer" "WorkerIsolation" "optional"
      ${IfNot} ${Silent}
        MessageBox MB_ICONEXCLAMATION|MB_OK "未启用判题账户隔离（退出码 $1）。$\r$\n$\r$\nOiJudge 已安装完成，判题将以普通账户运行。稍后可在管理员 PowerShell 中重新运行安装目录下的 worker-isolation.ps1 启用。"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!endif

!macro customUnInstall
  ; worker.json lives in the Electron userData directory. Remove the firewall
  ; rule, the local account and the credentials together; report a partial
  ; cleanup instead of silently claiming success.
  SetShellVarContext current
  InitPluginsDir
  File "/oname=$PLUGINSDIR\OiJudge-worker-isolation.ps1" "${PROJECT_DIR}\tools\deploy\windows\worker-isolation.ps1"
  ReadEnvStr $0 "USERNAME"
  DetailPrint "Removing optional judge-account isolation ..."
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\OiJudge-worker-isolation.ps1" -Remove -Elevate -DataDir "$APPDATA\OiJudge\runtime" -Owner "$0"' $1
  ${If} $1 != "0"
    DetailPrint "Judge-account isolation cleanup did not finish (exit code $1)."
    ${IfNot} ${Silent}
      MessageBox MB_ICONEXCLAMATION|MB_OK "判题账户隔离的清理未完成（退出码 $1）。$\r$\n$\r$\n请以管理员身份运行安装目录下的 worker-isolation.ps1 -Remove，或手动删除 OiJudgeWorker 本地用户与“OiJudge Worker outbound block”防火墙规则。"
    ${EndIf}
  ${EndIf}
  DeleteRegKey HKCU "Software\OiJudge\Installer"
  StrCmp $installMode "all" 0 +2
    SetShellVarContext all
!macroend
