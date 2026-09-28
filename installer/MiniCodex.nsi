Unicode true
RequestExecutionLevel user
SetCompressor /SOLID zlib
SetDateSave on
SetOverwrite on
CRCCheck force

!include "MUI2.nsh"

!ifndef APP_VERSION
  !define APP_VERSION "0.1.2"
!endif

!define APP_NAME "Mini Codex"
!define APP_EXE "MiniCodex.exe"
!define APP_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\MiniCodex"

Name "${APP_NAME} ${APP_VERSION}"
OutFile "dist\MiniCodex-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\Mini Codex"
InstallDirRegKey HKCU "${APP_UNINSTALL_KEY}" "InstallLocation"
ShowInstDetails show
ShowUnInstDetails show
UninstallDisplayName "${APP_NAME}"
UninstallDisplayIcon "$INSTDIR\${APP_EXE}"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "FileDescription" "${APP_NAME} Windows installer"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "啟動 Mini Codex"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "TradChinese"

Section "Mini Codex（必要檔案）" MainSection
  SectionIn RO
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "dist\MiniCodex\*"

  CreateDirectory "$SMPROGRAMS\Mini Codex"
  CreateShortcut "$SMPROGRAMS\Mini Codex\Mini Codex.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}"
  CreateShortcut "$SMPROGRAMS\Mini Codex\解除安裝 Mini Codex.lnk" "$INSTDIR\Uninstall.exe"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${APP_UNINSTALL_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${APP_UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${APP_UNINSTALL_KEY}" "Publisher" "Mini Codex"
  WriteRegStr HKCU "${APP_UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${APP_UNINSTALL_KEY}" "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  WriteRegStr HKCU "${APP_UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegDWORD HKCU "${APP_UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${APP_UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section /o "建立桌面捷徑" DesktopSection
  CreateShortcut "$DESKTOP\Mini Codex.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$SMPROGRAMS\Mini Codex\Mini Codex.lnk"
  Delete "$SMPROGRAMS\Mini Codex\解除安裝 Mini Codex.lnk"
  RMDir "$SMPROGRAMS\Mini Codex"
  Delete "$DESKTOP\Mini Codex.lnk"
  DeleteRegKey HKCU "${APP_UNINSTALL_KEY}"
  RMDir /r "$INSTDIR"
SectionEnd
