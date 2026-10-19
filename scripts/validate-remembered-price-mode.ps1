$ErrorActionPreference='Stop'
Push-Location ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')))
try {
 & node --test 'tests/*.test.mjs' *> artifacts/remembered-price-mode-unit.log
 if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath artifacts/remembered-price-mode-unit.log -Encoding utf8 -Tail 60; throw 'Unit checks failed' }
 & node scripts/check.mjs *> artifacts/remembered-price-mode-source.log
 if ($LASTEXITCODE -ne 0) { throw 'Source checks failed' }
 & node --test --test-concurrency=2 '--test-name-pattern=price mode reads|remembered discount badge|corruptPrice|retained original risk|unknown commit' tests/browser/remembered-price-mode.test.mjs tests/browser/platform-flow.test.mjs tests/browser/risk-continuation.test.mjs tests/browser/restart-unknown.test.mjs *> artifacts/remembered-price-mode-browser.log
 if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath artifacts/remembered-price-mode-browser.log -Encoding utf8 -Tail 80; throw 'Browser regression failed' }
 [ordered]@{at=[DateTimeOffset]::UtcNow.ToString('o');localFixtureOnly=$true;unit=$true;source=$true;twoViewports=$true;rememberedBadge=$true;wrongOrAmbiguousModeBlocks=$true;changedPriceBlocks=$true;retainedRisk=$true;lostPageNoResubmit=$true;unknownRestart=$true} | ConvertTo-Json | Set-Content -LiteralPath artifacts/remembered-price-mode-validation.json -Encoding utf8
 Get-Content -LiteralPath artifacts/remembered-price-mode-browser.log -Encoding utf8 -Tail 20
} finally { Pop-Location }
