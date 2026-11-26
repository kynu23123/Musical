param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$installDir = Join-Path $env:LOCALAPPDATA 'MusicalDownloader'
$registryKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.musical.downloader'
if ($Remove) {
    if (Test-Path $registryKey) { Remove-Item -LiteralPath $registryKey }
    Write-Host 'Musical helper disconnected. You can delete its folder from LocalAppData.'
    exit
}
$root = Split-Path $PSScriptRoot -Parent
$manifest = Get-Content (Join-Path $root 'extension/manifest.json') -Raw | ConvertFrom-Json
$keyBytes = [Convert]::FromBase64String($manifest.key)
$hash = [Security.Cryptography.SHA256]::Create().ComputeHash($keyBytes)
$extensionId = -join ($hash[0..15] | ForEach-Object {
    [char](97 + ($_ -shr 4))
    [char](97 + ($_ -band 15))
})
$nodePath = (Get-Command node -ErrorAction Stop).Source
$nodeMajor = [int]((& $nodePath --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { throw 'Install Node.js 22 or newer, then run setup again.' }
New-Item -Force -ItemType Directory $installDir | Out-Null
$runtime = Join-Path $installDir 'runtime'
$python = Join-Path $runtime 'Scripts/python.exe'
if (!(Test-Path $python)) {
    python -m venv $runtime
    if ($LASTEXITCODE) { throw 'Install Python 3.10 or newer, then run setup again.' }
}
& $python -m pip install --upgrade 'yt-dlp[default]' imageio-ffmpeg
if ($LASTEXITCODE) { throw 'Could not install downloader dependencies.' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'host.py') -Destination $installDir -Force
$ffmpeg = & $python -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'
Copy-Item -LiteralPath $ffmpeg -Destination (Join-Path $installDir 'ffmpeg.exe') -Force
@{ ffmpeg = (Join-Path $installDir 'ffmpeg.exe'); node = $nodePath } |
    ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $installDir 'config.json')
$launcher = Join-Path $installDir 'host.cmd'
@'
@echo off
"%~dp0runtime\Scripts\python.exe" -u "%~dp0host.py"
'@ | Set-Content -Encoding ASCII $launcher
$hostManifest = Join-Path $installDir 'com.musical.downloader.json'
@{
    name = 'com.musical.downloader'
    description = 'Musical video downloader'
    path = $launcher
    type = 'stdio'
    allowed_origins = @("chrome-extension://$extensionId/")
} | ConvertTo-Json | Set-Content -Encoding UTF8 $hostManifest
New-Item -Force -Path $registryKey | Out-Null
Set-Item -LiteralPath $registryKey -Value $hostManifest
Write-Host "Helper ready. Load the extension folder in Chrome. Extension ID $extensionId"
