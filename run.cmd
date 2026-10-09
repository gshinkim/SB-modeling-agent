@echo off
rem Windows entry point: starts the server. No bash needed.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" echo Run setup.cmd first.
if not exist ".venv\Scripts\python.exe" exit /b 1
node backend\server.mjs
