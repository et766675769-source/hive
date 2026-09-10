# 在桌面创建「Message Board」快捷方式。
#
# 目标选择顺序：
#   1) WPF 外壳 exe（desktop/shell/bin/Release/net8.0-windows/MessageBoard.Shell.exe）—— 若已构建
#   2) 无控制台启动器 MessageBoard.vbs（wscript 拉起，独立应用窗口）
#
# 用法：powershell -ExecutionPolicy Bypass -File desktop\install-shortcut.ps1

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
  $mode = 'WPF 外壳 exe'
} else {
  $lnk.TargetPath = 'wscript.exe'
  $lnk.Arguments = '"' + (Join-Path $here 'MessageBoard.vbs') + '"'
  $lnk.WorkingDirectory = $root
  $mode = '无控制台启动器（wscript + 独立应用窗口）'
}

$lnk.Description = 'Message Board · 留言板（本地多 AI 协作黑板）'
$lnk.Save()

Write-Host "已在桌面创建快捷方式：$lnkPath"
Write-Host "指向：$mode"
