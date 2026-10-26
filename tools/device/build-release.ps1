# Build a SIGNED release APK (D-044). Needs a keystore properties file outside the repo: set REARVIEW_KEYSTORE_PROPS to its path
# (keys: storeFile, storePassword, keyAlias, keyPassword), or put keystore.properties in app/android (git-ignored).
#   tools\device\build-release.ps1 -Props D:\path\to\keystore.properties
param([string]$Props = $env:REARVIEW_KEYSTORE_PROPS)
$ErrorActionPreference = 'Stop'
if ($Props) { $env:REARVIEW_KEYSTORE_PROPS = $Props }
Set-Location (Join-Path $PSScriptRoot '..\..\app')
npm run build
if ($LASTEXITCODE -ne 0) { throw 'build failed' }
npx cap sync android
if ($LASTEXITCODE -ne 0) { throw 'cap sync failed' }
Push-Location android
.\gradlew.bat assembleRelease
if ($LASTEXITCODE -ne 0) { throw 'gradle failed' }
Pop-Location
Write-Host 'BUILD_DONE: app\android\app\build\outputs\apk\release\'
