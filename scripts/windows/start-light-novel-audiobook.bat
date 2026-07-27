@echo off
REM Desktop launcher for the local audiobook web app. Installed as a Desktop shortcut by
REM scripts/windows/install-desktop-shortcuts.ps1.
REM
REM Closing this window with Ctrl-C stops the app and frees the GPU. Closing it with the X button
REM does not reliably deliver a signal through wsl.exe, so use Ctrl-C, the Stop button in the app,
REM or the "Stop Light Novel Audiobook" shortcut.
title Light Novel Audiobook

wsl.exe -d Ubuntu -- bash -lc "cd /home/windows_11/repos/light-novel-audiobook && exec ./scripts/start-web-app.sh %*"

echo.
echo The app has stopped.
echo If the GPU still looks busy, run the "Stop Light Novel Audiobook" shortcut.
pause
