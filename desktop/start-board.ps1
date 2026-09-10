# Message Board - desktop launcher (ASCII only on purpose).
#
# Windows PowerShell 5.1 reads .ps1 files as ANSI unless they carry a BOM,
# so keeping this file ASCII makes it work identically under 5.1 and 7+.
# The Chinese documentation lives in desktop/README.md instead.
#
# What it does:
#   1) if the board is not running, start `node server/index.js` hidden;
#   2) open the board in a Chromium app window (no address bar, no tabs,
#      its own taskbar entry).

param(
  [int]$Port = 8787,
  [switch]$BrowserTab
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $root 'server\index.js'
if (-not (Test-Path $entry)) { throw "Cannot find server entry: $entry" }
$url = "http://127.0.0.1:$Port"

function Test-Board {
  try {
    return (Invoke-WebRequest "$url/api/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200
  } catch {
    return $false
  }
}

if (-not (Test-Board)) {
  Write-Host "Starting board service at $url ..."
  Start-Process -FilePath 'node' -WorkingDirectory $root -WindowStyle Hidden `
    -ArgumentList @("`"$entry`"", '--port', "$Port")
  for ($i = 0; $i -lt 40 -and -not (Test-Board); $i++) { Start-Sleep -Milliseconds 300 }
}
if (-not (Test-Board)) { throw "Board did not start in time: $url" }

if ($BrowserTab) {
  Start-Process $url
  Write-Host "Opened in the default browser: $url"
  return
}

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
  Write-Host "Opened as a standalone window: $url"
} else {
  Write-Host "No Chromium-based browser found; opening in the default browser: $url"
  Start-Process $url
}
