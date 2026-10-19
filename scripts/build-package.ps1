$ErrorActionPreference = 'Stop'
$guardianRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$guardianDist = Join-Path $guardianRoot 'dist'
New-Item -ItemType Directory -Path $guardianDist -Force | Out-Null
$guardianTarget = Join-Path $guardianDist ('guardian-v2-win-x64-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
if (Test-Path -LiteralPath $guardianTarget) { throw '发行目录已存在，未覆盖' }
New-Item -ItemType Directory -Path $guardianTarget | Out-Null
foreach ($name in @('src','public')) { Copy-Item -LiteralPath (Join-Path $guardianRoot $name) -Destination (Join-Path $guardianTarget $name) -Recurse }
New-Item -ItemType Directory -Path (Join-Path $guardianTarget 'config') | Out-Null
Copy-Item -LiteralPath (Join-Path $guardianRoot 'config\default.json') -Destination (Join-Path $guardianTarget 'config\default.json')
New-Item -ItemType Directory -Path (Join-Path $guardianTarget 'scripts') | Out-Null
Copy-Item -LiteralPath (Join-Path $guardianRoot 'scripts\start-local.mjs') -Destination (Join-Path $guardianTarget 'scripts\start-local.mjs')
New-Item -ItemType Directory -Path (Join-Path $guardianTarget 'desktop') | Out-Null
Copy-Item -LiteralPath (Join-Path $guardianRoot 'desktop\service-controller.mjs') -Destination (Join-Path $guardianTarget 'desktop\service-controller.mjs')
foreach ($name in @('package.json','package-lock.json','README.md','USER-GUIDE.md','DEVELOPMENT.md','Start.ps1')) { Copy-Item -LiteralPath (Join-Path $guardianRoot $name) -Destination (Join-Path $guardianTarget $name) }
New-Item -ItemType Directory -Path (Join-Path $guardianTarget 'node_modules') | Out-Null
foreach ($name in @('playwright','playwright-core')) { Copy-Item -LiteralPath (Join-Path $guardianRoot "node_modules\$name") -Destination (Join-Path $guardianTarget "node_modules\$name") -Recurse }
$guardianEngine = Join-Path $guardianTarget 'engine'
New-Item -ItemType Directory -Path $guardianEngine | Out-Null
$guardianNode = (Get-Command node.exe -ErrorAction Stop).Source
Copy-Item -LiteralPath $guardianNode -Destination (Join-Path $guardianEngine 'node.exe')
$guardianNodeVersion = (& $guardianNode --version).Trim()
if ($LASTEXITCODE -ne 0 -or $guardianNodeVersion -ne 'v24.18.0') { throw 'Node 版本与封存运行时不一致' }
$guardianLicense = Join-Path $guardianRoot 'artifacts\node-v24.18.0-LICENSE.txt'
if (-not (Test-Path -LiteralPath $guardianLicense)) {
 Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/nodejs/node/v24.18.0/LICENSE' -OutFile $guardianLicense
}
if ((Get-Item -LiteralPath $guardianLicense).Length -lt 10000) { throw 'Node 许可文件不完整' }
Copy-Item -LiteralPath $guardianLicense -Destination (Join-Path $guardianEngine 'LICENSE.txt')
$guardianBrowserSource = Join-Path $env:LOCALAPPDATA 'ms-playwright\chromium-1248'
if (-not (Test-Path -LiteralPath $guardianBrowserSource)) { throw '固定 Chromium 构建尚未安装' }
$guardianBrowsers = Join-Path $guardianTarget 'browsers'
New-Item -ItemType Directory -Path $guardianBrowsers | Out-Null
Copy-Item -LiteralPath $guardianBrowserSource -Destination (Join-Path $guardianBrowsers 'chromium-1248') -Recurse
$guardianManifest = foreach ($file in Get-ChildItem -LiteralPath $guardianTarget -File -Recurse) {
 [ordered]@{ path=[IO.Path]::GetRelativePath($guardianTarget,$file.FullName); bytes=$file.Length; sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash }
}
$guardianManifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $guardianTarget 'manifest-sha256.json') -Encoding utf8
$guardianZip = $guardianTarget + '.zip'
Compress-Archive -LiteralPath $guardianTarget -DestinationPath $guardianZip -CompressionLevel Optimal
[ordered]@{createdAt=(Get-Date).ToUniversalTime().ToString('o');directory=$guardianTarget;zip=$guardianZip;files=$guardianManifest.Count;zipSha256=(Get-FileHash -LiteralPath $guardianZip -Algorithm SHA256).Hash;includesRuntime=$true;includesChromium=$true;includesUserData=$false} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $guardianRoot 'artifacts\package-result.json') -Encoding utf8
Get-Content -LiteralPath (Join-Path $guardianRoot 'artifacts\package-result.json') -Encoding utf8
