$ErrorActionPreference = 'Stop'
$guardianRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$guardianArtifacts = Join-Path $guardianRoot 'artifacts'
New-Item -ItemType Directory -Path $guardianArtifacts -Force | Out-Null
Push-Location $guardianRoot
try {
 & node.exe --test tests/*.test.mjs *> (Join-Path $guardianArtifacts 'unit-tests.log')
 if ($LASTEXITCODE -ne 0) { throw '业务规则回归未通过，见 artifacts/unit-tests.log' }
 & node.exe --test tests/browser/*.test.mjs *> (Join-Path $guardianArtifacts 'browser-tests.log')
 if ($LASTEXITCODE -ne 0) { throw '浏览器集成回归未通过，见 artifacts/browser-tests.log' }
 & node.exe scripts/check.mjs *> (Join-Path $guardianArtifacts 'source-check.log')
 if ($LASTEXITCODE -ne 0) { throw '源码检查未通过' }
 [ordered]@{completedAt=(Get-Date).ToUniversalTime().ToString('o');unit=$true;browser=$true;sourceCheck=$true;scope='local fixtures only';liveAcceptance=$false} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $guardianArtifacts 'validation-result.json') -Encoding utf8
 Get-Content -LiteralPath (Join-Path $guardianArtifacts 'validation-result.json') -Encoding utf8
} finally { Pop-Location }
