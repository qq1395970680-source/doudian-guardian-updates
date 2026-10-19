$ErrorActionPreference='Stop'
Push-Location ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')))
try {
 & node --test 'tests/*.test.mjs' *> artifacts/detail-expansion-unit.log
 if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath artifacts/detail-expansion-unit.log -Encoding utf8 -Tail 60; throw 'Unit checks failed' }
 & node scripts/check.mjs *> artifacts/detail-expansion-source.log
 if ($LASTEXITCODE -ne 0) { throw 'Source checks failed' }
 & node --test --test-concurrency=2 '--test-name-pattern=detail expansion|remembered discount badge|corruptPrice|unknown commit' tests/browser/detail-expansion.test.mjs tests/browser/remembered-price-mode.test.mjs tests/browser/platform-flow.test.mjs tests/browser/restart-unknown.test.mjs *> artifacts/detail-expansion-browser.log
 if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath artifacts/detail-expansion-browser.log -Encoding utf8 -Tail 80; throw 'Browser regression failed' }
 [ordered]@{at=[DateTimeOffset]::UtcNow.ToString('o');localFixtureOnly=$true;unit=$true;source=$true;globalExpansion=$true;individualExpansion=$true;incompleteInventoryBlocks=$true;twoViewports=$true;changedPriceBlocks=$true;unknownRestart=$true} | ConvertTo-Json | Set-Content -LiteralPath artifacts/detail-expansion-validation.json -Encoding utf8
 Get-Content -LiteralPath artifacts/detail-expansion-browser.log -Encoding utf8 -Tail 20
} finally { Pop-Location }
