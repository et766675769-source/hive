' Message Board - run the watchdog without a console window.
' ASCII only: .vbs is read as ANSI by wscript.
' Uses the absolute Windows PowerShell 5.1 path on purpose: PATH lookups for "pwsh"
' are unreliable (pwsh may be absent), and shell.Run with window style 0 already hides the window.
Option Explicit

Dim shell, fso, here, ps, script, cmd

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
ps = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
If Not fso.FileExists(ps) Then ps = "powershell.exe"

script = fso.BuildPath(here, "watchdog.ps1")
cmd = """" & ps & """ -NoProfile -ExecutionPolicy Bypass -File """ & script & """"

shell.Run cmd, 0, False
