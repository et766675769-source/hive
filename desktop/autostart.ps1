# Message Board - bring the whole stack back up (after reboot / logon).
# ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI unless it has a BOM.
#
# Starts, in order:
#   1) the board service       node server/index.js
#   2) the member channels     codex-channel.js (Codex app-server) + tools/mb.js watch (long-poll)
#   3) optionally the window   desktop\start-board.ps1 -OpenWindow
#
# Idempotent: it asks the board itself who is already online, and only starts what is missing.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File desktop\autostart.ps1
#   powershell -ExecutionPolicy Bypass -File desktop\autostart.ps1 -OpenWindow

param(
  [int]$Port = 8787,
  [switch]$OpenWindow
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
$url = "http://127.0.0.1:$Port"
$logDir = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'autostart.log'

function Write-Log([string]$message) {
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Write-Host $line
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}

function Test-Board {
  try {
    return (Invoke-WebRequest "$url/api/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200
  } catch {
    return $false
  }
}

function Get-State {
  try {
    return Invoke-RestMethod "$url/api/state?limit=3" -TimeoutSec 4
  } catch {
    return $null
  }
}

function Start-Hidden([string]$file, [string[]]$arguments, [string]$stdout, [string]$stderr) {
  $params = @{
    FilePath         = 'node'
    WorkingDirectory = $root
    WindowStyle      = 'Hidden'
    ArgumentList     = $arguments
  }
  if ($stdout) { $params.RedirectStandardOutput = $stdout }
  if ($stderr) { $params.RedirectStandardError = $stderr }
  return Start-Process @params
}

Write-Log "autostart: begin (root=$root port=$Port)"

# 1) board service
if (-not (Test-Board)) {
  Write-Log "autostart: starting board service"
  Start-Hidden 'server/index.js' @('server/index.js', '--port', "$Port") (Join-Path $logDir 'server.log') (Join-Path $logDir 'server.err.log') | Out-Null
  for ($i = 0; $i -lt 40 -and -not (Test-Board); $i++) { Start-Sleep -Milliseconds 400 }
} else {
  Write-Log "autostart: board already up"
}
if (-not (Test-Board)) {
  Write-Log "autostart: FAILED - board did not come up"
  exit 1
}

# 2) members - ask the board who is *actually* listening right now.
#    Do not trust "state -ne offline": a killed process keeps a fresh heartbeat for up to the TTL,
#    and the channel check accepts "recently attached" for 120s, which would skip a needed start.
#    The only reliable signal is: is a long-poll attached at this very moment.
$state = Get-State
$alreadyOnline = @()
if ($state) {
  foreach ($agent in $state.agents) {
    if (-not $agent.acceptance) { continue }
    $waiting = $false
    if ($agent.acceptance.channel -and $agent.acceptance.channel.inbox) {
      $waiting = [bool]$agent.acceptance.channel.inbox.waiting
    }
    $callbackOk = $false
    if ($agent.acceptance.channel -and $agent.acceptance.channel.callback) {
      $callbackOk = [bool]$agent.acceptance.channel.callback.ok
    }
    if ($waiting -or $callbackOk) { $alreadyOnline += $agent.id }
  }
}
Write-Log ("autostart: members listening now: " + (($alreadyOnline | Sort-Object) -join ', '))

if ($alreadyOnline -notcontains 'codex') {
  Write-Log "autostart: starting codex channel"
  # no --name/--title: the JS defaults (UTF-8, read by Node) keep the member's display name/title intact
  $codexArgs = @('bridges/codex-channel.js', '--agent', 'codex', '--workdir', $root)
  Start-Hidden 'bridges/codex-channel.js' $codexArgs (Join-Path $logDir 'codex-channel.log') (Join-Path $logDir 'codex-channel.err.log') | Out-Null
} else {
  Write-Log "autostart: codex channel already live"
}

# Fallback start: in some environments a grandchild process started via Start-Process
# cannot create further child processes (it surfaces as codex.exe ENOENT).
# In that case retry through "cmd start", which uses a different launch path.
if ($alreadyOnline -notcontains 'codex') {
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    $probe = Get-State
    $codexWaiting = $false
    if ($probe) {
      $entry = $probe.agents | Where-Object { $_.id -eq 'codex' }
      if ($entry -and $entry.acceptance -and $entry.acceptance.channel -and $entry.acceptance.channel.inbox) {
        $codexWaiting = [bool]$entry.acceptance.channel.inbox.waiting
      }
    }
    if ($codexWaiting) { break }
  }
  $probe = Get-State
  $codexUp = $false
  if ($probe) {
    $entry = $probe.agents | Where-Object { $_.id -eq 'codex' }
    if ($entry -and $entry.acceptance -and $entry.acceptance.channel -and $entry.acceptance.channel.inbox) {
      $codexUp = [bool]$entry.acceptance.channel.inbox.waiting
    }
  }
  if (-not $codexUp) {
    # Deliberately no second launch attempt here. In this environment a grandchild process
    # started from this script cannot create further child processes (codex.exe spawn -> ENOENT),
    # and a "cmd start" retry produced a visible Windows error dialog. Log the exact manual step instead.
    Write-Log "autostart: codex channel did NOT get up (see data\logs\codex-channel.log)"
    Write-Log "autostart: fix manually by double-clicking desktop\start-channel.cmd"
  }
}

if ($alreadyOnline -notcontains 'deepseek') {
  Write-Log "autostart: starting deepseek listener"
  Start-Hidden 'tools/mb.js' @('tools/mb.js', 'watch', 'deepseek', '--wait', '20', '--note', 'autostart listener') (Join-Path $logDir 'deepseek.log') (Join-Path $logDir 'deepseek.err.log') | Out-Null
} else {
  Write-Log "autostart: deepseek listener already live"
}

# 3) optional window (the WPF shell already starts the service itself if missing)
if ($OpenWindow) {
  Write-Log "autostart: opening window"
  & (Join-Path $PSScriptRoot 'start-board.ps1')
}

Start-Sleep -Seconds 3
$final = Get-State
if ($final) {
  $summary = ($final.agents | ForEach-Object { "$($_.id)=$($_.state)/$($_.acceptance.status)" }) -join ' '
  Write-Log "autostart: done - $summary"
} else {
  Write-Log "autostart: done (state unavailable)"
}
