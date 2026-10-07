param([switch]$Disable)
$ErrorActionPreference = 'Stop'
$connectorRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$connectorStartup = [Environment]::GetFolderPath('Startup')
if (-not $connectorStartup) { throw '无法找到当前用户的 Windows 启动文件夹。' }
$connectorShortcut = Join-Path $connectorStartup 'CodexRemoteConnector.lnk'
if ($Disable) {
  if (Test-Path -LiteralPath $connectorShortcut) { Remove-Item -LiteralPath $connectorShortcut }
  Write-Host '已关闭连接器自动启动。'
  exit 0
}
$connectorScript = Join-Path $connectorRoot 'connector-startup.vbs'
if (-not (Test-Path -LiteralPath $connectorScript)) { throw '缺少后台启动脚本，请完整解压连接器。' }
$connectorWscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path -LiteralPath $connectorStartup)) { New-Item -ItemType Directory -Path $connectorStartup -Force | Out-Null }
$connectorShell = New-Object -ComObject WScript.Shell
$connectorLink = $connectorShell.CreateShortcut($connectorShortcut)
$connectorLink.TargetPath = $connectorWscript
$connectorLink.Arguments = '"' + $connectorScript + '"'
$connectorLink.WorkingDirectory = $connectorRoot
$connectorLink.WindowStyle = 7
$connectorLink.Description = 'Codex remote desktop connector'
$connectorLink.Save()
Write-Host '已启用 Windows 登录后自动启动连接器，窗口不会弹出。'
