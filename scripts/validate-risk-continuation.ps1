$ErrorActionPreference = 'Stop'
$guardianRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location $guardianRoot
try {
    & node --test 'tests/*.test.mjs' *> 'artifacts/risk-continuation-unit.log'
    if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath 'artifacts/risk-continuation-unit.log' -Encoding utf8 -Tail 50; throw 'Unit checks failed' }
    & node scripts/check.mjs *> 'artifacts/risk-continuation-source.log'
    if ($LASTEXITCODE -ne 0) { throw 'Source checks failed' }
    & node --test --test-concurrency=2 '--test-name-pattern=native original risk|retained original risk|corruptPrice|unknown commit|independent detail at 1440' tests/browser/risk-spinner.test.mjs tests/browser/risk-continuation.test.mjs tests/browser/platform-flow.test.mjs tests/browser/restart-unknown.test.mjs *> 'artifacts/risk-continuation-browser.log'
    if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath 'artifacts/risk-continuation-browser.log' -Encoding utf8 -Tail 80; throw 'Native browser checks failed' }
    [ordered]@{at=[DateTimeOffset]::UtcNow.ToString('o');unit=$true;nativeRiskSpinner=$true;retainedOriginalPage=$true;changedPriceBlocks=$true;lostPageNoResubmit=$true;unknownRestart=$true;twoViewports=$true;source=$true;localFixtureOnly=$true} | ConvertTo-Json | Set-Content -LiteralPath 'artifacts/risk-continuation-validation.json' -Encoding utf8
    Get-Content -LiteralPath 'artifacts/risk-continuation-browser.log' -Encoding utf8 -Tail 20
} finally { Pop-Location }
