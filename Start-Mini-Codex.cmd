@echo off
cd /d "%~dp0"
pythonw mini_codex\desktop.py
if errorlevel 1 (
  echo Mini Codex could not start. Please install Python with Tcl/Tk support.
  pause
)
