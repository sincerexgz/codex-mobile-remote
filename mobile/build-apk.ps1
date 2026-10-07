param([switch]$UseMirror,[switch]$Release)
$ErrorActionPreference = 'Stop'
$mobileRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $mobileRoot
try {
  if (-not $env:JAVA_HOME) { throw '请安装 JDK 21 或更高版本并配置 JAVA_HOME。' }
  $mobileSdk = $env:ANDROID_HOME
  if (-not $mobileSdk) { $mobileSdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
  if (-not (Test-Path (Join-Path $mobileSdk 'platforms\android-36\android.jar'))) { throw '请用 Android Studio 安装 Android SDK 36，并自行接受 SDK 协议。' }
  $sdkPath = $mobileSdk.Replace('\','/').Replace(':','\:')
  $sdkPath = -join ($sdkPath.ToCharArray() | ForEach-Object { if ([int]$_ -gt 127) { '\u{0:x4}' -f [int]$_ } else { [string]$_ } })
  [System.IO.File]::WriteAllText((Join-Path $mobileRoot 'android\local.properties'), 'sdk.dir=' + $sdkPath + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) { throw '安装手机构建依赖失败。' }
  & node.exe scripts\build-web.mjs
  if ($LASTEXITCODE -ne 0) { throw '生成网页失败。' }
  & node.exe node_modules\@capacitor\cli\bin\capacitor sync android
  if ($LASTEXITCODE -ne 0) { throw '同步安卓项目失败。' }
  $mobileTask = 'assembleDebug'
  $mobileVariant = 'debug'
  if ($Release) {
    if (-not (Test-Path '.signing\signing.properties')) { throw '发布版本需配置自己的 .signing/signing.properties，参见 docs/BUILD.md。' }
    $mobileTask = 'assembleRelease'; $mobileVariant = 'release'
  }
  Push-Location android
  try {
    $mobileArguments = @('--no-daemon','--console=plain','--max-workers=2')
    if ($UseMirror) { $mobileArguments += @('--init-script', (Join-Path $mobileRoot 'scripts\china-repositories.gradle')) }
    & .\gradlew.bat @mobileArguments $mobileTask
    if ($LASTEXITCODE -ne 0) { throw 'APK 构建失败。' }
  } finally { Pop-Location }
  New-Item -ItemType Directory -Force artifacts | Out-Null
  Copy-Item "android\app\build\outputs\apk\$mobileVariant\app-$mobileVariant.apk" "artifacts\Codex-Remote-$mobileVariant.apk" -Force
  Write-Host "构建完成：mobile/artifacts/Codex-Remote-$mobileVariant.apk"
} catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }
