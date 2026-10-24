$ErrorActionPreference = 'Stop'
$guardianRoot = Split-Path -Parent $PSScriptRoot
$guardianCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$guardianSource = Join-Path $guardianRoot 'desktop\profile-vault.cs'
$guardianOutput = Join-Path $guardianRoot 'desktop\assets\GuardianProfileVault.exe'
& $guardianCompiler /nologo /target:exe /optimize+ /reference:System.Security.dll "/out:$guardianOutput" $guardianSource
if ($LASTEXITCODE -ne 0) { throw 'Profile session vault compilation failed' }
Get-Item -LiteralPath $guardianOutput | Select-Object Name,Length
