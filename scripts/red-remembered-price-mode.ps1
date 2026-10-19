$ErrorActionPreference='Stop'
Push-Location ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')))
try {
 & node --test --test-name-pattern='price mode reads' tests/browser/remembered-price-mode.test.mjs *> artifacts/remembered-price-mode-red.log
 $guardianExit=$LASTEXITCODE
 Get-Content -LiteralPath artifacts/remembered-price-mode-red.log -Encoding utf8
 if ($guardianExit -eq 0) { throw 'Expected existing implementation to fail the observed badge case' }
} finally { Pop-Location }
