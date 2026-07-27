@echo off
REM Stops the local audiobook web app and frees the GPU, from outside the app.
REM
REM For when the launcher window was closed with the X button, the WSL session was lost, or the
REM machine woke from sleep with the card still held.
title Stop Light Novel Audiobook

wsl.exe -d Ubuntu -- bash -lc "cd /home/windows_11/repos/light-novel-audiobook && ./scripts/stop-web-app.sh"

echo.
pause
