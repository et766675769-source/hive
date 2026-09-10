@echo off
REM Message Board - start the Codex member channel (app-server based).
REM ASCII only on purpose: this file is interpreted with the system code page.
REM
REM Why this file exists: on some machines a process started from the autostart chain
REM cannot create further child processes (spawning codex.exe fails with ENOENT),
REM while a directly launched one can. Double-clicking this file uses that working path.
REM
REM The channel keeps running in this window; close the window to stop the channel.

setlocal
set "ROOT=%~dp0.."
cd /d "%ROOT%"

echo Message Board - Codex channel
echo Repo: %ROOT%
echo.

node "bridges\codex-channel.js" --agent codex --workdir "%ROOT%"

echo.
echo Channel exited with code %errorlevel%.
pause
