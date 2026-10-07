Option Explicit
Dim fso, root, nodePath, command, shell
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
nodePath = fso.BuildPath(root, "runtime\node.exe")
If Not fso.FileExists(nodePath) Then nodePath = "node.exe"
command = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & fso.BuildPath(root, "pair-agent.mjs") & Chr(34) & " --background"
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = root
shell.Run command, 0, False
