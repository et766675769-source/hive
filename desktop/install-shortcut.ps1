# Create a "Message Board" shortcut on the desktop (ASCII only on purpose:
# Windows PowerShell 5.1 reads .ps1 as ANSI unless it has a BOM).
#
# Target priority:
#   1) the WPF shell exe (desktop/shell/bin/Release/net8.0-windows/MessageBoard.Shell.exe) if built;
#   2) otherwise the console-less launcher MessageBoard.vbs (wscript + app window).
#
# Usage: powershell -ExecutionPolicy Bypass -File desktop\install-shortcut.ps1

$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$root = Split-Path -Parent $here
$exe = Join-Path $here 'shell\bin\Release\net8.0-windows\MessageBoard.Shell.exe'
$lnkPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Message Board.lnk'

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)

if (Test-Path $exe) {
  $lnk.TargetPath = $exe
  $lnk.Arguments = ''
  $lnk.WorkingDirectory = Split-Path -Parent $exe
  $mode = 'WPF shell exe'
} else {
  $lnk.TargetPath = 'wscript.exe'
  $lnk.Arguments = '"' + (Join-Path $here 'MessageBoard.vbs') + '"'
  $lnk.WorkingDirectory = $root
  $mode = 'console-less launcher (wscript + app window)'
}

$lnk.Description = 'Message Board - local multi-AI collaboration board'
$lnk.Save()

Write-Host "Desktop shortcut created: $lnkPath"
Write-Host "Target: $mode"
