# Build the debug APK. Run in a normal terminal (Gradle fails in sandboxed shells).
#   tools\device\build-debug.ps1            production bundle
#   tools\device\build-debug.ps1 -Device    device-test bundle: pipeline autostarts and logs PRODUCT_STATUS every 5 s
param([switch]$Device)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..\app')
if ($Device) { $env:VITE_AUTOSTART = '1'; $env:VITE_PRODUCT_LOG = '1' }
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'build failed' }
  npx cap sync android
  if ($LASTEXITCODE -ne 0) { throw 'cap sync failed' }
  Push-Location android
  .\gradlew.bat assembleDebug
  if ($LASTEXITCODE -ne 0) { throw 'gradle failed' }
  Pop-Location
  Write-Host 'BUILD_DONE'
} finally {
  Remove-Item Env:VITE_AUTOSTART -ErrorAction SilentlyContinue
  Remove-Item Env:VITE_PRODUCT_LOG -ErrorAction SilentlyContinue
}
