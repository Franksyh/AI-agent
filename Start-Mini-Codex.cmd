@echo off
cd /d "%~dp0"
if exist "%~dp0MiniCodex.exe" (
  start "" "%~dp0MiniCodex.exe"
  exit /b 0
)
pythonw mini_codex\desktop.py
if errorlevel 1 (
  echo Mini Codex could not start. Install Python with Tcl/Tk support, or use the Windows release package.
  pause
)
