# Message Board · 桌面启动器
#
# 作用：双击即用。
#   1) 黑板服务没在跑 → 隐藏启动它；
#   2) 用 Chromium 内核浏览器以「应用窗口」模式打开黑板（无地址栏、无标签页、独立任务栏窗口）。
#
# 这是零依赖的窗口方案：不需要额外安装任何东西，Windows / macOS / Linux 都可用。

param(
  [int]$Port = 8787,
  [switch]$BrowserTab
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $root 'server\index.js'
if (-not (Test-Path $entry)) { throw "找不到黑板入口：$entry" }
$url = "http://127.0.0.1:$Port"

function Test-Board {
  try {
    return (Invoke-WebRequest "$url/api/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200
  } catch {
    return $false
  }
}

if (-not (Test-Board)) {
  Write-Host "启动黑板服务 $url …"
  Start-Process -FilePath 'node' -WorkingDirectory $root -WindowStyle Hidden `
    -ArgumentList @("`"$entry`"", '--port', "$Port")
  for ($i = 0; $i -lt 40 -and -not (Test-Board); $i++) { Start-Sleep -Milliseconds 300 }
}
if (-not (Test-Board)) { throw "黑板未能在预期时间内启动：$url" }

if ($BrowserTab) {
  Start-Process $url
  Write-Host "已用默认浏览器打开：$url"
  return
}

# 优先用独立窗口（--app），找不到 Chromium 内核浏览器时退回默认浏览器
$candidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
) | Where-Object { Test-Path $_ }
$browser = $candidates | Select-Object -First 1

if ($browser) {
  $profileDir = Join-Path $env:LOCALAPPDATA 'MessageBoard\app-window'
  New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
  Start-Process -FilePath $browser -ArgumentList @(
    "--app=$url",
    "--user-data-dir=`"$profileDir`"",
    '--window-size=1440,900',
    '--no-first-run',
    '--no-default-browser-check'
  )
  Write-Host "已在独立窗口中打开：$url"
} else {
  Write-Host "未找到 Chromium 内核浏览器，改用默认浏览器打开：$url"
  Start-Process $url
}
