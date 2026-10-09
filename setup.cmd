@echo off
rem Windows entry point: runs setup.sh with the bash that Git for Windows installs.
rem Plain "bash" in PowerShell or cmd is the WSL launcher, not Git Bash, and fails without WSL.
set "GITBASH=%ProgramFiles%\Git\bin\bash.exe"
if not exist "%GITBASH%" for /f "delims=" %%g in ('where git 2^>nul') do set "GITBASH=%%~dpg..\bin\bash.exe"
if not exist "%GITBASH%" echo Git for Windows is needed: winget install Git.Git   then open a new terminal.
if not exist "%GITBASH%" exit /b 1
"%GITBASH%" "%~dp0setup.sh" %*
