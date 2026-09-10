' Message Board - launch the board window without a console window.
' Double-click this file. ASCII only: .vbs is read as ANSI by wscript.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)

' Prefer PowerShell 7 (pwsh) when present, fall back to Windows PowerShell.
runner = "powershell"
Set probe = shell.Exec("cmd /c where pwsh")
If probe.ExitCode = 0 Then runner = "pwsh"

cmd = runner & " -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\start-board.ps1"""
shell.Run cmd, 0, False
