' ZCode Tarkov launcher trampoline.
' Starts zcode-tarkov-launch.ps1 next to this file with a hidden window
' (window style 0 hides it at process creation), so a double-click on the
' "ZCode Tarkov" shortcut never flashes a console window.
' Pass /noprompt on the command line to forward -NoPrompt to the launcher.
Option Explicit

Dim fso, sh, baseDir, ps1, psExe, extra, i
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(baseDir, "zcode-tarkov-launch.ps1")
psExe = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"

extra = ""
For i = 0 To WScript.Arguments.Count - 1
    If LCase(WScript.Arguments(i)) = "/noprompt" Then extra = " -NoPrompt"
Next
sh.Run """" & psExe & """ -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """" & extra, 0, False
