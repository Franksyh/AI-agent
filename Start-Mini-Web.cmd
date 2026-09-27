@echo off
cd /d "%~dp0"
python mini_codex\server.py
if errorlevel 1 pause
