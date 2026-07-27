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

# Two shortcuts: one that runs the app, one that stops it from outside. The second exists because
# closing the launcher window with the X button does not reliably deliver a signal through wsl.exe,
# and an abandoned run keeps roughly 15 GB of the card.
$shortcuts = @(
    @{ Name = 'Light Novel Audiobook';      Target = 'start-light-novel-audiobook.bat'; Icon = 'imageres.dll,109'; Description = 'Start the local audiobook studio and open it in the browser' },
    @{ Name = 'Stop Light Novel Audiobook'; Target = 'stop-light-novel-audiobook.bat';  Icon = 'imageres.dll,100'; Description = 'Stop the local audiobook studio and free the GPU' }
)

foreach ($entry in $shortcuts) {
    $target = Join-Path $scriptDir $entry.Target
    if (-not (Test-Path $target)) { throw "missing launcher: $target" }

    $linkPath = Join-Path $desktop ($entry.Name + '.lnk')
    $link = $shell.CreateShortcut($linkPath)
    $link.TargetPath = $target
    $link.WorkingDirectory = $scriptDir
    $link.Description = $entry.Description
    $link.IconLocation = Join-Path $env:SystemRoot ('System32\' + $entry.Icon)
    $link.Save()
    Write-Host "installed: $linkPath"
}

Write-Host ''
Write-Host 'Double-click "Light Novel Audiobook" to start. It opens http://localhost:3000 once the'
Write-Host 'server is answering. Ctrl-C in that window, or the Stop shortcut, frees the GPU.'
