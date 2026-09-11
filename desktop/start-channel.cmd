@echo off
REM Message Board - start one agent member channel (app-server based).
REM ASCII only on purpose: this file is interpreted with the system code page.
REM
REM Why this file exists: on some machines a process started from the autostart chain
REM cannot create further child processes (spawning codex.exe fails with ENOENT),
REM while a directly launched one can. Double-clicking this file uses that working path.
REM
REM Usage:
REM   start-channel.cmd --no-pause                                  (defaults to codex)
REM   start-channel.cmd --no-pause --agent deepseek --name DeepSeek --title "Second opinion"
REM
REM The channel keeps running in this window; close the window to stop the channel.

setlocal
set "ROOT=%~dp0.."
cd /d "%ROOT%"

set "AGENT=codex"
set "NAME=Codex"
set "TITLE=Project Lead"
set "NOPAUSE="

:parse
if "%~1"=="--no-pause" ( set "NOPAUSE=1" & shift & goto parse )
if "%~1"=="--agent"  ( set "AGENT=%~2"  & shift & shift & goto parse )
if "%~1"=="--name"   ( set "NAME=%~2"   & shift & shift & goto parse )
if "%~1"=="--title"  ( set "TITLE=%~2"  & shift & shift & goto parse )
if "%~1"=="" goto run
shift
goto parse

:run
echo Message Board - agent channel: %AGENT% (%NAME%)
echo Repo: %ROOT%
echo.

node "bridges\codex-channel.js" --agent "%AGENT%" --name "%NAME%" --title "%TITLE%" --workdir "%ROOT%"

echo.
echo Channel exited with code %errorlevel%.
if not defined NOPAUSE pause
