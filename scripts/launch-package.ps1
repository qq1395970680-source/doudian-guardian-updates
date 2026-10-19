$ErrorActionPreference = 'Stop'
$guardianRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$guardianPackage = Get-Content -LiteralPath (Join-Path $guardianRoot 'artifacts\package-result.json') -Encoding utf8 | ConvertFrom-Json
$guardianProof = Get-Content -LiteralPath (Join-Path $guardianRoot 'artifacts\package-verification.json') -Encoding utf8 | ConvertFrom-Json
if ($guardianProof.directory -ne $guardianPackage.directory -or -not $guardianProof.sourceFilesMatch -or -not $guardianProof.bundledChromium) { throw '发行包尚未通过验收' }
& pwsh.exe -NoLogo -File (Join-Path $guardianPackage.directory 'Start.ps1') -NoOpen
if ($LASTEXITCODE -ne 0) { throw '启动发行包失败' }
