$ErrorActionPreference = 'Stop'
$pairingRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $pairingRoot
try {
  $pairingNode = Join-Path $pairingRoot 'runtime\node.exe'
  if (-not (Test-Path -LiteralPath $pairingNode)) { $pairingNode = (Get-Command node.exe -ErrorAction Stop).Source }
  if (-not (Test-Path -LiteralPath (Join-Path $pairingRoot 'node_modules\ws'))) { throw '缺少连接器文件，请重新解压完整的电脑连接器压缩包。' }
  $connectorConfigPath = Join-Path $pairingRoot 'connector-config.json'
  $connectorIdentityPath = Join-Path $pairingRoot '.device-connection.json'
  if (-not (Test-Path -LiteralPath $connectorIdentityPath) -and -not (Test-Path -LiteralPath $connectorConfigPath)) {
    $connectorServer = Read-Host '请输入自己部署的服务器地址，例如 https://remote.example.com'
    $connectorRegistration = Read-Host '请输入服务器 REGISTRATION_KEY（首次登记访问密钥）' -AsSecureString
    $connectorCredential = New-Object System.Management.Automation.PSCredential('registration', $connectorRegistration)
    $connectorConfiguration = @{ server = $connectorServer.Trim(); registrationKey = $connectorCredential.GetNetworkCredential().Password } | ConvertTo-Json
    [System.IO.File]::WriteAllText($connectorConfigPath, $connectorConfiguration, [System.Text.UTF8Encoding]::new($false))
  }
  & (Join-Path $pairingRoot 'connector-autostart.ps1')
  & $pairingNode (Join-Path $pairingRoot 'pair-agent.mjs')
  exit $LASTEXITCODE
} catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }
