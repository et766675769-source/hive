# Message Board - install / uninstall autostart at logon.
# ASCII only on purpose (Windows PowerShell 5.1 + ANSI .ps1 files).
#
# Creates a shortcut in the user's Startup folder that runs desktop\autostart.vbs
# (which brings up the board service and the member channels in the background).
# No admin rights needed; uninstall is just deleting that shortcut.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File desktop\install-autostart.ps1
#   powershell -ExecutionPolicy Bypass -File desktop\install-autostart.ps1 -Uninstall

param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'Message Board.lnk'

if ($Uninstall) {
  if (Test-Path $lnkPath) {
    Remove-Item -LiteralPath $lnkPath -Force
    Write-Host "Removed autostart shortcut: $lnkPath"
  } else {
    Write-Host "No autostart shortcut found."
  }
  return
}

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = 'wscript.exe'
$lnk.Arguments = '"' + (Join-Path $here 'autostart.vbs') + '"'
$lnk.WorkingDirectory = (Split-Path -Parent $here)
$lnk.Description = 'Start the Message Board service and member channels at logon'
$lnk.Save()

Write-Host "Autostart installed: $lnkPath"
Write-Host "It runs: $here\autostart.vbs  ->  autostart.ps1 (background, no window)"
Write-Host "Logs:    <repo>\data\logs\autostart.log"
