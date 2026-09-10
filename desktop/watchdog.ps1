# Message Board - watchdog: keep every member's wake channel alive.
# ASCII only on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI unless it has a BOM).
#
# Every IntervalSeconds it asks the board who is actually listening (a long-poll attached
# right now, or a callback that succeeded). Whoever is not listening gets started again.
# It also restarts the board service itself if it is down.
#
# Meant to be started once at logon (see install-autostart.ps1) and left running.
# A PID lock file makes repeated launches harmless: a second watchdog exits immediately.
# Log: <repo>\data\logs\watchdog.log
#
# Manual run:
#   powershell -ExecutionPolicy Bypass -File desktop\watchdog.ps1

param(
  [int]$Port = 8787,
  [int]$IntervalSeconds = 60
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
$url = "http://127.0.0.1:$Port"
$logDir = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'watchdog.log'
$lock = Join-Path $logDir 'watchdog.lock'

# Singleton guard: if a live watchdog already owns the lock, do nothing.
$alive = $false
if (Test-Path $lock) {
  $owner = (Get-Content -LiteralPath $lock -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($owner -and (Get-Process -Id ([int]$owner) -ErrorAction SilentlyContinue)) { $alive = $true }
}
if ($alive) {
  Add-Content -LiteralPath $log -Value ("{0} watchdog: another instance is alive (PID {1}) - exiting" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $owner) -Encoding UTF8
  return
}
Set-Content -LiteralPath $lock -Value $PID -Encoding ASCII

# -ConsoleOnly: print progress to the screen but do not grow the log file
# (the per-cycle status line would otherwise write a line every interval, forever).
function Write-Log([string]$message, [switch]$ConsoleOnly) {
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Write-Host $line
  if ($ConsoleOnly) { return }

  # Cheap rotation so a long-running watchdog cannot grow one file without bound.
  try {
    if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) {
      Move-Item -LiteralPath $log -Destination "$log.1" -Force
    }
  } catch {
    # rotation is best effort
  }
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}

function Get-State {
  try {
    return Invoke-RestMethod "$url/api/state?limit=3" -TimeoutSec 5
  } catch {
    return $null
  }
}

function Start-Board {
  Start-Process -FilePath 'node' -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir 'server.log') `
    -RedirectStandardError (Join-Path $logDir 'server.err.log') `
    -ArgumentList @('server/index.js', '--port', "$Port") | Out-Null
}

# The Codex channel must be started through cmd (see desktop\start-channel.cmd):
# on this machine a node started directly by a background launcher cannot spawn codex.exe.
function Start-CodexChannel {
  Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -WorkingDirectory $root `
    -ArgumentList @('/c', 'desktop\start-channel.cmd', '--no-pause') | Out-Null
}

function Start-DeepseekListener {
  Start-Process -FilePath 'node' -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir 'deepseek.log') `
    -RedirectStandardError (Join-Path $logDir 'deepseek.err.log') `
    -ArgumentList @('tools/mb.js', 'watch', 'deepseek', '--wait', '20', '--note', 'watchdog') | Out-Null
}

function Test-Listening($state, [string]$id) {
  if (-not $state) { return $false }
  $entry = $state.agents | Where-Object { $_.id -eq $id }
  if (-not $entry) { return $false }
  $channel = $entry.acceptance.channel
  if (-not $channel) { return $false }
  if ($channel.inbox -and $channel.inbox.waiting) { return $true }
  if ($channel.callback -and $channel.callback.ok) { return $true }
  return $false
}

Write-Log "watchdog: start (port=$Port interval=${IntervalSeconds}s root=$root)"
Write-Log "watchdog: press Ctrl+C to stop. Each line below is one check." -ConsoleOnly

# Do not hammer the board while it is still coming up.
Start-Sleep -Seconds 5

$round = 0
try {
  while ($true) {
    $round += 1
    try {
      $state = Get-State
      if (-not $state) {
        Write-Log "watchdog: board not reachable - starting service"
        Start-Board
        Start-Sleep -Seconds 8
        $state = Get-State
      }

      if ($state) {
        $online = ($state.agents | ForEach-Object { "$($_.id)=$($_.state)" }) -join ' '
        $listening = ($state.agents | ForEach-Object {
            $w = $false
            if ($_.acceptance -and $_.acceptance.channel -and $_.acceptance.channel.inbox) {
              $w = [bool]$_.acceptance.channel.inbox.waiting
            }
            "$($_.id)=" + $(if ($w) { 'listening' } else { 'silent' })
          }) -join '  '
        Write-Log "check #$round - $listening  (states: $online)" -ConsoleOnly

        if (-not (Test-Listening $state 'codex')) {
          Write-Log "watchdog: codex is not listening (state: $online) - starting channel"
          Start-CodexChannel
          Start-Sleep -Seconds 10
        }
        if (-not (Test-Listening $state 'deepseek')) {
          Write-Log "watchdog: deepseek is not listening (state: $online) - starting listener"
          Start-DeepseekListener
          Start-Sleep -Seconds 5
        }
      }
    } catch {
      Write-Log "watchdog: error $($_.Exception.Message)"
    }

    Start-Sleep -Seconds $IntervalSeconds
  }
} finally {
  # Release the singleton lock so the next launch (logon, or a manual start) can run.
  Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
  Write-Log "watchdog: stopped, lock released"
}
