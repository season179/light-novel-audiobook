# Puts "Light Novel Audiobook" and "Stop Light Novel Audiobook" on the Windows Desktop.
#
# Run it again after moving the repository, wiping the Desktop, or changing the WSL distro name:
# it overwrites the shortcuts rather than adding more.
#
#   From WSL:      powershell.exe -ExecutionPolicy Bypass -File "$(wslpath -w scripts/windows/install-desktop-shortcuts.ps1)"
#   From Windows:  right-click the file and choose "Run with PowerShell"

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell

# The launchers are copied to a Windows-side directory rather than pointed at in place. A shortcut
# to \\wsl.localhost\... makes cmd.exe print "UNC paths are not supported" on every single launch,
# because it cannot use a UNC path as a working directory. The copies call wsl.exe with absolute
# Linux paths, so where they sit does not matter. Re-run this after editing a .bat.
$installDir = Join-Path $env:LOCALAPPDATA 'LightNovelAudiobook'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

# Two shortcuts: one that runs the app, one that stops it from outside. The second exists because
# closing the launcher window with the X button does not reliably deliver a signal through wsl.exe,
# and an abandoned run keeps roughly 15 GB of the card.
$shortcuts = @(
    @{ Name = 'Light Novel Audiobook';      Target = 'start-light-novel-audiobook.bat'; Icon = 'imageres.dll,109'; Description = 'Start the local audiobook studio and open it in the browser' },
    @{ Name = 'Stop Light Novel Audiobook'; Target = 'stop-light-novel-audiobook.bat';  Icon = 'imageres.dll,100'; Description = 'Stop the local audiobook studio and free the GPU' }
)

foreach ($entry in $shortcuts) {
    $source = Join-Path $scriptDir $entry.Target
    if (-not (Test-Path $source)) { throw "missing launcher: $source" }
    $target = Join-Path $installDir $entry.Target
    Copy-Item -Path $source -Destination $target -Force

    $linkPath = Join-Path $desktop ($entry.Name + '.lnk')
    $link = $shell.CreateShortcut($linkPath)
    $link.TargetPath = $target
    $link.WorkingDirectory = $installDir
    $link.Description = $entry.Description
    $link.IconLocation = Join-Path $env:SystemRoot ('System32\' + $entry.Icon)
    $link.Save()
    Write-Host "installed: $linkPath"
}

Write-Host ''
Write-Host 'Double-click "Light Novel Audiobook" to start. It opens http://localhost:3000 once the'
Write-Host 'server is answering. Ctrl-C in that window, or the Stop shortcut, frees the GPU.'
