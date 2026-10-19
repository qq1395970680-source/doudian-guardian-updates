$ErrorActionPreference = 'Stop'
$guardianRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$guardianSource = Join-Path $guardianRoot '.desktop\source'
if (-not (Test-Path -LiteralPath (Join-Path $guardianSource 'source-manifest.json'))) { throw '请先完成 npm run build:desktop' }
$guardianVersion = (Get-Content -LiteralPath (Join-Path $guardianRoot 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json).version
$guardianZip = Join-Path $guardianRoot "desktop-dist\DoudianGuardian-Source-$guardianVersion.zip"
Compress-Archive -LiteralPath $guardianSource -DestinationPath $guardianZip -CompressionLevel Optimal -Force
[ordered]@{path=$guardianZip;sha256=(Get-FileHash -LiteralPath $guardianZip -Algorithm SHA256).Hash} | ConvertTo-Json
