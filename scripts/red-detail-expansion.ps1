$ErrorActionPreference='Stop'
Push-Location ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')))
try {
 & node --test '--test-name-pattern=global expansion replaces|incomplete active inventory' tests/browser/detail-expansion.test.mjs tests/service.test.mjs *> artifacts/detail-expansion-red.log
 $guardianExit=$LASTEXITCODE
 Get-Content -LiteralPath artifacts/detail-expansion-red.log -Encoding utf8
 if ($guardianExit -eq 0) { throw 'Expected observed expansion race and patrol status to fail' }
} finally { Pop-Location }
