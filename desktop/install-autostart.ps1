# Message Board - install / uninstall "keep the board online" at logon.
# ASCII only on purpose (Windows PowerShell 5.1 + ANSI .ps1 files).
#
# Installs a shortcut in the user's Startup folder. By default it starts the watchdog
# (desktop\watchdog.vbs -> watchdog.ps1): one background loop that brings up the board
# service and keeps every member's wake channel alive, so a member going offline -
# after a reboot, a crash, or a kill - is repaired within about a minute.
#
# No admin rights needed; uninstall just deletes the shortcut.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File desktop\install-autostart.ps1
#   powershell -ExecutionPolicy Bypass -File desktop\install-autostart.ps1 -OneShot
#   powershell -ExecutionPolicy Bypass -File desktop\install-autostart.ps1 -Uninstall

param(
  [switch]$Uninstall,
  [switch]$OneShot
)

$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'Message Board.lnk'

if ($Uninstall) {
  if (Test-Path $lnkPath) {
    Remove-Item -LiteralPath $lnkPath -Force
    Write-Host "Removed startup shortcut: $lnkPath"
  } else {
    Write-Host "No startup shortcut found."
  }
  return
}

$vbs = 'watchdog.vbs'
$what = 'watchdog (keeps board + members online)'
if ($OneShot) {
  $vbs = 'autostart.vbs'
  $what = 'one-shot start (board service + member channels)'
}

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = 'wscript.exe'
$lnk.Arguments = '"' + (Join-Path $here $vbs) + '"'
$lnk.WorkingDirectory = (Split-Path -Parent $here)
$lnk.Description = 'Message Board: ' + $what
$lnk.Save()

Write-Host "Installed: $lnkPath"
Write-Host "Runs at logon: $here\$vbs  ->  $what (background, no window)"
Write-Host "Logs: <repo>\data\logs\watchdog.log (or autostart.log with -OneShot)"
