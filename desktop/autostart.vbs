' Message Board - autostart without a console window.
' ASCII only: .vbs is read as ANSI by wscript.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)

runner = "powershell"
Set probe = shell.Exec("cmd /c where pwsh")
If probe.ExitCode = 0 Then runner = "pwsh"

cmd = runner & " -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\autostart.ps1"""
shell.Run cmd, 0, False
